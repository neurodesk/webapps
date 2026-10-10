//! M2 end-to-end parity: read the phantom NIfTIs, run the full Rust pipeline
//! assembly, and reproduce the golden final maps from the Python pipeline.
//! Also round-trips the NIfTI writer.

use std::path::PathBuf;

use mp2rage_cli::nifti_io::{read_nifti, write_nifti_f32};
use mp2rage_core::model::{Mp2rageParams, Sa2rageParams};
use mp2rage_core::pipeline::{run_b1map, run_sa2rage};
use ndarray::Array3;
use ndarray_npy::read_npy;

fn repo() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p
}
fn golden(name: &str) -> Array3<f64> {
    read_npy(repo().join("tools/golden").join(format!("{name}.npy"))).unwrap()
}
fn phantom(name: &str) -> String {
    repo().join("tools/phantom").join(name).to_string_lossy().into_owned()
}

fn assert_close(name: &str, got: &Array3<f64>, want: &Array3<f64>, rtol: f64, atol: f64) {
    assert_eq!(got.dim(), want.dim(), "{name}: shape");
    let mut worst = 0.0f64;
    for (g, w) in got.iter().zip(want.iter()) {
        if g.is_nan() || w.is_nan() {
            assert!(g.is_nan() && w.is_nan(), "{name}: NaN mismatch {g} vs {w}");
            continue;
        }
        let d = (g - w).abs();
        assert!(d <= atol + rtol * w.abs(), "{name}: {g} vs {w} diff {d}");
        worst = worst.max(d);
    }
    eprintln!("  {name:22} OK  (worst |diff|={worst:.3e})");
}

fn mp() -> Mp2rageParams {
    Mp2rageParams { tr: 4.3, tis: (0.840, 2.370), flip: (5.0, 6.0), nz: (64.0, 128.0), flash_tr: 7.0e-3, inv_eff: 0.96 }
}
fn sa() -> Sa2rageParams {
    Sa2rageParams { tr: 2.4, tis: (0.150, 1.500), flip: (6.0, 6.0), nz: (24.0, 24.0), flash_tr: 5.0e-3, average_t1: 1.5 }
}

#[test]
fn sa2rage_pipeline_matches_golden() {
    let uni_v = read_nifti(&phantom("phantom_UNI.nii.gz")).unwrap();
    let inv2_v = read_nifti(&phantom("phantom_INV2.nii.gz")).unwrap();
    let sa_v = read_nifti(&phantom("phantom_SA2RAGE.nii.gz")).unwrap();
    let out = run_sa2rage(
        &uni_v.to_array3(),
        Some(&inv2_v.to_array3()),
        &sa_v.component(0),
        &sa_v.component(1),
        &uni_v.affine,
        &sa_v.affine,
        &mp(),
        &sa(),
        false, // fallback_uncorrected off → golden parity
    );
    assert_close("SA T1_corr(ms)", &out.t1_corr, &golden("v_corr_T1_ms"), 1e-6, 1e-4);
    assert_close("SA UNI_corr", &out.uni_corr, &golden("v_corr_UNI"), 0.0, 0.0);
    // (uncorrected T1 = t1_from_uni is validated unmasked in the core parity test;
    //  here it is masked to brain, so we don't re-compare it against v_uncorr_T1_s.)
}

#[test]
fn b1map_pipeline_matches_golden() {
    let uni_v = read_nifti(&phantom("phantom_UNI.nii.gz")).unwrap();
    let inv2_v = read_nifti(&phantom("phantom_INV2.nii.gz")).unwrap();
    let b1_v = read_nifti(&phantom("phantom_B1map_tfl.nii.gz")).unwrap();
    let out = run_b1map(
        &uni_v.to_array3(),
        Some(&inv2_v.to_array3()),
        &b1_v.to_array3(),
        &uni_v.affine,
        &b1_v.affine,
        "tfl",
        80.0,
        &mp(),
        false, // extend_fov off → bit-parity with the Python golden
        false, // fallback_uncorrected off → golden parity
    );
    assert_close("B1map T1_corr(ms)", &out.t1_corr, &golden("v_b1map_corr_T1_ms"), 1e-6, 1e-4);
    assert_close("B1map UNI_corr", &out.uni_corr, &golden("v_b1map_corr_UNI"), 0.0, 0.0);
}

