//! Startup checks of the Slurm runner: the five commands run, accounting
//! answers, `sbatch --test-only` accepts every profile, paths fit into a batch
//! script, and the image's SHA-256 matches (cached by path, size and
//! modification time).

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::commands::{slurm_time, Slurm, COMMANDS};
use super::config::script_safe_path;
use super::script::{self, Script, Step};
use super::{check_dir, SlurmSettings};
use crate::roots::DataRoot;

/// The command line of the Slurm runner's settings.
pub fn slurm(settings: &SlurmSettings) -> Slurm {
    Slurm {
        path: settings.path.clone(),
        timeout: settings.timings.command_timeout,
        user: settings.user.clone(),
    }
}

/// Runs every startup check; the first failure refuses startup.
pub async fn startup(
    settings: &SlurmSettings,
    data_dir: &Path,
    roots: &[DataRoot],
) -> Result<(), String> {
    script_safe_path(data_dir).map_err(|error| format!("data directory: {error}"))?;
    for root in roots {
        script_safe_path(&root.path)
            .map_err(|error| format!("data root '{}': {error}", root.id))?;
    }
    let slurm = slurm(settings);
    for command in COMMANDS {
        let output = slurm.call(command, &["--version"], &[], None).await?;
        if !output.ok {
            return Err(format!("{command} --version failed: {}", output.stderr));
        }
    }
    let since = slurm_time(chrono::Utc::now() - chrono::Duration::minutes(1));
    let accounting = slurm
        .call(
            "sacct",
            &[
                "-u",
                &slurm.user,
                "-S",
                &since,
                "-X",
                "-n",
                "-P",
                "--format=JobID",
            ],
            &[],
            None,
        )
        .await?;
    if !accounting.ok {
        return Err(format!(
            "Slurm accounting does not answer (sacct: {}); sites without accounting are not supported",
            accounting.stderr
        ));
    }
    test_profiles(settings, &slurm, data_dir, roots).await?;
    verify_image(settings, data_dir)
}

async fn test_profiles(
    settings: &SlurmSettings,
    slurm: &Slurm,
    data_dir: &Path,
    roots: &[DataRoot],
) -> Result<(), String> {
    let dir = check_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let config = &settings.config;
    for profile in config.profiles.list() {
        let steps = [Step {
            argv: vec!["true".into()],
            ranks: None,
        }];
        let text = script::render(&Script {
            name: "nd-test-only",
            job_dir: &dir,
            project_dir: &dir,
            roots,
            profile,
            gpu: profile.gpus > 0,
            apptainer: &config.apptainer,
            image: &config.image,
            scratch: &config.scratch,
            steps: &steps,
        });
        let path = dir.join(format!("test-only-{}.sbatch", profile.name));
        std::fs::write(&path, text).map_err(|error| error.to_string())?;
        slurm.test_only(&path, &dir).await.map_err(|error| {
            format!(
                "sbatch --test-only refuses profile '{}': {error}",
                profile.name
            )
        })?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct Verified {
    path: String,
    size: u64,
    modified: i128,
    sha256: String,
}

/// Checks the SIF's SHA-256 once per path, size and modification time.
pub fn verify_image(settings: &SlurmSettings, data_dir: &Path) -> Result<(), String> {
    let image = &settings.config.image;
    let metadata =
        std::fs::metadata(image).map_err(|error| format!("image {}: {error}", image.display()))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos() as i128)
        .unwrap_or(-1);
    let expected = Verified {
        path: image.display().to_string(),
        size: metadata.len(),
        modified,
        sha256: settings.config.image_sha256.clone(),
    };
    let cache = data_dir.join("image-verified.json");
    if let Ok(bytes) = std::fs::read(&cache) {
        if serde_json::from_slice::<Verified>(&bytes).is_ok_and(|cached| cached == expected) {
            return Ok(());
        }
    }
    let actual =
        sha256_file(image).map_err(|error| format!("image {}: {error}", image.display()))?;
    if actual != expected.sha256 {
        return Err(format!(
            "image {} has SHA-256 {actual}, expected {}",
            image.display(),
            expected.sha256
        ));
    }
    crate::durable::write(&cache, &expected).map_err(|error| error.to_string())
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut context = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        context.update(&buffer[..read]);
    }
    Ok(crate::api::hex_digest(context.finish()))
}
