//! Fake `sbatch`, `squeue`, `sacct`, `scontrol` and `scancel` scripts that
//! read and write a state directory, placed first on the runner's `PATH`.
//!
//! State: `jobs/<id>/{name,submitted,script,env}` from `sbatch`, which
//! records a job atomically before it answers; `queue`
//! (`STATE|reason`) while the job is in `squeue`; `sacct` (`STATE|exit`) once
//! accounting has a record; `accounted` while `sacct --name` lists it;
//! `scontrol` (`STATE|exit`) while the controller knows it. `mode/` steers the
//! commands; `calls` logs every call.

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const HEADER: &str = r#"#!/bin/bash
S=__STATE__
shopt -s nullglob
echo "$(basename "$0") $*" >> "$S/calls"
if [ "$1" = "--version" ]; then echo "slurm 23.11.10"; exit 0; fi
"#;

const SBATCH: &str = r#"
if [ "$1" = "--test-only" ]; then
  if [ -f "$S/mode/test_only_fail" ]; then echo "sbatch: error: Invalid partition name specified" >&2; exit 1; fi
  echo "sbatch: Job 1 to start at 2026-11-07T10:00:00" >&2
  exit 0
fi
script="${@: -1}"
mode=$(cat "$S/mode/sbatch" 2>/dev/null)
if [ "$mode" = reject ]; then echo "sbatch: error: Batch job submission failed: Invalid partition name specified" >&2; exit 1; fi
id=$(( $(cat "$S/next_id" 2>/dev/null || echo 4000) + 1 ))
echo "$id" > "$S/next_id"
new="$S/jobs/.new-$id"
mkdir -p "$new"
sed -n 's/^#SBATCH --job-name=//p' "$script" > "$new/name"
if [ -f "$S/mode/submitted" ]; then cp "$S/mode/submitted" "$new/submitted"; else date +%Y-%m-%dT%H:%M:%S > "$new/submitted"; fi
cp "$script" "$new/script"
env > "$new/env"
initial=$(cat "$S/mode/initial_queue" 2>/dev/null || echo "PENDING|Priority")
if [ "$initial" != none ]; then echo "$initial" > "$new/queue"; fi
if [ -f "$S/mode/initial_sacct" ]; then cp "$S/mode/initial_sacct" "$new/sacct"; fi
if [ ! -f "$S/mode/unaccounted" ]; then touch "$new/accounted"; fi
mv "$new" "$S/jobs/$id"
if [ -x "$S/mode/on_submit" ]; then "$S/mode/on_submit" "$id" "$script"; fi
case "$mode" in
  lose) echo "sbatch: error: Socket timed out on send/recv operation" >&2; exit 1 ;;
  hang) exec sleep 30 ;;
esac
echo "$id"
"#;

const SQUEUE: &str = r#"
if [ -f "$S/mode/squeue_fail" ]; then echo "squeue: error: Socket timed out on send/recv operation" >&2; exit 1; fi
want=""
format=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) want="$2"; shift ;;
    --format=*) format="${1#--format=}" ;;
  esac
  shift
done
for dir in "$S"/jobs/*/; do
  [ -f "$dir/queue" ] || continue
  id=$(basename "$dir")
  name=$(cat "$dir/name")
  if [ -n "$want" ] && [ "$name" != "$want" ]; then continue; fi
  IFS='|' read -r state reason < "$dir/queue"
  if [ "$format" = "%i" ]; then echo "$id"; else echo "$id|$name|$state|${reason:-None}"; fi
done
"#;

const SACCT: &str = r#"
job=""
want=""
start=""
user=""
while [ $# -gt 0 ]; do
  case "$1" in
    -j) job="$2"; shift ;;
    --name) want="$2"; shift ;;
    -S) start="$2"; shift ;;
    -u) user="$2"; shift ;;
  esac
  shift
done
if [ -n "$job" ]; then
  if [ -f "$S/jobs/$job/sacct" ]; then echo "$job|$(cat "$S/jobs/$job/sacct")"; fi
  exit 0
fi
if [ -n "$want" ]; then
  if [ -z "$start" ]; then start=$(cat "$S/today" 2>/dev/null || echo 0000); fi
  for dir in "$S"/jobs/*/; do
    [ -f "$dir/accounted" ] || continue
    [ "$(cat "$dir/name")" = "$want" ] || continue
    submitted=$(cat "$dir/submitted")
    if [[ "$submitted" < "$start" ]]; then continue; fi
    basename "$dir"
  done
fi
exit 0
"#;

