// Parity with the FreeSurfer 8.1.0 mri_synthseg reference.
#[path = "../src/nifti.rs"]
mod nifti;
#[allow(dead_code)]
#[path = "../src/volume.rs"]
mod volume;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// A gate from packages/synthseg/validation/gates.json, which the Node pipeline test, the web app's
/// fixture e2e and the portable command line's release check read too.
fn gate_value(path: &[&str]) -> f64 {
    let gates: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/synthseg/validation/gates.json"
    ))
    .unwrap();
    path.iter()
        .fold(&gates, |value, key| &value[*key])
        .as_f64()
        .unwrap()
}

fn load(path: &Path) -> nifti::Volume<f64> {
    nifti::read(&fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

/// Little-endian float32 .npy payload (v1 header), ignoring shape.
fn npy_f32(path: &Path) -> Vec<f32> {
    let b = fs::read(path).unwrap();
    let hlen = u16::from_le_bytes([b[8], b[9]]) as usize + 10;
    b[hlen..]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect()
}

struct Diff {
    mismatched: usize,
    total: usize,
    affine: f64,
}

fn compare(a: &nifti::Volume<f64>, b: &nifti::Volume<f64>) -> Diff {
    assert_eq!(a.dims, b.dims, "shape");
    let affine = a
        .affine
        .iter()
        .flatten()
        .zip(b.affine.iter().flatten())
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f64::max);
    let mismatched = a.data.iter().zip(&b.data).filter(|(x, y)| x != y).count();
    Diff {
        mismatched,
        total: a.data.len(),
        affine,
    }
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_synthseg"))
        .args(args)
        .output()
        .unwrap()
}

const DEVICES: &[&str] = if cfg!(target_os = "macos") {
    &["cpu", "metal"]
} else {
    &["cpu"]
};

fn available_devices() -> Vec<&'static str> {
    DEVICES
        .iter()
        .copied()
        .filter(|d| *d == "cpu" || run(&["--probe", d]).status.success())
        .collect()
}

#[test]
fn flip_is_an_involution() {
    let a: Vec<f32> = (0..24).map(|i| i as f32).collect();
    assert_eq!(
        volume::flip_x(&volume::flip_x(&a, &[2, 3, 4]), &[2, 3, 4]),
        a
    );
}

#[test]
fn nifti_roundtrip_and_rejections() {
    assert!(nifti::read(&[0u8; 10]).is_err());
    let v = nifti::Volume {
        data: (0..8).collect(),
        dims: [2, 2, 2],
        pixdim: [1.0; 3],
        affine: [[1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 1., 0.]],
        codes: [1, 1],
        units: 10,
    };
    let bytes = nifti::write(&v);
    let r = nifti::read(&bytes).unwrap();
    assert_eq!(r.data, (0..8).map(|i| i as f64).collect::<Vec<_>>());
    assert_eq!(r.affine, v.affine);
    assert_eq!((r.codes, r.units), (v.codes, v.units));
    // Hardening: bad vox_offset, non-finite slope is "unscaled", oversized dims are refused early.
    let mut bad = bytes.clone();
    bad[108..112].copy_from_slice(&(-1e30f32).to_le_bytes());
    assert!(nifti::read(&bad).err().unwrap().contains("vox_offset"));
    let mut nan_slope = bytes.clone();
    nan_slope[112..116].copy_from_slice(&f32::NAN.to_le_bytes());
    assert_eq!(nifti::read(&nan_slope).unwrap().data, r.data);
    let mut oversized_header = bytes.clone();
    oversized_header[40..42].copy_from_slice(&(4i16).to_le_bytes());
    for offset in [42, 44, 46, 48] {
        oversized_header[offset..offset + 2].copy_from_slice(&(i16::MAX).to_le_bytes());
    }
    assert!(nifti::read(&oversized_header)
        .err()
        .unwrap()
        .contains("Unsupported image dimensions"));
    let huge = nifti::Volume {
        data: vec![0i32; 8],
        dims: [2, 2, 2],
        pixdim: [1.0; 3],
        affine: v.affine,
        codes: [1, 1],
        units: 10,
    };
    let mut huge_bytes = nifti::write(&huge);
    huge_bytes[42..44].copy_from_slice(&(2i16).to_le_bytes());
    let mut fake = nifti::read(&huge_bytes).unwrap();
    fake.dims = [640, 640, 640];
    assert!(volume::prepare(&fake, false)
        .err()
        .unwrap()
        .contains("too large"));
}

