# Real MATLAB source references

This recorder runs the web port's pinned SamSrf source in MATLAB R2023b Update 11. It
uses MATLAB's own optimizers, correlation, single arithmetic and geometry.
The existing [compiled container reference](../container/README.md) remains
an independent baseline for the unmodified Neurodesk application.

Recording successfully is not a parity assertion. The required comparisons
and the diagnostic cases that retain differences are listed below.

`prepare.py` requires the clean commit in `source.json` and applies three
explicit repairs: make the documented double-precision setting work, omit
the undefined CF surround row outside hull mode, and give `fminsearch`
double starting parameters in CF Gaussian mode. It records both file hashes
for each repair. No equation, residual shape, CSS exponent, triangulator or
optimizer is replaced. References from this repaired source must be labeled
separately from stock container results.

The manual `samsrf-native` workflow can record these cases with
`record_matlab=true`. Set `include_matrix=false` for a shorter diagnostic run
that omits participant pipelines while retaining numerical primitive cases.
Focused CSS diagnostics run twice in independent MATLAB processes within each
job on `ubuntu-22.04` and `ubuntu-24.04`. The same-host comparison requires
every numerical array and case decision to match exactly. The two jobs
separately provide cross-machine evidence. Runner labels do not guarantee a CPU vendor. Use each receipt's
`cpu` field to establish which Intel or AMD machines actually ran the cases.
Do not pool the receipts or relabel the previous references.

