//! The batch script template (ADR-0004, "Data roots" and "Launching RELION
//! on one node"). `apptainer` starts through `env -i` with an allowlist, so
//! no `APPTAINER_*` or `SINGULARITY_*` variable of the submitting environment
//! can add a mount; the container sees `/project`, `/data/<root>`, the image
//! and, with `--nv`, the GPU driver.

use std::fmt::Write;
use std::path::Path;

use super::config::Scratch;
use crate::profiles::Profile;
use crate::roots::DataRoot;

/// Variables passed from the batch job into `env -i`, when set.
pub const ENV_ALLOWLIST: &[&str] = &["PATH", "HOME", "USER", "LANG", "CUDA_VISIBLE_DEVICES"];

/// One command run in the container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    /// Program and arguments.
    pub argv: Vec<String>,
    /// MPI ranks; more than one runs the step under `mpirun`.
    pub ranks: Option<u32>,
}

/// Everything the template needs.
pub struct Script<'a> {
    /// Slurm job name, `nd-<job id>`.
    pub name: &'a str,
    /// Host path of the job directory, which receives `run.out` and `run.err`.
    pub job_dir: &'a Path,
    /// Host path of the project, mounted read-write at `/project`.
    pub project_dir: &'a Path,
    /// Data roots, each mounted read-only at `/data/<id>`.
    pub roots: &'a [DataRoot],
    /// Resources.
    pub profile: &'a Profile,
    /// Pass the host's GPUs (`--nv`).
    pub gpu: bool,
    /// Absolute path of `apptainer`.
    pub apptainer: &'a Path,
    /// The SIF image.
    pub image: &'a Path,
    /// Node-local scratch for `--workdir`.
    pub scratch: &'a Scratch,
    /// Commands in order; the script stops at the first failure.
    pub steps: &'a [Step],
}

/// Quotes one word for `bash`: single quotes, with `'` written as `'\''`.
pub fn quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

fn path(path: &Path) -> String {
    path.display().to_string()
}

