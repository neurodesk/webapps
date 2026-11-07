//! `--slurm-config <file.json>`: the apptainer binary, the pinned image, node
//! scratch, resource profiles and each command's default profile.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::profiles::{Profile, Profiles};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    apptainer: PathBuf,
    image: ImageFile,
    scratch: String,
    profiles: BTreeMap<String, Profile>,
    #[serde(default)]
    defaults: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageFile {
    path: PathBuf,
    sha256: String,
}

/// Node-local scratch handed to `apptainer exec --workdir`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scratch {
    /// An absolute path.
    Path(PathBuf),
    /// An environment variable of the batch job (`$TMPDIR`).
    Variable(String),
}

/// The parsed configuration file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlurmConfig {
    /// Absolute path of `apptainer`; the batch script never searches `PATH`.
    pub apptainer: PathBuf,
    /// The SIF image.
    pub image: PathBuf,
    /// Its expected SHA-256, lowercase hex.
    pub image_sha256: String,
    /// Node-local scratch.
    pub scratch: Scratch,
    /// Profiles and defaults.
    pub profiles: Profiles,
}

impl SlurmConfig {
    /// Reads and validates a configuration file.
    pub fn load(path: &Path) -> Result<SlurmConfig, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        SlurmConfig::parse(&text).map_err(|error| format!("{}: {error}", path.display()))
    }

    /// Parses and validates the JSON text.
    pub fn parse(text: &str) -> Result<SlurmConfig, String> {
        let file: File = serde_json::from_str(text).map_err(|error| error.to_string())?;
        if !file.apptainer.is_absolute() {
            return Err("apptainer must be an absolute path".into());
        }
        if !file.image.path.is_absolute() {
            return Err("image.path must be an absolute path".into());
        }
        let sha256 = file.image.sha256.to_ascii_lowercase();
        if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("image.sha256 must be 64 hex digits".into());
        }
        for path in [&file.apptainer, &file.image.path] {
            script_safe_path(path)?;
        }
        let scratch = parse_scratch(&file.scratch)?;
        Ok(SlurmConfig {
            apptainer: file.apptainer,
            image: file.image.path,
            image_sha256: sha256,
            scratch,
            profiles: Profiles::new(file.profiles, file.defaults)?,
        })
    }
}

fn parse_scratch(text: &str) -> Result<Scratch, String> {
    if let Some(variable) = text.strip_prefix('$') {
        let name = variable
            .strip_prefix('{')
            .and_then(|inner| inner.strip_suffix('}'))
            .unwrap_or(variable);
        let mut bytes = name.bytes();
        let valid = bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        if !valid {
            return Err(format!("scratch '{text}' is not $NAME or an absolute path"));
        }
        return Ok(Scratch::Variable(name.to_string()));
    }
    let path = PathBuf::from(text);
    if !path.is_absolute() {
        return Err(format!("scratch '{text}' is not $NAME or an absolute path"));
    }
    script_safe_path(&path)?;
    Ok(Scratch::Path(path))
}

/// Paths written into `#SBATCH` lines and `--bind` arguments: Slurm expands
/// `%` in output names and apptainer splits binds on `:` and `,`, so only
/// plain characters are accepted.
pub fn script_safe_path(path: &Path) -> Result<(), String> {
    let text = path
        .to_str()
        .ok_or_else(|| format!("{} is not UTF-8", path.display()))?;
    let plain = |byte: u8| byte.is_ascii_alphanumeric() || b"/._+-@~=".contains(&byte);
    if text.bytes().all(plain) {
        Ok(())
    } else {
        Err(format!(
            "{text} contains characters a batch script cannot carry (allowed: letters, digits, / . _ + - @ ~ =)"
        ))
    }
}

