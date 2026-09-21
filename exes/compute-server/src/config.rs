//! Runtime configuration of the `serve` subcommand.

use std::path::PathBuf;
use std::time::Duration;

/// Which runner executes tool jobs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerKind {
    /// `docker run` with the pinned image.
    Docker,
    /// `apptainer exec` with a `.simg` image.
    Apptainer,
    /// The tool binary on `PATH`.
    Native,
    /// Built-in placeholder that averages the input stacks.
    Simulate,
}

impl RunnerKind {
    /// Stable identifier used on the command line and in `info.runner`.
    pub fn id(self) -> &'static str {
        match self {
            RunnerKind::Docker => "docker",
            RunnerKind::Apptainer => "apptainer",
            RunnerKind::Native => "native",
            RunnerKind::Simulate => "simulate",
        }
    }

    /// Parses the command-line spelling.
    pub fn parse(value: &str) -> Option<RunnerKind> {
        match value {
            "docker" => Some(RunnerKind::Docker),
            "apptainer" => Some(RunnerKind::Apptainer),
            "native" => Some(RunnerKind::Native),
            "simulate" => Some(RunnerKind::Simulate),
            _ => None,
        }
    }
}

/// TLS mode of the listener.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TlsMode {
    /// Plain HTTP (`--insecure-http`).
    Insecure,
    /// A site certificate given on the command line.
    Site { cert: PathBuf, key: PathBuf },
    /// A self-signed certificate generated into the data directory.
    SelfSigned,
}

/// GPU information reported by `info.gpu`.
#[derive(Debug, Clone, Default)]
pub struct GpuInfo {
    /// Whether a GPU will be passed to the tool.
    pub available: bool,
    /// Device name when known.
    pub name: Option<String>,
}

/// Everything the server needs to start.
#[derive(Debug, Clone)]
pub struct ServeConfig {
    /// Socket address to bind, e.g. `0.0.0.0:8765`.
    pub listen: String,
    /// Bearer token every API request must carry.
    pub token: String,
    /// Directory holding jobs, the token and TLS material.
    pub data_dir: PathBuf,
    /// Selected runner.
    pub runner: RunnerKind,
    /// Docker image reference or path to the `.simg` file.
    pub image: String,
    /// Run without GPU (`--device -1`, no `--gpus all` / `--nv`).
    pub cpu: bool,
    /// Number of jobs that run concurrently.
    pub parallel: usize,
    /// How long finished jobs are kept.
    pub retain: Duration,
    /// Extra origins allowed by CORS.
    pub allow_origins: Vec<String>,
    /// TLS mode.
    pub tls: TlsMode,
    /// Directory with static files served at `/`.
    pub www: Option<PathBuf>,
    /// Maximum request body size in bytes.
    pub max_upload_bytes: u64,
    /// Maximum number of file parts per job.
    pub max_files: usize,
    /// GPU information detected at start.
    pub gpu: GpuInfo,
    /// Interval of the retention sweep.
    pub sweep_interval: Duration,
}

impl ServeConfig {
    /// A configuration suitable for tests and development: simulate runner,
    /// plain HTTP on an ephemeral port, everything in `data_dir`.
    pub fn simulated(data_dir: PathBuf, token: &str) -> ServeConfig {
        ServeConfig {
            listen: "127.0.0.1:0".to_string(),
            token: token.to_string(),
            data_dir,
            runner: RunnerKind::Simulate,
            image: crate::NESVOR_DOCKER_IMAGE.to_string(),
            cpu: true,
            parallel: 1,
            retain: Duration::from_secs(3600),
            allow_origins: Vec::new(),
            tls: TlsMode::Insecure,
            www: None,
            max_upload_bytes: 4 * 1024 * 1024 * 1024,
            max_files: 40,
            gpu: GpuInfo::default(),
            sweep_interval: Duration::from_secs(30),
        }
    }

    /// `https` or `http` depending on the TLS mode.
    pub fn scheme(&self) -> &'static str {
        match self.tls {
            TlsMode::Insecure => "http",
            TlsMode::Site { .. } | TlsMode::SelfSigned => "https",
        }
    }
}
