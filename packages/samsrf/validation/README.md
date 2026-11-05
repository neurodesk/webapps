# SamSrf parity

`parity.mjs` runs `@neurodesk/samsrf` on SamSrf's example subject X001 and
compares every output with the reference that SamSrf's own `.m` files produced
in Octave 9.2. It loads the committed WebAssembly module through `src/node.js`.
[octave/README.md](octave/README.md) describes the Octave harness and each
reference file. The reference is scratch data and is not committed.

## What this validates

These checks compare against Octave with replacement optimization and geometry
functions and, by default, an identity shim for `samsrf_32bit_srf`. They do not
establish parity with default single-precision MATLAB. Fine-fit checks allow up
to 2% differing vertices and normalize errors by the largest value in the map;
a passing row does not imply that every vertex agrees. CF summary and Gaussian
fit modes lack successful upstream references. The numerical regression tests
also cover scalar HRF arrays, nearly constant full-rank predictions and combined
CSS/HRF fits; the latter intentionally corrects an upstream post-fit indexing bug.
See the package README for all retained differences and comparison setup.

On 2026-11-05, the corrected module passed 106/106 low-level checks and retained
the same 101/111 analysis results below. The original whole-surface example also
passed CLI/in-process byte equality for all three analyses and the browser's
processing and download checks. A separate Octave run with the unmodified
`samsrf_32bit_srf` completed successfully: compared with the double reference,
maximum absolute differences were 1.19e-7 in averaged courses (1,774,750 finite
values), 2.98e-8 in noise ceilings (7,013 finite values), 2.51e-6 in the global
signal and 1.87e-5 after global-signal regression. These measure precision
sensitivity in preprocessing; they are not MATLAB fit-error bounds.

## Run

```sh
node packages/samsrf/validation/parity.mjs [--json results.json] [--markdown table.md]
```

| Variable | Default | Content |
| --- | --- | --- |
| `SAMSRF_REFERENCE_DIR` | `/storage/scratch/samsrf-work/reference` | The output directory of `octave/run.sh` |
| `SAMSRF_EXAMPLE_DIR` | `/storage/scratch/samsrf-work/dl/X001` | The example subject (`func/lh_uBars1-6.gii`, `prf/aps_Bars.mat`) |

The script prints one line per check and exits with status 1 when a check fails.
A check passes when the largest absolute difference, divided by the largest
absolute reference value, is at most the tolerance. The tolerance is 1e-9, and 0
for the GIFTI samples, which are float32 values read without arithmetic. A NaN
must sit where the reference has a NaN, for example the noise ceiling of a vertex
whose odd-run and even-run means are constant. `--markdown` writes the table
below. `--json` writes the same numbers and the errfun timing.

The checks:

- **GIFTI.** `readRunFile` on each run, at 256 sampled (volume, vertex) pairs.
- **Apertures.** `readAperturesFile('prf/aps_Bars.mat')`. `toDense()` is compared
  with `ApFrm`, `scaledXy(1)` with `ApXY` (its largest magnitude is 1) and
  `scaledXy(9.5)` with the scaled `ApXY`.
- **Preprocessing.** One pass over the six runs feeds three `RunAccumulator`s
  that keep the 7099-vertex subset:
  - z-scored and averaged, with the noise ceiling and the global signal
    (`samsrf_gii2srf(runs, '', 1, true, true)`);
  - z-scored and concatenated, with the global signal (`..., 1, false, true`);
  - run 1, detrended only (`samsrf_gii2srf(runs(1), '', -1, true, true)`).

  `removeNoise` then regresses the global signal out of the averaged data
  (`samsrf_removenoise`).
- **HRF.** Every kernel in `hrf.json` at TR 1 and 2.55: `hrf.doublegamma` with
  and without parameters, `hrf.deHaas`, and `hrf.oldSchool` with the example's
  `fP`. `hrf.convolve` convolves the test sequence with each kernel, downsampled
  by 1 and by 2.
- **Profiles.** `prfProfile` for every entry of `prf_profiles.json`, on the
  scaled `ApXY` and on the 200-pixel grid.
- **Expressions.** `evaluateExpression` on every `Prf_Function` and
  `SeedPar_Function` in SamSrf's `Models/` folder, with two inputs each.
