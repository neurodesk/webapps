//! `docker run` runner.

use std::path::Path;

use tokio_util::sync::CancellationToken;

use super::process::{run_process, KillStrategy};
use super::{with_device_flag, LineSink, RunFuture, RunRequest, Runner};
use crate::config::RunnerKind;
use crate::tools::ToolPaths;

/// Runs the tool inside the pinned docker image.
#[derive(Debug, Clone)]
pub struct DockerRunner {
    /// Image reference passed to `docker run`.
    pub image: String,
}

/// Name of the container for a job, so that cancellation can `docker kill` it.
pub fn container_name(job_id: &str) -> String {
    format!("neurodesk-compute-{job_id}")
}

/// Builds the `docker` arguments for a request.
pub fn docker_args(image: &str, request: &RunRequest) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--network".to_string(),
        "none".to_string(),
        "--ipc=host".to_string(),
        "--name".to_string(),
        container_name(&request.job_id),
    ];
    if !request.cpu {
        args.push("--gpus".to_string());
        args.push("all".to_string());
    }
    if let Some(user) = owner_of(&request.job_dir) {
        args.push("--user".to_string());
        args.push(user);
    }
    args.push("-v".to_string());
    args.push(format!("{}:/job", request.job_dir.display()));
    args.push(image.to_string());
    args.extend(with_device_flag(request.argv.clone(), request.cpu));
    args
}

/// `uid:gid` of the directory owner on unix so that files written by the
/// container can be deleted by the server; `None` elsewhere.
fn owner_of(path: &Path) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path).ok()?;
        Some(format!("{}:{}", metadata.uid(), metadata.gid()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

impl Runner for DockerRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Docker
    }

    fn paths(&self, _job_dir: &Path) -> ToolPaths {
        ToolPaths::container()
    }

    fn run(&self, request: RunRequest, sink: LineSink, cancel: CancellationToken) -> RunFuture {
        let args = docker_args(&self.image, &request);
        let kill = KillStrategy::Command(vec![
            "docker".to_string(),
            "kill".to_string(),
            container_name(&request.job_id),
        ]);
        Box::pin(async move { run_process("docker", &args, sink, cancel, kill).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn builds_the_documented_shape() {
        let request = RunRequest {
            job_id: "abc".to_string(),
            job_dir: PathBuf::from("/data/jobs/abc"),
            argv: vec!["nesvor".to_string(), "reconstruct".to_string()],
            job: crate::tools::ValidatedJob {
                tool: "nesvor".to_string(),
                command: "reconstruct".to_string(),
                stacks: Vec::new(),
                options: serde_json::Map::new(),
                warnings: Vec::new(),
            },
            cpu: false,
        };
        let args = docker_args("img", &request);
        let joined = args.join(" ");
        assert!(joined.starts_with(
            "run --rm --network none --ipc=host --name neurodesk-compute-abc --gpus all"
        ));
        assert!(joined.ends_with("-v /data/jobs/abc:/job img nesvor reconstruct"));

        let cpu_request = RunRequest {
            cpu: true,
            ..request
        };
        let cpu_args = docker_args("img", &cpu_request).join(" ");
        assert!(!cpu_args.contains("--gpus"));
        assert!(cpu_args.ends_with("nesvor reconstruct --device -1"));
    }
}
