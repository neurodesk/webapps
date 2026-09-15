use std::env;
use std::path::PathBuf;
use std::process::{exit, Command};

fn installation_paths() -> Result<(PathBuf, PathBuf), String> {
    let executable =
        env::current_exe().map_err(|error| format!("cannot locate SYNcro: {error}"))?;
    let root = executable
        .parent()
        .ok_or_else(|| "cannot locate the SYNcro installation directory".to_string())?;
    #[cfg(windows)]
    let node = root.join("runtime").join("node.exe");
    #[cfg(not(windows))]
    let node = root.join("runtime").join("node");
    let entry = root.join("app").join("bin").join("syncro.js");
    if !node.is_file() {
        return Err(format!(
            "private Node runtime is missing: {}",
            node.display()
        ));
    }
    if !entry.is_file() {
        return Err(format!(
            "SYNcro entry point is missing: {}",
            entry.display()
        ));
    }
    Ok((node, entry))
}

fn main() {
    let (node, entry) = match installation_paths() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("SYNcro installation is incomplete: {error}");
            exit(1);
        }
    };
    let mut command = Command::new(node);
    let models = entry
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("models");
    command
        .arg(entry)
        .args(env::args_os().skip(1))
        .env("NEURODESK_SYNCRO_MODEL_DIR", models)
        .env("NEURODESK_OFFLINE", "1");

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        eprintln!("SYNcro could not start its private runtime: {error}");
        exit(1);
    }

    #[cfg(windows)]
    match command.status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("SYNcro could not start its private runtime: {error}");
            exit(1);
        }
    }
}
