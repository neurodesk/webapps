# dwi-shore

3dSHORE signal prediction for SHORELine head motion correction (Cieslak et al. 2021), ported from QSIPrep 26.1.1 (BSD-3-Clause, [LICENSE-QSIPREP](LICENSE-QSIPREP)).
SHORELine is the default model iteration of QSIPrep's model-based head motion correction.
This crate is the model: for each diffusion-weighted volume it predicts the signal from the other volumes.
The registration, the b0 template and the iterations belong to the `hmc` work in #457 and #458.

## What is ported

| QSIPrep 26.1.1 | Here |
| --- | --- |
| `utils/brainsuite_shore.py` `shore_index_matrix` | `basis::index_matrix` |
| `utils/brainsuite_shore.py` `brainsuite_shore_basis`, `_kappa` | `basis::basis_row`, `basis::basis` |
| `utils/shm.py` `real_sym_sh_brainsuite` | `basis::real_sym_sh_brainsuite` |
| `utils/brainsuite_shore.py` `BrainSuiteShoreModel(regularization='L2')`: `_n_shore`, `_l_shore`, `fit` | `prediction_weights` |
| `interfaces/shoreline.py` `_nonoverlapping_qspace_samples` | `nonoverlapping_samples` |
| `interfaces/shoreline.py` `SignalPrediction` (`model='3dshore'`) | `TargetFit::new`, `TargetFit::predict`, `mask_from_image` |
| DIPY 1.12.1 `gradient_table` (b0 rule, unit-vector check) and `cart2sphere` | inside `basis::basis_row` and `basis::cart2sphere` |

The basis has 72 columns: n = 0..6 outer, even l <= n, m = -l..l.
q = √(b / (4π²τ)) with τ = 1/(4π²), so q = √b; rows with b <= 50 get q = 0.
The angular part is BrainSuite's real harmonics with the Condon-Shortley phase.
`real_sym_sh_brainsuite` swaps DIPY's angle names to MATLAB's; the port keeps that order.
At r = 0, 0⁰ = 1, so only the l = 0 columns of a b0 row are non-zero.
DIPY does not normalise the directions. A direction within 1e-2 of unit length is used as given; for b > 50 a longer or shorter one is an error.

`special.rs` uses standard recurrences for the associated Legendre function and the generalised Laguerre polynomial, and closed forms for Γ(n + 3/2) and n!.
It does not port scipy's or specfun's code; `tests/oracle.rs` holds the basis to QSIPrep's.

### The fit and the prediction

QSIPrep fits each masked voxel: `coef = solve(MᵀM + λN·N + λL·L, Mᵀ) · data`, then `prediction = coef · m_pred`.
N = diag((n(n+1))²) and L = diag((l(l+1))²); λN = λL = 1e-8; the (0, 0) column has no penalty.
The fit is linear in the data, so the prediction is `w · data` with `w = M A⁻¹ m_pred`.
`TargetFit::new` computes `w` once per target volume with a Cholesky solve; `predict` applies it to every voxel.

The penalty is not a small numerical ridge.
The basis values are small (κ ∝ ζ^(-3/4)), so 1e-8·(n(n+1))² is of the same order as MᵀM.
On synthetic schemes like ds005577 (30 + 60 directions), ADNI3 (6 + 48 + 60) and one 32-direction shell, M has rank 44, 49 to 50 and 29 of 72 (31 on the fixture), but A is well conditioned (condition number 4e2 to 3e3).
Thus the data does not determine the fit, and the penalty selects it: a solve with a plain 1e-14 ridge (close to a pseudoinverse) gives predictions that differ by 106 % of the volume maximum.
Because A is well conditioned, the Cholesky solve equals QSIPrep's LAPACK `gesv` to rounding; the port does not need LAPACK's operation order.

### Training set

`TargetFit::new` assembles the training set as `SignalPrediction` does.
Sample 0 is the b0 mean (b = 0, zero direction); the others are the model volumes, which are the series without its b0 volumes.
q = √(b - min b) is scaled to percent of the largest q.
A sample is left out when its scaled q-vector or its antipode is within 2.0 of the target's, so the target itself is always left out.
If the rule would leave out the b0 mean, QSIPrep's images and gradients would no longer match; the port returns an error.

The caller removes the b0 volumes with QSIPrep's rule, b < 100 s/mm² (#439 adds it to `dwi-gradients`).
It also gives the current (rotated) directions and the mask: voxels where the mask image is above 1e-6.
Outside the mask the prediction is 0.

## Parity

`tools/oracle.py` writes `tests/fixtures/*.json` from QSIPrep 26.1.1's own code.
It loads `shm.py` and `brainsuite_shore.py` unchanged, takes `_nonoverlapping_qspace_samples` unchanged from `shoreline.py`, and repeats the 3dSHORE lines of `SignalPrediction` on a synthetic volume of crossing fibres.
Each fixture records the QSIPrep commit, the SHA-256 of the three files and the package versions.
Use the numerical stack of the QSIPrep container (its `pixi.lock`): Python 3.11, numpy 1.26.4 on netlib LAPACK 3.11, scipy 1.11.4, dipy 1.12.1, scikit-learn 1.4.0.

```bash
micromamba create -p ENV -c conda-forge python=3.11 numpy=1.26.4 scipy=1.11.4 dipy=1.12.1 \
  scikit-learn=1.4.0 nibabel=5.3.2 "libblas=*=*netlib" "liblapack=*=*netlib"
git clone https://github.com/PennLINC/qsiprep QSIPREP && git -C QSIPREP checkout 26.1.1
ENV/bin/python -I tools/oracle.py QSIPREP tests/fixtures
cargo test -p dwi-shore --test oracle -- --nocapture
```

