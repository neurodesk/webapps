//! Project tools: jobs that run in a project directory as `<Type>/jobNNN/`,
//! read earlier jobs' files by project-relative paths and data roots at
//! `/data/<root>`.
//!
//! A project tool's `validate` returns [`ProjectInputs`]. The server resolves
//! its data references and profile, records its dependencies and stores its
//! uploaded parts; the tool supplies only what is specific to it.

use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::profiles::Profile;

/// The validated inputs of a project tool's job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInputs {
    /// Project id.
    pub project: String,
    /// Job type directory (`Class2D`), `^[A-Za-z][A-Za-z0-9]*$`.
    pub job_type: String,
    /// Requested profile; the server replaces it by the resolved name.
    #[serde(default)]
    pub profile: Option<String>,
    /// Project-relative files of earlier jobs (`Extract/job007/particles.star`).
    #[serde(default)]
    pub inputs: Vec<String>,
    /// Files in data roots.
    #[serde(default)]
    pub data: Vec<DataReference>,
    /// Uploaded parts, stored in the job directory as `<part>.mrc`.
    #[serde(default)]
    pub parts: Vec<String>,
    /// Tool-specific validated settings.
    #[serde(default)]
    pub settings: Value,
}

/// `{ "root": "facility", "path": "2026-11/grid3", "pattern": "*.tiff" }`, or
/// one file, `{ "root": "facility", "path": "2026-11/gain.mrc" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataReference {
    /// Data root id.
    pub root: String,
    /// Directory relative to the root, or the file when there is no pattern.
    pub path: String,
    /// File-name pattern within that directory.
    #[serde(default)]
    pub pattern: Option<String>,
    /// Canonical directory of the matches as the job sees it
    /// (`/data/facility/2026-11/grid3`), filled in by the server.
    #[serde(default)]
    pub directory: Option<String>,
    /// Matching file names, filled in by the server.
    #[serde(default)]
    pub matches: Vec<String>,
}

/// How a job is launched on its allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchPlan {
    /// MPI ranks under `mpirun --bind-to none -np <ranks>`; `None` runs one process.
    pub ranks: Option<u32>,
    /// Threads per process.
    pub threads: u32,
    /// GPUs the job uses; more than 0 passes the host's GPUs to the container.
    pub gpus: u32,
}

/// The commands of one job, all run in `/project` inside the container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectCommand {
    /// The main program, launched under MPI when the plan has ranks.
    pub main: Vec<String>,
    /// Further commands run in order after the main program succeeds,
    /// stopping at the first failure.
    pub follow_up: Vec<Vec<String>>,
}

/// What a tool's command line depends on besides its inputs.
pub struct ProjectArgs<'a> {
    /// The job directory, `<Type>/jobNNN`.
    pub directory: &'a str,
    /// The resolved profile.
    pub profile: &'a Profile,
    /// The launch plan the tool chose for that profile.
    pub launch: LaunchPlan,
}

/// The directories and log of a simulated run.
pub struct SimulatedRun<'a> {
    /// Host path of the project, which jobs see as `/project`.
    pub project_dir: &'a Path,
    /// The job directory, `<Type>/jobNNN`.
    pub directory: &'a str,
    /// Forwards one log line.
    pub log: &'a (dyn Fn(String) + Sync),
}

/// What a project tool supplies to the generic machinery.
pub trait ProjectTool: Send + Sync {
    /// Ranks, threads and GPUs for a job on a profile; an error refuses the
    /// profile for this job (`invalid-spec`).
    fn launch(&self, job: &ProjectInputs, profile: &Profile) -> Result<LaunchPlan, String>;
    /// The commands inside the container, without the MPI launcher. The
    /// working directory is the project, `/project`.
    fn command(&self, job: &ProjectInputs, args: &ProjectArgs<'_>) -> ProjectCommand;
    /// Files, relative to the job directory, that a succeeded job must have written.
    fn required_outputs(&self, job: &ProjectInputs) -> Vec<String>;
    /// Writes placeholder results for `--runner simulate`; returns the exit status.
    fn simulate(&self, job: &ProjectInputs, run: &SimulatedRun<'_>) -> io::Result<i32>;
    /// Refuses a configuration whose profiles cannot run the tool's commands;
    /// checked at startup.
    fn check_profiles(&self, profiles: &crate::profiles::Profiles) -> Result<(), String> {
        let _ = profiles;
        Ok(())
    }
}

/// File name of an uploaded part inside the job directory.
pub fn part_file_name(part: &str) -> String {
    format!("{part}.mrc")
}

/// Whether `job_type` is a valid job type directory name.
pub fn valid_job_type(job_type: &str) -> bool {
    let mut bytes = job_type.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric())
        && job_type.len() <= 32
}

/// `Class2D/job006`: the number is zero padded to three digits.
pub fn job_directory(job_type: &str, number: u32) -> String {
    format!("{job_type}/job{number:03}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directories() {
        assert_eq!(job_directory("Class2D", 6), "Class2D/job006");
        assert_eq!(job_directory("Import", 1234), "Import/job1234");
        assert!(valid_job_type("MotionCorr"));
        assert!(!valid_job_type("Motion/Corr"));
        assert!(!valid_job_type("2D"));
        assert!(!valid_job_type(""));
    }
}
