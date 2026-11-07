//! One server per data directory. Every server holds `flock` on
//! `server.lock`. Some Lustre and NFS mounts do not honour `flock` across
//! hosts, so in Slurm mode the server also creates `instance.lock`
//! exclusively, naming its host, PID and start time. An existing lock file
//! always refuses startup, even when its holder looks dead; `unlock` removes
//! it once the operator has confirmed the old server is stopped.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// File name of the exclusive lock.
pub const INSTANCE_LOCK: &str = "instance.lock";

/// Who holds `instance.lock`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Holder {
    /// Host name.
    pub host: String,
    /// Process id.
    pub pid: u32,
    /// RFC 3339 time the process took the lock at startup.
    pub started_at: String,
}

impl Holder {
    fn current() -> Holder {
        Holder {
            host: crate::detect::hostname().unwrap_or_else(|| "unknown host".into()),
            pid: std::process::id(),
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }
    }

    fn describe(&self) -> String {
        format!(
            "{} (pid {}, started {})",
            self.host, self.pid, self.started_at
        )
    }
}

/// The held locks; dropping them removes `instance.lock`.
pub struct Locks {
    _flock: File,
    instance: Option<PathBuf>,
}

impl Drop for Locks {
    fn drop(&mut self) {
        if let Some(path) = &self.instance {
            if let Err(error) = std::fs::remove_file(path) {
                tracing::error!(%error, path = %path.display(), "could not remove the instance lock");
            }
        }
    }
}

fn holder_of(data_dir: &Path) -> Option<Holder> {
    let bytes = std::fs::read(data_dir.join(INSTANCE_LOCK)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn flock(data_dir: &Path) -> io::Result<File> {
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(data_dir.join("server.lock"))
}

/// Takes the data directory: `flock` always, `instance.lock` when `exclusive_file`.
pub fn acquire(data_dir: &Path, exclusive_file: bool) -> io::Result<Locks> {
    let file = flock(data_dir)?;
    if let Err(error) = file.try_lock() {
        let holder = holder_of(data_dir)
            .map(|holder| format!(" by {}", holder.describe()))
            .unwrap_or_default();
        return Err(io::Error::other(format!(
            "data directory already in use{holder}: {error}"
        )));
    }
    if !exclusive_file {
        return Ok(Locks {
            _flock: file,
            instance: None,
        });
    }
    let path = data_dir.join(INSTANCE_LOCK);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut lock = match options.open(&path) {
        Ok(lock) => lock,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let holder = holder_of(data_dir)
                .map(|holder| holder.describe())
                .unwrap_or_else(|| "an unreadable lock".into());
            return Err(io::Error::other(format!(
                "data directory is locked by {holder} ({}). If that server is stopped, run: neurodesk-compute unlock --data-dir {}",
                path.display(),
                data_dir.display()
            )));
        }
        Err(error) => return Err(error),
    };
    let written = serde_json::to_vec(&Holder::current())
        .map_err(io::Error::other)
        .and_then(|bytes| lock.write_all(&bytes))
        .and_then(|()| lock.sync_all());
    if let Err(error) = written {
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(Locks {
        _flock: file,
        instance: Some(path),
    })
}

/// Removes a stale `instance.lock`; refuses while a server holds `flock`.
pub fn unlock(data_dir: &Path) -> Result<String, String> {
    let file = flock(data_dir).map_err(|error| format!("cannot open the lock: {error}"))?;
    if file.try_lock().is_err() {
        let holder = holder_of(data_dir)
            .map(|holder| format!(" ({})", holder.describe()))
            .unwrap_or_default();
        return Err(format!(
            "a running server still holds {}{holder}; stop it first",
            data_dir.display()
        ));
    }
    let path = data_dir.join(INSTANCE_LOCK);
    let holder = holder_of(data_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(match holder {
            Some(holder) => format!("removed the lock of {}", holder.describe()),
            None => format!("removed {}", path.display()),
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(format!("{} has no instance lock", data_dir.display()))
        }
        Err(error) => Err(format!("cannot remove {}: {error}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_holder(data_dir: &Path, holder: &Holder) -> io::Result<()> {
        let mut file = File::create(data_dir.join(INSTANCE_LOCK))?;
        file.write_all(&serde_json::to_vec(holder).map_err(io::Error::other)?)
    }

    #[test]
    fn exclusive_lock_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let locks = acquire(dir.path(), true).unwrap();
        let holder = holder_of(dir.path()).unwrap();
        assert_eq!(holder.pid, std::process::id());
        assert!(unlock(dir.path()).unwrap_err().contains("still holds"));
        drop(locks);
        assert!(!dir.path().join(INSTANCE_LOCK).exists());
        let flock_only = acquire(dir.path(), false).unwrap();
        assert!(!dir.path().join(INSTANCE_LOCK).exists());
        drop(flock_only);
    }

    #[test]
    fn a_stale_lock_refuses_until_unlocked() {
        let dir = tempfile::tempdir().unwrap();
        let stale = Holder {
            host: "login2".into(),
            pid: 4242,
            started_at: "2026-11-01T08:00:00Z".into(),
        };
        write_holder(dir.path(), &stale).unwrap();
        let error = acquire(dir.path(), true).err().unwrap().to_string();
        assert!(error.contains("login2 (pid 4242"), "{error}");
        assert!(error.contains("neurodesk-compute unlock"), "{error}");
        assert!(acquire(dir.path(), false).is_ok());
        assert!(unlock(dir.path()).unwrap().contains("login2"));
        assert!(acquire(dir.path(), true).is_ok());
    }
}
