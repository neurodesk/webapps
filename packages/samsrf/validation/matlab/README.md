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
| RC profiles from MATLAB's courses, AMD host | exact | 0 (every profile entry identical) | |
| RC profiles from MATLAB's courses, AVX-512 host | 32 units x peak x kappa | 4.95 per kappa (29-36% identical) | MATLAB's single QR vs exact: 20 |
| Global-regression residuals | 32 units of the input course's peak | 5.41 (54% identical) | host vs host: 5.2 |
| Each host's profiles to its maps (replay) | exact | 0 | |
| RC `R^2` where MATLAB used MKL's AVX-512 path | 16 single ULPs | 9 | the dot product order (below) |
| Positions, `Fwhm`, `Vx`, hull and summary widths, end to end | exact | 0 | |
| CF `R^2`, `Beta`, `Suppression`; RC `Beta` (of itself), end to end | 32 units x kappa | 3.20 per kappa | profile values |
| Production Benson reader instead of MATLAB's template | exact | 0 | below |
| Internal single CF from the raw files, Gaussian fits included (AMD host) | exact | 0 | below |
| Public single `rc` 2D and CF Gaussian fits | refused | | below |

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

The production reader gate reads every recorded template's raw `*_benson.gii`
with `template::read_benson_gifti` and requires MATLAB's template bit for bit (all
8: six matrix, two edge). `cf_from_raw_files_equals_the_run_on_matlabs_courses`
then runs all 36 single CF cases of the matrix from the raw files alone: the
runs through the production preprocessing, the Benson GIfTI through the reader,
the white surface and areas through the FreeSurfer readers (the ROI and seed are
MATLAB's recorded choices). The courses, noise ceiling and global signal equal
MATLAB's, every map equals the run on MATLAB's courses and template, and on the
AMD host every map value equals MATLAB's, the twelve Gaussian cases included.
The Gaussian cases use internal model construction below the public refusal.
`compare-revcor.mjs` runs supported hull/summary cases through the Node API,
with the CF jobs on the reader's template, and asserts all single fitted-job
refusals (12 CF and 3 RC per host). It does not run Gaussian CLI success gates. The reader's `sin` and `cos` are not bit-identical
to MATLAB's on every angle ([single sin and cos](#single-sin-and-cos)).

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

Single RC 2D fits are refused. The recording below shows why single 2D parity
gates need a specified reference host. `kernels_only=true` (with `record_matlab=true`) runs
`record_single_kernels.m` on both hosts, repeats it in a new MATLAB process
(byte for byte equal). It records:

- single `exp` on 711,307 inputs (every binade from 2^-30 to 2^7 at 4,096
  mantissas, both signs, 400,000 uniform values in [-104, 0] and specials),
  whole and in chunks of 1, 9, 81 and 400 elements;
- the pieces of single `corr` (means, products, norms) for the CF matrix;
- a replica of `samsrf_cfparam_loop` and `samsrf_fit2dprf` that logs every
  `fminsearch` evaluation (parameters, exponents, single model values,
  objective) and asserts that it reproduces SamSrf's saved maps.

[Run 43123623296](https://github.com/neurodesk/webapps/actions/runs/43123623296)
recorded it at `6f63fb349` on an AMD EPYC 7763 (CNR `auto`) and an Intel Xeon
Platinum 8573C (CNR `AVX512_E1`). `single-kernels-reference.json` pins it (HF
commit `b8da2fe7`), and `analyse-single-kernels.mjs --check` holds the
recording to the following findings in `samsrf-native`:

Completeness checks require every named array with its recorded class and shape;
same-host repeats also require identical case metadata. Analysis recomputes every
objective from the logged model and profile, including the unsmoothed 81-element
row/column expansion. It checks the fitted mask, all five optimizer starts, the
selected parameters and R² against their trace, and the single-precision exports
against the replica. Mutation tests reject missing arrays, changed dimensions,
corrupted objectives and fitted maps, and inconsistent fit masks. Rounded-up
cross-host spread ceilings preserve the numerical claims below for this pin;
they are not tolerances for the port or another MATLAB recording.

- MATLAB's single `exp` is the same on both hosts and for every call shape,
  but it is not correctly rounded: 24,445 results are 1 ulp below
  `fround(exp(x))` and 22,702 are 1 ulp above. Rust `libm` `expf` matches
  706,598 of 711,307, glibc's `expf` (with or without FMA) 664,166 and
  correctly rounded `exp` 664,160.
- Sun fdlibm's historical degree-five `e_expf.c` structure matches 711,289.
  The translation identifies the immutable FreeBSD 5.0 source revision and hash
  and retains the Sun permission notice in `analyse-single-kernels.mjs`. That structure is the
  degree-5 rational, k = trunc(x/ln2 ± 1/2), every operation in single and no
  FMA. It needs ln2 split as hi = `0x3f317000` and lo = single(ln2 − hi), and
  0 below ln(2^-149). The error has no table period, only the distance from a
  multiple of ln2, and this split is a sharp optimum: lo one ulp either way
  loses 700 or more matches. `fdlibmExpf` in `analyse-single-kernels.mjs`
  writes it out. The 18 remaining inputs include one with k = 0, so the
  residual is in the rational stage's constants, which are not identified;
  shifting P2 by 24 ulps fits all but 5 and is curve fitting, not used.
- Single times a double scalar runs in double and rounds the result to
  single: the logged models are single(single(e × Beta) + Baseline), not
  operations on the single-rounded scalar.
- With those two rules the candidate reproduces every logged model value but
  2-8 per case (300,000-510,000 values), on 2-7 of 18-21 vertices, first at
  evaluation 686 or later. Correctly rounded `exp` departs on every vertex by
  evaluation 15-62. Given MATLAB's profiles, the other 13-19 vertices' traces
  contain no `exp` difference.
- MATLAB does not agree with itself across the two hosts. Their CF profiles
  differ by at most 3.1e-7 relative (1-2 single ulps), and the fitted maps
  differ on 15-18 of 21 vertices per case: `Sigma` by up to 387 times
  (LH, unsmoothed), `Beta` by 3,210 times, `x0` by 28 times, and `R^2` by up
  to 30% (RH, smoothed). `Fwhm`, `Vx` and the noise ceiling agree exactly.
  RC Gaussian fits replay exactly from either host's recorded profiles
  (commit `06f57adca`), but end to end the hosts differ by up to 0.84 in
  `Sigma`.

A gate needs a declared reference-host policy, as the double paths have.
The AMD CF profiles and internal recorded fits now agree (below), but the
remaining exponential and template-coordinate discrepancies do not have an
end-to-end acceptance bound. Single RC 2D and CF Gaussian fits stay refused;
the internal evidence does not establish general public enablement.

### Single CF profiles and Gaussian fits on the AMD host

`gemv_order=true` (with `record_matlab=true`) runs `record_gemv_order.m`, which
fingerprints the summation order of single `y' * A`, the product `corr(y, X)`
forms. It uses FPRev's pair method: 2^40 and -2^40 at two rows, ones elsewhere.
It covers four shapes, a vector-dot control and 100 random products per shape.
[Run 43129541262](https://github.com/neurodesk/webapps/actions/runs/43129541262)
recorded it at `1b68590c7`. Both runners reported MKL CNR `auto` (AMD), and
each repeated the recording exactly. `gemv-order-reference.json` pins it (HF
commit `b9ead07f`).

- Columns in full blocks of four use four single lanes, the remaining columns
  eight. Both start lane 0 with element 0 and put element i in lane
  (i - 1) mod lanes. Eight lanes fold to four as L[l] + L[l + 4], and four
  reduce as (L0 + L2) + (L1 + L3). The elements left over are then added in
  order. `analyse-gemv-order.mjs` rebuilds the trees.
  `precision::gemv_t_single` reproduces all 3,200 held-out products and all
  378 `corr` products of the single-kernel recording.
- `corr.m` then divides by `y`'s norm and each seed's, and limits the result to
  [-1, 1]. An ROI vertex that is also a seed gives 1, not 1.0000001.

With both, every single CF profile equals MATLAB's on the matrix and edge AMD
hosts. That covers both hemispheres, 250 and 1500 volumes, smoothing on and
off, and global-signal correction on and off.

MATLAB's global regression is `B = [X ones] \ Y` over every ROI course at once
(`samsrf_removenoise`), and the RC profile is `[Y ones] \ X` over every
aperture pixel at once (`samsrf_revcor_prf`, `prf_contour`). The port solves
both the same way with `lstsq::mldivide_many` (#795), whose `?ormqr` order
depends on each column's place among the right-hand sides. On the AMD hosts
the single residuals are bit-identical (5,250 of 5,250 values at 250 volumes,
31,500 of 31,500 at 1500, and the edge case on both edge hosts).

A course with a NaN keeps its place as a column of zeros and comes back
zeroed. Courses without NaNs that contain infinities or overflow when converted
to single also retain a zero placeholder, but return NaN residuals, preserving
the previous isolated-solve behavior. An empty ROI remains a successful no-op
after input-shape validation. MATLAB's result for invalid courses was not
recorded; these are port rules, not parity claims. The other courses are unaffected:
`a_missing_course_keeps_its_place_in_the_single_regression` replaces one ROI
course with NaN in every AMD case and still gets MATLAB's residual for every
other course. Dropping the course instead changes the last course in every
case, by 80 to 705 values.

Single RC profiles rose from 31% to 82-96% identical on the AMD hosts with
`mldivide_many`. What remained differed on whole vertices: 1-5 vertices per
case had 247-339 of their 400 pixels different, every other vertex exact. The
first differing operation was R(2,2) of that vertex's `[Y ones]`
factorization, the norm of the updated ones column: MKL's `snrm2` rescales
its sum as reference BLAS's Fortran reads, `ONE + SSQ*(SCALE/ABSXI)**2`
(the ratio squared first), where the port multiplied `(SSQ*R)*R` (#731,
"MKL's kernels" below). With that order every single RC profile and every
single RC map value equals MATLAB's on the AMD hosts: 8,400 of 8,400 profile
entries in each matrix case and 7,200 of 7,200 in each edge case. The Rust
and JavaScript gates require it there; the AVX-512 host keeps its limits.

`cf_single_replay.rs` runs on the pinned single-kernel and gemv recordings:

- `exp_single` differs from MATLAB on exactly the 18 known inputs.
- `fit_gaussian_single`, started from MATLAB's profiles, gives every parameter
  and `R^2` of all 156 fitted vertices on both hosts.

`revcor_reference.rs` takes each single Gaussian CF case:

- From MATLAB's courses and template, every map value of all twelve AMD
  cases, with and without global-signal correction, equals MATLAB's.
- From the raw files, with the production Benson reader, so does every map
  value of the same twelve cases (`cf_from_raw_files_equals_the_run_on_matlabs_courses`).
- The fits replay exactly from each host's profiles, except two smoothed
  vertices with global-signal correction on the AVX-512 host, most likely
  through the 18 `exp` inputs. That host's own maps differ from the port's on
  47-120 values per case; MATLAB's two hosts differ from each other as above.

Single Gaussian CF fits remain refused in the API, command line and app.
The empirical reader now matches the recorded templates, but 19 vertices of
the whole X001 atlases retain coordinate discrepancies, and 18 recorded single
`exp` inputs still differ. No general end-to-end acceptance bound covers those
inputs or the Intel Gaussian maps. Before this reader change, a one-ULP
coordinate difference on 1 of 9 seed vertices in the LH datasets changed
1-16 fitted vertices, with differences up to elevenfold in `Beta`.
The internal Gaussian gates retain evidence without enabling that public path.

### Single RC 2D fits

`samsrf_fit2dprf`'s `errfun` builds `ModelRfp` in double, but `ObsRfp` (the
profile) is single, so `Ds = ObsRfp - ModelRfp.*Mask` is single and
`R = sum(Ds(:).^2)` is a single sum. Its `R2 = 1 - R/sum(Resid(:))` uses
`Resid = (Rmap - mean(Rmap(:))).^2`, also single. `fminsearch` keeps each
single objective in its double `fv`. The port evaluated the objective and `R^2`
in double. `revcor_prf::Prepared::fit_model` now follows MATLAB's single
arithmetic when `Data_Precision` is single, with `precision::sum_single` (four
lanes from 44 elements) for both sums; double fits are unchanged.

`revcor_reference.rs` builds the three refused single RC 2D cases of the matrix
(LH averaged and concatenated, RH averaged) with a test-only model:

- `single_rc_2d_fits_replay_from_each_hosts_profiles`: from each host's
  recorded profiles, the reverse-correlation rows follow the replay policy,
  and every fitted parameter and `R^2` equals MATLAB's on both hosts. So does
  every acceptance class: 6, 2 and 5 vertices fitted, 7, 8 and 9 below
  `R2_Threshold`, 8, 11 and 7 rejected for a scaled parameter beyond
  `1.5 * Scaling_Factor`. With the double objective, 8, 3 and 5 vertices
  differed on both hosts, 4 of them fitted where MATLAB rejected them.
- `single_rc_2d_end_to_end_equals_the_amd_host`: on the AMD host every map value
  of every vertex equals MATLAB's, from MATLAB's courses and from the raw runs
  through the production preprocessing (raw courses and noise ceilings equal
  MATLAB's stored singles; the apertures are MATLAB's recorded subsample, whose
  derivation `compare-revcor.mjs` gates). On the AVX-512 host 6, 2 and 5
  vertices differ. There the first divergence is the profile: only 3,035,
  2,431 and 2,742 of 8,400 profile entries are identical, while the fit replays
  exactly from that host's profiles.
- `single_rc_profiles_stay_within_single_rounding` now includes these cases:
  8,400 of 8,400 profile entries identical on the AMD host.

Single RC 2D fits remain refused in the API, command line and app. The
evidence covers three recorded cases with `fminsearch`; the Hooke-Jeeves fine
fit uses the same objective but has no recording, and nothing bounds the fits on
other inputs or on MATLAB's AVX-512 host.

The double unsmoothed CF Gaussian is not gated here: on 2 of 21 vertices fits
run away to |x0| > 1e8, do not replay, and differ between hosts by up to 9e7.
That path is unchanged and gated by the 741-case pin's nine CF cases. Geodesic
distances are computed in double from the single mesh; MATLAB computes them in
single and stores them as double. That difference is inside the correlation
limit but should move to the geometry work.

## Single sin and cos

`samsrf_benson2srf` computes `x0` and `y0` with single `sin` and `cos` of the
GIfTI's single polar angles. MATLAB's single `sin` and `cos` are not correctly
rounded and are not glibc's (2.35, 2.39, 2.43), MKL VML's or the older Cygnus
float kernels. On the matrix templates (172 vertices) and the geometry
recording's whole-hemisphere V1 seeds (6,306 vertices, 3,705 unique points, both
hosts), correct rounding misses 8 matrix vertices and leaves 354 entries of
the two hemispheres' unique point sets different. fdlibm's float translation
(`sf_sin.c`, `sf_cos.c`, `kf_sin.c`, `kf_cos.c`, `ef_rem_pio2.c`, single
arithmetic, no FMA) matches all of them once `__kernel_cosf`'s x/4 term keeps
11 of its 23 fraction bits, also used by the empirical single `exp` candidate
for the high part of ln 2. With the full x/4, as Cygnus wrote it, 412 (LH) and 476
(RH) entries of the point sets differ. `precision::sin_single` and `cos_single`
implement this empirical candidate, not an identified MATLAB implementation.
The immutable float sources and their hashes are listed in
[`NOTICE`](../../NOTICE); the truncated x/4 term is an empirical modification.

The `single-trig` section of `record_numerics_probes.m` (`numerics_only=true`
with `record_matlab=true`) evaluates MATLAB's `sin` and `cos` on every single x
with |x| <= 2^7 pi/2 (bits `0x43490F80`, the end of fdlibm's medium reduction),
both signs, in chunks of 2^20. It records a SHA-256 of the output bits per 2^24
inputs and every input where MATLAB's output differs from the model, which the
recorder writes in MATLAB's own single arithmetic (checked against the Rust port
on 4,009,730 inputs in Octave before the run). Above that range it records
200,000 random inputs and the specials whole.
[Run 43196169557](https://github.com/neurodesk/webapps/actions/runs/43196169557)
recorded it at `35201acf1` on an AMD EPYC 9V45 and an AMD EPYC 9V74, each twice
in new processes; all four recordings are identical. `single-trig-reference.json`
pins the `single-trig` files (HF commit `3e17f69e`).

| Inputs (2,257,723,138) | `sin` differs | `cos` differs |
| --- | --- | --- |
| The model | 36,350 | 32,406 |
| `single(sin(double(x)))`, correctly rounded but for double rounding | 5,348,648 | 5,686,424 |

`single_trig.rs` rebuilds MATLAB's output in every block from the port, with
MATLAB's value at the recorded inputs, and requires MATLAB's digest, so the port
equals MATLAB on every other input; the number of inputs where the port differs
may only fall. Truncating the x/4 term to 20 bits (fdlibm's double kernel) or
not at all fails it.

What remains is in the sine kernel, used by `sin` below pi/4 and by `cos` from
pi/4 to 3 pi/4: every differing input there needs a value of the polynomial
`r` one or two ulps lower than both single Horner and the exact polynomial
give. Its evaluation order, FMA, double evaluation of any step, double
coefficients and fdlibm's later grouping all leave it or make it worse, and
shifting a coefficient is curve fitting, which is not used. The `exp`
residual (`cf_single_replay.rs`) sits in the same stage. Intel's compiler
runtime (`libimf`, `libsvml`) was not tested. Below |x| = 0.078 there is no
difference. Within the Benson range (|x| <= single(pi/2)) 12,598 `sin` and
9,384 `cos` inputs differ; on the whole X001 Benson hemispheres that moves `x0`
or `y0` by one single ulp on 10 (LH) and 9 (RH) of 134,260 and 138,314 vertices,
some in V1. A CF analysis whose seed region holds such a vertex can fit
differently from MATLAB. Above 2^7 pi/2 the port rounds the double result and
matches 193,602 (`sin`) and 193,686 (`cos`) of the 200,000 sampled inputs.

## Building a matching Runtime container

`build_container.py` is the build recipe for the repaired, version-matched
command-line reference. It verifies the SamSrf commit and exact repair bytes,
rejects additional tracked changes, and checks the SPM commit before invoking
MATLAB Compiler. It records the MATLAB environment and resulting local image
ID. It does not publish the image.

**Status: not built (#733).** The recipe has never been executed with MATLAB
Compiler, and no compiled SamSrf 10.4 with these repairs was found in the
SamSrf releases or the Neurodesk object store checked below. Nothing below is
evidence about a compiled application until a `build` run has passed.

| Step | State |
| --- | --- |
| Builder | Written, run only up to the license check: `licensed-host/build_and_validate.sh` and the `runtime_cli=build` dispatch. On 2026-11-12 the host driver cloned, downloaded and repaired the sources and started MATLAB, which stopped at its license check (below). No Compiler step has run. |
| Prerequisite | A MATLAB Compiler license for R2023b Update 11: a batch token (`MLM_LICENSE_TOKEN`) for the dispatch, or a host license or `PORT@HOST` server for `licensed-host/`. None is available to this repository; the search for one is finished (table below). |
| Compiled versus source | Pending. The compiled image and source MATLAB must run on the same host and match bit for bit (`compare_cli.py`); no compiled run exists. |
| Publication | Pending. Only a build that passes every gate pushes `ghcr.io/neurodesk/samsrf-reference`; after that, `runtime_image=NAME@sha256:...` validates it on Runtime-only hosts, which need no license. |

The source-CLI recording below ([pinned source recording](#pinned-source-recording))
is the only CLI evidence so far. The Runtime references in
[`validation/container`](../container/README.md) come from Neurodesk's 2024
SamSrfX image, which reports SamSrf 10.003 and lacks the repairs.

### Compiler access, checked 2026-11-10 and 2026-11-12

| Route | Finding |
| --- | --- |
| Public MATLAB Actions | [Licenses every product except transformation products such as MATLAB Compiler](https://github.com/matlab-actions/setup-matlab#licensing). Source recording works; packaging does not. |
| MathWorks batch licensing token | The only CI route to Compiler. The [pilot page](https://www.mathworks.com/support/batch-tokens.html) states that it is "not currently accepting new requests". |
| Trial license | [Trial-built applications expire](https://www.mathworks.com/matlabcentral/answers/515199-do-apps-compiled-using-simulink-compiler-under-a-trial-license-expire) and [trials cannot download previous releases](https://www.mathworks.com/matlabcentral/answers/2026102-how-do-i-download-and-install-previous-releases-of-matlab-or-the-mathworks-product-installer), so R2023b Update 11 is out of reach. |
| Existing binaries | SamSrf releases through v10.4 carry no assets. Neurodesk's object store holds only 2024 builds (`samsrf_v10.003.zip`, `samsrf_v10.004.zip` and their dated copies), which report SamSrf 10.003 and lack the repairs. |
| This repository | No `MLM_LICENSE_TOKEN` secret and no self-hosted runner. |
| Neurodesk organisation | No organisation secret holds a MATLAB token (only `AUTOCOMMIT_FOR_NEUROCOMMAND`, `NEURODESK_GITHUB_TOKEN_ISSUE_AUTOMATION` and `RCLONE_CONFIG` are visible). `neurocontainers`' `build-matlab-standalone.yml` expects a `MATLAB_BATCH_LICENSE_TOKEN` secret that does not exist; its only run failed and it has never compiled anything. |
| Upstream distribution | SamSrf's changelog says `SamSrfAnalysis` was made "for use in NeuroDesk", and Neurodesk distributes the builds. A full listing of the Neurodesk `build` container (46 objects) on 2026-11-12 found only the 2024 SamSrf zips and a 2024 `SamSrfX.zip`. No public build of 10.4 was found. |
| Institutional license | Many Campus-Wide Licenses include MATLAB Compiler for staff at no personal cost. Whether one covers this user, and on which machines, is for the user and their institution to confirm. Activation needs the user's MathWorks account, so only the user can take this route. |
| MATLAB Runtime | Free, and not a compiler. The [R2023b Update 11 installer](https://ssd.mathworks.com/supportfiles/downloads/R2023b/Release/11/deployment_files/installer/complete/glnxa64/MATLAB_Runtime_R2023b_Update_11_glnxa64.zip) (4,834,714,979 bytes) is public. `containers.mathworks.com/matlab-runtime` has `r2023b-update-1` to `-9` tags and a moving `r2023b` tag. The Runtime executes a compiled archive; it cannot build one. |

Building therefore needs a MATLAB Compiler license for R2023b Update 11, as a
batch token for the `build` dispatch, or as a license for one Linux host. That
host can be this kind of machine, using `licensed-host/`.

### Building on one licensed host

`licensed-host/build_and_validate.sh` runs every gate of the `build` dispatch on
one host:

1. Clone the pinned SamSrf and SPM.
2. Download the pinned inputs and apply `prepare.py --cli`.
3. Build with MATLAB Compiler, then prepare the bundle.
4. Run source MATLAB twice, plus `verify_cli_hrf.m`.
5. Run the compiled image twice, the strict compiled-versus-source and repeat
   comparisons, the SIGINT check and the missing-model check.

It publishes nothing. MATLAB runs in `licensed-host/Dockerfile`: MathWorks'
`matlab-deps:r2023b` (Ubuntu 22.04) by digest, plus the Docker CLI that
Compiler's image builders call. `licensed-host/matlab_batch.sh` mounts the
mpm installation, the license and the work directory at their own paths. It
uses `--network host`, so a host-locked license sees this host. It accepts a
license file or a `PORT@HOST` license server.

```sh
mpm install --release=R2023bU11 --destination="$TMPDIR/matlab-r2023bu11" \
  --products MATLAB MATLAB_Compiler Statistics_and_Machine_Learning_Toolbox \
  Image_Processing_Toolbox Parallel_Computing_Toolbox
packages/samsrf/validation/matlab/licensed-host/build_and_validate.sh \
  "$TMPDIR/samsrf-compiled" LICENSE_FILE_OR_PORT@HOST "$TMPDIR/matlab-r2023bu11"
```

Run `mpm` inside the same `matlab-deps` image; R2023b does not support newer
host distributions. The driver refuses an installation whose `VersionInfo.xml`
is not 23.2.0.3097123.

Checked on 2026-11-12 without a license:

- `mpm` installed exactly 23.2.0.3097123, R2023b Update 11 (9.8 GB, with
  `toolbox/compiler`).
- The driver ran through the clones, the input download, the CLI repair set
  (verified by `build_container.py`, five files) and the Python 3.10 venv.
- MATLAB then started in the builder container and stopped at its license check
  (`Feature: MATLAB`, error -2,413). A `PORT@HOST` value reached the same check.

No compiled step has run.

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
cases and all 253 polygon cases. Regression rank decisions must match exactly;
coefficient comparisons use per-value relative tolerances (4 single or 4
double epsilon units), never a map-wide scale. The measured maxima are 3.33 and
3.15 epsilon units; the earlier double solve on rounded inputs reached 6.7 and
7.5, under gates of 16 single epsilon units and 1e-12.
Polygons `polygon_191` and `polygon_193`, once excluded, now pass with the
others (see the fixed-point model below). CF checks from identical profiles isolate parameter
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

### MKL's kernels

`record_qr_kernels.m` (with the MEX file `qr_kernels.c`, built against the
BLAS and LAPACK MATLAB links) answers which operations differ. It runs MKL's
`?geqp3`, `?ormqr`/`?unmqr` and `?trsv`/`?trsm` on every design above, beside
`mldivide` and `qr(A,0)`, and probes `?gemv` and `?ormqr` with FPRev inputs:
+M and -M at two positions among ones, so the result counts the ones a
partial sum kept and the pairs together give the summation tree. The
`qr_kernels` dispatch ran it on three runners per label
([run 43127453138](https://github.com/neurodesk/webapps/actions/runs/43127453138),
recorder commit `b7c7782aa9a8837167cd012df869ca3f5ca0c3dd`): AMD EPYC 7763 three
times, 9V45 and 9V74 (CNR branch `auto`), and Intel Xeon 8370C (CNR branch
`AVX512_E1`). `qr-kernels-reference.json` pins all six recordings and
`hosts.json`. An earlier run on Intel Xeon 8573C (run 43123927704) gave the same
conclusions and is not pinned.

- `mldivide` is that chain: `?geqp3`, then `?ormqr` applying Q' to the
  right-hand sides, MATLAB's rank rule, then `?trsv` (one right-hand side) or
  `?trsm` (several). In the class MATLAB uses (complex whenever an imaginary
  part survives conversion, including subnormal single values), the chain
  reproduced `mldivide` bit for bit for all 348 designs on every host.
- Every AMD host recorded identical bits. The Intel host differs in 12,841 of
  16,326 arrays: MKL's AVX-512 branch sums in other trees. The port follows the
  AMD branch.
- On AMD, `?gemv` inside `?geqp3` starts accumulator 0 with c(1) and sums
  v(i)c(i) in eight accumulators over whole blocks of eight, then sequentially;
  single reduces the accumulators pairwise with strides 4, 2, 1 and double with
  2, 4, 1. `?ormqr` instead takes v(2)c(2) as the first term of accumulator 0
  and adds c(1) last. For several right-hand sides it works in groups of four
  columns with four (single) or two (double) accumulators; the one to three
  columns left over use narrower kernels. Complex single sums in two
  accumulators and complex double in sequence. No order depends on memory
  alignment (offsets 0-7 recorded).
- `cunmqr` and `zunmqr` do not round each complex product. They sum
  v.re (c.re, c.im) and v.im (c.im, c.re) in two separate sets of
  accumulators, each over the tree above, and combine them at the end as
  (A.re + B.re, A.im - B.im) before adding c(1). The FPRev probes cannot see
  this, because their v is real and the second set sums exact zeros. Nor can
  most designs: when the ones column is pivoted first, every entry of v1 is
  equal, so the intermediate imaginary parts are one constant and any tree
  gives the same sum. The 26 single and 21 double designs whose x column is
  pivoted first decide it: with this model `Q^H y` equals MKL's chain in all
  64 complex single and 79 complex double designs (52 and 58 before).
- `snrm2` and `scnrm2` rescale the scaled sum of squares as
  `1 + ssq (r r)`; `dnrm2` and `dznrm2` as `(1 + (ssq r) r)` (the order
  `matlab_numerics.rs` also holds for `corr`). With these orders R(1,1)
  equals MKL's in every recorded design, and R(2,2) in every design whose
  R(1,2) does (below).
- `?trsv` divides by the diagonal; `?trsm` multiplies by its reciprocal (every
  recorded real multi-column solve). `ztrsv` divides by (a c + b d) / (c² + d²).
  `ctrsv` evaluates the same formula in double and rounds to single: its
  coefficients, signed zeros included, equal that in all 64 complex single
  chains, while dividing each part gave -0 for 0 / a negative diagonal in 13.
  `?larfg` uses LAPACK's `?ladiv` (Baudin and Smith).
- `qr(A,0)` and `mldivide` share the factorisation, but `mldivide` matched the
  MEX chain where `qr(A,0)`'s R12 alone did not settle the order: R is no
  evidence of Q'y.

`lstsq.rs` implements these kernels. `qr_kernels.rs` holds them to MKL: every
one of the 8,640 probes (23.6 million sums) on the first AMD recording must
equal the port's sum, and the other four AMD recordings must be identical to
it. It also requires `lstsq::mldivide_many` to reproduce MATLAB's 8-column
`A \ B` bit for bit in all 214 single and 190 double recorded real solves;
complex multi-column solves are not modelled. Finally,
`every_recorded_chain_step_matches_mkl_on_amd` compares every step of each
recorded chain with the port's, bit for bit: pivot, packed factor, reflector
scalars, Q^H y and coefficients. All 345 chains in the class the port uses
match. The three single designs with subnormal imaginary parts have no chain in
that class and are counted, not compared.

`qr_reference.rs` requires, for all 348 cases, MATLAB's rank and, for the 89
rank warnings, its printed tolerance; a real result where MATLAB's is real; and
zero coefficients for dropped columns. Coefficients have two independent gates.
`exes/samsrf/core/tests/data/qr-outcomes.json` freezes each case's outcome: the
346 bit-identical cases must stay bit-identical, and no real or imaginary part
of any other coefficient may move further from MATLAB's, in ULPs, than
recorded there. Regenerating that file (`SAMSRF_QR_WRITE_OUTCOMES=1`) is a
deliberate change to review. Second, |port - MATLAB|, real and imaginary parts
together, must stay within an empirical acceptance scale shaped like the
first-order least-squares perturbation estimate,
`eps * ||row of R^-1|| * (||A|| ||b|| + kappa ||r||)`, computed from MATLAB's own
R, pivot and coefficients on the inputs converted to the design's class. It is
not a proven error bound, and its constant 1 is not derived; the largest
measured ratio is 0.93 (`random_single_9`).

| Family (cases) | Bit-identical, measured order (#773) → MKL kernels | Max ULP of any part (#773 → now) |
| --- | --- | --- |
| Regression scale, single (33) | 18 → 25 | 34 → 16 |
| Regression scale, double (33) | 10 → 28 | 132 → 17 |
| Rank boundary, single (40) | 10 → 32 | 107 → 18 |
| Rank boundary, double (40) | 8 → 34 | 132 → 15 |
| CSS traces, single (54) | 22 → 49 | 130 → 7 (excluding vertices 47 and 58's zero baselines) |
| CSS traces, double (54) | 22 → 52 | 48 → 29 |
| Constant and extreme scales, single (12) | 8 → 10 | 18 → 0 |
| Constant and extreme scales, double (12) | 9 → 12 | 1 → 0 |
| Nearly constant, single (5) | 4 → 5 | 1 → 0 |
| Nearly constant, double (5) | 1 → 5 | 2 → 0 |
| Imaginary underflow and ones last, single (6) | 5 → 6 | 1 → 0 |
| Imaginary underflow and ones last, double (6) | 3 → 6 | 87 → 0 |
| Irregular, single (24) | 1 → 16 | 1,011 → 1,009 |
| Irregular, double (24) | 2 → 20 | 1,684 → 673 |

After #731 (MKL's `snrm2` order, the two-accumulator `?unmqr` and `ctrsv` in
double) 346 of 348 are bit-identical, and the other two
(`trace_single_v58_nonnegative0_recorded` and `_recomputed`) equal MKL's own
chain bit for bit: their coefficients are 0 + -0i, which MATLAB stores as a
real array, so the recording cannot hold the sign. Every coefficient part is 0
ULPs from MATLAB, and every chain's coefficients equal MKL's bit for bit on the
five AMD recordings. No frozen part moved away from MATLAB.

The last intermediate that differed was R(1,2) in 8 CSS-trace designs (v60 in
both classes, v82 double), up to 8 ULPs. tau(1) = 1 there, but that was not the
cause: 42 real designs have tau(1) = 1 and the port already matched 34 of them.
All 8 have a first reflector whose v ends in 8-11 exact zeros, the clipped
nonnegative responses. Reference `xLARF` scans v for its last nonzero entry
(`ILADLR`) and applies the reflector only that far, which moves the end of the
`?gemv` blocks of eight. `?geqp3` trims so: with it, R(1,2) equals MKL's in all
95 double and 93 single real designs (90 and 90 before), including the passing
designs with trailing zeros. `?ormqr` does not trim. Trimming its right-hand
sides too changed Q^H y in 3 recorded single designs, so the port trims only
the column update. That also fixes the 6 double multi-RHS solves of the v82
designs, so all 190 match. The census is rerunnable:
`cargo run -p samsrf-core --example qr_steps` and `qr-steps.py` list the first
numerically differing step of each design (none now). This Python diagnostic
does not distinguish signed zeros; the Rust chain gate above compares the
recorded bits.

The two remaining non-exact designs are a recording-format loss, not an
arithmetic difference. The rest of this paragraph and the table record the
state before #731.

In total 123 → 300 of 348. Every real double design is bit-identical. Three
single designs with subnormal imaginary parts (`glm_single_1e+06/08/10_1e-50`)
equal MATLAB's values and differ only in the sign of a zero imaginary part. No
bit-identical case was lost. In 13 complex designs one
part moved further from MATLAB while the others came closer (for example
`random_double_3`'s imaginary intercept, 49 to 437 ULPs); `qr-outcomes.json`
records them. What remains: the single `?nrm2` in two designs (reference
LAPACK 3.9's scaled sum matches 91 of 93 single R(1,1) values; no candidate
tried fixes both without breaking others), R(2,2) in nine single designs,
complex `?unmqr` in 21 double and 12 single designs, and the Intel branch. In
`?ztrsv`, where c² + d² is not a finite normal number the port uses the guarded
division; MKL's result there matched it at the two recorded scales (1e155,
1e300) but its formula is not otherwise evidenced. The same safe division
protects overflowing numerator products/sums and products that flush to zero;
finite subnormal products retain the measured arithmetic. These extensions have
analytic single-column regression tests, not MATLAB bit-parity evidence.
Multi-RHS real solves use direct division when the reciprocal overflows, with
unit-solution regressions for subnormal diagonals in both precisions.

Every recorded real multi-RHS coefficient must equal MATLAB's bit for bit. The
frozen `qr-multi-outcomes.json` snapshots of earlier nonmatching solves are
gone: none remains.

The zero-based single CSS vertices 47 and 58 have exact zero baselines in
MATLAB, where cancellation of the observation sum gives the port about 4e-9
(within the acceptance scale). Other inputs, CPUs or MATLAB releases may round
differently.

Nonfinite converted inputs, including finite doubles that overflow single,
give NaN coefficients. MATLAB's handling was not recorded. When `beta - alpha`
overflows inside a reflector (both near the largest value), the reflector is
formed from halved values, which is exact and leaves every recorded solve
unchanged. Complex division is prescaled by powers of two near the overflow
and underflow thresholds, as LAPACK's `xLADIV` does, so a complex reflector
whose `alpha - beta` approaches the largest value keeps its coefficient; this
too leaves every recorded solve unchanged.

In the full pipelines (committed module from
[run 43151575795](https://github.com/neurodesk/webapps/actions/runs/43151575795), with the #799 polygon hulls, #796 and #801, and the reviewed division guards; the map and CSS reports equal those of the QR-only module from run 43136443327),
against the previous module on main: across the ten single forward pipelines
(748 vertices) bit-identical Beta values rise from 649 to 724 and Baseline
values from 391 to 670. The largest Beta difference falls from 9.54e-7 to
2.38e-7; the largest Baseline difference moves from 5.73e-8 to 5.82e-8, on the
small cancellation-dominated baselines described above, and one analyzePRF
baseline loses bit identity (6 to 5 of 10). The single CSS pipeline's Baseline
is bit-identical at 93 of 96 vertices (from 53) with its largest difference
falling from 1.82e-8 to 1.86e-9. All 114 map gates, the CSS replay and all 1,858
reverse-correlation gates pass with unchanged tolerances.

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
- **Polygons.** Emptiness is exact, the hull has exactly MATLAB's vertices,
  bit for bit, and area and centroid then lie within the forward-error bound
  of MATLAB's shoelace on untranslated vertices. 25,980 of the 26,073 recorded
  polygons agree, on both hosts, and so do all 253 polygons of the 741-case
  reference without exclusions. This is the shipped model: the WebAssembly
  module, the web app and the `samsrf` command line use it, and its gate and
  frozen baseline (`matlab_polygon_snapping.json`, 93 clouds) stay unchanged
  until a replacement passes without regressions. Only the hull is gated:
  SamSrf uses `polyshape` only for `convhull`, and the model's simplified
  vertex set is neither exposed nor compared. The model, reconstructed from
  these recordings (`core/src/polyshape.rs`):

  1. *Fixed-point grid.* Each axis is centred on the middle of its range,
     scaled by `10^p` with `p = 13 - floor(log10(m))` for the largest centred
     magnitude `m`, and truncated to integers. New vertices come back as
     `k * 10^-p + c` and surviving ones keep their original coordinates.
     Truncation, not rounding, is what separates exact power-of-two copies of
     one triangle (2^-10 lands on 976562.5 grid units) and the one-ULP apex
     steps at scale 1.
  2. *Thinness.* The tolerance is `(1e-8 * span) * 10^p` in grid units, and a
     vertex goes when its distance from the line through its neighbours,
     `|cross| / length` on the integers, is below it. This alone reproduces all
     22,636 recorded triangles, including the 1,853 within 1e-5 of the cutoff
     that the earlier floating-point rule missed.
  3. *Even-odd resolution.* The ring's boundary is every sub-segment covered an
     odd number of times (MATLAB's pentagram keeps five points, not its centre).
     Each filled face is traced with the region on its left and cleaned with
     Clipper 6.4.2's `CleanPolygon` loop (close neighbours, close
     semi-adjacent pairs, near-collinear points) using the distance in step 2;
     the hull of the survivors is cleaned the same way. Duplicate points,
     retraced spikes and narrow spikes all follow from this.

  The 93 remaining polygons are all near-collinear clouds: points within 1e-6
  to 1e-10 of a line in random order. The test names these 93 cases, requires
  each to stay near-collinear and still differ, and freezes each port hull,
  emptiness, area and centroid bit for bit in `matlab_polygon_snapping.json`.
  These are regression snapshots, not MATLAB ground truth. Every other polygon
  remains gated against MATLAB. Why these 93 differ is not known; the
  experimental model below reproduces 53 of them and its replay narrows, but
  does not settle, the cause.

  *Historical explanation, superseded:* before the polyshape probes this
  section attributed the 93 to MATLAB snapping vertices by up to the tolerance
  at nearly parallel crossings, because on this model's grid MATLAB's vertices
  lay 1e5 to 1e8 grid units from every exact intersection and Clipper's
  `IntersectPoint` reproduced 7 of 9,861 of them. On the span grid and with
  Clipper's whole union (experimental model below), every vertex MATLAB keeps
  for the 2,500 clouds lies on the union wherever the recording can tell which
  grid point it is. What differs is which vertices survive, not where they lie.
  The polyshape probe also ruled out the largest centred offset, which step 1
  uses, as MATLAB's grid measure. The shipped model keeps step 1 unchanged: its
  hulls still equal MATLAB's on all 27,648 grid-probe polygons (report-only,
  [below](#shipped-and-experimental-models-on-the-probe-recordings)).

  Unrepresentable grids (nonfinite centre/span/scale or scaled coordinates
  outside the integer arithmetic bound) return an empty hull before conversion.
  This prevents overflow or nontermination on extreme coordinates such as
  1e-300; it is not a MATLAB parity claim for that unsupported domain. MATLAB
  keeps a 1e-300 triangle's vertices with area 0 where this model returns an
  empty hull.
  Intersection coordinates use exact arithmetic; face tracing still uses
  floating-point turning and parity decisions. Clipper's source revision,
  copyright, Boost license and adapted distance comparisons are recorded in
  the module and the shipped package `NOTICE`.

  SamSrf passes `polyshape` a breadth-first cluster of unique template points;
  only a nearly collinear cluster of four or more points reaches this class.

A native release run of `real_template_cf_maps_match_matlab` with both hosts'
fixtures used 3.82 CPU seconds and 11,588 KiB peak resident memory on the shared
builder (15.57 seconds elapsed under contention). It exercises the 2,917/3,389
seed templates, 40 hull profiles per hemisphere/precision/host including centre
and surround hulls, plus the recorded summary and Gaussian cases. This is a
bounded workload measurement, not a full-surface or browser performance result;
the all-pairs intersection graph can still grow quadratically.

The same test replays the double hull and summary CF pipelines of the raw-input
matrix (both hemispheres, smoothing and global regression on and off, both
hosts) from their recorded profiles; all values agree within 1e-12 relative.

### Experimental Clipper model (not in production, #732 open)

`core/src/experimental` holds a second model of `polyshape(...).convhull`,
compiled only with the `samsrf-core` feature `polyshape-experimental`. No
shipped build enables it: the WebAssembly module, and with it the web app and
the `samsrf` command line, uses the production model above, and a WebAssembly
build with the feature fails to compile. Its gates are
`tests/matlab_polyshape_experimental.rs`, with their own frozen baselines; the
production gates and `matlab_polygon_snapping.json` (the 93 clouds above) do
not depend on it. It is not adopted because it regresses four clouds that the
production model matches (below).

The model, reconstructed from the recordings:

1. *Fixed-point grid.* Each axis is centred on the middle of its range and
   scaled by `10^p` with `p = floor(log10(1.25e14 / span))` for the larger
   axis range `span`, log10 rounded to nearest, then truncated to integers.
   The polyshape probe (below) supports the rule: across six shapes, five
   decades, translations and both axes, 27,648 polygons whose new vertices
   show their grid follow it without exception. In-MATLAB bisection puts the
   boundary between adjacent doubles (span 12.500000000000025 keeps `10^13`,
   12.500000000000027 takes `10^12`), where log10's rounding decides, and
   translated copies with the same largest centred offset but a half-range
   rounded one unit lower keep the finer grid, which rules out that offset as
   the measure. The model decides the rounding exactly (`floor_log10`).
2. *Clipper union.* The ring goes through a port of Clipper 6.4.2's strictly
   simple even-odd union (`SimplifyPolygons`, `experimental/clipper.rs`). Its
   sweep rounds each crossing with Clipper's floating-point `IntersectPoint`.
   Ties keep libstdc++'s `std::sort` order (`gnu-sort-probe.cpp` pins it). The
   port agrees ring for ring with `clipper-lib` 6.4.2 (the JavaScript
   translation) on 36,700 rings, once seven places where that translation
   departs from the C++ source are put back.
3. *Cleaning.* Each output path is cleaned with the tolerance
   `(1e-8 * span) * 10^p` in grid units by Clipper's `CleanPolygon` loop and
   its own comparisons (squared distances, `<` for near-collinear points, `<=`
   for close neighbours). The cleaned paths are united and cleaned once more,
   and the hull of the survivors is cleaned the same way.
4. *Input winding.* Before the union, a ring wound negatively on the grid is
   reversed behind its first vertex (`[p0, pn-1, ..., p1]`).

It gives MATLAB's hull vertices on 26,029 of the 26,073 original polygons
(production: 25,980) and on all 253 reference polygons. The 44 that differ are
near-collinear clouds; their outcomes are frozen in
`matlab_polygon_snapping.experimental.json` as regression snapshots, not MATLAB
ground truth. Forty are among the production model's 93. Four (177, 932, 1607,
1937) match under the production model and differ under this one: hull area
by 0.5 to 17.3 %, CF sigma by 0.2 to 9.1 % and the centroid by 0.3 to 6.5 % of
the hull's length (`compare-polygon-snapshots.mjs` on the production and
experimental snapshots, `polygon-snapshots-732.json`: 53 resolved, 36 carried
with changed bits, 4 carried unchanged, 4 newly differing).
`experimental_exceptions_are_production_exceptions_but_four_regressions`
requires exactly those four. Each correction tried (rotating rings to their
lowest input vertex, reversing them, face tracing, a non-strict first union,
splitting holes that touch their outer ring at two vertices) resolves some of
the four and breaks other polygons, so none is adopted. One union and clean
pass, or three or four, instead of two, resolves none of the four either
(tested because MATLAB's default is not idempotent). One pass loses three
original clouds and 37 real-cloud transforms and gains two held-out
near-collinear clouds; three or four passes lose six held-out strip pairs and
gain one held-out cloud. No general correction has been established from the
current evidence.

Where the model cannot follow MATLAB (nonfinite centre or span,
`log10(1.25e14 / span)` outside -22 to 38, or a Clipper sweep that fails for a
reason other than a degenerate path) it returns an error, not an empty hull.
The probe recorded MATLAB on four such inputs: a 1e-300 triangle keeps its
vertices with area 0, subnormal and +-1e308-span triangles give an empty shape,
and 1e308..1.1e308 fails with `MATLAB:polyshape:xyTooLarge`. The gate requires
the model's error on the first four extreme grids.

The *polyshape probe* (`record_geometry.m` in its `polyshape-probe` mode,
`geometry_only` with `geometry_probe` in the `samsrf-native` dispatch; pinned
by `polyshape-probe-reference.json`, HF commit
41f53d4ea8e4714ffe825375f024072aca9d70a3, SHA-256
`01d254651c688d7a764cc464fe1f8b21c3c7bb6ad151df118877ff7acf70827f`, run
43207291565 at webapps 9213e385054710e537cdeb22d7e820aca025a685) leaves
`geometry-reference.json` untouched. Both hosts passed an exact same-host
repeat, their 80 arrays are identical, and its re-recorded 2,500 point clouds
equal the original archive's bit for bit. `polyshape_probe_matches_matlab`
requires the grid sweep and bisection exactly (hull and simplified vertex set)
and every held-out hull except the IDs in `matlab_polyshape_probe.json` (148 of
1,500 near-collinear clouds, 30 of 1,500 mixed clouds), whose outcomes are
frozen in `matlab_polyshape_probe_outcomes.json`. Held-out cloud 1125 is a
half-integer grid whose `KeepCollinearPoints` rings hold the filled triangle
(1, 1.5), (1.5, 2), (1.5714, 1.7857) that Clipper also gives, while MATLAB's
default output has (1, 1.5), (1.6667, 1.5), (1.5714, 1.7857).

The *causal probe* (`polyshape-causal` mode, `polyshape_causal_cases.m`,
pinned by `polyshape-causal-reference.json`, HF commit
f742a23f395ee6fc11f14677e121a57cb01d7d37, SHA-256
`bec4a653acdc9b5ea8d9213bba860af4361be3e8283abf9cad776208ab2f2243`, run
43226907674 at webapps 9b4e1a0f2f864c8bafcdd47bc5c96ffc5913e11a; both hosts'
120 arrays identical and same-host repeats exact) records 10,749 controlled
polygons per host: 8,424 strip pairs around an unfilled sliver, 1,152
sliver-width bisection polygons, 170 holes at and near one contact, 403
transforms of real clouds and 600 held-out strip pairs. The strip pairs showed
MATLAB's hull depending on where the input starts but not on its direction
(step 4: 147 of 8,424 strip pairs and 12 of 600 held-out pairs differed
without it). The bisection showed MATLAB merging strips one tolerance thick up
to 2.478 tolerances, where an edge lies exactly at the tolerance; Clipper's
squared floating-point comparison removes it (step 3: 90 of 1,152 differed
without it). With both rules, every strip, bisection, hole-contact and
held-out strip hull matches, and no original or held-out probe polygon or
frozen snapshot changes. Every cyclic start, reversal, translation and scale
by 1e-2 and 1e2 of clouds 177, 932, 1607 and 1937 differs from MATLAB, while
every transform of clouds 7 and 1090 matches, so input order does not explain
the four. `polyshape_causal_matches_matlab` requires every causal hull except
the listed real-cloud transforms, whose outcomes are frozen in
`matlab_polyshape_causal.json`, and checks simplified vertex sets for the
controlled families except eight strip pairs and one held-out pair listed
there. It requires the family sizes, the descriptor dimensions and complete
consumption of every flattened array.

`polyshape_census.py` and `polyshape_replay.py` (with
`core/examples/polyshape_stages.rs`, built with the feature) report empirical
correspondences between the model and MATLAB's recorded configurations. They
do not observe MATLAB's internal stages: `KeepCollinearPoints=true` is a
separate configuration, not a checkpoint of the default. The census invokes
the model's own cleaner (`polyshape_stages --clean`); it has no independent
implementation of it. Replaying that cleaner on the recorded kept rings
disagrees with default MATLAB in 30 of the 158 near-collinear cases whose
kept-ring structure matches the model, so the premise that the default is the
kept rings cleaned one by one fails. The replay runs the model on the recorded
`P`, kept and default boundaries of the causal probe and compares each with
MATLAB's `polyshape` of the same boundaries. On both hosts, of 10,749 polygons:

- `simplify(polyshape(P, 'Simplify', false))` equals the default for all.
- `polyshape` of MATLAB's own kept vertices equals the default for every
  transform of cloud 177 but none of 932, 1607, 1937 or cloud 7.
- `polyshape` of the default is not the default for 932, 1607 and cloud 7.
- Given MATLAB's kept boundaries, the model reproduces MATLAB's `polyshape` of
  them, in vertex set and unoriented rings, for every transform of the four
  regressions and of cloud 7 and for 80 of 81 of cloud 1090. For cloud 1125 the
  vertex sets agree in all 35 transforms but the rings in 1. On the controlled
  families every vertex set agrees, but the rings only in 5,928 of 8,424 strip
  pairs, 794 of 1,152 bisection polygons, 170 of 170 holes and 455 of 600
  held-out pairs.
- Given MATLAB's default boundaries, the model reproduces MATLAB's
  `polyshape` of them, in vertex set and rings, for every transform of 177 and
  1937 and for 60 of 81 of 1090, for none of 932, 1607 or cloud 7, and for
  1125 in vertex set (35 of 35) but not in rings (1 of 35).

This empirical correspondence narrows the plausible causes towards how MATLAB
resolves the self-intersecting input in its default configuration, rather than
the cleaning of already resolved boundaries. It does not establish that the
cleaner matches MATLAB in general or that the mismatch lies only in a hidden
construction stage: the kept configuration is not the default, the default is
not idempotent, the model's replay of default boundaries differs for three of
the seven clouds, and its rings differ from MATLAB's on replayed kept
boundaries in 2,999 of the 10,346 controlled polygons even where the vertex sets
and hulls agree.

### What is established and what is not

Established on the pinned recordings (both hosts identical):

- The shipped model's hull agreement on every family listed below, and the 93
  original clouds where it differs.
- The experimental model's agreement, its 44 original, 178 held-out and 246
  causal exceptions, and its four regressions against the shipped model.
- MATLAB's grid decade follows the span rule on 27,648 probe polygons; input
  winding does not change MATLAB's hull of the strip pairs, but their starting
  vertex can; strips one tolerance thick merge up to 2.478 tolerances apart.
- MATLAB's default `polyshape` is not idempotent on 932, 1607 and cloud 7, and
  `polyshape` of its `KeepCollinearPoints` vertices differs from the default
  on 932, 1607, 1937 and cloud 7.

Not known:

- Why MATLAB's default keeps the vertices it keeps for the 44 (experimental)
  or 93 (shipped) near-collinear clouds. MATLAB's internal stages are not
  observable through `polyshape`'s public outputs, and `KeepCollinearPoints`
  is a separate configuration, not one of those stages.
- Whether any model reproduces both the four clouds and the families the
  experimental model fixes. The shipped model's hulls of the four depend on
  the input's order, and the experimental model matches no transform of them
  (table below).
- MATLAB's simplified vertex sets in general. The experimental model matches
  them for 1,904 of the 2,500 original clouds and every grid-probe polygon,
  and the shipped model's are not compared; SamSrf uses only the hull.
- Anything outside the recorded families, including the extreme grids where
  both models refuse or return an empty hull.

### Shipped and experimental models on the probe recordings

Report-only: no gate depends on this table, and it changes no baseline.
`core/examples/polyshape_hulls.rs` (built with the feature) counts the
polygons whose hull vertex set equals MATLAB's exactly; the gates also bound
area and centroid, which changes no count on the original families. Both
hosts give the same counts.

| Recording | Polygons | Shipped model | Experimental model |
| --- | ---: | ---: | ---: |
| Original families (`geometry-reference.json`) | 26,073 | 25,980 | 26,029 |
| Grid sweep and bisection (probe) | 27,648 | 27,648 | 27,648 |
| Held-out near-collinear clouds (probe) | 1,500 | 1,192 | 1,352 |
| Held-out mixed clouds (probe) | 1,500 | 1,435 | 1,470 |
| Extreme grids (probe) | 7 | 6 | 3, refuses 4 |
| Strip pairs (causal) | 8,424 | 7,866 | 8,424 |
| Sliver-width bisection (causal) | 1,152 | 954 | 1,152 |
| Holes at one contact (causal) | 170 | 170 | 170 |
| Held-out strip pairs (causal) | 600 | 568 | 600 |
| Real-cloud transforms (causal) | 403 | 308 | 157 |

The shipped model's one extreme-grid difference is the 1e-300 triangle; its
match at 1e308..1.1e308 is an empty hull where MATLAB raises
`MATLAB:polyshape:xyTooLarge`.

Real-cloud transforms by source (every cyclic start, both directions, a
translation and scales of 1e-2 and 1e2):

| Source cloud | Transforms | Shipped model | Experimental model |
| --- | ---: | ---: | ---: |
| 7 | 75 | 75 | 75 |
| 177 | 39 | 36 | 0 |
| 932 | 39 | 27 | 0 |
| 1607 | 83 | 71 | 0 |
| 1937 | 51 | 17 | 0 |
| 1090 | 81 | 81 | 81 |
| held-out 1125 | 35 | 1 | 1 |

The shipped model's agreement on the four regressions depends on the input's
order too: it matches the recorded order and some other transforms, not all.
This does not excuse the regressions. The shipped gate is the original
recording, on which it matches all four and the experimental model none, and
the experimental model matches no transform of any of the four.

### Performance

Performance, measured before the extraction (one core of a loaded builder,
timings approximate): on the whole X001 example (6 runs, 6,587 V1-V3 vertices,
V1 seed, Benson template) the experimental and production models give
bit-identical connective-field maps in hull and summary modes; the hull run
took 81.7 seconds against 68.4, with 623 MB peak for both. The largest single
hull SamSrf can ask for there takes 1.09 seconds (production 0.35). Clipper
sorts each scanbeam's edges by bubble sort and splits self-touching rings by
pairwise search, so a ring in random order costs roughly cubic time: 1,000
random points take 4.5 seconds (production 1.5).

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

With the port's own HRF, which now equals MATLAB's kernel bit for bit, three
recorded 96-vertex double pipelines are checked at every vertex: `reference.json`'s
`pipeline_double_css`, and the original-aperture and nonnegative-aperture
pipelines of `css-pipelines-reference.json` on its AMD host (below). This is
parity with that AMD reference only.

- `compare-css.mjs` replays each one on the committed WebAssembly through the
  public API (`createJob`, `runJob`, `hrf.deHaas`). It requires the port's de Haas
  kernel to equal the recorded one, every fitted parameter, R², nR² and noise
  ceiling to be bit-identical, and every map row to keep MATLAB's NaN, infinity
  and zero masks. A second run with MATLAB's recorded kernel is the control that
  isolates the objective from the HRF: the same gates apply, and both runs must
  agree in every bit. The former differences at vertices 14, 15, 51 and 81 came
  from the kernel and are gone.
- `css_pipeline.rs` runs the same pipelines natively and applies the same map
  and mask gates. It requires the WebAssembly's Beta and Baseline to be the
  native bits for all three, and checks the coefficients with a stated policy
  (`coefficient_gate`), not a derived error bound:
  1. **Rank.** MATLAB's rule (`|R22| > max(m, n) eps |R11|`, ten times that for a
     complex design, as `lstsq.rs` records) is evaluated exactly. Where it gives
     rank 1, the other coefficient must be MATLAB's and the port's exact zero,
     and the kept one is compared with the one-column solution. A MATLAB zero
     without rank deficiency fails. When the exact ratio lies within a factor of
     2 of the tolerance, rounding could flip MATLAB's decision. There the
     recorded zero pattern is the rank evidence and the port must match it: 3
     vertices of the original pipeline (both recordings), none of the
     nonnegative one. Elsewhere the closest exact ratio is 125 times from the
     tolerance (6.7 in the nonnegative pipeline).
  2. **Error.** For differing coefficients, `|port - t|` and `|MATLAB - t|`
     are measured exactly, with `t` the real part of the exact least-squares
     solution in rational arithmetic. Identical coefficients skip this
     measurement: their excess error is zero, but their individual errors
     against the exact solution need not be zero.
  3. **Scale.** The port's error may exceed MATLAB's by at most `S`. `S` is the
     first-order change of the coefficient when every column of the design and
     `y` moves by one unit roundoff of its norm (Wedin's expansion; Higham,
     *Accuracy and Stability of Numerical Algorithms*, 2nd ed., section 20.1).
     It neglects higher-order terms and assumes columnwise normwise
     perturbations, so it is a scale, not a bound on anything. The gate fails
     unless u times the column-scaled condition number is at most 2^-20, which
     every recorded vertex meets (at most 2.2e-16). `S` is computed in an
     extended exponent range, so designs whose squares overflow or underflow
     double keep finite scales. Below the double spacing nothing is widened:
     there a single ULP fails.
  4. **Mutation tests.** Synthetic problems check that the gate accepts exact
     coefficients and one-ULP changes, and rejects large mutations of either
     coefficient. They also check the rejection of a zero in the wrong place,
     a zero without rank deficiency, an ill-conditioned design and a mismatch
     with recorded rank evidence. Overflowing and subnormal designs are
     covered.

| Pipeline | Bit-identical | Differing | Basic zeros | Rank from recording | Port error / `S` (differing only) | MATLAB error / `S` (differing only) | Largest excess / `S` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `reference.json` original | 138 | 0 | 8 | 3 | Not measured | Not measured | 0 |
| AMD recording, original | 138 | 0 | 8 | 3 | Not measured | Not measured | 0 |
| AMD recording, nonnegative | 126 | 0 | 8 | 0 | Not measured | Not measured | 0 |

These counts use the MKL `?gemv` and `?ormqr` summation orders of #795 (see
Least-squares solves). Before them, 77 and 70 coefficients were bit-identical,
and the largest excesses were 0.40 and 0.81 of `S`. #731's two-accumulator
`zunmqr` made the original pipeline's last two coefficients bit-identical
(136 and 2 before, at most 0.21 and 0.22 of `S` for the port and MATLAB): its
complex CSS powers make those designs complex. The nonnegative control's last
differing coefficient (125 and 1 before, at most 0.0036 and 0.0026 of `S`,
excess 0.0010) became bit-identical with the reflector trim of `?geqp3`'s
column update: clipped responses leave exact zeros at the end of the first
reflector.

`css-pipelines-reference.json` pins a fresh recording of the original pipeline
and of a nonnegative control, `max(ApFrm, 0)` on the same vectorised apertures
(`record_css_pipelines.m`,
[run 43127425289](https://github.com/neurodesk/webapps/actions/runs/43127425289) at
recorder commit `7d2188ed226046a8cb19a770c08e43be0cb19321`, SamSrf `41ed1e96`).
Each host ran it twice in new MATLAB processes. `css_pipeline.rs` checks this
provenance from each process's own `environment.json`: run, recorder mode,
SamSrf commit, requested `MKL_CBWR`, the BLAS line and the CPU. It also checks
that every repeat array equals its first run.

| Host | CPU | Requested | Observed | Result |
| --- | --- | --- | --- | --- |
| `ubuntu-24.04` | AMD EPYC 9V74 | `MKL_CBWR=COMPATIBLE`, one MKL and OpenMP thread | CNR branch `auto`, one computational thread; MATLAB's process shows `MKL_NUM_THREADS` empty | repeat identical; the original pipeline equals the old pin (from an EPYC 7763) in every course, noise ceiling, map and HRF bit |
| `ubuntu-22.04` | Intel Xeon Platinum 8573C | the same | CNR branch `AVX512_E1`, one computational thread | repeat identical; 23,017 of 24,000 preprocessed samples, 82 noise ceilings and 336 of 864 map values (by up to 9.1e-5) differ from the AMD host, from MKL's preprocessing onward |

The effective CNR branch and MKL's dynamic threading cannot be verified from
inside MATLAB (`unverifiedControls`). So the reference is the AMD host, and the
Intel recording is kept as evidence of the branch difference; nothing here
asserts parity with it.

What remains:

- **Beta and Baseline** are not all bit-identical: 3 of the 264 kept
  coefficients of the original and nonnegative pipelines (the `reference.json`
  and recorded original pipelines are the same data) still round differently from MKL's QR (#731). The
  policy above compares their exact errors with MATLAB's at a first-order scale.
  It does not bound them.
- `gampdf` with shape below 1, the zero signs, sparse complex convolutions longer
  than 800 samples, and real `x'*y` of 8-19 elements.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-numerics" packages/samsrf/validation/matlab/numerics-reference.json
SAMSRF_MATLAB_NUMERICS_DIR="$TMPDIR/samsrf-numerics" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test matlab_numerics
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-numerics2" packages/samsrf/validation/matlab/numerics2-reference.json
SAMSRF_MATLAB_NUMERICS2_DIR="$TMPDIR/samsrf-numerics2" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test matlab_numerics2
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-css-pipelines" packages/samsrf/validation/matlab/css-pipelines-reference.json
node packages/samsrf/validation/matlab/compare-css.mjs "$TMPDIR/samsrf-source-reference" "$TMPDIR/samsrf-css.json" "$TMPDIR/samsrf-css-pipelines"
SAMSRF_MATLAB_REFERENCE_DIR="$TMPDIR/samsrf-source-reference" SAMSRF_CSS_WASM_REPORT="$TMPDIR/samsrf-css.json" SAMSRF_MATLAB_CSS_PIPELINES_DIR="$TMPDIR/samsrf-css-pipelines" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test css_pipeline
```

`record_matlab=true, numerics_only=true` repeats the probe recording and
`record_matlab=true, css_pipelines_only=true` the pipelines. Octave can run
the recorder's plumbing with a stubbed environment; its results are never
references.
