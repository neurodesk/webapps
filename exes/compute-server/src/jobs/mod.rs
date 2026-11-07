//! The job store: queue, dispatch, per-job event broadcast, projects, retention.

pub mod model;
mod projects;
mod recover;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc, Notify};
use tokio_util::sync::CancellationToken;

use crate::config::RunnerKind;
use crate::profiles::Profiles;
use crate::projects::{Project, ProjectDirs};
use crate::roots::RelativePath;
use crate::runner::{
    shell_join, ProjectRun, Resume, RunContext, RunOutcome, RunRequest, Runner, RunnerEvent,
    StatusReporter,
};
use crate::tools::project::{job_directory, part_file_name, valid_job_type, ProjectArgs};
use crate::tools::{Layout, LogLevel, Tool, ValidatedJob};

pub use model::{Event, JobError, JobView, OutputInfo, SchedulerView, State, Status};
pub use projects::{ProjectDetail, ProjectJobView, ProjectSummary};

/// Maximum number of log lines kept in memory per job (the file gets all).
pub const MAX_LOG_LINES: usize = 20_000;

/// Settings of a store.
#[derive(Debug, Clone)]
pub struct StoreOptions {
    /// Results come from placeholder tools.
    pub simulated: bool,
    /// GPU tools run on the CPU.
    pub cpu: bool,
    /// How long finished jobs outside projects are kept.
    pub retain: Duration,
    /// Jobs handed to the runner at once.
    pub parallel: usize,
    /// `<data-dir>`: job records in `jobs/`, projects in `projects/`.
    pub data_dir: PathBuf,
    /// Project outputs above this size are not downloadable.
    pub max_download_bytes: u64,
    /// Resource profiles of project jobs.
    pub profiles: Profiles,
}

/// Where a project job lives and what it reads.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Placement {
    project: String,
    directory: String,
    depends_on: Vec<String>,
}

struct Job {
    runner: RunnerKind,
    owner: String,
    key: String,
    fingerprint: String,
    id: String,
    tool: Arc<dyn Tool>,
    validated: ValidatedJob,
    /// `<data-dir>/jobs/<id>`: the record, and `in/` and `out/` of file tools.
    dir: PathBuf,
    state: State,
    placement: Option<Placement>,
    scheduler: Option<SchedulerView>,
    submitted_at: Option<DateTime<Utc>>,
    cancel_requested: bool,
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
    fn view(&self, position: usize) -> JobView {
        JobView {
            id: self.id.clone(),
            tool: self.tool.id().to_string(),
            command: self.validated.command.clone(),
            status: self.state.status(),
            position,
            progress: self.progress,
            stage: self.stage.clone(),
            message: self.message.clone(),
            simulated: self.runner == RunnerKind::Simulate,
            created_at: rfc3339(self.created_at),
            started_at: self.started_at.map(rfc3339),
            finished_at: self.finished_at.map(rfc3339),
            error: self.error.clone(),
            outputs: self.outputs.clone(),
            project: self.placement.as_ref().map(|place| place.project.clone()),
            directory: self.placement.as_ref().map(|place| place.directory.clone()),
            depends_on: self
                .placement
                .as_ref()
                .map(|place| place.depends_on.clone())
                .unwrap_or_default(),
            scheduler: self.scheduler.clone(),
        }
    }

    fn persist(&self) -> std::io::Result<()> {
        crate::durable::write(
            &self.dir.join("job.json"),
            &model::Record {
                runner: self.runner.id().to_owned(),
                owner: self.owner.clone(),
                key: self.key.clone(),
                fingerprint: self.fingerprint.clone(),
                validated: self.validated.clone(),
                view: self.view(0),
                state: Some(self.state),
                submitted_at: self.submitted_at.map(rfc3339),
                cancel_requested: self.cancel_requested,
            },
        )
    }

