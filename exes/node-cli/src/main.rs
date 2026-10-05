use std::env;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

struct Installation {
    tool: String,
    node: PathBuf,
    entry: PathBuf,
    models: PathBuf,
}

fn tool_name(executable: &Path) -> Option<String> {
    let stem = executable.file_stem()?.to_str()?;
    let valid = !stem.is_empty()
        && stem
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-');
    valid.then(|| stem.to_string())
}

fn model_variable(tool: &str) -> String {
    format!(
        "NEURODESK_{}_MODEL_DIR",
        tool.to_ascii_uppercase().replace('-', "_")
    )
}

fn installation() -> Result<Installation, String> {
    let executable =
        env::current_exe().map_err(|error| format!("cannot locate this executable: {error}"))?;
    let tool = tool_name(&executable)
        .ok_or_else(|| format!("cannot derive a tool name from {}", executable.display()))?;
    let root = executable
        .parent()
        .ok_or_else(|| format!("cannot locate the {tool} installation directory"))?;
    #[cfg(windows)]
    let node = root.join("runtime").join("node.exe");
    #[cfg(not(windows))]
    let node = root.join("runtime").join("node");
    let entry = root.join("app").join("bin").join(format!("{tool}.js"));
    if !node.is_file() {
        return Err(format!(
            "private Node runtime is missing: {}",
            node.display()
        ));
    }
    if !entry.is_file() {
        return Err(format!(
            "{tool} entry point is missing: {}",
            entry.display()
        ));
    }
    Ok(Installation {
        models: root.join("models"),
        tool,
        node,
        entry,
    })
}

fn main() {
    let installation = match installation() {
        Ok(installation) => installation,
        Err(error) => {
            eprintln!("Installation is incomplete: {error}");
            exit(1);
        }
    };
    let mut command = Command::new(&installation.node);
    command
        .arg(&installation.entry)
        .args(env::args_os().skip(1))
        .env(model_variable(&installation.tool), &installation.models)
        .env("NEURODESK_OFFLINE", "1");

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        eprintln!(
            "{} could not start its private runtime: {error}",
            installation.tool
        );
        exit(1);
    }

    #[cfg(windows)]
    match command.status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!(
                "{} could not start its private runtime: {error}",
                installation.tool
            );
            exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_name_is_the_executable_stem() {
        assert_eq!(
            tool_name(Path::new("/opt/syncro/syncro")).as_deref(),
            Some("syncro")
        );
        assert_eq!(
            tool_name(Path::new("syncro.exe")).as_deref(),
            Some("syncro")
        );
        assert_eq!(
            tool_name(Path::new("topofit.exe")).as_deref(),
            Some("topofit")
        );
    }

    #[test]
    fn unsafe_stems_are_rejected() {
        assert_eq!(tool_name(Path::new("/x/../")), None);
        assert_eq!(tool_name(Path::new("/x/top fit")), None);
        assert_eq!(tool_name(Path::new("/x/topofit.js.exe")), None);
    }

    #[test]
    fn model_directory_variable_keeps_the_syncro_name() {
        assert_eq!(model_variable("syncro"), "NEURODESK_SYNCRO_MODEL_DIR");
        assert_eq!(model_variable("topofit"), "NEURODESK_TOPOFIT_MODEL_DIR");
        assert_eq!(
            model_variable("brain-extraction"),
            "NEURODESK_BRAIN_EXTRACTION_MODEL_DIR"
        );
    }
}
