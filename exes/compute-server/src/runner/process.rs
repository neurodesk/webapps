//! Shared child-process handling for the docker, apptainer and native runners.

use std::io;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;

use super::{LineSink, RunContext, RunOutcome, RunnerEvent};

/// How a running process is stopped on cancellation.
#[derive(Debug, Clone)]
pub enum KillStrategy {
    /// Kill the child process directly.
    KillChild,
    /// Run another command (e.g. `docker kill <name>`) and then wait for the child.
    Command(Vec<String>),
}

/// Spawns `program args…` with piped stdout and stderr, reports the job
/// running once spawned, forwards every line, and resolves when the process
/// exits or is cancelled.
pub async fn run_process(
    program: &str,
    args: &[String],
    context: RunContext,
    kill: KillStrategy,
) -> io::Result<RunOutcome> {
    let RunContext {
        lines: sink,
        status,
        cancel,
        ..
    } = context;
    let mut command = Command::new(program);
    command.args(args);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|error| {
        io::Error::new(error.kind(), format!("could not start {program}: {error}"))
    })?;
    if let Err(error) = status.report(RunnerEvent::Running { state: None }) {
        tracing::error!(%error, "could not persist the running state");
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tokio::spawn(forward_lines(stdout, sink.clone()));
    let stderr_task = tokio::spawn(forward_lines(stderr, sink));
    let mut forwarders = Forwarders(vec![stdout_task, stderr_task]);

    let mut cancelled = false;
    let mut termination_error = None;
    let status = tokio::select! {
        status = child.wait() => status?,
        _ = cancel.cancelled() => {
            cancelled = true;
            if let KillStrategy::Command(argv) = &kill {
                if let Some((kill_program, kill_args)) = argv.split_first() {
                    let mut stopper = Command::new(kill_program);
                    stopper.args(kill_args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
                    let result = tokio::time::timeout(std::time::Duration::from_secs(10), stopper.status()).await;
                    if !matches!(result, Ok(Ok(status)) if status.success()) {
                        termination_error = Some(io::Error::other("container termination could not be confirmed"));
                    }
                }
            }
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                let status = Command::new("kill").args(["-KILL", "--", &format!("-{pid}")]).status().await?;
                if !status.success() {
                    child.start_kill()?;
                }
            }
            #[cfg(not(unix))]
            child.start_kill()?;
            child.wait().await?
        }
    };
    for mut task in forwarders.0.drain(..) {
        if tokio::time::timeout(std::time::Duration::from_secs(5), &mut task)
            .await
            .is_err()
        {
            task.abort();
        }
    }
    if let Some(error) = termination_error {
        return Err(error);
    }
    if cancelled {
        return Ok(RunOutcome::Cancelled);
    }
    Ok(RunOutcome::Exited(exit_code(status)))
}

struct Forwarders(Vec<tokio::task::JoinHandle<()>>);

impl Drop for Forwarders {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
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

/// Stop surviving containers before recovering interrupted records. Native process
/// trees cannot be safely identified after restart without an external supervisor.
pub fn reconcile(kind: crate::config::RunnerKind, id: &str) -> io::Result<()> {
    match kind {
        crate::config::RunnerKind::Simulate => Ok(()),
        crate::config::RunnerKind::Slurm => Err(io::Error::other("an unfinished Slurm job requires --runner slurm to re-attach")),
        crate::config::RunnerKind::Docker => {
            let name = super::docker::container_name(id);
            let output = bounded_command("docker", &["container", "ls", "--all", "--filter", &format!("name=^{name}$"), "--format", "{{.Names}}"])?;
            if !output.status.success() { return Err(io::Error::other("cannot inspect interrupted container")); }
            if String::from_utf8_lossy(&output.stdout).lines().any(|line| line == name) {
                let output = bounded_command("docker", &["rm", "--force", &name])?;
                if !output.status.success() { return Err(io::Error::other("cannot stop interrupted container")); }
            }
            Ok(())
        }
        _ => Err(io::Error::other("interrupted native/apptainer process requires operator termination before recovery; use the Docker runner for managed crash recovery")),
    }
}

fn bounded_command(program: &str, args: &[&str]) -> io::Result<std::process::Output> {
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "container cleanup timed out",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    struct Ignore;

    impl super::super::StatusReporter for Ignore {
        fn report(&self, _event: RunnerEvent) -> io::Result<()> {
            Ok(())
        }
    }

    fn context(sink: LineSink, cancel: CancellationToken) -> RunContext {
        RunContext {
            lines: sink,
            status: std::sync::Arc::new(Ignore),
            cancel,
            detach: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn cancellation_stops_descendants_before_returning() {
        let (sink, mut lines) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            run_process(
                "sh",
                &["-c".into(), "sleep 60 & echo $!; wait".into()],
                context(sink, task_cancel),
                KillStrategy::KillChild,
            )
            .await
        });
        let pid = lines.recv().await.unwrap();
        cancel.cancel();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(outcome, RunOutcome::Cancelled);
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            let mut fields = stat.split_once(") ").unwrap().1.split_whitespace();
            let state = fields.next().unwrap();
            let flags = fields.nth(5).unwrap().parse::<u64>().unwrap();
            // Linux do_exit closes the pipes before exit_notify marks the task as a zombie.
            const PF_EXITING: u64 = 0x4;
            assert!(
                state == "Z" || flags & PF_EXITING != 0,
                "descendant still live: {stat}"
            );
        }
    }

    #[tokio::test]
    async fn failed_container_stop_is_not_reported_as_cancelled() {
        let (sink, mut lines) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            run_process(
                "sh",
                &["-c".into(), "echo ready; sleep 60".into()],
                context(sink, task_cancel),
                KillStrategy::Command(vec!["sh".into(), "-c".into(), "exit 1".into()]),
            )
            .await
        });
        lines.recv().await.unwrap();
        cancel.cancel();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert!(outcome
            .unwrap_err()
            .to_string()
            .contains("could not be confirmed"));
    }
}
