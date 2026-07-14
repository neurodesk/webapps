//! Golden-file parity tests (milestone M1): the Rust core must reproduce every
//! checkpoint dumped by `tools/gen_golden.py` from the validated Python pipeline.
//!
//! Run `python tools/gen_golden.py` first to (re)generate `tools/golden/*.npy`.

use std::path::PathBuf;

use mp2rage_core::model::{self, Mp2rageParams, Sa2rageParams};
use mp2rage_core::{correct, denoise, filt, interp, mask, resample};
use ndarray::{Array1, Array2, Array3};
use ndarray_npy::read_npy;

const MP_AFF: resample::Affine = [
    [2.0, 0.0, 0.0, -24.0],
    [0.0, 2.0, 0.0, -20.0],
    [0.0, 0.0, 2.0, -16.0],
    [0.0, 0.0, 0.0, 1.0],
];
const SA_AFF: resample::Affine = [
    [5.0, 0.0, 0.0, -22.0],
    [0.0, 5.0, 0.0, -18.0],
    [0.0, 0.0, 5.0, -15.0],
    [0.0, 0.0, 0.0, 1.0],
];
const MP_SHAPE: (usize, usize, usize) = (24, 20, 18);

fn load3f64(name: &str) -> Array3<f64> {
    read_npy(golden_dir().join(format!("{name}.npy"))).unwrap_or_else(|e| panic!("load {name}: {e}"))
}
fn load3f32(name: &str) -> Array3<f32> {
    read_npy(golden_dir().join(format!("{name}.npy"))).unwrap_or_else(|e| panic!("load {name}: {e}"))
}
fn load3bool(name: &str) -> Array3<bool> {
    read_npy(golden_dir().join(format!("{name}.npy"))).unwrap_or_else(|e| panic!("load {name}: {e}"))
}

fn golden_dir() -> PathBuf {
    // crates/mp2rage-core -> repo root -> tools/golden
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p.push("tools/golden");
    p
}

fn load1(name: &str) -> Vec<f64> {
    let a: Array1<f64> = read_npy(golden_dir().join(format!("{name}.npy")))
        .unwrap_or_else(|e| panic!("load {name}: {e}"));
    a.to_vec()
}

fn load2(name: &str) -> Array2<f64> {
    read_npy(golden_dir().join(format!("{name}.npy")))
        .unwrap_or_else(|e| panic!("load {name}: {e}"))
}

/// numpy `allclose` with NaN-position equality.
fn assert_close(name: &str, got: &[f64], want: &[f64], rtol: f64, atol: f64) {
    assert_eq!(got.len(), want.len(), "{name}: length {} != {}", got.len(), want.len());
    let mut worst = 0.0f64;
    for (i, (&g, &w)) in got.iter().zip(want.iter()).enumerate() {
        if g.is_nan() || w.is_nan() {
            assert!(
                g.is_nan() && w.is_nan(),
                "{name}[{i}]: NaN mismatch got={g} want={w}"
            );
            continue;
        }
        let tol = atol + rtol * w.abs();
        let diff = (g - w).abs();
        if diff > tol {
            panic!("{name}[{i}]: got={g} want={w} diff={diff} > tol={tol}");
        }
        worst = worst.max(diff);
    }
    eprintln!("  {name:26} OK  ({} vals, worst |diff|={worst:.3e})", want.len());
}

fn mp_params() -> Mp2rageParams {
    Mp2rageParams {
        tr: 4.3,
        tis: (0.840, 2.370),
        flip: (5.0, 6.0),
        nz: (64.0, 128.0),
        flash_tr: 7.0e-3,
        inv_eff: 0.96,
    }
}

fn sa_params() -> Sa2rageParams {
    Sa2rageParams {
        tr: 2.4,
        tis: (0.150, 1.500),
        flip: (6.0, 6.0),
        nz: (24.0, 24.0),
        flash_tr: 5.0e-3,
        average_t1: 1.5,
    }
}

/// numpy-faithful linspace (endpoint forced exactly).
fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    if n == 1 {
        return vec![a];
    }
    let step = (b - a) / ((n - 1) as f64);
    let mut v: Vec<f64> = (0..n).map(|i| a + step * (i as f64)).collect();
    v[n - 1] = b;
    v
}