/// Decompressed NIfTI header bytes.
fn header(path: &Path) -> Vec<u8> {
    let mut v = Vec::new();
    std::io::Read::read_to_end(
        &mut flate2::read::MultiGzDecoder::new(&fs::read(path).unwrap()[..]),
        &mut v,
    )
    .unwrap();
    v.truncate(352);
    v
}

/// qform/sform codes, units and quaternion match the FreeSurfer output (the reader uses only the sform).
fn assert_header_matches(out: &Path, reference: &Path) {
    let (a, b) = (header(out), header(reference));
    assert_eq!(a[252..256], b[252..256], "qform/sform codes");
    assert_eq!(a[123], b[123], "xyzt_units");
    for o in (76..80).chain(256..280).step_by(4) {
        let f = |h: &[u8]| f32::from_le_bytes(h[o..o + 4].try_into().unwrap());
        assert!(
            f64::from((f(&a) - f(&b)).abs()) <= gate_value(&["maxQuaternionError"]),
            "quaternion field at {o}: {} vs {}",
            f(&a),
            f(&b)
        );
    }
}

// Gate: identical geometry; label mismatches below the recorded fraction (fp32 accumulation order).
fn gate(out: &Path, reference: &Path, limit: f64) {
    assert_header_matches(out, reference);
    let d = compare(&load(out), &load(reference));
    let fraction = d.mismatched as f64 / d.total as f64;
    assert!(
        d.affine <= gate_value(&["maxAffineErrorMm"]) && fraction <= limit,
        "{}: affine {} mismatched {} of {} ({fraction:.5})",
        out.display(),
        d.affine,
        d.mismatched,
        d.total
    );
}