#[test]
fn nifti_writer_roundtrips() {
    let uni_v = read_nifti(&phantom("phantom_UNI.nii.gz")).unwrap();
    let orig = uni_v.to_array3();
    let tmp = std::env::temp_dir().join("mp2rage_rt_test.nii.gz");
    let tmp = tmp.to_string_lossy().into_owned();
    write_nifti_f32(&tmp, &orig.mapv(|v| v as f32), &uni_v.affine).unwrap();
    let back_v = read_nifti(&tmp).unwrap();
    let back = back_v.to_array3();
    assert_eq!(orig.dim(), back.dim());
    for (a, b) in orig.iter().zip(back.iter()) {
        assert!((a - b).abs() <= 1e-4 * a.abs().max(1.0), "roundtrip {a} vs {b}");
    }
    // affine round-trips (f32-exact phantom affine)
    for r in 0..4 {
        for c in 0..4 {
            assert!((uni_v.affine[r][c] - back_v.affine[r][c]).abs() < 1e-6);
        }
    }
    let _ = std::fs::remove_file(&tmp);
    eprintln!("  nifti writer round-trip OK");
}

// The Python pipeline writes these files independently of the Rust/WASM core.
// Cover absent INV2, non-convergence fallback, and BOTH extrapolation bounds.
#[test]
fn optional_inv2_and_clamp_match_python_files() {
    let uni = read_nifti(&phantom("phantom_UNI.nii.gz")).unwrap();
    let inv2 = read_nifti(&phantom("phantom_INV2.nii.gz")).unwrap();
    let sa_v = read_nifti(&phantom("phantom_SA2RAGE.nii.gz")).unwrap();
    let root = repo().join("tools/golden/cli");
    for (name, is_sa, angle, fallback, clamp) in [
        ("sa2rage-no-inv2", true, 6.0, false, false),
        ("sa2rage-no-inv2-fa12-fallback", true, 12.0, true, false),
        ("tfl-no-inv2", false, 80.0, false, false),
        ("tfl-no-inv2-reference-40-fallback", false, 40.0, true, false),
        ("tfl-clamp-extended", false, 80.0, false, true),
        ("tfl-rank-deficient", false, 80.0, false, true),
    ] {
        let b1_path = if name == "tfl-rank-deficient" { root.join("inputs/plane_B1map_tfl.nii.gz") }
                      else if clamp { root.join("inputs/clamp_B1map_tfl.nii.gz") }
                      else { repo().join("tools/phantom/phantom_B1map_tfl.nii.gz") };
        let b1 = read_nifti(b1_path.to_str().unwrap()).unwrap();
        let inv2_array = inv2.to_array3();
        let mask_input = if clamp { Some(&inv2_array) } else { None };
        let out = if is_sa {
            let mut params = sa();
            params.flip = (angle, angle);
            run_sa2rage(&uni.to_array3(), mask_input, &sa_v.component(0), &sa_v.component(1),
                        &uni.affine, &sa_v.affine, &mp(), &params, fallback)
        } else {
            run_b1map(&uni.to_array3(), mask_input, &b1.to_array3(), &uni.affine, &b1.affine,
                      "tfl", angle, &mp(), clamp, fallback)
        };
        let b1_name = if is_sa { "B1map_from_SA2RAGE.nii.gz" } else { "B1map.nii.gz" };
        for (file, got, tol) in [
            ("T1map.nii.gz", &out.t1_corr, 0.1),
            ("T1map_uncorrected.nii.gz", &out.t1_uncorr, 0.1),
            ("UNI_b1corrected.nii.gz", &out.uni_corr, 0.01),
            (b1_name, &out.b1, 1e-4),
        ] {
            let want = read_nifti(root.join(name).join(file).to_str().unwrap()).unwrap().to_array3();
            assert_close(&format!("{name}/{file}"), got, &want, 0.0, tol);
        }
        if name == "tfl-clamp-extended" {
            assert!(out.b1.iter().any(|&v| v == 0.35));
            assert!(out.b1.iter().any(|&v| v == 1.7));
        }
    }
}

#[test]
fn sparse_and_rank_deficient_extension_match_numpy() {
    let root = repo().join("tools/golden/cli/b1fill");
    for name in ["sparse", "rank-deficient"] {
        let field: Array3<f64> = read_npy(root.join(format!("{name}-field.npy"))).unwrap();
        let mask: Array3<bool> = read_npy(root.join(format!("{name}-mask.npy"))).unwrap();
        let expected: Array3<f64> = read_npy(root.join(format!("{name}-expected.npy"))).unwrap();
        let actual = mp2rage_core::b1fill::extend_b1_fov(&field, &mask, 3, (0.35, 1.7));
        assert_close(name, &actual, &expected, 0.0, 1e-10);
        assert_eq!(actual[[0, 0, 0]], 0.2);
        assert_eq!(actual[[0, 0, 1]], 1.9);
    }
}
