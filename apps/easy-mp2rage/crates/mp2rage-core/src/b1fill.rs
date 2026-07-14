//! Smooth extrapolation of a B1⁺ (transmit) field to voxels outside the
//! measured field-of-view.
//!
//! Physics note: the B1⁺ transmit field is spatially smooth and dominated by
//! low spatial frequencies (it is the RF transmit magnitude, which varies
//! slowly over the head — no sharp tissue edges). A low-order 3-D polynomial is
//! therefore a physically reasonable model, and using it to *fill* brain voxels
//! that fell outside a small B1-map FOV is far better than leaving them with no
//! correction (B1 = 0). Measured voxels are always kept as-is; only the missing
//! ones are filled, and the fill is clamped to a plausible relative-B1 range so
//! a polynomial cannot blow up where it extrapolates far from the data.

use ndarray::Array3;

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

/// Solve the symmetric system `A x = y` (A is `n x n`, row-major) by Gaussian
/// elimination with partial pivoting. `A` is small (<= 20x20 for deg 3).
fn solve(mut a: Vec<f64>, mut y: Vec<f64>, n: usize) -> Option<Vec<f64>> {
    for col in 0..n {
        // partial pivot
        let mut piv = col;
        let mut best = a[col * n + col].abs();
        for r in (col + 1)..n {
            let v = a[r * n + col].abs();
            if v > best {
                best = v;
                piv = r;
            }
        }
        if best < 1e-12 {
            return None;
        }
        if piv != col {
            for k in 0..n {
                a.swap(col * n + k, piv * n + k);
            }
            y.swap(col, piv);
        }
        let d = a[col * n + col];
        for r in (col + 1)..n {
            let f = a[r * n + col] / d;
            if f == 0.0 {
                continue;
            }
            for k in col..n {
                a[r * n + k] -= f * a[col * n + k];
            }
            y[r] -= f * y[col];
        }
    }
    // back-substitute
    let mut x = vec![0.0f64; n];
    for r in (0..n).rev() {
        let mut s = y[r];
        for k in (r + 1)..n {
            s -= a[r * n + k] * x[k];
        }
        x[r] = s / a[r * n + r];
    }
    Some(x)
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
        v[v.len() / 2]
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

    // Build normal equations A = Bᵀ B (+ tiny ridge), rhs = Bᵀ y, where each row
    // of B is the monomial vector at a fit voxel.
    let eval_basis = |x: f64, y: f64, z: f64, buf: &mut [f64]| {
        for (t, &(a, b, c)) in exps.iter().enumerate() {
            buf[t] = x.powi(a as i32) * y.powi(b as i32) * z.powi(c as i32);
        }
    };
    let mut ata = vec![0.0f64; p * p];
    let mut aty = vec![0.0f64; p];
    let mut row = vec![0.0f64; p];
    for (idx, &(x, y, z)) in fit_coords.iter().enumerate() {
        eval_basis(x, y, z, &mut row);
        let yv = fit_vals[idx];
        for r in 0..p {
            aty[r] += row[r] * yv;
            let rr = row[r];
            for c in 0..p {
                ata[r * p + c] += rr * row[c];
            }
        }
    }
    // Tikhonov ridge for numerical safety (keeps the constant term unpenalized-ish).
    let mut trace = 0.0;
    for d in 0..p {
        trace += ata[d * p + d];
    }
    let ridge = 1e-9 * (trace / p as f64).max(1.0);
    for d in 0..p {
        ata[d * p + d] += ridge;
    }

    let coef = match solve(ata, aty, p) {
        Some(c) => c,
        None => {
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
    };

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
