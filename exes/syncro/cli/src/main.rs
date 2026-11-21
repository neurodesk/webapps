//! The `syncro` command line: the shared core over native processes and real files.

use neurodesk_pipeline_host::native::{Native, tool_path};
use neurodesk_pipeline_host::{Host, block_on};
use serde_json::{Value, json};
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
  --threads             threads for every tool (default: SLURM_CPUS_PER_TASK, else all cores)
  --device              where SynthSR and MindGrab run (default auto: each tool's fastest available)
  --keep-synth          also write the synthetic T1 (t1INPUT)
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
                a.threads = value()?
                    .parse()
                    .ok()
                    .filter(|&n| n > 0)
                    .ok_or("Threads must be a positive integer.")?
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

fn home() -> PathBuf {
    std::env::var_os("SYNCRO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let exe = std::env::current_exe().unwrap_or_default();
            let dir = exe.parent().unwrap_or(Path::new("."));
            // An archive's syncro sits at its root; an installed one in <home>/bin.
            if dir.file_name().is_some_and(|n| n == "bin") && !dir.join("bin").is_dir() {
                dir.parent().unwrap_or(dir).to_path_buf()
            } else {
                dir.to_path_buf()
            }
        })
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
            std::iter::once(PathBuf::from(ants)).chain(std::env::split_paths(&path)),
        );
        if let Ok(joined) = joined {
            // SAFETY: called once at startup, before any thread starts.
            unsafe { std::env::set_var("PATH", joined) };
        }
    }
}

fn version(tool: &str, path: &Path) -> String {
    let args: &[&str] = if tool == "brainchop-mindgrab" {
        &["--help"]
    } else {
        &["--version"]
    };
    let out = Command::new(path).args(args).output();
    let text = out
        .map(|o| {
            String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr)
        })
        .unwrap_or_default();
    match tool {
        // "BrainChop mindgrab: skull stripping in any modality (v0.1.20260923)"
        "brainchop-mindgrab" => text
            .split("(v")
            .nth(1)
            .and_then(|s| s.split(')').next())
            .map(String::from),
        _ => text
            .lines()
            .find(|l| !l.trim().is_empty())
            .map(|l| l.trim().to_string()),
    }
    .unwrap_or_else(|| "unknown".into())
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
                    json!({"path": p, "version": version(tool, &p), "sha256": sha256_file(&p)}),
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
    if Path::new(&out).exists() {
        if !a.resume {
            return Err("Output directory already exists. Choose a new directory or --resume an interrupted SYNcro run.".into());
        }
        if !Path::new(&out).join("work/syncro.json").is_file() {
            return Err(format!(
                "{out} is not an interrupted SYNcro run; --resume needs the output directory of one."
            ));
        }
    }
    // Tools run in the output directory, so commands.sh names work/... and the outputs as the browser does.
    std::fs::create_dir_all(&out).map_err(|e| format!("{out}: {e}"))?;
    std::env::set_current_dir(&out).map_err(|e| format!("{out}: {e}"))?;
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
        software: tools.clone(),
    };
    let mut provenance = block_on(pipeline::run(&host, &o, &|stage| eprintln!("[{stage}]")))?;
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
