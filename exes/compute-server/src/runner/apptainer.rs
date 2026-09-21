//! `apptainer exec` runner.

use std::path::{Path, PathBuf};

use tokio_util::sync::CancellationToken;

use super::process::{run_process, KillStrategy};
use super::{with_device_flag, LineSink, RunFuture, RunRequest, Runner};
use crate::config::RunnerKind;
use crate::tools::ToolPaths;

/// Runs the tool inside a `.simg` image with apptainer.
#[derive(Debug, Clone)]
pub struct ApptainerRunner {
    /// Path to the image.
    pub image: PathBuf,
}

/// Builds the `apptainer` arguments for a request.
pub fn apptainer_args(image: &Path, request: &RunRequest) -> Vec<String> {
    let mut args = vec!["exec".to_string(), "--containall".to_string()];
    if !request.cpu {
        args.push("--nv".to_string());
    }
    args.push("-B".to_string());
    args.push(format!("{}:/job", request.job_dir.display()));
    args.push(image.display().to_string());
    args.extend(with_device_flag(request.argv.clone(), request.cpu));
    args
}

impl Runner for ApptainerRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Apptainer
    }

    fn paths(&self, _job_dir: &Path) -> ToolPaths {
        ToolPaths::container()
    }

    fn run(&self, request: RunRequest, sink: LineSink, cancel: CancellationToken) -> RunFuture {
        let args = apptainer_args(&self.image, &request);
        Box::pin(async move {
            run_process("apptainer", &args, sink, cancel, KillStrategy::KillChild).await
        })
    }
}
