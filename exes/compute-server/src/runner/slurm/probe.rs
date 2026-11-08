//! `neurodesk-compute check-slurm`: a short job through the same template as
//! every project job. Inside the container it checks that the image runs,
//! every data root is readable, the projects directory and `/tmp` are
//! writable, the allocated GPUs are visible, and that a canary directory named
//! by `APPTAINER_BIND`, `APPTAINER_MOUNT` and `SINGULARITY_BIND` in the
//! submitting environment, and the server's data directory, stay invisible.

use std::path::Path;
use std::time::{Duration, Instant};

use super::checks::slurm;
use super::commands::{JobState, Slurm};
use super::config::script_safe_path;
use super::script::{self, quote, Script, Step};
use super::{check_dir, job_name, SlurmSettings};
use crate::roots::DataRoot;

/// Variables a site module could use to add mounts; the probe sets them.
pub const BIND_VARIABLES: &[&str] = &["APPTAINER_BIND", "APPTAINER_MOUNT", "SINGULARITY_BIND"];

/// The probe's findings.
#[derive(Debug)]
pub struct Report {
    lines: Vec<(bool, String)>,
    /// The probe's directory, kept when a check failed.
    kept: Option<std::path::PathBuf>,
}

impl Report {
    /// Whether every check passed.
    pub fn passed(&self) -> bool {
        !self.lines.is_empty() && self.lines.iter().all(|(ok, _)| *ok)
    }

    /// One line per check.
    pub fn render(&self) -> String {
        let mut text: String = self
            .lines
            .iter()
            .map(|(ok, line)| format!("[{}] {line}\n", if *ok { "pass" } else { "FAIL" }))
            .collect();
        if let Some(kept) = &self.kept {
            text.push_str(&format!(
                "probe output kept in {} (run.out, run.err, job.sbatch)\n",
                kept.display()
            ));
        }
        text
    }
}

/// The checks the probe runs, in report order.
fn expected(roots: &[DataRoot], gpus: u32) -> Vec<String> {
    let mut checks = vec!["image".to_string()];
    checks.extend(roots.iter().map(|root| format!("data-root:{}", root.id)));
    checks.extend(["projects", "tmp", "isolation"].map(String::from));
    if gpus > 0 {
        checks.push("gpus".into());
    }
    checks
}

/// The shell program the probe runs inside the container.
pub fn program(roots: &[DataRoot], canary: &Path, data_dir: &Path, gpus: u32) -> String {
    let mut text = String::from(
        "check() { label=$1; shift; if \"$@\" >/dev/null 2>&1; then echo \"PROBE $label pass\"; else echo \"PROBE $label fail\"; fi; }\n",
    );
    text.push_str("echo 'PROBE image pass'\n");
    for root in roots {
        text.push_str(&format!(
            "check data-root:{} ls {}\n",
            root.id,
            quote(&root.container_path())
        ));
    }
    text.push_str("check projects sh -c 'touch /project/.probe && rm /project/.probe'\n");
    text.push_str("check tmp sh -c 'touch /tmp/.probe && rm /tmp/.probe'\n");
    let hidden = [
        canary.to_path_buf(),
        canary.join("secret"),
        data_dir.join("token"),
    ];
    let tests: Vec<String> = hidden
        .iter()
        .map(|path| format!("[ ! -e {} ]", quote(&path.display().to_string())))
        .collect();
    text.push_str(&format!(
        "check isolation sh -c {}\n",
        quote(&tests.join(" && "))
    ));
    if gpus > 0 {
        text.push_str("n=$(nvidia-smi -L 2>/dev/null | grep -c '^GPU' || true)\n");
        text.push_str(&format!(
            "if [ \"${{n:-0}}\" -ge {gpus} ]; then echo \"PROBE gpus pass $n visible\"; else echo \"PROBE gpus fail ${{n:-0}} of {gpus} visible\"; fi\n"
        ));
    }
    text
}

