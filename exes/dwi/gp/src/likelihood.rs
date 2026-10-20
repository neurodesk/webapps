// SPDX-License-Identifier: BSD-3-Clause
//! The target normalisation and the log marginal likelihood of scikit-learn 1.9.1
//! `GaussianProcessRegressor` (`sklearn/gaussian_process/_gpr.py:275-280,541-656`)
//! for many targets that share one kernel.
//!
//! scikit-learn's gradient builds an (n, n, targets) array: 10 GB for 161668 targets.
//! The trace is linear, so the sum over the targets can come first:
//! sum_t 0.5 tr((a_t a_t' - K^-1) dK) = 0.5 tr((A A' - T K^-1) dK), with A = K^-1 Y.
//! This is the M0 patch of `_gpr.py`. The working memory is O(n^2); no buffer of size
//! n x n x targets exists. Two forms compute A A' and sum_t y_t . a_t:
//!
//! * [`Form::Gram`] (the default): S = Y Y' once per fit, then sum_t y_t . a_t =
//!   tr(K^-1 S) and A A' = K^-1 S K^-1. One evaluation costs O(n^3), whatever the
//!   number of targets.
//! * [`Form::PerTarget`]: a_t = K^-1 y_t for each target, as scikit-learn does, with
//!   the sums taken target by target. One evaluation costs O(n^2 T).

use crate::kernel::{Params, train_kernel};
use crate::linalg::{cho_solve, cho_solve_matrix, cholesky_lower};
use crate::numpy::pairwise_sum;

/// The normalised targets: `normalize_y=True` in `GaussianProcessRegressor.fit`.
#[derive(Clone, Debug)]
pub struct Targets {
    /// Samples per target (training volumes).
    pub n: usize,
    /// Number of targets (voxels).
    pub t: usize,
    /// `_y_train_mean`, one per target.
    pub mean: Vec<f64>,
    /// `_y_train_std`, one per target, after `_handle_zeros_in_scale`.
    pub std: Vec<f64>,
    /// `y_train_`, target major: the n samples of target t are y[t*n .. (t+1)*n].
    pub y: Vec<f64>,
}

impl Targets {
    /// `_gpr.py:275-280`. `data` is target major (each target's n samples are
    /// contiguous, as NiFreeze's (voxels, volumes) array is), so numpy reduces along
    /// a contiguous axis: `np.mean` and `np.std` (ddof 0) use [`pairwise_sum`].
    /// A standard deviation below 10 eps is taken as 1 (`_handle_zeros_in_scale`).
    pub fn normalize<T: Copy + Into<f64>>(data: &[T], n: usize) -> Self {
        assert!(
            n > 0 && data.len() % n == 0,
            "data is not a whole number of targets"
        );
        let t = data.len() / n;
        let nf = n as f64;
        let mut mean = Vec::with_capacity(t);
        let mut std = Vec::with_capacity(t);
        let mut y = Vec::with_capacity(data.len());
        let mut v = vec![0.0; n];
        for chunk in data.chunks_exact(n) {
            for (vi, &d) in v.iter_mut().zip(chunk) {
                *vi = d.into();
            }
            let mu = pairwise_sum(&v) / nf;
            let sq: Vec<f64> = v
                .iter()
                .map(|&x| {
                    let dev = x - mu;
                    dev * dev
                })
                .collect();
            let mut sd = (pairwise_sum(&sq) / nf).sqrt();
            if sd < 10.0 * f64::EPSILON {
                sd = 1.0;
            }
            for &x in &v {
                y.push((x - mu) / sd);
            }
            mean.push(mu);
            std.push(sd);
        }
        Targets { n, t, mean, std, y }
    }

    /// The n samples of target `t`.
    pub fn target(&self, t: usize) -> &[f64] {
        &self.y[t * self.n..(t + 1) * self.n]
    }
}

/// How [`Likelihood`] sums over the targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    /// S = Y Y' once; O(n^3) per evaluation.
    Gram,
    /// K^-1 y_t for each target; O(n^2 T) per evaluation.
    PerTarget,
}

/// The log marginal likelihood of a fixed training set as a function of theta.
#[derive(Clone, Debug)]
pub struct Likelihood<'a> {
    angles: &'a [f64],
    targets: &'a Targets,
    alpha: f64,
    form: Form,
    gram: Vec<f64>,
}

impl<'a> Likelihood<'a> {
    /// `angles` are the n x n training angles ([`crate::kernel::pairwise_angles`]),
    /// `alpha` the value added to the diagonal (`GP_JITTER` = 1e-10 in NiFreeze).
    pub fn new(angles: &'a [f64], targets: &'a Targets, alpha: f64, form: Form) -> Self {
        let n = targets.n;
        assert_eq!(angles.len(), n * n);
        let gram = match form {
            Form::Gram => gram(targets),
            Form::PerTarget => Vec::new(),
        };
        Likelihood {
            angles,
            targets,
            alpha,
            form,
            gram,
        }
    }

