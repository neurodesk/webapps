# SamSrfX MATLAB Runtime reference

These checks use the compiled MATLAB application, without the Octave shims.
The Neurodesk `v10.004_20241127` image contains an application that reports
**SamSrf 10.003 (2024-11-04)**, running on MATLAB Runtime R2023b. The web port
otherwise targets SamSrf 10.4, commit `41ed1e96`.

Image:
`ghcr.io/neurodesk/samsrfx@sha256:b4e584ce1eeb11cbe20a2012c5f8263fc9128184c0574c83c1cfabf59cc3ff16`.
Executable SHA-256:
`b29eb1b8fa42f295055296c27ef6be3021065bade3bdd1f99c372bad636eddc5`.
The bundled source HEAD is `974feab7b90d86dd9851b9d85b94d4573bcade06`;
this identifies the bundled source, not necessarily the binary's build commit.

## What changed

The container's exporter uses `sqrt(x0.^2 + y0.^2) - 0.5` after converting maps
to single precision. SamSrf 10.4 removed the subtraction. The web app now offers
**Advanced settings → Map export → Legacy SamSrfX 10.003** to reproduce that
convention in the displayed maps and downloads. Saved model JSON records
`"Export_Convention": "samsrfx-10.003"`; the CLI honors the same field.
The default remains geometric eccentricity, `sqrt(x0^2 + y0^2)`.
Legacy eccentricity can be negative near the origin; it is a compatibility
convention, not the geometric distance. Fitting remains double precision.

The remaining fine-fit discrepancy is precision sensitivity inside the objective.
Changing only the input type in the **compiled** `prf_errfun` gives:

| Check, 20 vertices | Maximum absolute difference |
| --- | ---: |
| Compiled single-precision probe vs complete GUI fit, all six exported outputs | 0 |
| Compiled double-precision probe vs WASM x0 | 2.47e-32 |
| Compiled double-precision probe vs WASM y0 | 4.44e-15 |
| Compiled double-precision probe vs WASM Sigma | 2.80e-14 |
| Compiled double-precision probe vs WASM R² | 1.45e-15 |
| Compiled double-precision probe vs WASM Beta | 6.53e-16 |
| Compiled double-precision probe vs WASM Baseline | 2.56e-15 |

Thus these cases do not show an equation or optimizer defect. The web core's
float64 fitting is retained. Merely rounding the observations, correlation or
objective to float32 does **not** reproduce MATLAB's full calculation.
A trace of 136 objective evaluations at vertex 597 showed that MATLAB uses
single-precision results for the mixed-precision dot product, sequential
normalization and `1 - R.^2`; those rounding differences change Nelder–Mead's
comparisons and its final point. Emulating a few casts would introduce a new,
unvalidated optimizer path. No claim of bitwise default-single equivalence is made.

After selecting legacy export, observed differences from the default GUI are:

| Analysis | Coordinates/size | Other maps |
| --- | --- | --- |
| Coarse Gaussian pRF | x0/y0/Sigma and eccentricity exact | R² ≤ 3.58e-7; beta ≤ 4.48e-8 |
| Fine Gaussian pRF | x0 ≤ 0.000994°, y0 ≤ 0.001318°, Sigma ≤ 0.001059° | R² ≤ 2.39e-7; eccentricity ≤ 0.001380° |
| Reverse-correlation hull | x0/y0/Fwhm and eccentricity exact | R² ≤ 2.39e-7; beta ≤ 8.95e-8 |
| CF hull | x0/y0/Centre/Surround/Vx and eccentricity exact; Fwhm ≤ 1.91e-6 | R² ≤ 3.58e-7 |

MATLAB's single-precision `atan2` and WASM's implementation can differ by one
ULP; derived polar angles from identical coordinates differ by at most
7.63e-6° in this fixture. Fine-fit polar differences also reflect the different
fitted coordinates (up to 0.01752°). Noise-ceiling exports match exactly.
These are observations on this fixture, not error bounds for arbitrary data.

