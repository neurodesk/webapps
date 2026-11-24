//! The `syncro` command line: the shared core over native processes and real files.

use neurodesk_pipeline_host::native::{Native, tool_path};
use neurodesk_pipeline_host::{Host, block_on};
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use syncro_core::pipeline::{self, Device, Normalization, Options};

const USAGE: &str = "usage: syncro INPUT OUTPUT_DIR [--lesion FILE] [--pathological FILE] [--ct]
              [--normalization greedy|ants] [--threads N] [--device auto|cpu|metal|cuda]
              [--keep-synth] [--resume]
       syncro self-check

SYNcro normalizes a brain scan of any contrast to MNI152 space: SynthSR synthesizes a T1-weighted image,
MindGrab extracts its brain and Greedy (or ANTs SyN) registers it to the template; the scan, a pathological
modality and a lesion map follow the same transforms.

  --lesion FILE         binary lesion map on the primary scan's grid (or the pathological scan's)
  --pathological FILE   second modality (e.g. FLAIR), registered to the primary scan first
  --ct                  the primary scan is CT in Hounsfield units
  --normalization       greedy (default, the web app's method) or ants (ANTs SyN; needs ANTs on PATH or ANTSPATH)
  --threads             threads for every tool; 0 or omitted: SLURM_CPUS_PER_TASK, else every core
  --device              where SynthSR and MindGrab run (default auto: each tool's fastest available)
  --keep-synth          also write the synthetic T1 (t1INPUT)
  --heal                experimental: heal the lesion from the mirrored scan before SynthSR (heal builds only)
  --resume              reuse the steps an interrupted run with the same inputs finished

Tools are found in <home>/bin, then PATH (ANTs also in ANTSPATH); the template in <home>/templates
(home: $SYNCRO_HOME, else the executable's parent directory).";

/// Options the Node command line had, and what replaced them.
const REMOVED: [(&str, &str); 4] = [
    (
        "--brain-extractor",
        "MindGrab is SYNcro's only brain extractor",
    ),
    (
        "--cache-dir",
        "the models are built into the tools; there is nothing to download",
    ),
    ("--offline", "SYNcro always runs offline"),
    (
        "download-models",
        "the models are built into the tools; there is nothing to download",
    ),
];

const TEMPLATE: &str = "MNI152_T1_1mm_brain.nii.gz";

struct Args {
    input: String,
    output: String,
    lesion: Option<String>,
    pathological: Option<String>,
    ct: bool,
    normalization: Normalization,
    threads: usize,
    device: Device,
    keep_synth: bool,
    heal: bool,
    resume: bool,
}

fn default_threads() -> usize {
    std::env::var("SLURM_CPUS_PER_TASK")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
}

fn parse(argv: &[String]) -> Result<Args, String> {
    let mut positional = vec![];
    let mut a = Args {
        input: String::new(),
        output: String::new(),
        lesion: None,
        pathological: None,
        ct: false,
        normalization: Normalization::Greedy,
        threads: default_threads(),
        device: Device::Auto,
        keep_synth: false,
        heal: false,
        resume: false,
    };
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value = || {
            inline
                .clone()
                .or_else(|| it.next().cloned())
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        if let Some((_, why)) = REMOVED.iter().find(|(f, _)| *f == flag) {
            return Err(format!("{flag} was removed: {why}."));
        }
        match flag {
            "--lesion" => a.lesion = Some(value()?),
            "--pathological" => a.pathological = Some(value()?),
            "--ct" => a.ct = true,
            "--keep-synth" => a.keep_synth = true,
            #[cfg(feature = "heal")]
            "--heal" => a.heal = true,
            "--resume" => a.resume = true,
            "--normalization" => {
                a.normalization = match value()?.as_str() {
                    "greedy" => Normalization::Greedy,
                    "ants" => Normalization::Ants,
                    other => {
                        return Err(format!(
                            "--normalization must be greedy or ants, not {other}"
                        ));
                    }
                }
            }
            "--threads" => {
                // 0 asks for the automatic count, as omitting the option does.
                a.threads = match value()?.parse::<usize>() {
                    Ok(0) => default_threads(),
                    Ok(n) => n,
                    Err(_) => {
                        return Err("Threads must be 0 (automatic) or a positive integer.".into());
                    }
                }
            }
            "--device" => {
                a.device = match value()?.as_str() {
                    "auto" => Device::Auto,
                    "cpu" => Device::Cpu,
                    "metal" => Device::Metal,
                    "cuda" => Device::Cuda,
                    other => {
                        return Err(format!(
                            "--device must be auto, cpu, metal or cuda, not {other}"
                        ));
                    }
                }
            }
            f if f.starts_with('-') => return Err(format!("unknown option {f}")),
            _ => positional.push(arg.clone()),
        }
    }
    let [input, output] = <[String; 2]>::try_from(positional).map_err(|_| USAGE.to_string())?;
    (a.input, a.output) = (input, output);
    Ok(a)
}

// Absolute, because the run changes into the output directory.
fn home() -> PathBuf {
    let home = std::env::var_os("SYNCRO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let exe = std::env::current_exe().unwrap_or_default();
            #[cfg(target_os = "macos")]
            let exe = exe.canonicalize().unwrap_or(exe);
            let dir = exe.parent().unwrap_or(Path::new("."));
            // An archive's syncro sits at its root; an installed one in <home>/bin.
            if dir.file_name().is_some_and(|n| n == "bin") && !dir.join("bin").is_dir() {
                dir.parent().unwrap_or(dir).to_path_buf()
            } else {
                dir.to_path_buf()
            }
        });
    std::path::absolute(&home).unwrap_or(home)
}

fn tools(normalization: Normalization) -> Vec<&'static str> {
    let mut t = vec!["synthsr", "brainchop-mindgrab", "greedy-rs", "niimath"];
    if normalization == Normalization::Ants {
        t.extend(["antsRegistration", "antsApplyTransforms"]);
    }
    t
}

/// ANTs is not bundled: its usual install sets ANTSPATH, which the tools' search then includes.
fn search_path() {
    if let Some(ants) = std::env::var_os("ANTSPATH") {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let joined = std::env::join_paths(
            std::iter::once(std::path::absolute(&ants).unwrap_or_else(|_| PathBuf::from(&ants)))
                .chain(std::env::split_paths(&path)),
        );
        if let Ok(joined) = joined {
            // SAFETY: called once at startup, before any thread starts.
            unsafe { std::env::set_var("PATH", joined) };
        }
    }
}

fn version(tool: &str, path: &Path) -> Result<String, String> {
    let flag = match tool {
        "brainchop-mindgrab" | "antsApplyTransforms" => "--help",
        _ => "--version",
    };
    let output = Command::new(path)
        .arg(flag)
        .output()
        .map_err(|e| format!("{tool}: could not start {}: {e}", path.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "{tool}: {} {flag} failed ({}):\n{stdout}{stderr}",
            path.display(),
            output.status
        ));
    }
    let text = stdout.to_string() + &stderr;
    Ok(match tool {
        "brainchop-mindgrab" => text.split("(v").nth(1).and_then(|s| s.split(')').next()),
        "antsApplyTransforms" => None,
        _ => text.lines().map(str::trim).find(|line| !line.is_empty()),
    }
    .unwrap_or("unknown")
    .to_string())
}