- **errfun.** `predictTimecourse` of one profile. Then `errfun` on the averaged
  time courses of the three ROI vertices with the highest noise ceiling: three
  parameter sets with the canonical HRF, one with the compressive nonlinearity,
  and two with the fitted HRF (`{ fit: 1 }`), one of them outside the HRF bounds.

## Results

From a run on 2026-11-02 with the module committed beside this file. All 106
checks pass.

| Check | Max abs | Relative | Tolerance | Result |
| --- | ---: | ---: | ---: | --- |
| GIFTI lh_uBars1.gii: 256 samples (250 x 134260) | 0 | 0 | 0 | PASS |
| GIFTI lh_uBars2.gii: 256 samples (250 x 134260) | 0 | 0 | 0 | PASS |
| GIFTI lh_uBars3.gii: 256 samples (250 x 134260) | 0 | 0 | 0 | PASS |
| GIFTI lh_uBars4.gii: 256 samples (250 x 134260) | 0 | 0 | 0 | PASS |
| GIFTI lh_uBars5.gii: 256 samples (250 x 134260) | 0 | 0 | 0 | PASS |
| GIFTI lh_uBars6.gii: 256 samples (250 x 134260) | 0 | 0 | 0 | PASS |
| apertures ApFrm (pixels x volumes) | 0 | 0 | 1.0e-9 | PASS |
| apertures ApXY | 0 | 0 | 1.0e-9 | PASS |
| apertures ApXY scaled 9.5 | 0 | 0 | 1.0e-9 | PASS |
| preprocess average, 7099 vertices x 250 volumes | 7.1e-14 | 2.5e-14 | 1.0e-9 | PASS |
| preprocess noise ceiling (finite entries, NaN positions) | 4.1e-15 | 4.3e-15 | 1.0e-9 | PASS |
| global signal, average | 1.8e-14 | 8.2e-14 | 1.0e-9 | PASS |
| preprocess concatenate, 1500 volumes | 1.0e-13 | 1.6e-14 | 1.0e-9 | PASS |
| global signal, concatenate | 1.9e-14 | 2.5e-14 | 1.0e-9 | PASS |
| preprocess detrend only, run 1 | 5.0e-12 | 7.8e-15 | 1.0e-9 | PASS |
| removenoise (global signal) | 1.3e-13 | 4.5e-14 | 1.0e-9 | PASS |
| HRF doublegamma_default TR 1 | 1.8e-16 | 1.0e-15 | 1.0e-9 | PASS |
| HRF doublegamma_default TR 1 convolution | 5.6e-16 | 1.2e-15 | 1.0e-9 | PASS |
| HRF doublegamma_default TR 1 convolution, downsampled 2 | 5.6e-16 | 1.4e-15 | 1.0e-9 | PASS |
| HRF samsrf_hrf TR 1 | 7.5e-16 | 3.6e-15 | 1.0e-9 | PASS |
| HRF samsrf_hrf TR 1 convolution | 2.5e-15 | 3.6e-15 | 1.0e-9 | PASS |
| HRF samsrf_hrf TR 1 convolution, downsampled 2 | 2.4e-15 | 4.2e-15 | 1.0e-9 | PASS |
| HRF old_school TR 1 | 3.0e-16 | 2.2e-15 | 1.0e-9 | PASS |
| HRF old_school TR 1 convolution | 9.4e-16 | 2.8e-15 | 1.0e-9 | PASS |
| HRF old_school TR 1 convolution, downsampled 2 | 9.4e-16 | 2.8e-15 | 1.0e-9 | PASS |
| HRF doublegamma_nondefault TR 1 | 1.6e-16 | 8.8e-16 | 1.0e-9 | PASS |
| HRF doublegamma_nondefault TR 1 convolution | 1.1e-15 | 2.1e-15 | 1.0e-9 | PASS |
| HRF doublegamma_nondefault TR 1 convolution, downsampled 2 | 1.1e-15 | 2.3e-15 | 1.0e-9 | PASS |
| HRF doublegamma_default TR 2.55 | 4.5e-17 | 2.6e-16 | 1.0e-9 | PASS |
| HRF doublegamma_default TR 2.55 convolution | 1.2e-16 | 1.7e-16 | 1.0e-9 | PASS |
| HRF doublegamma_default TR 2.55 convolution, downsampled 2 | 1.2e-16 | 1.7e-16 | 1.0e-9 | PASS |
| HRF samsrf_hrf TR 2.55 | 9.4e-16 | 1.7e-15 | 1.0e-9 | PASS |
| HRF samsrf_hrf TR 2.55 convolution | 3.1e-15 | 9.2e-16 | 1.0e-9 | PASS |
| HRF samsrf_hrf TR 2.55 convolution, downsampled 2 | 3.1e-15 | 9.2e-16 | 1.0e-9 | PASS |
| HRF old_school TR 2.55 | 1.5e-16 | 1.3e-15 | 1.0e-9 | PASS |
| HRF old_school TR 2.55 convolution | 4.4e-16 | 7.2e-16 | 1.0e-9 | PASS |
| HRF old_school TR 2.55 convolution, downsampled 2 | 4.4e-16 | 7.2e-16 | 1.0e-9 | PASS |
| HRF doublegamma_nondefault TR 2.55 | 5.6e-17 | 3.1e-16 | 1.0e-9 | PASS |
| HRF doublegamma_nondefault TR 2.55 convolution | 3.3e-16 | 4.6e-16 | 1.0e-9 | PASS |
| HRF doublegamma_nondefault TR 2.55 convolution, downsampled 2 | 3.3e-16 | 4.6e-16 | 1.0e-9 | PASS |
| profile prf_gaussian_rf [2 1 1.5] xy | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_gaussian_rf [2 1 1.5] grid | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_gaussian_rf [-3 -4 0.05] xy | 1.1e-16 | 1.6e-16 | 1.0e-9 | PASS |
| profile prf_gaussian_rf [-3 -4 0.05] grid | 0 | 0 | 1.0e-9 | PASS |
| profile prf_gaussian_rf [0 0 9] xy | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_gaussian_rf [0 0 9] grid | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_dog_rf [1 -2 1 3 0.5] xy | 1.1e-16 | 2.2e-16 | 1.0e-9 | PASS |
| profile prf_dog_rf [1 -2 1 3 0.5] grid | 1.1e-16 | 2.2e-16 | 1.0e-9 | PASS |
| profile prf_dog_rf [-4 3 0.1 0.5 1.2] xy | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_dog_rf [-4 3 0.1 0.5 1.2] grid | 1.4e-20 | 2.9e-16 | 1.0e-9 | PASS |
| profile prf_dog_rf [0 0 2 0.05 -0.3] xy | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_dog_rf [0 0 2 0.05 -0.3] grid | 1.1e-16 | 8.5e-17 | 1.0e-9 | PASS |
| profile prf_multivariate_rf [1 2 1 3 45] xy | 3.3e-16 | 3.3e-16 | 1.0e-9 | PASS |
| profile prf_multivariate_rf [1 2 1 3 45] grid | 2.2e-16 | 2.2e-16 | 1.0e-9 | PASS |
| profile prf_multivariate_rf [-2 -1 0.5 0.1 -30] xy | 3.3e-16 | 3.4e-16 | 1.0e-9 | PASS |
| profile prf_multivariate_rf [-2 -1 0.5 0.1 -30] grid | 6.1e-16 | 6.1e-16 | 1.0e-9 | PASS |
| profile prf_multivariate_rf [3 -3 2 1 400] xy | 2.2e-16 | 2.2e-16 | 1.0e-9 | PASS |
| profile prf_multivariate_rf [3 -3 2 1 400] grid | 8.3e-17 | 2.3e-16 | 1.0e-9 | PASS |
| profile prf_sumnorm_rf [1 1 2 0.5] xy | 2.2e-16 | 2.2e-16 | 1.0e-9 | PASS |
| profile prf_sumnorm_rf [1 1 2 0.5] grid | 2.2e-16 | 2.2e-16 | 1.0e-9 | PASS |
| profile prf_sumnorm_rf [-2 3 0.1 -0.7] xy | 1.1e-16 | 1.3e-16 | 1.0e-9 | PASS |
| profile prf_sumnorm_rf [-2 3 0.1 -0.7] grid | 7.5e-37 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_sumnorm_rf [0 -4 1 1.5] xy | 2.8e-16 | 2.9e-16 | 1.0e-9 | PASS |
| profile prf_sumnorm_rf [0 -4 1 1.5] grid | 5.6e-17 | 2.1e-16 | 1.0e-9 | PASS |
| profile prf_skewgauss_rf [1 1 2 1.5 -2] xy | 2.2e-16 | 1.5e-16 | 1.0e-9 | PASS |
| profile prf_skewgauss_rf [1 1 2 1.5 -2] grid | 2.2e-16 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_skewgauss_rf [-3 2 0.05 -0.5 0.5] xy | 1.1e-19 | 1.4e-18 | 1.0e-9 | PASS |
| profile prf_skewgauss_rf [-3 2 0.05 -0.5 0.5] grid | 5.6e-250 | 1.3e-16 | 1.0e-9 | PASS |
| profile prf_skewgauss_rf [0 0 3 0 3] xy | 1.1e-16 | 1.2e-16 | 1.0e-9 | PASS |
| profile prf_skewgauss_rf [0 0 3 0 3] grid | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_gaussian_rf_2sigma [1 1 1 2] xy | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_gaussian_rf_2sigma [-2 -3 0.05 0.5] xy | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| profile prf_gaussian_rf_2sigma [0 0 3 0.1] xy | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| expr  1 Circular_Tuning_Curve.m (Prf_Function) | 1.7e-16 | 4.6e-16 | 1.0e-9 | PASS |
| expr  2 Circular_Tuning_Curve.m (Prf_Function) | 1.1e-16 | 1.1e-16 | 1.0e-9 | PASS |
| expr  3 Difference_of_Gaussians_Prf.m (Prf_Function) | 1.8e-15 | 1.3e-16 | 1.0e-9 | PASS |
| expr  4 Difference_of_Gaussians_Prf.m (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr  5 Horizontal_Tuning_Curve.m (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr  6 Horizontal_Tuning_Curve.m (Prf_Function) | 1.1e-16 | 1.3e-16 | 1.0e-9 | PASS |
| expr  7 Oriented_2d_Multivariate_Prf.m (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr  8 Oriented_2d_Multivariate_Prf.m (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr  9 Prf_Of_CF_Data.m (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr 10 Prf_Of_CF_Data.m (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr 11 Radial_2d_Multivariate_Prf.m (Prf_Function) | 5.6e-17 | 5.6e-17 | 1.0e-9 | PASS |
| expr 12 Radial_2d_Multivariate_Prf.m (Prf_Function) | 1.1e-16 | 1.4e-16 | 1.0e-9 | PASS |
| expr 13 Reverse_Correlation_Prf.m (SeedPar_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr 14 Reverse_Correlation_Prf.m (SeedPar_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr 15 Summed_Normalisation_Prf.m (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr 16 Summed_Normalisation_Prf.m (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr 17 Vertical_Tuning_Curve.m (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr 18 Vertical_Tuning_Curve.m (Prf_Function) | 1.1e-16 | 1.3e-16 | 1.0e-9 | PASS |
| expr 19 Example_2D_Gaussian_pRF.json (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| expr 20 Example_2D_Gaussian_pRF.json (Prf_Function) | 0 | 0 | 1.0e-9 | PASS |
| predicted time course [2 1 1.5] | 3.6e-15 | 9.2e-17 | 1.0e-9 | PASS |
| errfun vertex 612 [2 1 1.5] canonical HRF | 4.4e-16 | 4.7e-16 | 1.0e-9 | PASS |
| errfun vertex 612 [-3 -4 0.5] canonical HRF | 6.7e-16 | 7.8e-16 | 1.0e-9 | PASS |
| errfun vertex 612 [0.5 0.5 5] canonical HRF | 1.1e-15 | 1.3e-15 | 1.0e-9 | PASS |
| errfun vertex 408 [2 1 1.5] canonical HRF | 5.6e-16 | 6.0e-16 | 1.0e-9 | PASS |
| errfun vertex 408 [-3 -4 0.5] canonical HRF | 1.1e-15 | 1.3e-15 | 1.0e-9 | PASS |
| errfun vertex 408 [0.5 0.5 5] canonical HRF | 1.8e-15 | 2.2e-15 | 1.0e-9 | PASS |
| errfun vertex 407 [2 1 1.5] canonical HRF | 3.3e-16 | 3.5e-16 | 1.0e-9 | PASS |
| errfun vertex 407 [-3 -4 0.5] canonical HRF | 7.8e-16 | 9.3e-16 | 1.0e-9 | PASS |
| errfun vertex 407 [0.5 0.5 5] canonical HRF | 1.6e-15 | 1.8e-15 | 1.0e-9 | PASS |
| errfun vertex 612 [2 1 1.5 0.5] canonical HRF, CSS | 4.4e-16 | 4.8e-16 | 1.0e-9 | PASS |
| errfun vertex 612 [2 1 1.5 6 16 1 1 6] fitted HRF | 4.4e-16 | 4.7e-16 | 1.0e-9 | PASS |
| errfun vertex 612 [2 1 1.5 2 16 1 1 6] fitted HRF | 0 | 0 | 1.0e-9 | PASS |

## The analyses

`parity-analyses.mjs` compares the three analyses with SamSrf's own
`samsrf_fit_prf`, `samsrf_revcor_prf` and `samsrf_revcor_cf` run in Octave
(`octave/analyses.m`, outputs under `analyses/` in the reference directory):

```sh
node packages/samsrf/validation/parity-analyses.mjs [--only prf_nm,cf_hull] [--json out.json] [--markdown table.md]
```

| Variable | Default | Content |
| --- | --- | --- |
| `SAMSRF_REFERENCE_DIR` | `/storage/scratch/samsrf-work/reference` | `analyses/` inside it: one `<run>.json` and `<run>_data.f64` per run |
| `SAMSRF_EXAMPLE_DIR` | `/storage/scratch/samsrf-work/dl/X001` | The full runs (`func/lh_uBars1-6.gii`, `prf/aps_Bars.mat`) the Octave run used |
| `SAMSRF_WEBAPP_EXAMPLE_DIR` | `/storage/scratch/samsrf-work/example` | The web app's example files: the V123 and V1-seed labels, `lh_benson.gii`, `lh.area`, `lh.white` |

The script preprocesses the six full runs once (z-scored, averaged, noise
ceiling, global signal) for the ROI and seed vertices, then rebuilds each
reference run's model from `octave/analyses.m` (`RUNS` in the script), runs the
job on the reference's `mver` in two shards and compares every row of
`Srf.Data` (and `Srf.Raw_Data`) at those vertices, plus a sample of vertices
outside the ROI, which must be 0 as `samsrf_expand_srf` leaves them. Coarse
fits, reverse correlations, convex hulls and summary statistics must agree to
1e-9 of the map's largest value. Fine fits (`fminsearch`, Hooke-Jeeves,
`samsrf_fit2dprf`) count the vertices whose value differs by more than 1e-6
relative: two optimisers that agree to rounding can still part ways after a
1e-15 difference in one error value, so a map passes when at most 2 % of its
vertices differ, and the differing vertices are listed. The template
coordinates pass at 1e-7 (one float32 ulp; see the package README).

`exes/samsrf/core/tests/geometry_reference.rs` checks `samsrf_georoi` on the
first three seed vertices (`analyses/georoi.json`: vertex sets and step
distances identical) and the Delaunay cluster, convex hull area and centroid
on the hand-made point sets of `analyses/convexhull_cases.json` (identical).

### Results

On X001 (the six full runs) against Octave 9.2 running SamSrf 41ed1e96, 101 of
111 checks pass. The ten failures are two documented divergences (package
README, "Divergences from SamSrf"):

- `prf_coarse` Beta and Baseline on 9 of 6587 vertices whose prediction is
  constant to rounding: the port applies MATLAB's QR rank tolerance and reports
  0; Octave's `\` has no tolerance and reports amplitudes near 1e13.
- `prf_css` on 18 of 20 vertices: the resampled apertures ring below zero, so
  SamSrf's `Yp.^Exponent` turns complex in Octave; the port takes those volumes
  as zero. Its fits reach a higher R^2 (0.8916 against 0.8910 at vertex 399).

`cf_summary` and `cf_fit` (`Fit_pRF` -1 and 1) have no reference: SamSrf's
`samsrf_cfparam_loop` reads `fIimg`, which only the convex hull mode creates,
after its loop, so both fail in Octave. The port writes the single `Sigma` row
those modes evidently intend.

| Run and map | Max abs | Relative | Differing vertices | Result |
| --- | ---: | ---: | ---: | --- |
| template R^2 | 0 | 0 | 0 / 134260 | PASS |
| template x0 | 3.8e-6 | 4.4e-8 | 0 / 134260 | PASS |
| template y0 | 3.8e-6 | 4.3e-8 | 0 / 134260 | PASS |
| georoi cases recorded | 0 | 0 | 0 / 0 | PASS |
| prf_coarse nR^2 | 1.8e-10 | 4.9e-13 | 0 / 6587 | PASS |
| prf_coarse x0 | 1.8e-15 | 1.2e-16 | 0 / 6587 | PASS |
| prf_coarse y0 | 1.8e-15 | 1.2e-16 | 0 / 6587 | PASS |
| prf_coarse Sigma | 0 | 0 | 0 / 6587 | PASS |
| prf_coarse Beta | 2.1e+13 | 1.0e+0 | 9 / 6587 | FAIL |
| prf_coarse Baseline | 1.7e-1 | 2.6e-1 | 9 / 6587 | FAIL |
| prf_coarse Noise Ceiling | 3.5e-15 | 3.6e-15 | 0 / 6587 | PASS |
| prf_coarse R^2 | 6.6e-15 | 7.1e-15 | 0 / 6587 | PASS |
| prf_coarse nR^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| prf_coarse R^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| prf_nm nR^2 | 8.0e-15 | 1.7e-15 | 0 / 200 | PASS |
| prf_nm x0 | 0 | 0 | 0 / 200 | PASS |
| prf_nm y0 | 8.9e-16 | 5.8e-17 | 0 / 200 | PASS |
| prf_nm Sigma | 0 | 0 | 0 / 200 | PASS |
| prf_nm Beta | 7.2e+13 | 1.0e+0 | 1 / 200 | PASS |
| prf_nm Baseline | 1.7e-1 | 3.6e-1 | 1 / 200 | PASS |
| prf_nm Noise Ceiling | 1.3e-15 | 1.4e-15 | 0 / 200 | PASS |
| prf_nm R^2 | 4.1e-15 | 4.5e-15 | 0 / 200 | PASS |
| prf_nm nR^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| prf_nm R^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| prf_hj nR^2 | 1.8e-13 | 3.6e-14 | 0 / 200 | PASS |
| prf_hj x0 | 0 | 0 | 0 / 200 | PASS |
| prf_hj y0 | 4.4e-16 | 2.8e-17 | 0 / 200 | PASS |
| prf_hj Sigma | 0 | 0 | 0 / 200 | PASS |
| prf_hj Beta | 5.7e-5 | 3.2e-15 | 0 / 200 | PASS |
| prf_hj Baseline | 2.4e-15 | 4.9e-15 | 0 / 200 | PASS |
| prf_hj Noise Ceiling | 1.3e-15 | 1.4e-15 | 0 / 200 | PASS |
| prf_hj R^2 | 4.7e-15 | 5.1e-15 | 0 / 200 | PASS |
| prf_hj nR^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| prf_hj R^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| prf_hrf nR^2 | 5.7e-15 | 5.8e-15 | 0 / 20 | PASS |
| prf_hrf x0 | 0 | 0 | 0 / 20 | PASS |
| prf_hrf y0 | 0 | 0 | 0 / 20 | PASS |
| prf_hrf Sigma | 0 | 0 | 0 / 20 | PASS |
| prf_hrf RLat | 0 | 0 | 0 / 20 | PASS |
| prf_hrf ULat | 0 | 0 | 0 / 20 | PASS |
| prf_hrf RDisp | 0 | 0 | 0 / 20 | PASS |
| prf_hrf UDisp | 0 | 0 | 0 / 20 | PASS |
| prf_hrf AmpRat | 0 | 0 | 0 / 20 | PASS |
| prf_hrf Beta | 3.9e-16 | 1.9e-15 | 0 / 20 | PASS |
| prf_hrf Baseline | 2.0e-15 | 6.0e-15 | 0 / 20 | PASS |
| prf_hrf Noise Ceiling | 1.3e-15 | 1.4e-15 | 0 / 20 | PASS |
| prf_hrf R^2 | 4.8e-15 | 5.2e-15 | 0 / 20 | PASS |
| prf_hrf nR^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| prf_hrf R^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| prf_css nR^2 | 1.9e-3 | 2.1e-3 | 18 / 20 | FAIL |
| prf_css x0 | 3.4e-2 | 1.7e-2 | 18 / 20 | FAIL |
| prf_css y0 | 5.7e-2 | 1.1e-2 | 18 / 20 | FAIL |
| prf_css Sigma | 1.4e-1 | 2.9e-2 | 18 / 20 | FAIL |
| prf_css Exponent | 9.1e-2 | 2.0e-2 | 18 / 20 | FAIL |
| prf_css Beta | 6.6e-1 | 3.5e-1 | 18 / 20 | FAIL |
| prf_css Baseline | 7.3e-3 | 1.6e-2 | 18 / 20 | FAIL |
| prf_css Noise Ceiling | 1.3e-15 | 1.4e-15 | 0 / 20 | PASS |
| prf_css R^2 | 1.8e-3 | 2.1e-3 | 18 / 20 | FAIL |
| prf_css nR^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| prf_css R^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| rc_hull R^2 | 5.3e-15 | 6.0e-15 | 0 / 6587 | PASS |
| rc_hull x0 | 1.2e-14 | 1.4e-15 | 0 / 6587 | PASS |
| rc_hull y0 | 8.9e-15 | 1.1e-15 | 0 / 6587 | PASS |
| rc_hull Fwhm | 2.7e-15 | 4.1e-16 | 0 / 6587 | PASS |
| rc_hull Beta | 9.3e-16 | 4.7e-15 | 0 / 6587 | PASS |
| rc_hull Noise Ceiling | 3.5e-15 | 3.6e-15 | 0 / 6587 | PASS |
| rc_hull raw R^2 | 5.3e-15 | 6.0e-15 | 0 / 6587 | PASS |
| rc_hull raw x0 | 1.8e-15 | 1.9e-16 | 0 / 6587 | PASS |
| rc_hull raw y0 | 1.8e-15 | 1.9e-16 | 0 / 6587 | PASS |
| rc_hull raw Fwhm | 0 | 0 | 0 / 6587 | PASS |
| rc_hull raw Beta | 9.3e-16 | 4.7e-15 | 0 / 6587 | PASS |
| rc_hull R^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| rc_hull Noise Ceiling outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| rc_fit R^2 | 6.1e-9 | 6.3e-9 | 0 / 200 | PASS |
| rc_fit x0 | 5.7e-8 | 6.1e-9 | 0 / 200 | PASS |
| rc_fit y0 | 1.3e-7 | 9.1e-9 | 0 / 200 | PASS |
| rc_fit Sigma | 0 | 0 | 0 / 200 | PASS |
| rc_fit Beta | 0 | 0 | 0 / 200 | PASS |
| rc_fit Baseline | 0 | 0 | 0 / 200 | PASS |
| rc_fit Noise Ceiling | 1.3e-15 | 1.4e-15 | 0 / 200 | PASS |
| rc_fit raw R^2 | 4.4e-15 | 5.0e-15 | 0 / 200 | PASS |
| rc_fit raw x0 | 1.8e-15 | 1.9e-16 | 0 / 200 | PASS |
| rc_fit raw y0 | 1.8e-15 | 2.1e-16 | 0 / 200 | PASS |
| rc_fit raw Fwhm | 0 | 0 | 0 / 200 | PASS |
| rc_fit raw Beta | 5.2e-16 | 2.9e-15 | 0 / 200 | PASS |
| rc_fit R^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| rc_fit Noise Ceiling outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| cf_hull R^2 | 4.4e-15 | 4.4e-15 | 0 / 6587 | PASS |
| cf_hull x0 | 1.7e-7 | 2.3e-8 | 0 / 6587 | PASS |
| cf_hull y0 | 1.3e-7 | 1.7e-8 | 0 / 6587 | PASS |
| cf_hull Centre | 8.4e-8 | 2.1e-8 | 0 / 6587 | PASS |
| cf_hull Surround | 9.4e-8 | 2.4e-8 | 0 / 6587 | PASS |
| cf_hull Beta | 2.3e-15 | 2.3e-15 | 0 / 6587 | PASS |
| cf_hull Suppression | 1.6e-15 | 2.4e-15 | 0 / 6587 | PASS |
| cf_hull Fwhm | 0 | 0 | 0 / 6587 | PASS |
| cf_hull Vx | 0 | 0 | 0 / 6587 | PASS |
| cf_hull Noise Ceiling | 3.5e-15 | 3.6e-15 | 0 / 6587 | PASS |
| cf_hull R^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| cf_hull Noise Ceiling outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| cf_smooth R^2 | 1.7e-15 | 2.3e-15 | 0 / 200 | PASS |
| cf_smooth x0 | 2.4e-8 | 3.4e-9 | 0 / 200 | PASS |
| cf_smooth y0 | 2.6e-8 | 4.6e-9 | 0 / 200 | PASS |
| cf_smooth Centre | 1.0e-8 | 3.8e-9 | 0 / 200 | PASS |
| cf_smooth Surround | 5.0e-9 | 1.3e-9 | 0 / 200 | PASS |
| cf_smooth Beta | 1.0e-15 | 1.2e-15 | 0 / 200 | PASS |
| cf_smooth Suppression | 6.1e-16 | 1.3e-15 | 0 / 200 | PASS |
| cf_smooth Fwhm | 0 | 0 | 0 / 200 | PASS |
| cf_smooth Vx | 0 | 0 | 0 / 200 | PASS |
| cf_smooth Noise Ceiling | 1.3e-15 | 1.4e-15 | 0 / 200 | PASS |
| cf_smooth R^2 outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |
| cf_smooth Noise Ceiling outside ROI (sampled) | 0 | 0 | 0 / 2000 | PASS |

## errfun timing

One `errfun` call evaluates a gaussian pRF on the 10 000 aperture pixels,
predicts 250 volumes, convolves with the canonical HRF at TR 1 and correlates
with an observed time course. Both timings parse the function source on every
call, as the package's `errfun` does, and report the fastest of 10 blocks of
200 calls on the 16-core AMD EPYC (Rome) development host:

| Build | ms per call |
| --- | ---: |
| Native, `cargo test --release` | 0.335 |
| WebAssembly in Node 24 (`parity.mjs`) | 0.442 |

The WebAssembly module is about 1.3 times slower than native code. Rerun the
native timing with:

```sh
cd exes/samsrf
SAMSRF_EXAMPLE_DIR=/storage/scratch/samsrf-work/dl/X001 \
  cargo test --release --test errfun_timing -- --ignored --nocapture
```

## Analysis timing

`timing.mjs` runs each analysis on the example's whole V123 ROI (6587 vertices)
in Node 24 on the committed module, one thread, with the example models
(`example-inputs.mjs`): the Gaussian pRF grid of 36 x 30 x 24 = 25 920
predictions, the default reverse correlation and the default connective fields.

```sh
SAMSRF_WEBAPP_EXAMPLE_DIR=/storage/scratch/samsrf-work/example node packages/samsrf/validation/timing.mjs
```

On the 16-core AMD EPYC (Rome) development host, 2026-11-02:

| Analysis | Prepare | 6587 vertices | Per vertex |
| --- | ---: | ---: | ---: |
| `prf`, Nelder-Mead fine fit | 17.6 s (search space) | 545.5 s | 82.8 ms |
| `prf`, Hooke-Jeeves fine fit | 18.2 s | 282.6 s | 42.9 ms |
| `prf`, coarse fit only | 12.5 s | 51.7 s | 7.8 ms |
| `rc`, convex hull | 0.1 s | 15.6 s | 2.4 ms |
| `cf`, convex hull | 0.1 s | 3.9 s | 0.6 ms |

Reading and preprocessing the six runs took 5.7 s. The browser splits the
vertices over workers, so a pRF fine fit of the whole ROI takes about a minute
and a half on eight workers plus each worker's search space.

