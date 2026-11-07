//! A project tool for tests of the generic project machinery.
//!
//! `import` reads a data reference and writes `out.star`; `process` reads an
//! earlier job's file and an optional uploaded `mask` part. `options` steer
//! the simulated run: `fail`, `skipOutput`, `bigBytes`, `ranks`, `needGpus`,
//! `followUp`.

use std::io;

use serde_json::{Map, Value};

use super::project::{
    LaunchPlan, ProjectArgs, ProjectCommand, ProjectInputs, ProjectTool, SimulatedRun,
};
use super::{JobInputs, Layout, LogLevel, LogUpdate, ReceivedPart, SpecError, Tool, ValidatedJob};
use crate::profiles::Profile;

/// The fake tool.
pub struct FakeRelion;

/// Tool id.
pub const ID: &str = "fake-relion";

fn options(job: &ProjectInputs) -> &Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    job.settings
        .as_object()
        .unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

impl Tool for FakeRelion {
    fn id(&self) -> &'static str {
        ID
    }

    fn version(&self) -> &'static str {
        "0"
    }

    fn uses_gpu(&self) -> bool {
        false
    }

    fn commands(&self) -> &'static [&'static str] {
        &["import", "process"]
    }

    fn validate(&self, spec: &Value, parts: &[ReceivedPart]) -> Result<ValidatedJob, SpecError> {
        let command = spec["command"]
            .as_str()
            .filter(|command| self.commands().contains(command))
            .ok_or_else(|| SpecError::new("unknown command"))?;
        let project = spec["project"]
            .as_str()
            .ok_or_else(|| SpecError::new("project must be a string"))?;
        let data = match spec.get("data") {
            Some(value) => vec![serde_json::from_value(value.clone())
                .map_err(|error| SpecError::new(error.to_string()))?],
            None => Vec::new(),
        };
        let inputs: Vec<String> = spec["inputs"]
            .as_object()
            .map(|inputs| {
                inputs
                    .values()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let wanted: Vec<String> = spec["parts"]
            .as_array()
            .map(|names| {
                names
                    .iter()
                    .filter_map(|name| name.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        for name in &wanted {
            if !parts.iter().any(|part| &part.name == name) {
                return Err(SpecError::new(format!("part '{name}' was not received")));
            }
        }
        if parts.len() != wanted.len() {
            return Err(SpecError::new("unused file parts"));
        }
        if command == "import" && data.is_empty() {
            return Err(SpecError::new("import needs data"));
        }
        let job_type = if command == "import" {
            "Import"
        } else {
            "Process"
        };
        Ok(ValidatedJob {
            tool: ID.into(),
            command: command.into(),
            inputs: JobInputs::Project {
                project: ProjectInputs {
                    project: project.into(),
                    job_type: job_type.into(),
                    profile: spec["profile"].as_str().map(str::to_string),
                    inputs,
                    data,
                    parts: wanted,
                    settings: spec.get("options").cloned().unwrap_or(Value::Null),
                },
            },
            options: Map::new(),
            warnings: Vec::new(),
        })
    }

    fn parse_log_line(&self, _job: &ValidatedJob, line: &str) -> LogUpdate {
        let level = if line.contains("ERROR") {
            LogLevel::Error
        } else {
            LogLevel::Info
        };
        let progress = line
            .strip_prefix("progress ")
            .and_then(|value| value.trim().parse::<f64>().ok())
            .map(|fraction| (fraction, "Fake".to_string()));
        LogUpdate { level, progress }
    }

    fn layout(&self) -> Layout<'_> {
        Layout::Project(self)
    }
}

impl ProjectTool for FakeRelion {
    fn launch(&self, job: &ProjectInputs, profile: &Profile) -> Result<LaunchPlan, String> {
        let options = options(job);
        let need = options.get("needGpus").and_then(Value::as_u64).unwrap_or(0) as u32;
        if need > profile.gpus {
            return Err(format!(
                "profile '{}' has fewer than {need} GPUs",
                profile.name
            ));
        }
        Ok(LaunchPlan {
            ranks: options
                .get("ranks")
                .and_then(Value::as_u64)
                .map(|ranks| ranks as u32),
            threads: profile.cpus,
            gpus: profile.gpus,
        })
    }

    fn command(&self, job: &ProjectInputs, args: &ProjectArgs<'_>) -> ProjectCommand {
        let mut main = vec![
            "fake_relion".to_string(),
            "--o".to_string(),
            format!("{}/", args.directory),
            "--j".to_string(),
            args.launch.threads.to_string(),
        ];
        for input in &job.inputs {
            main.extend(["--i".to_string(), input.clone()]);
        }
        for reference in &job.data {
            let directory = reference.directory.clone().unwrap_or_default();
            let pattern = reference.pattern.clone().unwrap_or_default();
            main.extend(["--movies".to_string(), format!("{directory}/{pattern}")]);
        }
        let steps = options(job)
            .get("followUp")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let follow_up = (1..=steps)
            .map(|step| {
                vec![
                    "touch".to_string(),
                    format!("{}/step {step}", args.directory),
                ]
            })
            .collect();
        ProjectCommand { main, follow_up }
    }

    fn required_outputs(&self, _job: &ProjectInputs) -> Vec<String> {
        vec!["out.star".to_string()]
    }

    fn simulate(&self, job: &ProjectInputs, run: &SimulatedRun<'_>) -> io::Result<i32> {
        let options = options(job);
        let flag = |key: &str| options.get(key).and_then(Value::as_bool).unwrap_or(false);
        let dir = run.project_dir.join(run.directory);
        (run.log)("progress 0.5".to_string());
        std::fs::create_dir_all(dir.join("sub"))?;
        std::fs::write(dir.join("sub/inner.txt"), "inner")?;
        std::os::unix::fs::symlink(dir.join("sub/inner.txt"), dir.join("inside-link"))?;
        std::os::unix::fs::symlink("/etc/hostname", dir.join("escape-link"))?;
        if let Some(bytes) = options.get("bigBytes").and_then(Value::as_u64) {
            std::fs::write(dir.join("big.bin"), vec![0u8; bytes as usize])?;
        }
        if flag("fail") {
            (run.log)("ERROR simulated failure".to_string());
            std::fs::write(dir.join("RELION_JOB_EXIT_FAILURE"), "")?;
            return Ok(1);
        }
        if !flag("skipOutput") {
            let mut star = String::from("data_\n");
            for input in &job.inputs {
                star.push_str(&format!("{input}\n"));
            }
            for reference in &job.data {
                for name in &reference.matches {
                    let directory = reference.directory.clone().unwrap_or_default();
                    star.push_str(&format!("{directory}/{name}\n"));
                }
            }
            for part in &job.parts {
                star.push_str(&format!(
                    "{}/{}\n",
                    run.directory,
                    super::project::part_file_name(part)
                ));
            }
            std::fs::write(dir.join("out.star"), star)?;
        }
        std::fs::write(dir.join("RELION_JOB_EXIT_SUCCESS"), "")?;
        Ok(0)
    }
}
