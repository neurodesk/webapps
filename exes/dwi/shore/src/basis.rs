// SPDX-License-Identifier: BSD-3-Clause
//! The BrainSuite 3dSHORE basis as QSIPrep 26.1.1 computes it: `brainsuite_shore_basis` and
//! `shore_index_matrix` (`qsiprep/utils/brainsuite_shore.py`), `real_sym_sh_brainsuite`
//! (`qsiprep/utils/shm.py`), and the parts of DIPY 1.12.1's `gradient_table` and
//! `cart2sphere` that the basis depends on.

use crate::special::{factorial, gamma_half, genlaguerre, lpmv};
use std::f64::consts::PI;

/// DIPY's default `b0_threshold`: rows with b <= 50 s/mm² get q = 0 inside the basis.
pub const DIPY_B0_THRESHOLD: f64 = 50.0;

/// DIPY's default `atol` for unit gradient directions.
pub const BVEC_ATOL: f64 = 1e-2;

/// The (n, l, m) of each basis column, in QSIPrep's order: n outer, then even l <= n, then
/// m = -l..l (`shore_index_matrix`). Radial order 6 gives 72 columns.
pub fn index_matrix(radial_order: usize) -> Vec<(usize, usize, i32)> {
    let mut indices = Vec::new();
    for n in 0..=radial_order {
        for l in (0..=n).step_by(2) {
            for m in -(l as i32)..=l as i32 {
                indices.push((n, l, m));
            }
        }
    }
    indices
}

/// BrainSuite's real symmetric spherical harmonics up to even order `sh_order`, at polar
/// angle `theta` and azimuth `phi` (DIPY's convention). Returns (1+order)(2+order)/2 values;
/// order l fills the columns l(l-1)/2 .. (l+1)(l+2)/2 with m = -l..l, and the odd-order
/// columns stay 0, as in `real_sym_sh_brainsuite`. The column for m < 0 is
/// √2 Re(Y_l^|m|) and the column for m > 0 is √2 (-1)^(m+1) Im(Y_l^m).
pub fn real_sym_sh_brainsuite(sh_order: usize, theta: f64, phi: f64) -> Vec<f64> {
    // shm.py swaps the angles to MATLAB's names: below, `azimuth` is its theta and `polar`
    // its phi.
    let (azimuth, polar) = (phi, theta);
    let nbases = (sh_order + 1) * (sh_order + 2) / 2;
    let mut s = vec![0.0; nbases];
    s[0] = 1.0 / (4.0 * PI).sqrt();
    let cos_polar = polar.cos();
    for l in (2..=sh_order).step_by(2) {
        let start = l * (l - 1) / 2;
        let mut re = vec![0.0; l + 1];
        let mut im = vec![0.0; l + 1];
        for m in 0..=l {
            let norm =
                ((2 * l + 1) as f64 / (4.0 * PI) * factorial(l - m) / factorial(l + m)).sqrt();
            let p = norm * lpmv(m, l, cos_polar);
            let angle = azimuth * m as f64;
            re[m] = p * angle.cos();
            im[m] = p * angle.sin();
        }
        let sqrt2 = 2.0f64.sqrt();
        for m in 1..=l {
            s[start + l - m] = sqrt2 * re[m];
            let sign = if (m + 1) % 2 == 0 { 1.0 } else { -1.0 };
            s[start + l + m] = sqrt2 * sign * im[m];
        }
        s[start + l] = re[0];
    }
    s
}

/// DIPY's `cart2sphere`: radius, polar angle and azimuth; the polar angle is 0 at r = 0.
pub fn cart2sphere(v: [f64; 3]) -> (f64, f64, f64) {
    let r = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let theta = if r > 0.0 { (v[2] / r).acos() } else { 0.0 };
    (r, theta, v[1].atan2(v[0]))
}

