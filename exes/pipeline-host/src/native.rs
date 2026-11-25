//! Native host: OS processes and real files. GPU slots are flock'd files on Unix.

use crate::{Exit, Host, Stat, Step};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Native {
    /// Searched before PATH for every tool.
    pub bin: PathBuf,
    /// Environment for every tool (thread caps).
    pub env: Vec<(String, String)>,
    /// Concurrent GPU steps allowed across every instance sharing `gpu_lock_dir` (0: no locking).
    pub gpu_slots: usize,
    pub gpu_lock_dir: PathBuf,
}

fn executable(p: &Path) -> bool {
    let Ok(m) = fs::metadata(p) else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.is_file() && m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        m.is_file()
    }
}

/// `name` in `bin`, then on PATH (with `.exe` on Windows).
pub fn tool_path(name: &str, bin: &Path) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let names: &[String] = if cfg!(windows) {
        &[format!("{name}.exe"), name.to_string()]
    } else {
        &[name.to_string()]
    };
    std::iter::once(bin.to_path_buf())
        .chain(std::env::split_paths(&path))
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| executable(p))
}

impl Native {
    /// One of gpu_slots flock'd files shared by every instance; waits while all are taken. The kernel drops a lock
    /// when its holder exits, so a crashed instance never leaves a stale slot.
    #[cfg(unix)]
    fn gpu_slot(&self) -> Result<File, String> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
        use std::os::unix::io::AsRawFd;
        loop {
            for i in 0..self.gpu_slots {
                let path = self.gpu_lock_dir.join(format!("fastprep-gpu-{i}.lock"));
                // O_NOFOLLOW: a symlink planted in shared /tmp must not redirect the open or the chmod
                // an open failure is permanent (missing dir, permissions, symlink); only a held flock means wait
                let f = OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .mode(0o666)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&path)
                    .map_err(|e| format!("GPU lock {}: {e}", path.display()))?;
                // other users' instances share the slots; O_NOFOLLOW stops symlinks but not a planted hard link, so
                // only a lone file of our own is opened up
                if f.metadata().is_ok_and(|m| {
                    m.is_file() && m.nlink() == 1 && m.uid() == unsafe { libc::geteuid() }
                }) {
                    let _ = f.set_permissions(fs::Permissions::from_mode(0o666));
                }
                if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                    return Ok(f);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    // ponytail: no cross-instance GPU slots off Unix; add a LockFileEx variant if Windows clusters need them.
    #[cfg(not(unix))]
    fn gpu_slot(&self) -> Result<(), String> {
        Ok(())
    }
}

impl Host for Native {
    async fn run(&self, step: &Step) -> Result<Exit, String> {
        let name = &step.argv[0];
        let exe = tool_path(name, &self.bin).ok_or_else(|| {
            format!(
                "tool not found: {name} (add to PATH or {})",
                self.bin.display()
            )
        })?;
        let mut cmd = Command::new(exe);
        cmd.args(&step.argv[1..])
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .envs(step.env.iter().map(|(k, v)| (k, v)));
        let _slot = (step.gpu && self.gpu_slots > 0)
            .then(|| self.gpu_slot())
            .transpose()?;
        let o = cmd.output().map_err(|e| format!("{name}: {e}"))?;
        Ok(Exit {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into(),
            stderr: String::from_utf8_lossy(&o.stderr).into(),
        })
    }

    async fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        let err = |e: std::io::Error| format!("{path}: {e}");
        let mut f = File::open(path).map_err(err)?;
        f.seek(SeekFrom::Start(offset)).map_err(err)?;
        let mut buf = Vec::with_capacity(len);
        f.take(len as u64).read_to_end(&mut buf).map_err(err)?;
        Ok(buf)
    }

    async fn read_text(&self, path: &str, limit: usize) -> Result<String, String> {
        let n = fs::metadata(path)
            .map_err(|e| format!("{path}: {e}"))?
            .len();
        if n > limit as u64 {
            return Err(format!(
                "{path}: {n} bytes exceeds the {limit}-byte text limit"
            ));
        }
        fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
    }

    async fn write(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        fs::write(path, bytes).map_err(|e| format!("{path}: {e}"))
    }

    async fn append(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| f.write_all(bytes))
            .map_err(|e| format!("{path}: {e}"))
    }

    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    fn stat(&self, path: &str) -> Option<Stat> {
        let m = fs::metadata(path).ok().filter(|m| m.is_file())?;
        Some((
            m.len(),
            m.modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_nanos(),
        ))
    }

    fn list(&self, dir: &str) -> Vec<String> {
        fn walk(root: &Path, rel: &str, out: &mut Vec<String>) {
            let Ok(rd) = fs::read_dir(root.join(rel)) else {
                return;
            };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let r = if rel.is_empty() {
                    name
                } else {
                    format!("{rel}/{name}")
                };
                match e.file_type() {
                    Ok(t) if t.is_dir() => walk(root, &r, out), // symlinked dirs are not followed, as pathlib.rglob
                    Ok(_) if e.path().is_file() => out.push(r),
                    _ => {}
                }
            }
        }
        let mut out = vec![];
        walk(Path::new(dir), "", &mut out);
        out
    }

    fn mkdirs(&self, dir: &str) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| format!("{dir}: {e}"))
    }

    fn remove(&self, path: &str) {
        let _ = fs::remove_file(path);
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        fs::rename(from, to).map_err(|e| format!("{from} -> {to}: {e}"))
    }

    fn copy(&self, from: &str, to: &str) -> Result<(), String> {
        fs::copy(from, to)
            .map(|_| ())
            .map_err(|e| format!("{from} -> {to}: {e}"))
    }

    fn now(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
    }

    #[cfg(unix)]
    fn local_time(&self) -> String {
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&t, &mut tm) };
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}",
            tm.tm_year + 1900,
            tm.tm_mon + 1,
            tm.tm_mday,
            tm.tm_hour,
            tm.tm_min
        )
    }

    // ponytail: UTC off Unix (reports only); use GetLocalTime if a Windows report needs local time.
    #[cfg(not(unix))]
    fn local_time(&self) -> String {
        let s = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let (days, rem) = (s.div_euclid(86400), s.rem_euclid(86400));
        // civil-from-days (Howard Hinnant)
        let z = days + 719468;
        let era = z.div_euclid(146097);
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(m <= 2);
        format!(
            "{y:04}-{m:02}-{d:02} {:02}:{:02}",
            rem / 3600,
            rem % 3600 / 60
        )
    }

    fn log(&self, line: &str) {
        println!("{line}");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn gpu_slot_is_shared_between_instances() {
        let d = std::env::temp_dir().join(format!("fastprep-gpu-test-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        let host = |d: &Path| Native {
            bin: PathBuf::new(),
            env: vec![],
            gpu_slots: 1,
            gpu_lock_dir: d.to_path_buf(),
        };
        let (a, b) = (host(&d), host(&d));
        let events = std::sync::Mutex::new(vec![]);
        let (acquired, ready) = std::sync::mpsc::channel();
        std::thread::scope(|s| {
            s.spawn(|| {
                let _f = a.gpu_slot().unwrap();
                events.lock().unwrap().push("a+");
                acquired.send(()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(400));
                events.lock().unwrap().push("a-");
            });
            ready.recv().unwrap();
            let _f = b.gpu_slot().unwrap();
            events.lock().unwrap().push("b+");
        });
        assert_eq!(*events.lock().unwrap(), ["a+", "a-", "b+"]);
        fs::remove_dir_all(&d).unwrap();
        assert!(host(&d).gpu_slot().is_err()); // a missing lock dir fails instead of waiting forever
    }
}