    fn persist_or_fail(&mut self) {
        if let Err(error) = self.persist() {
            self.state = State::Failed;
            self.error = Some(JobError::new("storage-failed", error.to_string()));
        }
    }

    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }

    fn emit_status(&self) {
        self.emit(Event::Status {
            status: self.state.status(),
            position: 0,
        });
    }

    fn fail(&mut self, error: JobError) {
        self.state = State::Failed;
        self.error = Some(error);
        self.finished_at = Some(Utc::now());
        self.persist_or_fail();
        self.emit_status();
        self.emit(Event::Done(Box::new(self.view(0))));
    }

    fn mark_cancelled(&mut self) {
        self.state = State::Cancelled;
        self.finished_at = Some(Utc::now());
        self.persist_or_fail();
        self.emit_status();
        self.emit(Event::Done(Box::new(self.view(0))));
    }
}

struct Inner {
    jobs: HashMap<String, Job>,
    queue: VecDeque<String>,
    projects: HashMap<String, Project>,
    /// Jobs handed to the runner whose run has not returned.
    executing: usize,
    /// Jobs recovered for re-attachment, started by [`JobStore::start`].
    reattach: Vec<String>,
}

impl Inner {
    /// Number of jobs ahead of a waiting job: executing jobs plus earlier waiting jobs.
    fn position(&self, id: &str) -> usize {
        match self.queue.iter().position(|queued| queued == id) {
            Some(index) => index + self.executing,
            None => 0,
        }
    }

    fn emit_positions(&self) {
        for queued in &self.queue {
            if let Some(job) = self.jobs.get(queued) {
                job.emit(Event::Status {
                    status: Status::Queued,
                    position: self.position(queued),
                });
            }
        }
    }
}

/// A project job's files to collect after its run.
#[derive(Clone)]
struct ProjectFiles {
    project_dir: PathBuf,
    directory: String,
    required: Vec<String>,
}

/// What an execution needs.
struct Started {
    request: RunRequest,
    cancel: CancellationToken,
    log_path: Option<PathBuf>,
    project: Option<ProjectFiles>,
}

/// The owner, idempotency key and fingerprint of a submission.
pub struct SubmissionIdentity {
    pub owner: String,
    pub key: String,
    pub fingerprint: String,
}

/// Why a submission was refused.
#[derive(Debug)]
pub enum SubmitError {
    /// The spec names an unknown project, profile or dependency.
    Invalid(String),
    /// Storage failed or the server is stopping.
    Unavailable(std::io::Error),
}

/// Why a deletion was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum DeleteError {
    /// Unknown id.
    NotFound,
    /// The job or project is active, or another job depends on it.
    Conflict(&'static str),
    /// The tombstone could not be written.
    Storage,
}

/// Why an output is not served.
#[derive(Debug, PartialEq, Eq)]
pub enum OutputError {
    /// Unknown job or name, or a job without outputs yet.
    NotFound,
    /// A project output above the download limit.
    TooLarge,
}

/// A servable output file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputFile {
    /// Host path.
    pub path: PathBuf,
    /// MIME type.
    pub content_type: String,
    /// Name for `Content-Disposition`: the last path component.
    pub file_name: String,
}

/// Shared store of all jobs.
pub struct JobStore {
    inner: Mutex<Inner>,
    wake: Notify,
    runner: Arc<dyn Runner>,
    tools: Vec<Arc<dyn Tool>>,
    options: StoreOptions,
    dirs: ProjectDirs,
    stopping: CancellationToken,
}

impl JobStore {
    /// Creates a store that executes jobs of `tools` with `runner`.
    pub fn new(
        runner: Arc<dyn Runner>,
        tools: Vec<Arc<dyn Tool>>,
        options: StoreOptions,
    ) -> Arc<JobStore> {
        Arc::new(JobStore {
            inner: Mutex::new(Inner {
                jobs: HashMap::new(),
                queue: VecDeque::new(),
                projects: HashMap::new(),
                executing: 0,
                reattach: Vec::new(),
            }),
            wake: Notify::new(),
            runner,
            tools,
            dirs: ProjectDirs::new(&options.data_dir),
            options,
            stopping: CancellationToken::new(),
        })
    }

