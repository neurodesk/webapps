//! Project operations on the job store, under its lock.

use chrono::Utc;
use serde::Serialize;

use super::{remove_dir, DeleteError, JobStore, Status};
use crate::projects::Project;

/// An entry of `GET /api/v1/projects`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub job_count: usize,
}

/// A job of `GET /api/v1/projects/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectJobView {
    pub id: String,
    pub command: String,
    pub directory: String,
    pub status: Status,
    pub depends_on: Vec<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

/// `GET /api/v1/projects/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub id: String,
    pub name: String,
    pub created_at: String,
    /// Jobs in creation order.
    pub jobs: Vec<ProjectJobView>,
}

impl JobStore {
    /// Creates a project directory and its record.
    pub fn create_project(&self, name: String) -> std::io::Result<ProjectDetail> {
        let mut inner = self.lock();
        // Creation times are strictly increasing, so projects created within
        // one millisecond still list newest first.
        let newest = inner.projects.values().filter_map(Project::created).max();
        let mut created = Utc::now();
        if let Some(newest) = newest {
            if created <= newest {
                created = newest + chrono::Duration::milliseconds(1);
            }
        }
        let project = Project::new(crate::api::new_job_id(), name, created);
        let dir = self.dirs.project(&project.id);
        std::fs::create_dir_all(&dir)?;
        if let Err(error) = self.dirs.persist(&project) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(error);
        }
        inner.projects.insert(project.id.clone(), project.clone());
        drop(inner);
        Ok(ProjectDetail {
            id: project.id,
            name: project.name,
            created_at: project.created_at,
            jobs: Vec::new(),
        })
    }

    /// All projects, newest first.
    pub fn projects(&self) -> Vec<ProjectSummary> {
        let inner = self.lock();
        let mut ordered: Vec<&Project> = inner.projects.values().collect();
        ordered.sort_by(|a, b| {
            b.created()
                .cmp(&a.created())
                .then_with(|| b.created_at.cmp(&a.created_at))
                .then_with(|| b.id.cmp(&a.id))
        });
        ordered
            .into_iter()
            .map(|project| ProjectSummary {
                id: project.id.clone(),
                name: project.name.clone(),
                created_at: project.created_at.clone(),
                job_count: inner
                    .jobs
                    .values()
                    .filter(|job| {
                        job.placement
                            .as_ref()
                            .is_some_and(|place| place.project == project.id)
                    })
                    .count(),
            })
            .collect()
    }

    /// A project with its jobs in creation order.
    pub fn project(&self, id: &str) -> Option<ProjectDetail> {
        let inner = self.lock();
        let project = inner.projects.get(id)?;
        let mut jobs: Vec<_> = inner
            .jobs
            .values()
            .filter_map(|job| {
                let place = job.placement.as_ref()?;
                (place.project == id).then_some((job, place))
            })
            .collect();
        jobs.sort_by(|(a, _), (b, _)| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        Some(ProjectDetail {
            id: project.id.clone(),
            name: project.name.clone(),
            created_at: project.created_at.clone(),
            jobs: jobs
                .into_iter()
                .map(|(job, place)| ProjectJobView {
                    id: job.id.clone(),
                    command: job.validated.command.clone(),
                    directory: place.directory.clone(),
                    status: job.state.status(),
                    depends_on: place.depends_on.clone(),
                    created_at: super::rfc3339(job.created_at),
                    finished_at: job.finished_at.map(super::rfc3339),
                })
                .collect(),
        })
    }

    /// Deletes a project whose jobs are all terminal: its job records and its
    /// directory. The record is marked deleted first, so recovery finishes an
    /// interrupted deletion.
    pub async fn delete_project(&self, id: &str) -> Result<(), DeleteError> {
        let job_dirs = {
            let mut inner = self.lock();
            let project = inner.projects.get(id).ok_or(DeleteError::NotFound)?;
            let in_project = |job: &&super::Job| {
                job.placement
                    .as_ref()
                    .is_some_and(|place| place.project == id)
            };
            if inner
                .jobs
                .values()
                .filter(in_project)
                .any(|job| !job.state.is_finished())
            {
                return Err(DeleteError::Conflict(
                    "a job in the project is still active",
                ));
            }
            let mut deleted = project.clone();
            deleted.deleted = true;
            self.dirs
                .persist(&deleted)
                .map_err(|_| DeleteError::Storage)?;
            let ids: Vec<String> = inner
                .jobs
                .values()
                .filter(in_project)
                .map(|job| job.id.clone())
                .collect();
            let mut job_dirs = Vec::new();
            for job_id in ids {
                if let Some(job) = inner.jobs.remove(&job_id) {
                    job_dirs.push(job.dir);
                }
            }
            inner.projects.remove(id);
            job_dirs
        };
        for dir in job_dirs {
            remove_dir(&dir).await;
        }
        let dirs = self.dirs.clone();
        let id = id.to_string();
        let removed = tokio::task::spawn_blocking(move || dirs.remove(&id)).await;
        if !matches!(removed, Ok(Ok(()))) {
            tracing::warn!("could not remove a deleted project's directory; recovery retries");
        }
        Ok(())
    }
}
