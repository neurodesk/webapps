//! Tool definitions: a tool owns spec validation, the `argv` mapping and the
//! progress mapping of its log lines. The server never runs caller-supplied
//! command lines.

#[cfg(test)]
pub mod fake;
pub mod mrc;
pub mod nesvor;
pub mod nifti;
pub mod project;
pub mod sct;

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

/// A multipart file part that was received and stored in the job's `in/` directory.
#[derive(Debug, Clone)]
pub struct ReceivedPart {
    /// Multipart part name (`stack-0`, `mask-0`, …).
    pub name: String,
    /// Where the bytes were stored.
    pub path: PathBuf,
    /// File name inside the job's `in/` directory (`stack-0.nii.gz`,
    /// `stack-0.nii`, or `gain.mrc` for project tools).
    pub file_name: String,
    /// Whether the bytes are gzip-compressed.
    pub gzipped: bool,
    /// The first (decompressed) bytes of the file: at most 352 of a NIfTI
    /// upload, 1024 of an MRC upload.
    pub header: Vec<u8>,
    /// Size of the stored (possibly compressed) file.
    pub bytes: u64,
}

/// One input stack of a validated job.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StackInput {
    /// Part name of the stack.
    pub file: String,
    /// File name in the job's `in/` directory.
    pub file_name: String,
    /// Slice thickness in mm.
    pub thickness: f64,
    /// Part name of the optional mask.
    pub mask: Option<String>,
    /// File name of the optional mask in the job's `in/` directory.
    pub mask_file_name: Option<String>,
}

/// A job specification that passed validation.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ValidatedJob {
    /// Tool identifier (`nesvor`).
    pub tool: String,
    /// Tool command (`reconstruct`).
    pub command: String,
    /// Tool-specific validated inputs.
    #[serde(flatten)]
    pub inputs: JobInputs,
    /// Options as given in the spec (only the keys that were present).
    pub options: serde_json::Map<String, Value>,
    /// Warnings produced during validation that are logged when the job starts.
    pub warnings: Vec<String>,
}

/// Tool-owned inputs. The untagged NeSVoR shape preserves persisted v1 jobs.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum JobInputs {
    Nesvor { stacks: Vec<StackInput> },
    Sct { analysis: sct::AnalysisInputs },
    Project { project: project::ProjectInputs },
}

impl ValidatedJob {
    pub fn stacks(&self) -> &[StackInput] {
        match &self.inputs {
            JobInputs::Nesvor { stacks } => stacks,
            _ => &[],
        }
    }

    /// The inputs of a project tool's job.
    pub fn project(&self) -> Option<&project::ProjectInputs> {
        match &self.inputs {
            JobInputs::Project { project } => Some(project),
            _ => None,
        }
    }

    /// The inputs of a project tool's job, for the server to resolve.
    pub fn project_mut(&mut self) -> Option<&mut project::ProjectInputs> {
        match &mut self.inputs {
            JobInputs::Project { project } => Some(project),
            _ => None,
        }
    }
}

/// Paths of the job directory as seen by the tool process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPaths {
    /// Directory with the input files (`/job/in` inside a container).
    pub input_dir: String,
    /// Directory for the outputs (`/job/out` inside a container).
    pub output_dir: String,
}

impl ToolPaths {
    /// The paths used inside containers.
    pub fn container() -> ToolPaths {
        ToolPaths {
            input_dir: "/job/in".to_string(),
            output_dir: "/job/out".to_string(),
        }
    }

    /// Joins a file name onto a directory with `/`.
    pub fn join(dir: &str, name: &str) -> String {
        format!("{}/{}", dir.trim_end_matches(['/', '\\']), name)
    }
}

/// A validation failure; reported as `invalid-spec`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecError {
    /// Human-readable explanation.
    pub message: String,
}

impl SpecError {
    /// Creates an error with the given message.
    pub fn new(message: impl Into<String>) -> SpecError {
        SpecError {
            message: message.into(),
        }
    }
}

impl fmt::Display for SpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SpecError {}

/// Log level of a forwarded line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    /// Informational output.
    Info,
    /// A warning.
    Warning,
    /// An error.
    Error,
}

impl LogLevel {
    /// The spelling used on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Info => "info",
            LogLevel::Warning => "warning",
            LogLevel::Error => "error",
        }
    }
}

/// What a log line tells about the job.
#[derive(Debug, Clone, PartialEq)]
pub struct LogUpdate {
    /// Level of the line.
    pub level: LogLevel,
    /// Progress fraction and stage name when the line marks progress.
    pub progress: Option<(f64, String)>,
}

