//! End-to-end pipeline assembly: Rust mirror of `mp2rage_t1/pipeline.py`
//! (SA2RAGE B1 source and direct B1-map source), operating on in-memory arrays
//! so it can be unit-tested against the golden checkpoints.

use ndarray::Array3;

use crate::correct::{t1b1_correct, t1b1_correct_with_b1map};
use crate::filt::gaussian_filter3;
use crate::interp::np_interp_vec;
use crate::mask::{brain_mask, percentile};
use crate::model::{sa2rage_lookuptable, t1_from_uni, Mp2rageParams, Sa2rageParams};
use crate::resample::resample_to;
use crate::Affine;

pub struct Outputs {
    pub t1_corr: Array3<f64>,   // B1-corrected T1 (ms), 0 outside mask / non-converged
    pub b1: Array3<f64>,        // relative B1 on the MP2RAGE grid (0 outside mask)
    pub t1_uncorr: Array3<f64>, // uncorrected T1 (ms)
    pub uni_corr: Array3<f64>,  // B1-corrected UNI (0..4095)
    pub mask: Array3<bool>,
}

fn median_finite(vals: &[f64]) -> f64 {
    let mut v: Vec<f64> = vals.iter().copied().filter(|x| x.is_finite()).collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n == 0 {
        return f64::NAN;
    }
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

#[inline]
fn isclose_4000(t: f64) -> bool {
    (t - 4000.0).abs() <= 2.0 + 1e-5 * 4000.0
}

fn uncorrected_t1_ms(uni: &Array3<f64>, mp: &Mp2rageParams, mask: &Array3<bool>) -> Array3<f64> {
    let flat: Vec<f64> = uni.iter().copied().collect();
    let t1 = t1_from_uni(&flat, mp);
    let mut out = Array3::from_shape_vec(uni.dim(), t1).unwrap();
    out.mapv_inplace(|v| v * 1000.0);
    for (idx, &m) in mask.indexed_iter() {
        if !m {
            out[idx] = 0.0;
        }
    }
    out
}

/// SA2RAGE B1 source (port of the `b1_mode == 'sa2rage'` branch).
pub fn run_sa2rage(
    uni: &Array3<f64>,
    inv2: &Array3<f64>,
    s_a: &Array3<f64>,
    s_b: &Array3<f64>,
    uni_aff: &Affine,
    sa_aff: &Affine,
    mp: &Mp2rageParams,
    sa: &Sa2rageParams,
    fallback_uncorrected: bool,
) -> Outputs {
    let dim = uni.dim();
    let mask = brain_mask(inv2, 0.12);
    let t1_uncorr = uncorrected_t1_ms(uni, mp, &mask);

    // SA2RAGE ratio -> B1 lookup (sorted by intensity for np.interp)
    let (b1v, iv) = sa2rage_lookuptable(sa.tr, sa.tis, sa.flip, sa.nz, sa.flash_tr, sa.average_t1);
    let mut order: Vec<usize> = (0..iv.len()).collect();
    order.sort_by(|&a, &b| iv[a].partial_cmp(&iv[b]).unwrap());
    let iv_s: Vec<f64> = order.iter().map(|&i| iv[i]).collect();
    let b1v_s: Vec<f64> = order.iter().map(|&i| b1v[i]).collect();

    // ratio / B1 are computed on the SA2RAGE grid, then resampled to the MP grid
    let sad = s_a.dim();
    let ratio_to_b1 = |num: &Array3<f64>, den: &Array3<f64>| -> (Array3<f64>, Array3<f64>) {
        let r = Array3::from_shape_fn(sad, |ix| num[ix] / den[ix]);
        let rflat: Vec<f64> = r.iter().copied().collect();
        let b1 = np_interp_vec(&rflat, &iv_s, &b1v_s, f64::NAN, f64::NAN);
        (r, Array3::from_shape_vec(sad, b1).unwrap())
    };

    // sa_mask = S_b > 0.15 * percentile(S_b[S_b>0], 99)
    let sbpos: Vec<f64> = s_b.iter().copied().filter(|&v| v > 0.0).collect();
    let sb99 = percentile(&sbpos, 99.0);
    let sa_mask = s_b.mapv(|v| v > 0.15 * sb99);
    let nanmed_over_samask = |arr: &Array3<f64>| -> f64 {
        let vals: Vec<f64> = arr
            .indexed_iter()
            .filter(|(ix, _)| sa_mask[*ix])
            .map(|(_, &v)| v)
            .collect();
        median_finite(&vals)
    };

    // pick S1/S2 order that yields brain B1 closest to 1
    let (_, b1_ab) = ratio_to_b1(s_a, s_b);
    let (_, b1_ba) = ratio_to_b1(s_b, s_a);
    let med_ab = nanmed_over_samask(&b1_ab);
    let med_ba = nanmed_over_samask(&b1_ba);
    // Python `min(cand, key=|median-1|)`: 'ab' is first, so it wins ties and
    // 'ba' only replaces it when strictly closer to 1 (a NaN median never wins).
    let d_ab = (med_ab - 1.0).abs();
    let d_ba = (med_ba - 1.0).abs();
    let use_ab = !(d_ba < d_ab);
    let (num, den): (&Array3<f64>, &Array3<f64>) = if use_ab { (s_a, s_b) } else { (s_b, s_a) };
    let (ratio_low, b1_low) = ratio_to_b1(num, den);

    // relative B1 map -> smooth (f64) -> resample to MP grid
    let med_b1 = nanmed_over_samask(&b1_low);
    let b1_low_f = b1_low.mapv(|v| if v.is_finite() { v } else { med_b1 });
    let b1_low_g = gaussian_filter3(&b1_low_f, 1.0, false).mapv(|v| v as f32);
    let mut b1_out = resample_to(&b1_low_g, sa_aff, dim, uni_aff, f64::NAN).mapv(|v| v as f64);
    for (idx, &m) in mask.indexed_iter() {
        if !m {
            b1_out[idx] = f64::NAN;
        }
    }

    // SA2RAGE ratio -> smooth (f64) -> resample -> correction input
    let med_ratio = nanmed_over_samask(&ratio_low);
    let ratio_f = ratio_low.mapv(|v| if v.is_finite() { v } else { med_ratio });
    let ratio_g = gaussian_filter3(&ratio_f, 1.0, false).mapv(|v| v as f32);
    let mut ratio_mp = resample_to(&ratio_g, sa_aff, dim, uni_aff, f64::NAN).mapv(|v| v as f64);
    for (idx, &m) in mask.indexed_iter() {
        if !m {
            ratio_mp[idx] = 0.0;
        }
    }

    let res = t1b1_correct(uni, &ratio_mp, mp, sa, &mask, 3);
    let mut t1_corr = res.t1_ms;
    let b1c = res.b1;
    for (idx, &m) in mask.indexed_iter() {
        let noncov = b1c[idx] >= 1.9 || b1c[idx] <= 0.05 || isclose_4000(t1_corr[idx]);
        if !m {
            t1_corr[idx] = 0.0;
        } else if noncov {
            t1_corr[idx] = if fallback_uncorrected { t1_uncorr[idx] } else { 0.0 };
        }
    }
    let b1 = b1_out.mapv(|v| if v.is_nan() { 0.0 } else { v });

    Outputs { t1_corr, b1, t1_uncorr, uni_corr: res.uni_corr, mask }
}

/// Direct B1-map source (port of the `b1_mode == 'b1map'` branch).
/// `b1_map` is the raw stored B1 map on the SA/B1 grid; `kind`/`ref_angle`
/// control the conversion to relative B1.
pub fn run_b1map(
    uni: &Array3<f64>,
    inv2: &Array3<f64>,
    b1_map: &Array3<f64>,
    uni_aff: &Affine,
    b1_aff: &Affine,
    kind: &str,
    ref_angle: f64,
    mp: &Mp2rageParams,
    extend_fov: bool,
    fallback_uncorrected: bool,
) -> Outputs {
    let dim = uni.dim();
    let mask = brain_mask(inv2, 0.12);
    let t1_uncorr = uncorrected_t1_ms(uni, mp, &mask);

    // to relative B1
    let rel = b1_map.mapv(|v| match kind {
        "tfl" => v / 10.0 / ref_angle,
        "percent" => v / 100.0,
        _ => v, // "relative"
    });
    let finite: Vec<f64> = rel.iter().copied().filter(|v| v.is_finite()).collect();
    let med = if finite.is_empty() { 1.0 } else { median_finite(&finite) };
    // b1-map branch smooths in f32 (matches pipeline.py .astype(float32) before gaussian)
    let rel_f = rel.mapv(|v| if v.is_finite() { v } else { med });
    let rel_g = gaussian_filter3(&rel_f, 1.0, true).mapv(|v| v as f32);
    // Resample with NaN outside the measured B1 FOV so those voxels are distinct
    // from genuine low-B1 measurements.
    let mut b1_grid = resample_to(&rel_g, b1_aff, dim, uni_aff, f64::NAN).mapv(|v| v as f64);

    // Optionally extend a too-small B1 FOV to cover the whole brain by fitting a
    // smooth low-order polynomial to the measured field (B1⁺ is slowly varying).
    if extend_fov {
        b1_grid = crate::b1fill::extend_b1_fov(&b1_grid, &mask, 3, (0.3, 2.0));
    }

    let b1_in = b1_grid.mapv(|v| if v.is_nan() { 0.0 } else { v });
    let res = t1b1_correct_with_b1map(uni, &b1_in, mp, &mask);
    let mut t1_corr = res.t1_ms;
    for (idx, &m) in mask.indexed_iter() {
        if !m {
            t1_corr[idx] = 0.0;
        } else if isclose_4000(t1_corr[idx]) {
            t1_corr[idx] = if fallback_uncorrected { t1_uncorr[idx] } else { 0.0 };
        }
    }
    // Export contract: 0 outside the mask, finite everywhere else. In-mask voxels
    // outside the measured B1 FOV are NaN (resample fill) when extend_fov is off,
    // or if the polynomial extend could not fit; map those to 0 so the saved B1
    // NIfTI never carries NaN (mirrors run_sa2rage at the top of this file).
    let mut b1 = b1_grid.mapv(|v| if v.is_nan() { 0.0 } else { v });
    for (idx, &m) in mask.indexed_iter() {
        if !m {
            b1[idx] = 0.0;
        }
    }
    Outputs { t1_corr, b1, t1_uncorr, uni_corr: res.uni_corr, mask }
}
