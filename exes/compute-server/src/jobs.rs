//! The job store: queue, worker tasks, per-job event broadcast, retention.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use crate::runner::{shell_join, RunOutcome, RunRequest, Runner};
use crate::tools::{LogLevel, Tool, ValidatedJob};

/// Maximum number of log lines kept in memory per job (the file gets all).
pub const MAX_LOG_LINES: usize = 20_000;

/// Lifecycle state of a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    /// The queued job was cancelled or its runner has stopped.
    Cancelled,
    /// Waiting for runner termination.
    Cancelling,
}

impl Status {
    /// Whether the job reached a final state.
    pub fn is_finished(self) -> bool {
        matches!(self, Status::Succeeded | Status::Failed | Status::Cancelled)
    }
}

/// Error record of a failed job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobError {
    /// Error code (`tool-failed`).
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

/// A produced output file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    runner: crate::config::RunnerKind,
    owner: String,
    key: String,
    fingerprint: String,
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
    fn view(&self, position: usize, _simulated: bool) -> JobView {
        JobView {
            id: self.id.clone(),
            tool: self.tool.id().to_string(),
            command: self.validated.command.clone(),
            status: self.status,
            position,
            progress: self.progress,
            stage: self.stage.clone(),
            message: self.message.clone(),
            simulated: self.runner == crate::config::RunnerKind::Simulate,
            created_at: rfc3339(self.created_at),
            started_at: self.started_at.map(rfc3339),
            finished_at: self.finished_at.map(rfc3339),
            error: self.error.clone(),
            outputs: self.outputs.clone(),
        }
    }

    fn persist(&self, simulated: bool) -> std::io::Result<()> {
        crate::durable::write(
            &self.dir.join("job.json"),
            &Record {
                runner: self.runner.id().to_owned(),
                owner: self.owner.clone(),
                key: self.key.clone(),
                fingerprint: self.fingerprint.clone(),
                validated: self.validated.clone(),
                view: self.view(0, simulated),
            },
        )
    }

    fn persist_or_fail(&mut self, simulated: bool) {
        if let Err(error) = self.persist(simulated) {
            self.status = Status::Failed;
            self.error = Some(JobError {
                code: "storage-failed".into(),
                message: error.to_string(),
            });
        }
    }

    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }
}

