//! Runner for a `nesvor` binary on `PATH`.

use std::path::Path;

use tokio_util::sync::CancellationToken;

use super::process::{run_process, KillStrategy};
use super::{with_device_flag, LineSink, RunFuture, RunRequest, Runner};
use crate::config::RunnerKind;
use crate::tools::ToolPaths;

/// Runs the tool directly on the host.
#[derive(Debug, Clone, Copy, Default)]
pub struct NativeRunner;

impl Runner for NativeRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Native
    }

    fn paths(&self, job_dir: &Path) -> ToolPaths {
        ToolPaths {
            input_dir: job_dir.join("in").display().to_string(),
            output_dir: job_dir.join("out").display().to_string(),
        }
    }

    fn run(&self, request: RunRequest, sink: LineSink, cancel: CancellationToken) -> RunFuture {
        let argv = with_device_flag(request.argv, request.cpu);
        Box::pin(async move {
            let Some((program, args)) = argv.split_first() else {
                return Err(std::io::Error::other("empty argv"));
            };
            run_process(program, args, sink, cancel, KillStrategy::KillChild).await
        })
    }
}
