//! Tool definitions: a tool owns spec validation, the `argv` mapping and the
//! progress mapping of its log lines. The server never runs caller-supplied
//! command lines.

pub mod nesvor;
pub mod nifti;

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
    /// File name inside the job's `in/` directory (`stack-0.nii.gz` or `stack-0.nii`).
    pub file_name: String,
    /// Whether the bytes are gzip-compressed.
    pub gzipped: bool,
    /// The first (decompressed) bytes of the file, at most 352.
    pub header: Vec<u8>,
    /// Size of the stored (possibly compressed) file.
    pub bytes: u64,
}

/// One input stack of a validated job.
#[derive(Debug, Clone, PartialEq)]
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
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedJob {
    /// Tool identifier (`nesvor`).
    pub tool: String,
    /// Tool command (`reconstruct`).
    pub command: String,
    /// Input stacks in spec order.
    pub stacks: Vec<StackInput>,
    /// Options as given in the spec (only the keys that were present).
    pub options: serde_json::Map<String, Value>,
    /// Warnings produced during validation that are logged when the job starts.
    pub warnings: Vec<String>,
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
    /// Commands accepted in `spec.command`.
    fn commands(&self) -> &'static [&'static str];
    /// Validates the spec against the received parts.
    fn validate(&self, spec: &Value, parts: &[ReceivedPart]) -> Result<ValidatedJob, SpecError>;
    /// Builds the tool command line (first element is the program name).
    fn argv(&self, job: &ValidatedJob, paths: &ToolPaths) -> Vec<String>;
    /// Classifies a log line and extracts progress.
    fn parse_log_line(&self, job: &ValidatedJob, line: &str) -> LogUpdate;
    /// The outputs the tool produces.
    fn outputs(&self) -> &'static [OutputSpec];
}

/// All registered tools.
pub fn registry() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(nesvor::Nesvor)]
}

/// Looks up a tool by id.
pub fn find(tools: &[Arc<dyn Tool>], id: &str) -> Option<Arc<dyn Tool>> {
    tools.iter().find(|tool| tool.id() == id).cloned()
}