/// Timing constants of the Slurm runner (protocol: "Slurm runner").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlurmTimings {
    /// Interval of the one `squeue --me` call for all jobs.
    pub poll: Duration,
    /// `sacct -S` margin before the recorded submission time.
    pub sacct_margin: Duration,
    /// How long accounting may stay empty before `interrupted` or `scheduler-lost`.
    pub retry_window: Duration,
    /// Grace period for `RELION_JOB_EXIT_*` after `COMPLETED`.
    pub marker_grace: Duration,
    /// Polling failures for this long make new submissions `runner-unavailable`.
    pub unavailable_after: Duration,
    /// Interval of reading new lines of `run.out` and `run.err`.
    pub tail: Duration,
    /// Deadline of one Slurm command.
    pub command_timeout: Duration,
}

impl Default for SlurmTimings {
    fn default() -> SlurmTimings {
        SlurmTimings {
            poll: Duration::from_secs(15),
            sacct_margin: Duration::from_secs(5 * 60),
            retry_window: Duration::from_secs(10 * 60),
            marker_grace: Duration::from_secs(120),
            unavailable_after: Duration::from_secs(10 * 60),
            tail: Duration::from_secs(2),
            command_timeout: Duration::from_secs(60),
        }
    }
}

/// Everything the Slurm runner needs.
#[derive(Debug, Clone)]
pub struct SlurmSettings {
    /// The configuration file.
    pub config: SlurmConfig,
    /// Timing constants.
    pub timings: SlurmTimings,
    /// `PATH` the Slurm commands are looked up and run with (`None`: inherited).
    pub path: Option<OsString>,
    /// The Unix user the server runs as, for `sacct -u`.
    pub user: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(scratch: &str, image: &str) -> String {
        serde_json::json!({
            "apptainer": "/usr/bin/apptainer",
            "image": { "path": image, "sha256": "A".repeat(64) },
            "scratch": scratch,
            "profiles": {
                "cpu": { "partition": "cpu", "cpus": 16, "gpus": 0, "memory": "64G", "time": "12:00:00" },
                "gpu-4": { "partition": "gpu", "account": "lab", "qos": null, "cpus": 24, "gpus": 4, "memory": "128G", "time": "24:00:00" }
            },
            "defaults": { "class2d": "gpu-4", "import": "cpu" }
        })
        .to_string()
    }

    #[test]
    fn parses_the_protocol_example() {
        let parsed =
            SlurmConfig::parse(&config("$TMPDIR", "/shared/images/relion_5.1.1.sif")).unwrap();
        assert_eq!(parsed.scratch, Scratch::Variable("TMPDIR".into()));
        assert_eq!(parsed.image_sha256, "a".repeat(64));
        assert_eq!(parsed.profiles.resolve("class2d", None).unwrap().gpus, 4);
        assert_eq!(
            SlurmConfig::parse(&config("${SCRATCH}", "/i.sif"))
                .unwrap()
                .scratch,
            Scratch::Variable("SCRATCH".into())
        );
        assert_eq!(
            SlurmConfig::parse(&config("/local/scratch", "/i.sif"))
                .unwrap()
                .scratch,
            Scratch::Path("/local/scratch".into())
        );
    }

    #[test]
    fn refuses_unsafe_configurations() {
        for (scratch, image) in [
            ("tmp", "/i.sif"),
            ("$(rm -rf /)", "/i.sif"),
            ("$TMPDIR", "relative.sif"),
            ("$TMPDIR", "/images/a:b.sif"),
            ("$TMPDIR", "/images/a b.sif"),
            ("/scratch/%j", "/i.sif"),
        ] {
            assert!(
                SlurmConfig::parse(&config(scratch, image)).is_err(),
                "{scratch} {image}"
            );
        }
        let unknown = serde_json::json!({
            "apptainer": "/usr/bin/apptainer",
            "image": { "path": "/i.sif", "sha256": "a".repeat(64) },
            "scratch": "$TMPDIR",
            "profiles": { "cpu": { "cpus": 1, "gpus": 0 } },
            "extra": true
        });
        assert!(SlurmConfig::parse(&unknown.to_string()).is_err());
    }
}
