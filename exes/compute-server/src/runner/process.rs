//! Shared child-process handling for the docker, apptainer and native runners.

use std::io;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::{LineSink, RunOutcome};

/// How a running process is stopped on cancellation.
#[derive(Debug, Clone)]
pub enum KillStrategy {
    /// Kill the child process directly.
    KillChild,
    /// Run another command (e.g. `docker kill <name>`) and then wait for the child.
    Command(Vec<String>),
}

/// Spawns `program args…` with piped stdout and stderr, forwards every line
/// to `sink`, and resolves when the process exits or is cancelled.
pub async fn run_process(
    program: &str,
    args: &[String],
    sink: LineSink,
    cancel: CancellationToken,
    kill: KillStrategy,
) -> io::Result<RunOutcome> {
    let mut command = Command::new(program);
    command.args(args);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        io::Error::new(error.kind(), format!("could not start {program}: {error}"))
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tokio::spawn(forward_lines(stdout, sink.clone()));
    let stderr_task = tokio::spawn(forward_lines(stderr, sink));

    let mut cancelled = false;
    let status = tokio::select! {
        status = child.wait() => status?,
        _ = cancel.cancelled() => {
            cancelled = true;
            match &kill {
                KillStrategy::KillChild => {
                    child.start_kill()?;
                }
                KillStrategy::Command(argv) => {
                    if let Some((kill_program, kill_args)) = argv.split_first() {
                        let result = Command::new(kill_program)
                            .args(kill_args)
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status()
                            .await;
                        if result.is_err() {
                            child.start_kill()?;
                        }
                    }
                }
            }
            child.wait().await?
        }
    };
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    if cancelled {
        return Ok(RunOutcome::Cancelled);
    }
    Ok(RunOutcome::Exited(exit_code(status)))
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    -1
}

async fn forward_lines<R: AsyncRead + Unpin + Send + 'static>(reader: Option<R>, sink: LineSink) {
    let Some(reader) = reader else {
        return;
    };
    let mut lines = BufReader::new(reader).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                for piece in line.split('\r') {
                    let trimmed = piece.trim_end();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if sink.send(trimmed.to_string()).is_err() {
                        return;
                    }
                }
            }
            Ok(None) => return,
            Err(_) => return,
        }
    }
}
