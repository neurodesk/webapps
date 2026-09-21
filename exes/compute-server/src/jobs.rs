//! The job store: queue, worker tasks, per-job event broadcast, retention.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use crate::runner::{shell_join, RunOutcome, RunRequest, Runner};
use crate::tools::{LogLevel, Tool, ValidatedJob};

/// Maximum number of log lines kept in memory per job (the file gets all).
pub const MAX_LOG_LINES: usize = 20_000;

/// Lifecycle state of a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Waiting for a worker.
    Queued,
    /// A runner is executing the tool.
    Running,
    /// The tool exited with status 0 and wrote its outputs.
    Succeeded,
    /// The tool failed.
    Failed,
    /// Cancelled through `DELETE`.
    Cancelled,
}

impl Status {
    /// Whether the job reached a final state.
    pub fn is_finished(self) -> bool {
        matches!(self, Status::Succeeded | Status::Failed | Status::Cancelled)
    }
}

/// Error record of a failed job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobError {
    /// Error code (`tool-failed`).
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

/// A produced output file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputInfo {
    /// File name.
    pub name: String,
    /// Size in bytes.
    pub bytes: u64,
    /// MIME type.
    pub content_type: String,
}

/// The job object of `GET /api/v1/jobs/{id}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    /// Job identifier.
    pub id: String,
    /// Tool identifier.
    pub tool: String,
    /// Tool command.
    pub command: String,
    /// Current state.
    pub status: Status,
    /// Number of jobs ahead in the queue (0 unless queued).
    pub position: usize,
    /// Progress fraction, `null` before the first progress event.
    pub progress: Option<f64>,
    /// Current stage name.
    pub stage: Option<String>,
    /// Last log line.
    pub message: Option<String>,
    /// Whether the placeholder tool produced the result.
    pub simulated: bool,
    /// RFC 3339 creation time.
    pub created_at: String,
    /// RFC 3339 start time.
    pub started_at: Option<String>,
    /// RFC 3339 finish time.
    pub finished_at: Option<String>,
    /// Error of a failed job.
    pub error: Option<JobError>,
    /// Outputs of a succeeded job.
    pub outputs: Vec<OutputInfo>,
}

/// An event of the job's SSE stream.
#[derive(Debug, Clone)]
pub enum Event {
    /// The job changed state or queue position.
    Status { status: Status, position: usize },
    /// Progress advanced.
    Progress { fraction: f64, stage: String },
    /// A log line.
    Log { line: String, level: LogLevel },
    /// The job finished; carries the final job object.
    Done(Box<JobView>),
}

impl Event {
    /// SSE event name.
    pub fn name(&self) -> &'static str {
        match self {
            Event::Status { .. } => "status",
            Event::Progress { .. } => "progress",
            Event::Log { .. } => "log",
            Event::Done(_) => "done",
        }
    }

    /// SSE event data.
    pub fn data(&self) -> Value {
        match self {
            Event::Status { status, position } => {
                serde_json::json!({ "status": status, "position": position })
            }
            Event::Progress { fraction, stage } => {
                serde_json::json!({ "fraction": fraction, "stage": stage })
            }
            Event::Log { line, level } => {
                serde_json::json!({ "line": line, "level": level.as_str() })
            }
            Event::Done(view) => serde_json::to_value(view.as_ref()).unwrap_or(Value::Null),
        }
    }
}

struct Job {
    id: String,
    tool: Arc<dyn Tool>,
    validated: ValidatedJob,
    dir: PathBuf,
    status: Status,
    progress: Option<f64>,
    stage: Option<String>,
    message: Option<String>,
    created_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    error: Option<JobError>,
    outputs: Vec<OutputInfo>,
    log: Vec<(String, LogLevel)>,
    events: broadcast::Sender<Event>,
    cancel: CancellationToken,
}

fn rfc3339(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

impl Job {
    fn view(&self, position: usize, simulated: bool) -> JobView {
        JobView {
            id: self.id.clone(),
            tool: self.tool.id().to_string(),
            command: self.validated.command.clone(),
            status: self.status,
            position,
            progress: self.progress,
            stage: self.stage.clone(),
            message: self.message.clone(),
            simulated,
            created_at: rfc3339(self.created_at),
            started_at: self.started_at.map(rfc3339),
            finished_at: self.finished_at.map(rfc3339),
            error: self.error.clone(),
            outputs: self.outputs.clone(),
        }
    }

    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }
}

