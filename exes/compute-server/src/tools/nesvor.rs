//! The `nesvor` tool: spec validation, `argv` mapping and progress mapping as
//! specified in `docs/architecture/remote-compute-protocol.md`.

use serde_json::{Map, Value};

use super::nifti;
use super::{
    LogLevel, LogUpdate, OutputSpec, ReceivedPart, SpecError, StackInput, Tool, ToolPaths,
    ValidatedJob,
};

/// Maximum number of stacks per job.
pub const MAX_STACKS: usize = 20;

/// Maximum voxels per input file (a 512³ volume).
pub const MAX_VOXELS: u64 = 512 * 512 * 512;

/// Default `--n-iter` of NeSVoR, used for progress when the spec omits it.
pub const DEFAULT_ITERATIONS: u64 = 6000;

/// Accepted values of `options.registration`.
pub const REGISTRATIONS: &[&str] = &["svort", "svort-only", "svort-stack", "stack", "none"];

/// Outputs of `nesvor reconstruct`.
pub const OUTPUTS: &[OutputSpec] = &[
    OutputSpec {
        name: "volume.nii.gz",
        content_type: "application/gzip",
        required: true,
    },
    OutputSpec {
        name: "result.json",
        content_type: "application/json",
        required: false,
    },
    OutputSpec {
        name: "log.txt",
        content_type: "text/plain",
        required: true,
    },
];

/// Progress table: (needle, stage, fraction).
const STAGES: &[(&str, &str, f64)] = &[
    ("Data loading starts", "Loading stacks", 0.02),
    ("Segmentation starts", "Brain masking", 0.08),
    (
        "Bias Field Correction starts",
        "Bias field correction",
        0.15,
    ),
    ("Assessment starts", "Stack assessment", 0.20),
    ("Registration starts", "Motion correction", 0.25),
    ("Reconsturction starts", "Reconstruction", 0.40),
    ("Reconstruction starts", "Reconstruction", 0.40),
    ("NeSVoR training starts.", "Reconstruction", 0.40),
    ("Results saving starts", "Sampling volume", 0.92),
    ("finished, overall time", "Finished", 1.00),
];

/// The nesvor tool definition.
#[derive(Debug, Default, Clone, Copy)]
pub struct Nesvor;

/// What kind of value an option takes.
#[derive(Clone, Copy)]
enum OptionKind {
    Number { min: f64, max: f64 },
    Integer { min: i64, max: i64 },
    Bool,
    Choice(&'static [&'static str]),
}

/// Option name, kind and the command-line flag it maps to, in `argv` order.
const OPTIONS: &[(&str, OptionKind, &str)] = &[
    (
        "outputResolution",
        OptionKind::Number { min: 0.3, max: 3.0 },
        "--output-resolution",
    ),
    (
        "registration",
        OptionKind::Choice(REGISTRATIONS),
        "--registration",
    ),
    ("segmentation", OptionKind::Bool, "--segmentation"),
    (
        "biasFieldCorrection",
        OptionKind::Bool,
        "--bias-field-correction",
    ),
    ("otsuThresholding", OptionKind::Bool, "--otsu-thresholding"),
    (
        "stacksIntersection",
        OptionKind::Bool,
        "--stacks-intersection",
    ),
    ("deformable", OptionKind::Bool, "--deformable"),
    (
        "iterations",
        OptionKind::Integer {
            min: 100,
            max: 20000,
        },
        "--n-iter",
    ),
    ("singlePrecision", OptionKind::Bool, "--single-precision"),
    (
        "weightTransformation",
        OptionKind::Number {
            min: 0.0,
            max: 100.0,
        },
        "--weight-transformation",
    ),
    (
        "weightDeform",
        OptionKind::Number {
            min: 0.0,
            max: 100.0,
        },
        "--weight-deform",
    ),
    (
        "weightImage",
        OptionKind::Number {
            min: 0.0,
            max: 100.0,
        },
        "--weight-image",
    ),
    (
        "batchSize",
        OptionKind::Integer {
            min: 256,
            max: 32768,
        },
        "--batch-size",
    ),
    (
        "log2HashmapSize",
        OptionKind::Integer { min: 15, max: 24 },
        "--log2-hashmap-size",
    ),
];

