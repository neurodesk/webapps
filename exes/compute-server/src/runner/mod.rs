//! Runners execute a tool's `argv` in a job directory: docker, apptainer, a
//! native binary on `PATH`, or the built-in simulated tool.

pub mod apptainer;
pub mod docker;
pub mod native;
pub mod process;
pub mod simulate;

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::config::{RunnerKind, ServeConfig};
use crate::tools::{Tool, ToolPaths, ValidatedJob};

/// Receives every stdout/stderr line of the tool.
pub type LineSink = mpsc::UnboundedSender<String>;

/// A boxed future returned by [`Runner::run`].
pub type RunFuture = Pin<Box<dyn Future<Output = io::Result<RunOutcome>> + Send>>;

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    /// The tool exited with the given status code.
    Exited(i32),
    /// The run was cancelled before the tool finished.
    Cancelled,
}

/// Everything a runner needs to execute one job.
#[derive(Debug, Clone)]
pub struct RunRequest {
    /// Job identifier (used to name containers).
    pub job_id: String,
    /// Absolute job directory with `in/` and `out/`.
    pub job_dir: PathBuf,
    /// Complete tool command line, including the tool's CPU flags when a GPU
    /// tool runs on the CPU.
    pub argv: Vec<String>,
    /// The validated job.
    pub job: ValidatedJob,
    /// Pass the host GPU to the tool.
    pub gpu: bool,
    /// The tool's pinned image, which replaces the configured one.
    pub image: Option<&'static str>,
}

impl RunRequest {
    /// Resolves a tool's command line, GPU use and image for one job.
    pub fn new(
        tool: &dyn Tool,
        job_id: String,
        job_dir: PathBuf,
        job: ValidatedJob,
        paths: &ToolPaths,
        cpu: bool,
    ) -> Self {
        let mut argv = tool.argv(&job, paths);
        if cpu && tool.uses_gpu() {
            argv.extend(tool.cpu_flags().iter().map(|flag| flag.to_string()));
        }
        Self {
            job_id,
            job_dir,
            argv,
            job,
            gpu: tool.uses_gpu() && !cpu,
            image: tool.pinned_image(),
        }
    }
}

/// Executes tool command lines.
pub trait Runner: Send + Sync {
    /// Which runner this is.
    fn kind(&self) -> RunnerKind;
    /// The paths the tool sees for the given job directory.
    fn paths(&self, job_dir: &Path) -> ToolPaths;
    /// Runs the tool, forwarding every output line to `sink`. Cancelling the
    /// token stops the tool; the future then resolves to
    /// [`RunOutcome::Cancelled`].
    fn run(&self, request: RunRequest, sink: LineSink, cancel: CancellationToken) -> RunFuture;
}

/// Builds the runner selected by the configuration.
pub fn build(config: &ServeConfig) -> Arc<dyn Runner> {
    match config.runner {
        RunnerKind::Docker => Arc::new(docker::DockerRunner {
            image: config.image.clone(),
        }),
        RunnerKind::Apptainer => Arc::new(apptainer::ApptainerRunner {
            image: PathBuf::from(&config.image),
        }),
        RunnerKind::Native => Arc::new(native::NativeRunner),
        RunnerKind::Simulate => Arc::new(simulate::SimulateRunner),
    }
}

/// Formats a command line for a log line, quoting arguments with spaces.
pub fn shell_join(argv: &[String]) -> String {
    argv.iter()
        .map(|argument| {
            if argument.contains(' ') {
                format!("'{argument}'")
            } else {
                argument.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
