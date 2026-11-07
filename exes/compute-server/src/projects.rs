//! Projects: one RELION project directory each, `<data-dir>/projects/<id>/`.
//! Their records live outside it, in `<data-dir>/project-records/<id>.json`,
//! because jobs can write anywhere in the project directory.

use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::jobs::model::OutputInfo;

/// A project and its job counter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// 32 lowercase hex digits.
    pub id: String,
    /// Display name.
    pub name: String,
    /// RFC 3339 creation time.
    pub created_at: String,
    /// Job directories allocated so far; the next job is `jobNNN` with NNN one more.
    pub allocated: u32,
    /// Deletion has started; recovery finishes it.
    #[serde(default)]
    pub deleted: bool,
}

impl Project {
    /// A new project named `name`.
    pub fn new(id: String, name: String, created_at: DateTime<Utc>) -> Project {
        Project {
            id,
            name,
            created_at: created_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            allocated: 0,
            deleted: false,
        }
    }
}

/// Where projects and their records live.
#[derive(Debug, Clone)]
pub struct ProjectDirs {
    /// `<data-dir>/projects`.
    pub projects: PathBuf,
    /// `<data-dir>/project-records`.
    pub records: PathBuf,
}

impl ProjectDirs {
    /// The directories under a data directory.
    pub fn new(data_dir: &Path) -> ProjectDirs {
        ProjectDirs {
            projects: data_dir.join("projects"),
            records: data_dir.join("project-records"),
        }
    }

    /// The project directory, mounted at `/project` in its jobs.
    pub fn project(&self, id: &str) -> PathBuf {
        self.projects.join(id)
    }

    fn record(&self, id: &str) -> PathBuf {
        self.records.join(format!("{id}.json"))
    }

    /// Writes a project record atomically.
    pub fn persist(&self, project: &Project) -> io::Result<()> {
        crate::durable::write(&self.record(&project.id), project)
    }

    /// Removes a project's directory and then its record.
    pub fn remove(&self, id: &str) -> io::Result<()> {
        remove_if_present(&self.project(id))?;
        match std::fs::remove_file(self.record(id)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    /// Every project record.
    pub fn load(&self) -> io::Result<Vec<Project>> {
        std::fs::create_dir_all(&self.records)?;
        std::fs::create_dir_all(&self.projects)?;
        let mut projects = Vec::new();
        for entry in std::fs::read_dir(&self.records)? {
            let path = entry?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let project: Project = serde_json::from_slice(&std::fs::read(&path)?)?;
            if path.file_stem().and_then(|stem| stem.to_str()) != Some(project.id.as_str()) {
                return Err(io::Error::other("project record name mismatch"));
            }
            projects.push(project);
        }
        Ok(projects)
    }
}

/// Removes a directory tree; a missing directory is not an error.
pub fn remove_if_present(path: &Path) -> io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Project ids are 32 lowercase hex digits.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Names are 1 to 100 characters without control characters.
pub fn validate_name(name: &str) -> Result<(), String> {
    let count = name.chars().count();
    if count == 0 || count > 100 {
        return Err("project name must be 1 to 100 characters".into());
    }
    if name.chars().any(char::is_control) {
        return Err("project name must not contain control characters".into());
    }
    Ok(())
}

/// Every regular file under a job directory, recursively, sorted by its
/// project-relative name. A symlink is listed only when its canonical target
/// is a file inside the job directory. Files above `max_download` carry
/// `download: false`.
pub fn list_outputs(
    project_dir: &Path,
    directory: &str,
    max_download: u64,
) -> io::Result<Vec<OutputInfo>> {
    let job_dir = project_dir.join(directory).canonicalize()?;
    let mut outputs = Vec::new();
    let mut pending = vec![(job_dir.clone(), directory.to_string())];
    while let Some((dir, name)) = pending.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let Ok(file_name) = entry.file_name().into_string() else {
                continue;
            };
            let child = format!("{name}/{file_name}");
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                pending.push((entry.path(), child));
                continue;
            }
            let metadata = if file_type.is_symlink() {
                match entry.path().canonicalize() {
                    Ok(target) if target.starts_with(&job_dir) => std::fs::metadata(target)?,
                    _ => continue,
                }
            } else {
                entry.metadata()?
            };
            if !metadata.is_file() {
                continue;
            }
            outputs.push(OutputInfo {
                content_type: content_type(&file_name).to_string(),
                download: Some(metadata.len() <= max_download),
                bytes: metadata.len(),
                name: child,
            });
        }
    }
    outputs.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    Ok(outputs)
}

/// The MIME type served for a project file.
pub fn content_type(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map(|(_, extension)| extension);
    match extension.map(str::to_ascii_lowercase).as_deref() {
        Some("json") => "application/json",
        Some("star" | "txt" | "out" | "err" | "log" | "sbatch") => "text/plain",
        Some("png") => "image/png",
        Some("pdf") => "application/pdf",
        Some("eps") => "application/postscript",
        Some("gz") => "application/gzip",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn ids_and_names() {
        assert!(valid_id(&"a".repeat(32)));
        assert!(!valid_id(&"A".repeat(32)));
        assert!(!valid_id("../x"));
        assert!(validate_name("Apoferritin grid 3").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name(&"x".repeat(101)).is_err());
        assert!(validate_name("a\nb").is_err());
    }

    #[test]
    fn outputs_are_recursive_sorted_and_contained() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let job = project.path().join("Class2D/job006");
        std::fs::create_dir_all(job.join("sub")).unwrap();
        std::fs::create_dir_all(project.path().join("Import/job001")).unwrap();
        std::fs::write(project.path().join("Import/job001/movies.star"), "x").unwrap();
        std::fs::write(job.join("run_it200_classes.mrcs"), vec![0u8; 10]).unwrap();
        std::fs::write(job.join("sub/log.txt"), "hello").unwrap();
        std::fs::write(outside.path().join("secret"), "s").unwrap();
        symlink(job.join("sub/log.txt"), job.join("inside-link")).unwrap();
        symlink(outside.path().join("secret"), job.join("escape-link")).unwrap();
        symlink(
            project.path().join("Import/job001/movies.star"),
            job.join("sibling-link"),
        )
        .unwrap();
        symlink(outside.path(), job.join("escape-dir")).unwrap();
        let outputs = list_outputs(project.path(), "Class2D/job006", 6).unwrap();
        let names: Vec<&str> = outputs.iter().map(|output| output.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Class2D/job006/inside-link",
                "Class2D/job006/run_it200_classes.mrcs",
                "Class2D/job006/sub/log.txt",
            ]
        );
        assert_eq!(outputs[0].download, Some(true));
        assert_eq!(outputs[1].download, Some(false));
        assert_eq!(outputs[2].content_type, "text/plain");
    }
}
