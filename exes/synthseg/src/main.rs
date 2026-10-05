// synthseg: SynthSeg 2.0 with ONNX Runtime (CPU) or native Metal, embedded model, no run-time dependencies.
#[cfg(target_os = "macos")]
mod metal;
mod nifti;
mod post;
mod volume;

use neurodesk_result_publish::publish;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::exit,
    time::Instant,
};

const MODEL: &[u8] = include_bytes!(env!("SYNTHSEG_MODEL_PATH"));
const MODEL_SHA256: &str = env!("SYNTHSEG_MODEL_SHA256");
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MODEL_NAME: &str = "synthseg_2.0 (FreeSurfer 8.1.0 synthseg_2.0.h5)";
const CITATION: &str = "Billot et al. (2023) SynthSeg: Segmentation of brain MRI scans of any contrast and resolution without retraining. Med Image Anal. PMID: 36857946";
const HELP: &str = "synthseg VERSION — SynthSeg 2.0 brain segmentation (ONNX Runtime / Metal)
Model: MODEL
Cite:  CITATION

Usage:
  synthseg [--i] INPUT.nii[.gz] [[--o] OUTPUT.nii[.gz]] [options]

Options:
  --threads N     CPU threads (default: SLURM_CPUS_PER_TASK, or all cores)
  --device DEV    cpu or metal (macOS); default DEFAULT
  --ct            Clip CT scans in Hounsfield units to [0, 80]
  --fast          Skip left–right averaging and topology postprocessing
  --force         Replace existing output and JSON sidecar
  --quiet         Suppress progress messages
  --self-check    Report build, model checksum and runtime, then exit
  --help, -h      Show this help
  --version, -v   Print the version

Output defaults to INPUT_synthseg.nii.gz (int32 FreeSurfer labels on the 1 mm grid).
A JSON sidecar records settings, model checksum, geometry and timings.
";

struct Args {
    input: PathBuf,
    output: Option<PathBuf>,
    threads: usize,
    ct: bool,
    fast: bool,
    force: bool,
    quiet: bool,
    device: String,
}

const DEFAULT_DEVICE: &str = if cfg!(target_os = "macos") {
    "metal"
} else {
    "cpu"
};
const DEVICES: &[&str] = if cfg!(target_os = "macos") {
    &["cpu", "metal"]
} else {
    &["cpu"]
};

fn default_threads() -> usize {
    std::env::var("SLURM_CPUS_PER_TASK")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        input: PathBuf::new(),
        output: None,
        threads: default_threads(),
        ct: false,
        fast: false,
        force: false,
        quiet: false,
        device: DEFAULT_DEVICE.into(),
    };
    let mut positional = Vec::new();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                print!(
                    "{}",
                    HELP.replace("VERSION", VERSION)
                        .replace("DEFAULT", DEFAULT_DEVICE)
                        .replace("MODEL", MODEL_NAME)
                        .replace("CITATION", CITATION)
                );
                exit(0);
            }
            "--version" | "-v" => {
                println!("{VERSION}");
                exit(0);
            }
            "--self-check" => self_check(),
            "--probe" => probe(&it.next().unwrap_or_default()),
            "--i" => a.input = it.next().map(PathBuf::from).ok_or("--i needs a path.")?,
            "--o" => a.output = Some(it.next().map(PathBuf::from).ok_or("--o needs a path.")?),
            "--ct" => a.ct = true,
            "--fast" => a.fast = true,
            "--force" => a.force = true,
            "--quiet" => a.quiet = true,
            "--threads" => {
                a.threads = it
                    .next()
                    .and_then(|s| s.parse().ok())
                    .filter(|&n| n > 0)
                    .ok_or("Threads must be a positive integer.")?
            }
            "--device" => {
                a.device = match it.next().as_deref() {
                    Some(d) if DEVICES.contains(&d) => d.into(),
                    _ => return Err(format!("Device must be one of {}.", DEVICES.join(", "))),
                }
            }
            s if s.starts_with('-') => return Err(format!("Unknown option {s}. See --help.")),
            _ => positional.push(PathBuf::from(arg)),
        }
    }
    if a.input.as_os_str().is_empty() {
        if positional.is_empty() {
            return Err("An input NIfTI path is required. See --help.".into());
        }
        a.input = positional.remove(0);
    }
    if a.output.is_none() {
        a.output = positional.pop();
    }
    if !positional.is_empty() {
        return Err("Too many arguments. See --help.".into());
    }
    Ok(a)
}