## Run the gates

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-reference"
node packages/samsrf/validation/container/compare.mjs "$TMPDIR/samsrf-reference" "$TMPDIR/samsrf-comparison.json"
```

The downloader requires a new or empty directory and verifies the immutable
archive's size and SHA-256 from [fixture.json](fixture.json). The comparator
also verifies each extracted input's checksum. The ready-PR `samsrf-native`
workflow runs these gates on the committed WASM:

- Legacy eccentricity derived from identical coordinates: exact at every vertex.
- Legacy polar angles: absolute error ≤ 2^-15 degrees.
- Compiled MATLAB vs WASM with identical double-precision observations:
  absolute error ≤ 1e-9 for **each** x0, y0, Sigma, R², Beta and Baseline value.
- Compiled single-precision probe vs these six original GUI outputs: exact after float32 export.
- Coarse pRF x0/y0/Sigma, RC x0/y0/Fwhm, CF x0/y0/Centre/Surround/Vx,
  their legacy eccentricities, and all noise-ceiling exports: exact.
- Nonfinite masks must agree; every default-precision map difference is reported.

Default-single vs web-double differences are diagnostics, not silently accepted
as exact matches. No vertices are discarded and no map-wide normalization or
percentage-of-outliers exemption is used. A passing exit status covers the
explicit gates above; it does not certify all default-single outputs.

## Re-record the precision control

The fixture contains the exact processed observations, canonical HRF,
vectorized apertures and initial coarse seeds in `probe-all.mat`. It also
contains the original GUI output GIfTIs. The larger `fullGuiReference` archive
linked in [fixture.json](fixture.json) retains the original GUI models, saved
MAT results, logs, methods and input hashes.

With SciPy installed, generate two model files from the container's stock
`Models/Standard_2D_Gaussian_pRF.mod`:

```sh
python3 packages/samsrf/validation/container/record.py REFERENCE_DIRECTORY STOCK_GAUSSIAN.mod
```

Run the immutable container with an X display, mount that directory at `/work`,
set writable `MCR_CACHE_ROOT` and `TMPDIR`, and start
`/opt/samsrfx-v10.004/samsrf/run_SamSrfX.sh /opt/MCR-2023b/R2023b` from the app
directory. Load `/work/probe-single.mod`, then `/work/probe-double.mod` through
**Model Specification → Load Model**. Loading evaluates the anonymous profile
callback and writes `fits-single.json` or `fits-double.json`. The callback calls
the already compiled SamSrf functions; no numerical source is patched.
The subsequent `contourf` complaint is expected because `fprintf` returns a
scalar, not a profile. Verify the output files; each has 20 rows with columns
x0, y0, Sigma, R², Beta and Baseline. Both generated models were run through
the real GUI to record the committed fixture.
Re-record into a copy: changing a reference requires a deliberate new fixture
pin and review, not silently replacing the expected values during a test.

## Scope and remaining limits

The fixture uses original, whole-surface X001 data: six LH runs of 250 volumes,
134260 vertices, detrend/z-score then average, and the 20 high-noise-ceiling
vertices in `matlab-input.json`. pRF TR is 1 s, radius 9.5°, canonical SPM HRF,
and 144 grid points. Fresh names/directories avoid MATLAB's stale caches.
CF uses the original whole-surface global signal, no smoothing, and identical
precomputed template arrays. It does not independently validate Benson conversion.
Earlier app examples zeroed vertices outside V1–V3 and are unsuitable for a CF
comparison with the original whole-surface data. The current pinned app example
preserves the original whole-surface runs.

The container itself fails in CF summary mode (`fIimg` undefined) and Gaussian
CF fitting (`FMINSEARCH accepts inputs only of data type double`). The web app's
working modes are retained; there is no successful default-container reference
for those paths. CSS, fitted HRFs, other model families, lower-signal vertices,
right hemisphere and degenerate triangulations still need further MATLAB cases.
This controlled comparison does not identify the unspecified users' inputs or
establish the cause of their reports.
