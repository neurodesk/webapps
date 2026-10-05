// synthsr: SynthSR v2 with ONNX Runtime, embedded model, no run-time dependencies.
#[cfg(target_os = "macos")]
mod metal;
mod nifti;
mod volume;

use neurodesk_result_publish::publish;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use sha2::Digest;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::exit,
    time::Instant,
};

const MODEL: &[u8] = include_bytes!(env!("SYNTHSR_MODEL_PATH"));
const MODEL_SHA256: &str = env!("SYNTHSR_MODEL_SHA256");
const MODEL_NAME: &str = "synthsr_v20_230130";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const HELP: &str = "synthsr VERSION — SynthSR v2 brain image synthesis (ONNX Runtime, CPU)

Model: MODEL_NAME (general model, January 2023, version 2)
Cite: Iglesias et al. (2023). SynthSR: A public AI tool to turn heterogeneous clinical brain scans into high-resolution T1-weighted images for 3D morphometry. Science Advances 9(5):eadd3607. PMID: 36724222.

Usage:
  synthsr INPUT.nii[.gz] [OUTPUT.nii[.gz]] [options]

Options:
  --threads N     CPU threads (default: SLURM_CPUS_PER_TASK, or all cores)
  --device DEV    cpu, webgpu (ORT WebGPU EP) or metal (native, macOS); default DEFAULT
  --ct            Input is CT in Hounsfield units
  --no-flip       Disable left–right averaging (default: enabled)
  --no-sharpen    Disable sharpening (default: enabled)
  --force         Replace existing output and JSON sidecar
  --quiet         Suppress progress messages
  --self-check    Report build, model checksum and runtime, then exit
  --help, -h      Show this help
  --version, -v   Print the version

Output defaults to INPUT_synthsr.nii.gz. A JSON sidecar records settings,
model checksum, geometry and timings. Synthetic images can alter lesions;
no skull stripping or spatial normalization is performed.
";

struct Args {
    input: PathBuf,
    output: Option<PathBuf>,
    threads: usize,
    ct: bool,
    flip: bool,
    sharpen: bool,
    force: bool,
    quiet: bool,
    device: String,
}

// Native Metal runs the webapp's blocked FP32 kernels: 2.6x faster than CPU on an M4 Pro.
// ORT's WebGPU EP is 4-5x slower than CPU with ORT 1.28's Conv3D kernel, so it stays opt-in.
const DEFAULT_DEVICE: &str = if cfg!(target_os = "macos") {
    "metal"
} else {
    "cpu"
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
        flip: true,
        sharpen: true,
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
                        .replace("MODEL_NAME", MODEL_NAME)
                        .replace("DEFAULT", DEFAULT_DEVICE)
                );
                exit(0);
            }
            "--version" | "-v" => {
                println!("{VERSION}");
                exit(0);
            }
            "--self-check" => self_check(),
            "--probe" => probe(&it.next().unwrap_or_default()),
            "--ct" => a.ct = true,
            "--no-flip" => a.flip = false,
            "--no-sharpen" => a.sharpen = false,
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
    match positional.len() {
        0 => return Err("An input NIfTI path is required. See --help.".into()),
        1 | 2 => {}
        _ => return Err("Too many arguments. See --help.".into()),
    }
    a.input = positional.remove(0);
    a.output = positional.pop();
    Ok(a)
}

fn ort_version() -> String {
    // ort::info() looks like "ORT Build Info: git-branch=rel-1.28.0, git-commit-id=..."
    ort::info()
        .split("git-branch=rel-")
        .nth(1)
        .and_then(|s| s.split(',').next())
        .map(String::from)
        .unwrap_or_else(|| format!("1.{}", ort::MINOR_VERSION))
}

const DEVICES: &[&str] = if cfg!(target_os = "macos") {
    &["cpu", "webgpu", "metal"]
} else {
    &["cpu", "webgpu"]
};

// One backend per device. Adding a device means adding a variant here and in DEVICES.
enum Net {
    Ort(Session),
    #[cfg(target_os = "macos")]
    Metal(metal::Session),
}