fn ort_version() -> String {
    format!("1.{}", ort::MINOR_VERSION) // ort is pinned, so the runtime version is fixed per build
}

// One backend per device. Adding a device means adding a variant here and in DEVICES.
enum Net {
    Ort(Session),
    #[cfg(target_os = "macos")]
    Metal(metal::Session),
}

impl Net {
    /// Softmax posteriors, channel-major (33 × voxels).
    fn run(&mut self, input: &[f32], dims: &[usize; 3]) -> Result<Vec<f32>, String> {
        let data = match self {
            Net::Ort(session) => ort_run(session, input, dims)?,
            #[cfg(target_os = "macos")]
            Net::Metal(session) => session.run(input)?,
        };
        if data.iter().any(|v| !v.is_finite()) {
            return Err("Inference produced non-finite output.".into());
        }
        Ok(data)
    }
}

fn create_session(threads: usize, device: &str, dims: [usize; 3]) -> Result<Net, String> {
    #[cfg(target_os = "macos")]
    if device == "metal" {
        return metal::Session::new(MODEL, dims).map(Net::Metal);
    }
    let _ = dims;
    ort_session(threads, device).map(Net::Ort)
}

fn ort_session(threads: usize, device: &str) -> Result<Session, String> {
    (|| {
        Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(threads)?
            .with_inter_threads(1)?
            .commit_from_memory(MODEL)
    })()
    .map_err(|e: ort::Error| format!("Cannot initialize ONNX Runtime ({device}): {e}"))
}

// Each device is probed in a child process so an aborting provider cannot take the report down.
fn self_check() -> ! {
    println!(
        "synthseg {VERSION}\ntarget: {}-{}\nmodel: synthseg-2.0.onnx sha256 {MODEL_SHA256} ({} bytes)\nonnxruntime: {}\ndefault device: {DEFAULT_DEVICE}",
        std::env::consts::ARCH,
        std::env::consts::OS,
        MODEL.len(),
        ort_version()
    );
    let exe = std::env::current_exe().expect("current executable");
    let mut cpu_ok = false;
    for device in DEVICES {
        let out = std::process::Command::new(&exe)
            .args(["--probe", device])
            .output();
        let status = match out {
            Ok(o) if o.status.success() => "ok".to_string(),
            Ok(o) => format!(
                "FAILED {}",
                String::from_utf8_lossy(&o.stderr)
                    .trim()
                    .lines()
                    .last()
                    .unwrap_or("aborted")
            ),
            Err(e) => format!("FAILED {e}"),
        };
        cpu_ok |= *device == "cpu" && status == "ok";
        println!("{device}: {status}");
    }
    exit(if cpu_ok { 0 } else { 1 })
}

fn probe(device: &str) -> ! {
    if !DEVICES.contains(&device) {
        eprintln!("unknown device {device}");
        exit(2)
    }
    match create_session(1, device, [32, 32, 32]) {
        Ok(_) => exit(0),
        Err(e) => {
            eprintln!("{e}");
            exit(1)
        }
    }
}

fn strip_nii(p: &Path) -> Option<String> {
    let s = p.to_str()?;
    let lower = s.to_ascii_lowercase();
    [".nii.gz", ".nii"]
        .iter()
        .find(|e| lower.ends_with(*e))
        .map(|e| s[..s.len() - e.len()].to_string())
}

fn same_file(a: &Path, canonical: &Path) -> bool {
    fs::canonicalize(a).ok().as_deref() == Some(canonical)
}

