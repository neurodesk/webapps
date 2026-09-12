// Parity with the pinned Python/JS contract (fixtures) and with saved goldens (real volumes).
#[path = "../src/nifti.rs"]
mod nifti;
#[path = "../src/volume.rs"]
mod volume;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/synthsr/test/fixtures")
        .join(name)
}

fn load(path: &Path) -> nifti::Volume<f32> {
    nifti::read(&fs::read(path).unwrap()).unwrap()
}

struct Diff {
    max: u8,
    mismatched: usize,
    total: usize,
    affine: f64,
}

fn compare(a: &nifti::Volume<f32>, b: &nifti::Volume<f32>) -> Diff {
    assert_eq!(a.dims, b.dims, "shape");
    let affine = a
        .affine
        .iter()
        .flatten()
        .zip(b.affine.iter().flatten())
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f64::max);
    let (mut max, mut mismatched) = (0u8, 0);
    for (x, y) in a.data.iter().zip(&b.data) {
        let d = (x - y).abs() as u8;
        max = max.max(d);
        mismatched += (d > 0) as usize;
    }
    Diff {
        max,
        mismatched,
        total: a.data.len(),
        affine,
    }
}

#[test]
fn python_parity_geometry_intensities_output() {
    for (name, ct) in [("anisotropic", false), ("permuted", false), ("ct", true)] {
        let prep = volume::prepare(&load(&fixture(&format!("{name}.nii.gz"))), ct).unwrap();
        assert_eq!(prep.padded, [32, 32, 32], "{name}");
        let expected: Vec<f32> = fs::read(fixture(&format!("{name}-input.bin")))
            .unwrap()
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&c| f32::from_le_bytes(c))
            .collect();
        let max = expected
            .iter()
            .zip(&prep.input)
            .map(|(e, a)| (e - a).abs())
            .fold(0.0, f32::max);
        assert!(max < 2e-6, "{name} preprocessing error {max}");
        let scaled: Vec<f32> = prep.input.iter().map(|v| v * 128.0).collect();
        let out = volume::finish(&scaled, &prep, true);
        let reference = load(&fixture(&format!("{name}-output.nii.gz")));
        let as_f32 = nifti::Volume {
            data: out.data.iter().map(|&v| v as f32).collect(),
            dims: out.dims,
            affine: out.affine,
        };
        let d = compare(&as_f32, &reference);
        assert!(
            d.affine < 2e-5 && d.max <= 1 && (d.mismatched as f64) / (d.total as f64) < 0.002,
            "{name} mismatches {}",
            d.mismatched
        );
        let reread = nifti::read(&nifti::write(&out)).unwrap();
        assert_eq!(reread.data, as_f32.data);
    }
}

#[test]
fn flip_is_an_involution() {
    let a: Vec<f32> = (0..24).map(|i| i as f32).collect();
    assert_eq!(
        volume::flip_input(&volume::flip_input(&a, &[2, 3, 4]), &[2, 3, 4]),
        a
    );
}

#[test]
fn rejects_corrupt_non_finite_flat_and_4d() {
    assert!(nifti::read(&[0u8; 10]).is_err());
    let mut v = nifti::Volume {
        data: vec![0f32; 8],
        dims: [2, 2, 2],
        affine: [[1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 1., 0.]],
    };
    assert!(volume::prepare(&v, false)
        .err()
        .unwrap()
        .contains("variation"));
    v.data[0] = 3.0;
    let bytes = nifti::write(&nifti::Volume {
        data: vec![0u8; 8],
        dims: v.dims,
        affine: v.affine,
    });
    let mut nan = bytes.clone();
    nan[70..72].copy_from_slice(&16i16.to_le_bytes());
    nan[72..74].copy_from_slice(&32i16.to_le_bytes());
    nan.truncate(352);
    nan.extend((0..8).flat_map(|i| if i == 0 { f32::NAN } else { 1.0 }.to_le_bytes()));
    assert!(nifti::read(&nan).err().unwrap().contains("non-finite"));

    // MATLAB commonly writes a spatially 3-D image as dim[0]=4, dim[4]=1.
    let mut singleton_four_d = bytes.clone();
    singleton_four_d[40..42].copy_from_slice(&4i16.to_le_bytes());
    assert!(nifti::read(&singleton_four_d).is_ok());

    let mut four_d = bytes;
    four_d[40..42].copy_from_slice(&4i16.to_le_bytes());
    four_d[48..50].copy_from_slice(&2i16.to_le_bytes());
    assert!(nifti::read(&four_d).err().unwrap().contains("3D"));
}

#[test]
fn scaling_and_meter_units_apply_once() {
    let v = nifti::Volume {
        data: (0..8).collect(),
        dims: [2, 2, 2],
        affine: [
            [0.001, 0., 0., 0.01],
            [0., 0.002, 0., -0.02],
            [0., 0., 0.003, 0.],
        ],
    };
    let mut b = nifti::write(&v);
    b[123] = 1;
    b[112..116].copy_from_slice(&2f32.to_le_bytes());
    b[116..120].copy_from_slice(&(-4f32).to_le_bytes());
    let r = nifti::read(&b).unwrap();
    assert_eq!(r.data[3], 2.0);
    assert!((r.affine[0][0] - 1.0).abs() < 1e-6 && (r.affine[0][3] - 10.0).abs() < 1e-6);
}

const DEVICES: &[&str] = if cfg!(target_os = "macos") {
    &["cpu", "webgpu", "metal"]
} else {
    &["cpu"]
};