#[test]
fn cli_matches_fixture_and_refuses_to_clobber() {
    let dir = std::env::temp_dir().join(format!("synthseg-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let input = root().join("test/fixtures/small.nii.gz");
    let input = input.to_str().unwrap();
    for device in available_devices() {
        for mode in ["fast", "default"] {
            let out = dir.join(format!("{device}_{mode}.nii.gz"));
            let mut args = vec![
                "--i",
                input,
                "--o",
                out.to_str().unwrap(),
                "--threads",
                "4",
                "--quiet",
                "--device",
                device,
            ];
            if mode == "fast" {
                args.push("--fast");
            }
            let r = run(&args);
            assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
            gate(
                &out,
                &root().join(format!("test/fixtures/small_{mode}.nii.gz")),
                gate_value(&["maxMismatchFraction", "fixture"]),
            );
            let report: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(dir.join(format!("{device}_{mode}.json"))).unwrap(),
            )
            .unwrap();
            assert_eq!(report["threads"], 4);
            assert_eq!(report["executionProvider"], device);
            assert_eq!(report["fast"], mode == "fast");
            let r = run(&args);
            assert!(
                !r.status.success()
                    && String::from_utf8_lossy(&r.stderr).contains("already exists")
            );
        }
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

fn reference_dir() -> PathBuf {
    PathBuf::from(
        std::env::var("SYNTHSEG_REFERENCE_DIR").unwrap_or_else(|_| {
            format!("{}/src/synthseg-references", std::env::var("HOME").unwrap())
        }),
    )
}

// Preprocessed tensor vs FreeSurfer's preprocess() dump (scripts/keras_reference.py).
#[test]
#[ignore]
fn preprocess_matches_keras() {
    for stem in ["T1_head_2mm", "T1_head"] {
        let prep = volume::prepare(
            &load(&reference_dir().join(format!("{stem}.nii.gz"))),
            false,
        )
        .unwrap();
        let expected = npy_f32(&reference_dir().join(format!("keras/{stem}_input.npy")));
        assert_eq!(expected.len(), prep.input.len(), "{stem} padded shape");
        let max = expected
            .iter()
            .zip(&prep.input)
            .map(|(e, a)| (e - a).abs())
            .fold(0.0, f32::max);
        assert!(max < 1e-5, "{stem} preprocessing error {max}");
    }
}

fn select_real_devices(
    requested: Option<&str>,
    available: &[&'static str],
) -> Result<Vec<&'static str>, String> {
    let Some(requested) = requested else {
        return Ok(available.to_vec());
    };
    let mut selected = Vec::new();
    for name in requested.split(',').map(str::trim) {
        let device = available
            .iter()
            .copied()
            .find(|&device| device == name)
            .ok_or_else(|| {
                format!(
                    "Requested full-volume device {name:?} is unavailable; available: {}",
                    available.join(",")
                )
            })?;
        if selected.contains(&device) {
            return Err(format!("Duplicate full-volume device {name:?}"));
        }
        selected.push(device);
    }
    Ok(selected)
}

#[test]
fn full_volume_device_selection_is_explicit_and_strict() {
    assert_eq!(
        select_real_devices(None, &["cpu", "metal"]).unwrap(),
        ["cpu", "metal"]
    );
    assert_eq!(
        select_real_devices(Some("cpu"), &["cpu", "metal"]).unwrap(),
        ["cpu"]
    );
    assert_eq!(
        select_real_devices(Some("metal, cpu"), &["cpu", "metal"]).unwrap(),
        ["metal", "cpu"]
    );
    for invalid in ["", "cpu,", "cuda", "cpu,cpu"] {
        assert!(select_real_devices(Some(invalid), &["cpu", "metal"]).is_err());
    }
    assert!(select_real_devices(Some("metal"), &["cpu"]).is_err());
}

fn write_real_report(
    available: &[&str],
    selected: &[&str],
    results: &[serde_json::Value],
    failures: &[String],
) {
    fs::write(
        root().join("validation/report.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "available_devices": available,
            "selected_devices": selected,
            "results": results,
            "failures": failures,
        }))
        .unwrap()
            + "\n",
    )
    .unwrap();
}

// Both benchmark volumes and modes use every available device by default. Hosted CI requests
// CPU explicitly through SYNTHSEG_REAL_DEVICES; small-fixture coverage still uses all devices.
#[test]
#[ignore]
fn real_volumes() {
    let available = available_devices();
    let requested = std::env::var("SYNTHSEG_REAL_DEVICES").ok();
    let selected = select_real_devices(requested.as_deref(), &available).unwrap();
    let dir = std::env::temp_dir().join(format!("synthseg-real-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let mut report = Vec::new();
    let mut failures = Vec::new();
    write_real_report(&available, &selected, &report, &failures);
    for &device in &selected {
        for stem in ["T1_head", "T1_head_2mm"] {
            for mode in ["fast", "default"] {
                let input = reference_dir().join(format!("{stem}.nii.gz"));
                let out = dir.join(format!("{stem}_{mode}_{device}.nii.gz"));
                let mut args = vec![
                    "--i",
                    input.to_str().unwrap(),
                    "--o",
                    out.to_str().unwrap(),
                    "--quiet",
                    "--device",
                    device,
                ];
                if mode == "fast" {
                    args.push("--fast");
                }
                let r = run(&args);
                if !r.status.success() {
                    let error = format!(
                        "{device} {mode} {stem}: {}",
                        String::from_utf8_lossy(&r.stderr)
                    );
                    report.push(serde_json::json!({
                        "device": device, "input": stem, "mode": mode, "pass": false,
                        "exit_code": r.status.code(), "error": error,
                    }));
                    failures.push(error.clone());
                    write_real_report(&available, &selected, &report, &failures);
                    panic!("{error}");
                }
                let reference = reference_dir().join(format!("{stem}_{mode}.nii.gz"));
                assert_header_matches(&out, &reference);
                let d = compare(&load(&out), &load(&reference));
                let fraction = d.mismatched as f64 / d.total as f64;
                let pass = d.affine <= gate_value(&["maxAffineErrorMm"])
                    && fraction <= gate_value(&["maxMismatchFraction", "fullVolume"]);
                let sidecar: serde_json::Value = serde_json::from_str(
                    &fs::read_to_string(out.with_extension("").with_extension("json")).unwrap(),
                )
                .unwrap();
                report.push(serde_json::json!({ "device": device, "input": stem, "mode": mode, "mismatched_voxels": d.mismatched,
                    "compared_voxels": d.total, "mismatch_fraction": fraction, "max_affine_error_mm": d.affine,
                    "seconds": sidecar["seconds"], "pass": pass }));
                if !pass {
                    failures.push(format!("{device} {mode} {stem} {} voxels", d.mismatched));
                }
                write_real_report(&available, &selected, &report, &failures);
            }
        }
    }
    fs::remove_dir_all(&dir).unwrap();
    assert!(failures.is_empty(), "failed gates: {failures:?}");
}
