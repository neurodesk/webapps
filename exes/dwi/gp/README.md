# dwi-gp

The Gaussian process of NiFreeze's GP DWI model, for head-motion correction (`hmc`).
It ports the parts of three projects that NiFreeze 3bcfb00 (`--models gp`) uses:

| Source | Licence | Here |
| --- | --- | --- |
| NiFreeze 3bcfb00 `model/gpr.py`: `SphericalKriging`, `spherical_covariance`, `compute_pairwise_angles`, `BOUNDS_A`, `BOUNDS_LAMBDA`, `THETA_EPSILON` | Apache-2.0 ([LICENSE-NIFREEZE](LICENSE-NIFREEZE)) | `src/kernel.rs` |
| NiFreeze 3bcfb00 `model/_dipy.py`: `GaussianProcessModel` defaults, `GP_JITTER`; `model/gpr.py`: `DiffusionGPR._constrained_optimization` | Apache-2.0 | `src/gpr.rs` |
| scikit-learn 1.9.1 `GaussianProcessRegressor` (`fit`, `log_marginal_likelihood`, `predict` mean), `WhiteKernel`, `Sum` | BSD-3-Clause ([LICENSE-SCIKIT-LEARN](LICENSE-SCIKIT-LEARN)) | `src/likelihood.rs`, `src/gpr.rs`, `src/kernel.rs` |
| scipy 1.18.1 `optimize/src/lbfgsb.c` (L-BFGS-B 3.0) and the `_minimize_lbfgsb` driver | BSD-3-Clause and MIT ([LICENSE-SCIPY](LICENSE-SCIPY)) | `src/lbfgsb.rs` |
| numpy 2.3.5 `pairwise_sum` (the order of `np.mean`, `np.std`, `.sum()`) | BSD-3-Clause ([LICENSE-NUMPY](LICENSE-NUMPY), numpy's own notice; the notices of the libraries that numpy bundles do not apply) | `src/numpy.rs` |

Each source file has an SPDX line for the code that it ports.
[LICENSE-NIFREEZE](LICENSE-NIFREEZE) starts with the NiPreps copyright notice of the NiFreeze source files.
[LICENSE-SCIPY](LICENSE-SCIPY) also retains David M. Cooke's MIT notice for the Python wrapper and gives the L-BFGS-B 3.0 authors and the papers that they ask users to cite.

## The model

For each held-out volume, NiFreeze fits one GP to the other volumes and predicts the held-out volume.

- Inputs: the b-vectors of the n training volumes. The b-value is not an input, so all shells enter one GP.
- Targets: one per voxel of the mask (161668 for M0), all with one shared kernel.
- Kernel: `SphericalKriging(a, lambda) + WhiteKernel(sigma2)`, on the axial angle arccos(|g . g'|).
- Hyperparameters: theta = ln(a, lambda, sigma2), from ln(0.1, 2.0, 1.0). The bounds are (0.1, 2.35), (1e-3, 1e3) and (1e-5, 1e5). a starts on its lower bound.
- `alpha` = 1e-10 and `normalize_y` = true.
- Optimizer: L-BFGS-B with scipy's defaults (m = 10, factr = 1e7, pgtol = 1e-5, maxiter = maxfun = 15000, maxls = 20). There are no restarts, so the fit uses no random numbers. The CLI `--seed` of NiFreeze does not reach the GP.
- Prediction: the posterior mean only.

```rust
use dwi_gp::GaussianProcess;
// x: n b-vectors; y: target major (each voxel's n samples are contiguous), i16 or f64.
let fit = GaussianProcess::default().fit(&x, &y)?;
let mean = fit.predict(&[held_out_bvec])?; // one value per target
```

## Memory

scikit-learn's gradient builds an (n, n, targets) float64 array: 89 x 89 x 161668 = 10.2 GB.
The trace is linear, so the sum over the targets comes first:
sum_t 0.5 tr((a_t a_t' - K^-1) dK) = 0.5 tr((A A' - T K^-1) dK), with A = K^-1 Y.
This is the patch of the M0 runs. No buffer of n x n x targets exists here.
`Likelihood` has two forms:

- `Form::Gram` (the default): S = Y Y' once per fit. Then sum_t y_t . a_t = tr(K^-1 S) and A A' = K^-1 S K^-1. One evaluation costs O(n^3) for any number of targets.
- `Form::PerTarget`: a_t = K^-1 y_t for each target, as scikit-learn does. One evaluation costs O(n^2 T).

`predict` solves K^-1 y_t one target at a time and does not keep alpha_.
The working memory is O(n^2 + T); the normalised targets (n x T) are the only large array.
`tests/memory.rs` runs one evaluation of each form, a full fit and a prediction at the M0 size (n = 89, T = 161668).
The peak resident size is 257 MiB, of which the targets are 137 MiB.
In a release build the test takes 1.7 s; one M0 `fit_predict` in Python took 5.5 s.
In a debug build (`cargo test`) it takes about 40-70 s, the longest test of the workspace.
The test reads `VmHWM` from `/proc/self/status`; on a system without it, the test does not check the peak.

At the M0 size, `Form::PerTarget` is about 200 times slower than `Form::Gram`.
In a review on the M0 data (held-out volume 7, release build), one fit took 0.3 s with `Form::Gram`, 61 s with `Form::PerTarget` and 8.2 s in scikit-learn.

## Agreement with scikit-learn and scipy

`tools/oracle.py` writes the fixtures in `tests/fixtures/` from NiFreeze 3bcfb00, scikit-learn 1.9.1 and scipy 1.18.1.
The X of each GP fixture is the 89 b-vectors of ds005577 sub-107 that the M0 dry run used.
The targets are synthetic.

| Fixture | What it tests |
| --- | --- |
| `bounded_shell` | Shell-like int16 targets from NiFreeze's start. a and lambda end on their lower bounds, as in all 90 M0 fits. |
| `stuck_inf` | Random targets. The first trial point is the box corner, K there is not positive definite, f = +inf, and the line search returns to theta0. |
| `interior` | GP-prior targets with an interior optimum, stop on the relative reduction of f. |
| `interior_pgtol` | The same, stop on the projected gradient. |
| `lml_grid` | The lml and gradient at six theta for two target sets, from both scikit-learn's original gradient and the summed form. |
| `normalize_edge` | A constant target: std 1.0 and a column of zeros. |
| `lbfgsb_rosen_box` | 6-D Rosenbrock in a box: 38 updates, so the memory shifts (`iupdat > m`). |
| `lbfgsb_rosen_backtrack` | 4-D Rosenbrock where `subsm` goes back along the projected path. |
| `lbfgsb_mixed` | Free, lower-only, upper-only and boxed variables; x0 outside the box. |

The oracle checks the stopping margins of the interior fixtures.
At each iterate before the last, the relative reduction of f is more than 10 times its tolerance, and the projected gradient is more than 2 times pgtol.
At the last iterate, the test that stops the run passes by a factor of 2 or more.
The other test is either a factor of 2 from its limit, or it also stops the run at that iterate.
A rounding difference of 1e-10 thus cannot change where the fit stops.

Measured on x86-64 Linux, both forms (largest value over the fixtures):

| Quantity | Measured | Test limit |
| --- | --- | --- |
| lml at every traced theta and on the grid, relative | 2.2e-15 | 1e-10 |
| gradient on the grid, against scikit-learn's original (n, n, T) form | 1.8e-13 | 1e-10 |
| gradient at every traced theta | 1.1e-12 | 1e-10 |
| theta at each step of the fit path | 4.5e-13 | 1e-11 |
| fitted (a, lambda, sigma2), interior fixtures, relative | 1.6e-14 | 1e-6 |
| bounded fixture: a and lambda | the lower bounds, bit for bit | equal |
| posterior mean | 5.7e-15 | 1e-12 |
| evaluations, iterations, status, message | equal | equal |
| L-BFGS-B on the plain functions, x at each step | 8.6e-12 | 1e-10 |

The gradient error is max |g - g_ref| / max(|g_ref|, 1).
Near an optimum each component is a small difference of large terms, and |g| falls to 1e-8.
No implementation agrees there to 1e-10 of |g|; scikit-learn's two forms do not either.
The measure is relative where |g| >= 1 and absolute below 1.
The pgtol test of the optimizer is absolute too.

## Differences from the sources

The port follows the operation order of the sources. These differences remain:

- BLAS and LAPACK. scipy links OpenBLAS. Here, `ddot`, `daxpy`, `dscal`, `dcopy`, `dnrm2` (sqrt of the sum of squares), `dtrtrs` and `dpotrf` (as the unblocked `dpotf2`) use the reference order. scikit-learn's Cholesky factorisation, `cho_solve`, matrix products and `einsum` are written as plain loops. Results can differ in the last bits. On Rosenbrock the L-BFGS-B path differs by about 1e-11, with the same branches.
- `pow(x, 2.0)` in `lbfgsb.c` is written `x * x`. glibc's `pow` is correctly rounded, so the values are the same.
- `exp`, `log`, `acos` and `pow` come from the `libm` crate, so the native and WebAssembly builds agree. On the fixtures, exp and log give numpy's bits for theta0 and the bounds (tested).
- `cauchy` keeps the C test `nbreak == n`, which a 0-based `nbreak` never meets. The Fortran's 1-based test could be true. This is scipy's behaviour, so it is kept.
- The driver calls the objective directly instead of the reverse-communication `task` protocol. The state transitions, the evaluation memo (a new evaluation only when x changes) and the counts are scipy's.
- When x becomes NaN, scipy's `ScalarFunction` and `MemoizeJac` fail their `x == self.x` test and call the objective twice for each point. The memo here calls it once. The counts, iterations, x and message are the same; only an objective with side effects can see the difference. The GP objective never returns NaN.
- `fit` refuses NaN and infinite values in X and y, and `predict` refuses them in query directions, with `FitError::NonFinite`, where scikit-learn raises `ValueError`.
- Not ported: restarts (`n_restarts_optimizer > 0`), `return_std` and `return_cov`, other kernels (exponential, multishell), `hess_inv`, and a fit where every variable is fixed by its bounds (an error here).
- scikit-learn warns when the optimizer does not converge and when a hyperparameter is near a bound. The port does not warn. `Fit::result` holds the status and message, and `Fit::theta` and `Fit::bounds_log` show a bound.

## Regenerate the fixtures

The inputs:

- A Python environment with NiFreeze 3bcfb00, scikit-learn 1.9.1, scipy 1.18.1 and numpy 2.3.5 (the M0 environment).
- `tools/sklearn-gpr-sum-targets.patch`, the M0 gradient patch, applied to the installed scikit-learn: `patch -d "$SITE_PACKAGES" -p1 < tools/sklearn-gpr-sum-targets.patch`. The fits run the installed (patched) `_gpr.py`, because that code made the M0 reference data.
- `$SKLEARN_GPR_ORIG`: a copy of the unpatched `sklearn/gaussian_process/_gpr.py` from the scikit-learn 1.9.1 wheel. `lml_grid` loads it for scikit-learn's original gradient.
- `$DS005577`: a directory with `sub-107_dir-AP_dwi.bvec` and `.bval` of OpenNeuro ds005577 v1.0.0 (CC0), `sub-107/dwi/`.

```bash
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
  "$VENV/bin/python" -I tools/oracle.py \
  "$DS005577/sub-107_dir-AP_dwi" \
  "$SKLEARN_GPR_ORIG" \
  tests/fixtures
```

The oracle stops when the bvec, the bval or one of the two `_gpr.py` files has a SHA-256 other than the M0 one.
Each fixture records the versions and the SHA-256 of the oracle and of both `_gpr.py` files.
After a change to the oracle, run it again: only `meta.oracle_sha256` must change.
Rust reads them with `serde_json`'s `float_roundtrip` feature; without it, the parser can change the last bit.
