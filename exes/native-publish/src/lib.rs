use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

/// Stage every buffer before publishing destinations in caller order.
/// Without force, refuse existing destinations and roll back destinations created
/// by this call on failure. With force, use native rename semantics and retain
/// earlier replacements on later failure. Created directories remain.
/// Temporary cleanup is best effort and never replaces an operation error.
pub fn publish(files: &[(&Path, Vec<u8>)], force: bool) -> Result<(), String> {
    publish_with_writer(files, force, |file, data| file.write_all(data))
}

struct Temporary {
    path: PathBuf,
}

impl Temporary {
    fn create(destination: &Path) -> Result<(Self, File), String> {
        let mut name = destination.as_os_str().to_owned();
        name.push(format!(".{}.partial", std::process::id()));
        let path = PathBuf::from(name);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
        Ok((Self { path }, file))
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn publish_with_writer(
    files: &[(&Path, Vec<u8>)],
    force: bool,
    mut write: impl FnMut(&mut File, &[u8]) -> io::Result<()>,
) -> Result<(), String> {
    let mut temps = Vec::new();
    let mut published = Vec::new();
    let result = (|| {
        for (path, data) in files {
            if let Some(dir) = path.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let (temp, file) = Temporary::create(path)?;
            let stage = || {
                let mut file = file;
                write(&mut file, data)
            };
            let result = stage();
            result.map_err(|e| format!("Cannot write {}: {e}", temp.path.display()))?;
            temps.push(temp);
        }
        for ((path, _), temp) in files.iter().zip(&temps) {
            if force {
                fs::rename(&temp.path, path)
            } else {
                fs::hard_link(&temp.path, path)
            }
            .map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
            published.push(path);
        }
        Ok(())
    })();
    if result.is_err() && !force {
        for path in published {
            let _ = fs::remove_file(path);
        }
    }
    result
}

#[cfg(test)]
mod tests;