    /// Whether results are produced by placeholder tools.
    pub fn simulated(&self) -> bool {
        self.options.simulated
    }

    /// An error while the runner cannot accept new work.
    pub fn runner_health(&self) -> Result<(), String> {
        if self.stopping.is_cancelled() {
            return Err("server is stopping".into());
        }
        self.runner.health()
    }

    /// Starts the dispatcher, the retention sweeper and re-attached jobs.
    pub fn start(self: &Arc<JobStore>, sweep_interval: Duration) {
        let store = Arc::clone(self);
        tokio::spawn(async move { store.dispatch().await });
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
        let resumed: Vec<Started> = {
            let mut inner = self.lock();
            let ids = std::mem::take(&mut inner.reattach);
            let mut resumed = Vec::new();
            for id in ids {
                if let Some(started) = self.resume(&mut inner, &id) {
                    inner.executing += 1;
                    resumed.push(started);
                }
            }
            resumed
        };
        for started in resumed {
            let store = Arc::clone(self);
            tokio::spawn(async move { store.execute(started).await });
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Queues a validated job whose uploads are in `dir/in`. A project job's
    /// dependencies are resolved, its directory allocated and its uploads
    /// moved into it under the store's lock. Returns the queue position.
    pub fn submit(
        &self,
        identity: SubmissionIdentity,
        id: String,
        tool: Arc<dyn Tool>,
        validated: ValidatedJob,
        dir: PathBuf,
    ) -> Result<usize, SubmitError> {
        let stopping = || SubmitError::Unavailable(std::io::Error::other("server is stopping"));
        if self.stopping.is_cancelled() {
            return Err(stopping());
        }
        let mut inner = self.lock();
        if self.stopping.is_cancelled() {
            return Err(stopping());
        }
        let placement = match validated.project() {
            Some(inputs) => Some(self.place(&mut inner, inputs, &dir)?),
            None => None,
        };
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
            state: State::Waiting,
            placement,
            scheduler: None,
            submitted_at: None,
            cancel_requested: false,
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
        if let Err(error) = job.persist() {
            if let Some(place) = &job.placement {
                let work = self.dirs.project(&place.project).join(&place.directory);
                let _ = std::fs::remove_dir_all(work);
            }
            return Err(SubmitError::Unavailable(error));
        }
        let position = inner.queue.len() + inner.executing;
        inner.queue.push_back(id.clone());
        inner.jobs.insert(id, job);
        drop(inner);
        self.wake.notify_one();
        Ok(position)
    }

    /// Resolves a project job's dependencies, allocates `<Type>/jobNNN` and
    /// stores its uploads there.
    fn place(
        &self,
        inner: &mut Inner,
        inputs: &crate::tools::project::ProjectInputs,
        dir: &Path,
    ) -> Result<Placement, SubmitError> {
        let invalid = |message: String| SubmitError::Invalid(message);
        let storage = SubmitError::Unavailable;
        if !valid_job_type(&inputs.job_type) {
            return Err(invalid(format!("invalid job type '{}'", inputs.job_type)));
        }
        if !inner
            .projects
            .get(&inputs.project)
            .is_some_and(|project| !project.deleted)
        {
            return Err(invalid(format!("unknown project '{}'", inputs.project)));
        }
        let mut depends_on: Vec<String> = Vec::new();
        for path in &inputs.inputs {
            let path = RelativePath::parse(path).map_err(|error| invalid(error.to_string()))?;
            let producer = inner
                .jobs
                .values()
                .find(|job| {
                    job.state == State::Succeeded
                        && job
                            .placement
                            .as_ref()
                            .is_some_and(|place| place.project == inputs.project)
                        && job
                            .outputs
                            .iter()
                            .any(|output| output.name == path.as_str())
                })
                .ok_or_else(|| {
                    invalid(format!(
                        "'{}' is not an output of a succeeded job in this project",
                        path.as_str()
                    ))
                })?;
            if !depends_on.contains(&producer.id) {
                depends_on.push(producer.id.clone());
            }
        }
        let project = inner
            .projects
            .get_mut(&inputs.project)
            .ok_or_else(|| invalid("unknown project".into()))?;
        let mut updated = project.clone();
        updated.allocated += 1;
        self.dirs.persist(&updated).map_err(storage)?;
        *project = updated;
        let directory = job_directory(&inputs.job_type, project.allocated);
        let work = self.dirs.project(&inputs.project).join(&directory);
        let created = std::fs::create_dir_all(work.parent().unwrap_or(&work))
            .and_then(|()| std::fs::create_dir(&work));
        created.map_err(storage)?;
        let moved = inputs.parts.iter().try_for_each(|part| {
            let name = part_file_name(part);
            std::fs::rename(dir.join("in").join(&name), work.join(&name))
        });
        let synced = moved.and_then(|()| std::fs::File::open(&work)?.sync_all());
        if let Err(error) = synced {
            let _ = std::fs::remove_dir_all(&work);
            return Err(storage(error));
        }
        Ok(Placement {
            project: inputs.project.clone(),
            directory,
            depends_on,
        })
    }

    /// The job object, or `None` for unknown ids.
    pub fn view(&self, id: &str) -> Option<JobView> {
        let inner = self.lock();
        let job = inner.jobs.get(id)?;
        Some(job.view(inner.position(id)))
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
            status: job.state.status(),
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
        if job.state.is_finished() {
            replay.push(Event::Done(Box::new(job.view(position))));
        }
        Some((replay, receiver))
    }

    /// A job's output: after success for file tools; after any ending for
    /// project jobs, whose path must canonicalise into the job's directory.
    pub fn output(&self, id: &str, name: &str) -> Result<OutputFile, OutputError> {
        let inner = self.lock();
        let job = inner.jobs.get(id).ok_or(OutputError::NotFound)?;
        let output = job
            .outputs
            .iter()
            .find(|output| output.name == name)
            .ok_or(OutputError::NotFound)?;
        let Some(place) = &job.placement else {
            if job.state != State::Succeeded {
                return Err(OutputError::NotFound);
            }
            return Ok(OutputFile {
                path: job.dir.join("out").join(&output.name),
                content_type: output.content_type.clone(),
                file_name: output.name.clone(),
            });
        };
        if !job.state.is_finished() {
            return Err(OutputError::NotFound);
        }
        if output.download == Some(false) {
            return Err(OutputError::TooLarge);
        }
        let relative = RelativePath::parse(name).map_err(|_| OutputError::NotFound)?;
        let project_dir = self.dirs.project(&place.project);
        let work = project_dir
            .join(&place.directory)
            .canonicalize()
            .map_err(|_| OutputError::NotFound)?;
        let path = project_dir
            .join(relative.as_str())
            .canonicalize()
            .map_err(|_| OutputError::NotFound)?;
        if !path.starts_with(&work) || !path.is_file() {
            return Err(OutputError::NotFound);
        }
        Ok(OutputFile {
            path,
            content_type: output.content_type.clone(),
            file_name: relative.file_name().to_string(),
        })
    }

    /// Whether `owner` owns job `id`.
    pub fn owned(&self, id: &str, owner: &str) -> bool {
        self.lock()
            .jobs
            .get(id)
            .is_some_and(|job| job.owner == owner)
    }

    /// The jobs of an owner.
    pub fn list(&self, owner: &str) -> Vec<JobView> {
        let inner = self.lock();
        inner
            .jobs
            .values()
            .filter(|job| job.owner == owner)
            .map(|job| job.view(inner.position(&job.id)))
            .collect()
    }

    /// The fingerprint of a job's submission.
    pub fn fingerprint(&self, id: &str) -> Option<String> {
        self.lock().jobs.get(id).map(|job| job.fingerprint.clone())
    }

    /// The job an owner submitted under an idempotency key.
    pub fn receipt(&self, owner: &str, key: &str) -> Option<JobView> {
        let inner = self.lock();
        inner
            .jobs
            .values()
            .find(|job| job.owner == owner && job.key == key)
            .map(|job| job.view(inner.position(&job.id)))
    }

    /// Cancels a waiting job at once; a job handed to the runner persists the
    /// request and stays `cancelling` until the runner confirms termination.
    pub fn cancel(&self, id: &str) -> std::io::Result<()> {
        let mut inner = self.lock();
        let Some(state) = inner.jobs.get(id).map(|job| job.state) else {
            return Ok(());
        };
        match state {
            State::Waiting => {
                inner.queue.retain(|queued| queued != id);
                if let Some(job) = inner.jobs.get_mut(id) {
                    job.mark_cancelled();
                }
                inner.emit_positions();
            }
            State::Submitting | State::Pending | State::Running => {
                if let Some(job) = inner.jobs.get_mut(id) {
                    job.state = State::Cancelling;
                    job.cancel_requested = true;
                    job.persist()?;
                    job.cancel.cancel();
                    job.emit_status();
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Deletes a terminal job that no other job depends on. The tombstone
    /// makes interrupted deletion recoverable.
    pub async fn delete(&self, id: &str) -> Result<(), DeleteError> {
        let (dir, work) = {
            let mut inner = self.lock();
            let job = inner.jobs.get(id).ok_or(DeleteError::NotFound)?;
            if !job.state.is_finished() {
                return Err(DeleteError::Conflict(
                    "cancel and wait for termination before deletion",
                ));
            }
            let depended = inner.jobs.values().any(|other| {
                other
                    .placement
                    .as_ref()
                    .is_some_and(|place| place.depends_on.iter().any(|dependency| dependency == id))
            });
            if depended {
                return Err(DeleteError::Conflict(
                    "another job depends on this job; delete it first",
                ));
            }
            if crate::durable::write(&job.dir.join("deleted.json"), &true).is_err() {
                return Err(DeleteError::Storage);
            }
            let dir = job.dir.clone();
            let work = job
                .placement
                .as_ref()
                .map(|place| self.dirs.project(&place.project).join(&place.directory));
            inner.jobs.remove(id);
            (dir, work)
        };
        if let Some(work) = work {
            remove_dir(&work).await;
        }
        remove_dir(&dir).await;
        Ok(())
    }

    /// Stops admission. Local runners' jobs are cancelled and awaited; a
    /// detaching runner's jobs are left to the scheduler and waiting jobs stay
    /// queued for the next start.
    pub async fn shutdown(&self) {
        self.stopping.cancel();
        let detaches = self.runner.detaches();
        if !detaches {
            let ids: Vec<String> = self.lock().jobs.keys().cloned().collect();
            for id in ids {
                let _ = self.cancel(&id);
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if tokio::time::Instant::now() >= deadline {
                tracing::error!("shutdown cleanup unconfirmed; recovery required before new jobs");
                break;
            }
            let settled = {
                let inner = self.lock();
                if detaches {
                    inner.executing == 0
                } else {
                    inner.jobs.values().all(|job| job.state.is_finished())
                }
            };
            if settled {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Removes finished jobs outside projects older than the retention period.
    pub async fn sweep(&self) {
        let cutoff = Utc::now()
            - chrono::Duration::from_std(self.options.retain).unwrap_or(chrono::Duration::hours(1));
        let expired: Vec<String> = {
            let inner = self.lock();
            inner
                .jobs
                .values()
                .filter(|job| job.placement.is_none() && job.state.is_finished())
                .filter(|job| job.finished_at.is_some_and(|finished| finished < cutoff))
                .map(|job| job.id.clone())
                .collect()
        };
        for id in expired {
            tracing::info!(job = %id, "retention expired");
            let _ = self.delete(&id).await;
        }
    }

    async fn dispatch(self: Arc<JobStore>) {
        loop {
            while let Some(started) = self.next() {
                let store = Arc::clone(&self);
                tokio::spawn(async move { store.execute(started).await });
            }
            tokio::select! {
                _ = self.wake.notified() => {},
                _ = self.stopping.cancelled() => return,
            }
        }
    }

    /// Hands the next waiting job to the runner while fewer than `parallel` execute.
    fn next(&self) -> Option<Started> {
        let mut inner = self.lock();
        loop {
            if self.stopping.is_cancelled() || inner.executing >= self.options.parallel.max(1) {
                return None;
            }
            let id = inner.queue.pop_front()?;
            if let Some(started) = self.begin(&mut inner, &id) {
                inner.executing += 1;
                inner.emit_positions();
                return Some(started);
            }
        }
    }

    fn begin(&self, inner: &mut Inner, id: &str) -> Option<Started> {
        let job = inner.jobs.get_mut(id)?;
        if job.state != State::Waiting {
            return None;
        }
        job.state = State::Submitting;
        if let Err(error) = job.persist() {
            job.fail(JobError::new("storage-failed", error.to_string()));
            return None;
        }
        match self.started(job, None) {
            Ok(started) => Some(started),
            Err(message) => {
                job.fail(JobError::new(
                    "tool-failed",
                    format!("cannot launch: {message}"),
                ));
                None
            }
        }
    }

    /// Restarts watching a job an earlier server process handed to the runner.
    fn resume(&self, inner: &mut Inner, id: &str) -> Option<Started> {
        let job = inner.jobs.get_mut(id)?;
        let resume = job.submitted_at.map(|submitted_at| Resume {
            submitted_at,
            scheduler_id: job.scheduler.as_ref().map(|scheduler| scheduler.id.clone()),
        });
        if job.cancel_requested {
            job.cancel.cancel();
        }
        match self.started(job, resume) {
            Ok(started) => Some(started),
            Err(message) => {
                job.fail(JobError::new(
                    "interrupted",
                    format!("cannot re-attach: {message}"),
                ));
                None
            }
        }
    }

    fn started(&self, job: &Job, resume: Option<Resume>) -> Result<Started, String> {
        let file_tool = match job.tool.layout() {
            Layout::Files(file_tool) => file_tool,
            Layout::Project(project_tool) => {
                let (Some(place), Some(inputs)) = (&job.placement, job.validated.project()) else {
                    return Err("project job without a project".into());
                };
                let profile = self
                    .options
                    .profiles
                    .resolve(&job.validated.command, inputs.profile.as_deref())?
                    .clone();
                let launch = project_tool.launch(inputs, &profile)?;
                let command = project_tool.command(
                    inputs,
                    &ProjectArgs {
                        directory: &place.directory,
                        profile: &profile,
                        launch,
                    },
                )?;
                let project_dir = self.dirs.project(&place.project);
                let request = RunRequest {
                    job_id: job.id.clone(),
                    job_dir: project_dir.join(&place.directory),
                    argv: command.main,
                    job: job.validated.clone(),
                    gpu: launch.gpus > 0,
                    image: job.tool.pinned_image(),
                    project: Some(ProjectRun {
                        tool: Arc::clone(&job.tool),
                        project_dir: project_dir.clone(),
                        directory: place.directory.clone(),
                        profile,
                        launch,
                        follow_up: command.follow_up,
                    }),
                    resume,
                };
                return Ok(Started {
                    request,
                    cancel: job.cancel.clone(),
                    log_path: None,
                    project: Some(ProjectFiles {
                        project_dir,
                        directory: place.directory.clone(),
                        required: project_tool.required_outputs(inputs),
                    }),
                });
            }
        };
        let paths = self.runner.paths(&job.dir);
        let mut request = RunRequest::files(
            job.tool.as_ref(),
            file_tool,
            job.id.clone(),
            job.dir.clone(),
            job.validated.clone(),
            &paths,
            self.options.cpu,
        );
        request.resume = resume;
        Ok(Started {
            request,
            cancel: job.cancel.clone(),
            log_path: Some(job.dir.join("out").join("log.txt")),
            project: None,
        })
    }

    async fn execute(self: Arc<JobStore>, started: Started) {
        let Started {
            request,
            cancel,
            log_path,
            project,
        } = started;
        let id = request.job_id.clone();
        let job_dir = request.job_dir.clone();
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
            let id = id.clone();
            let store = Arc::clone(&self);
            tokio::spawn(async move {
                consume_lines(store, id, log_path, line_rx).await;
            })
        };
        let context = RunContext {
            lines: line_tx,
            status: Arc::new(Reporter {
                store: Arc::clone(&self),
                id: id.clone(),
            }),
            cancel,
            detach: self.stopping.clone(),
        };
        let outcome = self.runner.run(request, context).await;
        let _ = consumer.await;
        if matches!(outcome, Ok(RunOutcome::Detached)) {
            self.lock().executing -= 1;
            return;
        }
        let files = match project {
            Some(files) => {
                let max = self.options.max_download_bytes;
                let collected = tokio::task::spawn_blocking(move || collect(&files, max)).await;
                Some(collected.unwrap_or_else(|error| Collected {
                    outputs: Err(std::io::Error::other(error.to_string())),
                    missing: None,
                }))
            }
            None => None,
        };
        let remove = {
            let mut inner = self.lock();
            inner.executing -= 1;
            match inner.jobs.get_mut(&id) {
                None => true,
                Some(job) => {
                    self.finish(job, outcome, files);
                    false
                }
            }
        };
        self.wake.notify_one();
        if remove {
            remove_dir(&job_dir).await;
        }
    }

    fn finish(
        &self,
        job: &mut Job,
        outcome: std::io::Result<RunOutcome>,
        files: Option<Collected>,
    ) {
        let tool_name = job.tool.id();
        if job.state == State::Cancelling && outcome.is_err() {
            job.error = Some(JobError::new(
                "termination-unconfirmed",
                "Could not confirm process termination; server rejects new work until restart and recovery.",
            ));
            if let Err(error) = job.persist() {
                tracing::error!(%error, "could not persist unconfirmed termination");
            }
            job.emit_status();
            self.stopping.cancel();
            return;
        }
        let outcome = if job.state == State::Cancelling && outcome.is_ok() {
            Ok(RunOutcome::Cancelled)
        } else {
            outcome
        };
        let mut missing = None;
        let mut listing_error = None;
        if let Some(files) = files {
            missing = files.missing;
            match files.outputs {
                Ok(outputs) => job.outputs = outputs,
                Err(error) => listing_error = Some(error),
            }
        }
        match outcome {
            Ok(RunOutcome::Cancelled) => {
                job.mark_cancelled();
                return;
            }
            Ok(RunOutcome::Exited(0)) if job.placement.is_some() => {
                if let Some(error) = listing_error {
                    job.fail(JobError::new("storage-failed", error.to_string()));
                    return;
                }
                if let Some(name) = missing {
                    job.fail(JobError::new(
                        "tool-failed",
                        format!("{tool_name} did not write {name}"),
                    ));
                    return;
                }
                job.state = State::Succeeded;
                job.progress = Some(1.0);
            }
            Ok(RunOutcome::Exited(0)) => match file_outputs(job) {
                Ok(outputs) => {
                    job.state = State::Succeeded;
                    job.outputs = outputs;
                    job.progress = Some(1.0);
                }
                Err(error) => {
                    job.fail(error);
                    return;
                }
            },
            Ok(RunOutcome::Exited(code)) => {
                job.state = State::Failed;
                job.error = Some(JobError::new(
                    "tool-failed",
                    format!("{tool_name} exited with status {code}"),
                ));
            }
            Ok(RunOutcome::Failed { code, message }) => {
                job.state = State::Failed;
                job.error = Some(JobError::new(code, message));
            }
            Ok(RunOutcome::Detached) => {
                job.state = State::Failed;
                job.error = Some(JobError::new("interrupted", "the runner detached"));
            }
            Err(error) => {
                job.state = State::Failed;
                job.error = Some(JobError::new(
                    "tool-failed",
                    format!("{tool_name} could not run: {error}"),
                ));
            }
        }
        job.finished_at = Some(Utc::now());
        job.persist_or_fail();
        job.emit_status();
        job.emit(Event::Done(Box::new(job.view(0))));
    }

    /// Applies a runner's state report.
    fn apply(&self, id: &str, event: RunnerEvent) -> std::io::Result<()> {
        let mut inner = self.lock();
        let Some(job) = inner.jobs.get_mut(id) else {
            return Ok(());
        };
        match event {
            RunnerEvent::Submitting { at } => {
                job.submitted_at = Some(at);
                if let Err(error) = job.persist() {
                    job.submitted_at = None;
                    return Err(error);
                }
            }
            RunnerEvent::Submitted { scheduler_id } => {
                job.scheduler = Some(SchedulerView {
                    id: scheduler_id,
                    state: "PENDING".into(),
                });
                if job.state == State::Submitting {
                    job.state = State::Pending;
                }
                job.persist()?;
            }
            RunnerEvent::Pending { state, reason } => {
                let message = match reason {
                    Some(reason) => format!("Waiting in the cluster queue ({reason})"),
                    None => "Waiting in the cluster queue".to_string(),
                };
                job.message = Some(message);
                let changed = job
                    .scheduler
                    .as_ref()
                    .is_some_and(|scheduler| scheduler.state != state);
                if let Some(scheduler) = job.scheduler.as_mut() {
                    scheduler.state = state;
                }
                if job.state == State::Submitting {
                    job.state = State::Pending;
                }
                if changed {
                    job.persist()?;
                }
            }
            RunnerEvent::Running { state } => {
                if let (Some(state), Some(scheduler)) = (state, job.scheduler.as_mut()) {
                    scheduler.state = state;
                }
                if job.started_at.is_none() {
                    job.started_at = Some(Utc::now());
                }
                if matches!(job.state, State::Submitting | State::Pending) {
                    job.state = State::Running;
                    job.emit_status();
                }
                job.persist()?;
            }
        }
        Ok(())
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
        if job.state != State::Pending {
            job.message = Some(line.to_string());
        }
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

/// Forwards a runner's reports for one job to the store.
struct Reporter {
    store: Arc<JobStore>,
    id: String,
}

impl StatusReporter for Reporter {
    fn report(&self, event: RunnerEvent) -> std::io::Result<()> {
        self.store.apply(&self.id, event)
    }
}

/// A project job's files after its run.
struct Collected {
    outputs: std::io::Result<Vec<OutputInfo>>,
    /// The first required output the job did not write.
    missing: Option<String>,
}

fn collect(files: &ProjectFiles, max_download: u64) -> Collected {
    let work = files.project_dir.join(&files.directory);
    let missing = files
        .required
        .iter()
        .find(|name| !work.join(name).is_file())
        .cloned();
    Collected {
        outputs: crate::projects::list_outputs(&files.project_dir, &files.directory, max_download),
        missing,
    }
}

/// The declared outputs of a succeeded file tool's job.
fn file_outputs(job: &Job) -> Result<Vec<OutputInfo>, JobError> {
    let Layout::Files(file_tool) = job.tool.layout() else {
        return Err(JobError::new("tool-failed", "not a file tool"));
    };
    let out_dir = job.dir.join("out");
    let mut outputs = Vec::new();
    for spec in file_tool.outputs(&job.validated) {
        let path = out_dir.join(spec.name);
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => {
                std::fs::File::open(&path)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| JobError::new("storage-failed", error.to_string()))?;
                outputs.push(OutputInfo {
                    name: spec.name.to_string(),
                    bytes: metadata.len(),
                    content_type: spec.content_type.to_string(),
                    download: None,
                });
            }
            _ if spec.required => {
                return Err(JobError::new(
                    "tool-failed",
                    format!("{} did not write {}", job.tool.id(), spec.name),
                ));
            }
            _ => {}
        }
    }
    Ok(outputs)
}

async fn consume_lines(
    store: Arc<JobStore>,
    id: String,
    log_path: Option<PathBuf>,
    mut lines: mpsc::UnboundedReceiver<String>,
) {
    let mut file = match log_path {
        Some(path) => tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .ok(),
        None => None,
    };
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
mod tests;
