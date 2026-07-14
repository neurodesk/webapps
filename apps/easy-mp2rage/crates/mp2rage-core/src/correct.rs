//! B1-corrected T1 — ports of `t1b1_correct` (iterative SA2RAGE) and
//! `t1b1_correct_with_b1map` (direct B1 map), plus the shared lookup builders
//! and a `RegularGridInterpolator` (2D linear, fill_value=NaN).

use ndarray::{Array2, Array3};

use crate::interp::{arange, np_interp, np_interp_vec, pchip_safe, round_half_even};
use crate::model::{mp2rage_lookuptable, sa2rage_lookuptable, Mp2rageParams, Sa2rageParams};

/// numpy-faithful `np.linspace(a, b, n)` (endpoint forced exactly).
fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    if n == 1 {
        return vec![a];
    }
    let step = (b - a) / ((n - 1) as f64);
    let mut v: Vec<f64> = (0..n).map(|i| a + step * (i as f64)).collect();
    v[n - 1] = b;
    v
}

/// `scipy.interpolate.RegularGridInterpolator((gx,gy), mat, method='linear',
/// bounds_error=False, fill_value=fill)` evaluated at one point.
fn rgi2(gx: &[f64], gy: &[f64], mat: &Array2<f64>, qx: f64, qy: f64, fill: f64) -> f64 {
    let (nx, ny) = (gx.len(), gy.len());
    // A NaN query slips past the `<`/`>` bounds test (both false) and would then
    // panic the binary_search's partial_cmp().unwrap(); treat it as out-of-grid.
    if qx.is_nan() || qy.is_nan() || qx < gx[0] || qx > gx[nx - 1] || qy < gy[0] || qy > gy[ny - 1] {
        return fill;
    }
    let cell = |g: &[f64], x: f64| -> usize {
        let n = g.len();
        let i = match g.binary_search_by(|v| v.partial_cmp(&x).unwrap()) {
            Ok(k) => k,
            Err(k) => k.saturating_sub(1),
        };
        i.min(n - 2)
    };
    let i = cell(gx, qx);
    let j = cell(gy, qy);
    let tx = (qx - gx[i]) / (gx[i + 1] - gx[i]);
    let ty = (qy - gy[j]) / (gy[j + 1] - gy[j]);
    mat[[i, j]] * (1.0 - tx) * (1.0 - ty)
        + mat[[i + 1, j]] * tx * (1.0 - ty)
        + mat[[i, j + 1]] * (1.0 - tx) * ty
        + mat[[i + 1, j + 1]] * tx * ty
}

/// T1(B1, UNI) lookup — returns `(B1_vector, MP2RAGE_vector, T1matrix)`.
/// Port of `_build_mp2rage_t1_lookup`.
pub fn build_mp2rage_t1_lookup(p: &Mp2rageParams) -> (Vec<f64>, Vec<f64>, Array2<f64>) {
    let b1_vector = arange(0.005, 1.9 + 1e-9, 0.05);
    let t1_vector = arange(0.5, 5.2 + 1e-9, 0.05);
    let mp2rage_vector = linspace(-0.5, 0.5, 100);
    let mut t1matrix = Array2::<f64>::zeros((b1_vector.len(), mp2rage_vector.len()));
    for (k, &b1) in b1_vector.iter().enumerate() {
        let flip = (p.flip.0 * b1, p.flip.1 * b1);
        let (i, t) = mp2rage_lookuptable(p.tr, p.tis, flip, p.nz, p.flash_tr, p.inv_eff);
        let row_i = np_interp_vec(&t1_vector, &t, &i, f64::NAN, f64::NAN);
        let mut t1row = pchip_safe(&row_i, &t1_vector, &mp2rage_vector);
        for v in t1row.iter_mut() {
            if v.is_nan() {
                *v = 4.0;
            }
        }
        for (c, &val) in t1row.iter().enumerate() {
            t1matrix[[k, c]] = val;
        }
    }
    (b1_vector, mp2rage_vector, t1matrix)
}

/// SA2RAGE ratio -> B1 lookup — returns `(T1_vector, Sa2RAGE_vector, B1matrix)`.
fn build_sa2rage_b1_lookup(sa: &Sa2rageParams, b1_vector: &[f64]) -> (Vec<f64>, Vec<f64>, Array2<f64>) {
    let t1_vector = arange(0.5, 5.2 + 1e-9, 0.05);
    let mut sa_matrix = Array2::<f64>::from_elem((t1_vector.len(), b1_vector.len()), f64::NAN);
    for (k, &t1val) in t1_vector.iter().enumerate() {
        let (b1v, iv) = sa2rage_lookuptable(sa.tr, sa.tis, sa.flip, sa.nz, sa.flash_tr, t1val);
        let row = np_interp_vec(b1_vector, &b1v, &iv, f64::NAN, f64::NAN);
        for (c, &val) in row.iter().enumerate() {
            sa_matrix[[k, c]] = val;
        }
    }
    let finite: Vec<f64> = sa_matrix.iter().copied().filter(|v| v.is_finite()).collect();
    let smin = finite.iter().copied().fold(f64::INFINITY, f64::min);
    let smax = finite.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let sa_vector = linspace(smin, smax, 100);
    let mut b1matrix = Array2::<f64>::zeros((t1_vector.len(), 100));
    for k in 0..t1_vector.len() {
        let row: Vec<f64> = (0..b1_vector.len()).map(|c| sa_matrix[[k, c]]).collect();
        let mut b1row = pchip_safe(&row, b1_vector, &sa_vector);
        for v in b1row.iter_mut() {
            if v.is_nan() {
                *v = 2.0;
            }
        }
        for (c, &val) in b1row.iter().enumerate() {
            b1matrix[[k, c]] = val;
        }
    }
    (t1_vector, sa_vector, b1matrix)
}