// Tolerances: f64 math with libm exp/cos/sin; powf(nztot) with large nztot
// amplifies ULP noise, so use a small relative tolerance.
const RTOL: f64 = 1e-9;
const ATOL: f64 = 1e-11;

#[test]
fn mprage_signal_matches() {
    let p = mp_params();
    let t1vec = interp::arange(0.05, 5.0 + 1e-9, 0.05);
    let (s1, s2) = model::mprage_signal(p.tr, p.tis, p.nz, p.flash_tr, p.flip, &t1vec, p.inv_eff);
    assert_close("u_mprage_S1", &s1, &load1("u_mprage_S1"), RTOL, ATOL);
    assert_close("u_mprage_S2", &s2, &load1("u_mprage_S2"), RTOL, ATOL);
}

#[test]
fn mp2rage_lookuptable_matches() {
    let p = mp_params();
    let (i, t) = model::mp2rage_lookuptable(p.tr, p.tis, p.flip, p.nz, p.flash_tr, p.inv_eff);
    assert_close("u_mp2rage_lut_I", &i, &load1("u_mp2rage_lut_I"), RTOL, ATOL);
    assert_close("u_mp2rage_lut_T", &t, &load1("u_mp2rage_lut_T"), RTOL, ATOL);
}

#[test]
fn sa2rage_lookuptable_matches() {
    let p = sa_params();
    let (b1, i) = model::sa2rage_lookuptable(p.tr, p.tis, p.flip, p.nz, p.flash_tr, p.average_t1);
    assert_close("u_sa2rage_lut_B1", &b1, &load1("u_sa2rage_lut_B1"), RTOL, ATOL);
    assert_close("u_sa2rage_lut_I", &i, &load1("u_sa2rage_lut_I"), RTOL, ATOL);
}

#[test]
fn pchip_matches() {
    let x = load1("u_pchip_x");
    let y = load1("u_pchip_y");
    let q = load1("u_pchip_q");
    let out = interp::pchip_safe(&x, &y, &q);
    assert_close("u_pchip_out", &out, &load1("u_pchip_out"), 1e-9, 1e-12);
}

#[test]
fn interp_decreasing_matches() {
    let p = mp_params();
    let (i, t) = model::mp2rage_lookuptable(p.tr, p.tis, p.flip, p.nz, p.flash_tr, p.inv_eff);
    let q = linspace(-0.6, 0.6, 51);
    let out = interp::interp_decreasing(&i, &t, &q, f64::NAN, f64::NAN);
    assert_close("u_interp_dec_out", &out, &load1("u_interp_dec_out"), 1e-9, 1e-12);
}

#[test]
fn gaussian_matches() {
    let inp = load3f32("u_gauss_in").mapv(|x| x as f64);
    let got = filt::gaussian_filter3(&inp, 1.0, true);
    let want = load3f32("u_gauss_out").mapv(|x| x as f64);
    assert_close(
        "u_gauss_out",
        got.as_slice().unwrap(),
        want.as_slice().unwrap(),
        1e-5,
        1e-6,
    );
}

#[test]
fn gaussian_f64_matches() {
    let inp = load3f64("u_gauss64_in");
    let got = filt::gaussian_filter3(&inp, 1.0, false);
    assert_close(
        "u_gauss64_out",
        got.as_slice().unwrap(),
        load3f64("u_gauss64_out").as_slice().unwrap(),
        1e-12,
        1e-14,
    );
}

#[test]
fn morphology_matches() {
    let inp = load3bool("u_morph_in");
    let closed = filt::binary_closing(&inp, 2);
    assert_eq!(closed, load3bool("u_morph_closed"), "binary_closing(iters=2)");
    let filled = filt::binary_fill_holes(&closed);
    assert_eq!(filled, load3bool("u_morph_filled"), "binary_fill_holes");
    eprintln!("  u_morph_closed/filled       OK");
}

#[test]
fn brain_mask_matches() {
    let inv2 = load3f64("v_inv2");
    let got = mask::brain_mask(&inv2, 0.12);
    assert_eq!(got, load3bool("v_mask"), "brain_mask");
    eprintln!("  v_mask                      OK  ({} true)", got.iter().filter(|&&b| b).count());
}

#[test]
fn uncorrected_t1_matches() {
    let uni = load3f64("v_uni");
    let flat: Vec<f64> = uni.iter().copied().collect();
    let got = model::t1_from_uni(&flat, &mp_params());
    let want = load3f64("v_uncorr_T1_s");
    assert_close("v_uncorr_T1_s", &got, want.as_slice().unwrap(), 1e-9, 1e-11);
}

