//! Native SCT analysis. Input bytes and native output artifacts are never rewritten.
use super::{
    JobInputs, LogUpdate, OutputSpec, ReceivedPart, SpecError, Tool, ToolPaths, ValidatedJob,
};
use serde_json::{Map, Value};

pub const IMAGE: &str = "vnmd/spinalcordtoolbox_7.3.3@sha256:974f6019415df81465ac03102d27b8a23945155b96a45e7b5f525a3d0d55ab83";
pub const VERSION: &str = "7.3";
pub const COMMANDS: &[&str] = &["process_segmentation", "analyze_lesion"];

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum AnalysisInputs {
    ProcessSegmentation {
        cord: String,
    },
    AnalyzeLesion {
        lesion: String,
        cord: Option<String>,
    },
}

const LOG: OutputSpec = OutputSpec {
    name: "log.txt",
    content_type: "text/plain",
    required: true,
};
const MORPHOMETRY: &[OutputSpec] = &[
    OutputSpec {
        name: "morphometry.csv",
        content_type: "text/csv",
        required: true,
    },
    LOG,
];
const LESION_GZIP: &[OutputSpec] = &[
    OutputSpec {
        name: "lesion_analysis.xlsx",
        content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        required: true,
    },
    OutputSpec {
        name: "lesion_analysis.pkl",
        content_type: "application/octet-stream",
        required: true,
    },
    OutputSpec {
        name: "lesion_label.nii.gz",
        content_type: "application/gzip",
        required: true,
    },
    LOG,
];

const LESION_NIFTI: &[OutputSpec] = &[
    OutputSpec {
        name: "lesion_analysis.xlsx",
        content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        required: true,
    },
    OutputSpec {
        name: "lesion_analysis.pkl",
        content_type: "application/octet-stream",
        required: true,
    },
    OutputSpec {
        name: "lesion_label.nii",
        content_type: "application/octet-stream",
        required: true,
    },
    LOG,
];

#[derive(Debug, Default, Clone, Copy)]
pub struct Sct;

