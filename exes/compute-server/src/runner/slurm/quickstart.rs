//! `neurodesk-compute cryo-em`: a first `slurm.json` written from what
//! `sinfo` reports, so a cluster user does not write one by hand.

use std::path::Path;

/// Partitions read from `sinfo -h -o "%P %G"`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Partitions {
    /// The default partition, when it has no GPUs; else the first without GPUs.
    pub cpu: Option<String>,
    /// Partitions with a `gpu` GRES, in `sinfo` order.
    pub gpu: Vec<String>,
}

/// Parses `sinfo -h -o "%P %G"`: one line per partition and node shape, the
/// default partition marked with `*`, GRES `(null)` when a node has none.
pub fn partitions(sinfo: &str) -> Partitions {
    let mut default = None;
    let mut cpu_only: Vec<String> = Vec::new();
    let mut gpu: Vec<String> = Vec::new();
    for line in sinfo.lines() {
        let mut fields = line.split_whitespace();
        let Some(name) = fields.next() else { continue };
        let gres = fields.next().unwrap_or("");
        let marked = name.ends_with('*');
        let name = name.trim_end_matches('*').to_string();
        if name.is_empty() {
            continue;
        }
        let has_gpu = gres.split(',').any(|entry| entry.starts_with("gpu"));
        if has_gpu {
            if !gpu.contains(&name) {
                gpu.push(name.clone());
            }
        } else if !cpu_only.contains(&name) {
            cpu_only.push(name.clone());
        }
        if marked {
            default = Some(name);
        }
    }
    cpu_only.retain(|name| !gpu.contains(name));
    let cpu = match default {
        Some(name) if cpu_only.contains(&name) => Some(name),
        _ => cpu_only.into_iter().next(),
    };
    Partitions { cpu, gpu }
}

/// Where and as whom the generated profiles run.
#[derive(Debug, Clone, Default)]
pub struct Choice<'a> {
    /// Partition of the CPU steps (`None`: the cluster's default).
    pub cpu_partition: Option<&'a str>,
    /// Partition of the GPU steps.
    pub gpu_partition: &'a str,
    /// Slurm account of both profiles (`None`: the user's default).
    pub account: Option<&'a str>,
}

/// The RELION commands that run on a GPU; every other runs on the CPU profile.
const GPU_COMMANDS: [&str; 3] = ["class2d", "initialmodel", "refine3d"];
const CPU_COMMANDS: [&str; 8] = [
    "import",
    "motioncorr",
    "ctffind",
    "autopick",
    "extract",
    "select",
    "maskcreate",
    "postprocess",
];

/// A `slurm.json` sized for the RELION tutorial: 8 CPUs and 32G for the CPU
/// steps, one GPU, 8 CPUs and 64G for the GPU steps (3D refinement needs at
/// least 3 CPUs).
pub fn config_json(apptainer: &Path, image: &Path, choice: &Choice) -> String {
    let profile = |partition: Option<&str>, gpus: u32, memory: &str, time: &str| {
        let mut value =
            serde_json::json!({ "cpus": 8, "gpus": gpus, "memory": memory, "time": time });
        if let Some(partition) = partition {
            value["partition"] = partition.into();
        }
        if let Some(account) = choice.account {
            value["account"] = account.into();
        }
        value
    };
    let mut defaults = serde_json::Map::new();
    for command in CPU_COMMANDS {
        defaults.insert(command.into(), "cpu".into());
    }
    for command in GPU_COMMANDS {
        defaults.insert(command.into(), "gpu".into());
    }
    let config = serde_json::json!({
        "apptainer": apptainer,
        "image": { "path": image },
        "scratch": "$TMPDIR",
        "profiles": {
            "cpu": profile(choice.cpu_partition, 0, "32G", "12:00:00"),
            "gpu": profile(Some(choice.gpu_partition), 1, "64G", "24:00:00"),
        },
        "defaults": defaults,
    });
    let mut text = serde_json::to_string_pretty(&config).expect("JSON value");
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::slurm::SlurmConfig;

    #[test]
    fn reads_partitions_from_sinfo() {
        let sinfo = "general* (null)\ngpu gpu:a100:4(S:0-1)\ngpu gpu:v100:2\nbigmem (null)\nvolta gpu:2,shard:8\n";
        assert_eq!(
            partitions(sinfo),
            Partitions {
                cpu: Some("general".into()),
                gpu: vec!["gpu".into(), "volta".into()]
            }
        );
    }

    #[test]
    fn a_gpu_default_partition_leaves_the_cpu_steps_on_the_next_one() {
        let sinfo = "gpu* gpu:4\nbatch (null)\n";
        let found = partitions(sinfo);
        assert_eq!(found.cpu.as_deref(), Some("batch"));
        assert_eq!(found.gpu, vec!["gpu".to_string()]);
        assert_eq!(partitions("gpu* gpu:4\n").cpu, None);
    }

    #[test]
    fn a_partition_with_some_gpu_nodes_counts_as_a_gpu_partition() {
        let found = partitions("mixed* (null)\nmixed gpu:1\n");
        assert_eq!(found.cpu, None);
        assert_eq!(found.gpu, vec!["mixed".to_string()]);
    }

    #[test]
    fn the_generated_file_is_a_valid_configuration_for_every_relion_command() {
        let text = config_json(
            Path::new("/usr/bin/apptainer"),
            Path::new("/home/you/neurodesk-compute/images/relion/relion_5.1.1.sif"),
            &Choice {
                cpu_partition: None,
                gpu_partition: "gpu",
                account: Some("lab"),
            },
        );
        let config = SlurmConfig::parse(&text).unwrap();
        for command in CPU_COMMANDS.iter().chain(GPU_COMMANDS.iter()) {
            let profile = config.profiles.resolve(command, None).unwrap();
            assert_eq!(
                profile.gpus > 0,
                GPU_COMMANDS.contains(command),
                "{command}"
            );
            assert_eq!(profile.account.as_deref(), Some("lab"));
            crate::tools::relion::spec::relion_launch(command, profile.cpus, profile.gpus)
                .unwrap_or_else(|error| panic!("{command}: {error}"));
        }
        assert_eq!(
            config.profiles.resolve("import", None).unwrap().partition,
            None
        );
        assert_eq!(
            config
                .profiles
                .resolve("refine3d", None)
                .unwrap()
                .partition
                .as_deref(),
            Some("gpu")
        );
    }
}