#[test]
fn resample_matches() {
    let src = load3f32("v_b1_lowres_post_gauss"); // SA grid
    let got = resample::resample_to(&src, &SA_AFF, MP_SHAPE, &MP_AFF, f64::NAN);
    let want = load3f32("v_b1_resampled_mp").mapv(|x| x as f64);
    let gotf: Vec<f64> = got.iter().map(|&x| x as f64).collect();
    assert_close("v_b1_resampled_mp", &gotf, want.as_slice().unwrap(), 1e-5, 1e-6);
}

#[test]
fn t1b1_correct_matches() {
    let uni = load3f64("v_uni");
    let ratio = load3f32("v_ratio_resampled_mp").mapv(|x| x as f64);
    let brain = load3bool("v_mask");
    let res = correct::t1b1_correct(&uni, &ratio, &mp_params(), &sa_params(), &brain, 3);
    assert_close("v_corr_T1_ms", res.t1_ms.as_slice().unwrap(), load3f64("v_corr_T1_ms").as_slice().unwrap(), 1e-6, 1e-4);
    assert_close("v_corr_B1", res.b1.as_slice().unwrap(), load3f64("v_corr_B1").as_slice().unwrap(), 1e-6, 1e-6);
    assert_close("v_corr_UNI", res.uni_corr.as_slice().unwrap(), load3f64("v_corr_UNI").as_slice().unwrap(), 0.0, 0.0);
}

#[test]
fn t1b1_correct_with_b1map_matches() {
    let uni = load3f64("v_uni");
    let b1 = load3f32("v_b1map_grid_mp").mapv(|x| if x.is_nan() { 0.0 } else { x as f64 });
    let brain = load3bool("v_mask");
    let res = correct::t1b1_correct_with_b1map(&uni, &b1, &mp_params(), &brain);
    assert_close("v_b1map_corr_T1_ms", res.t1_ms.as_slice().unwrap(), load3f64("v_b1map_corr_T1_ms").as_slice().unwrap(), 1e-6, 1e-4);
    assert_close("v_b1map_corr_UNI", res.uni_corr.as_slice().unwrap(), load3f64("v_b1map_corr_UNI").as_slice().unwrap(), 0.0, 0.0);
}

#[test]
fn robust_combination_matches() {
    let uni = load3f64("u_rc_uni");
    let inv1 = load3f64("u_rc_inv1");
    let inv2 = load3f64("u_rc_inv2");
    let got = denoise::robust_combination(&uni, &inv1, &inv2, 6.0);
    assert_close("u_rc_out", got.as_slice().unwrap(), load3f64("u_rc_out").as_slice().unwrap(), 1e-9, 1e-9);
}

#[test]
fn t1matrix_matches() {
    // reconstruct the T1(B1,UNI) lookup table (PCHIP inversion over the B1 grid)
    let p = mp_params();
    let b1_vector = interp::arange(0.005, 1.9 + 1e-9, 0.05);
    let t1_vector = interp::arange(0.5, 5.2 + 1e-9, 0.05);
    let mp2rage_vector = linspace(-0.5, 0.5, 100);
    let want = load2("u_T1matrix");
    let mut got = Vec::new();
    for &b1 in &b1_vector {
        let flip = (p.flip.0 * b1, p.flip.1 * b1);
        let (i, t) = model::mp2rage_lookuptable(p.tr, p.tis, flip, p.nz, p.flash_tr, p.inv_eff);
        // np.interp(T1_vector, T, I) with NaN outside
        let row_i = model::interp_ascending(&t1_vector, &t, &i);
        // pchip_safe(MP2RAGEmatrix_row, T1_vector, MP2RAGE_vector), NaN->4.0
        let mut t1row = interp::pchip_safe(&row_i, &t1_vector, &mp2rage_vector);
        for v in t1row.iter_mut() {
            if v.is_nan() {
                *v = 4.0;
            }
        }
        got.extend_from_slice(&t1row);
    }
    assert_close("u_T1matrix", &got, &want.iter().copied().collect::<Vec<_>>(), 1e-8, 1e-10);
    assert_eq!(
        (b1_vector.len(), mp2rage_vector.len()),
        (want.shape()[0], want.shape()[1]),
        "T1matrix shape"
    );
}
