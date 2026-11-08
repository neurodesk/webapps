//! Startup recovery: projects, job records, and what happens to jobs an
//! earlier server process left unfinished.

use std::path::Path;

use chrono::{DateTime, Utc};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use super::model::Record;
use super::{Job, JobError, JobStore, Placement, State};
use crate::runner::Recovery;

fn time(value: &str) -> std::io::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(std::io::Error::other)
}

impl JobStore {
    /// Restores projects and job records. Unacknowledged uploads, deletion
    /// tombstones and jobs of deleted projects are removed; unfinished jobs
    /// are failed, requeued or re-attached as the runner decides.
    pub fn recover(&self) -> std::io::Result<()> {
        for project in self.dirs.load()? {
            if project.deleted {
                self.dirs.remove(&project.id)?;
                continue;
            }
            self.lock().projects.insert(project.id.clone(), project);
        }
        let root = self.options.data_dir.join("jobs");
        std::fs::create_dir_all(&root)?;
        let mut requeue = Vec::new();
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let dir = entry.path();
            if dir.join("deleted.json").exists() || !dir.join("job.json").exists() {
                if let Some(Record { view, .. }) = read_record(&dir) {
                    if let (Some(project), Some(directory)) = (view.project, view.directory) {
                        crate::projects::remove_if_present(
                            &self.dirs.project(&project).join(directory),
                        )?;
                    }
                }
                std::fs::remove_dir_all(&dir)?;
                continue;
            }
            let record: Record = serde_json::from_slice(&std::fs::read(dir.join("job.json"))?)?;
            if let Some(project) = &record.view.project {
                if !self.lock().projects.contains_key(project) {
                    std::fs::remove_dir_all(&dir)?;
                    continue;
                }
            }
            let mut job = self.restore(record, dir)?;
            if !job.state.is_finished() {
                match self.recovery(&mut job)? {
                    Some(Recovery::Requeue) => requeue.push((job.created_at, job.id.clone())),
                    Some(Recovery::Reattach) => self.lock().reattach.push(job.id.clone()),
                    Some(Recovery::Interrupted) | None => {}
                }
            }
            self.lock().jobs.insert(job.id.clone(), job);
        }
        requeue.sort();
        let mut inner = self.lock();
        for (_, id) in requeue {
            inner.queue.push_back(id);
        }
        Ok(())
    }

    fn restore(&self, record: Record, dir: std::path::PathBuf) -> std::io::Result<Job> {
        let state = record.state();
        let view = record.view;
        if dir.file_name().and_then(|name| name.to_str()) != Some(&view.id) {
            return Err(std::io::Error::other("job record directory mismatch"));
        }
        let tool = crate::tools::find(&self.tools, &view.tool).ok_or_else(|| {
            std::io::Error::other(format!("unknown persisted tool '{}'", view.tool))
        })?;
        let placement = match (view.project, view.directory) {
            (Some(project), Some(directory)) => Some(Placement {
                project,
                directory,
                depends_on: view.depends_on,
            }),
            _ => None,
        };
        let (events, _) = broadcast::channel(4096);
        Ok(Job {
            runner: crate::config::RunnerKind::parse(&record.runner)
                .ok_or_else(|| std::io::Error::other("unknown persisted runner"))?,
            owner: record.owner,
            key: record.key,
            fingerprint: record.fingerprint,
            id: view.id,
            tool,
            validated: record.validated,
            dir,
            state,
            placement,
            scheduler: view.scheduler,
            submitted_at: record.submitted_at.as_deref().map(time).transpose()?,
            cancel_requested: record.cancel_requested,
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
        })
    }

    /// Settles an unfinished job; `None` when it became terminal here.
    fn recovery(&self, job: &mut Job) -> std::io::Result<Option<Recovery>> {
        if job.runner != self.runner.kind() {
            crate::runner::process::reconcile(job.runner, &job.id)?;
            interrupt(job)?;
            return Ok(None);
        }
        if job.cancel_requested && job.submitted_at.is_none() {
            job.state = State::Cancelled;
            job.finished_at = Some(Utc::now());
            job.persist()?;
            return Ok(None);
        }
        let recovery = self.runner.recover(&job.id, job.submitted_at.is_some())?;
        match recovery {
            Recovery::Interrupted => interrupt(job)?,
            Recovery::Requeue => {
                job.state = State::Waiting;
                job.persist()?;
            }
            Recovery::Reattach => {}
        }
        Ok(Some(recovery))
    }
}

fn interrupt(job: &mut Job) -> std::io::Result<()> {
    job.state = State::Failed;
    job.finished_at = Some(Utc::now());
    job.error = Some(JobError::new(
        "interrupted",
        "Server stopped before execution completed; submit a new job to retry.",
    ));
    job.persist()
}

fn read_record(dir: &Path) -> Option<Record> {
    let bytes = std::fs::read(dir.join("job.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}