impl Tool for Sct {
    fn id(&self) -> &'static str {
        "sct"
    }
    fn version(&self) -> &'static str {
        VERSION
    }
    fn image<'a>(&self, _configured: &'a str) -> &'a str {
        IMAGE
    }
    fn uses_gpu(&self) -> bool {
        false
    }
    fn commands(&self) -> &'static [&'static str] {
        COMMANDS
    }

    fn validate(&self, spec: &Value, parts: &[ReceivedPart]) -> Result<ValidatedJob, SpecError> {
        let object = spec
            .as_object()
            .ok_or_else(|| SpecError::new("spec must be an object"))?;
        if spec["tool"] != "sct" {
            return Err(SpecError::new("tool must be sct"));
        }
        let command = spec["command"]
            .as_str()
            .filter(|s| COMMANDS.contains(s))
            .ok_or_else(|| SpecError::new("unknown SCT command"))?;
        let allowed: &[&str] = if command == "process_segmentation" {
            &["tool", "command", "cord", "options"]
        } else {
            &["tool", "command", "cord", "lesion", "options"]
        };
        for key in object.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(SpecError::new(format!("unknown field '{key}'")));
            }
        }
        let mut used = Vec::new();
        let mut resolve = |role: &str| -> Result<String, SpecError> {
            if spec[role].as_str() != Some(role) {
                return Err(SpecError::new(format!(
                    "{role} must reference the '{role}' part"
                )));
            }
            let part = parts
                .iter()
                .find(|part| part.name == role)
                .ok_or_else(|| SpecError::new(format!("part '{role}' was not received")))?;
            if !super::nifti::has_nifti1_magic(&part.header) {
                return Err(SpecError::new(format!("{role} is not a NIfTI-1 file")));
            }
            let header = super::nifti::Header::parse(&part.header).map_err(SpecError::new)?;
            if header.voxel_count() > super::nesvor::MAX_VOXELS {
                return Err(SpecError::new("mask exceeds voxel limit"));
            }
            used.push(role.to_string());
            Ok(part.file_name.clone())
        };
        let analysis = if command == "process_segmentation" {
            AnalysisInputs::ProcessSegmentation {
                cord: resolve("cord")?,
            }
        } else {
            let lesion = resolve("lesion")?;
            let cord = if object.contains_key("cord") {
                Some(resolve("cord")?)
            } else {
                None
            };
            AnalysisInputs::AnalyzeLesion { lesion, cord }
        };
        if used.len() != parts.len() {
            return Err(SpecError::new("unused file parts"));
        }
        let options = match object.get("options") {
            None => Map::new(),
            Some(Value::Object(options)) => options.clone(),
            _ => return Err(SpecError::new("options must be an object")),
        };
        for (key, value) in &options {
            let valid = command == "process_segmentation"
                && match key.as_str() {
                    "perSlice" | "angleCorrection" => value.is_boolean(),
                    "slices" => value.as_str().is_some_and(valid_slices),
                    _ => false,
                };
            if !valid {
                return Err(SpecError::new(format!("invalid SCT option '{key}'")));
            }
        }
        Ok(ValidatedJob {
            tool: "sct".into(),
            command: command.into(),
            inputs: JobInputs::Sct { analysis },
            options,
            warnings: vec![],
        })
    }

    fn argv(&self, job: &ValidatedJob, paths: &ToolPaths) -> Vec<String> {
        let JobInputs::Sct { analysis } = &job.inputs else {
            unreachable!("validated SCT inputs")
        };
        let input = |name: &str| ToolPaths::join(&paths.input_dir, name);
        let mut argv = match analysis {
            AnalysisInputs::ProcessSegmentation { cord } => vec![
                "sct_process_segmentation".into(),
                "-i".into(),
                input(cord),
                "-o".into(),
                ToolPaths::join(&paths.output_dir, "morphometry.csv"),
            ],
            AnalysisInputs::AnalyzeLesion { lesion, cord } => {
                let mut args = vec!["sct_analyze_lesion".into(), "-m".into(), input(lesion)];
                if let Some(cord) = cord {
                    args.extend(["-s".into(), input(cord)]);
                }
                args.extend(["-ofolder".into(), paths.output_dir.clone()]);
                args
            }
        };
        for (key, flag) in [
            ("perSlice", "-perslice"),
            ("angleCorrection", "-angle-corr"),
            ("slices", "-z"),
        ] {
            if let Some(value) = job.options.get(key) {
                let text = if let Some(flag) = value.as_bool() {
                    if flag { "1" } else { "0" }.to_string()
                } else {
                    value.as_str().unwrap().to_string()
                };
                argv.extend([flag.into(), text]);
            }
        }
        argv
    }

    fn parse_log_line(&self, _job: &ValidatedJob, line: &str) -> LogUpdate {
        let (level, _) = super::nesvor::split_python_log(line);
        LogUpdate {
            level,
            progress: None,
        }
    }

    fn outputs(&self, job: &ValidatedJob) -> &'static [OutputSpec] {
        match &job.inputs {
            JobInputs::Sct {
                analysis: AnalysisInputs::ProcessSegmentation { .. },
            } => MORPHOMETRY,
            JobInputs::Sct {
                analysis: AnalysisInputs::AnalyzeLesion { lesion, .. },
            } => {
                if lesion.ends_with(".gz") {
                    LESION_GZIP
                } else {
                    LESION_NIFTI
                }
            }
            _ => unreachable!("validated SCT inputs"),
        }
    }
}