/// Submits the probe for `profile` and waits up to `timeout` for its report.
pub async fn check(
    settings: &SlurmSettings,
    data_dir: &Path,
    roots: &[DataRoot],
    profile: &str,
    timeout: Duration,
) -> Result<Report, String> {
    let config = &settings.config;
    let profile = config
        .profiles
        .list()
        .iter()
        .find(|candidate| candidate.name == profile)
        .ok_or_else(|| format!("unknown profile '{profile}'"))?;
    script_safe_path(data_dir).map_err(|error| format!("data directory: {error}"))?;
    let id = format!("check-{}", &crate::api::new_job_id()[..12]);
    let name = job_name(&id);
    let project_dir = data_dir.join("projects").join(format!(".{id}"));
    let job_dir = project_dir.join("Check/job001");
    let canary = check_dir(data_dir).join(format!("canary-{id}"));
    let io = |error: std::io::Error| error.to_string();
    std::fs::create_dir_all(&job_dir).map_err(io)?;
    std::fs::create_dir_all(&canary).map_err(io)?;
    std::fs::write(canary.join("secret"), "must stay invisible").map_err(io)?;
    let steps = [Step {
        argv: vec![
            "/bin/sh".into(),
            "-c".into(),
            program(roots, &canary, data_dir, profile.gpus),
        ],
        ranks: None,
    }];
    let text = script::render(&Script {
        name: &name,
        job_dir: &job_dir,
        project_dir: &project_dir,
        roots,
        profile,
        gpu: profile.gpus > 0,
        apptainer: &config.apptainer,
        image: &config.image,
        scratch: &config.scratch,
        steps: &steps,
    });
    let script_path = job_dir.join("job.sbatch");
    std::fs::write(&script_path, text).map_err(io)?;
    let slurm = slurm(settings);
    let canary_text = canary.display().to_string();
    let env: Vec<(&str, &str)> = BIND_VARIABLES
        .iter()
        .map(|name| (*name, canary_text.as_str()))
        .collect();
    let slurm_id = slurm
        .sbatch(&script_path, &job_dir, &env)
        .await
        .map_err(|error| format!("sbatch refused the probe: {error:?}"))?;
    let ended = wait(&slurm, &slurm_id, timeout, settings.timings.poll).await;
    let mut lines = Vec::new();
    match &ended {
        Some(state) => lines.push((
            state.state == "COMPLETED",
            format!(
                "Slurm job {slurm_id} ended {} (exit {})",
                state.state, state.exit
            ),
        )),
        None => {
            let _ = slurm.cancel(&slurm_id).await;
            lines.push((
                false,
                format!(
                    "Slurm job {slurm_id} did not finish within {}s",
                    timeout.as_secs()
                ),
            ));
        }
    }
    let output = std::fs::read_to_string(job_dir.join("run.out")).unwrap_or_default();
    for check in expected(roots, profile.gpus) {
        let result = output.lines().find_map(|line| {
            let rest = line.strip_prefix("PROBE ")?;
            let (label, verdict) = rest.split_once(' ')?;
            (label == check).then(|| verdict.to_string())
        });
        lines.push(match result {
            Some(verdict) => (verdict.starts_with("pass"), format!("{check}: {verdict}")),
            None => (false, format!("{check}: no result")),
        });
    }
    let mut report = Report { lines, kept: None };
    let _ = std::fs::remove_dir_all(&canary);
    if report.passed() {
        let _ = std::fs::remove_dir_all(&project_dir);
    } else {
        report.kept = Some(job_dir);
    }
    Ok(report)
}

/// Polls until Slurm reports a terminal state, or `None` at the deadline.
async fn wait(slurm: &Slurm, id: &str, timeout: Duration, poll: Duration) -> Option<JobState> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let queued = slurm
            .queue()
            .await
            .map(|queue| queue.contains_key(id))
            .unwrap_or(true);
        if !queued {
            let known = match slurm.accounting(id).await {
                Ok(Some(state)) => Some(state),
                _ => slurm.control(id).await.ok().flatten(),
            };
            if let Some(state) = known.filter(JobState::is_terminal) {
                return Some(state);
            }
        }
        tokio::time::sleep(poll).await;
    }
    None
}
