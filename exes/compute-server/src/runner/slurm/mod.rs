//! The Slurm runner (ADR-0004, "Job lifecycle on Slurm").
//!
//! A job is written as `job.sbatch` in its directory, the submission time is
//! persisted, then `sbatch` hands it to Slurm under the unique name
//! `nd-<job id>` and the id is persisted. A lost answer is reconciled by name.
//! One shared `squeue --me` per interval tracks every job; a job that left
//! the queue is resolved by `sacct -X`, then `scontrol show job`. Shutdown
//! detaches; a restart re-attaches jobs with a Slurm id and reconciles the
//! rest.

pub mod checks;
pub mod commands;
pub mod config;
pub mod poll;
pub mod probe;
pub mod reconcile;
pub mod script;
pub mod tail;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;

pub use config::{Scratch, SlurmConfig, SlurmSettings, SlurmTimings};

use self::commands::{JobState, SbatchError, Slurm};
use self::poll::Poller;
use self::reconcile::Reconciled;
use self::script::{Script, Step};
use self::tail::Tail;
use super::{
    ProjectRun, Recovery, RunContext, RunFuture, RunOutcome, RunRequest, Runner, RunnerEvent,
};
use crate::config::RunnerKind;
use crate::roots::DataRoot;
use crate::tools::ToolPaths;

/// Marker RELION writes with `--pipeline_control` on success.
pub const SUCCESS_MARKER: &str = "RELION_JOB_EXIT_SUCCESS";

/// Marker RELION writes with `--pipeline_control` on failure.
pub const FAILURE_MARKER: &str = "RELION_JOB_EXIT_FAILURE";

/// Slurm job name of a compute job.
pub fn job_name(job_id: &str) -> String {
    format!("nd-{job_id}")
}

struct Shared {
    settings: SlurmSettings,
    roots: Vec<DataRoot>,
    slurm: Slurm,
    poller: Poller,
}

/// Runs project jobs as Slurm batch jobs.
pub struct SlurmRunner {
    shared: Arc<Shared>,
}

impl SlurmRunner {
    /// A runner for these settings and data roots.
    pub fn new(settings: SlurmSettings, roots: Vec<DataRoot>) -> SlurmRunner {
        let slurm = Slurm {
            path: settings.path.clone(),
            timeout: settings.timings.command_timeout,
            user: settings.user.clone(),
        };
        let poller = Poller::new(
            slurm.clone(),
            settings.timings.poll,
            settings.timings.unavailable_after,
        );
        SlurmRunner {
            shared: Arc::new(Shared {
                settings,
                roots,
                slurm,
                poller,
            }),
        }
    }
}

impl Runner for SlurmRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Slurm
    }

    fn paths(&self, _job_dir: &Path) -> ToolPaths {
        ToolPaths::container()
    }

    fn run(&self, request: RunRequest, context: RunContext) -> RunFuture {
        let shared = Arc::clone(&self.shared);
        Box::pin(async move { shared.run(request, context).await })
    }

    fn recover(&self, _job_id: &str, submitted: bool) -> io::Result<Recovery> {
        Ok(if submitted {
            Recovery::Reattach
        } else {
            Recovery::Requeue
        })
    }

    fn detaches(&self) -> bool {
        true
    }

    fn health(&self) -> Result<(), String> {
        self.shared.poller.health()
    }
}

/// What one poll established about a job.
enum Seen {
    /// Slurm holds or runs it, in this state and for this pending reason.
    Queued(String, Option<String>),
    /// Accounting or the controller report a terminal state.
    Ended(JobState),
    /// Nothing knows the job.
    Unknown,
    /// A command failed; the state is unchanged.
    Unavailable,
}

/// Reports a queue state: running states as running, others as pending.
fn report(state: &str, reason: Option<String>, context: &RunContext) {
    let event = if matches!(state, "RUNNING" | "COMPLETING" | "STAGE_OUT") {
        RunnerEvent::Running {
            state: Some(state.to_string()),
        }
    } else {
        RunnerEvent::Pending {
            state: state.to_string(),
            reason,
        }
    };
    if let Err(error) = context.status.report(event) {
        tracing::error!(%error, "could not persist the scheduler state");
    }
}

/// What tracking a submitted job ended with.
enum Tracked {
    Ended(JobState),
    Lost,
    Detached,
}

impl Shared {
    fn timings(&self) -> &SlurmTimings {
        &self.settings.timings
    }

