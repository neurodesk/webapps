//! Runtime configuration of the `serve` subcommand.

use std::path::PathBuf;
use std::time::Duration;

use crate::profiles::Profiles;
use crate::roots::DataRoot;
use crate::runner::slurm::SlurmSettings;

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
    /// Slurm batch jobs running an apptainer image (single-owner mode only).
    Slurm,
}

impl RunnerKind {
    /// Stable identifier used on the command line and in `info.runner`.
    pub fn id(self) -> &'static str {
        match self {
            RunnerKind::Docker => "docker",
            RunnerKind::Apptainer => "apptainer",
            RunnerKind::Native => "native",
            RunnerKind::Simulate => "simulate",
            RunnerKind::Slurm => "slurm",
        }
    }

    /// Parses the command-line spelling.
    pub fn parse(value: &str) -> Option<RunnerKind> {
        match value {
            "docker" => Some(RunnerKind::Docker),
            "apptainer" => Some(RunnerKind::Apptainer),
            "native" => Some(RunnerKind::Native),
            "simulate" => Some(RunnerKind::Simulate),
            "slurm" => Some(RunnerKind::Slurm),
            _ => None,
        }
    }
}

/// Default of `--max-download-bytes`: 2 GiB.
pub const DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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
    /// Installation pairing code; cannot authorize patient APIs.
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
    /// Every pairing maps to one owner; enables projects and data roots.
    pub single_owner: bool,
    /// Idle period after which a single-owner credential is revoked.
    pub session_idle: Duration,
    /// Read-only data roots (single-owner mode only).
    pub data_roots: Vec<DataRoot>,
    /// Outputs above this size are listed with `download: false`.
    pub max_download_bytes: u64,
    /// Resource profiles of project jobs.
    pub profiles: Profiles,
    /// The Slurm runner's settings.
    pub slurm: Option<SlurmSettings>,
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
            single_owner: false,
            session_idle: crate::auth::SESSION_IDLE,
            data_roots: Vec::new(),
            max_download_bytes: DEFAULT_MAX_DOWNLOAD_BYTES,
            profiles: Profiles::local(),
            slurm: None,
        }
    }

    /// `info.ownership`.
    pub fn ownership(&self) -> &'static str {
        if self.single_owner {
            "single"
        } else {
            "pairing"
        }
    }

    /// `info.features`: projects and data roots in single-owner mode, the
    /// scheduler with the Slurm runner.
    pub fn features(&self) -> Vec<&'static str> {
        let mut features = Vec::new();
        if self.single_owner {
            features.extend(["projects", "dataRoots"]);
        }
        if self.runner == RunnerKind::Slurm {
            features.push("scheduler");
        }
        features
    }

    /// Whether a feature is enabled.
    pub fn has_feature(&self, feature: &str) -> bool {
        self.features().contains(&feature)
    }

    /// `https` or `http` depending on the TLS mode.
    pub fn scheme(&self) -> &'static str {
        match self.tls {
            TlsMode::Insecure => "http",
            TlsMode::Site { .. } | TlsMode::SelfSigned => "https",
        }
    }
}