/// Result of a B1 correction: T1 [ms], relative B1, corrected UNI (0..4095).
pub struct CorrResult {
    pub t1_ms: Array3<f64>,
    pub b1: Array3<f64>,
    pub uni_corr: Array3<f64>,
}

/// Forward map T1[s] -> corrected UNI (0..4095), shared by both correctors.
fn corrected_uni(t1temp: &Array3<f64>, p: &Mp2rageParams) -> Array3<f64> {
    let (i, t) = mp2rage_lookuptable(p.tr, p.tis, p.flip, p.nz, p.flash_tr, p.inv_eff);
    t1temp.mapv(|t1| {
        let v = np_interp(t1, &t, &i, f64::NAN, f64::NAN);
        let v = if v.is_nan() { -0.5 } else { v };
        round_half_even(4095.0 * (v + 0.5))
    })
}

/// Iterative B1-corrected T1 (port of `t1b1_correct`).
pub fn t1b1_correct(
    uni: &Array3<f64>,
    ratio: &Array3<f64>,
    mp: &Mp2rageParams,
    sa: &Sa2rageParams,
    brain: &Array3<bool>,
    n_iter: usize,
) -> CorrResult {
    let dim = uni.dim();
    let mp2rage_img = uni.mapv(|v| v / 4095.0 - 0.5);
    let mp_min = mp2rage_img.iter().copied().fold(f64::INFINITY, f64::min);

    let (b1_vector, mp2rage_vector, t1matrix) = build_mp2rage_t1_lookup(mp);
    let (t1_vector, sa_vector, b1matrix) = build_sa2rage_b1_lookup(sa, &b1_vector);

    // active voxels: brain & ratio!=0 & not at the UNI floor
    let mut active = Array3::<bool>::from_elem(dim, false);
    for ((idx, &b), (&r, &m)) in brain
        .indexed_iter()
        .zip(ratio.iter().zip(mp2rage_img.iter()))
    {
        active[idx] = b && r != 0.0 && m != mp_min;
    }

    let mut t1temp = Array3::<f64>::zeros(dim);
    let mut b1temp = Array3::<f64>::zeros(dim);
    for (idx, &a) in active.indexed_iter() {
        if a {
            t1temp[idx] = 1.5;
        }
    }
    // Sa2_filled: NaN ratio -> -0.5 (our ratios are finite, but match Python)
    let sa_filled = ratio.mapv(|r| if r.is_nan() { -0.5 } else { r });

    for _ in 0..n_iter {
        for (idx, &a) in active.indexed_iter() {
            if !a {
                continue;
            }
            let mut b = rgi2(&t1_vector, &sa_vector, &b1matrix, t1temp[idx], sa_filled[idx], f64::NAN);
            if b.is_nan() {
                b = 2.0;
            }
            b1temp[idx] = b;
            let mut t = rgi2(&b1_vector, &mp2rage_vector, &t1matrix, b1temp[idx], mp2rage_img[idx], f64::NAN);
            if t.is_nan() {
                t = 4.0;
            }
            t1temp[idx] = t;
        }
    }

    let uni_corr = corrected_uni(&t1temp, mp);
    CorrResult {
        t1_ms: t1temp.mapv(|v| v * 1000.0),
        b1: b1temp,
        uni_corr,
    }
}

/// Direct B1-corrected T1 from a known relative B1 map (port of
/// `t1b1_correct_with_b1map`).
pub fn t1b1_correct_with_b1map(
    uni: &Array3<f64>,
    b1_rel: &Array3<f64>,
    mp: &Mp2rageParams,
    brain: &Array3<bool>,
) -> CorrResult {
    let dim = uni.dim();
    let mp2rage_img = uni.mapv(|v| v / 4095.0 - 0.5);
    let mp_min = mp2rage_img.iter().copied().fold(f64::INFINITY, f64::min);
    let (b1_vector, mp2rage_vector, t1matrix) = build_mp2rage_t1_lookup(mp);

    let mut t1temp = Array3::<f64>::zeros(dim);
    for (idx, &b1) in b1_rel.indexed_iter() {
        let active = brain[idx] && b1.is_finite() && b1 != 0.0 && mp2rage_img[idx] != mp_min;
        if !active {
            continue;
        }
        let mut t = rgi2(&b1_vector, &mp2rage_vector, &t1matrix, b1, mp2rage_img[idx], f64::NAN);
        if t.is_nan() {
            t = 4.0;
        }
        t1temp[idx] = t;
    }
    let uni_corr = corrected_uni(&t1temp, mp);
    CorrResult {
        t1_ms: t1temp.mapv(|v| v * 1000.0),
        b1: b1_rel.mapv(|v| if v.is_nan() { 0.0 } else { v }),
        uni_corr,
    }
}
