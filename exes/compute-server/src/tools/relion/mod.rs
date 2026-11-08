//! The `relion` project tool (ADR-0004): RELION 5.1.1 jobs in a project,
//! interpreted from `packages/cryo-em/src/commands.json` exactly as
//! `packages/cryo-em/src/spec.js` interprets it for the app and the Node
//! reference server. Offered only in single-owner mode, on the Slurm runner or
//! the simulator.

pub mod definition;
pub mod simulate;
pub mod spec;
pub mod star;

use std::io;

use serde_json::Value;

use super::project::{
    DataReference, LaunchPlan, ProjectArgs, ProjectCommand, ProjectInputs, ProjectTool,
    SimulatedEnd, SimulatedRun,
};
use super::{JobInputs, Layout, LogUpdate, ReceivedPart, SpecError, Tool, ValidatedJob};
use crate::profiles::{Profile, Profiles};
use spec::{InputValue, Validated};

/// Tool id.
pub const ID: &str = "relion";

/// The Neurodesk RELION image, reported as `info.tools[].image` only: the
/// Slurm runner runs the SIF named in `--slurm-config`. Pin it by digest once
/// neurocontainers publishes the multi-arch rebuild (branch
/// `feat/relion-5.1.1`); the digest changes with that release. The Node
/// reference server reports the same reference (`RELION_IMAGE`).
pub const IMAGE: &str = "vnmd/relion_5.1.1";

/// The simulator's warning line; the tool logs it at level `warning`.
pub const SIMULATED_WARNING: &str =
    "SIMULATED relion: no RELION program runs and every output is a placeholder";

/// What marks the simulator's warning line.
pub const SIMULATED_WARNING_PREFIX: &str = "SIMULATED relion:";

/// The tool.
pub struct Relion;

fn validated(job: &ProjectInputs) -> Result<Validated, String> {
    serde_json::from_value(job.settings.clone())
        .map_err(|error| format!("the job's relion settings are unreadable: {error}"))
}

fn to_launch(launch: spec::Launch) -> LaunchPlan {
    LaunchPlan {
        ranks: (launch.mpi_ranks > 1).then_some(launch.mpi_ranks),
        threads: launch.threads,
        gpus: launch.gpus,
    }
}

impl Tool for Relion {
    fn id(&self) -> &'static str {
        ID
    }

    fn version(&self) -> &'static str {
        &definition::definition().version
    }

    fn pinned_image(&self) -> Option<&'static str> {
        Some(IMAGE)
    }

    fn uses_gpu(&self) -> bool {
        false
    }

    fn commands(&self) -> &'static [&'static str] {
        spec::relion_commands()
    }

    fn validate(&self, spec: &Value, parts: &[ReceivedPart]) -> Result<ValidatedJob, SpecError> {
        let names: Vec<&str> = parts.iter().map(|part| part.name.as_str()).collect();
        let validated = spec::validate_relion_spec(spec, &names, None).map_err(SpecError::new)?;
        let mut inputs = Vec::new();
        let mut data = Vec::new();
        let mut used_parts = Vec::new();
        for (_, value) in validated.ordered_inputs() {
            match value {
                InputValue::Path(path) => inputs.push(path.clone()),
                InputValue::Part { part } => used_parts.push(part.clone()),
                InputValue::DataRoot {
                    root,
                    path,
                    pattern,
                } => data.push(DataReference {
                    root: root.clone(),
                    path: path.clone(),
                    pattern: Some(pattern.clone()),
                    directory: None,
                    matches: Vec::new(),
                }),
                InputValue::DataFile { root, path } => data.push(DataReference {
                    root: root.clone(),
                    path: path.clone(),
                    pattern: None,
                    directory: None,
                    matches: Vec::new(),
                }),
            }
        }
        let settings =
            serde_json::to_value(&validated).map_err(|error| SpecError::new(error.to_string()))?;
        Ok(ValidatedJob {
            tool: ID.into(),
            command: validated.command.clone(),
            inputs: JobInputs::Project {
                project: ProjectInputs {
                    project: validated.project.clone(),
                    job_type: validated.entry().job_type.clone(),
                    profile: validated.profile.clone(),
                    inputs,
                    data,
                    parts: used_parts,
                    settings,
                },
            },
            options: validated.options.clone(),
            warnings: Vec::new(),
        })
    }

    fn parse_log_line(&self, job: &ValidatedJob, line: &str) -> LogUpdate {
        let (_, progress) = spec::parse_relion_log_line(&job.command, line);
        LogUpdate {
            level: simulate::level(line),
            progress,
        }
    }

    fn layout(&self) -> Layout<'_> {
        Layout::Project(self)
    }
}