impl Tool for Nesvor {
    fn id(&self) -> &'static str {
        "nesvor"
    }

    fn version(&self) -> &'static str {
        "0.5.0"
    }

    fn commands(&self) -> &'static [&'static str] {
        &["reconstruct"]
    }

    fn validate(&self, spec: &Value, parts: &[ReceivedPart]) -> Result<ValidatedJob, SpecError> {
        let object = spec
            .as_object()
            .ok_or_else(|| SpecError::new("spec must be a JSON object"))?;
        let tool = string_field(object, "tool")?;
        if tool != self.id() {
            return Err(SpecError::new(format!("unknown tool '{tool}'")));
        }
        let command = string_field(object, "command")?;
        if !self.commands().contains(&command) {
            return Err(SpecError::new(format!("unknown command '{command}'")));
        }

        let stacks_value = object
            .get("stacks")
            .and_then(Value::as_array)
            .ok_or_else(|| SpecError::new("'stacks' must be an array"))?;
        if stacks_value.is_empty() || stacks_value.len() > MAX_STACKS {
            return Err(SpecError::new(format!(
                "'stacks' must have 1 to {MAX_STACKS} entries"
            )));
        }

        let mut used_parts: Vec<&str> = Vec::new();
        let mut stacks = Vec::with_capacity(stacks_value.len());
        for (index, entry) in stacks_value.iter().enumerate() {
            let stack = entry
                .as_object()
                .ok_or_else(|| SpecError::new(format!("stacks[{index}] must be an object")))?;
            let file = string_field(stack, "file")
                .map_err(|error| SpecError::new(format!("stacks[{index}]: {error}")))?;
            let file_part = reference_part(parts, file, &mut used_parts)
                .map_err(|error| SpecError::new(format!("stacks[{index}].file: {error}")))?;
            let thickness = stack
                .get("thickness")
                .and_then(Value::as_f64)
                .ok_or_else(|| {
                    SpecError::new(format!("stacks[{index}].thickness must be a number"))
                })?;
            if !thickness.is_finite() || thickness <= 0.0 || thickness > 20.0 {
                return Err(SpecError::new(format!(
                    "stacks[{index}].thickness must be in (0, 20]"
                )));
            }
            let mask_part = match stack.get("mask") {
                None | Some(Value::Null) => None,
                Some(Value::String(mask)) => Some(
                    reference_part(parts, mask, &mut used_parts).map_err(|error| {
                        SpecError::new(format!("stacks[{index}].mask: {error}"))
                    })?,
                ),
                Some(_) => {
                    return Err(SpecError::new(format!(
                        "stacks[{index}].mask must be a string"
                    )))
                }
            };
            stacks.push(StackInput {
                file: file.to_string(),
                file_name: file_part.file_name.clone(),
                thickness,
                mask: mask_part.map(|part| part.name.clone()),
                mask_file_name: mask_part.map(|part| part.file_name.clone()),
            });
        }

        let options = match object.get("options") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(options)) => validate_options(options)?,
            Some(_) => return Err(SpecError::new("'options' must be an object")),
        };

        let mut warnings = Vec::new();
        let masks_given = stacks.iter().filter(|stack| stack.mask.is_some()).count();
        if masks_given > 0 && masks_given < stacks.len() {
            warnings.push(format!(
                "masks ignored: {masks_given} of {} stacks have a mask; --stack-masks needs one per stack",
                stacks.len()
            ));
        }

        Ok(ValidatedJob {
            tool: tool.to_string(),
            command: command.to_string(),
            stacks,
            options,
            warnings,
        })
    }

    fn argv(&self, job: &ValidatedJob, paths: &ToolPaths) -> Vec<String> {
        let mut argv = vec!["nesvor".to_string(), job.command.clone()];
        argv.push("--input-stacks".to_string());
        for stack in &job.stacks {
            argv.push(ToolPaths::join(&paths.input_dir, &stack.file_name));
        }
        if job
            .stacks
            .iter()
            .all(|stack| stack.mask_file_name.is_some())
        {
            argv.push("--stack-masks".to_string());
            for stack in &job.stacks {
                if let Some(mask) = &stack.mask_file_name {
                    argv.push(ToolPaths::join(&paths.input_dir, mask));
                }
            }
        }
        argv.push("--thicknesses".to_string());
        for stack in &job.stacks {
            argv.push(format_number(stack.thickness));
        }
        argv.push("--output-volume".to_string());
        argv.push(ToolPaths::join(&paths.output_dir, "volume.nii.gz"));
        argv.push("--output-json".to_string());
        argv.push(ToolPaths::join(&paths.output_dir, "result.json"));
        for (key, kind, flag) in OPTIONS {
            let Some(value) = job.options.get(*key) else {
                continue;
            };
            match kind {
                OptionKind::Bool => {
                    if value.as_bool() == Some(true) {
                        argv.push(flag.to_string());
                    }
                }
                OptionKind::Number { .. } => {
                    if let Some(number) = value.as_f64() {
                        argv.push(flag.to_string());
                        argv.push(format_number(number));
                    }
                }
                OptionKind::Integer { .. } => {
                    if let Some(integer) = integer_value(value) {
                        argv.push(flag.to_string());
                        argv.push(integer.to_string());
                    }
                }
                OptionKind::Choice(_) => {
                    if let Some(choice) = value.as_str() {
                        argv.push(flag.to_string());
                        argv.push(choice.to_string());
                    }
                }
            }
        }
        argv.push("--verbose".to_string());
        argv.push("1".to_string());
        argv
    }

    fn parse_log_line(&self, job: &ValidatedJob, line: &str) -> LogUpdate {
        let (level, message) = split_python_log(line);
        for (needle, stage, fraction) in STAGES {
            if message.contains(needle) {
                return LogUpdate {
                    level,
                    progress: Some((*fraction, stage.to_string())),
                };
            }
        }
        if let Some(iteration) = training_row_iteration(message) {
            let total = job
                .options
                .get("iterations")
                .and_then(integer_value)
                .map(|value| value as u64)
                .unwrap_or(DEFAULT_ITERATIONS)
                .max(1);
            let ratio = (iteration as f64 / total as f64).clamp(0.0, 1.0);
            return LogUpdate {
                level,
                progress: Some((0.40 + 0.50 * ratio, "Reconstruction".to_string())),
            };
        }
        LogUpdate {
            level,
            progress: None,
        }
    }

    fn outputs(&self) -> &'static [OutputSpec] {
        OUTPUTS
    }
}