struct Inner {
    jobs: HashMap<String, Job>,
    queue: VecDeque<String>,
}

impl Inner {
    /// Number of jobs ahead of `id`: running jobs plus earlier queued jobs.
    fn position(&self, id: &str) -> usize {
        match self.queue.iter().position(|queued| queued == id) {
            Some(index) => index + self.running_count(),
            None => 0,
        }
    }

    fn running_count(&self) -> usize {
        self.jobs
            .values()
            .filter(|job| job.status == Status::Running)
            .count()
    }
}

/// What the worker needs to run a job it dequeued.
struct Started {
    request: RunRequest,
    cancel: CancellationToken,
}

/// Shared store of all jobs.
pub struct JobStore {
    inner: Mutex<Inner>,
    queue_tx: mpsc::UnboundedSender<String>,
    queue_rx: tokio::sync::Mutex<mpsc::UnboundedReceiver<String>>,
    runner: Arc<dyn Runner>,
    simulated: bool,
    cpu: bool,
    retain: Duration,
}

impl JobStore {
    /// Creates a store that executes jobs with `runner`.
    pub fn new(
        runner: Arc<dyn Runner>,
        simulated: bool,
        cpu: bool,
        retain: Duration,
    ) -> Arc<JobStore> {
        let (queue_tx, queue_rx) = mpsc::unbounded_channel();
        Arc::new(JobStore {
            inner: Mutex::new(Inner {
                jobs: HashMap::new(),
                queue: VecDeque::new(),
            }),
            queue_tx,
            queue_rx: tokio::sync::Mutex::new(queue_rx),
            runner,
            simulated,
            cpu,
            retain,
        })
    }

    /// Whether results are produced by the placeholder tool.
    pub fn simulated(&self) -> bool {
        self.simulated
    }