Public GitHub Actions runs are [licensed by MathWorks](https://github.com/matlab-actions/setup-matlab#licensing)
for MATLAB and the required toolboxes. That grant excludes Compiler. A MATLAB Compiler license is needed
only to package a new standalone Runtime application; it is not needed for
this source-level comparison.

The workflow requests `MKL_CBWR=COMPATIBLE`, `MKL_NUM_THREADS=1`,
`OMP_NUM_THREADS=1`, `MKL_DYNAMIC=FALSE` and `OMP_DYNAMIC=FALSE`. The
workflow saves the request environment before MATLAB starts. MATLAB can alter
these variables during startup, so the recorder retains its process environment
separately and sets and checks MATLAB's computational thread limit with
`maxNumCompThreads(1)` and records the reported BLAS branch and CPU.
The effective MKL branch and dynamic-thread setting are still unverified;
`environment.json` lists these explicitly. A successful recording is not a
verified cross-host reproducibility result. This matters even with an identical MATLAB release:
[run 42199010165](https://github.com/neurodesk/webapps/actions/runs/42199010165)
reported CNR `auto`, while
[run 42201373392](https://github.com/neurodesk/webapps/actions/runs/42201373392)
reported `AVX512_E1`; identical saved CSS inputs produced different optimizer
traces and parameter estimates. Existing archives retain their original BLAS
provenance. Reproducing one recorded backend does not imply bit parity with
every MATLAB host.

On a machine with MATLAB and the required toolboxes, export the execution
requests before launching MATLAB:

```sh
export MKL_CBWR=COMPATIBLE MKL_NUM_THREADS=1 OMP_NUM_THREADS=1
export MKL_DYNAMIC=FALSE OMP_DYNAMIC=FALSE
```

Prepare the inputs:

```sh
git clone https://github.com/samsrf/samsrf.git "$TMPDIR/samsrf-source"
git -C "$TMPDIR/samsrf-source" checkout 41ed1e96cc4d9b8b750f5594a61845df21ab8984
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-input"
python3 packages/samsrf/validation/matlab/prepare.py "$TMPDIR/samsrf-source" "$TMPDIR/samsrf-matlab"
python3 packages/samsrf/validation/matlab/capture_environment.py "$TMPDIR/samsrf-matlab"
```

Then call `record_reference(SOURCE, INPUT, OUTPUT, MATRIX_INPUT, SPM)` with
absolute paths from MATLAB after adding this directory to its path. Each array is saved as
little-endian float64 with its original class, dimensions and separate
imaginary part recorded in JSON. This preserves nonfinite values and complex
CSS results without JSON coercing them to null.

`inputs.json` pins additional raw-data subsets from the public X001 dataset
(left and right hemispheres) and the analyzePRF example participant. Download
it with `python3 packages/samsrf/validation/container/download.py MATRIX_INPUT packages/samsrf/validation/matlab/inputs.json`. Its manifest
records the original vertex indices, input hashes, timing and stimulus scale.
The second dataset's four different stimulus sequences are concatenated for
fitting; averaging is tested only as a preprocessing operation. Synthetic
anatomy is clearly marked and used only to satisfy Benson's importer, not as
evidence about cortical geometry. SPM's actual GIfTI readers are pinned in
`source.json`; there are no replacement IO functions.

The expanded recorder captures raw preprocessing, noise ceilings, coarse and
fine maps, threshold selection, reverse correlation, Benson conversion, mesh
distances and smoothed CFs in both precisions. CSS cases retain the original
apertures and separately test a nonnegative control. Saved complex MAT values
are recorded before `samsrf_expand_srf` discards their imaginary components
for export. Polygon cases cover retraced edges, duplicates, self-intersections
and thin triangles across scales. Recording any of these is still not a
passing equivalence gate until its numerical comparison is implemented.

The pinned source's reverse-correlation path cannot finish when `Rdim` differs
from the aperture width: `samsrf_revcor_prf` line 368 reshapes the full coordinate
grid to the requested profile dimensions. The source recording therefore uses
the original 100-pixel resolution. The failed 20-pixel run is evidence of an
upstream execution limit, not a passing web-equivalence case. Each completed
pipeline case also writes its own metadata so a later failure does not hide it.

## Raw-input reverse-correlation matrix

No personal MATLAB license or local MATLAB installation is needed for this
public source-recording workflow:

```sh
gh workflow run samsrf-native.yml --ref BRANCH \
  -f revcor_only=true
```

`revcor_only` selects this matrix instead of the normal reference, even when
`record_matlab=true` is also set. It always includes the participant inputs,
so `include_matrix` has no effect. Do not combine it with `diagnostics_only`
or `wasm_only`, which select different recording/build jobs.

`record_revcor_matrix.m` records 102 cases: six preprocessing cases, six Benson
imports, 72 CF pipelines and 18 RC pipelines. Both precisions use LH averaged
and concatenated runs and the single RH run from the pinned input archive.
CF covers hull, summary and Gaussian estimation, each with smoothing and
global regression on and off. The ROI overlaps part of the seed region to
exercise the source's ordering of global regression and seed selection.
RC covers hull and Gaussian estimation and a custom HRF. The hull and Gaussian
cases use the app presets' SPM canonical HRF (`Hrf=0`) with negative peaks off.
Gaussian fits use the upstream seed expression
`@(V)[V(2:3);V(4)/(2*sqrt(2*log(2)))]` and `R2_Threshold=0.1`.
The custom-HRF case enables negative peaks. RC's summary estimator
(`Prf_Function=-1`) is not covered or supported by the port.

These inputs are participant subsets with synthetic meshes. Global correction
uses the mean of the complete subset; it does not reproduce the original
whole-cortex global signal. Smoothing checks the numerical path on the
synthetic mesh, not anatomical accuracy. Additional RC cases sample every fifth
aperture row and column, giving a 20-by-20 input with `Rdim=20`; the original
100-by-100 hull cases remain in the existing reference. The derived apertures
are recorded explicitly. This is not a repair of the upstream mismatched-Rdim
failure or an assertion that RC supports temporal aperture downsampling.

Each case has a fresh directory and defaults file. Receipts retain saved maps,
expanded maps, profiles, selected vertices, processed courses and MATLAB array
classes. RC records the actual regressor cache before compression alongside
the rounded saved copy. CF also records the global signal and a separately
recomputed global-regression result; the validator requires it to equal the
courses saved by the full analysis at every selected vertex.
CF's saved `ConFlds` retains full vertex width with NaNs outside the ROI:
the source's compression guard leaves it uncompressed in this case. Its
columns therefore differ from the compressed maps and courses. RC profiles
are compressed to the selected vertices. Receipts preserve both behaviors.
The recorded source `model` enables `Save_Rmaps` to retain those profiles.
`mapReplayModel` disables that storage-only option, which the port rejects,
and selects `Data_Precision` explicitly. In the pinned source, `Save_Rmaps`
does not change the computed maps. Replay resolves no
recorded paths: the gates below pass the recorded or raw inputs directly.

The local/CI Octave smoke executes all 17 branches of a single-precision,
three-vertex recording using the documented Octave shims. Vertex 25 adds a
usable Gaussian fit to vertices 2 and 96, which can be rejected or fall below
the fit threshold. The full ROI also includes vertex 25. The NaN-median shim
runs on CI's Octave 8.4 without the newer `omitnan` option.
MATLAB then runs and validates the same smoke before recording the full matrix.
`validate-revcor-recording.mjs` requires every case and array, correct row
labels, finite profiles inside the ROI, partial seed/ROI overlap and at least
one finite nonzero R² per pipeline. It checks saved classes and compression
round trips, then hashes the numerical files. Mutation tests run on the actual
Octave smoke to check that corrupt recordings fail. Compression round trips
check the source's own serialization, not an independent numerical reference.
These checks establish recording integrity,
not port parity; the port gates follow below. There is no compiled Runtime
evidence for this matrix. The new archives are separate from the 741-case pin.

The first actual MATLAB recording, [run 42445033403](https://github.com/neurodesk/webapps/actions/runs/42445033403),
passed the smoke and all 102 cases on both hosts at recorder commit `949548566`.
Each full recording contains 788 numerical arrays. The Ubuntu 22.04 host used
an AMD EPYC 9V74; Ubuntu 24.04 used an Intel Xeon Platinum 8370C. Despite both
requesting `MKL_CBWR=COMPATIBLE`, MATLAB reported CNR branches `auto` and
`AVX512_E1`, respectively. The environment receipts retain that distinction.

Across these two recordings, 499 array hashes and all 90 saved pipeline maps
differ. Their zero and nonfinite masks agree, but the differences are not
limited to rounding: a single-precision smoothed Gaussian CF R² differs by
0.25536. Double-precision Gaussian CF parameters also differ substantially
despite nearly identical R². Both recordings must be retained as evidence;
neither establishes cross-host reproducibility or a tolerance for the port.

`revcor-reference.json` pins both recordings and their comparison report by
dataset commit, SHA-256 and byte count. To download and validate them:

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-revcor-reference" \
  packages/samsrf/validation/matlab/revcor-reference.json
node packages/samsrf/validation/matlab/validate-revcor-recording.mjs \
  "$TMPDIR/samsrf-revcor-reference/ubuntu-22.04"
node packages/samsrf/validation/matlab/validate-revcor-recording.mjs \
  "$TMPDIR/samsrf-revcor-reference/ubuntu-24.04"
```

## Reverse-correlation edge cases

`revcor_edges=true` (with `revcor_only=true`) runs `record_revcor_matrix.m` in
its edge mode: 24 cases on the averaged LH subset in both precisions, edited
after preprocessing. Vertex 3 is constant 0, vertex 5 constant 3 (above the
ones column's norm, so MATLAB's QR keeps the course) and vertex 7 constant
0.25 (below it). Vertex 9 is a low-variance course with an offset (`1e-4 y + 5`).
Vertex 11 equals the strongest regressor, whose aperture pixel is copied at
exactly 1/2 and 1/4 into two other pixels, so its profile sits exactly on
`cM > mM/2` and the hull threshold. Seed vertices 14 and 16, and ROI vertex 12,
share one course, which ties the CF peak. CF covers hull and summary with
smoothing and global regression on and off; RC covers the hull with the SPM
and a custom HRF.

[Run 42926267196](https://github.com/neurodesk/webapps/actions/runs/42926267196)
recorded it at `d5956934f` on an AMD EPYC 9V74 and an AMD EPYC 7763 (both
CNR `auto`). `revcor-edges-reference.json` pins it (HF commit `04932c2e`).

## Reverse-correlation port gates

Two required gates in `samsrf-native` hold the port to both hosts of both
recordings. `exes/samsrf/core/tests/revcor_reference.rs`
(`SAMSRF_REVCOR_REFERENCE_DIR`, `SAMSRF_REVCOR_EDGES_DIR`,
`SAMSRF_MATRIX_INPUT_DIR`) starts each stage from MATLAB's own arrays, so a
disagreement names its stage. `compare-revcor.mjs` runs the matrix's raw GIfTI,
FreeSurfer and aperture inputs through the public Node API (`preprocessRuns`
to `runJob`); the edge cases are edits after preprocessing, so only the Rust
gates read them. Both fail on a missing case and count the cases per gate.

Units are 2^-24, single precision's unit roundoff. A NaN only matches NaN, an
infinity only itself, and a zero limit only an exact value. Profile-derived
limits scale with the course's conditioning `kappa = max|y| / std(y)`
(original and analysed course): centring loses that much relative precision in
MATLAB as in the port. It is 1 to 4 on the participant courses and 5e4 on the
low-variance edge course.

| Stage | Limit | Largest | Evidence for the limit |
| --- | --- | --- | --- |
| Raw runs to single courses, noise ceiling, area, mesh; single global signal | exact | 0 | |
| CF correlations from MATLAB's courses | 16 units | 10.0 | MATLAB vs the exact correlation of its inputs: 9.9; host vs host: 10 |
| RC profiles from MATLAB's courses | 32 units x peak x kappa | 5.45 per kappa (30% identical) | MATLAB's single QR vs exact: 20 |
| Global-regression residuals | 32 units of the input course's peak | 5.41 (54% identical) | host vs host: 5.2 |
| Each host's profiles to its maps (replay) | exact | 0 | |
| RC `R^2` where MATLAB used MKL's AVX-512 path | 16 single ULPs | 9 | the dot product order (below) |
| Positions, `Fwhm`, `Vx`, hull and summary widths, end to end | exact | 0 | |
| CF `R^2`, `Beta`, `Suppression`; RC `Beta` (of itself), end to end | 32 units x kappa | 3.20 per kappa | profile values |
| Production Benson reader instead of MATLAB's template | geometric bound | 0.20 of it | below |
| Single 2D fits (`rc` with `Prf_Function`, `cf` with `Fit_pRF = 1`) | refused | | below |

Double precision is held to `1e-12 x kappa` (relative above 1), and its
regression residuals to `1e-13` of the input's peak.

Three record-keeping rules of the source are reproduced, not tolerated. MATLAB
stores an RC profile only when `corr(Y, X(:,m))` is finite, so a constant
course's recorded profile is zero while its hull, which recomputes the profile,
is not: the gate requires the stored zeros, and the replay recomputes the
profile as `prf_contour` does. A constant course above the ones column's norm
keeps its coefficient (`y'x / y'y`) in both precisions; the port's double path
now applies that rank rule too, where it returned NaN before. When global
regression reduces a constant course to rounding (at most 64 units of the
input's peak), MATLAB correlates that rounding and reports CF parameters from
it; the port's residual is exactly 0 and it reports no estimate. The gates list
those vertices (only the two constant edge courses) and require the empty
estimate there. Reproducing MATLAB's rounding would need its QR bit for bit.

The production reader gate replaces MATLAB's template with
`template::read_benson_gifti` on the raw `*_benson.gii`. Its x0 and y0 differ
from MATLAB's by `delta` up to 2e-6 (`compare.mjs` gates the reader). The gate
requires every discrete decision to stay: the unique seed coordinates, each
cluster, each hull's vertex set and the summary's suprathreshold set. Values
that do not use the coordinates must equal the MATLAB-template run. Summary
medians may move by `delta` and `Sigma` by `2 sqrt(2) delta`. Hull positions and
widths may move by the bound for a convex region whose points move by
`e = sqrt(2) delta`: the area changes by at most `P e + pi e^2`, and the centroid
by `(2 P e + pi e^2)(R + e) / (A - P e - pi e^2)`, with `P` the perimeter, `A`
the area and `R` the farthest vertex. Two single spacings cover output
rounding. Gaussian fits are not covered. `compare-revcor.mjs` runs the same
production template through the Node API and requires the coordinate-free
values and the summary bounds; it runs its hull positions on MATLAB's template.

The port reproduces these single-precision rules, each confirmed by an exact
replay on both hosts: `corr` centres, multiplies and divides by each norm in
single; smoothing rounds each weighted product and the quotient; `Fwhm` sums
single areas; summary statistics take single medians (`median.m`'s
`a + (b - a) / 2`) and MADs; the convex-hull threshold rounds to single; and
the global signal and its regression are single.

The port cannot be bit-identical before the profiles, because MATLAB is not:
the two matrix hosts' profiles differ on about 70% of entries. Single RC profiles
(`[Y ones] \ X`) and the single global regression (`[X ones] \ Y`) use
`lstsq::mldivide`, the QR solve that reproduces MATLAB's on the QR recording,
in MATLAB's column order. It brought the largest RC profile error from 8.42 to
5.45 units per kappa, residuals from 18.81 to 5.41 and end-to-end profile
values from 6.44 to 3.20; the limits did not change. It is not bit-identical
on these hosts' MKL kernels (30% of profile entries and 54% of residuals are),
so the rounding-only courses stay. Double courses with variance keep the
centred solve, within 1e-12 of MATLAB on every recorded case; a constant double
course goes through `mldivide` for its rank rule. `corr`'s dot product follows MKL's CNR `auto` order
exactly (all 189 matrix `R^2` values on that host); the AVX-512 order was not
identified (best candidate, 16 lanes x 4 accumulators with FMA: 145 of 189).

Single 2D fits are refused. CF Gaussian fits run on single template
coordinates, so MATLAB's single `exp` decides them. Its implementation is not
reproduced: replaying the recorded profiles with Rust's `libm` `expf` leaves
1-5 of 21 vertices per case different; glibc's `expf` and a correctly rounded
`exp` leave more. RC Gaussian fits replay exactly from either host's recorded
profiles (single residuals, a four-lane sum and single `R^2`, commit
`06f57adca`), but end to end the fit amplifies profile rounding: the two hosts
differ by up to 0.84 in `Sigma`, and no bound on the parameters has been
established. A recording of MATLAB's single `exp`, and such a bound, come first.

The double unsmoothed CF Gaussian is not gated here: on 2 of 21 vertices fits
run away to |x0| > 1e8, do not replay, and differ between hosts by up to 9e7.
That path is unchanged and gated by the 741-case pin's nine CF cases. Geodesic
distances are computed in double from the single mesh; MATLAB computes them in
single and stores them as double. That difference is inside the correlation
limit but should move to the geometry work.

## Building a matching Runtime container

`build_container.py` is the build recipe for the repaired, version-matched
command-line reference. It verifies the SamSrf commit and exact repair bytes,
rejects additional tracked changes, and checks the SPM commit before invoking
MATLAB Compiler. It records the MATLAB environment and resulting local image
ID. It does not publish the image.

**Status: not built.** The recipe has never been executed with MATLAB Compiler,
and no compiled SamSrf 10.4 with these repairs was found in the SamSrf
releases or the Neurodesk object store checked below. Nothing below is
evidence about a compiled application until a `build` run has passed.

### Compiler access, checked 2026-11-10

| Route | Finding |
| --- | --- |
| Public MATLAB Actions | [Licenses every product except transformation products such as MATLAB Compiler](https://github.com/matlab-actions/setup-matlab#licensing). Source recording works; packaging does not. |
| MathWorks batch licensing token | The only CI route to Compiler. The [pilot page](https://www.mathworks.com/support/batch-tokens.html) states that it is "not currently accepting new requests". |
| Trial license | [Trial-built applications expire](https://www.mathworks.com/matlabcentral/answers/515199-do-apps-compiled-using-simulink-compiler-under-a-trial-license-expire) and [trials cannot download previous releases](https://www.mathworks.com/matlabcentral/answers/2026102-how-do-i-download-and-install-previous-releases-of-matlab-or-the-mathworks-product-installer), so R2023b Update 11 is out of reach. |
| Existing binaries | SamSrf releases through v10.4 carry no assets. Neurodesk's object store holds only 2024 builds (`samsrf_v10.003.zip`, `samsrf_v10.004.zip` and their dated copies), which report SamSrf 10.003 and lack the repairs. |
| This repository | No `MLM_LICENSE_TOKEN` secret and no self-hosted runner. |
| MATLAB Runtime | Free, and not a compiler. The [R2023b Update 11 installer](https://ssd.mathworks.com/supportfiles/downloads/R2023b/Release/11/deployment_files/installer/complete/glnxa64/MATLAB_Runtime_R2023b_Update_11_glnxa64.zip) (4,834,714,979 bytes) is public. `containers.mathworks.com/matlab-runtime` has `r2023b-update-1` to `-9` tags and a moving `r2023b` tag. The Runtime executes a compiled archive; it cannot build one. |

Building therefore needs someone with a MATLAB Compiler license for R2023b
Update 11 to provide a batch token, or to run the recipe on their own licensed
host. Everything else is in place and runs from one dispatch.

### SamSrfAnalysis case matrix

`cli_plan.py` defines 12 `SamSrfAnalysis` cases, each in both precisions (24
runs): forward Gaussian pRF on the left hemisphere with runs averaged and with
runs concatenated, on the right hemisphere, CSS and a custom HRF; reverse
correlation (hull, Gaussian, custom HRF); and CF (hull, summary, Gaussian, and hull
with smoothing and global-signal correction). Each run has its exact argv, its
model file and a fresh directory whose `SamSrf_defaults.json` sets
`def_64bit`.

`prepare_cli_bundle.m` makes every derived input once, in source MATLAB:
lowercase copies of the runs, ROI and seed labels, per-precision Benson
templates, vectorised apertures and a subject-HRF file. `cli_plan.py models`
then writes the model JSON. The bundle is hashed, made read-only and served at
`/input` to both executions. Three upstream behaviours shape it:

- `SamSrfAnalysis` lowercases the data wildcard before listing files.
- `samsrf_fit_prf` writes vectorised apertures beside unvectorised ones, which
  would fail on read-only inputs.
- A custom HRF cannot be a numeric vector in model JSON. `readstruct` reads a
  flat list as a row, which fails with `MATLAB:badsubscript` (run
  [42922209457](https://github.com/neurodesk/webapps/actions/runs/42922209457)),
  and a nested list as a 1-by-30 cell, which `isinf` and `conv` reject (run
  [42923773513](https://github.com/neurodesk/webapps/actions/runs/42923773513)).
  Both hosts failed identically in source MATLAB.

The custom-HRF cases therefore use SamSrf's subject-HRF file route: `Hrf` is
the relative name `hrf_custom`, recognised by its `hrf_` prefix, and staging
copies `fP = [5 15 5 0.9]` into each results directory. At the pinned commit
that route is broken too. `Fitting/samsrf_fit_prf.m` line 270 and
`Fitting/samsrf_revcor_prf.m` line 235 assign
`samsrf_doublegamma(Model.TR, [fP(1:2) 1 1 fP(3) 0 32])' * fP(4)`.
`samsrf_doublegamma` already returns a column (`Hrf = (g1 - g2)'` over a row
of sample times), so the extra transpose makes a 1-by-33 row.
`samsrf_prfoptim_loop` and `samsrf_revcor_prf` treat any HRF with more than one
column as one HRF per vertex. The forward run then fails in `prf_errfun`, and
reverse correlation fails at `samsrf_revcor_prf` line 319 (run
[42925787988](https://github.com/neurodesk/webapps/actions/runs/42925787988),
both hosts, both precisions).

### The CLI repair set

`prepare.py --cli` adds a fourth, CLI-only repair to the three above: it
removes that transpose in both files, so the HRF stays the column
`samsrf_doublegamma` returns. This is the same orientation as the SPM-canonical
route (`Hrf = 0`), which has no transpose. Nothing else in either file changes.

- The output `source.json` records `repairSet: "samsrfanalysis-cli"`, the added
  patch description, and the original and patched SHA-256 of all five files.
- `build_container.py` refuses a checkout without exactly this set, so the
  compiled image and the source runs it is compared with carry the same code.
- Without `--cli`, `prepare.py` still applies the three repairs only. The 741-case,
  CSS-diagnostic and RC/CF references were recorded with those three and are
  not affected or relabelled.

`verify_cli_hrf.m` checks each of the four custom-HRF runs in MATLAB. The saved
`Model.Hrf` must be a column equal to `samsrf_doublegamma(TR, [5 15 1 1 5 0 32]) * 0.9`.
The saved maps must equal, value for value and class for class, a direct
`samsrf_fit_prf` or `samsrf_revcor_prf` call that passes that column as
`Model.Hrf` on the same preprocessing. All 24 runs must succeed; none is
excused.

`run_source_cli.m` runs each argv in source MATLAB. `run_runtime_cli.py` runs
it in the compiled image. Each container has no network (so no license
server can be reached), a read-only root and read-only inputs, runs as the
caller with `--init`, and gets only its own results directory. Tags are refused: the image must
be a registry digest or local image ID. Receipts record the argv, exit status,
duration, image ID and digests, the requested BLAS/thread environment, `lscpu`
and the input hashes before and after. `interrupt` sends SIGINT to the run
that took longest and requires a prompt, nonzero exit. `failure` requires a
missing model to exit nonzero.

`compare_cli.py` is the gate between two executions. Every run must succeed in
both and leave the same files. Every numerical array in the exported GIfTIs
and the saved MAT files (HDF5, read with h5py) must be bitwise identical; this
covers the nonfinite and zero masks. The saved maps must have the run's
precision. Text fields can contain the results path and are reported, not
gated. Function handles are listed as not compared. No tolerance is applied:
two hosts of the same MATLAB release already differ (see
[cross-host differences](#raw-input-reverse-correlation-matrix)), so the
compiled-versus-source gate runs on one host, in one job.

`samsrf-native` dispatch modes:

- `runtime_cli=source`: public MATLAB, no Compiler. Prepares the CLI repair set,
  runs the matrix twice in new MATLAB processes on Ubuntu 22.04 and 24.04,
  runs `verify_cli_hrf.m`, and requires each host to repeat exactly. This is
  source-CLI evidence only.
- `runtime_cli=build`: needs the `MLM_LICENSE_TOKEN` secret and fails at once
  without it. Builds the image, then runs the source matrix and the compiled
  image twice on the same host. Both repeats, compiled versus source, the
  interruption and the failure check must pass before the image is pushed to
  `ghcr.io/neurodesk/samsrf-reference` and its digest recorded.
- `runtime_image=NAME@sha256:...`: a Runtime-only host with no MATLAB.
  It downloads the pinned bundle (`cli-reference.json`), verifies its hashes,
  runs the image twice, and repeats the interruption and failure checks. It
  also reports, without gating, its differences from the pinned source
  recording made on another host.

### Pinned source recording

`cli-reference.json` pins the source recording from run
[42928350417](https://github.com/neurodesk/webapps/actions/runs/42928350417)
(recorder commit `2592b72`, CLI repair set, MATLAB R2023b Update 11):
603,749,930 bytes, SHA-256
`63649a532a1290f6f1318dcc4caf09d2e22fb7ba19e13e749fbdbbb291d995f4`, dataset
commit `2e09c43dedac7f5f37d86e8dbc02fb3097b4de59`.

- **Repeats:** all 24 runs succeeded on both hosts. Each host's two MATLAB
  processes matched bit for bit, with 1,036 array checks per host.
- **Custom HRF:** each custom-HRF run's saved HRF is the 33-sample column, and
  its maps equal the direct call. Forward pRF R² reaches 0.92 and reverse
  correlation R² 0.70, and both differ from the canonical-HRF runs.
- **Archive layout:** the root holds the Ubuntu 22.04 host (AMD EPYC 9V74),
  which the Runtime-only job uses. `ubuntu-24.04/` holds the Intel Xeon
  Platinum 8573C host.
- **Cross-host differences:** all 24 runs differ between the two hosts. The
  largest difference is 7.4e7, in a diverged double-precision Gaussian CF map
  (`cross-host-comparison.json`). This is why the compiled-versus-source gate
  must run on one host.
- **Bundle bytes:** the hosts' bundles differ only in the creation timestamps
  of MATLAB-written MAT files; the arrays are identical. Each recording pins
  its own bundle hashes.

This is source-CLI evidence only. No compiled application has run.

`test_cli.py` tests the plan, staging, the container arguments, the receipts,
input-tree protection and the comparator, including one-ULP and nonfinite-mask
changes. `run_runtime_cli.py` was also exercised with Docker against a
stand-in image that fails if its inputs, root file system or network are
writable or reachable. That checks the harness, not SamSrf.

To build by hand on a Linux x86-64 host with MATLAB R2023b Update 11, MATLAB
Compiler, the Statistics, Image Processing and Parallel Computing toolboxes,
and Docker:

```sh
python3 packages/samsrf/validation/matlab/build_container.py \
  "$TMPDIR/samsrf-source" "$TMPDIR/spm12" "$TMPDIR/samsrf-container-build"
```

Use the prepared SamSrf checkout from above and SPM's commit in `source.json`.
The build uses MathWorks'
[standalone compiler](https://www.mathworks.com/help/compiler/compiler.build.standaloneapplication.html)
and [Runtime image builder](https://www.mathworks.com/help/compiler/compiler.runtime.createdockerimage.html),
then [packages the application](https://www.mathworks.com/help/compiler/compiler.package.docker.html).
It selects the Runtime for the installed MATLAB build instead of reusing the
older Neurodesk image's Runtime. The recipe sets `MKL_CBWR=COMPATIBLE` in both
the build process and generated container. Set `SAMSRF_MATLAB_BATCH=matlab-batch`
when licensing through a batch token. Then follow the `build` steps in
`samsrf-native.yml` to run the matrix and the gates.

## Recorded inputs and focused diagnosis

`reference.json` pins the 741-case archive from runs
[42187489864](https://github.com/neurodesk/webapps/actions/runs/42187489864) and
[42194676865](https://github.com/neurodesk/webapps/actions/runs/42194676865), plus
the controlled diagnostics from
[42204409108, attempt 2](https://github.com/neurodesk/webapps/actions/runs/42204409108/attempts/2).
That diagnostic run records `MKL_CBWR=COMPATIBLE`, an AMD EPYC host and
MATLAB's reported CNR `auto` branch. The original pipeline recordings retain
their own provenance; the new run does not relabel them.
The archive manifest hashes every file and identifies the supplemental cases.
It includes retained discrepancies; case count is not a passing-gate count.

`record_matlab=true, diagnostics_only=true` runs `record_css_diagnostics`
against those pinned inputs in both precisions. It includes MATLAB columns
47 and 88 from #730 and columns 73 and 22 from #731. The current recorder also
includes columns 16, 17, 60, 69 and 82: the missing traces for the remaining
double CSS parameter differences after #736 (zero-based vertices 15, 16, 59,
68 and 81). Columns 16/17 differ by at most 2.7e-15 in fitted parameters;
columns 60/69/82 include exponent differences up to 5.2e-3. There are
18 columns in each precision, 108 optimizer traces and
268 cases in total. The current pin includes these new traces and preserves
all arrays from the earlier 238-case archive. The repeat comparator requires each current trace by ID, so
two matching but incomplete recordings cannot pass. Each original-aperture
case runs with both the saved coarse seed and a seed recomputed on the current
host. A separate nonnegative control recomputes its own coarse seed.
The recorder saves every objective call, raw/compressed/convolved prediction,
correlation reduction, optimizer iteration procedure, termination reason,
coarse fit threshold decision, acceptance decision, final QR factors and complex
coefficients. `sourceSavedFit` retains the complex fit parameters, R² and
coefficients after the precision conversion in `samsrf_compress_srf`.
`sourceExport` records their real parts, as `samsrf_expand_srf` does before
GIfTI export. Both list coefficients in map order, Beta then Baseline; rejected
fits contain zeros.
`candidateBeta` is a diagnostic solve even when that candidate is rejected.
The separate explicit QR solve is compared byte for byte with `mldivide` and
labeled `qrMatchesMldivide`; the factors are not assumed to be its internal QR.
An Octave smoke test runs one pipeline vertex and all 156 numerical primitive
cases before MATLAB dispatch. It
checks executable plumbing with a stubbed environment; its outputs never
become MATLAB fixtures. The previous 238-case diagnostics occupied approximately
200 MB per process before compression. Budget at least 300 MB per process
for the expanded matrix, or 1.2 GB across the two same-host pairs.
The objective remains the actual source `prf_errfun`; diagnostic computations
do not supply its return value. The callback uses the source's nonfinite stop
rule. This isolates CSS optimizer paths without rerunning the participant
matrix. Each completed case has a JSON receipt so a later failure retains it.
Only MATLAB runs supply numerical reference evidence; the Octave run checks
that the recorder executes.

The source gate is now executable:

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-source-reference" packages/samsrf/validation/matlab/reference.json
node packages/samsrf/validation/matlab/compare.mjs "$TMPDIR/samsrf-source-reference" "$TMPDIR/samsrf-matrix-input"
SAMSRF_MATLAB_REFERENCE_DIR="$TMPDIR/samsrf-source-reference" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test matlab_reference
```

The Node comparator verifies every archive file hash, requires each tested case,
and checks individual vertices without map-wide error normalization. Its 114
required gates cover preprocessing, Benson import, single-precision Gaussian
forward pipelines, double-precision reverse-correlation pipelines and the
single-precision CSS pipeline. Fine-fit parameters and scores in the single mode must match exactly; coarse scores and
least-squares coefficients have small absolute/per-value tolerances. No differing
vertex quota is allowed.

Native gates additionally cover all 14 raw optimizer cases, nine double-precision
CF modes from identical recorded profiles, 146 real/complex regression scale
cases and 251 polygon cases. Regression rank decisions must match exactly;
coefficient comparisons use per-value relative tolerances (4 single or 4
double epsilon units), never a map-wide scale. The measured maxima are 3.33 and
3.15 epsilon units; the earlier double solve on rounded inputs reached 6.7 and
7.5, under gates of 16 single epsilon units and 1e-12.
Two polygons
(`polygon_191`, `polygon_193`) lie in the measured fixed-point band of the
geometry recording below; the gate reports them instead of asserting them, by
that rule rather than by name. CF checks from identical profiles isolate parameter
estimation, and do not establish full single-precision CF pipeline parity.

General double-precision fine-fit plateaus, remaining double CSS fits, and single
reverse-correlation/CF arithmetic remain diagnostic cases. The single CSS
parameters and scores match exactly for this recorded pipeline; beta and baseline
retain the documented least-squares rounding tolerance. A successful source
gate does not assert those paths, arbitrary-input parity, or a rebuilt container.

## Least-squares solves

`record_qr_backends.m` records MATLAB's `[ones x] \ y` (and `[x ones] \ y`)
for 348 designs: the 146 regression scale and rank cases above, the 108
recorded CSS trace regressions, constant and nearly constant predictions,
imaginary parts that are subnormal or vanish in single precision, scales whose
squares overflow or underflow, the reverse column order and 48 irregular
designs. Each case keeps the inputs, `mldivide`'s coefficients, `qr(A,0)`'s R
and pivot, and the rank warning with its tolerance. (`qr(A,y,0)` accepts a
right-hand side only for sparse matrices, so Q'y is not available.)

The `qr_only` dispatch ran it in seven fresh MATLAB processes per host, under
`MKL_CBWR=COMPATIBLE` twice, `AUTO`, `SSE4_2`, `AVX2`, `AVX512` and
`MKL_ENABLE_INSTRUCTIONS=SSE4_2`
([run 42920119400](https://github.com/neurodesk/webapps/actions/runs/42920119400),
recorder commit `2e0eb54fd02ba0eddddcf3bb262d6b649347ec8a`). Both runner labels
received AMD EPYC 7763 CPUs. Every process reported `CNR branch auto` with
LAPACK 3.9.0, and every array was identical across all fourteen processes:
MATLAB ignores these MKL requests, so they cannot select another backend.
Intel hosts were not recorded. `qr-reference.json` pins the archive
(`ubuntu-22.04/` and `ubuntu-24.04/`, one directory per request, with
`compare-qr-backends.mjs`'s report). The port is gated against
`ubuntu-24.04/compatible`.

`qr_reference.rs` requires, for all 348 cases, MATLAB's rank and, for the 89
rank warnings, its printed tolerance; a real result where MATLAB's is real; and
zero coefficients for dropped columns. Coefficients have two independent gates.
`exes/samsrf/core/tests/data/qr-outcomes.json` freezes each case's outcome: the
123 bit-identical cases (58 real and 10 complex single, 49 real and 6 complex
double; the previous double solve matched 18) must stay bit-identical, and no
real or imaginary part of any other coefficient may move further from MATLAB's,
in ULPs, than recorded there. Regenerating that file
(`SAMSRF_QR_WRITE_OUTCOMES=1`) is a deliberate change to review. Second,
|port - MATLAB|, real and imaginary parts together, must stay within an
empirical acceptance scale shaped like the first-order least-squares
perturbation estimate, `eps * ||row of R^-1|| * (||A|| ||b|| + kappa ||r||)`,
computed from MATLAB's own R, pivot and coefficients on the inputs converted to
the design's class. It is not a proven error bound, and its constant 1 is not
derived; the largest measured ratio is 0.93 (`random_double_9`).
`qr-accuracy.py` reports each coefficient's ULP distance and its error against
the exact rational solution of the same rounded inputs:

| Family (cases) | Bit-identical before → after | Max real-part ULP before → after |
| --- | --- | --- |
| Regression scale, single (33) | 6 → 24 | 12 → 1 |
| Regression scale, double (33) | 0 → 10 | 8 → 5 |
| Rank boundary, single (40) | 2 → 12 | 12 → 5 |
| Rank boundary, double (40) | 0 → 8 | 14 → 6 |
| CSS traces, single (54) | 2 → 22 | 128 → 130 (excluding vertices 47 and 58's zero baselines) |
| CSS traces, double (54) | 0 → 22 | 293 → 16; vertex 47's baseline had the wrong sign and is now exact |
| Constant and extreme scales, single (12) | 3 → 10 | 7 → 0 |
| Constant and extreme scales, double (12) | 1 → 11 | 6 → 1 |
| Nearly constant, single (5) | 0 → 4 | 351 → 1 |
| Nearly constant, double (5) | 0 → 1 | 4.4e11 → 2 |
| Imaginary underflow (6) and ones last (6), single | 0 → 5 | 6 → 1 |
| Imaginary underflow (6) and ones last (6), double | 0 → 3 | 5 → 1 |
| Irregular, single (24) | 0 → 1 | 266 → 1,011 |
| Irregular, double (24) | 0 → 2 | 1,702 → 1,684 |

"Before" is the previous solve; it had no imaginary parts and no ones-last
order, so those columns compare real parts of ones-first designs only.
Units are the design class's ULPs of the real part, which overstate small
real parts of complex coefficients. The cause of the remaining differences is
not established. The working hypothesis is MKL's internal kernels: other
reductions (`xNRM2`, the back substitution), blocking or code paths that differ
from reference LAPACK would all produce them, and the recording cannot tell
these apart. The Householder steps follow reference LAPACK; only the reflector
inner products follow a measured order.
For real designs the first product is taken alone, the rest accumulate in
eight lanes over whole blocks of eight, the lanes reduce pairwise (i with
i + 4, then i + 2, then i + 1), the remaining terms follow in sequence, and the
leading element is added last. That is consistent with an aligned vector loop
after a one-element peel, but it was chosen among sequential, 2- to 32-lane,
peeled, adjacent-pair, fused multiply-add and split complex accumulations by
the number of bit-identical cases: a fit to this host, not MKL's documented
algorithm. Complex single designs fit best with two lanes and complex double
designs sequentially; few complex cases are bit-identical.
`qr(A,0)`'s R12 matches less often than `mldivide`'s coefficients do, so the
separate factorisation is not evidence of `mldivide`'s internal one.
The zero-based single CSS vertices 47 and 58 have exact zero baselines in
MATLAB, where cancellation of the observation sum gives the port about 4e-9
(within the acceptance scale). Other inputs, CPUs or MATLAB releases may round
differently.

The irregular single designs move further from MATLAB in ULPs (266 to 1,011)
because the previous solve was more accurate than MATLAB, not closer to it: it
solved in double and rounded once, so its largest real-part error against the
exact solution of the same rounded inputs was 0.44 single eps (relative to the
coefficient's magnitude). MATLAB's own error reaches 184 single eps on these
ill-conditioned designs, and the port's, now in single arithmetic, reaches 185.
The two single-precision solves carry rounding errors of the same size in
different bits. `random_single_9`, the 1,011-ULP case, is a complex coefficient
whose real part is 5% of its magnitude; port and MATLAB differ by 28 and 6 eps
of that magnitude from the exact value. This is accepted as the cost of
computing in MATLAB's class; the per-case freeze keeps it from growing.

Nonfinite converted inputs, including finite doubles that overflow single,
give NaN coefficients. MATLAB's handling was not recorded. When `beta - alpha`
overflows inside a reflector (both near the largest value), the reflector is
formed from halved values, which is exact and leaves every recorded solve
unchanged. Complex division is prescaled by powers of two near the overflow
and underflow thresholds, as LAPACK's `xLADIV` does, so a complex reflector
whose `alpha - beta` approaches the largest value keeps its coefficient; this
too leaves every recorded solve unchanged.

In the full pipelines (committed module from
[run 42932877139](https://github.com/neurodesk/webapps/actions/runs/42932877139),
which also contains the CF geometry port; the map and CSS reports equal those of
the QR-only module from run 42930052851),
the single CSS pipeline's largest Beta difference falls from 1.07e-6 to
2.38e-7 and its largest Baseline difference from 3.12e-8 to 1.82e-8. Across the
ten single forward pipelines (748 vertices), bit-identical Beta values rise from
279 to 649 (largest distance 22 to 5 single ULPs) and bit-identical Baseline
values from 223 to 391, with the mean Baseline distance lower in every
pipeline. The largest absolute Baseline difference rises from 4.0e-8 to 5.7e-8:
`pipeline_single_x001_lh_average0_coarse0` vertex 29 (MATLAB -0.0064553185)
moves from 65 to 123 ULPs. Its maximum ULP distance also rises in three
pipelines (79 to 123, 47 to 57 and 102 to 166), all on small baselines whose
value is a cancellation residual of the observation sum. The largest Beta
difference stays 9.54e-7 (`pipeline_single_x001_rh_average1_coarse0`). The double CSS replay keeps every
decision; its maximum Beta and Baseline differences are unchanged (8.3e-9 and
5.6e-16), on 64 and 65 rather than 67 vertices. The map gates' tolerances are
unchanged.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-qr" packages/samsrf/validation/matlab/qr-reference.json
SAMSRF_QR_REFERENCE_DIR="$TMPDIR/samsrf-qr" SAMSRF_QR_REPORT="$TMPDIR/qr-port.json" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test qr_reference -- --nocapture
python3 -I packages/samsrf/validation/matlab/qr-accuracy.py "$TMPDIR/samsrf-qr/ubuntu-24.04/compatible" "$TMPDIR/qr-port.json" "$TMPDIR/qr-accuracy.json"
```

## Geometry: polyshape, delaunay and real templates

No MATLAB license is needed:

```sh
gh workflow run samsrf-native.yml --ref BRANCH \
  -f record_matlab=true -f geometry_only=true
```

`record_geometry.m` records MATLAB's own `polyshape`, `convhull`, `delaunay`,
`samsrf_clusterroi` and `samsrf_cfparam_loop`, 259 cases:

- 7 polygon families, 26,073 polygons: thin triangles one ULP of the apex height
  apart across the cutoff at nine scales, three offsets, three rotations and
  three apex positions; a coarser relative sweep; 4,000 random thin triangles
  in random vertex order; a near-collinear vertex with local spacing 1 on
  polygons spanning up to 1e5; spikes, retraced and collinear edges; degenerate
  inputs; and 2,500 unordered clouds as SamSrf passes clusters (uniform,
  integer grids with duplicates, single-rounded, near-collinear, grid subsets).
- 168 `delaunay` cases: grids from 2x2 to 6x6, scaled, offset, rotated and
  shuffled; integer cocircular rings of radius 5, 25 and 65; regular polygons;
  a hexagonal lattice; centre and corner perturbations from 1e-15 to 1e-7;
  jittered grids; duplicates; collinear inputs; integer clouds; and the
  unique Benson V1 coordinates of both hemispheres.
- 72 `samsrf_clusterroi` cases with tied statistics on grids, a hexagonal
  lattice and a cocircular ring.
- 12 real-template CF cases: `samsrf_cfparam_loop` in hull, summary and
  Gaussian modes, double and single, on the Benson V1 vertices inside the
  author's V123 label of each hemisphere of X001 (LH 2917, RH 3389 seed
  vertices), converted exactly as `samsrf_benson2srf` does with SPM's GIfTI
  reader. Profiles come from synthetic smooth courses; hull cases also record
  the unique rows, triangles, clusters and polygon vertices.

The inputs are the unmodified X001 `lh_benson.gii`, `rh_benson.gii` and
`prf/V123.label` from OSF h92mr, pinned by `geometry-inputs.json`.
[Run 42921602151](https://github.com/neurodesk/webapps/actions/runs/42921602151)
recorded them at commit `44a5e9262` on an AMD EPYC 9V74 (ubuntu-22.04) and an
AMD EPYC 9V45 (ubuntu-24.04). Each host passed an exact repeat in a new MATLAB
process, and the two hosts' 780 arrays are identical. `geometry-reference.json`
pins both recordings. `compare-geometry.mjs` checks the inventory and that
identity; `tests/matlab_geometry.rs` is the port gate:

- **Triangulation.** Every `delaunay` edge set is equal, cocircular ties and
  shuffled inputs included, and the port has no triangles where MATLAB errors
  (collinear points, fewer than three). MATLAB's choices are those of exact
  predicates with CGAL's symbolic perturbation, which the port implements;
  Delaunator, used before, fails the grid cases.
- **Region growing.** All 72 cluster selections are equal, in MATLAB's order.
- **Real templates.** Unique rows, triangulation, every cluster and every map
  value from MATLAB's profiles agree within 1e-12 relative for hull, summary
  and Gaussian CF in double. In single precision the hull geometry rows,
  `Fwhm` and `Vx` agree; R² and the summary and Gaussian parameters are
  MATLAB single arithmetic, left to the single-precision pipeline work.
- **Polygons.** Emptiness is exact, and area and centroid lie within the
  forward-error bound of MATLAB's shoelace on untranslated vertices (its hull
  vertices are compared first, ignoring winding and roundoff-collinear
  redundant vertices; retained coordinates must match exactly). Three measured
  classes remain discrepant. The gate freezes each failing case identity and
  a checksum of its port hull, centroid and area in
  `core/tests/matlab_polygon_exceptions.json`, so neither a new failing member
  nor a changed result can be absorbed by a class exemption. It counts and prints: 1,853 triangles whose altitude over the longest side is
  within [1e-8, 1.00001e-8] of the span, 16 clouds with duplicate points, and
  188 clouds within 1e-5 of the span of a line. MATLAB decides on a
  fixed-point copy of the vertices (its simplified vertices come back on a
  13-digit decimal grid, and exact power-of-two scalings of one triangle get
  different answers), and it resolves crossings of near-parallel edges into
  slivers. SamSrf removes duplicates before `polyshape`; the near-collinear
  class is only reachable by a nearly collinear cluster.

The same test replays the double hull and summary CF pipelines of the raw-input
matrix (both hemispheres, smoothing and global regression on and off, both
hosts) from their recorded profiles; all values agree within 1e-12 relative.

## Extreme CSS scales and regression rank

The previous 238-case recording came from
[run 42427404570](https://github.com/neurodesk/webapps/actions/runs/42427404570),
recorder commit `681e7e3290b036b9a054dfc38ef9376a9b3869e2`. Both runner labels
received AMD EPYC 7763 CPUs. All 4,189 numerical arrays and every case decision
were identical in four processes, including two fresh processes on each host.
`reproducibility.json` retains all four environments and per-file hashes. This
does not establish Intel/AMD reproducibility or change the older reference's
provenance. MATLAB reported CNR `auto`; its effective CNR and dynamic-thread
settings remain unverified.

`diagnostics-reference.json` now pins the expanded 268-case recording from
[run 42717941843](https://github.com/neurodesk/webapps/actions/runs/42717941843),
recorder commit `901c2a6e56c8f00ccd32402f8abf30720b9f8236`. All 5,155 arrays
and every case receipt matched in four processes on AMD EPYC 7763 and 9V45
hosts. All 4,189 arrays and 238 case receipts from the earlier archive are
unchanged. The new archive retains the four environments and file hashes;
it adds no Intel-host or effective-CNR verification.

The new traces isolated a second overflow: at MATLAB column 60, evaluation
787 (zero-based), MATLAB's dot is 1.7973782649551213e308, and at column 69,
evaluation 590, it is -1.7971496736890576e308, where a sequential sum overflows.
#768 rescaled overflowed components; the port now reproduces MKL's dot product
itself (see [Double CSS arithmetic](#double-css-arithmetic)), which gives both
values exactly. The native tests still require every objective's
finite/nonfinite decision across both vertices, both seeds and the
nonnegative controls, and now require the two objectives exactly.

Double CSS squared norms could underflow or overflow even when predictions
were finite. MKL's scaled `dnrm2`/`dznrm2`, now reproduced, keeps that scale and
restores the recorded fit at zero-based vertex 46 (R² 0.4461133943 becomes
0.04894233754) and the rejected all-zero output at vertex 87. At vertex 80, MATLAB's rank warning reports a
tolerance of 24.78495. This is ten times the real QR tolerance; the earlier
`eps(norm(A,1))` inference gives 15.625 and wrongly retains the baseline column,
whose QR diagonal is 15.81078. The corrected rule passes the original 146
scale cases and the newly recorded pipeline regression.
The factor is measured directly for double precision. The same factor is used
for single precision, whose recorded cases agree but do not distinguish the
two rules; the least-squares recording below confirms it in single precision.
Separate native gates require vertex 80's coefficients and the overflowing
design's tiny amplitude to equal MATLAB's bit for bit, even though the latter's
final map is rejected.

The required CSS replay checks all 96 vertices' zero and nonfinite decisions.
At vertices 46, 59, 68, 80 and 87 it also requires exact parameters, noise ceilings and
zero coefficients. Nonzero amplitudes have a 16-double-epsilon relative bound;
R² and near-zero baselines have a 16-double-epsilon absolute bound. A second
run of the same pipeline with MATLAB's recorded HRF kernel (`hrf` in the job
spec, passed as binary doubles) must match every fitted parameter, R², nR² and
noise ceiling at all 96 vertices bit for bit; only Beta and Baseline, which come
from the least-squares solve (#731), are reported rather than gated. Every
remaining per-value difference is written to the report without a widened
tolerance. The existing single CSS and Gaussian gates remain required.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-css-diagnostics" packages/samsrf/validation/matlab/diagnostics-reference.json
SAMSRF_CSS_DIAGNOSTICS_DIR="$TMPDIR/samsrf-css-diagnostics" SAMSRF_MATLAB_REFERENCE_DIR="$TMPDIR/samsrf-source-reference" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test css_diagnostics
node packages/samsrf/validation/matlab/compare-css.mjs "$TMPDIR/samsrf-source-reference" "$TMPDIR/css-comparison.json"
cargo run --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --example css_trace -- "$TMPDIR/samsrf-source-reference" "$TMPDIR/samsrf-css-diagnostics" css_pipeline_double_v47_nonnegative0_recorded "$TMPDIR/css-trace.json"
```

`css_trace` evaluates the native Rust port at every recorded parameter vector,
reports the first differing raw, compressed, convolved and objective value,
then compares the independent optimizer's evaluation sequence. It records
real and imaginary differences and nonfinite mismatches separately, including
the first nonfinite mismatch. It also evaluates the objective on MATLAB's
recorded predictions to distinguish correlation errors from prediction errors. Native
tracing is diagnostic evidence; the required pipeline replay uses the committed
WebAssembly module. The trace does not treat a numerical difference as an
accepted tolerance or claim that separate QR factors reproduce `mldivide`.

## Double CSS arithmetic

The remaining double CSS differences were not optimizer noise. Every stage of
the objective differed from MATLAB by a few ULP, and CSS exponents amplify those
differences on fit plateaus (columns 16, 17 and 82). Each stage was identified from the
recorded traces and then checked on generated inputs
(`record_numerics_probes.m`). `exes/samsrf/core/src/matlab_math.rs` holds two kinds of
code: ported source (fdlibm) and empirical models inferred from MATLAB's recorded
results. A model is established only for the inputs below.

| Stage | Kind | MATLAB R2023b, as recorded | Evidence |
| --- | --- | --- | --- |
| pRF profile `exp`, `.^`, `log`, `sin`, `cos` | Ported source | fdlibm 5.3 from https://netlib.org/fdlibm/: `e_log.c` 1.3, `k_sin.c` 1.3, `k_cos.c` 1.3, `s_sin.c` 1.3, `s_cos.c` 1.3, `e_rem_pio2.c` 1.4 (SCCS 95/01/18), ported. `libm` 0.2.16 `exp`/`pow` matched `e_exp.c` 1.6/`e_pow.c` 1.5 (SCCS 04/04/22) on every value tested | 35,200 probe values on both hosts |
| Raw prediction | Empirical | the existing four-lane `mean` | every recorded raw prediction |
| Negative-base power | Empirical | (-x)^e = (-x)^trunc(e) × exp(f log x)(cos fπ + i sin fπ), integer part by right-to-left binary exponentiation; complex products recover infinities as C99 Annex G (libgcc `__muldc3`) does; i·sqrt(x) for f = 1/2; e < 0 is Smith's reciprocal, a real division when the power is real, and a correctly signed real infinity when it underflowed to zero | all 13,776 probe values with their NaN/Inf masks |
| `conv` | Empirical | the shorter vector slides over the longer one (a kernel at least as long as the course swaps roles). Kernels of fewer than 9 taps: one ascending accumulator, unfused for courses of at most 16 samples and fused otherwise. Fused multiply-adds; nonzero samples scattered in order when fewer than a quarter are nonzero; otherwise blocks of 24 input samples (8 for complex) with taps in `tap % 4` (`% 2`) order. A final partial block is grouped in whole vectors of 8 (4) samples, and its last samples follow in input order | every recorded prediction; the kept (first n) outputs of 288 + 1,308 probe convolutions |
| `gampdf`, `a ≥ 1` | Empirical | Loader's saddle point as MATLAB evaluates it: `exp((-log(2πk)/2 - stirlerr(k)) - bd0(k, x/b)) / b` with `k = a - 1`; `stirlerr` from a table at half-integers up to 15, Cody's `gammaln` elsewhere below 15 and the Stirling series above; `bd0` by its series near the mode, `x log(x/np) + np - x` away from it; `exp(-x/b)/b` for `a = 1` | 9,760 probe densities per host; out of sample, all six TRs' HRF kernels of the first recording and the pipeline's recorded kernel |
| `corr` | Empirical | `x'*y` reproduced by MKL 2021.3 `ddot`/`zdotc` kernels, norms by `dnrm2`/`dznrm2` (reference-BLAS scaled sums), `dot/‖x‖/‖y‖`, then values beyond 1 in magnitude divided by their magnitude | every recorded objective; AMD probe kernels |

`css_diagnostics.rs` requires all 108 traces (54 double, 54 single; both seeds and
nonnegative controls) to reproduce MATLAB's raw prediction, power, convolution
and objective at every evaluation (the objective also from MATLAB's own
predictions), and to follow MATLAB's optimizer parameter sequence bit for bit.
This includes the column 82 plateau (177 evaluations) and columns 16 and 17
(801 and 570 evaluations). The only allowance is the sign of a zero part.

`numerics-reference.json` pins the probes from
[run 42926430579](https://github.com/neurodesk/webapps/actions/runs/42926430579)
(recorder commit `12c26ab14e2518819aee295f4c6ae6d07cfa726e`) on an AMD EPYC 7763
(`ubuntu-24.04`) and an Intel Xeon Platinum 8370C (`ubuntu-22.04`). Each host
ran the probes twice in fresh processes with `MKL_CBWR=COMPATIBLE`, and a third
process with `MKL_CBWR=AUTO`. `matlab_numerics.rs` checks:

- fdlibm functions bit for bit on both hosts;
- every negative-base power, including its NaN and infinite parts. The sign of
  a zero part differs in 2,440 of 27,552 parts; no rule tried (product order,
  FMA, true sign) reproduces MATLAB's zero signs;
- every output SamSrf keeps (the first n) for all 288 convolutions of 1-129-tap
  kernels, dense and sparse, except the 6 sparse complex courses of 1,000 samples;
- the HRF kernels (gamma densities, SPM canonical, de Haas) at six TRs, both hosts;
- MKL dot products and norms on the AMD host;
- the reproducibility results below, real and imaginary arrays.

`numerics2-reference.json` pins a second recording from
[run 43123132508](https://github.com/neurodesk/webapps/actions/runs/43123132508)
(recorder commit `04cd0ef76793c17ca796cb54723ff1f14dc21d8e`) on an AMD EPYC 7763
(`ubuntu-22.04`) and an Intel Xeon Platinum 8573C (`ubuntu-24.04`): `gampdf` on 36
shape and scale pairs (shapes 0.7 to 100.1, scales 0.5 to 2) beside six
candidate formulas MATLAB evaluated itself, and 1,318 convolutions: the first
recording's 294 again, and 1,024 of 9-65-sample courses with 2-33-tap kernels
and of sparse courses of 300-2,000 samples.
`matlab_numerics2.rs` checks on both hosts:

- every density with shape at least 1 (9,760), and `pdf('Gamma', ...)` equal to
  `gampdf`. The 1,220 densities with shape below 1 are declined: there MATLAB's
  formula is not reproduced, and the port keeps the closed form. No HRF uses
  such a shape;
- the kept outputs of every convolution (1,308) except 95 outputs in the 10
  sparse complex courses longer than 800 samples, which differ by one ULP near multiples of 512 samples. That
  path is not established; `matlab_numerics.rs` excludes complex sparse courses of
  1,000 samples or more for the same reason.

None of the six closed-form candidates matches `gampdf` anywhere it matters, and
the identified formula was fitted on these probes. A bit-for-bit match on probes
shows agreement, not MATLAB's internal code. The out-of-sample checks are the
first recording's kernels at TR 0.5-3 (TR 2.5 and 3 were never used in fitting)
and the recorded pipeline kernel, all equal bit for bit.

Real `x'*y` of 8-19 elements takes another MATLAB path and is not gated. The
recorded `conv_complex_n1000_nnz244` case has eight differing outputs, beginning
at sample 498, whose imaginary component is `0.2720763362077453` in the port and
`0.2720763362077454` in MATLAB.

Reproducibility: repeated processes are bit-identical on each host. Across
hosts, only MKL's results differ (83 BLAS arrays: 51 real and 32 imaginary).
Elementary functions, powers, `conv`, `gammaln` and the HRF are identical. On
the Intel host MATLAB reports CNR branch `AVX512_E1`, and its MKL results are
bit-identical under `MKL_CBWR=AUTO` and `COMPATIBLE`, so the environment request
does not select MKL's branch inside MATLAB. The AMD hosts report `auto`; their
results match the modelled kernels. Outside MATLAB, MKL 2021.3 on an AMD EPYC
Milan machine rejected the SSE2 and AVX2 branch requests, and `AUTO` and
`COMPATIBLE` gave the same kernels. Double CSS references must therefore be
recorded on AMD hosts (or with a verified compatible branch); an Intel recording
is a different reference, not a port error. Every CSS trace and pin above is
from AMD hosts.

In the second recording, repeated processes are again bit-identical on each host
(6,112 arrays; the pinned archive keeps the `ubuntu-22.04` repeat, the
`ubuntu-24.04` repeat was compared in the run's artifact). Across hosts only the
83 BLAS arrays differ; all 432 `gampdf` and 4,096 short-convolution arrays are
identical. `MKL_CBWR=AUTO` gave the `COMPATIBLE` results on both hosts. The
Intel host again reports `AVX512_E1` whatever was requested, the AMD host `auto`.

### The double CSS pipeline

With the port's own HRF, which now equals MATLAB's kernel bit for bit, the
recorded 96-vertex double pipeline is gated at every vertex:

- `compare-css.mjs` (committed WebAssembly) requires the port's de Haas kernel to
  equal the recorded one, every fitted parameter, R², nR² and noise ceiling to be
  bit-identical, and every map row to keep MATLAB's NaN, infinity and zero masks.
  It runs the pipeline a second time with MATLAB's recorded kernel as a control,
  which isolates the objective from the HRF: the same gates apply, and the two
  runs must agree in every bit. The former differences at vertices 14, 15, 51
  and 81 came from the kernel and are gone.
- `css_pipeline.rs` runs the same pipeline natively, requires the WebAssembly's
  Beta and Baseline to be its bits, and checks them against the exact
  least-squares solution, computed in rational arithmetic from the design. Where
  MATLAB returned a basic solution (8 coefficients, exactly zero because `\`
  found `[1 x]` rank deficient), the port returns the same zero, and the kept
  coefficient is checked against the one-column solution. Every other
  coefficient must be no further from the exact solution than MATLAB's, plus
  its inherent double-precision uncertainty: the first-order change of that
  coefficient when every input column moves by one unit roundoff of its norm
  (Wedin's least-squares perturbation bound; Higham, *Accuracy and Stability of
  Numerical Algorithms*, 2nd ed., section 20.1). The limit depends on the
  problem alone, not on any observed difference. 77 coefficients are
  bit-identical and 61 differ. The port's error exceeds MATLAB's by at most 0.40
  of that uncertainty, and neither error exceeds 5.2 of it. The test also pins
  these counts.

`css-pipelines-reference.json` pins a fresh recording of this pipeline and of a
nonnegative control, `max(ApFrm, 0)` on the same vectorised apertures
(`record_css_pipelines.m`,
[run 43127425289](https://github.com/neurodesk/webapps/actions/runs/43127425289),
recorder commit `7d2188ed226046a8cb19a770c08e43be0cb19321`). Each host ran it twice
in new MATLAB processes.

| Host | CPU | Requested | Observed | Result |
| --- | --- | --- | --- | --- |
| `ubuntu-24.04` | AMD EPYC 9V74 | `MKL_CBWR=COMPATIBLE`, one MKL and OpenMP thread | CNR branch `auto`, one computational thread; MATLAB's process shows `MKL_NUM_THREADS` empty | repeat identical; the original pipeline equals the old pin (from an EPYC 7763) in every course, noise ceiling, map and HRF bit |
| `ubuntu-22.04` | Intel Xeon Platinum 8573C | the same | CNR branch `AVX512_E1`, one computational thread | repeat identical; 23,017 of 24,000 preprocessed samples, 82 noise ceilings and 336 of 864 map values (by up to 9.1e-5) differ from the AMD host, from MKL's preprocessing onward |

The effective CNR branch and MKL's dynamic threading cannot be verified from
inside MATLAB (`unverifiedControls`). So the reference is the AMD host, and the
Intel recording is kept as evidence of the branch difference. On the AMD host,
`css_pipeline.rs` applies the gates above to both pipelines with the port's HRF:
the original one gives the counts above, and the nonnegative control gives 70
identical and 56 differing coefficients, with 8 basic zeros. Its port errors
reach 2.65 of the inherent uncertainty against MATLAB's 2.12, an excess of at
most 0.81. Every non-coefficient map is exact and every mask matches in both.

What remains:

- **Beta and Baseline** are not bit-identical: the column-pivoted QR solve (#731,
  #773) rounds differently from MKL's. The gate above bounds them against the
  exact solution, not against MATLAB's rounding.
- `gampdf` with shape below 1, the zero signs, sparse complex convolutions longer
  than 800 samples, and real `x'*y` of 8-19 elements.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-numerics" packages/samsrf/validation/matlab/numerics-reference.json
SAMSRF_MATLAB_NUMERICS_DIR="$TMPDIR/samsrf-numerics" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test matlab_numerics
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-numerics2" packages/samsrf/validation/matlab/numerics2-reference.json
SAMSRF_MATLAB_NUMERICS2_DIR="$TMPDIR/samsrf-numerics2" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test matlab_numerics2
node packages/samsrf/validation/matlab/compare-css.mjs "$TMPDIR/samsrf-source-reference" "$TMPDIR/samsrf-css.json"
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-css-pipelines" packages/samsrf/validation/matlab/css-pipelines-reference.json
SAMSRF_MATLAB_REFERENCE_DIR="$TMPDIR/samsrf-source-reference" SAMSRF_CSS_WASM_REPORT="$TMPDIR/samsrf-css.json" SAMSRF_MATLAB_CSS_PIPELINES_DIR="$TMPDIR/samsrf-css-pipelines" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test css_pipeline
```

`record_matlab=true, numerics_only=true` repeats the probe recording and
`record_matlab=true, css_pipelines_only=true` the pipelines. Octave can run
the recorder's plumbing with a stubbed environment; its results are never
references.
