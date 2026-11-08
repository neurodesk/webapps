//! `sbatch`, `squeue`, `sacct`, `scontrol` and `scancel`, each with a
//! deadline, and the parsing of their answers.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::process::Command;

/// The five commands the runner uses.
pub const COMMANDS: &[&str] = &["sbatch", "squeue", "sacct", "scontrol", "scancel"];

/// How the runner calls Slurm.
#[derive(Debug, Clone)]
pub struct Slurm {
    /// `PATH` for the commands; `None` inherits the server's.
    pub path: Option<OsString>,
    /// Deadline of one call.
    pub timeout: Duration,
    /// The server's user, for `sacct -u`.
    pub user: String,
}

/// The finished output of a command.
pub struct Output {
    /// Exit status was 0.
    pub ok: bool,
    /// Standard output.
    pub stdout: String,
    /// Standard error.
    pub stderr: String,
}

/// A job in `squeue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueEntry {
    /// Job name.
    pub name: String,
    /// State (`PENDING`, `RUNNING`, …).
    pub state: String,
    /// Pending reason (`Priority`), `None` when Slurm reports none.
    pub reason: Option<String>,
}

/// A job's state from accounting or `scontrol`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobState {
    /// First word of the state (`CANCELLED by 1000` → `CANCELLED`).
    pub state: String,
    /// `exit:signal`.
    pub exit: String,
}

impl JobState {
    /// Whether Slurm considers the job finished.
    pub fn is_terminal(&self) -> bool {
        !matches!(
            self.state.as_str(),
            "PENDING"
                | "RUNNING"
                | "REQUEUED"
                | "RESIZING"
                | "SUSPENDED"
                | "CONFIGURING"
                | "COMPLETING"
                | "STAGE_OUT"
                | "SIGNALING"
                | "REQUEUE_HOLD"
                | "REQUEUE_FED"
                | "RESV_DEL_HOLD"
                | "STOPPED"
        )
    }
}

/// Why `sbatch` gave no job id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SbatchError {
    /// Slurm refused the job; it was not submitted.
    Rejected(String),
    /// The answer was lost; the job may or may not exist.
    Unknown(String),
}

/// `sacct -S` and `scontrol` take local time.
pub fn slurm_time(time: DateTime<Utc>) -> String {
    time.with_timezone(&chrono::Local)
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string()
}

impl Slurm {
    /// Runs one command with the deadline.
    pub async fn call(
        &self,
        program: &str,
        args: &[&str],
        env: &[(&str, &str)],
        directory: Option<&Path>,
    ) -> Result<Output, String> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
        for (name, value) in env {
            command.env(name, value);
        }
        if let Some(directory) = directory {
            command.current_dir(directory);
        }
        let output = tokio::time::timeout(self.timeout, command.output())
            .await
            .map_err(|_| format!("{program} timed out after {}s", self.timeout.as_secs()))?
            .map_err(|error| format!("cannot run {program}: {error}"))?;
        Ok(Output {
            ok: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }

    async fn checked(&self, program: &str, args: &[&str]) -> Result<String, String> {
        let output = self.call(program, args, &[], None).await?;
        if output.ok {
            Ok(output.stdout)
        } else {
            Err(format!("{program} failed: {}", output.stderr))
        }
    }

    /// `sbatch --parsable <script>` in the job directory.
    pub async fn sbatch(
        &self,
        script: &Path,
        directory: &Path,
        env: &[(&str, &str)],
    ) -> Result<String, SbatchError> {
        let script = script.display().to_string();
        let output = self
            .call("sbatch", &["--parsable", &script], env, Some(directory))
            .await
            .map_err(SbatchError::Unknown)?;
        if !output.ok {
            return Err(if output.stderr.contains("Batch job submission failed") {
                SbatchError::Rejected(output.stderr)
            } else {
                SbatchError::Unknown(format!("sbatch failed: {}", output.stderr))
            });
        }
        let id = output
            .stdout
            .trim()
            .split(';')
            .next()
            .unwrap_or("")
            .to_string();
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit() || byte == b'_') {
            return Err(SbatchError::Unknown(format!(
                "sbatch answered '{}'",
                output.stdout.trim()
            )));
        }
        Ok(id)
    }

    /// `sbatch --test-only <script>`.
    pub async fn test_only(&self, script: &Path, directory: &Path) -> Result<(), String> {
        let script = script.display().to_string();
        let output = self
            .call("sbatch", &["--test-only", &script], &[], Some(directory))
            .await?;
        if output.ok {
            Ok(())
        } else {
            Err(output.stderr)
        }
    }