fn valid_slices(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 1000
        && text.split(',').all(|range| {
            let values: Option<Vec<u32>> = range
                .split(':')
                .map(|n| {
                    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
                        None
                    } else {
                        n.parse().ok()
                    }
                })
                .collect();
            matches!(values.as_deref(), Some([_]))
                || matches!(values.as_deref(), Some([a, b]) if a <= b)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn part(role: &str, gzipped: bool) -> ReceivedPart {
        let mut header = vec![0; 352];
        header[..4].copy_from_slice(&348i32.to_le_bytes());
        header[40..42].copy_from_slice(&3i16.to_le_bytes());
        for offset in [42, 44, 46] {
            header[offset..offset + 2].copy_from_slice(&4i16.to_le_bytes());
        }
        header[344..348].copy_from_slice(b"n+1\0");
        ReceivedPart {
            name: role.into(),
            path: PathBuf::new(),
            header,
            gzipped,
            bytes: 1000,
            file_name: format!("{role}.nii{}", if gzipped { ".gz" } else { "" }),
        }
    }

    #[test]
    fn morphometry_preserves_mask_and_maps_only_explicit_options() {
        let spec = json!({"tool":"sct","command":"process_segmentation","cord":"cord","options":{"perSlice":true,"angleCorrection":false,"slices":"2:4,8"}});
        let job = Sct.validate(&spec, &[part("cord", false)]).unwrap();
        assert_eq!(Sct.argv(&job, &ToolPaths::container()).join(" "), "sct_process_segmentation -i /job/in/cord.nii -o /job/out/morphometry.csv -perslice 1 -angle-corr 0 -z 2:4,8");
        assert_eq!(Sct.outputs(&job)[0].name, "morphometry.csv");
        let mut defaults = spec.clone();
        defaults.as_object_mut().unwrap().remove("options");
        let job = Sct.validate(&defaults, &[part("cord", true)]).unwrap();
        assert_eq!(Sct.argv(&job, &ToolPaths::container()).len(), 5);
    }

    #[test]
    fn lesion_mask_is_independent_and_label_compression_follows_input() {
        for gzipped in [true, false] {
            let spec = json!({"tool":"sct","command":"analyze_lesion","lesion":"lesion"});
            let job = Sct.validate(&spec, &[part("lesion", gzipped)]).unwrap();
            let argv = Sct.argv(&job, &ToolPaths::container());
            assert_eq!(argv.len(), 5);
            assert!(!argv.contains(&"-s".to_string()));
            assert_eq!(
                Sct.outputs(&job)[2].name,
                if gzipped {
                    "lesion_label.nii.gz"
                } else {
                    "lesion_label.nii"
                }
            );
            let with_cord =
                json!({"tool":"sct","command":"analyze_lesion","lesion":"lesion","cord":"cord"});
            let job = Sct
                .validate(&with_cord, &[part("lesion", gzipped), part("cord", true)])
                .unwrap();
            assert!(Sct
                .argv(&job, &ToolPaths::container())
                .join(" ")
                .contains("-s /job/in/cord.nii.gz"));
        }
    }

    #[test]
    fn unknown_options_and_unused_inputs_cannot_change_native_command() {
        for options in [
            json!({"slices":"9:1"}),
            json!({"slices":"0;touch /job/out/bad"}),
            json!({"angleCorrection":1}),
            json!({"command":"bash"}),
        ] {
            let spec = json!({"tool":"sct","command":"process_segmentation","cord":"cord","options":options});
            assert!(Sct.validate(&spec, &[part("cord", true)]).is_err());
        }
        let spec = json!({"tool":"sct","command":"analyze_lesion","lesion":"lesion"});
        assert!(Sct
            .validate(&spec, &[part("lesion", true), part("cord", true)])
            .is_err());
    }

    #[test]
    fn docker_selects_the_pinned_cpu_runtime_without_nesvor_flags() {
        let job = Sct
            .validate(
                &json!({"tool":"sct","command":"process_segmentation","cord":"cord"}),
                &[part("cord", true)],
            )
            .unwrap();
        let request = crate::runner::RunRequest {
            job_id: "sct-test".into(),
            job_dir: PathBuf::from("/job-test"),
            argv: Sct.argv(&job, &ToolPaths::container()),
            job,
            cpu: true,
        };
        let args = crate::runner::docker::docker_args("custom-nesvor-image", &request);
        assert!(args.contains(&IMAGE.to_string()));
        for invalid in ["--gpus", "--device", "custom-nesvor-image"] {
            assert!(!args.contains(&invalid.to_string()));
        }
    }
}