// Accelerators absent on this host (a VM, CI) are skipped; cpu is always required.
fn available_devices() -> Vec<&'static str> {
    DEVICES
        .iter()
        .copied()
        .filter(|d| *d == "cpu" || run(&["--probe", d]).status.success())
        .collect()
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_synthsr"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn cli_matches_reference_and_refuses_to_clobber() {
    let dir = std::env::temp_dir().join(format!("synthsr-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let input = fixture("validation.nii.gz");
    let input = input.to_str().unwrap();
    for device in available_devices() {
        let out = dir.join(format!("{device}.nii.gz"));
        let out = out.to_str().unwrap();
        let r = run(&[input, out, "--threads", "2", "--quiet", "--device", device]);
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        let d = compare(
            &load(Path::new(out)),
            &load(&fixture("validation-reference.nii.gz")),
        );
        assert!(
            d.max <= 1 && (d.mismatched as f64) / (d.total as f64) < 0.001,
            "{device} mismatches {}",
            d.mismatched
        );
        let report: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(format!("{device}.json"))).unwrap())
                .unwrap();
        assert_eq!(report["threads"], 2);
        assert_eq!(report["flip"], true);
        assert_eq!(report["executionProvider"], device);
        assert_eq!(
            report["modelSha256"],
            "276151128c666f81eba80a6afb7f307aa3c7d58825748029ba67cf170f1460a3"
        );
        assert!(report["timings"]["inference"].as_f64().unwrap() > 0.0);
        assert!(report["onnxRuntime"].as_str().unwrap().starts_with("1."));
        let r = run(&[input, out, "--quiet"]);
        assert!(
            !r.status.success() && String::from_utf8_lossy(&r.stderr).contains("already exists")
        );
        let r = run(&[
            input,
            out,
            "--quiet",
            "--force",
            "--no-flip",
            "--no-sharpen",
            "--threads",
            "2",
            "--device",
            device,
        ]);
        assert!(r.status.success());
    }
    assert!(!run(&[input, input, "--force"]).status.success());
    assert!(!run(&[input, "--device", "cuda"]).status.success());
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn self_check_runs_offline() {
    let r = run(&["--self-check"]);
    assert!(r.status.success());
    assert!(String::from_utf8_lossy(&r.stdout).contains("cpu: ok"));
}

#[test]
fn help_names_model_and_citation() {
    let r = run(&["--help"]);
    let help = String::from_utf8_lossy(&r.stdout);
    assert!(r.status.success());
    assert!(help.contains("Model: synthsr_v20_230130"));
    assert!(help.contains("Iglesias et al. (2023)"));
    assert!(help.contains("PMID: 36724222"));
}

// `SYNTHSR_REFERENCE_DIR=... cargo test --release -- --ignored real_volumes` (make test-real).
// Gates: identical shape, affine <= 4e-6 mm, max uint8 error <= 1, mismatched voxels <= 0.1% (the tolerance used by the JS suites).
#[test]
#[ignore]
fn real_volumes() {
    let dir = PathBuf::from(std::env::var("SYNTHSR_REFERENCE_DIR").expect("SYNTHSR_REFERENCE_DIR"));
    let out_dir = dir.join("synthsr");
    fs::create_dir_all(&out_dir).unwrap();
    let mut report = Vec::new();
    let mut failures = Vec::new();
    let manifest = fs::read_to_string(dir.join("manifest.jsonl")).unwrap();
    for (device, line) in available_devices()
        .into_iter()
        .flat_map(|d| manifest.lines().map(move |l| (d, l)))
    {
        let entry: serde_json::Value = serde_json::from_str(line).unwrap();
        let (input, reference) = (
            entry["input"].as_str().unwrap(),
            entry["reference"].as_str().unwrap(),
        );
        let stem = Path::new(reference)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .replace("_node.nii.gz", "")
            .replace("_fs.nii.gz", "");
        let out = out_dir.join(format!("{stem}_{device}.nii.gz"));
        let mut args = vec![
            input,
            out.to_str().unwrap(),
            "--quiet",
            "--force",
            "--device",
            device,
        ];
        if entry["ct"] == true {
            args.push("--ct");
        }
        let r = run(&args);
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        let d = compare(&load(&out), &load(Path::new(reference)));
        let fraction = d.mismatched as f64 / d.total as f64;
        let limit = 1e-3; // the repository-wide tolerance (packages/synthsr tests)
        let pass = d.affine <= 4e-6 && d.max <= 1 && fraction <= limit;
        let sidecar: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(out.with_extension("").with_extension("json")).unwrap(),
        )
        .unwrap();
        report.push(serde_json::json!({ "device": device, "input": input, "reference": reference, "max_uint8_error": d.max, "mismatched_voxels": d.mismatched,
            "compared_voxels": d.total, "mismatch_fraction": fraction, "max_affine_error_mm": d.affine, "seconds": sidecar["seconds"], "pass": pass }));
        if !pass {
            failures.push(format!("{device} {reference}"));
        }
    }
    let summary = serde_json::json!({ "scope": "Engineering parity on named hardware; not clinical validation", "onnxRuntime": ort_version(), "host": host(), "results": report });
    fs::write(
        dir.join("report.json"),
        serde_json::to_string_pretty(&summary).unwrap() + "\n",
    )
    .unwrap();
    assert!(failures.is_empty(), "failed gates: {failures:?}");
}

fn ort_version() -> String {
    let out = run(&["--self-check"]).stdout;
    String::from_utf8_lossy(&out)
        .lines()
        .find_map(|l| l.strip_prefix("onnxruntime: ").map(String::from))
        .unwrap_or_default()
}

fn host() -> String {
    let cpu = Command::new("sysctl")
        .args(["-n", "machdep.cpu.brand_string"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    format!(
        "{} {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        cpu
    )
}
