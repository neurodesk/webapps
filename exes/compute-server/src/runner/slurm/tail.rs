//! Forwards new lines of `run.out` and `run.err`, Slurm's copy of the log,
//! read from the start on every attach.

use std::io::SeekFrom;
use std::path::{Path, PathBuf};

use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::runner::LineSink;

struct Followed {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
}

/// Follows a job's two log files.
pub struct Tail {
    files: Vec<Followed>,
}

impl Tail {
    /// Follows `run.out` and `run.err` in `job_dir` from their start.
    pub fn new(job_dir: &Path) -> Tail {
        Tail {
            files: ["run.out", "run.err"]
                .into_iter()
                .map(|name| Followed {
                    path: job_dir.join(name),
                    offset: 0,
                    partial: Vec::new(),
                })
                .collect(),
        }
    }

    /// Sends complete new lines; `finish` also sends unterminated last lines.
    pub async fn forward(&mut self, sink: &LineSink, finish: bool) {
        for file in &mut self.files {
            let Ok(mut handle) = tokio::fs::File::open(&file.path).await else {
                continue;
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

    #[tokio::test]
    async fn forwards_complete_lines_and_rereads_from_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let (sink, mut lines) = tokio::sync::mpsc::unbounded_channel();
        let mut tail = Tail::new(dir.path());
        tail.forward(&sink, false).await;
        std::fs::write(dir.path().join("run.out"), "one\ntw").unwrap();
        std::fs::write(dir.path().join("run.err"), "err 1\n").unwrap();
        tail.forward(&sink, false).await;
        assert_eq!(lines.recv().await.unwrap(), "one");
        assert_eq!(lines.recv().await.unwrap(), "err 1");
        assert!(lines.try_recv().is_err());
        std::fs::write(
            dir.path().join("run.out"),
            "one\ntwo\n 000/??? sec ..\r 001/010 sec ....",
        )
        .unwrap();
        tail.forward(&sink, true).await;
        assert_eq!(lines.recv().await.unwrap(), "two");
        assert_eq!(lines.recv().await.unwrap(), " 000/??? sec ..");
        assert_eq!(lines.recv().await.unwrap(), " 001/010 sec ....");
        let mut again = Tail::new(dir.path());
        again.forward(&sink, true).await;
        assert_eq!(lines.recv().await.unwrap(), "one");
    }
}