fn sha256_file(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    std::fs::read(path).map_or_else(
        |_| "unreadable".into(),
        |b| {
            Sha256::digest(b)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        },
    )
}

/// Each tool's resolved path, version and SHA-256; an error names the missing ones.
fn find_tools(bin: &Path, normalization: Normalization) -> Result<Value, String> {
    let mut found = serde_json::Map::new();
    let mut missing = vec![];
    for tool in tools(normalization) {
        match tool_path(tool, bin) {
            Some(p) => {
                found.insert(
                    tool.into(),
                    json!({"path": p, "version": version(tool, &p)?, "sha256": sha256_file(&p)}),
                );
            }
            None => missing.push(tool),
        }
    }
    if missing.is_empty() {
        return Ok(Value::Object(found));
    }
    let ants = missing.iter().any(|t| t.starts_with("ants"));
    Err(format!(
        "SYNcro needs {} but cannot find {}. Tools are searched in {} and then PATH{}.",
        tools(normalization).join(", "),
        missing.join(", "),
        bin.display(),
        if ants {
            "; ANTs is not bundled: install it and add it to PATH or set ANTSPATH"
        } else {
            ""
        }
    ))
}

fn self_check() -> Result<(), String> {
    let home = home();
    let bin = home.join("bin");
    let template = home.join("templates").join(TEMPLATE);
    let tools = find_tools(&bin, Normalization::Greedy)?;
    let ants = find_tools(&bin, Normalization::Ants)
        .ok()
        .map(|t| t["antsRegistration"].clone());
    let report = json!({
        "syncro": env!("CARGO_PKG_VERSION"),
        "executable": std::env::current_exe().ok(),
        "home": home,
        "template": template.is_file().then_some(&template),
        "threads": default_threads(),
        "tools": tools,
        "ants": ants,
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    if !template.is_file() {
        return Err(format!("template not found: {}", template.display()));
    }
    Ok(())
}

fn absolute(p: &str) -> String {
    std::path::absolute(p).map_or_else(
        |_| p.to_string(),
        |a| a.to_string_lossy().replace('\\', "/"),
    )
}

fn start(a: Args) -> Result<(), String> {
    let home = home();
    let bin = home.join("bin");
    let template = home.join("templates").join(TEMPLATE);
    if !template.is_file() {
        return Err(format!("template not found: {}", template.display()));
    }
    for (what, path) in [
        ("input", Some(&a.input)),
        ("lesion", a.lesion.as_ref()),
        ("pathological scan", a.pathological.as_ref()),
    ] {
        if let Some(p) = path
            && !Path::new(p).is_file()
        {
            return Err(format!("The {what} {p} does not exist."));
        }
    }
    let tools = find_tools(&bin, a.normalization)?;
    let out = absolute(&a.output);
    let out_path = Path::new(&out);
    // Inputs resolve against the caller's directory, before the run changes into the output.
    let host = Native {
        bin,
        env: vec![],
        gpu_slots: 0,
        gpu_lock_dir: std::env::temp_dir(),
    };
    let o = Options {
        input: absolute(&a.input),
        lesion: a.lesion.as_deref().map(absolute),
        pathological: a.pathological.as_deref().map(absolute),
        template: absolute(&template.to_string_lossy()),
        work: "work".into(),
        out: String::new(),
        ct: a.ct,
        normalization: a.normalization,
        threads: a.threads,
        device: a.device,
        keep_synth: a.keep_synth,
        heal: a.heal,
        software: tools.clone(),
    };
    // Tools run in the output directory, so commands.sh names work/... and the outputs as the browser does.
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{out}: {e}"))?;
    }
    let created = match std::fs::create_dir(out_path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if !a.resume {
                return Err("Output directory already exists. Choose a new directory or --resume an interrupted SYNcro run.".into());
            }
            false
        }
        Err(e) => return Err(format!("{out}: {e}")),
    };
    if !created && !out_path.join("work/syncro.json").is_file() {
        return Err(format!(
            "{out} is not an interrupted SYNcro run; --resume needs the output directory of one."
        ));
    }
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(out_path.join(".syncro.lock"))
        .map_err(|e| format!("{out}: could not open the run lock: {e}"))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            return Err(format!(
                "{out}: another SYNcro process is using this directory."
            ));
        }
        Err(std::fs::TryLockError::Error(e)) => {
            return Err(format!("{out}: could not lock the run directory: {e}"));
        }
    }
    std::env::set_current_dir(&out).map_err(|e| format!("{out}: {e}"))?;
    let result = block_on(pipeline::run(&host, &o, &|stage| eprintln!("[{stage}]")));
    // Inputs refused before any record was written leave nothing behind, so the same command can run again.
    if result.is_err() && created && !Path::new("work/syncro.json").is_file() {
        let _ = std::env::set_current_dir(std::env::temp_dir());
        drop(lock);
        let _ = std::fs::remove_dir_all(&out);
    }
    let mut provenance = result?;
    provenance["device"] = json!(format!("{:?}", a.device).to_lowercase());
    provenance["tools"] = tools;
    provenance["input"] = json!(o.input);
    let text = serde_json::to_string_pretty(&provenance).unwrap() + "\n";
    block_on(host.write("provenance.json", text.as_bytes()))?;
    host.copy("work/commands.sh", "commands.sh")?;
    println!("{out}");
    Ok(())
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() || argv.iter().any(|a| a == "-h" || a == "--help") {
        println!("{USAGE}");
        return if argv.is_empty() {
            ExitCode::FAILURE
        } else {
            ExitCode::SUCCESS
        };
    }
    if argv.iter().any(|a| a == "--version") {
        println!("syncro {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    search_path();
    let result = match argv[0].as_str() {
        "self-check" => self_check(),
        _ => parse(&argv).and_then(start),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("syncro: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_threads_means_the_automatic_count() {
        let argv = |t: &str| ["in.nii", "out", "--threads", t].map(String::from);
        assert_eq!(parse(&argv("0")).unwrap().threads, default_threads());
        assert_eq!(parse(&argv("3")).unwrap().threads, 3);
        assert!(parse(&argv("-1")).is_err());
    }
}