#[derive(Serialize, Deserialize)]
struct Record {
    runner: String,
    owner: String,
    key: String,
    fingerprint: String,
    validated: ValidatedJob,
    view: JobView,
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

pub struct SubmissionIdentity {
    pub owner: String,
    pub key: String,
    pub fingerprint: String,
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
    stopping: CancellationToken,
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
            stopping: CancellationToken::new(),
        })
    }

    /// Recover completed records; interrupted jobs require an explicit new submission.
    /// Unacknowledged upload directories and deletion tombstones are removed at startup.
    pub fn recover(&self, root: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(root)?;
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let dir = entry.path();
            if dir.join("deleted.json").exists() || !dir.join("job.json").exists() {
                std::fs::remove_dir_all(&dir)?;
                continue;
            }
            let record: Record = serde_json::from_slice(&std::fs::read(dir.join("job.json"))?)?;
            let view = record.view;
            if dir.file_name().and_then(|name| name.to_str()) != Some(&view.id) {
                return Err(std::io::Error::other("job record directory mismatch"));
            }
            let tool = crate::tools::find(&crate::tools::registry(), &view.tool)
                .ok_or_else(|| std::io::Error::other("unknown persisted tool"))?;
            let (events, _) = broadcast::channel(4096);
            let time = |value: &str| {
                DateTime::parse_from_rfc3339(value)
                    .map(|time| time.with_timezone(&Utc))
                    .map_err(std::io::Error::other)
            };
            let mut job = Job {
                runner: crate::config::RunnerKind::parse(&record.runner)
                    .ok_or_else(|| std::io::Error::other("unknown persisted runner"))?,
                owner: record.owner,
                key: record.key,
                fingerprint: record.fingerprint,
                id: view.id,
                tool,
                validated: record.validated,
                dir,
                status: view.status,
                progress: view.progress,
                stage: view.stage,
                message: view.message,
                created_at: time(&view.created_at)?,
                started_at: view.started_at.as_deref().map(time).transpose()?,
                finished_at: view.finished_at.as_deref().map(time).transpose()?,
                error: view.error,
                outputs: view.outputs,
                log: Vec::new(),
                events,
                cancel: CancellationToken::new(),
            };
            if !job.status.is_finished() {
                crate::runner::process::reconcile(job.runner, &job.id)?;
                job.status = Status::Failed;
                job.finished_at = Some(Utc::now());
                job.error = Some(JobError {
                    code: "interrupted".into(),
                    message:
                        "Server stopped before execution completed; submit a new job to retry."
                            .into(),
                });
                job.persist(self.simulated)?;
            }
            self.lock().jobs.insert(job.id.clone(), job);
        }
        Ok(())
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
                tokio::select! {
                    _ = ticker.tick() => {},
                    _ = store.stopping.cancelled() => return,
                }
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
        identity: SubmissionIdentity,
        id: String,
        tool: Arc<dyn Tool>,
        validated: ValidatedJob,
        dir: PathBuf,
    ) -> std::io::Result<usize> {
        if self.stopping.is_cancelled() {
            return Err(std::io::Error::other("server is stopping"));
        }
        let (events, _) = broadcast::channel(4096);
        let job = Job {
            runner: self.runner.kind(),
            owner: identity.owner,
            key: identity.key,
            fingerprint: identity.fingerprint,
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
        job.persist(self.simulated)?;
        let mut inner = self.lock();
        if self.stopping.is_cancelled() {
            return Err(std::io::Error::other("server is stopping"));
        }
        let position = inner.queue.len() + inner.running_count();
        inner.queue.push_back(id.clone());
        inner.jobs.insert(id.clone(), job);
        let _ = self.queue_tx.send(id);
        Ok(position)
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

    pub fn owned(&self, id: &str, owner: &str) -> bool {
        self.lock()
            .jobs
            .get(id)
            .is_some_and(|job| job.owner == owner)
    }

    pub fn list(&self, owner: &str) -> Vec<JobView> {
        let inner = self.lock();
        inner
            .jobs
            .values()
            .filter(|job| job.owner == owner)
            .map(|job| job.view(inner.position(&job.id), self.simulated))
            .collect()
    }

    pub fn fingerprint(&self, id: &str) -> Option<String> {
        self.lock().jobs.get(id).map(|job| job.fingerprint.clone())
    }

    pub fn receipt(&self, owner: &str, key: &str) -> Option<JobView> {
        let inner = self.lock();
        inner
            .jobs
            .values()
            .find(|job| job.owner == owner && job.key == key)
            .map(|job| job.view(inner.position(&job.id), self.simulated))
    }

    pub fn cancel(&self, id: &str) -> std::io::Result<()> {
        let mut inner = self.lock();
        inner.queue.retain(|queued| queued != id);
        if let Some(job) = inner.jobs.get_mut(id) {
            match job.status {
                Status::Queued => self.mark_cancelled(job),
                Status::Running => {
                    job.status = Status::Cancelling;
                    job.persist(self.simulated)?;
                    job.cancel.cancel();
                    job.emit(Event::Status {
                        status: Status::Cancelling,
                        position: 0,
                    });
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Deletes terminal jobs only. The tombstone makes interrupted deletion recoverable.
    pub async fn delete(&self, id: &str) -> bool {
        let dir = {
            let mut inner = self.lock();
            let Some(job) = inner.jobs.get(id) else {
                return false;
            };
            if !job.status.is_finished() {
                return false;
            }
            if crate::durable::write(&job.dir.join("deleted.json"), &true).is_err() {
                return false;
            }
            let dir = job.dir.clone();
            inner.jobs.remove(id);
            dir
        };
        remove_dir(&dir).await;
        true
    }

    fn mark_cancelled(&self, job: &mut Job) {
        job.status = Status::Cancelled;
        job.finished_at = Some(Utc::now());
        job.persist_or_fail(self.simulated);
        job.emit(Event::Status {
            status: job.status,
            position: 0,
        });
        job.emit(Event::Done(Box::new(job.view(0, self.simulated))));
    }

    /// Stops active jobs while retaining durable records and results.
    pub async fn shutdown(&self) {
        self.stopping.cancel();
        let ids: Vec<String> = {
            let inner = self.lock();
            inner.jobs.keys().cloned().collect()
        };
        for id in ids {
            let _ = self.cancel(&id);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if tokio::time::Instant::now() >= deadline {
                tracing::error!("shutdown cleanup unconfirmed; recovery required before new jobs");
                break;
            }
            if self
                .lock()
                .jobs
                .values()
                .all(|job| job.status.is_finished())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
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
                tokio::select! {
                    value = receiver.recv() => value,
                    _ = self.stopping.cancelled() => return,
                }
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
        if job.persist(self.simulated).is_err() {
            job.status = Status::Failed;
            job.finished_at = Some(Utc::now());
            return None;
        }
        job.emit(Event::Status {
            status: Status::Running,
            position: 0,
        });
        let paths = self.runner.paths(&job.dir);
        let started = Started {
            request: RunRequest::new(
                job.tool.as_ref(),
                job.id.clone(),
                job.dir.clone(),
                job.validated.clone(),
                &paths,
                self.cpu,
            ),
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
        if job.status == Status::Cancelling && outcome.is_err() {
            job.error = Some(JobError { code: "termination-unconfirmed".into(), message: "Could not confirm process termination; server rejects new work until restart and recovery.".into() });
            if let Err(error) = job.persist(self.simulated) {
                tracing::error!(%error, "could not persist unconfirmed termination");
            }
            job.emit(Event::Status {
                status: job.status,
                position: 0,
            });
            self.stopping.cancel();
            return;
        }
        let outcome = if job.status == Status::Cancelling && outcome.is_ok() {
            Ok(RunOutcome::Cancelled)
        } else {
            outcome
        };
        match outcome {
            Ok(RunOutcome::Cancelled) => {
                self.mark_cancelled(job);
                return;
            }
            Ok(RunOutcome::Exited(0)) => {
                let mut outputs = Vec::new();
                let mut missing = None;
                for spec in job.tool.outputs(&job.validated) {
                    let path = out_dir.join(spec.name);
                    match std::fs::metadata(&path) {
                        Ok(metadata) if metadata.is_file() => {
                            if let Err(error) =
                                std::fs::File::open(&path).and_then(|file| file.sync_all())
                            {
                                job.status = Status::Failed;
                                job.error = Some(JobError {
                                    code: "storage-failed".into(),
                                    message: error.to_string(),
                                });
                                job.finished_at = Some(Utc::now());
                                job.persist_or_fail(self.simulated);
                                job.emit(Event::Done(Box::new(job.view(0, self.simulated))));
                                return;
                            }
                            outputs.push(OutputInfo {
                                name: spec.name.to_string(),
                                bytes: metadata.len(),
                                content_type: spec.content_type.to_string(),
                            });
                        }
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
        job.persist_or_fail(self.simulated);
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

#[cfg(test)]
mod tests {
    use super::*;

    struct SlowStop(Arc<tokio::sync::Notify>);

    impl Runner for SlowStop {
        fn kind(&self) -> crate::config::RunnerKind {
            crate::config::RunnerKind::Simulate
        }
        fn paths(&self, _dir: &Path) -> crate::tools::ToolPaths {
            crate::tools::ToolPaths::container()
        }
        fn run(
            &self,
            _request: RunRequest,
            _sink: crate::runner::LineSink,
            cancel: CancellationToken,
        ) -> crate::runner::RunFuture {
            let stopped = self.0.clone();
            Box::pin(async move {
                cancel.cancelled().await;
                stopped.notified().await;
                Ok(RunOutcome::Cancelled)
            })
        }
    }

    #[tokio::test]
    async fn cancellation_does_not_finish_or_delete_before_runner_exit() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("out")).unwrap();
        let stopped = Arc::new(tokio::sync::Notify::new());
        let store = JobStore::new(
            Arc::new(SlowStop(stopped.clone())),
            true,
            false,
            Duration::from_secs(3600),
        );
        store.spawn_workers(1, Duration::from_secs(60));
        store
            .submit(
                SubmissionIdentity {
                    owner: "owner".into(),
                    key: "key".into(),
                    fingerprint: "test".into(),
                },
                "id".into(),
                crate::tools::registry()[0].clone(),
                ValidatedJob {
                    tool: "nesvor".into(),
                    command: "reconstruct".into(),
                    inputs: crate::tools::JobInputs::Nesvor { stacks: vec![] },
                    options: serde_json::Map::new(),
                    warnings: vec![],
                },
                dir.path().to_owned(),
            )
            .unwrap();
        while store.view("id").unwrap().status != Status::Running {
            tokio::task::yield_now().await;
        }
        store.cancel("id").unwrap();
        assert_eq!(store.view("id").unwrap().status, Status::Cancelling);
        assert!(store.view("id").unwrap().finished_at.is_none());
        assert!(!store.delete("id").await);
        let (events, _) = store.subscribe("id").unwrap();
        assert!(!events.iter().any(|event| matches!(event, Event::Done(_))));
        stopped.notify_one();
        while store.view("id").unwrap().status != Status::Cancelled {
            tokio::task::yield_now().await;
        }
        store.shutdown().await;
        assert!(dir.path().join("job.json").exists());
    }
}
