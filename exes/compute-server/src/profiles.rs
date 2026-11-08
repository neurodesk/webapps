//! Resource profiles: the Slurm resources a project job runs with. The caller
//! names a profile; it never passes scheduler flags.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// One named set of resources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    /// Name, set from the key of the `profiles` map.
    #[serde(skip_deserializing)]
    pub name: String,
    /// Slurm partition.
    #[serde(default)]
    pub partition: Option<String>,
    /// Slurm account.
    #[serde(default)]
    pub account: Option<String>,
    /// Slurm quality of service.
    #[serde(default)]
    pub qos: Option<String>,
    /// CPUs of the allocation (`--cpus-per-task`).
    pub cpus: u32,
    /// GPUs of the allocation.
    pub gpus: u32,
    /// Memory (`--mem`), e.g. `128G`.
    #[serde(default)]
    pub memory: Option<String>,
    /// Wall time (`--time`), e.g. `24:00:00`.
    #[serde(default)]
    pub time: Option<String>,
    /// A site-specific `--gres` value replacing `gpu:<gpus>`.
    #[serde(default)]
    pub gres: Option<String>,
}

impl Profile {
    /// `4 GPUs, 24 CPUs, 128G, 24:00:00`.
    pub fn summary(&self) -> String {
        let mut parts = Vec::new();
        match self.gpus {
            0 => {}
            1 => parts.push("1 GPU".to_string()),
            count => parts.push(format!("{count} GPUs")),
        }
        match self.cpus {
            1 => parts.push("1 CPU".to_string()),
            count => parts.push(format!("{count} CPUs")),
        }
        parts.extend(self.memory.iter().cloned());
        parts.extend(self.time.iter().cloned());
        parts.join(", ")
    }

    fn validate(&self) -> Result<(), String> {
        let name = &self.name;
        if !crate::roots::valid_root_id(name) {
            return Err(format!(
                "profile name '{name}' must match ^[a-z0-9][a-z0-9-]{{0,31}}$"
            ));
        }
        if self.cpus == 0 {
            return Err(format!("profile '{name}' needs at least one CPU"));
        }
        let word = |byte: u8| byte.is_ascii_alphanumeric() || b"_.,:+=-".contains(&byte);
        for (field, value) in [
            ("partition", &self.partition),
            ("account", &self.account),
            ("qos", &self.qos),
            ("gres", &self.gres),
        ] {
            if let Some(value) = value {
                if value.is_empty() || !value.bytes().all(word) {
                    return Err(format!("profile '{name}': invalid {field} '{value}'"));
                }
            }
        }
        if let Some(memory) = &self.memory {
            let digits = memory.trim_end_matches(['K', 'M', 'G', 'T']);
            if digits.is_empty()
                || !digits.bytes().all(|byte| byte.is_ascii_digit())
                || memory.len() > digits.len() + 1
            {
                return Err(format!("profile '{name}': invalid memory '{memory}'"));
            }
        }
        if let Some(time) = &self.time {
            if time.is_empty()
                || !time
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b':' || byte == b'-')
            {
                return Err(format!("profile '{name}': invalid time '{time}'"));
            }
        }
        Ok(())
    }
}

/// The profiles a server offers and each command's default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profiles {
    list: Vec<Profile>,
    defaults: BTreeMap<String, String>,
}

impl Profiles {
    /// Validates profiles and defaults; every default must name a profile.
    pub fn new(
        profiles: BTreeMap<String, Profile>,
        defaults: BTreeMap<String, String>,
    ) -> Result<Profiles, String> {
        let mut list = Vec::new();
        for (name, mut profile) in profiles {
            profile.name = name;
            profile.validate()?;
            list.push(profile);
        }
        if list.is_empty() {
            return Err("at least one profile is required".into());
        }
        for (command, profile) in &defaults {
            if !list.iter().any(|candidate| &candidate.name == profile) {
                return Err(format!(
                    "default profile '{profile}' of '{command}' is not defined"
                ));
            }
        }
        Ok(Profiles { list, defaults })
    }

    /// The built-in profile `local`: every available CPU, no GPU.
    pub fn local() -> Profiles {
        let cpus = std::thread::available_parallelism()
            .map(|count| count.get() as u32)
            .unwrap_or(1);
        Profiles {
            list: vec![Profile {
                name: "local".into(),
                partition: None,
                account: None,
                qos: None,
                cpus,
                gpus: 0,
                memory: None,
                time: None,
                gres: None,
            }],
            defaults: BTreeMap::new(),
        }
    }

    /// All profiles, sorted by name.
    pub fn list(&self) -> &[Profile] {
        &self.list
    }

    /// The profile a spec asked for, else the command's default, else the
    /// only profile.
    pub fn resolve(&self, command: &str, requested: Option<&str>) -> Result<&Profile, String> {
        let name = match requested {
            Some(name) => name,
            None => match self.defaults.get(command) {
                Some(name) => name.as_str(),
                None if self.list.len() == 1 => self.list[0].name.as_str(),
                None => return Err(format!("no default profile for '{command}'; name one")),
            },
        };
        self.list
            .iter()
            .find(|profile| profile.name == name)
            .ok_or_else(|| format!("unknown profile '{name}'"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(json: serde_json::Value) -> Profile {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn summaries_and_resolution() {
        let mut map = BTreeMap::new();
        map.insert(
            "gpu-4".to_string(),
            profile(serde_json::json!({"partition": "gpu", "cpus": 24, "gpus": 4, "memory": "128G", "time": "24:00:00"})),
        );
        map.insert(
            "cpu".to_string(),
            profile(serde_json::json!({"cpus": 16, "gpus": 0, "memory": "64G"})),
        );
        let defaults = BTreeMap::from([("class2d".to_string(), "gpu-4".to_string())]);
        let profiles = Profiles::new(map, defaults).unwrap();
        assert_eq!(
            profiles.resolve("class2d", None).unwrap().summary(),
            "4 GPUs, 24 CPUs, 128G, 24:00:00"
        );
        assert_eq!(
            profiles.resolve("x", Some("cpu")).unwrap().summary(),
            "16 CPUs, 64G"
        );
        assert!(profiles.resolve("import", None).is_err());
        assert!(profiles.resolve("import", Some("nope")).is_err());
        assert_eq!(
            Profiles::local().resolve("import", None).unwrap().name,
            "local"
        );
    }

    #[test]
    fn refuses_unsafe_values() {
        for bad in [
            serde_json::json!({"cpus": 0, "gpus": 0}),
            serde_json::json!({"cpus": 1, "gpus": 0, "partition": "gpu\n#SBATCH --x"}),
            serde_json::json!({"cpus": 1, "gpus": 0, "memory": "12GB"}),
            serde_json::json!({"cpus": 1, "gpus": 0, "time": "1 day"}),
        ] {
            let map = BTreeMap::from([("p".to_string(), profile(bad))]);
            assert!(Profiles::new(map, BTreeMap::new()).is_err());
        }
        let map = BTreeMap::from([(
            "p".to_string(),
            profile(serde_json::json!({"cpus": 1, "gpus": 0})),
        )]);
        let defaults = BTreeMap::from([("x".to_string(), "q".to_string())]);
        assert!(Profiles::new(map, defaults).is_err());
        assert!(serde_json::from_value::<Profile>(
            serde_json::json!({"cpus": 1, "gpus": 0, "nodes": 2})
        )
        .is_err());
    }
}