/// A declared output file of a tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputSpec {
    /// File name in the job's `out/` directory and in the API.
    pub name: &'static str,
    /// MIME type served for the file.
    pub content_type: &'static str,
    /// Whether a successful job must have written it.
    pub required: bool,
}

/// A tool definition.
pub trait Tool: Send + Sync {
    /// Tool identifier (`nesvor`).
    fn id(&self) -> &'static str;
    /// Tool version (`0.5.0`).
    fn version(&self) -> &'static str;
    /// Container image that replaces the configured `--image`, for tools pinned
    /// to their own scientific runtime.
    fn pinned_image(&self) -> Option<&'static str> {
        None
    }
    /// Whether the tool runs on the GPU unless the server is started with `--cpu`.
    fn uses_gpu(&self) -> bool;
    /// Commands accepted in `spec.command`.
    fn commands(&self) -> &'static [&'static str];
    /// Validates the spec against the received parts.
    fn validate(&self, spec: &Value, parts: &[ReceivedPart]) -> Result<ValidatedJob, SpecError>;
    /// Classifies a log line and extracts progress.
    fn parse_log_line(&self, job: &ValidatedJob, line: &str) -> LogUpdate;
    /// Whether the tool works on its own `in/` and `out/` or in a project.
    fn layout(&self) -> Layout<'_>;
}

/// Where a tool's job reads and writes.
pub enum Layout<'a> {
    /// NIfTI uploads in the job's `in/`, a static list of outputs in `out/`.
    Files(&'a dyn FileTool),
    /// MRC uploads and every output in the job's `<Type>/jobNNN/` of a project.
    Project(&'a dyn ProjectTool),
}

/// A tool that runs on uploaded NIfTI files in its own job directory.
pub trait FileTool: Send + Sync {
    /// Arguments appended to a GPU tool's command line when it runs on the CPU.
    fn cpu_flags(&self) -> &'static [&'static str] {
        &[]
    }
    /// Builds the tool command line (first element is the program name).
    fn argv(&self, job: &ValidatedJob, paths: &ToolPaths) -> Vec<String>;
    /// The outputs the tool produces.
    fn outputs(&self, job: &ValidatedJob) -> &'static [OutputSpec];
}

pub use project::ProjectTool;

/// All registered tools.
pub fn registry() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(nesvor::Nesvor), Arc::new(sct::Sct)]
}

/// The tools a configuration offers: project tools only in single-owner
/// mode, file tools never on Slurm, SCT only with Docker or the simulator.
pub fn available(
    config: &crate::config::ServeConfig,
    tools: Vec<Arc<dyn Tool>>,
) -> Vec<Arc<dyn Tool>> {
    use crate::config::RunnerKind;
    tools
        .into_iter()
        .filter(|tool| match tool.layout() {
            Layout::Project(_) => config.single_owner,
            Layout::Files(_) => {
                config.runner != RunnerKind::Slurm
                    && (tool.id() != "sct"
                        || matches!(config.runner, RunnerKind::Docker | RunnerKind::Simulate))
            }
        })
        .collect()
}

/// Looks up a tool by id.
pub fn find(tools: &[Arc<dyn Tool>], id: &str) -> Option<Arc<dyn Tool>> {
    tools.iter().find(|tool| tool.id() == id).cloned()
}

/// Splits a Python-logging line `YYYY-MM-DD HH:MM:SS [LEVEL] message` into
/// the level and the message. Other lines are `info` with the whole line as
/// message.
pub fn split_python_log(line: &str) -> (LogLevel, &str) {
    let trimmed = line.trim_end();
    let mut fields = trimmed.splitn(4, ' ');
    let date = fields.next().unwrap_or("");
    let time = fields.next().unwrap_or("");
    let level_field = fields.next().unwrap_or("");
    let rest = fields.next().unwrap_or("");
    let looks_like_date = date.len() == 10 && date.as_bytes().get(4) == Some(&b'-');
    let looks_like_time = time.len() == 8 && time.as_bytes().get(2) == Some(&b':');
    if looks_like_date
        && looks_like_time
        && level_field.starts_with('[')
        && level_field.ends_with(']')
    {
        let level = match &level_field[1..level_field.len() - 1] {
            "WARNING" | "WARN" => LogLevel::Warning,
            "ERROR" | "CRITICAL" | "FATAL" => LogLevel::Error,
            _ => LogLevel::Info,
        };
        return (level, rest);
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("traceback") || lower.contains("error") {
        return (LogLevel::Error, trimmed);
    }
    if lower.contains("warning") {
        return (LogLevel::Warning, trimmed);
    }
    (LogLevel::Info, trimmed)
}