    async fn run(&self, request: RunRequest, context: RunContext) -> io::Result<RunOutcome> {
        let project = request
            .project
            .clone()
            .ok_or_else(|| io::Error::other("the Slurm runner runs project jobs only"))?;
        let name = job_name(&request.job_id);
        let job_dir = request.job_dir.clone();
        let id = match &request.resume {
            Some(resume) => match &resume.scheduler_id {
                Some(id) => id.clone(),
                None => match self.adopt(&name, resume.submitted_at, &context).await? {
                    Ok(id) => id,
                    Err(outcome) => return Ok(outcome),
                },
            },
            None => match self.submit(&request, &project, &name, &context).await? {
                Ok(id) => id,
                Err(outcome) => return Ok(outcome),
            },
        };
        let mut tail = Tail::new(&job_dir);
        let tracked = self.track(&id, &mut tail, &context).await;
        let outcome = match tracked {
            Tracked::Detached => RunOutcome::Detached,
            Tracked::Lost => RunOutcome::Failed {
                code: "scheduler-lost",
                message: format!(
                    "Slurm no longer knows job {id}; neither squeue, sacct nor scontrol reported it for {}s",
                    self.timings().retry_window.as_secs()
                ),
            },
            Tracked::Ended(state) => self.conclude(&id, &state, &job_dir, &context).await,
        };
        tail.forward(&context.lines, true).await;
        Ok(outcome)
    }

    /// Writes `job.sbatch`, persists the intent and calls `sbatch`. A lost
    /// answer is reconciled; a refusal fails the job.
    async fn submit(
        &self,
        request: &RunRequest,
        project: &ProjectRun,
        name: &str,
        context: &RunContext,
    ) -> io::Result<Result<String, RunOutcome>> {
        if context.cancel.is_cancelled() {
            return Ok(Err(RunOutcome::Cancelled));
        }
        let script_path = request.job_dir.join("job.sbatch");
        let text = self.script(request, project, name);
        std::fs::write(&script_path, text)?;
        std::fs::File::open(&script_path)?.sync_all()?;
        let at = Utc::now();
        context.status.report(RunnerEvent::Submitting { at })?;
        let submitted = tokio::select! {
            submitted = self.slurm.sbatch(&script_path, &request.job_dir, &[]) => submitted,
            _ = context.detach.cancelled() => return Ok(Err(RunOutcome::Detached)),
        };
        match submitted {
            Ok(id) => {
                if let Err(error) = context.status.report(RunnerEvent::Submitted {
                    scheduler_id: id.clone(),
                }) {
                    tracing::error!(%error, job = name, "could not persist the Slurm id; a restart reconciles it");
                }
                Ok(Ok(id))
            }
            Err(SbatchError::Rejected(message)) => Ok(Err(RunOutcome::Failed {
                code: "scheduler-failed",
                message,
            })),
            Err(SbatchError::Unknown(message)) => {
                tracing::warn!(job = name, %message, "sbatch answer lost; reconciling");
                self.adopt(name, at, context).await
            }
        }
    }

    /// Reconciles a submission whose id is unknown.
    async fn adopt(
        &self,
        name: &str,
        submitted_at: chrono::DateTime<Utc>,
        context: &RunContext,
    ) -> io::Result<Result<String, RunOutcome>> {
        let reconciled = reconcile::reconcile(
            &self.slurm,
            name,
            submitted_at,
            self.timings(),
            &context.detach,
        )
        .await;
        Ok(match reconciled {
            Reconciled::Found(id) => {
                context.status.report(RunnerEvent::Submitted {
                    scheduler_id: id.clone(),
                })?;
                Ok(id)
            }
            Reconciled::Detached => Err(RunOutcome::Detached),
            Reconciled::Absent if context.cancel.is_cancelled() => Err(RunOutcome::Cancelled),
            Reconciled::Absent => Err(RunOutcome::Failed {
                code: "interrupted",
                message: format!(
                    "Slurm has no job named {name}: the submission was never accepted. Submit a new job to retry."
                ),
            }),
        })
    }

    fn script(&self, request: &RunRequest, project: &ProjectRun, name: &str) -> String {
        let config = &self.settings.config;
        let mut steps = vec![Step {
            argv: request.argv.clone(),
            ranks: project.launch.ranks,
        }];
        steps.extend(project.follow_up.iter().map(|argv| Step {
            argv: argv.clone(),
            ranks: None,
        }));
        script::render(&Script {
            name,
            job_dir: &request.job_dir,
            project_dir: &project.project_dir,
            roots: &self.roots,
            profile: &project.profile,
            gpu: project.launch.gpus > 0,
            apptainer: &config.apptainer,
            image: &config.image,
            scratch: &config.scratch,
            steps: &steps,
        })
    }