A rerun writes the same bytes.

| Comparison (`tests/oracle.rs`) | Gate | Result |
| --- | --- | --- |
| Basis, 41 rows: b0 rows, the axes, an antipodal pair, a direction of length 1.005, four shells | 1e-12 | 3.0e-18 (5.7e-16 of the largest entry) |
| Leave-out masks, 32 targets | equal | equal |
| Prediction weights | 1e-10 | 3.7e-15 |
| Predictions, 32 targets, 120 voxels, mask values 0, 5e-7, 1e-6, 0.25 and 2 | 1e-5 of the volume maximum | 8.5e-15 |
| Predictions with a plain 1e-14 ridge in place of the penalty | must miss the gate | 1.06 |

### QSIPrep run

`tests/reference.rs` compares every volume of one SHORELine iteration with a QSIPrep 26.1.1 run.
The inputs must be the ones that the iteration's `predict_dwis` node received: its registered images and rotated directions.
Every iteration predicts from the previous iteration's registration, not from `qsiprep/input/split_dwis`.
`tools/reference.py` converts those inputs and the node's `predicted_image` files:

```bash
python -I tools/reference.py OUT --mask MASK --b0-mean B0_MEAN --bvals BVALS --bvecs BVECS \
  --dwis DWI... --predicted PREDICTED...
SHORE_REFERENCE=OUT cargo test --release -p dwi-shore --test reference -- --nocapture
```

Without `SHORE_REFERENCE` the test is skipped.
It waits for the ds005577 sub-107 reference runs (#409, #438).
QSIPrep 26.1.1 uses 3dSHORE in both default iterations (`hmc.py`, `shoreline_params.json`), so `initial_model_iteration` and `shoreline_iteration001` can both be checked.
QSIPrep writes the predictions as float32, so a perfect port differs by up to about 6e-8 of the maximum.

### Run time

`cargo run --release -p dwi-shore --example profile` times one pass at the size of ds005577 sub-107 (30 + 60 directions, 250 000 voxels).
On one thread of an AMD EPYC 9655: 0.3 ms for the weights and 7.2 ms for the prediction, per volume.
QSIPrep takes 32.8 s per volume (native mean).

## SHORELine, 3dSHORE and FSL eddy

SHORELine is a head motion correction method.
It aligns the b0 volumes to an unbiased b0 template.
Then, for each diffusion-weighted volume, it leaves the volume and its q-space neighbours out, predicts the volume from the others and registers the volume to the prediction.
It does this two times.
3dSHORE is the signal model that makes the predictions (this crate); QSIPrep also offers a tensor model and none.

The webapps use SHORELine as a replacement for FSL eddy, which the FSL licence does not let us port.
QSIPrep 26.1.1 makes eddy its default method and marks SHORELine for removal in a future major release; QSIPrep's choice does not change ours.
The table compares the methods. The signal model row compares 3dSHORE with eddy's Gaussian process; the other rows compare SHORELine with eddy.

| | SHORELine in QSIPrep 26.1.1 | SHORELine in the webapps | FSL eddy, QSIPrep defaults |
| --- | --- | --- | --- |
| Corrects | Head motion: one 12-parameter affine per volume. The affine also absorbs the linear part of eddy-current distortion, not only along the phase-encoding axis. With a field map, susceptibility distortion at the final resampling | The same; field maps from topup output (`_fieldcoef`, `movpar`) or in Hz. Slice outlier replacement and an eddy-current model are prototypes | Head motion, eddy currents (`flm quadratic`, `slm linear`) and, with a TOPUP or GRE field, susceptibility, in one model |
| Sampling | Any q-space scheme | Any | Shells only |
| Signal model | 3dSHORE: radial order 6, ζ = 700, L2 penalty on n and l; all shells together | 3dSHORE, this crate | A Gaussian process per shell, with hyperparameters from 1000 voxels |
| Prediction target | Leave-neighbourhood-out: samples within 2 % of the largest q, and antipodes, are left out | The same | Predictions from all volumes with a noise term |
| b0 volumes | A separate stage: unbiased b0 template, two rigid iterations | The same (#457); MindGrab mask in place of SynthStrip | Inside the model |
| Registration | ANTs, Mattes mutual information, rigid then affine, random sampling | ANTs WebAssembly, `--float 1`, the same arguments (#458) | Gauss-Newton on squared differences, `niter 5` |
| Field map | Applied after motion estimation, in the final resampling, with Jacobian weights | The same | Inside the model during estimation |
| Repeatability | Stochastic (sampling seeds) | Replays a run's seed | Almost deterministic |
| Slice outliers | None | Prototype | Detected and replaced (`repol`) |
| Slice-to-volume motion | None | None | Off by default |
| Interpolations of the data | One | One per app | Two (eddy, then QSIPrep's resampling) |
| Licence | BSD-3-Clause | BSD-3-Clause (ports), Apache-2.0 (new code) | FSL licence: reference outputs only |

## Licence

`brainsuite_shore.py` and `shm.py` have no licence header of their own.
QSIPrep's `LICENSE` (BSD-3-Clause, "Copyright (c) 2015-2018, the BBL developers team") covers them.
`git log --follow` at tag 26.1.1 shows that Matt Cieslak added both files in December 2018 (a7ac064).
`brainsuite_shore.py` adapts DIPY's `ShoreModel` (BSD-3-Clause, [LICENSE-DIPY](LICENSE-DIPY)), and the port also follows DIPY 1.12.1's `gradient_table` and `cart2sphere`.
`real_sym_sh_brainsuite` says that it is adapted from BrainSuite's `sph_harm_basis`.
The port uses QSIPrep's code as QSIPrep distributes it; BrainSuite's own licence is not checked here.
