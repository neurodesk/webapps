//! Job states, the wire job object, SSE events and the persisted record.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tools::{LogLevel, ValidatedJob};

/// Status of a job on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Waiting in the server's queue or the cluster's.
    Queued,
    /// The tool is executing.
    Running,
    /// The tool exited with status 0 and wrote its outputs.
    Succeeded,
    /// The tool failed.
    Failed,
    /// The job was cancelled.
    Cancelled,
    /// Waiting for termination.
    Cancelling,
}

impl Status {
    /// Whether the job reached a final state.
    pub fn is_finished(self) -> bool {
        matches!(self, Status::Succeeded | Status::Failed | Status::Cancelled)
    }
}

/// Internal lifecycle state (ADR-0004); several map to one wire status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// In the server's own queue, not yet handed to the runner.
    Waiting,
    /// Handed to the runner; a scheduler's acceptance is not yet known.
    Submitting,
    /// Accepted by the scheduler, waiting.
    Pending,
    /// The runner reports the tool executing.
    Running,
    /// Cancel requested; termination not yet confirmed.
    Cancelling,
    /// Terminal.
    Succeeded,
    /// Terminal.
    Failed,
    /// Terminal.
    Cancelled,
}

impl State {
    /// The wire status.
    pub fn status(self) -> Status {
        match self {
            State::Waiting | State::Submitting | State::Pending => Status::Queued,
            State::Running => Status::Running,
            State::Cancelling => Status::Cancelling,
            State::Succeeded => Status::Succeeded,
            State::Failed => Status::Failed,
            State::Cancelled => Status::Cancelled,
        }
    }

    /// Whether the job reached a final state.
    pub fn is_finished(self) -> bool {
        self.status().is_finished()
    }

    /// The state of a record written before internal states were persisted.
    fn from_status(status: Status) -> State {
        match status {
            Status::Queued => State::Waiting,
            Status::Running => State::Running,
            Status::Cancelling => State::Cancelling,
            Status::Succeeded => State::Succeeded,
            Status::Failed => State::Failed,
            Status::Cancelled => State::Cancelled,
        }
    }
}

/// Error record of a failed job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobError {
    /// Error code (`tool-failed`, `interrupted`, `scheduler-lost`, …).
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

impl JobError {
    /// Creates an error record.
    pub fn new(code: &str, message: impl Into<String>) -> JobError {
        JobError {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// A produced output file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputInfo {
    /// File name; project-relative for project jobs.
    pub name: String,
    /// Size in bytes.
    pub bytes: u64,
    /// MIME type.
    pub content_type: String,
    /// Whether the file can be downloaded; absent for jobs outside projects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download: Option<bool>,
}

/// `scheduler` of the job object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchedulerView {
    /// Slurm job id.
    pub id: String,
    /// Slurm's state string.
    pub state: String,
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
    /// Number of jobs ahead in the queue (0 unless waiting).
    pub position: usize,
    /// Progress fraction, `null` before the first progress event.
    pub progress: Option<f64>,
    /// Current stage name.
    pub stage: Option<String>,
    /// Last log line, or the scheduler's pending reason.
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
    /// Outputs of a finished job.
    pub outputs: Vec<OutputInfo>,
    /// Project id, `null` outside projects.
    #[serde(default)]
    pub project: Option<String>,
    /// `<Type>/jobNNN`, `null` outside projects.
    #[serde(default)]
    pub directory: Option<String>,
    /// Ids of the jobs whose outputs this job reads.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// The scheduler's id and state once it has accepted the job.
    #[serde(default)]
    pub scheduler: Option<SchedulerView>,
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

/// `<data-dir>/jobs/<id>/job.json`.
#[derive(Serialize, Deserialize)]
pub struct Record {
    pub runner: String,
    pub owner: String,
    pub key: String,
    pub fingerprint: String,
    pub validated: ValidatedJob,
    pub view: JobView,
    /// Absent in records of servers before internal states.
    #[serde(default)]
    pub state: Option<State>,
    /// RFC 3339 time the runner persisted before handing the job to the scheduler.
    #[serde(default)]
    pub submitted_at: Option<String>,
    /// A cancel was requested; it survives restarts until resolved.
    #[serde(default)]
    pub cancel_requested: bool,
}

impl Record {
    /// The persisted internal state.
    pub fn state(&self) -> State {
        self.state
            .unwrap_or_else(|| State::from_status(self.view.status))
    }
}