fn ort_run(session: &mut Session, input: &[f32], dims: &[usize; 3]) -> Result<Vec<f32>, String> {
    let shape = [1, 1, dims[0], dims[1], dims[2]];
    let name = session.inputs()[0].name().to_string();
    let tensor = Tensor::from_array((shape, input.to_vec())).map_err(|e| e.to_string())?;
    let outputs = session
        .run(ort::inputs![name.as_str() => tensor])
        .map_err(|e| format!("Inference failed: {e}"))?;
    let (out_shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    if out_shape.iter().map(|&d| d as usize).collect::<Vec<_>>()
        != [1, post::N, dims[0], dims[1], dims[2]]
    {
        return Err("Model output shape does not match the SynthSeg contract.".into());
    }
    Ok(data.to_vec())
}

fn run(a: &Args) -> Result<(), String> {
    let input = fs::canonicalize(&a.input)
        .map_err(|e| format!("Cannot read {}: {e}", a.input.display()))?;
    let output = match &a.output {
        Some(o) => o.clone(),
        None => PathBuf::from(
            strip_nii(&input).unwrap_or_else(|| input.to_string_lossy().into_owned())
                + "_synthseg.nii.gz",
        ),
    };
    let stem = strip_nii(&output).ok_or("Output must end with .nii or .nii.gz.")?;
    let report = PathBuf::from(stem + ".json");
    for path in [&output, &report] {
        if same_file(path, &input) {
            return Err("Output must not overwrite the input image.".into());
        }
        if path.exists() && !a.force {
            return Err(format!(
                "Output already exists: {}. Use --force to replace results.",
                path.display()
            ));
        }
    }
    let progress = |m: &str| {
        if !a.quiet {
            eprintln!("{m}")
        }
    };
    let started = Instant::now();
    let mut timings = serde_json::Map::new();
    let mut previous = Instant::now();
    let mut mark = |name: &str| {
        let now = Instant::now();
        timings.insert(
            name.into(),
            now.duration_since(previous).as_secs_f64().into(),
        );
        previous = now;
    };

    progress(&format!("synthseg {VERSION}, model {MODEL_NAME}\nIf you use this tool in a publication, please cite: {CITATION}"));
    progress("Reading NIfTI…");
    let bytes = fs::read(&input).map_err(|e| e.to_string())?;
    let vol = nifti::read(&bytes)?;
    mark("read");
    progress("Resampling to 1 mm, aligning and rescaling…");
    let prep = volume::prepare(&vol, a.ct)?;
    mark("preprocess");
    progress(&format!(
        "Prepared {} × {} × {} voxels",
        prep.padded[0], prep.padded[1], prep.padded[2]
    ));
    progress("Initializing inference…");
    let mut session = create_session(a.threads, &a.device, prep.padded)?;
    mark("initialize");
    progress("Segmenting…");
    let mut posteriors = session.run(&prep.input, &prep.padded)?;
    post::blur(&mut posteriors, &prep.padded, a.threads);
    if !a.fast {
        progress("Segmenting flipped image…");
        let mut flipped = session.run(&volume::flip_x(&prep.input, &prep.padded), &prep.padded)?;
        post::blur(&mut flipped, &prep.padded, a.threads);
        post::average_flipped(&mut posteriors, &flipped, &prep.padded);
    }
    mark("inference");
    drop(session);
    mark("release");
    progress("Postprocessing and saving labels…");
    let labels = post::labels(posteriors, &prep, a.fast);
    let out = volume::restore(&labels, &prep);
    let mut image = nifti::write(&out);
    if output
        .to_string_lossy()
        .to_ascii_lowercase()
        .ends_with(".gz")
    {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(&image)
            .and_then(|_| enc.finish())
            .map(|v| image = v)
            .map_err(|e| e.to_string())?;
    }
    mark("postprocess");

    let provenance = serde_json::json!({
        "package": "synthseg", "version": VERSION, "model": MODEL_NAME, "modelSha256": MODEL_SHA256, "citation": CITATION,
        "onnxRuntime": ort_version(), "executionProvider": a.device,
        "target": format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
        "threads": a.threads, "ct": a.ct, "fast": a.fast, "flip": !a.fast,
        "inputShape": vol.dims, "paddedShape": prep.padded, "outputShape": out.dims, "outputAffine": out.affine,
        "seconds": started.elapsed().as_secs_f64(), "timings": timings, "input": input, "output": output,
    });
    publish(
        &[
            (
                &report,
                (serde_json::to_string_pretty(&provenance).unwrap() + "\n").into_bytes(),
            ),
            (&output, image),
        ],
        a.force,
    )?;
    progress(&format!("Wrote {}", output.display()));
    Ok(())
}

fn main() {
    let a = parse_args().unwrap_or_else(|e| {
        eprintln!("synthseg: {e}");
        exit(2)
    });
    if let Err(e) = run(&a) {
        eprintln!("synthseg: {e}");
        exit(1);
    }
}