impl Net {
    fn run(&mut self, input: &[f32], dims: &[usize; 3]) -> Result<Vec<f32>, String> {
        let mut data = match self {
            Net::Ort(session) => ort_run(session, input, dims)?,
            #[cfg(target_os = "macos")]
            Net::Metal(session) => session.run(input)?,
        };
        for v in &mut data {
            if !v.is_finite() {
                return Err("Inference produced non-finite output.".into());
            }
            *v = (255.0 * *v as f64).clamp(0.0, 128.0) as f32;
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

// A requested provider must register (error_on_failure) and hold the whole graph
// (no CPU fallback), so a run never silently degrades to a different device.
fn ort_session(threads: usize, device: &str) -> Result<Session, String> {
    (|| {
        let mut b = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(threads)?
            .with_inter_threads(1)?;
        if device == "webgpu" {
            b = b
                .with_execution_providers([ort::ep::WebGPU::default().build().error_on_failure()])?
                .with_disable_cpu_fallback()?;
        }
        b.commit_from_memory(MODEL)
    })()
    .map_err(|e: ort::Error| format!("Cannot initialize ONNX Runtime ({device}): {e}"))
}

// Each device is probed in a child process: a provider that aborts (an uncaught
// C++ exception in ORT, a missing GPU) must not take the report down with it.
// Exit status follows the CPU baseline only; accelerators are reported, not required.
fn self_check() -> ! {
    println!(
        "synthsr {VERSION}\ntarget: {}-{}\nmodel: synthsr-v2.onnx sha256 {MODEL_SHA256} ({} bytes)\nonnxruntime: {}\ndefault device: {DEFAULT_DEVICE}",
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

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", sha2::Sha256::digest(bytes))
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
    if out_shape.iter().map(|&d| d as usize).collect::<Vec<_>>() != shape {
        return Err("Model output shape does not match the SynthSR contract.".into());
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
                + "_synthsr.nii.gz",
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

    progress("Reading NIfTI…");
    let bytes = fs::read(&input).map_err(|e| e.to_string())?;
    let vol = nifti::read(&bytes)?;
    mark("read");
    progress("Resampling to 1 mm and preparing intensities…");
    let prep = volume::prepare(&vol, a.ct)?;
    mark("preprocess");
    progress(&format!(
        "Prepared {} × {} × {} voxels",
        prep.padded[0], prep.padded[1], prep.padded[2]
    ));
    mark("model");
    progress("Initializing inference…");
    let mut session = create_session(a.threads, &a.device, prep.padded)?;
    mark("initialize");
    progress("Synthesizing volume… this can take several minutes");
    let mut result = session.run(&prep.input, &prep.padded)?;
    if a.flip {
        progress("Synthesizing flipped image…");
        let flipped = session.run(&volume::flip_input(&prep.input, &prep.padded), &prep.padded)?;
        let (d0, slab) = (prep.padded[0], prep.padded[1] * prep.padded[2]);
        for x in 0..d0 {
            for i in 0..slab {
                result[x * slab + i] = (0.5
                    * (result[x * slab + i] as f64 + flipped[(d0 - 1 - x) * slab + i] as f64))
                    as f32;
            }
        }
    }
    mark("inference");
    drop(session);
    mark("release");
    progress("Restoring orientation and saving synthetic T1…");
    let out = volume::finish(&result, &prep, a.sharpen);
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

    let exe_hash = std::env::current_exe()
        .and_then(fs::read)
        .map(|b| sha256_hex(&b))
        .unwrap_or_default();
    let provenance = serde_json::json!({
        "package": "synthsr", "version": VERSION, "model": MODEL_NAME, "modelSha256": MODEL_SHA256,
        "app": format!("synthsr {VERSION}"), "executableSha256": exe_hash, "onnxRuntime": ort_version(),
        "executionProvider": a.device, "target": format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
        "threads": a.threads, "ct": a.ct, "tiled": false, "flip": a.flip, "sharpen": a.sharpen, "backend": a.device,
        "inputShape": vol.dims, "outputShape": out.dims, "outputAffine": out.affine, "spacingMm": [1, 1, 1],
        "seconds": started.elapsed().as_secs_f64(), "timings": timings, "synthetic": true,
        "input": input, "output": output,
    });
    publish(
        &[
            (&output, image),
            (
                &report,
                (serde_json::to_string_pretty(&provenance).unwrap() + "\n").into_bytes(),
            ),
        ],
        a.force,
    )?;
    progress(&format!("Wrote {}", output.display()));
    Ok(())
}

fn main() {
    let a = parse_args().unwrap_or_else(|e| {
        eprintln!("synthsr: {e}");
        exit(2)
    });
    if let Err(e) = run(&a) {
        eprintln!("synthsr: {e}");
        exit(1);
    }
}