    /// Follows a submitted job until Slurm reports a terminal state, forgets
    /// it, or the server stops. A user cancel calls `scancel` until it succeeds.
    async fn track(&self, id: &str, tail: &mut Tail, context: &RunContext) -> Tracked {
        let mut snapshots = self.poller.subscribe();
        let mut seen = 0;
        let mut cancelled = false;
        let mut reported: Option<(String, Option<String>)> = None;
        let mut missing_since: Option<Instant> = None;
        loop {
            if context.cancel.is_cancelled() && !cancelled {
                match self.slurm.cancel(id).await {
                    Ok(()) => cancelled = true,
                    Err(error) => tracing::warn!(%error, job = id, "scancel failed; retrying"),
                }
            }
            tail.forward(&context.lines, false).await;
            let snapshot = snapshots.borrow_and_update().clone();
            if snapshot.generation != seen {
                seen = snapshot.generation;
                if let Some(queue) = snapshot.queue {
                    let seen_as = match queue.get(id) {
                        Some(entry) => Seen::Queued(entry.state.clone(), entry.reason.clone()),
                        None => self.left_queue(id).await,
                    };
                    match seen_as {
                        Seen::Queued(state, reason) => {
                            missing_since = None;
                            if reported.as_ref() != Some(&(state.clone(), reason.clone())) {
                                report(&state, reason.clone(), context);
                                reported = Some((state, reason));
                            }
                        }
                        Seen::Ended(ended) => return Tracked::Ended(ended),
                        Seen::Unknown => {
                            let first = *missing_since.get_or_insert_with(Instant::now);
                            if first.elapsed() >= self.timings().retry_window {
                                return Tracked::Lost;
                            }
                        }
                        Seen::Unavailable => {}
                    }
                }
            }
            tokio::select! {
                _ = snapshots.changed() => {},
                _ = context.cancel.cancelled(), if !cancelled => {},
                _ = context.detach.cancelled() => return Tracked::Detached,
                _ = tokio::time::sleep(self.timings().tail) => {},
            }
        }
    }

    /// What accounting, then `scontrol`, know about a job missing from the queue.
    async fn left_queue(&self, id: &str) -> Seen {
        let known = match self.slurm.accounting(id).await {
            Ok(Some(state)) => Some(state),
            Ok(None) => match self.slurm.control(id).await {
                Ok(state) => state,
                Err(error) => {
                    tracing::warn!(%error, job = id, "scontrol failed");
                    return Seen::Unavailable;
                }
            },
            Err(error) => {
                tracing::warn!(%error, job = id, "sacct failed");
                return Seen::Unavailable;
            }
        };
        match known {
            None => Seen::Unknown,
            Some(state) if state.is_terminal() => Seen::Ended(state),
            Some(state) => Seen::Queued(state.state, None),
        }
    }

    /// Maps a terminal Slurm state to the job's outcome (ADR-0004 table).
    async fn conclude(
        &self,
        id: &str,
        ended: &JobState,
        job_dir: &Path,
        context: &RunContext,
    ) -> RunOutcome {
        let failed = || RunOutcome::Failed {
            code: "scheduler-failed",
            message: format!("Slurm job {id} ended {} (exit {})", ended.state, ended.exit),
        };
        match ended.state.as_str() {
            "COMPLETED" if ended.exit == "0:0" => self.marker(job_dir, &context.detach).await,
            "CANCELLED" if context.cancel.is_cancelled() => RunOutcome::Cancelled,
            _ => failed(),
        }
    }

    /// Waits for RELION's exit marker after `COMPLETED`, because the submit
    /// host's NFS cache can lag behind the compute node.
    async fn marker(
        &self,
        job_dir: &Path,
        detach: &tokio_util::sync::CancellationToken,
    ) -> RunOutcome {
        let deadline = Instant::now() + self.timings().marker_grace;
        let step = self.timings().tail.min(Duration::from_secs(1));
        loop {
            refresh(job_dir);
            if job_dir.join(SUCCESS_MARKER).exists() {
                return RunOutcome::Exited(0);
            }
            if job_dir.join(FAILURE_MARKER).exists() {
                return RunOutcome::Failed {
                    code: "tool-failed",
                    message: format!("RELION wrote {FAILURE_MARKER}"),
                };
            }
            if Instant::now() >= deadline {
                return RunOutcome::Failed {
                    code: "tool-failed",
                    message: format!(
                        "Slurm reports COMPLETED but no {SUCCESS_MARKER} appeared within {}s",
                        self.timings().marker_grace.as_secs()
                    ),
                };
            }
            tokio::select! {
                _ = tokio::time::sleep(step) => {},
                _ = detach.cancelled() => return RunOutcome::Detached,
            }
        }
    }
}

/// Reading a directory makes NFS clients revalidate its cached entries.
fn refresh(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        entries.for_each(drop);
    }
}

/// Where `check-slurm` and startup checks keep their scratch files.
pub fn check_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("slurm-checks")
}