const SCONTROL: &str = r#"
id="$3"
if [ -f "$S/jobs/$id/scontrol" ]; then
  IFS='|' read -r state exit < "$S/jobs/$id/scontrol"
  echo "JobId=$id JobName=$(cat "$S/jobs/$id/name")"
  echo "   JobState=$state Reason=None Dependency=(null)"
  echo "   ExitCode=$exit"
  exit 0
fi
echo "slurm_load_jobs error: Invalid job id specified" >&2
exit 1
"#;

const SCANCEL: &str = r#"
id="$1"
echo "$id" >> "$S/cancelled"
if [ ! -f "$S/mode/scancel_noop" ]; then
  rm -f "$S/jobs/$id/queue"
  echo "CANCELLED by 1000|0:15" > "$S/jobs/$id/sacct"
fi
"#;

/// A fake Slurm installation.
pub struct FakeSlurm {
    bin: PathBuf,
    state: PathBuf,
}

impl FakeSlurm {
    /// Writes the scripts under `dir`.
    pub fn new(dir: &Path) -> FakeSlurm {
        let bin = dir.join("bin");
        let state = dir.join("state");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(state.join("jobs")).unwrap();
        std::fs::create_dir_all(state.join("mode")).unwrap();
        let header = HEADER.replace(
            "__STATE__",
            &super::script::quote(&state.display().to_string()),
        );
        for (name, body) in [
            ("sbatch", SBATCH),
            ("squeue", SQUEUE),
            ("sacct", SACCT),
            ("scontrol", SCONTROL),
            ("scancel", SCANCEL),
        ] {
            let path = bin.join(name);
            std::fs::write(&path, format!("{header}{body}")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        FakeSlurm { bin, state }
    }

    /// `PATH` with the fakes first.
    pub fn path(&self) -> OsString {
        let mut paths = vec![self.bin.clone()];
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        std::env::join_paths(paths).unwrap()
    }

    fn job(&self, id: &str) -> PathBuf {
        self.state.join("jobs").join(id)
    }

    /// Sets or clears a mode file.
    pub fn mode(&self, name: &str, value: Option<&str>) {
        let path = self.state.join("mode").join(name);
        match value {
            Some(value) => std::fs::write(path, value).unwrap(),
            None => {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    /// The "today" sacct uses without `-S`.
    pub fn today(&self, start: &str) {
        std::fs::write(self.state.join("today"), start).unwrap();
    }

    /// The Slurm id of the job named `nd-<job id>`.
    pub fn id_of(&self, job_id: &str) -> Option<String> {
        let name = super::job_name(job_id);
        std::fs::read_dir(self.state.join("jobs"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
            .find(|entry| {
                std::fs::read_to_string(entry.path().join("name"))
                    .is_ok_and(|text| text.trim() == name)
            })
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
    }

    /// Every Slurm id sbatch created.
    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = std::fs::read_dir(self.state.join("jobs"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| !name.starts_with('.'))
            .collect();
        ids.sort();
        ids
    }

    /// Puts a job in `squeue` with a state and reason.
    pub fn queue(&self, id: &str, state: &str, reason: Option<&str>) {
        std::fs::write(
            self.job(id).join("queue"),
            format!("{state}|{}", reason.unwrap_or("None")),
        )
        .unwrap();
    }

    /// Takes a job out of `squeue`.
    pub fn leave_queue(&self, id: &str) {
        let _ = std::fs::remove_file(self.job(id).join("queue"));
    }

    /// Records an accounting state.
    pub fn account(&self, id: &str, state: &str, exit: &str) {
        std::fs::write(self.job(id).join("sacct"), format!("{state}|{exit}")).unwrap();
    }

    /// Makes `sacct --name` list or hide a job.
    pub fn accounted(&self, id: &str, listed: bool) {
        let path = self.job(id).join("accounted");
        if listed {
            std::fs::write(path, "").unwrap();
        } else {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Makes `scontrol show job` know a job.
    pub fn control(&self, id: &str, state: &str, exit: &str) {
        std::fs::write(self.job(id).join("scontrol"), format!("{state}|{exit}")).unwrap();
    }

    /// Ends a job: out of the queue, with an accounting record.
    pub fn finish(&self, id: &str, state: &str, exit: &str) {
        self.account(id, state, exit);
        self.leave_queue(id);
    }

    /// Every logged call.
    pub fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.state.join("calls"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// Ids passed to `scancel`.
    pub fn cancelled(&self) -> Vec<String> {
        std::fs::read_to_string(self.state.join("cancelled"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// A file sbatch kept for a job (`script`, `env`).
    pub fn kept(&self, id: &str, name: &str) -> String {
        std::fs::read_to_string(self.job(id).join(name)).unwrap()
    }

    /// Path of a mode file, for executable hooks.
    pub fn mode_path(&self, name: &str) -> PathBuf {
        self.state.join("mode").join(name)
    }
}
