// SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
// Ports scikit-learn code (LICENSE-SCIKIT-LEARN) and NiFreeze code:
// Copyright The NiPreps Developers <nipreps@gmail.com> (LICENSE-NIFREEZE).
//! `GaussianProcessRegressor.fit` and `predict` of scikit-learn 1.9.1
//! (`_gpr.py:233-368,444-457`, BSD-3-Clause) with the settings of NiFreeze 3bcfb00's
//! `GaussianProcessModel.fit` and `DiffusionGPR` (`nifreeze/model/_dipy.py:115-180,
//! 215-239`, `nifreeze/model/gpr.py:228-253`, Apache-2.0).

use crate::kernel::{
    BOUNDS_A, BOUNDS_LAMBDA, BOUNDS_NOISE, Params, cross_kernel, pairwise_angles, train_kernel,
};
use crate::lbfgsb::{self, OptimizeResult, Options};
use crate::likelihood::{Form, Likelihood, Targets};
use crate::linalg::{cho_solve, cholesky_lower};

/// `GP_JITTER` (`_dipy.py:42`), the regressor's `alpha`.
pub const GP_JITTER: f64 = 1e-10;

/// The regressor's settings. [`Default`] gives NiFreeze's `GaussianProcessModel()`.
#[derive(Clone, Debug)]
pub struct GaussianProcess {
    /// Start values (a, lambda, sigma2): `beta_a=0.1`, `beta_l=2.0`, `sigma_sq=1.0`
    /// (`_dipy.py:115-121`).
    pub start: [f64; 3],
    /// Linear bounds of (a, lambda, sigma2).
    pub bounds: [(f64, f64); 3],
    /// Added to the diagonal of K.
    pub alpha: f64,
    /// How the likelihood sums over the targets.
    pub form: Form,
    /// The optimizer options; NiFreeze passes none, so scipy's defaults apply.
    pub options: Options,
}

impl Default for GaussianProcess {
    fn default() -> Self {
        GaussianProcess {
            start: [0.1, 2.0, 1.0],
            bounds: [BOUNDS_A, BOUNDS_LAMBDA, BOUNDS_NOISE],
            alpha: GP_JITTER,
            form: Form::Gram,
            options: Options::default(),
        }
    }
}

/// One objective evaluation of the optimizer.
#[derive(Clone, Debug, PartialEq)]
pub struct Evaluation {
    pub theta: [f64; 3],
    /// -lml
    pub f: f64,
    /// -d lml / d theta
    pub g: [f64; 3],
}

/// Why a fit failed.
#[derive(Clone, Debug, PartialEq)]
pub enum FitError {
    /// X has no rows, or y does not hold a whole number of targets of n samples.
    Shape,
    /// Training or query directions, or targets, hold NaN or an infinite value.
    /// scikit-learn's `validate_data` raises `ValueError` before fitting or prediction.
    NonFinite,
    /// The optimizer refused its input.
    Optimizer(lbfgsb::Error),
    /// K + alpha I at the fitted theta is not positive definite; scikit-learn raises
    /// `LinAlgError` from `fit` (`_gpr.py:349-361`).
    NotPositiveDefinite,
}

impl std::fmt::Display for FitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FitError::Shape => f.write_str("X and y do not agree in shape"),
            FitError::NonFinite => f.write_str("X or y contains NaN or infinity"),
            FitError::Optimizer(e) => write!(f, "optimizer: {e}"),
            FitError::NotPositiveDefinite => {
                f.write_str("the kernel matrix at the fitted theta is not positive definite")
            }
        }
    }
}

impl std::error::Error for FitError {}

/// A fitted regressor.
#[derive(Clone, Debug)]
pub struct Fit {
    /// `X_train_`.
    pub x_train: Vec<[f64; 3]>,
    /// The normalised targets.
    pub targets: Targets,
    /// The log-space start (`kernel.theta`) and bounds (`kernel.bounds`).
    pub theta0: [f64; 3],
    pub bounds_log: [(f64, f64); 3],
    /// `kernel_.theta` after the fit.
    pub theta: [f64; 3],
    /// `log_marginal_likelihood_value_`.
    pub lml: f64,
    /// The optimizer result.
    pub result: OptimizeResult,
    /// Every objective evaluation, in order.
    pub trace: Vec<Evaluation>,
    /// The iterates (x, f) that scipy passes to a callback.
    pub iterations: Vec<([f64; 3], f64)>,
    /// `L_`, the lower Cholesky factor of K + alpha I at `theta`, row major.
    l: Vec<f64>,
}