/// Renders the batch script.
pub fn render(script: &Script<'_>) -> String {
    let mut text = String::from("#!/bin/bash\n");
    let mut directive = |line: String| {
        text.push_str("#SBATCH ");
        text.push_str(&line);
        text.push('\n');
    };
    let profile = script.profile;
    directive(format!("--job-name={}", script.name));
    directive(format!("--output={}/run.out", path(script.job_dir)));
    directive(format!("--error={}/run.err", path(script.job_dir)));
    directive("--no-requeue".into());
    directive("--nodes=1".into());
    directive("--ntasks=1".into());
    directive(format!("--cpus-per-task={}", profile.cpus));
    if let Some(partition) = &profile.partition {
        directive(format!("--partition={partition}"));
    }
    if let Some(account) = &profile.account {
        directive(format!("--account={account}"));
    }
    if let Some(qos) = &profile.qos {
        directive(format!("--qos={qos}"));
    }
    match (&profile.gres, profile.gpus) {
        (Some(gres), _) => directive(format!("--gres={gres}")),
        (None, 0) => {}
        (None, gpus) => directive(format!("--gres=gpu:{gpus}")),
    }
    if let Some(memory) = &profile.memory {
        directive(format!("--mem={memory}"));
    }
    if let Some(time) = &profile.time {
        directive(format!("--time={time}"));
    }
    text.push_str("set -euo pipefail\n");
    let scratch = match script.scratch {
        Scratch::Path(base) => quote(&format!("{}/{}", path(base), script.name)),
        Scratch::Variable(name) => format!(
            "\"${{{name}:?node scratch \\${name} is unset}}\"/{}",
            quote(script.name)
        ),
    };
    let _ = writeln!(text, "scratch={scratch}");
    text.push_str("mkdir -p \"$scratch\"\n");
    text.push_str("trap 'rm -rf \"$scratch\"' EXIT\n");
    text.push_str("keep=()\n");
    let _ = writeln!(text, "for name in {}; do", ENV_ALLOWLIST.join(" "));
    text.push_str("  if [ -n \"${!name+set}\" ]; then keep+=(\"$name=${!name}\"); fi\n");
    text.push_str("done\n");
    text.push_str("gpu_env=()\n");
    text.push_str("if [ -n \"${CUDA_VISIBLE_DEVICES+set}\" ]; then gpu_env=(--env \"CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES\"); fi\n");
    text.push_str("run() {\n");
    let _ = write!(
        text,
        "  env -i \"${{keep[@]}}\" {} exec --containall --no-mount hostfs,bind-paths --workdir \"$scratch\"",
        quote(&path(script.apptainer))
    );
    if script.gpu {
        text.push_str(" --nv");
    }
    let _ = write!(
        text,
        " --bind {}",
        quote(&format!("{}:/project:rw", path(script.project_dir)))
    );
    for root in script.roots {
        let _ = write!(
            text,
            " --bind {}",
            quote(&format!(
                "{}:{}:ro",
                path(&root.path),
                root.container_path()
            ))
        );
    }
    let _ = writeln!(
        text,
        " --pwd /project ${{gpu_env[@]+\"${{gpu_env[@]}}\"}} {} \"$@\"",
        quote(&path(script.image))
    );
    text.push_str("}\n");
    for step in script.steps {
        text.push_str("run");
        if let Some(ranks) = step.ranks.filter(|ranks| *ranks > 1) {
            let _ = write!(text, " mpirun --bind-to none -np {ranks}");
        }
        for word in &step.argv {
            text.push(' ');
            text.push_str(&quote(word));
        }
        text.push('\n');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn profile(gpus: u32) -> Profile {
        Profile {
            name: "gpu-4".into(),
            partition: Some("gpu".into()),
            account: Some("lab".into()),
            qos: None,
            cpus: 24,
            gpus,
            memory: Some("128G".into()),
            time: Some("24:00:00".into()),
            gres: None,
        }
    }

    const GOLDEN: &str = r#"#!/bin/bash
#SBATCH --job-name=nd-0123
#SBATCH --output=/home/u/nd/projects/p1/Refine3D/job007/run.out
#SBATCH --error=/home/u/nd/projects/p1/Refine3D/job007/run.err
#SBATCH --no-requeue
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=24
#SBATCH --partition=gpu
#SBATCH --account=lab
#SBATCH --gres=gpu:4
#SBATCH --mem=128G
#SBATCH --time=24:00:00
set -euo pipefail
scratch="${TMPDIR:?node scratch \$TMPDIR is unset}"/'nd-0123'
mkdir -p "$scratch"
trap 'rm -rf "$scratch"' EXIT
keep=()
for name in PATH HOME USER LANG CUDA_VISIBLE_DEVICES; do
  if [ -n "${!name+set}" ]; then keep+=("$name=${!name}"); fi
done
gpu_env=()
if [ -n "${CUDA_VISIBLE_DEVICES+set}" ]; then gpu_env=(--env "CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES"); fi
run() {
  env -i "${keep[@]}" '/usr/bin/apptainer' exec --containall --no-mount hostfs,bind-paths --workdir "$scratch" --nv --bind '/home/u/nd/projects/p1:/project:rw' --bind '/scratch/cryoem:/data/facility:ro' --pwd /project ${gpu_env[@]+"${gpu_env[@]}"} '/shared/relion_5.1.1.sif' "$@"
}
run mpirun --bind-to none -np 5 'relion_refine_mpi' '--o' 'Refine3D/job007/run' '--sym' 'C1' '--title' 'it'\''s a "map"; $(rm -rf /)'
run 'touch' 'Refine3D/job007/RELION_JOB_EXIT_SUCCESS'
"#;

    #[test]
    fn renders_the_golden_script() {
        let roots = vec![DataRoot {
            id: "facility".into(),
            path: PathBuf::from("/scratch/cryoem"),
        }];
        let steps = vec![
            Step {
                argv: [
                    "relion_refine_mpi",
                    "--o",
                    "Refine3D/job007/run",
                    "--sym",
                    "C1",
                    "--title",
                    "it's a \"map\"; $(rm -rf /)",
                ]
                .map(String::from)
                .to_vec(),
                ranks: Some(5),
            },
            Step {
                argv: vec![
                    "touch".into(),
                    "Refine3D/job007/RELION_JOB_EXIT_SUCCESS".into(),
                ],
                ranks: None,
            },
        ];
        let profile = profile(4);
        let text = render(&Script {
            name: "nd-0123",
            job_dir: Path::new("/home/u/nd/projects/p1/Refine3D/job007"),
            project_dir: Path::new("/home/u/nd/projects/p1"),
            roots: &roots,
            profile: &profile,
            gpu: true,
            apptainer: Path::new("/usr/bin/apptainer"),
            image: Path::new("/shared/relion_5.1.1.sif"),
            scratch: &Scratch::Variable("TMPDIR".into()),
            steps: &steps,
        });
        assert_eq!(text, GOLDEN);
    }

    #[test]
    fn cpu_profiles_and_fixed_scratch() {
        let mut profile = profile(0);
        profile.account = None;
        profile.partition = None;
        profile.qos = Some("normal".into());
        let steps = vec![Step {
            argv: vec!["relion_import".into()],
            ranks: Some(1),
        }];
        let text = render(&Script {
            name: "nd-1",
            job_dir: Path::new("/p/Import/job001"),
            project_dir: Path::new("/p"),
            roots: &[],
            profile: &profile,
            gpu: false,
            apptainer: Path::new("/opt/apptainer/bin/apptainer"),
            image: Path::new("/i.sif"),
            scratch: &Scratch::Path(PathBuf::from("/local")),
            steps: &steps,
        });
        assert!(text.contains("#SBATCH --qos=normal\n"));
        assert!(!text.contains("--gres"));
        assert!(!text.contains("--partition"));
        assert!(!text.contains(" --nv"));
        assert!(!text.contains("mpirun"));
        assert!(text.contains("scratch='/local/nd-1'\n"));
        assert!(text.contains("\nrun 'relion_import'\n"));
        let mut gres = profile.clone();
        gres.gres = Some("gpu:a100:2".into());
        gres.gpus = 2;
        let text = render(&Script {
            name: "nd-1",
            job_dir: Path::new("/p/Import/job001"),
            project_dir: Path::new("/p"),
            roots: &[],
            profile: &gres,
            gpu: true,
            apptainer: Path::new("/a"),
            image: Path::new("/i.sif"),
            scratch: &Scratch::Path(PathBuf::from("/local")),
            steps: &steps,
        });
        assert!(text.contains("#SBATCH --gres=gpu:a100:2\n"));
    }

    #[test]
    fn quoting_round_trips_through_bash() {
        let word = "a'b\"c $HOME `x` \\ \n end";
        let output = std::process::Command::new("bash")
            .args(["-c", &format!("printf %s {}", quote(word))])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), word);
    }

    /// The script drops every variable outside the allowlist, including the
    /// apptainer bind variables, and passes CUDA_VISIBLE_DEVICES only when set.
    #[test]
    fn the_container_environment_is_the_allowlist() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("apptainer");
        std::fs::write(
            &fake,
            "#!/bin/sh\nenv | sort > \"$OUT/env\"\nprintf '%s\\n' \"$@\" > \"$OUT/args\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let profile = profile(0);
        let steps = vec![Step {
            argv: vec!["true".into()],
            ranks: None,
        }];
        let text = render(&Script {
            name: "nd-env",
            job_dir: dir.path(),
            project_dir: dir.path(),
            roots: &[],
            profile: &profile,
            gpu: false,
            apptainer: &fake,
            image: Path::new("/i.sif"),
            scratch: &Scratch::Variable("TMPDIR".into()),
            steps: &steps,
        });
        // The fake apptainer writes into $OUT, which env -i removes, so run
        // it with OUT baked into the script instead.
        let text = text.replace(
            "env -i \"${keep[@]}\"",
            &format!(
                "env -i \"${{keep[@]}}\" OUT={}",
                quote(&dir.path().display().to_string())
            ),
        );
        let script = dir.path().join("job.sbatch");
        std::fs::write(&script, &text).unwrap();
        for cuda in [None, Some("1,3")] {
            let mut command = std::process::Command::new("bash");
            command
                .arg(&script)
                .env("TMPDIR", dir.path())
                .env("APPTAINER_BIND", "/secret")
                .env("SINGULARITY_BIND", "/secret")
                .env("APPTAINER_MOUNT", "/secret")
                .env("SITE_SECRET", "must not leak")
                .env_remove("CUDA_VISIBLE_DEVICES");
            if let Some(cuda) = cuda {
                command.env("CUDA_VISIBLE_DEVICES", cuda);
            }
            assert!(command.status().unwrap().success());
            let env = std::fs::read_to_string(dir.path().join("env")).unwrap();
            let names: Vec<&str> = env
                .lines()
                .filter_map(|line| line.split_once('=').map(|(name, _)| name))
                .filter(|name| *name != "OUT" && *name != "PWD" && *name != "SHLVL" && *name != "_")
                .collect();
            for name in &names {
                assert!(ENV_ALLOWLIST.contains(name), "{name} leaked into {env}");
            }
            assert!(!env.contains("/secret"));
            let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
            let args: Vec<&str> = args.lines().collect();
            assert_eq!(
                &args[..4],
                ["exec", "--containall", "--no-mount", "hostfs,bind-paths"]
            );
            match cuda {
                Some(cuda) => {
                    assert!(env.contains(&format!("CUDA_VISIBLE_DEVICES={cuda}\n")));
                    assert!(args.contains(&"--env"));
                    assert!(args.contains(&format!("CUDA_VISIBLE_DEVICES={cuda}").as_str()));
                }
                None => {
                    assert!(!env.contains("CUDA_VISIBLE_DEVICES"));
                    assert!(!args.contains(&"--env"));
                }
            }
            assert_eq!(args.last(), Some(&"true"));
            assert!(!dir.path().join("nd-env").exists(), "scratch is removed");
        }
    }
}