fn string_field<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, SpecError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| SpecError::new(format!("'{key}' must be a string")))
}

/// Resolves a part reference, ensuring it exists, is a NIfTI-1 file and is
/// referenced only once.
fn reference_part<'a>(
    parts: &'a [ReceivedPart],
    name: &str,
    used: &mut Vec<&'a str>,
) -> Result<&'a ReceivedPart, SpecError> {
    let part = parts
        .iter()
        .find(|part| part.name == name)
        .ok_or_else(|| SpecError::new(format!("part '{name}' was not received")))?;
    if used.contains(&part.name.as_str()) {
        return Err(SpecError::new(format!(
            "part '{name}' is referenced more than once"
        )));
    }
    if !nifti::has_nifti1_magic(&part.header) {
        return Err(SpecError::new(format!(
            "part '{name}' is not a NIfTI-1 file"
        )));
    }
    if let Ok(header) = nifti::Header::parse(&part.header) {
        if header.voxel_count() > MAX_VOXELS {
            return Err(SpecError::new(format!(
                "part '{name}' has more than {MAX_VOXELS} voxels"
            )));
        }
    }
    used.push(part.name.as_str());
    Ok(part)
}

fn validate_options(options: &Map<String, Value>) -> Result<Map<String, Value>, SpecError> {
    let mut normalized = Map::new();
    for (key, value) in options {
        let Some((_, kind, _)) = OPTIONS.iter().find(|(name, _, _)| name == key) else {
            return Err(SpecError::new(format!("unknown option '{key}'")));
        };
        if value.is_null() {
            continue;
        }
        match kind {
            OptionKind::Number { min, max } => {
                let number = value
                    .as_f64()
                    .filter(|number| number.is_finite())
                    .ok_or_else(|| SpecError::new(format!("options.{key} must be a number")))?;
                if number < *min || number > *max {
                    return Err(SpecError::new(format!(
                        "options.{key} must be in [{min}, {max}]"
                    )));
                }
                normalized.insert(key.clone(), Value::from(number));
            }
            OptionKind::Integer { min, max } => {
                let integer = integer_value(value)
                    .ok_or_else(|| SpecError::new(format!("options.{key} must be an integer")))?;
                if integer < *min || integer > *max {
                    return Err(SpecError::new(format!(
                        "options.{key} must be an integer in [{min}, {max}]"
                    )));
                }
                normalized.insert(key.clone(), Value::from(integer));
            }
            OptionKind::Bool => {
                let flag = value
                    .as_bool()
                    .ok_or_else(|| SpecError::new(format!("options.{key} must be a boolean")))?;
                normalized.insert(key.clone(), Value::from(flag));
            }
            OptionKind::Choice(choices) => {
                let choice = value
                    .as_str()
                    .ok_or_else(|| SpecError::new(format!("options.{key} must be a string")))?;
                if !choices.contains(&choice) {
                    return Err(SpecError::new(format!(
                        "options.{key} must be one of {}",
                        choices.join(", ")
                    )));
                }
                normalized.insert(key.clone(), Value::from(choice));
            }
        }
    }
    Ok(normalized)
}

