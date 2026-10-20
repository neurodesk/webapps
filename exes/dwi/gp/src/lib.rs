// SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0 AND MIT
//! The Gaussian process of NiFreeze 3bcfb00's GP DWI model: a port of the parts of
//! scikit-learn 1.9.1 `GaussianProcessRegressor` (BSD-3-Clause) and scipy 1.18.1
//! L-BFGS-B (BSD-3-Clause, with its MIT-licensed driver) that it uses, with NiFreeze's
//! spherical kriging kernel (Apache-2.0).
//!
//! The model predicts a held-out DWI volume from the others: one GP over the
//! b-vectors (the b-value is not an input), one target per mask voxel, all targets
//! sharing the kernel `SphericalKriging(a, lambda) + WhiteKernel(sigma2)`. The fit
//! maximises the summed log marginal likelihood over theta = ln(a, lambda, sigma2)
//! with L-BFGS-B from (0.1, 2.0, 1.0).
//!
//! ```
//! use dwi_gp::GaussianProcess;
//! let x = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.6, 0.8, 0.0]];
//! // Two targets (voxels), four samples each, target major.
//! let y: [i16; 8] = [500, 300, 420, 380, 900, 880, 905, 870];
//! let fit = GaussianProcess::default().fit(&x, &y).unwrap();
//! let mean = fit.predict(&[[0.0, 0.6, 0.8]]).unwrap();
//! assert_eq!(mean.len(), 2);
//! ```

pub mod gpr;
pub mod kernel;
pub mod lbfgsb;
pub mod likelihood;
mod linalg;
mod numpy;

pub use gpr::{Evaluation, Fit, FitError, GP_JITTER, GaussianProcess};
pub use likelihood::{Form, Likelihood, Targets};
pub use numpy::pairwise_sum;
