//! Forwards new lines of `run.out` and `run.err`, Slurm's copy of the log,
//! read from the start on every attach. Jobs write the project, so the job
//! directory must be a plain directory of it (`projects::job_dir`) and a log
//! that is a symbolic link is not followed: it reads as absent.

use std::io::SeekFrom;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::runner::LineSink;

struct Followed {
    name: &'static str,
    offset: u64,
    partial: Vec<u8>,
    /// A refusal was logged.
    warned: bool,
}

/// Follows a job's two log files.
pub struct Tail {
    project_dir: PathBuf,
    directory: String,
    warned: bool,
    files: Vec<Followed>,
}

/// Opens `path` when it is a regular file and not a symbolic link: the file
/// opened must be the one `symlink_metadata` saw, so a swap in between fails.
/// `Err(None)` is a missing or unreadable file, `Err(Some(reason))` a refusal.
async fn open_plain(path: &Path) -> Result<tokio::fs::File, Option<&'static str>> {
    let seen = tokio::fs::symlink_metadata(path).await.map_err(|_| None)?;
    if !seen.file_type().is_file() {
        return Err(Some("not a regular file"));
    }
    let file = tokio::fs::File::open(path).await.map_err(|_| None)?;
    let opened = file.metadata().await.map_err(|_| None)?;
    if (opened.dev(), opened.ino()) != (seen.dev(), seen.ino()) {
        return Err(Some("replaced while it was opened"));
    }
    Ok(file)
}

impl Tail {
    /// Follows `run.out` and `run.err` in `<project_dir>/<directory>` from their start.
    pub fn new(project_dir: &Path, directory: &str) -> Tail {
        Tail {
            project_dir: project_dir.to_path_buf(),
            directory: directory.to_string(),
            warned: false,
            files: ["run.out", "run.err"]
                .into_iter()
                .map(|name| Followed {
                    name,
                    offset: 0,
                    partial: Vec::new(),
                    warned: false,
                })
                .collect(),
        }
    }

    /// Sends complete new lines; `finish` also sends unterminated last lines.
    pub async fn forward(&mut self, sink: &LineSink, finish: bool) {
        let job_dir = match crate::projects::job_dir(&self.project_dir, &self.directory) {
            Ok(job_dir) => job_dir,
            Err(error) => {
                if !std::mem::replace(&mut self.warned, true) {
                    tracing::warn!(%error, "not following the job's log");
                }
                return;
            }
        };
        for file in &mut self.files {
            let mut handle = match open_plain(&job_dir.join(file.name)).await {
                Ok(handle) => handle,
                Err(refused) => {
                    if let Some(reason) = refused {
                        if !std::mem::replace(&mut file.warned, true) {
                            tracing::warn!(directory = %self.directory, file = file.name, reason, "not following the log file");
                        }
                    }
                    continue;
                }
            };
            if handle.seek(SeekFrom::Start(file.offset)).await.is_err() {
                continue;
            }
            let mut bytes = Vec::new();
            let Ok(read) = handle.read_to_end(&mut bytes).await else {
                continue;
            };
            file.offset += read as u64;
            file.partial.extend_from_slice(&bytes);
            let complete = match file.partial.iter().rposition(|byte| *byte == b'\n') {
                Some(end) => file.partial.drain(..=end).collect::<Vec<u8>>(),
                None if finish => std::mem::take(&mut file.partial),
                None => continue,
            };
            let mut text = String::from_utf8_lossy(&complete).into_owned();
            if finish && !file.partial.is_empty() {
                text.push_str(&String::from_utf8_lossy(&std::mem::take(&mut file.partial)));
            }
            for line in text.split('\n') {
                for piece in line.split('\r') {
                    let piece = piece.trim_end();
                    if !piece.is_empty() {
                        let _ = sink.send(piece.to_string());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    const JOB: &str = "Class2D/job006";

    /// A project with an empty job directory `JOB`.
    fn project() -> (tempfile::TempDir, PathBuf) {
        let project = tempfile::tempdir().unwrap();
        let dir = project.path().join(JOB);
        std::fs::create_dir_all(&dir).unwrap();
        (project, dir)
    }

    #[tokio::test]
    async fn forwards_complete_lines_and_rereads_from_the_start() {
        let (project, dir) = project();
        let (sink, mut lines) = tokio::sync::mpsc::unbounded_channel();
        let mut tail = Tail::new(project.path(), JOB);
        tail.forward(&sink, false).await;
        std::fs::write(dir.join("run.out"), "one\ntw").unwrap();
        std::fs::write(dir.join("run.err"), "err 1\n").unwrap();
        tail.forward(&sink, false).await;
        assert_eq!(lines.recv().await.unwrap(), "one");
        assert_eq!(lines.recv().await.unwrap(), "err 1");
        assert!(lines.try_recv().is_err());
        std::fs::write(
            dir.join("run.out"),
            "one\ntwo\n 000/??? sec ..\r 001/010 sec ....",
        )
        .unwrap();
        tail.forward(&sink, true).await;
        assert_eq!(lines.recv().await.unwrap(), "two");
        assert_eq!(lines.recv().await.unwrap(), " 000/??? sec ..");
        assert_eq!(lines.recv().await.unwrap(), " 001/010 sec ....");
        let mut again = Tail::new(project.path(), JOB);
        again.forward(&sink, true).await;
        assert_eq!(lines.recv().await.unwrap(), "one");
    }

    #[tokio::test]
    async fn symlinked_logs_and_job_directories_are_not_followed() {
        let (project, dir) = project();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "outside the project\n").unwrap();
        std::fs::create_dir_all(outside.path().join("job006")).unwrap();
        std::fs::write(outside.path().join("job006/run.out"), "outside job\n").unwrap();
        symlink(outside.path().join("secret"), dir.join("run.out")).unwrap();
        std::fs::write(dir.join("run.err"), "inside\n").unwrap();
        let (sink, mut lines) = tokio::sync::mpsc::unbounded_channel();
        let mut tail = Tail::new(project.path(), JOB);
        tail.forward(&sink, true).await;
        assert_eq!(lines.recv().await.unwrap(), "inside");
        assert!(lines.try_recv().is_err());
        std::fs::remove_dir_all(project.path().join("Class2D")).unwrap();
        symlink(outside.path(), project.path().join("Class2D")).unwrap();
        let mut swapped = Tail::new(project.path(), JOB);
        swapped.forward(&sink, true).await;
        assert!(lines.try_recv().is_err());
    }
}
