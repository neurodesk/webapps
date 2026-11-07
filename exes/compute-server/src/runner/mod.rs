//! Runners execute a tool's `argv`: docker, apptainer, a native binary on
//! `PATH`, the built-in simulated tool, or Slurm batch jobs.
//!
//! A runner reports state to the job store through a [`StatusReporter`]
//! (`Submitting`, `Submitted`, scheduler states, `Running`) and resolves its
//! future with the final [`RunOutcome`]. The store never marks a job running
//! before the runner says so.

pub mod apptainer;
pub mod docker;
pub mod native;
pub mod process;
pub mod simulate;
pub mod slurm;

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::config::{RunnerKind, ServeConfig};
use crate::profiles::Profile;
use crate::tools::project::LaunchPlan;
use crate::tools::{FileTool, Tool, ToolPaths, ValidatedJob};

/// Receives every stdout/stderr line of the tool.
pub type LineSink = mpsc::UnboundedSender<String>;

/// A boxed future returned by [`Runner::run`].
pub type RunFuture = Pin<Box<dyn Future<Output = io::Result<RunOutcome>> + Send>>;

/// How a run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    /// The tool exited with the given status code.
    Exited(i32),
    /// The run was cancelled before the tool finished.
    Cancelled,
    /// The run failed for a reason the runner names (`scheduler-failed`, …).
    Failed {
        /// Protocol error code.
        code: &'static str,
        /// Human-readable message.
        message: String,
    },
    /// The server is stopping and left the job to its scheduler.
    Detached,
}

/// A state change the runner reports while a job runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerEvent {
    /// The runner is about to hand the job to the scheduler. The store
    /// persists the time before this report returns.
    Submitting {
        /// Submission time, the reference for reconciliation.
        at: DateTime<Utc>,
    },
    /// The scheduler accepted the job under this id.
    Submitted {
        /// Scheduler job id.
        scheduler_id: String,
    },
    /// The scheduler reports the job waiting in its queue.
    Pending {
        /// Scheduler state string (`PENDING`).
        state: String,
        /// Why it waits (`Priority`).
        reason: Option<String>,
    },
    /// The tool started executing.
    Running {
        /// Scheduler state string, `None` for local runners.
        state: Option<String>,
    },
}

/// Applies runner events to a job.
pub trait StatusReporter: Send + Sync {
    /// Applies and persists an event. An error means the store could not
    /// persist it; a runner must not hand a job to a scheduler after a failed
    /// `Submitting` report.
    fn report(&self, event: RunnerEvent) -> io::Result<()>;
}

/// The channels of one run.
#[derive(Clone)]
pub struct RunContext {
    /// Log lines.
    pub lines: LineSink,
    /// State changes.
    pub status: Arc<dyn StatusReporter>,
    /// Cancelled when the user cancels the job.
    pub cancel: CancellationToken,
    /// Cancelled when the server stops; runners that detach resolve to
    /// [`RunOutcome::Detached`].
    pub detach: CancellationToken,
}

/// Scheduler state persisted by an earlier server process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resume {
    /// The persisted submission time.
    pub submitted_at: DateTime<Utc>,
    /// The scheduler id, when it was saved.
    pub scheduler_id: Option<String>,
}

/// A project job's directories, resources and launch.
#[derive(Clone)]
pub struct ProjectRun {
    /// The tool, for the simulated runner.
    pub tool: Arc<dyn Tool>,
    /// Host path of the project directory, mounted at `/project`.
    pub project_dir: PathBuf,
    /// `<Type>/jobNNN`.
    pub directory: String,
    /// Resources.
    pub profile: Profile,
    /// Ranks, threads, GPUs.
    pub launch: LaunchPlan,
    /// Commands after the main program (whose argv is the request's).
    pub follow_up: Vec<Vec<String>>,
}

/// Everything a runner needs to execute one job.
#[derive(Clone)]
pub struct RunRequest {
    /// Job identifier (used to name containers and scheduler jobs).
    pub job_id: String,
    /// Absolute directory the job writes: the record directory with `in/` and
    /// `out/`, or the project job's `<Type>/jobNNN`.
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
    /// Set for project jobs.
    pub project: Option<ProjectRun>,
    /// Set when re-attaching to a job submitted by an earlier server process.
    pub resume: Option<Resume>,
}

impl RunRequest {
    /// Resolves a file tool's command line, GPU use and image for one job.
    pub fn files(
        tool: &dyn Tool,
        file_tool: &dyn FileTool,
        job_id: String,
        job_dir: PathBuf,
        job: ValidatedJob,
        paths: &ToolPaths,
        cpu: bool,
    ) -> Self {
        let mut argv = file_tool.argv(&job, paths);
        if cpu && tool.uses_gpu() {
            argv.extend(file_tool.cpu_flags().iter().map(|flag| flag.to_string()));
        }
        Self {
            job_id,
            job_dir,
            argv,
            job,
            gpu: tool.uses_gpu() && !cpu,
            image: tool.pinned_image(),
            project: None,
            resume: None,
        }
    }
}

/// What recovery does with a job an earlier server process left unfinished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// Fail it as `interrupted`.
    Interrupted,
    /// Put it back into the server's queue; it never reached the runner.
    Requeue,
    /// Resume watching it.
    Reattach,
}

/// Executes tool command lines.
pub trait Runner: Send + Sync {
    /// Which runner this is.
    fn kind(&self) -> RunnerKind;
    /// The paths a file tool sees for the given job directory.
    fn paths(&self, job_dir: &Path) -> ToolPaths;
    /// Runs the tool, forwarding every output line and state change.
    /// Cancelling `context.cancel` stops the tool; the future then resolves
    /// to [`RunOutcome::Cancelled`] once termination is confirmed.
    fn run(&self, request: RunRequest, context: RunContext) -> RunFuture;
    /// Decides what happens to an unfinished job of this runner after a
    /// restart. `submitted` says whether the runner persisted a submission.
    /// Local runners stop leftovers and fail the job.
    fn recover(&self, job_id: &str, submitted: bool) -> io::Result<Recovery> {
        let _ = submitted;
        process::reconcile(self.kind(), job_id)?;
        Ok(Recovery::Interrupted)
    }
    /// Whether jobs outlive the server: shutdown detaches instead of cancelling.
    fn detaches(&self) -> bool {
        false
    }
    /// An error while the runner cannot accept new work.
    fn health(&self) -> Result<(), String> {
        Ok(())
    }
}

/// Builds the runner selected by the configuration.
pub fn build(config: &ServeConfig) -> io::Result<Arc<dyn Runner>> {
    Ok(match config.runner {
        RunnerKind::Docker => Arc::new(docker::DockerRunner {
            image: config.image.clone(),
        }),
        RunnerKind::Apptainer => Arc::new(apptainer::ApptainerRunner {
            image: PathBuf::from(&config.image),
        }),
        RunnerKind::Native => Arc::new(native::NativeRunner),
        RunnerKind::Simulate => Arc::new(simulate::SimulateRunner),
        RunnerKind::Slurm => {
            let settings = config
                .slurm
                .clone()
                .ok_or_else(|| io::Error::other("--runner slurm requires --slurm-config"))?;
            Arc::new(slurm::SlurmRunner::new(settings, config.data_roots.clone()))
        }
    })
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
