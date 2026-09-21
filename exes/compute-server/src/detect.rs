//! Detection of runners, GPUs and images on the host.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::config::{GpuInfo, RunnerKind};

/// Result of running a probe command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    /// Whether the command exited with status 0.
    pub ok: bool,
    /// Captured stdout (and stderr on failure).
    pub output: String,
}

/// Finds `name` on `PATH` (also `name.exe` on Windows).
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let candidates: Vec<String> = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path) {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

/// Runs `program args…` with a timeout and captures its output.
pub async fn probe(program: &str, args: &[&str], timeout: Duration) -> Probe {
    let command = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(timeout, command).await {
        Ok(Ok(output)) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            if !output.status.success() {
                text.push_str(&String::from_utf8_lossy(&output.stderr));
            }
            Probe {
                ok: output.status.success(),
                output: text.trim().to_string(),
            }
        }
        Ok(Err(error)) => Probe {
            ok: false,
            output: error.to_string(),
        },
        Err(_) => Probe {
            ok: false,
            output: format!("{program} timed out after {}s", timeout.as_secs()),
        },
    }
}

/// Queries the host's `nvidia-smi` for the first GPU name.
pub async fn host_gpu() -> GpuInfo {
    if which("nvidia-smi").is_none() {
        return GpuInfo::default();
    }
    let result = probe(
        "nvidia-smi",
        &["--query-gpu=name", "--format=csv,noheader"],
        Duration::from_secs(10),
    )
    .await;
    if !result.ok {
        return GpuInfo::default();
    }
    let name = result
        .output
        .lines()
        .next()
        .map(|line| line.trim().to_string());
    GpuInfo {
        available: true,
        name: name.filter(|name| !name.is_empty()),
    }
}

/// Whether `docker info` succeeds.
pub async fn docker_info() -> Probe {
    probe("docker", &["info"], Duration::from_secs(20)).await
}

/// Whether the docker daemon lists an `nvidia` runtime.
pub fn docker_has_nvidia_runtime(info_output: &str) -> bool {
    info_output
        .lines()
        .any(|line| line.trim_start().starts_with("Runtimes:") && line.contains("nvidia"))
}

/// Whether a docker image is present locally.
pub async fn docker_image_present(image: &str) -> bool {
    probe(
        "docker",
        &["image", "inspect", image],
        Duration::from_secs(20),
    )
    .await
    .ok
}

/// Auto-detects a runner in the order docker, apptainer, native.
pub async fn auto_detect() -> Option<RunnerKind> {
    if which("docker").is_some() && docker_info().await.ok {
        return Some(RunnerKind::Docker);
    }
    if which("apptainer").is_some() || which("singularity").is_some() {
        return Some(RunnerKind::Apptainer);
    }
    if which("nesvor").is_some() {
        return Some(RunnerKind::Native);
    }
    None
}

/// Whether the apptainer image exists.
pub fn simg_present(path: &Path) -> bool {
    path.is_file()
}

/// Local IPv4 addresses of this host, loopback first.
pub fn local_ipv4_addresses() -> Vec<std::net::Ipv4Addr> {
    let mut addresses = vec![std::net::Ipv4Addr::LOCALHOST];
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            if let std::net::IpAddr::V4(ip) = interface.ip() {
                if !ip.is_loopback() && !addresses.contains(&ip) {
                    addresses.push(ip);
                }
            }
        }
    }
    addresses
}

/// The host name, when the OS reports one.
pub fn hostname() -> Option<String> {
    if let Ok(name) = std::env::var("HOSTNAME") {
        if !name.is_empty() {
            return Some(name);
        }
    }
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        if !name.is_empty() {
            return Some(name);
        }
    }
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvidia_runtime_detection() {
        assert!(docker_has_nvidia_runtime(
            " Runtimes: io.containerd.runc.v2 nvidia runc\n"
        ));
        assert!(!docker_has_nvidia_runtime(
            " Runtimes: io.containerd.runc.v2 runc\n"
        ));
    }
}