    /// One `squeue --me` for every job of the user.
    pub async fn queue(&self) -> Result<HashMap<String, QueueEntry>, String> {
        let stdout = self
            .checked("squeue", &["--me", "--noheader", "--format=%i|%j|%T|%r"])
            .await?;
        let mut jobs = HashMap::new();
        for line in stdout.lines() {
            let mut fields = line.trim().splitn(4, '|');
            let (Some(id), Some(name), Some(state)) = (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            let reason = fields
                .next()
                .map(str::trim)
                .filter(|reason| !reason.is_empty() && *reason != "None")
                .map(str::to_string);
            jobs.insert(
                id.trim().to_string(),
                QueueEntry {
                    name: name.trim().to_string(),
                    state: state.trim().to_string(),
                    reason,
                },
            );
        }
        Ok(jobs)
    }

    /// Ids of the user's queued jobs named `name`.
    pub async fn queued_named(&self, name: &str) -> Result<Vec<String>, String> {
        let stdout = self
            .checked(
                "squeue",
                &["--me", "--noheader", "--name", name, "--format=%i"],
            )
            .await?;
        Ok(ids(&stdout))
    }

    /// Ids of the user's accounted jobs named `name` submitted since `since`.
    pub async fn accounted_named(
        &self,
        name: &str,
        since: DateTime<Utc>,
    ) -> Result<Vec<String>, String> {
        let since = slurm_time(since);
        let stdout = self
            .checked(
                "sacct",
                &[
                    "-u",
                    &self.user,
                    "--name",
                    name,
                    "-S",
                    &since,
                    "-X",
                    "-n",
                    "-P",
                    "--format=JobID",
                ],
            )
            .await?;
        Ok(ids(&stdout))
    }

    /// The allocation record of a job (`sacct -X`), `None` while accounting has none.
    pub async fn accounting(&self, id: &str) -> Result<Option<JobState>, String> {
        let stdout = self
            .checked(
                "sacct",
                &["-X", "-n", "-P", "-j", id, "--format=JobID,State,ExitCode"],
            )
            .await?;
        Ok(stdout.lines().find_map(|line| {
            let mut fields = line.trim().split('|');
            let (Some(job), Some(state), Some(exit)) =
                (fields.next(), fields.next(), fields.next())
            else {
                return None;
            };
            (job == id).then(|| JobState {
                state: first_word(state),
                exit: exit.trim().to_string(),
            })
        }))
    }

    /// `scontrol show job`, `None` when the controller no longer knows the job.
    pub async fn control(&self, id: &str) -> Result<Option<JobState>, String> {
        let output = self
            .call("scontrol", &["show", "job", id], &[], None)
            .await?;
        if !output.ok {
            if output.stderr.contains("Invalid job id") {
                return Ok(None);
            }
            return Err(format!("scontrol failed: {}", output.stderr));
        }
        let field = |key: &str| {
            output
                .stdout
                .split_whitespace()
                .find_map(|word| word.strip_prefix(key))
                .map(str::to_string)
        };
        Ok(field("JobState=").map(|state| JobState {
            state: first_word(&state),
            exit: field("ExitCode=").unwrap_or_else(|| "0:0".into()),
        }))
    }

    /// `scancel <id>`.
    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        self.checked("scancel", &[id]).await.map(|_| ())
    }
}

fn first_word(text: &str) -> String {
    text.split_whitespace().next().unwrap_or("").to_string()
}

fn ids(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_states() {
        let state = |state: &str| JobState {
            state: state.into(),
            exit: "0:0".into(),
        };
        for terminal in [
            "COMPLETED",
            "CANCELLED",
            "FAILED",
            "TIMEOUT",
            "OUT_OF_MEMORY",
            "NODE_FAIL",
            "PREEMPTED",
            "BOOT_FAIL",
            "DEADLINE",
            "REVOKED",
        ] {
            assert!(state(terminal).is_terminal(), "{terminal}");
        }
        for active in [
            "PENDING",
            "RUNNING",
            "COMPLETING",
            "SUSPENDED",
            "CONFIGURING",
        ] {
            assert!(!state(active).is_terminal(), "{active}");
        }
        assert_eq!(first_word("CANCELLED by 1000"), "CANCELLED");
    }
}
