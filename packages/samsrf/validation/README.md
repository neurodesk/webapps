# SamSrf parity

`parity.mjs` runs `@neurodesk/samsrf` on SamSrf's example subject X001 and
compares every output with the reference that SamSrf's own `.m` files produced
in Octave 9.2. It loads the committed WebAssembly module through `src/node.js`.
[octave/README.md](octave/README.md) describes the Octave harness and each
reference file. The reference is scratch data and is not committed.

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