    /// Starts `parallel` worker tasks and the retention sweeper.
    pub fn spawn_workers(self: &Arc<JobStore>, parallel: usize, sweep_interval: Duration) {
        for _ in 0..parallel.max(1) {
            let store = Arc::clone(self);
            tokio::spawn(async move { store.worker().await });
        }
        let store = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(sweep_interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                store.sweep().await;
            }
        });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Queues a validated job whose inputs are already in `dir/in`. Returns
    /// the queue position.
    pub fn submit(
        &self,
        id: String,
        tool: Arc<dyn Tool>,
        validated: ValidatedJob,
        dir: PathBuf,
    ) -> usize {
        let (events, _) = broadcast::channel(4096);
        let job = Job {
            id: id.clone(),
            tool,
            validated,
            dir,
            status: Status::Queued,
            progress: None,
            stage: None,
            message: None,
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
            error: None,
            outputs: Vec::new(),
            log: Vec::new(),
            events,
            cancel: CancellationToken::new(),
        };
        let mut inner = self.lock();
        let position = inner.queue.len() + inner.running_count();
        inner.queue.push_back(id.clone());
        inner.jobs.insert(id.clone(), job);
        let _ = self.queue_tx.send(id);
        position
    }

    /// The job object, or `None` for unknown ids.
    pub fn view(&self, id: &str) -> Option<JobView> {
        let inner = self.lock();
        let job = inner.jobs.get(id)?;
        Some(job.view(inner.position(id), self.simulated))
    }

    /// Subscribes to a job's events. Returns the replay of the current state
    /// (status, progress, log lines, and `done` when finished) and the live
    /// receiver.
    pub fn subscribe(&self, id: &str) -> Option<(Vec<Event>, broadcast::Receiver<Event>)> {
        let inner = self.lock();
        let job = inner.jobs.get(id)?;
        let receiver = job.events.subscribe();
        let position = inner.position(id);
        let mut replay = vec![Event::Status {
            status: job.status,
            position,
        }];
        if let (Some(fraction), Some(stage)) = (job.progress, &job.stage) {
            replay.push(Event::Progress {
                fraction,
                stage: stage.clone(),
            });
        }
        for (line, level) in &job.log {
            replay.push(Event::Log {
                line: line.clone(),
                level: *level,
            });
        }
        if job.status.is_finished() {
            replay.push(Event::Done(Box::new(job.view(position, self.simulated))));
        }
        Some((replay, receiver))
    }

    /// Path and MIME type of a succeeded job's output.
    pub fn output(&self, id: &str, name: &str) -> Option<(PathBuf, String, u64)> {
        let inner = self.lock();
        let job = inner.jobs.get(id)?;
        if job.status != Status::Succeeded {
            return None;
        }
        let output = job.outputs.iter().find(|output| output.name == name)?;
        Some((
            job.dir.join("out").join(&output.name),
            output.content_type.clone(),
            output.bytes,
        ))
    }

    /// Cancels and removes a job. Returns `false` for unknown ids.
    pub async fn delete(&self, id: &str) -> bool {
        let dir_to_remove = {
            let mut inner = self.lock();
            let Some(mut job) = inner.jobs.remove(id) else {
                return false;
            };
            inner.queue.retain(|queued| queued != id);
            match job.status {
                Status::Queued => {
                    self.mark_cancelled(&mut job);
                    Some(job.dir.clone())
                }
                Status::Running => {
                    // The worker removes the directory once the runner returned.
                    self.mark_cancelled(&mut job);
                    job.cancel.cancel();
                    None
                }
                Status::Succeeded | Status::Failed | Status::Cancelled => Some(job.dir.clone()),
            }
        };
        if let Some(dir) = dir_to_remove {
            remove_dir(&dir).await;
        }
        true
    }

    fn mark_cancelled(&self, job: &mut Job) {
        job.status = Status::Cancelled;
        job.finished_at = Some(Utc::now());
        job.emit(Event::Status {
            status: Status::Cancelled,
            position: 0,
        });
        job.emit(Event::Done(Box::new(job.view(0, self.simulated))));
    }

    /// Cancels every job and removes all job directories (server shutdown).
    pub async fn shutdown(&self) {
        let ids: Vec<String> = {
            let inner = self.lock();
            inner.jobs.keys().cloned().collect()
        };
        for id in ids {
            self.delete(&id).await;
        }
    }

    /// Removes finished jobs older than the retention period.
    pub async fn sweep(&self) {
        let cutoff = Utc::now()
            - chrono::Duration::from_std(self.retain).unwrap_or(chrono::Duration::hours(1));
        let expired: Vec<String> = {
            let inner = self.lock();
            inner
                .jobs
                .values()
                .filter(|job| job.status.is_finished())
                .filter(|job| job.finished_at.is_some_and(|finished| finished < cutoff))
                .map(|job| job.id.clone())
                .collect()
        };
        for id in expired {
            tracing::info!(job = %id, "retention expired");
            self.delete(&id).await;
        }
    }

    async fn worker(self: Arc<JobStore>) {
        loop {
            let next = {
                let mut receiver = self.queue_rx.lock().await;
                receiver.recv().await
            };
            let Some(id) = next else {
                return;
            };
            let Some(started) = self.begin(&id) else {
                continue;
            };
            self.execute(&id, started).await;
        }
    }

    fn begin(&self, id: &str) -> Option<Started> {
        let mut inner = self.lock();
        inner.queue.retain(|queued| queued != id);
        let job = inner.jobs.get_mut(id)?;
        if job.status != Status::Queued {
            return None;
        }
        job.status = Status::Running;
        job.started_at = Some(Utc::now());
        job.emit(Event::Status {
            status: Status::Running,
            position: 0,
        });
        let paths = self.runner.paths(&job.dir);
        let argv = job.tool.argv(&job.validated, &paths);
        let started = Started {
            request: RunRequest {
                job_id: job.id.clone(),
                job_dir: job.dir.clone(),
                argv,
                job: job.validated.clone(),
                cpu: self.cpu,
            },
            cancel: job.cancel.clone(),
        };
        // Queue positions of the remaining jobs changed.
        let queued: Vec<(usize, String)> = inner
            .queue
            .iter()
            .map(|queued| (inner.position(queued), queued.clone()))
            .collect();
        for (position, queued) in queued {
            if let Some(job) = inner.jobs.get(&queued) {
                job.emit(Event::Status {
                    status: Status::Queued,
                    position,
                });
            }
        }
        Some(started)
    }

    async fn execute(self: &Arc<JobStore>, id: &str, started: Started) {
        let Started { request, cancel } = started;
        let job_dir = request.job_dir.clone();
        let out_dir = job_dir.join("out");
        let log_path = out_dir.join("log.txt");
        let (line_tx, line_rx) = mpsc::unbounded_channel::<String>();

        let mut preamble = vec![crate::runner::simulate::log_line(
            "INFO",
            &format!("argv: {}", shell_join(&request.argv)),
        )];
        for warning in &request.job.warnings {
            preamble.push(crate::runner::simulate::log_line("WARNING", warning));
        }
        for line in preamble {
            let _ = line_tx.send(line);
        }

        let consumer = {
            let id = id.to_string();
            let store = Arc::clone(self);
            tokio::spawn(async move {
                consume_lines(store, id, log_path, line_rx).await;
            })
        };

        let outcome = self.runner.run(request, line_tx, cancel).await;
        let _ = consumer.await;

        let remove = {
            let mut inner = self.lock();
            match inner.jobs.get_mut(id) {
                None => true,
                Some(job) => {
                    self.finish(job, outcome, &out_dir);
                    false
                }
            }
        };
        if remove {
            remove_dir(&job_dir).await;
        }
    }

    fn finish(&self, job: &mut Job, outcome: std::io::Result<RunOutcome>, out_dir: &Path) {
        let tool_name = job.tool.id();
        match outcome {
            Ok(RunOutcome::Cancelled) => {
                self.mark_cancelled(job);
                return;
            }
            Ok(RunOutcome::Exited(0)) => {
                let mut outputs = Vec::new();
                let mut missing = None;
                for spec in job.tool.outputs() {
                    let path = out_dir.join(spec.name);
                    match std::fs::metadata(&path) {
                        Ok(metadata) if metadata.is_file() => outputs.push(OutputInfo {
                            name: spec.name.to_string(),
                            bytes: metadata.len(),
                            content_type: spec.content_type.to_string(),
                        }),
                        _ if spec.required => {
                            missing = Some(spec.name);
                            break;
                        }
                        _ => {}
                    }
                }
                if let Some(name) = missing {
                    job.status = Status::Failed;
                    job.error = Some(JobError {
                        code: "tool-failed".to_string(),
                        message: format!("{tool_name} did not write {name}"),
                    });
                } else {
                    job.status = Status::Succeeded;
                    job.outputs = outputs;
                    job.progress = Some(1.0);
                }
            }
            Ok(RunOutcome::Exited(code)) => {
                job.status = Status::Failed;
                job.error = Some(JobError {
                    code: "tool-failed".to_string(),
                    message: format!("{tool_name} exited with status {code}"),
                });
            }
            Err(error) => {
                job.status = Status::Failed;
                job.error = Some(JobError {
                    code: "tool-failed".to_string(),
                    message: format!("{tool_name} could not run: {error}"),
                });
            }
        }
        job.finished_at = Some(Utc::now());
        job.emit(Event::Status {
            status: job.status,
            position: 0,
        });
        job.emit(Event::Done(Box::new(job.view(0, self.simulated))));
    }

    /// Records a log line: keeps it in memory, parses progress, emits events.
    fn record_line(&self, id: &str, line: &str) {
        let mut inner = self.lock();
        let Some(job) = inner.jobs.get_mut(id) else {
            return;
        };
        let update = job.tool.parse_log_line(&job.validated, line);
        if job.log.len() < MAX_LOG_LINES {
            job.log.push((line.to_string(), update.level));
        }
        job.message = Some(line.to_string());
        job.emit(Event::Log {
            line: line.to_string(),
            level: update.level,
        });
        if let Some((fraction, stage)) = update.progress {
            job.progress = Some(fraction);
            job.stage = Some(stage.clone());
            job.emit(Event::Progress { fraction, stage });
        }
    }
}

async fn consume_lines(
    store: Arc<JobStore>,
    id: String,
    log_path: PathBuf,
    mut lines: mpsc::UnboundedReceiver<String>,
) {
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await
        .ok();
    while let Some(line) = lines.recv().await {
        if let Some(file) = file.as_mut() {
            let _ = file.write_all(line.as_bytes()).await;
            let _ = file.write_all(b"\n").await;
        }
        store.record_line(&id, &line);
    }
    if let Some(mut file) = file {
        let _ = file.flush().await;
    }
}

async fn remove_dir(dir: &Path) {
    if let Err(error) = tokio::fs::remove_dir_all(dir).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(dir = %dir.display(), %error, "could not remove job directory");
        }
    }
}
