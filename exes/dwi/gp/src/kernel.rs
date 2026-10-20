// SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause
// Ports NiFreeze code: Copyright The NiPreps Developers <nipreps@gmail.com>
// (LICENSE-NIFREEZE), and scikit-learn code (LICENSE-SCIKIT-LEARN).
//! NiFreeze 3bcfb00's GP kernel: `SphericalKriging(beta_a, beta_l) +
//! WhiteKernel(noise_level)` (`nifreeze/model/_dipy.py:175-180`).
//!
//! The spherical kriging covariance and the pairwise angles port
//! `nifreeze/model/gpr.py:450-466,694,697-760` (Apache-2.0). The white-noise term
//! ports scikit-learn 1.9.1 `WhiteKernel` (`sklearn/gaussian_process/kernels.py:1403-1419`)
//! and the sum ports `Sum.__call__` (`kernels.py:866-869`) (BSD-3-Clause).
//!
//! scikit-learn keeps the hyperparameters as theta = [ln a, ln lambda, ln sigma2]
//! (the order of `Kernel.hyperparameters`, sorted by name, then k1 before k2) and the
//! kernel uses exp(theta), not the given value: exp(ln 0.1) != 0.1.

/// `BOUNDS_A` (`gpr.py:54`): the angular range a, in radians.
pub const BOUNDS_A: (f64, f64) = (0.1, 2.35);
/// `BOUNDS_LAMBDA` (`gpr.py:56`): the signal scale lambda.
pub const BOUNDS_LAMBDA: (f64, f64) = (1e-3, 1000.0);
/// `WhiteKernel`'s default `noise_level_bounds` (`kernels.py:1366`).
pub const BOUNDS_NOISE: (f64, f64) = (1e-5, 1e5);
/// `THETA_EPSILON` (`gpr.py:58`): smaller angles are set to zero.
pub const THETA_EPSILON: f64 = 1e-5;

/// The linear hyperparameters a, lambda and sigma2 for a log-space theta.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Params {
    pub a: f64,
    pub lambda: f64,
    pub sigma2: f64,
}

impl Params {
    /// `Kernel.theta.setter` (`kernels.py:314-343`): params = exp(theta).
    pub fn from_theta(theta: &[f64; 3]) -> Self {
        Params {
            a: libm::exp(theta[0]),
            lambda: libm::exp(theta[1]),
            sigma2: libm::exp(theta[2]),
        }
    }
}

/// `sklearn.preprocessing.normalize` (`row_norms` then `_handle_zeros_in_scale`):
/// divides each row by its L2 norm; a norm below 10 eps is taken as 1.
fn normalize_rows(x: &[[f64; 3]]) -> Vec<[f64; 3]> {
    x.iter()
        .map(|r| {
            let mut norm = (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt();
            if norm < 10.0 * f64::EPSILON {
                norm = 1.0;
            }
            [r[0] / norm, r[1] / norm, r[2] / norm]
        })
        .collect()
}

/// `compute_pairwise_angles(X, Y, closest_polarity=True)` (`gpr.py:757-760`): the
/// axial angle arccos(|cos|) between the rows, in [0, pi/2], with angles below
/// [`THETA_EPSILON`] set to zero. Returns a rows(x) x rows(y) matrix, row major.
pub fn pairwise_angles(x: &[[f64; 3]], y: &[[f64; 3]]) -> Vec<f64> {
    let xn = normalize_rows(x);
    let yn = normalize_rows(y);
    let mut out = Vec::with_capacity(x.len() * y.len());
    for a in &xn {
        for b in &yn {
            let c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).clamp(-1.0, 1.0);
            let mut t = libm::acos(c.abs());
            if t.abs() < THETA_EPSILON {
                t = 0.0;
            }
            out.push(t);
        }
    }
    out
}

/// `spherical_covariance` (`gpr.py:694`).
pub fn spherical_covariance(theta: f64, a: f64) -> f64 {
    if theta <= a {
        1.0 - 1.5 * theta / a + 0.5 * libm::pow(theta, 3.0) / libm::pow(a, 3.0)
    } else {
        0.0
    }
}

/// d K / d ln a of `SphericalKriging.__call__` (`gpr.py:457-463`).
fn deriv_a(theta: f64, p: &Params) -> f64 {
    if theta <= p.a {
        1.5 * p.lambda * (theta / p.a - libm::pow(theta, 3.0) / libm::pow(p.a, 3.0))
    } else {
        0.0
    }
}

/// K(X) = lambda C + sigma2 I for the n x n training angles, and, when `grad` is
/// given, the three matrices d K / d theta_k: [d/d ln a, lambda C, sigma2 I].
pub fn train_kernel(
    angles: &[f64],
    n: usize,
    p: &Params,
    grad: Option<&mut [Vec<f64>; 3]>,
) -> Vec<f64> {
    let mut k = vec![0.0; n * n];
    for (kv, &t) in k.iter_mut().zip(angles) {
        *kv = p.lambda * spherical_covariance(t, p.a);
    }
    // Sum: k1(X) + k2(X); WhiteKernel adds sigma2 on the diagonal only.
    for i in 0..n {
        k[i * n + i] += p.sigma2;
    }
    if let Some(g) = grad {
        for gk in g.iter_mut() {
            gk.clear();
            gk.resize(n * n, 0.0);
        }
        for (idx, &t) in angles.iter().enumerate() {
            g[0][idx] = deriv_a(t, p);
            g[1][idx] = p.lambda * spherical_covariance(t, p.a);
        }
        for i in 0..n {
            g[2][i * n + i] = p.sigma2;
        }
    }
    k
}

/// K(X_new, X) = lambda C: the white-noise term is zero between two sets
/// (`WhiteKernel.__call__` with Y given, `kernels.py:1416-1419`).
pub fn cross_kernel(angles: &[f64], p: &Params) -> Vec<f64> {
    angles
        .iter()
        .map(|&t| p.lambda * spherical_covariance(t, p.a))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antipodal_vectors_have_angle_zero() {
        let x = [[1.0, 0.0, 0.0], [-2.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let t = pairwise_angles(&x, &x);
        assert_eq!(t[1], 0.0);
        assert!((t[2] - std::f64::consts::FRAC_PI_2).abs() < 1e-15);
    }

    #[test]
    fn covariance_is_continuous_at_a() {
        assert_eq!(spherical_covariance(0.0, 0.5), 1.0);
        assert!(spherical_covariance(0.5, 0.5).abs() < 1e-15);
        assert_eq!(spherical_covariance(0.6, 0.5), 0.0);
    }
}
