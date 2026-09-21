//! Bearer token authentication.

use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::Response;

use crate::api::{ApiError, AppState};

/// Result of checking a request's credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Credentials {
    /// No token was presented.
    Missing,
    /// A token was presented and matches.
    Valid,
    /// A token was presented and does not match.
    Invalid,
}

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

/// Extracts the bearer token from the `Authorization` header, falling back
/// to the `token` query parameter on the endpoints `EventSource` and
/// `<a download>` use.
pub fn presented_token(request: &Request) -> Option<String> {
    if let Some(value) = request.headers().get(AUTHORIZATION) {
        let value = value.to_str().ok()?;
        let token = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))?;
        return Some(token.trim().to_string());
    }
    let path = request.uri().path();
    let query_allowed = path.ends_with("/events") || path.contains("/outputs/");
    if !query_allowed {
        return None;
    }
    let query = request.uri().query()?;
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix("token=") {
            return Some(percent_decode(value));
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &value[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// Classifies the request's credentials against the configured token.
pub fn check(request: &Request, expected: &str) -> Credentials {
    match presented_token(request) {
        None => Credentials::Missing,
        Some(token) if constant_time_eq(&token, expected) => Credentials::Valid,
        Some(_) => Credentials::Invalid,
    }
}

/// Middleware that rejects requests without a valid token.
pub async fn require_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    match check(&request, &state.config.token) {
        Credentials::Valid => Ok(next.run(request).await),
        Credentials::Missing => Err(ApiError::unauthorized("missing bearer token")),
        Credentials::Invalid => Err(ApiError::unauthorized("invalid token")),
    }
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
    fn query_token_only_on_stream_and_outputs() {
        let request = Request::builder()
            .uri("/api/v1/jobs/1/events?token=a%20b")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(presented_token(&request).as_deref(), Some("a b"));
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
