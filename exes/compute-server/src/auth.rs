//! Bearer token authentication.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::Response;

use crate::api::{ApiError, AppState};

/// Compares two tokens without leaking the position of the first mismatch.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in a.iter().zip(b) {
        difference |= left ^ right;
    }
    difference == 0
}

/// Extracts credentials only from the Authorization header.
pub fn presented_token(request: &Request) -> Option<String> {
    if let Some(value) = request.headers().get(AUTHORIZATION) {
        let value = value.to_str().ok()?;
        let token = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))?;
        return Some(token.trim().to_string());
    }
    None
}

/// Middleware that rejects requests without a valid token.
pub async fn require_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token =
        presented_token(&request).ok_or_else(|| ApiError::unauthorized("missing bearer token"))?;
    let owner = state
        .sessions
        .authenticate(&token)
        .ok_or_else(|| ApiError::unauthorized("invalid or revoked client token"))?;
    let mut request = request;
    request.extensions_mut().insert(Owner(owner));
    request.extensions_mut().insert(Credential(token));
    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_comparison() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }

    #[test]
    fn rejects_query_credentials() {
        let request = Request::builder()
            .uri("/api/v1/jobs/1/events?token=a%20b")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(presented_token(&request).as_deref(), None);
        let request = Request::builder()
            .uri("/api/v1/jobs/1?token=x")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(presented_token(&request), None);
        let request = Request::builder()
            .uri("/api/v1/jobs/1")
            .header(AUTHORIZATION, "Bearer secret")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(presented_token(&request).as_deref(), Some("secret"));
    }
}

/// The owner of the authenticated request.
#[derive(Clone)]
pub struct Owner(pub String);

/// The bearer credential of the authenticated request.
#[derive(Clone)]
pub struct Credential(pub String);

/// The owner every pairing maps to in single-owner mode.
pub const SINGLE_OWNER: &str = "single-owner";

/// Idle period after which a single-owner credential is revoked.
pub const SESSION_IDLE: Duration = Duration::from_secs(14 * 24 * 3600);

/// Minimum interval between persisted refreshes of a credential's last use.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(3600);