impl ProjectTool for Relion {
    fn launch(&self, job: &ProjectInputs, profile: &Profile) -> Result<LaunchPlan, String> {
        let validated = validated(job)?;
        spec::relion_launch(&validated.command, profile.cpus, profile.gpus).map(to_launch)
    }

    fn command(
        &self,
        job: &ProjectInputs,
        args: &ProjectArgs<'_>,
    ) -> Result<ProjectCommand, String> {
        let validated = validated(job)?;
        let command = spec::relion_command(
            &validated,
            args.directory,
            args.profile.cpus,
            args.profile.gpus,
        )?;
        let mut main = vec![command.program];
        main.extend(command.args);
        Ok(ProjectCommand {
            main,
            follow_up: command
                .then
                .into_iter()
                .map(|step| {
                    let mut argv = vec![step.program];
                    argv.extend(step.args);
                    argv
                })
                .collect(),
        })
    }

    fn required_outputs(&self, job: &ProjectInputs) -> Vec<String> {
        validated(job)
            .and_then(|validated| spec::relion_outputs(&validated))
            .map(|outputs| {
                outputs
                    .into_iter()
                    .filter(|(_, required)| *required)
                    .map(|(path, _)| path)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn simulate(&self, job: &ProjectInputs, run: &SimulatedRun<'_>) -> io::Result<SimulatedEnd> {
        let validated = validated(job).map_err(io::Error::other)?;
        simulate::run(&validated, run)
    }

    fn check_profiles(&self, profiles: &Profiles) -> Result<(), String> {
        // The app's "Server default" sends no profile, so every command needs one.
        for command in spec::relion_commands() {
            let profile = profiles.resolve(command, None).map_err(|_| {
                format!("{command} has no default profile; add it to \"defaults\" in the Slurm configuration")
            })?;
            spec::relion_launch(command, profile.cpus, profile.gpus).map_err(|error| {
                format!(
                    "the default profile '{}' of {command} cannot run it: {error}",
                    profile.name
                )
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn profiles(cpus: u32, gpus: u32) -> Profiles {
        let profile: Profile =
            serde_json::from_value(serde_json::json!({ "cpus": cpus, "gpus": gpus })).unwrap();
        let map = BTreeMap::from([("gpu".to_string(), profile)]);
        let defaults = BTreeMap::from([("refine3d".to_string(), "gpu".to_string())]);
        Profiles::new(map, defaults).unwrap()
    }

    #[test]
    fn refuses_a_command_without_a_default_among_several_profiles() {
        let profile = |cpus: u32| -> Profile {
            serde_json::from_value(serde_json::json!({ "cpus": cpus, "gpus": 0 })).unwrap()
        };
        let map = BTreeMap::from([("a".to_string(), profile(8)), ("b".to_string(), profile(8))]);
        let mut defaults: BTreeMap<String, String> = spec::relion_commands()
            .iter()
            .map(|command| (command.to_string(), "a".to_string()))
            .collect();
        assert!(Relion
            .check_profiles(&Profiles::new(map.clone(), defaults.clone()).unwrap())
            .is_ok());
        defaults.remove("import");
        let error = Relion
            .check_profiles(&Profiles::new(map, defaults).unwrap())
            .unwrap_err();
        assert!(error.contains("import has no default profile"), "{error}");
    }

    #[test]
    fn refuses_a_default_profile_that_cannot_run_refine3d() {
        let error = Relion.check_profiles(&profiles(4, 4)).unwrap_err();
        assert!(error.contains("refine3d needs 5 MPI ranks"), "{error}");
        assert!(Relion.check_profiles(&profiles(24, 4)).is_ok());
    }

    #[test]
    fn info_reports_the_table() {
        assert_eq!(Relion.version(), "5.1.1");
        assert_eq!(Relion.commands()[0], "import");
        assert!(Relion
            .pinned_image()
            .unwrap()
            .starts_with("vnmd/relion_5.1.1"));
    }
}
