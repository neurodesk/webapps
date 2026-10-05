//! Filesystem-only result publication shared by native SynthSR and SynthSeg.

use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};

/// Stage every file, then publish each atomically in the caller's order.
///
/// Without `force`, hard links refuse existing destinations and a failed publish
/// removes only destinations created by this call. With `force`, earlier
/// replacements remain if a later rename fails. This is not a multi-file
/// transaction. Temporary cleanup is best effort, as in the native callers.
pub fn publish(files: &[(&Path, Vec<u8>)], force: bool) -> Result<(), String> {
    publish_with(files, force, |file, data| file.write_all(data))
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut temp = path.as_os_str().to_owned();
    temp.push(format!(".{}.partial", std::process::id()));
    PathBuf::from(temp)
}

// Keep failure injection private; production always uses File::write_all.
fn publish_with(
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
            let temp = temporary_path(path);
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| format!("Cannot write {}: {e}", temp.display()))?;
            // We own the temporary only after create_new succeeds. Track it
            // before writing, so even a partial write is cleaned up on error.
            temps.push(temp.clone());
            write(&mut file, data).map_err(|e| format!("Cannot write {}: {e}", temp.display()))?;
        }
        for ((path, _), temp) in files.iter().zip(&temps) {
            if force {
                fs::rename(temp, path)
            } else {
                fs::hard_link(temp, path)
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
    for temp in temps {
        let _ = fs::remove_file(temp);
    }
    result
}

#[cfg(test)]
mod tests;