/// How pairings map to owners and when credentials expire.
#[derive(Debug, Clone, Copy)]
pub struct SessionPolicy {
    /// Every pairing maps to [`SINGLE_OWNER`] and idle credentials expire.
    pub single_owner: bool,
    /// Idle period after which a single-owner credential is revoked.
    pub idle: Duration,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Session {
    token: String,
    client_id: String,
    /// Unix milliseconds of the last persisted use.
    #[serde(default)]
    last_used: Option<i64>,
}

struct Entry {
    session: Session,
    /// Unix milliseconds of the last use, refreshed in memory on every request.
    last_used: i64,
}

/// Durable credentials, keyed by credential.
pub struct Sessions {
    path: PathBuf,
    policy: SessionPolicy,
    entries: Mutex<Vec<Entry>>,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

impl Sessions {
    /// Loads `sessions.json` from the data directory.
    pub fn load(dir: &Path, policy: SessionPolicy) -> std::io::Result<Self> {
        let path = dir.join("sessions.json");
        let records: Vec<Session> = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        let now = now_millis();
        let entries = records
            .into_iter()
            .map(|session| Entry {
                last_used: session.last_used.unwrap_or(now),
                session,
            })
            .collect();
        Ok(Self {
            path,
            policy,
            entries: Mutex::new(entries),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Entry>> {
        match self.entries.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn persist(&self, entries: &[Entry]) -> std::io::Result<()> {
        let records: Vec<&Session> = entries.iter().map(|entry| &entry.session).collect();
        crate::durable::write(&self.path, &records)
    }

    /// The owner of a valid credential. In single-owner mode an idle
    /// credential is revoked here, and use refreshes it.
    pub fn authenticate(&self, token: &str) -> Option<String> {
        let mut entries = self.lock();
        let index = entries
            .iter()
            .position(|entry| constant_time_eq(token, &entry.session.token))?;
        if !self.policy.single_owner {
            return Some(entries[index].session.client_id.clone());
        }
        let now = now_millis();
        if now - entries[index].last_used > millis(self.policy.idle) {
            let removed = entries.remove(index);
            if let Err(error) = self.persist(&entries) {
                tracing::error!(%error, "could not persist the revocation of an idle credential");
                entries.insert(index, removed);
            }
            return None;
        }
        entries[index].last_used = now;
        let persisted = entries[index].session.last_used.unwrap_or(0);
        if now - persisted >= millis(REFRESH_INTERVAL) {
            entries[index].session.last_used = Some(now);
            if let Err(error) = self.persist(&entries) {
                tracing::warn!(%error, "could not persist a credential refresh");
                entries[index].session.last_used = Some(persisted);
            }
        }
        Some(entries[index].session.client_id.clone())
    }

    /// Creates a credential and returns it with its owner.
    pub fn pair(&self) -> std::io::Result<(String, String)> {
        let mut entries = self.lock();
        let client_id = if self.policy.single_owner {
            SINGLE_OWNER.to_string()
        } else {
            crate::api::new_job_id()
        };
        let now = now_millis();
        let session = Session {
            token: format!("{}{}", crate::api::new_job_id(), crate::api::new_job_id()),
            client_id,
            last_used: Some(now),
        };
        entries.push(Entry {
            session: session.clone(),
            last_used: now,
        });
        if let Err(error) = self.persist(&entries) {
            entries.pop();
            return Err(error);
        }
        Ok((session.token, session.client_id))
    }

    /// Revokes one credential; other credentials of the same owner stay valid.
    pub fn revoke(&self, token: &str) -> std::io::Result<()> {
        let mut entries = self.lock();
        let Some(index) = entries
            .iter()
            .position(|entry| constant_time_eq(token, &entry.session.token))
        else {
            return Ok(());
        };
        let removed = entries.remove(index);
        if let Err(error) = self.persist(&entries) {
            entries.insert(index, removed);
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;

    fn policy(single_owner: bool, idle: Duration) -> SessionPolicy {
        SessionPolicy { single_owner, idle }
    }

    #[test]
    fn revocation_is_per_credential() {
        let dir = tempfile::tempdir().unwrap();
        for single_owner in [false, true] {
            let sessions = Sessions::load(dir.path(), policy(single_owner, SESSION_IDLE)).unwrap();
            let (first, first_owner) = sessions.pair().unwrap();
            let (second, _) = sessions.pair().unwrap();
            sessions.revoke(&first).unwrap();
            assert!(sessions.authenticate(&first).is_none());
            assert!(sessions.authenticate(&second).is_some());
            if single_owner {
                assert_eq!(first_owner, SINGLE_OWNER);
                assert_eq!(sessions.authenticate(&second).unwrap(), SINGLE_OWNER);
            }
            let reloaded = Sessions::load(dir.path(), policy(single_owner, SESSION_IDLE)).unwrap();
            assert!(reloaded.authenticate(&first).is_none());
            assert!(reloaded.authenticate(&second).is_some());
        }
    }

    #[test]
    fn pairing_mode_mints_an_owner_per_pairing() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Sessions::load(dir.path(), policy(false, SESSION_IDLE)).unwrap();
        let (_, a) = sessions.pair().unwrap();
        let (_, b) = sessions.pair().unwrap();
        assert_ne!(a, b);
    }

    /// Moves a credential's last use (in memory and as persisted) into the past.
    fn age(sessions: &Sessions, token: &str, used: Duration, persisted: Duration) {
        let mut entries = sessions.lock();
        let entry = entries
            .iter_mut()
            .find(|entry| entry.session.token == token)
            .unwrap();
        entry.last_used = now_millis() - millis(used);
        entry.session.last_used = Some(now_millis() - millis(persisted));
    }

    #[test]
    fn idle_single_owner_credentials_expire_and_use_refreshes_them() {
        let dir = tempfile::tempdir().unwrap();
        let hour = Duration::from_secs(3600);
        let sessions = Sessions::load(dir.path(), policy(true, hour)).unwrap();
        let (used, _) = sessions.pair().unwrap();
        let (unused, _) = sessions.pair().unwrap();
        age(
            &sessions,
            &used,
            hour - Duration::from_secs(60),
            Duration::ZERO,
        );
        assert!(sessions.authenticate(&used).is_some());
        age(
            &sessions,
            &unused,
            hour + Duration::from_secs(60),
            Duration::ZERO,
        );
        assert!(sessions.authenticate(&unused).is_none());
        let reloaded = Sessions::load(dir.path(), policy(true, hour)).unwrap();
        assert!(reloaded.authenticate(&unused).is_none());
        assert!(reloaded.authenticate(&used).is_some());
        let pairing = Sessions::load(dir.path(), policy(false, hour)).unwrap();
        age(&pairing, &used, 10 * hour, 10 * hour);
        assert!(pairing.authenticate(&used).is_some());
    }

    #[test]
    fn refreshes_are_persisted_at_most_hourly() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Sessions::load(dir.path(), policy(true, SESSION_IDLE)).unwrap();
        let (token, _) = sessions.pair().unwrap();
        let before = std::fs::read(dir.path().join("sessions.json")).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        assert!(sessions.authenticate(&token).is_some());
        assert_eq!(
            std::fs::read(dir.path().join("sessions.json")).unwrap(),
            before
        );
    }
}
