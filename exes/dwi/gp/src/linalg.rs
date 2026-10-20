// SPDX-License-Identifier: BSD-3-Clause
//! The dense linear algebra of scikit-learn's `GaussianProcessRegressor`:
//! `scipy.linalg.cholesky(K, lower=True)` and `cho_solve((L, True), B)`.
//!
//! Matrices are n x n, row major. The factorisation is LAPACK's unblocked `dpotf2`
//! ("L") in its operation order; scipy calls OpenBLAS's blocked `dpotrf`, so the last
//! bits can differ. A pivot that is not positive, or is NaN, is a failure, as in
//! LAPACK (scipy then raises `LinAlgError`).

/// Overwrites the lower triangle of `a` with L, where A = L L'. The strict upper
/// triangle is set to zero. Returns false when A is not positive definite.
pub fn cholesky_lower(a: &mut [f64], n: usize) -> bool {
    for j in 0..n {
        let mut ajj = a[j * n + j];
        for k in 0..j {
            ajj -= a[j * n + k] * a[j * n + k];
        }
        if ajj <= 0.0 || ajj.is_nan() {
            return false;
        }
        ajj = ajj.sqrt();
        a[j * n + j] = ajj;
        let r = 1.0 / ajj;
        for i in (j + 1)..n {
            let mut s = a[i * n + j];
            for k in 0..j {
                s -= a[i * n + k] * a[j * n + k];
            }
            a[i * n + j] = s * r;
        }
    }
    for i in 0..n {
        for j in (i + 1)..n {
            a[i * n + j] = 0.0;
        }
    }
    true
}

/// Solves L L' x = b in place, with L from [`cholesky_lower`].
pub fn cho_solve(l: &[f64], n: usize, b: &mut [f64]) {
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i {
            s -= l[i * n + k] * b[k];
        }
        b[i] = s / l[i * n + i];
    }
    for i in (0..n).rev() {
        let mut s = b[i];
        for k in (i + 1)..n {
            s -= l[k * n + i] * b[k];
        }
        b[i] = s / l[i * n + i];
    }
}

/// `cho_solve((L, True), B)` for an n x n B (row major): returns K^-1 B, row major.
pub fn cho_solve_matrix(l: &[f64], n: usize, b: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; n * n];
    let mut col = vec![0.0; n];
    for j in 0..n {
        for i in 0..n {
            col[i] = b[i * n + j];
        }
        cho_solve(l, n, &mut col);
        for i in 0..n {
            out[i * n + j] = col[i];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_a_small_system() {
        let a = [4.0, 2.0, 2.0, 3.0];
        let mut l = a;
        assert!(cholesky_lower(&mut l, 2));
        let mut b = [2.0, 1.0];
        cho_solve(&l, 2, &mut b);
        assert!((4.0 * b[0] + 2.0 * b[1] - 2.0).abs() < 1e-15);
        assert!((2.0 * b[0] + 3.0 * b[1] - 1.0).abs() < 1e-15);
        let inv = cho_solve_matrix(&l, 2, &[1.0, 0.0, 0.0, 1.0]);
        assert!((inv[0] - 0.375).abs() < 1e-15 && (inv[1] + 0.25).abs() < 1e-15);
    }

    #[test]
    fn rejects_indefinite_and_nan() {
        let mut a = [1.0, 2.0, 2.0, 1.0];
        assert!(!cholesky_lower(&mut a, 2));
        let mut a = [f64::NAN];
        assert!(!cholesky_lower(&mut a, 1));
    }
}