impl GaussianProcess {
    /// `fit(X, y)`: `x` holds the b-vectors (n rows), `y` is target major, n samples
    /// per target. One optimizer run from `start` (`n_restarts_optimizer=0`).
    pub fn fit<T: Copy + Into<f64>>(&self, x: &[[f64; 3]], y: &[T]) -> Result<Fit, FitError> {
        let n = x.len();
        if n == 0 || y.is_empty() || y.len() % n != 0 {
            return Err(FitError::Shape);
        }
        if x.iter().flatten().any(|v| !v.is_finite())
            || y.iter().any(|&v| !Into::<f64>::into(v).is_finite())
        {
            return Err(FitError::NonFinite);
        }
        let targets = Targets::normalize(y, n);
        let angles = pairwise_angles(x, x);

        // kernel.theta and kernel.bounds are np.log of the values (kernels.py:290-362).
        let theta0 = [
            libm::log(self.start[0]),
            libm::log(self.start[1]),
            libm::log(self.start[2]),
        ];
        let bounds_log = self.bounds.map(|(lo, hi)| (libm::log(lo), libm::log(hi)));
        let lower: Vec<f64> = bounds_log.iter().map(|b| b.0).collect();
        let upper: Vec<f64> = bounds_log.iter().map(|b| b.1).collect();

        let lik = Likelihood::new(&angles, &targets, self.alpha, self.form);
        let mut trace = Vec::new();
        let mut iterations = Vec::new();
        let result = lbfgsb::minimize_observed(
            |th: &[f64], g: &mut [f64]| {
                let f = lik.objective(th, g);
                trace.push(Evaluation {
                    theta: [th[0], th[1], th[2]],
                    f,
                    g: [g[0], g[1], g[2]],
                });
                f
            },
            &theta0,
            &lower,
            &upper,
            &self.options,
            |th: &[f64], f: f64| iterations.push(([th[0], th[1], th[2]], f)),
        )
        .map_err(FitError::Optimizer)?;

        // _gpr.py:336-340 (one optimum) and 349-361 (L_ at the fitted theta).
        let theta = [result.x[0], result.x[1], result.x[2]];
        let lml = -result.fun;
        let p = Params::from_theta(&theta);
        let mut l = train_kernel(&angles, n, &p, None);
        for i in 0..n {
            l[i * n + i] += self.alpha;
        }
        if !cholesky_lower(&mut l, n) {
            return Err(FitError::NotPositiveDefinite);
        }
        Ok(Fit {
            x_train: x.to_vec(),
            targets,
            theta0,
            bounds_log,
            theta,
            lml,
            result,
            trace,
            iterations,
            l,
        })
    }
}

impl Fit {
    /// The fitted linear hyperparameters (a, lambda, sigma2).
    pub fn params(&self) -> Params {
        Params::from_theta(&self.theta)
    }

    /// `predict(X_new, return_std=False)` (`_gpr.py:444-457`): the posterior mean,
    /// `std * (K(X_new, X) @ alpha_) + mean`, for each new row and target. Returns a
    /// rows x targets matrix, row major. `alpha_ = K^-1 y` is solved one target at a
    /// time, so no n x targets array is stored. Non-finite query directions return
    /// [`FitError::NonFinite`], as scikit-learn's prediction validation does.
    pub fn predict(&self, x_new: &[[f64; 3]]) -> Result<Vec<f64>, FitError> {
        if x_new.iter().flatten().any(|v| !v.is_finite()) {
            return Err(FitError::NonFinite);
        }
        let n = self.targets.n;
        let nt = self.targets.t;
        let rows = x_new.len();
        let k_trans = cross_kernel(&pairwise_angles(x_new, &self.x_train), &self.params());
        let mut out = vec![0.0; rows * nt];
        let mut a = vec![0.0; n];
        for t in 0..nt {
            a.copy_from_slice(self.targets.target(t));
            cho_solve(&self.l, n, &mut a);
            for r in 0..rows {
                let kr = &k_trans[r * n..(r + 1) * n];
                let mut s = 0.0;
                for i in 0..n {
                    s += kr[i] * a[i];
                }
                out[r * nt + t] = self.targets.std[t] * s + self.targets.mean[t];
            }
        }
        Ok(out)
    }
}
