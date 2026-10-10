//! Smooth extrapolation of a B1⁺ (transmit) field to voxels outside the
//! measured field-of-view.
//!
//! Optional application heuristic: a low-order polynomial estimates missing
//! B1 values from measured in-mask samples. Measured values stay unchanged.
//! The clamp bounds the extrapolation; it is not a physiological validity range.
//! See docs/numerical-policy.md for the reference contract and its limitations.

use ndarray::Array3;
use nalgebra::{DMatrix, DVector};

/// Number of monomials `x^a y^b z^c` with `a+b+c <= deg` (3-D total degree).
fn n_terms(deg: usize) -> usize {
    // C(deg+3, 3)
    (deg + 1) * (deg + 2) * (deg + 3) / 6
}

/// The exponent triples `(a,b,c)` with `a+b+c <= deg`, in a fixed order.
fn exponents(deg: usize) -> Vec<(u32, u32, u32)> {
    let mut e = Vec::with_capacity(n_terms(deg));
    for total in 0..=deg {
        for a in 0..=total {
            for b in 0..=(total - a) {
                let c = total - a - b;
                e.push((a as u32, b as u32, (c) as u32));
            }
        }
    }
    e
}

/// Fill non-finite voxels of `field` that lie inside `mask` with a smooth
/// low-order polynomial fit to the finite in-mask voxels whose value is within
/// `clamp`. Finite voxels and out-of-mask voxels are returned unchanged; filled
/// values are clamped to `clamp`.
///
/// If there are too few usable voxels to fit the polynomial, falls back to
/// filling with the median of the usable voxels (a constant field).
pub fn extend_b1_fov(
    field: &Array3<f64>,
    mask: &Array3<bool>,
    deg: usize,
    clamp: (f64, f64),
) -> Array3<f64> {
    let (nx, ny, nz) = field.dim();
    let (lo, hi) = clamp;

    // normalize voxel coords to [-1, 1] for conditioning
    let sx = if nx > 1 { 2.0 / (nx as f64 - 1.0) } else { 0.0 };
    let sy = if ny > 1 { 2.0 / (ny as f64 - 1.0) } else { 0.0 };
    let sz = if nz > 1 { 2.0 / (nz as f64 - 1.0) } else { 0.0 };
    let un = |i: usize, s: f64| i as f64 * s - 1.0;

    // collect the fit set: inside mask, finite, plausible value
    let mut fit_coords: Vec<(f64, f64, f64)> = Vec::new();
    let mut fit_vals: Vec<f64> = Vec::new();
    // also track how many masked voxels need filling
    let mut n_missing = 0usize;
    for ((i, j, k), &m) in mask.indexed_iter() {
        if !m {
            continue;
        }
        let v = field[[i, j, k]];
        if v.is_finite() {
            if v >= lo && v <= hi {
                fit_coords.push((un(i, sx), un(j, sy), un(k, sz)));
                fit_vals.push(v);
            }
        } else {
            n_missing += 1;
        }
    }

    // nothing to do
    if n_missing == 0 {
        return field.clone();
    }

    let exps = exponents(deg);
    let p = exps.len();
    let mut out = field.clone();

    // Median fallback if we can't fit robustly.
    let median = || -> f64 {
        if fit_vals.is_empty() {
            return f64::NAN;
        }
        let mut v = fit_vals.clone();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = v.len();
        if n % 2 == 1 { v[n / 2] } else { 0.5 * (v[n / 2 - 1] + v[n / 2]) }
    };

    // Need clearly more equations than unknowns for a stable fit.
    if fit_vals.len() < 4 * p {
        let med = median();
        if med.is_finite() {
            for ((i, j, k), &m) in mask.indexed_iter() {
                if m && !field[[i, j, k]].is_finite() {
                    out[[i, j, k]] = med.clamp(lo, hi);
                }
            }
        }
        return out;
    }

    // Incremental QR keeps only a p x p triangular factor, not a voxel x p
    // design matrix. SVD of that factor gives the same minimum-norm least
    // squares solution as np.linalg.lstsq, including rank-deficient fits.
    let eval_basis = |x: f64, y: f64, z: f64, buf: &mut [f64]| {
        for (t, &(a, b, c)) in exps.iter().enumerate() {
            buf[t] = x.powi(a as i32) * y.powi(b as i32) * z.powi(c as i32);
        }
    };
    let mut r = DMatrix::<f64>::zeros(p, p);
    let mut rhs = DVector::<f64>::zeros(p);
    let mut row = vec![0.0f64; p];
    for (idx, &(x, y, z)) in fit_coords.iter().enumerate() {
        eval_basis(x, y, z, &mut row);
        let mut value = fit_vals[idx];
        for j in 0..p {
            let norm = r[(j, j)].hypot(row[j]);
            if norm == 0.0 {
                continue;
            }
            let c = r[(j, j)] / norm;
            let s = row[j] / norm;
            for k in j..p {
                let old = r[(j, k)];
                r[(j, k)] = c * old + s * row[k];
                row[k] = -s * old + c * row[k];
            }
            let old = rhs[j];
            rhs[j] = c * old + s * value;
            value = -s * old + c * value;
        }
    }
    let svd = r.svd(true, true);
    // NumPy rcond=None: machine precision times max(original matrix shape).
    let cutoff = f64::EPSILON * fit_vals.len().max(p) as f64 * svd.singular_values.max();
    let coef = svd.solve(&rhs, cutoff).expect("SVD includes both singular vector matrices");

    // Evaluate the polynomial at every missing masked voxel.
    for ((i, j, k), &m) in mask.indexed_iter() {
        if !m || field[[i, j, k]].is_finite() {
            continue;
        }
        eval_basis(un(i, sx), un(j, sy), un(k, sz), &mut row);
        let mut val = 0.0;
        for t in 0..p {
            val += coef[t] * row[t];
        }
        out[[i, j, k]] = val.clamp(lo, hi);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndarray::Array3;

    /// A genuinely smooth field (quadratic) with a slab masked out beyond the
    /// measured FOV should be recovered by the polynomial fill to good accuracy.
    #[test]
    fn recovers_smooth_field_outside_fov() {
        let (nx, ny, nz) = (20, 22, 18);
        // ground-truth smooth relative-B1 field in [~0.6, ~1.2]
        let truth = Array3::from_shape_fn((nx, ny, nz), |(i, j, k)| {
            let x = i as f64 / (nx as f64 - 1.0) - 0.5;
            let y = j as f64 / (ny as f64 - 1.0) - 0.5;
            let z = k as f64 / (nz as f64 - 1.0) - 0.5;
            0.95 + 0.3 * x - 0.2 * y + 0.15 * z - 0.25 * (x * x + y * y)
        });
        let mask = Array3::from_elem((nx, ny, nz), true);
        // "measured FOV" = only the central slab in k; outside is NaN (out of FOV)
        let mut field = truth.clone();
        let mut n_out = 0;
        for ((_, _, k), v) in field.indexed_iter_mut() {
            if k < 4 || k >= nz - 4 {
                *v = f64::NAN;
                n_out += 1;
            }
        }
        assert!(n_out > 0);
        let filled = extend_b1_fov(&field, &mask, 3, (0.3, 2.0));
        // every masked voxel is now finite
        let mut maxerr = 0.0f64;
        for ((i, j, k), &t) in truth.indexed_iter() {
            let f = filled[[i, j, k]];
            assert!(f.is_finite(), "voxel {i},{j},{k} still non-finite");
            maxerr = maxerr.max((f - t).abs());
        }
        // quadratic truth, cubic fit → recovery well under 1% of the ~1.0 field
        assert!(maxerr < 5e-3, "max extrapolation error {maxerr} too large");
    }

    /// In-FOV measured voxels must be preserved exactly; out-of-mask untouched.
    #[test]
    fn preserves_measured_and_out_of_mask() {
        let (nx, ny, nz) = (12, 12, 12);
        let mut field = Array3::from_elem((nx, ny, nz), f64::NAN);
        let mut mask = Array3::from_elem((nx, ny, nz), false);
        // measured + masked block
        for i in 2..10 {
            for j in 2..10 {
                for k in 2..7 {
                    field[[i, j, k]] = 1.0 + 0.01 * i as f64;
                    mask[[i, j, k]] = true;
                }
            }
        }
        // masked-but-missing block (k 7..10) to force a fill
        for i in 2..10 {
            for j in 2..10 {
                for k in 7..10 {
                    mask[[i, j, k]] = true;
                }
            }
        }
        let filled = extend_b1_fov(&field, &mask, 2, (0.3, 2.0));
        // measured voxels preserved
        for i in 2..10 {
            for k in 2..7 {
                assert_eq!(filled[[i, 5, k]], 1.0 + 0.01 * i as f64);
            }
        }
        // an out-of-mask voxel stays NaN
        assert!(filled[[0, 0, 0]].is_nan());
    }
}