/// Accepts JSON integers and integral floats.
fn integer_value(value: &Value) -> Option<i64> {
    if let Some(integer) = value.as_i64() {
        return Some(integer);
    }
    let number = value.as_f64()?;
    if number.is_finite() && number.fract() == 0.0 {
        Some(number as i64)
    } else {
        None
    }
}

/// Formats a number for the command line: integral values keep one decimal
/// (`3.0`), others use the shortest round-trip form (`0.8`).
pub fn format_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{value:.1}")
    } else {
        format!("{value}")
    }
}

/// Splits a Python-logging line `YYYY-MM-DD HH:MM:SS [LEVEL] message` into
/// the level and the message. Other lines are `info` with the whole line as
/// message.
pub fn split_python_log(line: &str) -> (LogLevel, &str) {
    let trimmed = line.trim_end();
    let mut fields = trimmed.splitn(4, ' ');
    let date = fields.next().unwrap_or("");
    let time = fields.next().unwrap_or("");
    let level_field = fields.next().unwrap_or("");
    let rest = fields.next().unwrap_or("");
    let looks_like_date = date.len() == 10 && date.as_bytes().get(4) == Some(&b'-');
    let looks_like_time = time.len() == 8 && time.as_bytes().get(2) == Some(&b':');
    if looks_like_date
        && looks_like_time
        && level_field.starts_with('[')
        && level_field.ends_with(']')
    {
        let level = match &level_field[1..level_field.len() - 1] {
            "WARNING" | "WARN" => LogLevel::Warning,
            "ERROR" | "CRITICAL" | "FATAL" => LogLevel::Error,
            _ => LogLevel::Info,
        };
        return (level, rest);
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("traceback") || lower.contains("error") {
        return (LogLevel::Error, trimmed);
    }
    if lower.contains("warning") {
        return (LogLevel::Warning, trimmed);
    }
    (LogLevel::Info, trimmed)
}

/// Returns the iteration column of a training table row: the first column is
/// `H:MM:SS` and the third an integer.
pub fn training_row_iteration(message: &str) -> Option<u64> {
    let columns: Vec<&str> = message.split_whitespace().collect();
    if columns.len() < 3 {
        return None;
    }
    if !is_clock(columns[0]) {
        return None;
    }
    columns[2].parse::<u64>().ok()
}

fn is_clock(value: &str) -> bool {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 3 {
        return false;
    }
    let all_digits =
        |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    all_digits(parts[0])
        && parts[1].len() == 2
        && all_digits(parts[1])
        && parts[2].len() == 2
        && all_digits(parts[2])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn nifti_part(name: &str, gzipped: bool) -> ReceivedPart {
        let mut header = vec![0u8; nifti::HEADER_LEN];
        header[0..4].copy_from_slice(&348i32.to_le_bytes());
        header[40..42].copy_from_slice(&3i16.to_le_bytes());
        for index in 1..=3 {
            header[40 + index * 2..42 + index * 2].copy_from_slice(&4i16.to_le_bytes());
        }
        header[nifti::MAGIC_OFFSET..nifti::MAGIC_OFFSET + 4].copy_from_slice(b"n+1\0");
        let file_name = if gzipped {
            format!("{name}.nii.gz")
        } else {
            format!("{name}.nii")
        };
        ReceivedPart {
            name: name.to_string(),
            path: PathBuf::from(&file_name),
            file_name,
            gzipped,
            header,
            bytes: 1000,
        }
    }

    fn text_part(name: &str) -> ReceivedPart {
        ReceivedPart {
            name: name.to_string(),
            path: PathBuf::from(format!("{name}.nii")),
            file_name: format!("{name}.nii"),
            gzipped: false,
            header: b"this is not a nifti file".to_vec(),
            bytes: 24,
        }
    }

    fn example_spec() -> Value {
        json!({
            "tool": "nesvor",
            "command": "reconstruct",
            "stacks": [
                { "file": "stack-0", "thickness": 3.0, "mask": "mask-0" },
                { "file": "stack-1", "thickness": 3.0 }
            ],
            "options": {
                "outputResolution": 0.8,
                "registration": "svort",
                "segmentation": true,
                "biasFieldCorrection": true,
                "otsuThresholding": false,
                "stacksIntersection": false,
                "deformable": false,
                "iterations": 6000,
                "singlePrecision": false,
                "weightTransformation": 0.1,
                "weightDeform": 0.1,
                "weightImage": 1.0,
                "batchSize": 4096,
                "log2HashmapSize": 19
            }
        })
    }

    fn example_parts() -> Vec<ReceivedPart> {
        vec![
            nifti_part("stack-0", true),
            nifti_part("stack-1", true),
            nifti_part("mask-0", true),
        ]
    }

    #[test]
    fn accepts_the_example_spec() {
        let job = Nesvor.validate(&example_spec(), &example_parts()).unwrap();
        assert_eq!(job.tool, "nesvor");
        assert_eq!(job.command, "reconstruct");
        assert_eq!(job.stacks.len(), 2);
        assert_eq!(job.stacks[0].mask.as_deref(), Some("mask-0"));
        assert_eq!(job.stacks[0].file_name, "stack-0.nii.gz");
        assert_eq!(job.options.len(), 14);
        assert_eq!(job.warnings.len(), 1);
    }

    #[test]
    fn rejects_unknown_option_keys() {
        let mut spec = example_spec();
        spec["options"]["nIter"] = json!(5);
        let error = Nesvor.validate(&spec, &example_parts()).unwrap_err();
        assert!(error.message.contains("unknown option 'nIter'"), "{error}");
    }

    #[test]
    fn rejects_out_of_range_values() {
        let cases = vec![
            ("outputResolution", json!(0.2)),
            ("outputResolution", json!(3.5)),
            ("registration", json!("elastic")),
            ("segmentation", json!("yes")),
            ("iterations", json!(50)),
            ("iterations", json!(20001)),
            ("iterations", json!(100.5)),
            ("weightTransformation", json!(-1)),
            ("weightImage", json!(101)),
            ("batchSize", json!(255)),
            ("log2HashmapSize", json!(25)),
        ];
        for (key, value) in cases {
            let mut spec = example_spec();
            spec["options"][key] = value.clone();
            let result = Nesvor.validate(&spec, &example_parts());
            assert!(result.is_err(), "{key} = {value} should be rejected");
        }
        let mut spec = example_spec();
        spec["stacks"][0]["thickness"] = json!(0);
        assert!(Nesvor.validate(&spec, &example_parts()).is_err());
        spec["stacks"][0]["thickness"] = json!(20.5);
        assert!(Nesvor.validate(&spec, &example_parts()).is_err());
        spec["stacks"] = json!([]);
        assert!(Nesvor.validate(&spec, &example_parts()).is_err());
    }

    #[test]
    fn rejects_missing_part_references() {
        let mut spec = example_spec();
        spec["stacks"][1]["file"] = json!("stack-9");
        let error = Nesvor.validate(&spec, &example_parts()).unwrap_err();
        assert!(error.message.contains("stack-9"), "{error}");

        let mut spec = example_spec();
        spec["stacks"][1]["mask"] = json!("mask-9");
        assert!(Nesvor.validate(&spec, &example_parts()).is_err());

        let mut spec = example_spec();
        spec["stacks"][1]["file"] = json!("stack-0");
        let error = Nesvor.validate(&spec, &example_parts()).unwrap_err();
        assert!(error.message.contains("more than once"), "{error}");
    }

    #[test]
    fn rejects_non_nifti_bytes() {
        let parts = vec![
            nifti_part("stack-0", true),
            text_part("stack-1"),
            nifti_part("mask-0", false),
        ];
        let error = Nesvor.validate(&example_spec(), &parts).unwrap_err();
        assert!(error.message.contains("not a NIfTI-1 file"), "{error}");
    }

    #[test]
    fn rejects_wrong_tool_or_command() {
        let mut spec = example_spec();
        spec["tool"] = json!("synthsr");
        assert!(Nesvor.validate(&spec, &example_parts()).is_err());
        let mut spec = example_spec();
        spec["command"] = json!("segment");
        assert!(Nesvor.validate(&spec, &example_parts()).is_err());
    }

    #[test]
    fn argv_matches_the_protocol_example() {
        let job = Nesvor.validate(&example_spec(), &example_parts()).unwrap();
        let argv = Nesvor.argv(&job, &ToolPaths::container());
        let expected = "nesvor reconstruct \
            --input-stacks /job/in/stack-0.nii.gz /job/in/stack-1.nii.gz \
            --thicknesses 3.0 3.0 \
            --output-volume /job/out/volume.nii.gz \
            --output-json /job/out/result.json \
            --output-resolution 0.8 \
            --registration svort \
            --segmentation \
            --bias-field-correction \
            --n-iter 6000 \
            --weight-transformation 0.1 --weight-deform 0.1 --weight-image 1.0 \
            --batch-size 4096 --log2-hashmap-size 19 \
            --verbose 1";
        assert_eq!(argv.join(" "), expected);
    }

    #[test]
    fn argv_passes_masks_only_when_complete() {
        let mut spec = example_spec();
        spec["stacks"][1]["mask"] = json!("mask-1");
        let mut parts = example_parts();
        parts.push(nifti_part("mask-1", false));
        let job = Nesvor.validate(&spec, &parts).unwrap();
        assert!(job.warnings.is_empty());
        let argv = Nesvor.argv(&job, &ToolPaths::container());
        let joined = argv.join(" ");
        assert!(joined.contains(
            "--input-stacks /job/in/stack-0.nii.gz /job/in/stack-1.nii.gz \
             --stack-masks /job/in/mask-0.nii.gz /job/in/mask-1.nii \
             --thicknesses 3.0 3.0"
        ));
    }

    #[test]
    fn argv_emits_all_flags_when_true() {
        let mut spec = example_spec();
        for key in [
            "otsuThresholding",
            "stacksIntersection",
            "deformable",
            "singlePrecision",
        ] {
            spec["options"][key] = json!(true);
        }
        let job = Nesvor.validate(&spec, &example_parts()).unwrap();
        let argv = Nesvor.argv(&job, &ToolPaths::container());
        let joined = argv.join(" ");
        assert!(joined.contains(
            "--segmentation --bias-field-correction --otsu-thresholding \
             --stacks-intersection --deformable --n-iter 6000 --single-precision"
        ));
    }

    #[test]
    fn argv_uses_native_paths() {
        let job = Nesvor.validate(&example_spec(), &example_parts()).unwrap();
        let paths = ToolPaths {
            input_dir: "/data/jobs/abc/in".to_string(),
            output_dir: "/data/jobs/abc/out".to_string(),
        };
        let argv = Nesvor.argv(&job, &paths);
        assert_eq!(argv[3], "/data/jobs/abc/in/stack-0.nii.gz");
        assert!(argv.contains(&"/data/jobs/abc/out/volume.nii.gz".to_string()));
    }

    #[test]
    fn progress_table_rows() {
        let job = Nesvor.validate(&example_spec(), &example_parts()).unwrap();
        let rows = vec![
            (
                "2026-09-21 10:00:00 [INFO] Data loading starts ...",
                "Loading stacks",
                0.02,
            ),
            (
                "2026-09-21 10:00:01 [INFO] Segmentation starts ...",
                "Brain masking",
                0.08,
            ),
            (
                "2026-09-21 10:00:01 [INFO] Bias Field Correction starts ...",
                "Bias field correction",
                0.15,
            ),
            (
                "2026-09-21 10:00:02 [INFO] Assessment starts ...",
                "Stack assessment",
                0.20,
            ),
            (
                "2026-09-21 10:00:02 [INFO] Registration starts ...",
                "Motion correction",
                0.25,
            ),
            (
                "2026-09-21 10:00:03 [INFO] Reconsturction starts ...",
                "Reconstruction",
                0.40,
            ),
            (
                "2026-09-21 10:00:03 [INFO] Reconstruction starts ...",
                "Reconstruction",
                0.40,
            ),
            (
                "2026-09-21 10:00:03 [INFO] NeSVoR training starts.",
                "Reconstruction",
                0.40,
            ),
            (
                "2026-09-21 10:00:10 [INFO] Results saving starts ...",
                "Sampling volume",
                0.92,
            ),
            (
                "2026-09-21 10:00:11 [INFO] Reconstruction finished, overall time: 0:01:12",
                "Finished",
                1.00,
            ),
        ];
        for (line, stage, fraction) in rows {
            let update = Nesvor.parse_log_line(&job, line);
            assert_eq!(update.level, LogLevel::Info);
            let (got_fraction, got_stage) = update.progress.expect(line);
            assert_eq!(got_stage, stage, "{line}");
            assert!(
                (got_fraction - fraction).abs() < 1e-9,
                "{line}: {got_fraction}"
            );
        }
    }

    #[test]
    fn progress_training_row() {
        let job = Nesvor.validate(&example_spec(), &example_parts()).unwrap();
        let line = "2026-09-21 10:00:03 [INFO]      0:01:12            3         3000    1.234e-01    5.678e-02    1.000e-03";
        let update = Nesvor.parse_log_line(&job, line);
        let (fraction, stage) = update.progress.expect("training row");
        assert_eq!(stage, "Reconstruction");
        assert!((fraction - 0.65).abs() < 1e-9, "{fraction}");

        let job_without_iterations = ValidatedJob {
            options: Map::new(),
            ..job.clone()
        };
        let update = Nesvor.parse_log_line(&job_without_iterations, line);
        let (fraction, _) = update.progress.expect("training row");
        assert!((fraction - 0.65).abs() < 1e-9, "{fraction}");

        let header =
            "2026-09-21 10:00:03 [INFO]         time        epoch         iter         loss";
        assert_eq!(Nesvor.parse_log_line(&job, header).progress, None);
    }

    #[test]
    fn log_levels() {
        let job = Nesvor.validate(&example_spec(), &example_parts()).unwrap();
        let warning = Nesvor.parse_log_line(&job, "2026-09-21 10:00:03 [WARNING] masks ignored");
        assert_eq!(warning.level, LogLevel::Warning);
        assert_eq!(warning.progress, None);
        let error = Nesvor.parse_log_line(&job, "2026-09-21 10:00:03 [ERROR] boom");
        assert_eq!(error.level, LogLevel::Error);
        let plain = Nesvor.parse_log_line(&job, "some tqdm noise");
        assert_eq!(plain.level, LogLevel::Info);
        assert_eq!(plain.progress, None);
    }

    #[test]
    fn number_formatting() {
        assert_eq!(format_number(3.0), "3.0");
        assert_eq!(format_number(0.8), "0.8");
        assert_eq!(format_number(0.1), "0.1");
        assert_eq!(format_number(1.0), "1.0");
        assert_eq!(format_number(2.5), "2.5");
    }
}