    /// `log_marginal_likelihood(theta, eval_gradient=True)` (`_gpr.py:541-656`):
    /// the summed lml and its gradient with respect to theta. When K + alpha I is not
    /// positive definite, returns (-inf, [0, 0, 0]) as scikit-learn does.
    pub fn eval(&self, theta: &[f64; 3]) -> (f64, [f64; 3]) {
        let n = self.targets.n;
        let tf = self.targets.t as f64;
        let p = Params::from_theta(theta);
        let mut g: [Vec<f64>; 3] = Default::default();
        let mut l = train_kernel(self.angles, n, &p, Some(&mut g));
        for i in 0..n {
            l[i * n + i] += self.alpha;
        }
        if !cholesky_lower(&mut l, n) {
            return (f64::NEG_INFINITY, [0.0; 3]);
        }
        let logs: Vec<f64> = (0..n).map(|i| libm::log(l[i * n + i])).collect();
        let sumlog = pairwise_sum(&logs);
        let half_log_2pi = (n as f64) / 2.0 * libm::log(2.0 * std::f64::consts::PI);

        let mut ident = vec![0.0; n * n];
        for i in 0..n {
            ident[i * n + i] = 1.0;
        }
        let k_inv = cho_solve_matrix(&l, n, &ident);

        // aat = A A' = sum_t a_t a_t'
        let (lml, aat) = match self.form {
            Form::Gram => {
                let m1 = cho_solve_matrix(&l, n, &self.gram);
                let diag: Vec<f64> = (0..n).map(|i| m1[i * n + i]).collect();
                let data = pairwise_sum(&diag);
                let mut m1t = vec![0.0; n * n];
                for i in 0..n {
                    for j in 0..n {
                        m1t[i * n + j] = m1[j * n + i];
                    }
                }
                let aat = cho_solve_matrix(&l, n, &m1t);
                (-0.5 * data - tf * sumlog - tf * half_log_2pi, aat)
            }
            Form::PerTarget => {
                let mut aat = vec![0.0; n * n];
                let mut dims = Vec::with_capacity(self.targets.t);
                let mut a = vec![0.0; n];
                for t in 0..self.targets.t {
                    let y = self.targets.target(t);
                    a.copy_from_slice(y);
                    cho_solve(&l, n, &mut a);
                    let mut dot = 0.0;
                    for i in 0..n {
                        dot += y[i] * a[i];
                    }
                    dims.push(-0.5 * dot - sumlog - half_log_2pi);
                    for i in 0..n {
                        for j in 0..n {
                            aat[i * n + j] += a[i] * a[j];
                        }
                    }
                }
                (pairwise_sum(&dims), aat)
            }
        };

        // 0.5 * einsum("ij,jik->k", A A' - T K^-1, K_gradient)
        let mut grad = [0.0; 3];
        for (k, gk) in g.iter().enumerate() {
            let mut s = 0.0;
            for i in 0..n {
                for j in 0..n {
                    s += (aat[i * n + j] - tf * k_inv[i * n + j]) * gk[j * n + i];
                }
            }
            grad[k] = 0.5 * s;
        }
        (lml, grad)
    }

    /// The objective that scikit-learn hands to the optimizer (`_gpr.py:302-309`):
    /// returns -lml and writes -grad. A failed factorisation gives +inf and -0.0.
    pub fn objective(&self, theta: &[f64], g: &mut [f64]) -> f64 {
        let (lml, grad) = self.eval(&[theta[0], theta[1], theta[2]]);
        for k in 0..3 {
            g[k] = -grad[k];
        }
        -lml
    }
}

/// S = Y Y' = sum_t y_t y_t', n x n row major.
fn gram(targets: &Targets) -> Vec<f64> {
    let n = targets.n;
    let mut s = vec![0.0; n * n];
    for t in 0..targets.t {
        let y = targets.target(t);
        for i in 0..n {
            let yi = y[i];
            let row = &mut s[i * n..i * n + i + 1];
            for (j, sj) in row.iter_mut().enumerate() {
                *sj += yi * y[j];
            }
        }
    }
    for i in 0..n {
        for j in (i + 1)..n {
            s[i * n + j] = s[j * n + i];
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_target_has_unit_std_and_zero_column() {
        let data: Vec<i16> = vec![700, 700, 700, 1, 2, 3];
        let t = Targets::normalize(&data, 3);
        assert_eq!(t.std[0], 1.0);
        assert_eq!(t.target(0), &[0.0, 0.0, 0.0]);
        assert_eq!(t.mean[1], 2.0);
    }
}