/// One row of `brainsuite_shore_basis` for a sample with b-value `b` and gradient `g`.
/// `tau` is the effective diffusion time; with QSIPrep's τ = 1/(4π²), q = √b.
///
/// DIPY's `gradient_table` keeps `g` as given (it does not normalise it). A direction more
/// than `BVEC_ATOL` from unit length is an error for b > 50 and is zeroed for b <= 50.
pub fn basis_row(
    radial_order: usize,
    zeta: f64,
    tau: f64,
    b: f64,
    g: [f64; 3],
) -> Result<Vec<f64>, String> {
    let norm = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
    let close_to_unit = (norm - 1.0).abs() <= BVEC_ATOL;
    if b > DIPY_B0_THRESHOLD && !close_to_unit {
        return Err(format!(
            "The direction for b = {b} has length {norm:.4}; DIPY needs unit vectors within {BVEC_ATOL}."
        ));
    }
    let (b, g) = if close_to_unit {
        (b, g)
    } else {
        (0.0, [0.0; 3])
    };
    let q = if b <= DIPY_B0_THRESHOLD {
        0.0
    } else {
        (b / (4.0 * (PI * PI) * tau)).sqrt()
    };
    let (r, theta, phi) = cart2sphere([q * g[0], q * g[1], q * g[2]]);
    let sh = real_sym_sh_brainsuite(radial_order, theta, phi);
    let r2 = r * r;
    let mut row = Vec::with_capacity(index_matrix(radial_order).len());
    for n in 0..=radial_order {
        for l in (0..=n).step_by(2) {
            let kappa = (2.0 * factorial(n - l) / (zeta.powf(1.5) * gamma_half(n))).sqrt();
            let radial = genlaguerre(n - l, l as f64 + 0.5, r2 / zeta)
                * (-r2 / (2.0 * zeta)).exp()
                * kappa
                * (r2 / zeta).powf(l as f64 / 2.0);
            let start = if l == 0 { 0 } else { l * (l - 1) / 2 };
            for k in 0..2 * l + 1 {
                row.push(radial * sh[start + k]);
            }
        }
    }
    Ok(row)
}

/// The basis matrix, one row per sample.
pub fn basis(
    radial_order: usize,
    zeta: f64,
    tau: f64,
    bvals: &[f64],
    bvecs: &[[f64; 3]],
) -> Result<Vec<Vec<f64>>, String> {
    bvals
        .iter()
        .zip(bvecs)
        .map(|(&b, &g)| basis_row(radial_order, zeta, tau, b, g))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_matrix_has_72_columns_in_n_outer_order() {
        let ind = index_matrix(6);
        assert_eq!(ind.len(), 72);
        assert_eq!(&ind[..3], &[(0, 0, 0), (1, 0, 0), (2, 0, 0)]);
        assert_eq!(ind[3], (2, 2, -2));
        assert_eq!(ind[71], (6, 6, 6));
        assert!(
            ind.iter()
                .all(|&(n, l, m)| l <= n && l % 2 == 0 && m.unsigned_abs() as usize <= l)
        );
    }

    #[test]
    fn harmonics_are_orthonormal_on_a_dense_grid() {
        // Riemann sum over the sphere: ∫ Y_i Y_j = δ_ij for the even-order harmonics.
        let (nt, np) = (200, 400);
        let mut gram = vec![vec![0.0; 28]; 28];
        for i in 0..nt {
            let theta = (i as f64 + 0.5) * PI / nt as f64;
            for j in 0..np {
                let phi = (j as f64 + 0.5) * 2.0 * PI / np as f64;
                let y = real_sym_sh_brainsuite(6, theta, phi);
                let w = theta.sin() * (PI / nt as f64) * (2.0 * PI / np as f64);
                for a in 0..28 {
                    for b in 0..28 {
                        gram[a][b] += w * y[a] * y[b];
                    }
                }
            }
        }
        for (a, row) in gram.iter().enumerate() {
            for (b, &v) in row.iter().enumerate() {
                let expected = if a == b { 1.0 } else { 0.0 };
                assert!((v - expected).abs() < 1e-3, "{a},{b}: {v}");
            }
        }
    }

    #[test]
    fn b0_row_is_the_isotropic_radial_term() {
        let row = basis_row(6, 700.0, 1.0 / (4.0 * PI * PI), 0.0, [0.0; 3]).unwrap();
        // At r = 0 only l = 0 columns survive (0^0 = 1 for l = 0).
        for (k, &(_, l, _)) in index_matrix(6).iter().enumerate() {
            if l > 0 {
                assert_eq!(row[k], 0.0);
            } else {
                assert!(row[k] != 0.0);
            }
        }
    }

    #[test]
    fn rejects_a_non_unit_direction_for_a_weighted_sample() {
        assert!(basis_row(6, 700.0, 1.0, 1000.0, [0.9, 0.0, 0.0]).is_err());
        assert!(basis_row(6, 700.0, 1.0, 1000.0, [1.005, 0.0, 0.0]).is_ok());
    }
}
