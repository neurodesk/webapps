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
The `controls_only` receipts ([Requested and effective MKL controls](#requested-and-effective-mkl-controls-730))
show that MKL ignores the branch request and runs each CPU's automatic branch
(`AUTO` on AMD, `AVX512_E1` on Intel), and that `MKL_NUM_THREADS` never reaches
MATLAB's environment. MKL's own thread count and dynamic setting could not be
read (its thread functions do not resolve in MATLAB's process). The older
recordings' `environment.json` still lists them as unverified. A successful recording is not a
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
| Single global-regression residuals, AMD host | exact | 0 (every residual identical) | |
| Single global-regression residuals, AVX-512 matrix host | 32 units of the input course's peak | Not summarized here | Matrix reference; the edge recording has AMD hosts only |
| Double global-regression residuals, both recordings and hosts | `1e-13` x input course peak | Not summarized here | Separate double-precision gate |
| Each host's profiles to its maps (replay) | exact | 0 | |
| RC `R^2` where MATLAB used MKL's AVX-512 path | 16 single ULPs | 9 | the dot product order (below) |
| Positions, `Fwhm`, `Vx`, hull and summary widths, end to end | exact | 0 | |
| CF `R^2`, `Beta`, `Suppression`; RC `Beta` (of itself), end to end | 32 units x kappa | 3.20 per kappa | profile values |
| Production Benson reader instead of MATLAB's template | exact | 0 | below |
| Internal single CF from the raw files, Gaussian fits included (AMD host) | exact | 0 | below |
| Internal single RC 2D fits from the raw files (AMD host); replay from each host's profiles | exact | 0 | below |
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
`lstsq::mldivide_many`, which solves all right-hand sides together,
in MATLAB's column order. Historically it brought the largest RC profile error
from 8.42 to 5.45 units per kappa, residuals from 18.81 to 5.41 and end-to-end
profile values from 6.44 to 3.20, with 30% of profile entries and 54% of
residuals bit-identical. With the multi-RHS solves (#808) and MKL's `snrm2`
order (#812), every single profile entry and residual is now bit-identical on
the AMD host (above); the AVX-512 host keeps the limits. The rounding-only
courses stay, because MATLAB's residual there is rounding the port does not have. Double profiles are
one `[Y ones] \\ X` over every pixel as well since 0.6.20261116: every double
profile of the matrix and edge recordings is bit-identical on their AMD hosts
(`double_rc_profiles_equal_matlab_on_amd_hosts`; the centred solve it replaced
matched 1,533-1,815 of 8,400 per case). `corr`'s dot product follows MKL's CNR `auto` order
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
  The same structure with FreeBSD's published ln 2 splits differs from
  MATLAB's recorded outputs on more inputs, on both hosts: hi = `0x3f317180`,
  lo = `0x3717f7d1` (5.0) on 465, and hi = `0x3f317200`, lo = `0x35bfbe8e`
  (`e_expf.c` `90880193`, 2005-11-30) on 601, against 18 for `0x3f317000`
  (`candidate_exclusions.rs`, `exp_ln2_splits_differ_from_matlab_as_recorded`,
  which first requires its reconstruction with the port's split to equal
  `exp_single` on all 711,307 inputs).
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
the whole X001 atlases retain coordinate discrepancies (their effect on
held-out CF fits is measured under
[atlas coordinates](#atlas-coordinates-and-connective-fields)), and 18 recorded
single `exp` inputs still differ. No general end-to-end acceptance bound covers those
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
evidence covers three recorded cases with `fminsearch` and, from the focused
probes below, the same cases' profiles fitted with `Hooke_Jeeves_Steps`; nothing
bounds the fits on other inputs or on MATLAB's AVX-512 host.

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

**Candidates rejected against the recording (no production change).**
`exes/samsrf/core/tests/candidate_exclusions.rs` evaluates reconstructed
variants: the port's structure with one element replaced by a constant or mask
transcribed from a FreeBSD msun revision of 2005 (the full commits are listed in
the file's header). No upstream code is executed or imported, so these are not
the revisions themselves. Every variant shares the port's fdlibm float range
reduction (n = +-1 below 3 pi/4) and, unless named, its fdlibm kernels.

MATLAB's output is reconstructed, not re-recorded: it is the port's output
except at the recorded exception inputs, where it is the recorded value. The
test rebuilds it for all 2,257,723,138 recorded inputs and requires every one of
the 136 recorded SHA-256 block digests, and it requires the reconstructed port
to equal `precision::sin_single`/`cos_single` on every evaluated input. It reads
the AMD EPYC 9V45 host's first process; `single_trig.rs` requires the other
three recordings to be identical. Counts are over every single with
|x| < 3 pi/4 (bits below `0x4016CBE4`), both signs, 2,150,471,624 inputs; the
sine-kernel rows count `sin` only, for 2^-12 <= |x| <= pi/4 (bits `0x39800000`
to `0x3F490FD8`):

| Variant | `sin` differs | `cos` differs |
| --- | --- | --- |
| The port: x/4 keeps 11 fraction bits (`& 0xfffff000`) | 12,610 | 12,392 |
| x/4 keeps 20 bits (`& 0xfffffff8`), the mask of `k_cosf.c` `11cba99f` (2005-10-09) | 12,878 | 12,630 |
| x/4 keeps 19, 15, 12, 10 or 7 bits | 12,738 to 15,902 | 12,512 to 16,274 |
| Sine kernel with the minimax S1-S4 of `k_sinf.c` `11dc2417` (2005-10-28) / `6e10a447` (2005-11-12) | 404,344 / 405,880 | |
| Sine kernel with fdlibm's coefficients rounded toward zero | 1,335,986 | |

FreeBSD's mask and the port's give different outputs on 268 (`sin`) and 238
(`cos`) inputs, and MATLAB agrees with the port's on all of them. Of the five
other masks tested, none does better than the port's. These results reject
candidates; they do not identify MATLAB's implementation, and the sine kernel's
residual is unexplained. In the [focused probes](#focused-probes-729-730),
scalar calls, each of 33 positions in an array and whole-array calls all give
the recorded value at 256 sampled exception inputs of each function and 256
controls. That excludes a position effect for those inputs and call shapes,
not every vector-kernel explanation.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-single-trig" packages/samsrf/validation/matlab/single-trig-reference.json
SAMSRF_SINGLE_TRIG_DIR="$TMPDIR/samsrf-single-trig" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test candidate_exclusions -- --ignored --nocapture
```

The run takes about a minute on 8 cores. Changing one recorded output bit fails
its block's digest, so the reconstruction is checked rather than assumed.

## Focused probes (#729, #730)

`record_focused_probes.m` answers four questions whose competing predictions were
committed in [`focused-probes-predictions.md`](focused-probes-predictions.md)
before MATLAB ran it. The first run
([43527633094](https://github.com/neurodesk/webapps/actions/runs/43527633094))
voided its Hooke-Jeeves section: the control failed because the recorder seeded
the fits from `single(rawMaps)`, while `samsrf_revcor_prf` holds the raw maps in
double until the Srf is saved. The amendment that says so, with new predictions,
was committed before the rerun. `focused-probes-reference.json` pins the rerun
([43528858771](https://github.com/neurodesk/webapps/actions/runs/43528858771),
recorder commit `5170ab0aaa9a1317296c095178742597800ac7c9`) on an Intel Xeon
Platinum 8573C (`ubuntu-22.04`, CNR `AVX512_E1`) and an AMD EPYC 7763
(`ubuntu-24.04`, CNR `auto`). Each host ran the probes twice in fresh processes,
and the recording workflow required the repeat to be identical; the archive
keeps both processes. When the pin was made (not in a test), every array outside
the Hooke-Jeeves section also equalled the first run's, which used an AMD EPYC
9V45 and an Intel Xeon Platinum 8573C.

`focused_probes.rs` reads only the first process of each host, through a checked
boundary: both hosts and exactly the recorder's 44 cases (ids, kinds, pipelines,
algorithms, step sets, conv sources and centres rebuilt from the recorder's
rules), each array's class (`double`, `single` or `uint32`), realness, shape and
exact byte count, integral indices and dimensions, and a NaN policy per field.
The `refuses_*` tests run without data and check that malformed recordings fail.
The results it freezes:

| Probe | Recorded | Prediction confirmed | Rejected |
| --- | --- | --- | --- |
| Hooke-Jeeves | the three single RC 2D cases of each pin host, from that host's profiles: a Nelder-Mead control and step sets `[0.1 0.1 0.1]` and `[0.05 0.05 0.02]`, with two logged searches per fit | Control: the pinned maps, on both recording hosts. H1': parameters and seeds double, `R^2` single; each logged error is a single value the search keeps in a double. H2': per pin host, 78 fits (39 vertices × 2 step sets); MATLAB's keep rule keeps 43 (30 distinct vertices) and rejects 35. For each kept fit the port gives `R^2` and every parameter bit for bit in double; it rejects the same 35. The rejected fits' parameters are not compared, because `fit_model` returns NaN for them | H1 and H3 (single parameters): an artifact of the first run's single seeds |
| conv near 512 | 24 regions per host: sparse complex courses of 1,000-2,000 samples, 33 ones taps, a ±2^60 pair at every window position within 15 below to 14 above 256 (control) and each multiple of 512 | H-seq for these probes: each count equals `convolve_complex`'s sparse path, which adds the window's nonzero samples in index order, in every region | H-split, H-tile, as orders of these ones-kernel patterns |
| trig position | 256 `sin` and 256 `cos` exception inputs and 256 controls, called as scalars, at each of 33 offsets in an array, and as one array | H0: every call gives the recorded value | H-position, for these inputs and call shapes |
| dot, 2-24 elements | the pair fingerprint of every pair for each length, and 50 held-out random products per length | Other: the tree read from the counts | H-mkl (the port's `ddot`), H-seq |

The short dot tree adds adjacent products in pairs from the end, then the pair
sums in index order after the first product when the length is odd; products
and sums are rounded separately (an FMA in either product of a pair fails some
held-out products, which the test checks). It reproduces every count and all
1,150 held-out products on both hosts of the pinned run; the first run's dot
arrays were the same. The earlier BLAS recording agrees: its one product per
length matches this tree for 1-20 and 33 elements, and MKL's blocked kernel,
which the port's `ddot` follows, matches the AMD host at 64, 250 and 1,000 but
not this tree. At 20 and 33 both trees give that recording's value, which is how
`matlab_numerics.rs` came to gate `ddot` from 20 elements. The
[arithmetic-order probes](#arithmetic-order-729-730) then located the switch at
51 elements, and the port's `ddot` follows both trees since 0.6.20261114.

What the probes leave open:

- **conv near 512.** The fingerprints use a ones kernel and the pinned courses'
  nonzero patterns at the probed windows. They show index-order accumulation for
  those patterns, not for the original weighted inputs. The 111 differing parts
  were later explained by which products are fused
  ([sparse conv blocks](#sparse-conv-blocks-730)).
- **sin and cos.** No position effect appears at the 768 sampled inputs, 33
  positions and the three call shapes. Other vector-kernel explanations are not
  excluded, and no candidate kernel reproduces the residual
  ([single sin and cos](#single-sin-and-cos)).
- **Hooke-Jeeves.** The evidence is 43 kept and 35 rejected fits per pin host in
  three cases of one subject; nothing bounds other inputs. Single RC 2D fits stay
  refused.

The convolution gate derives each region's nonzero pattern from its original
complex course in the numerics2 pin. The trig gate reconstructs the recorder's
exception selections and freezes the random-control input inventory, so empty
regions or repeated inputs cannot silently replace the recorded coverage.

The probes in CI's numerics step:

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-focused-probes" packages/samsrf/validation/matlab/focused-probes-reference.json
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-revcor-reference" packages/samsrf/validation/matlab/revcor-reference.json
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-numerics2" packages/samsrf/validation/matlab/numerics2-reference.json
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-single-trig" packages/samsrf/validation/matlab/single-trig-reference.json
SAMSRF_FOCUSED_PROBES_DIR="$TMPDIR/samsrf-focused-probes" SAMSRF_MATLAB_NUMERICS2_DIR="$TMPDIR/samsrf-numerics2" SAMSRF_REVCOR_REFERENCE_DIR="$TMPDIR/samsrf-revcor-reference" SAMSRF_SINGLE_TRIG_DIR="$TMPDIR/samsrf-single-trig" \
  cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test focused_probes -- --nocapture
```

### Atlas coordinates and connective fields

`atlas_coordinate_impact.rs` (ignored; the web app's example and the trig pin)
measures what the remaining one-ULP coordinate differences do downstream without
a new recording. At the exception inputs MATLAB's `sin` and `cos` are the
recorded values and elsewhere the port's, so MATLAB's whole LH template is the
reader's with those values substituted, at 10 vertices. The test runs the same
single CF job on both templates; every other step is the port's, so this is not
a comparison with a MATLAB run. The example's seed holds none of the 10, so its
maps cannot change. Seeds Benson V1 (6,645 vertices, 5 affected) and V2
(4,609, 4 affected), with every 40th V1-V3 vertex outside the seed as held-out
targets (92 and 106): with the V1 seed, the hull fit changes on 1 target
(`Surround`, by 1.9e-6) and the smoothed Gaussian fit on 1 (`Sigma` by 1.2e-4,
`x0` by 1.1e-4); with V2 only the Gaussian fit changes, on 1 target (`y0` by
5.4e-5); the summary mode never changes. The test compares the port with
itself on one subject's left hemisphere, two seeds and sampled targets; it is no
general bound on the effect.

## Arithmetic order (#729, #730)

`record_arithmetic_order.m` records three questions whose predictions and holdout
design were committed first in
[`arithmetic-order-predictions.md`](arithmetic-order-predictions.md), with the
results appended there. `arithmetic-order-reference.json` pins
[run 43564031333](https://github.com/neurodesk/webapps/actions/runs/43564031333)
(recorder commit `36a91f2653a1c4ce40d628a9fd8ddf006eebe24f`) on an AMD EPYC 9V74
(`ubuntu-22.04`, CNR `auto`) and an Intel Xeon 6975P-C (`ubuntu-24.04`,
`AVX512_E1`). Each host recorded twice in fresh processes and the repeats were
identical. `arithmetic_order.rs` reads the recording through the checked boundary
(`tests/support/checked.rs`): the exact host CPUs and MKL branches of the pinned
run, the recorder's 164 cases, every array's class, shape and byte count, and, for
the conv section, each course's nonzero pattern, values and kernel against its
numerics2 source.

**Real `x'*y`.** FPRev pair fingerprints at every pair for every length from 2 to
80 and at 300 sampled pairs for 96, 100, 127, 128, 129, 200, 250, 256 and 1,000
elements, and 50 random products per length (draws 26-50 held out):

| Lengths | Both hosts | AMD host | Intel host |
| --- | --- | --- | --- |
| 2-50 | MATLAB's pair tree: every fingerprint and draw; arrays identical | | |
| 51-80, held out to 1,000 | | MKL's `ddot` as the port models it: every fingerprint and draw | another tree (pairs 32 apart) at every length |

Products and sums are rounded separately in both trees. Before this change the
port used MKL's kernel at every length: on the AMD host it missed fingerprints at
every length from 3 to 50, and the pair tree misses them at every length from 51.
Since 0.6.20261114 `matlab_math::ddot` uses `ddot_pairs` below
`DDOT_MKL_MIN_LENGTH` (51) and `ddot_mkl` from it. The BLAS cases of
`matlab_numerics.rs` (1-20, 33, 64, 250 and 1,000 elements) are now gated at every
length.

**`corr`.** SamSrf's double CSS objective, `1 - corr(x, y)^2`, on 20
time-course-like pairs at each of 25-80, 96, 100, 128 and 250 elements. On the
AMD host the previous port missed 223 of the 1,200 objectives; with the new `ddot`
all 1,200 equal MATLAB's. On the Intel host 786 differed before and 747 after,
also below 51 elements, where the dot product is the same on both hosts; another
operation in Intel's `corr` (not identified) depends on the host.

**Weighted sparse complex `conv`.** The 10 pinned sparse complex courses longer
than 800 samples, each with its original values and 24 sets of random values on
the same nonzero positions and kernel (draws 17-24 held out), and six generated
held-out courses (1,100, 1,536, 2,048 and 2,600 samples with 33 taps; 1,600 with
17 and 65). Both hosts recorded identical outputs. Of 750,312 kept output parts,
the port's sparse path differs on 4,993, all within 16 below to 14 above a
multiple of 512 or within 16 of the end of a course whose length is a multiple of
512. For every differing output, one fusion mask in index order reproduces every
draw, so the difference is which products are fused, not the values. The masks fit
one rule on every 33-tap course, including the held-out draws and the four
held-out 33-tap courses: products of the last 16 inputs before a multiple B of 512
are rounded and then added for outputs B - 16 to B - 1, and products of inputs
before B - 16 for outputs from B on. The 17- and 65-tap courses reject it (98 and
159 parts). The gate keeps that rule as a test-only evaluator. The general rule,
found and held out in two later recordings, is in
[sparse conv blocks](#sparse-conv-blocks-730); with it the port equals MATLAB
on all 750,312 parts of this section.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-arithmetic-order" packages/samsrf/validation/matlab/arithmetic-order-reference.json
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-numerics2" packages/samsrf/validation/matlab/numerics2-reference.json
SAMSRF_ARITHMETIC_ORDER_DIR="$TMPDIR/samsrf-arithmetic-order" SAMSRF_MATLAB_NUMERICS2_DIR="$TMPDIR/samsrf-numerics2" \
  cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test arithmetic_order -- --nocapture
```

## Sparse conv blocks (#730)

Two pre-registered recordings
([`conv-boundary-predictions.md`](conv-boundary-predictions.md): the rules, the
designs, the decision criteria and every amendment, each committed before the data
it depends on was read) support the adopted empirical rule for which products
MATLAB R2023b's sparse `conv` rounds before adding them. Each recording writes a discovery file and a held-out file;
the held-out file was opened only after the rule was frozen from discovery.

| Pin | Run | Hosts | Discovery | Held out |
| --- | --- | --- | --- | --- |
| `conv-boundary-reference.json` | [43678512524](https://github.com/neurodesk/webapps/actions/runs/43678512524) | AMD EPYC 9V74 (CNR `auto`), Intel Xeon 6975P-C (`AVX512_E1`) | 32 courses: 820-1,530 samples, 9-33 taps, a real and a dense control | 14 courses: 845-4,096 samples, 10-129 taps |
| `conv-blocks-reference.json` | [43679359744](https://github.com/neurodesk/webapps/actions/runs/43679359744) | Intel Xeon Platinum 8573C, Intel Xeon 6975P-C (both `AVX512_E1`) | 39 courses: 4,096 samples with 65-258 taps, 1,900-2,000 with 129, real 2,010-4,096, and 3-8 taps | 12 courses: 900-6,000 samples, 13-300 taps, 7 complex and 5 real |

Every course has 12 draws of random values on fixed nonzero positions (24% of the
samples). Each host recorded twice; every repeat was identical, and in each
recording both hosts recorded identical arrays. GitHub assigned no AMD host to the
second recording; MATLAB's `conv` is not an MKL call, and its arrays were identical
on AMD and Intel hosts in every recording that had both (96, 276 arrays).

**The rule** (`matlab_math::sparse_product_unfused`, since 0.6.20261115). For a
course of n samples with fewer than a quarter nonzero and a kernel of T >= 9 taps,
or of 2-8 taps shorter than the course, the nonzero samples are summed in input
order, each product fused into the running sum, except:

- for T <= 16, every product is rounded and then added;
- when the full output (f = n + T - 1 elements) takes more than 16 KiB (f >= 1,025
  complex or 2,049 real), near the boundaries B of blocks that hold 8 KiB of output
  (512 complex or 1,024 real elements), the block doubled while f spans 8 blocks
  or more: for the 16 outputs before B, the products of the 16 inputs before B;
  for outputs from B on, the products of the 16 inputs from B - (T - 1).

The short-kernel part (2-8 taps) and the block doubling at exactly 8 blocks come
from the third recording ([remaining gaps](#remaining-gaps-730)).

**How it was found.** The first discovery file decided that boundaries depend on
the full output, not the course length (995 samples with 33 taps show them, 1,000
with 17 do not), that they apply at a course end even when B lies past it, and
that 9-15-tap kernels are unfused everywhere. The rule frozen from it reproduced 13
of the 14 held-out courses and missed 398 parts of the 4,096-sample, 129-tap
course, so it was rejected. The second discovery file showed the block growing
with the course, not the kernel (at 4,096 samples a 1,024-element block fits every
kernel from 65 to 258 taps), and placed the real threshold strictly above 16 KiB.
The law frozen from it reproduces every kept part of all 12 held-out courses on
both hosts. A block law that grows to the largest power of two below a quarter of
the full output gives the same blocks on every recorded course.

**Identification limits.** These two recordings left the complex threshold
undistinguished among full output lengths 1,023-1,026 and the block law undecided
at exactly eight blocks, and their final held-out courses had no AMD replay. The
third recording ([remaining gaps](#remaining-gaps-730)) settles all three. None of
this establishes MATLAB's internal algorithm or parity on arbitrary inputs.

| Courses (at least 9 taps) | Parts compared | Previous port misses | Now |
| --- | --- | --- | --- |
| First recording, discovery (31 sparse) | 756,912 | 30,399 | 0 |
| First recording, held out (14) | 643,296 | 63,460 | 0 |
| Second recording, discovery (33) | 2,939,472 | 12,023 | 0 |
| Second recording, held out (12) | 1,142,400 | 15,552 | 0 |
| arithmetic-order weighted conv (16) | 750,312 | 4,993 | 0 |
| numerics and numerics2 sparse complex longer than 800 samples | | 47 and 111 | 0 |

The previous port fused every product. `conv_boundary.rs` also keeps, as negative
controls, the rule rejected by the first held-out file (398 parts of its 129-tap
course) and the previous model (the counts above).

**Outside the rule.** The 3-, 5- and 8-tap courses of the second recording (13,851
parts the previous short-kernel path missed) were discovery for the short-kernel
rule, which the third recording held out. The dense complex control (60% nonzero)
matches the port's dense path. Kernels as long as the course (where MATLAB slides
the course over the kernel) are not covered.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-conv-boundary" packages/samsrf/validation/matlab/conv-boundary-reference.json
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-conv-blocks" packages/samsrf/validation/matlab/conv-blocks-reference.json
SAMSRF_CONV_BOUNDARY_DIR="$TMPDIR/samsrf-conv-boundary" SAMSRF_CONV_BLOCKS_DIR="$TMPDIR/samsrf-conv-blocks" \
  cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test conv_boundary -- --nocapture
```

### Remaining gaps (#730)

[`conv-gaps-predictions.md`](conv-gaps-predictions.md) pre-registered three
questions, each in its own file, before `record_conv_gaps.m` ran.
`conv-gaps-reference.json` pins
[run 43697799526](https://github.com/neurodesk/webapps/actions/runs/43697799526)
(recorder commit `b62621d4f0fa6137e5b199b7d97c9d2c05ca0494`) on two AMD hosts: an
EPYC 7763 (`ubuntu-22.04`) and an EPYC 9V74 (`ubuntu-24.04`), both CNR `auto`. Each
recorded twice with identical repeats, and both recorded identical arrays (294).
The boundary and short-kernel inputs come from a Park-Miller stream that
[`conv_gaps_design.py`](conv_gaps_design.py) and `conv_gaps.rs` regenerate; every
candidate was evaluated on them before the run.

- **A, AMD replay.** The 12 held-out courses of the second recording, regenerated
  with its generator: on both AMD hosts all 72 arrays (inputs and outputs) equal
  that recording's Intel arrays byte for byte, and the port reproduces every kept
  part.
- **B, threshold and block length.** The frozen threshold holds: courses with full
  outputs of 1,023 and 1,024 complex elements (33 and 17 taps) and 2,048 real
  elements show no boundaries, 1,025 and 2,049 do; each competing threshold misses
  59-164 parts where the design predicted. The frozen block form at exactly 8 blocks
  (keep P when f = 8P) is **rejected**: on the deciding course (complex, f = 4,096,
  33 taps) it misses 434 parts and on both confirming courses (complex 65 taps,
  411; real f = 8,192, 251), while doubling the block there misses none. Production
  doubles it since this recording; on every other recorded course the two forms
  agree.
- **C, kernels of 2-8 taps.** On 12 held-out sparse courses (2, 4, 5, 6 and 7 taps;
  40-2,500 samples, complex and real, including SamSrf-sized courses of 250-400
  samples) every product after the first is rounded and then added in input order,
  as the second recording's discovery courses showed. The same unfused products
  in kernel order miss 74-1,393 parts and the previous path (kernel order, fused)
  16-3,766. The two dense controls follow the previous path, which production
  keeps for dense courses. Production follows the rule for sparse courses since
  this recording.

| Courses (third recording) | Previous port misses | Now |
| --- | --- | --- |
| A, replay (12) | 0 | 0 |
| B, boundary (23) | 434 + 411 + 251 at f = 8P | 0 |
| C, short kernels, sparse (12) / dense (2) | 16-3,766 per course / 0 | 0 / 0 |

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-conv-gaps" packages/samsrf/validation/matlab/conv-gaps-reference.json
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-conv-blocks" packages/samsrf/validation/matlab/conv-blocks-reference.json
SAMSRF_CONV_GAPS_DIR="$TMPDIR/samsrf-conv-gaps" SAMSRF_CONV_BLOCKS_DIR="$TMPDIR/samsrf-conv-blocks" \
  cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test conv_gaps -- --nocapture
```

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

### Compiler access, checked 2026-11-10, 2026-11-12 and 2026-11-16

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
| Institutional license server, checked 2026-11-16 | The user authorised a network license server at their institution, given as `SERVER <host> ANY 27000` and `USE_SERVER` and kept in an untracked file outside the repository. In a `SERVER` line, `ANY` is the host ID field and 27000 the license manager's port. The file has no `DAEMON` (vendor) line, so it does not state the MathWorks vendor daemon's port; MathWorks documents fixing that port with `port=` on the `DAEMON` line of the server's license file. From this repository's cloud build host the name resolves to a private 10.x address, TCP 27000 timed out twice, and MATLAB 23.2.0.3097123 stopped with License Manager Error -15 (`-15,570`, system error 115, `Feature: MATLAB`) before any product check. A GitHub Actions runner linked to that network reaches TCP 27000; a separate maintainer worker on that route is installing R2023b Update 11 to check a MATLAB Compiler checkout before building. MATLAB Compiler entitlement and the vendor daemon's reachability are not yet observed. |
| MATLAB Runtime | Free, and not a compiler. The [R2023b Update 11 installer](https://ssd.mathworks.com/supportfiles/downloads/R2023b/Release/11/deployment_files/installer/complete/glnxa64/MATLAB_Runtime_R2023b_Update_11_glnxa64.zip) (4,834,714,979 bytes) is public. `containers.mathworks.com/matlab-runtime` has `r2023b-update-1` to `-9` tags and a moving `r2023b` tag. The Runtime executes a compiled archive; it cannot build one. |

Building therefore needs a MATLAB Compiler license for R2023b Update 11, as a
batch token for the `build` dispatch, or as a license for one Linux host. That
host can be this kind of machine, using `licensed-host/`. With the institutional
server above, it must also be able to reach that server.

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

### Operator handoff for a licensed host

For someone who holds a MATLAB Compiler license for R2023b Update 11 on a
Linux x86-64 host with Docker. Nothing here needs the repository's secrets, and
the license never leaves that host.

Needs: Docker with access to `/var/run/docker.sock`, disk for MATLAB (9.8 GB), the
Runtime images and the work directory, network
access to GitHub, Hugging Face and `mathworks/matlab-deps`, Python 3, git, and
a checkout of this repository at the commit to be validated.

```sh
# 1. MATLAB R2023b Update 11, installed with mpm inside the builder's base image.
export WORK="$TMPDIR/samsrf-compiled"           # must not exist yet
export MATLAB_ROOT="$TMPDIR/matlab-r2023bu11"
mpm install --release=R2023bU11 --destination="$MATLAB_ROOT" \
  --products MATLAB MATLAB_Compiler Statistics_and_Machine_Learning_Toolbox \
  Image_Processing_Toolbox Parallel_Computing_Toolbox
# 2. Build and run every gate on this host; the driver stops at the first failure.
packages/samsrf/validation/matlab/licensed-host/build_and_validate.sh \
  "$WORK" /path/to/license.lic "$MATLAB_ROOT"   # or PORT@HOST
```

The run passed only if its last lines are `All gates passed on this host for
local image sha256:...` and `Evidence: .../samsrf-cli`. In `$WORK/samsrf-cli`:

| File | Must show |
| --- | --- |
| `container-build/source.json`, `provenance/source.json` | The pinned SamSrf and SPM commits and the five CLI repair hashes. |
| `container-build/image.json` | The local image ID that the last line names. |
| `source-repeat.json` | Source MATLAB repeated bit for bit (24 runs). |
| `compiled-vs-source.json` | Compiled equals source MATLAB bit for bit on this host (24 runs). |
| `compiled-repeat.json` | The compiled image repeated bit for bit. |
| `compiled-1/receipts`, `compiled-2/receipts` | No network, read-only inputs, the image ID, input hashes unchanged. |
| `interrupt/`, `failure/` | A prompt nonzero exit on SIGINT, and on a missing model. |
| `web-1/`, `web-1-vs-source.json`, `web-1-vs-compiled.json` | The web engine (Node) on the same bundle, held against both executions on this host ([web engine against the CLI matrix](#web-engine-against-the-cli-matrix)). It lists exact, differing, refused and unsupported runs; the driver fails on inventory errors and failed runs, not on differing values. The Chromium run is a separate step on the returned evidence. |

The archive keeps `bundle/` (11 MB) because the web engine and the maintainers'
browser run read those exact input bytes.

Return two files and their SHA-256 through whatever channel the maintainers
name, never with the license:

```sh
tar -C "$WORK" -czf samsrf-cli-evidence.tar.gz samsrf-cli
docker save samsrf-reference:41ed1e96-r2023b | gzip > samsrf-reference-41ed1e96-r2023b.tar.gz
sha256sum samsrf-cli-evidence.tar.gz samsrf-reference-41ed1e96-r2023b.tar.gz
```

A failed run is evidence too: return the evidence archive and the console log,
from which the failing gate is clear (the driver stops at it).

The maintainers then load the image, check that its ID equals
`container-build/image.json`, push it to `ghcr.io/neurodesk/samsrf-reference`,
record its digest beside `cli-reference.json`, and dispatch `samsrf-native`
with `runtime_image=ghcr.io/neurodesk/samsrf-reference@sha256:...` for the
Runtime-only check on other hosts. That last step needs no license.

Checked without a license on 2026-11-13, and again on 2026-11-16 with
`test_web_cli.py`: all 62 harness tests in this directory pass (Python 3.12
with `requirements-cli.txt`, none skipped), and the driver refuses a MATLAB root other than
23.2.0.3097123 and an existing work directory before it does anything.

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

### Web engine against the CLI matrix

`run_web_matrix.mjs` runs the 24 `cli_plan.py` runs through the web app's
WebAssembly module (Node, one thread) on the read-only bundle, after checking
that the bundle's file tree equals `bundle-sha256.json`. Its entry check follows
symbolic links, so a checkout reached through a linked path runs instead of
exiting silently.

`run_browser_matrix.mjs` runs the same runs in Chromium (Playwright 1.64.0, a
devDependency of this package) through the app's own `apps/samsrf/src/engine.js`
(`createJob`, `runShard`, `mergeShards`), from the bundle's file bytes as the
app reads dropped files. This is an engine-module harness served from source:
it does not exercise the production Vite bundle or the app's interface.
`mergeShards` rounds the maps to float32 for display, so the runner merges the
same shard bytes once more to keep the double rows (`maps.f64`). The GIfTIs
exported from that merge must equal the files `mergeShards` exported, byte for
byte (`replayEqualsExport`), or the run fails.

Both runners write one layout: per run the record (`files`, ROI, labels,
vertex count, `mapsSha256`), the exported GIfTIs and `maps.f64`, plus an
environment that names the runner and the SHA-256 of the plan file, the bundle
manifest and the WebAssembly module.

Each run's model is the CLI model plus `Data_Precision`, which carries the
precision that `def_64bit` selects for MATLAB, and, for forward models,
`Css_Convention: "samsrf"`: SamSrf always takes complex CSS powers, while the
engine's default clips negative responses. Bundle paths replace `/input`,
and CF reads the Benson GIfTI that `prepare_cli_bundle.m` converted into the
per-precision `.mat`. The Node runner passes the subject-HRF file to the engine
API as a kernel (`hrf.oldSchool` of the file's `fP`). The app's interface has no
subject-HRF route, so the browser runner records those four runs as
`unsupported`.

```sh
compare_web_cli.py PLAN BUNDLE_SHA256 WEB_ROOT MATLAB_ROOT REPORT \
  --expect source|compiled-runtime [--allow-unattested-source-inputs]
```

`compare_web_cli.py` holds one web execution against one MATLAB execution.
Which MATLAB execution it is comes from its receipts, not from the caller, and
`--expect` must agree with them. It refuses before reading any value when:

- the plan is not `cli_plan.py`'s matrix, is empty or repeats a run;
- a plan model is not the bundle manifest's model file;
- the web execution names another plan or bundle manifest;
- a MATLAB receipt is missing, extra, of another execution kind, or ran
  another argv;
- a compiled execution lacks an image ID (`sha256:...`), or its
  `receipts/inputs.json` differs from the manifest.

Source receipts do not record the bundle. A source comparison therefore needs
`--allow-unattested-source-inputs`, and its report says the inputs are
unattested.

For each run that succeeded on both sides, every map in the run's contract
(`compare_cli.expected_results`) is compared bitwise twice:

- MATLAB's `Srf.Data` column over `Srf.Roi`, against the web value cast to
  MATLAB's class. The cast must be exact.
- The exported GIfTI over every vertex.

Before that comparison, the run's inventory must hold, or the run is an
`inventory-error`:

- `Srf.Roi` must be unique, finite integers in 1..vertices, one per row, and in
  the same order as the web ROI;
- both GIfTIs must hold one float32 array over every vertex;
- `maps.f64` must have exactly 8 x maps x vertices bytes and match its hash;
- the labels and the files on each side must match the contract.

Where `Srf.Data` is complex (SamSrf's CSS powers of a negative response), its
imaginary parts are compared bitwise with the engine's, which the runners write
to `maps.imag.f64` from `Job.merge`'s `imaginary` (a run without that file has
+0 imaginary parts). A map is `exact` only if all of these agree bit for bit,
including nonfinite values and the sign of zero. Otherwise it `differs`. The
report then gives the differing vertices, how many differ only in the sign of
zero, the largest absolute, relative and ULP differences, and whether the masks
agree. ULPs count +0 and -0 as one ordinal,
so the smallest subnormals of opposite sign are 2 apart; `signedZeroOnly`
counts the sign-of-zero differences.

A run is `refused` only where the engine is expected to refuse (single RC with
a fitted profile, single CF Gaussian), and `unsupported` only for the browser's
subject-HRF runs, in both cases with MATLAB succeeding. Any other combination
is `failed`, with both sides' statuses kept. The polar angle and eccentricity
GIfTIs that the web exports and SamSrfAnalysis does not are checked for shape
and listed as not compared. MATLAB-only files are listed the same way. No
tolerance is applied. Failed and inventory-error runs exit nonzero.

`test_web_cli.py` (31 tests) builds full-provenance fixtures and covers each
refusal and inventory rule with a negative control:

- one ULP that the float32 GIfTI hides, a signed zero, a NaN and an imaginary
  part; equal imaginary parts, one ULP or a signed zero in one, a web run
  without them, and a damaged, extra or unrecorded `maps.imag.f64`;
- ULPs across zero in both precisions;
- a MATLAB failure behind a web refusal, and unexpected web statuses;
- an extra `maps.f64` byte, a duplicate, zero, out-of-range or fractional ROI,
  empty and one-vertex GIfTIs, and corrupt or extra files;
- a stale plan or bundle hash and a model changed to TR 999;
- source receipts presented as compiled, and malformed compiled receipts.

Eight comparator mutations (the earlier ULP mapping, the ROI, argv, kind and
GIfTI-length checks, MATLAB failures and truncation) each fail the suite.

The pull-request tests hold the committed module to one MATLAB execution:
`run_web_matrix.mjs` on the pinned source recording (run 42928350417),
`compare_web_cli.py` against its AMD host, then `web_cli_outcome.py check`
against `web-cli-outcome.json`. That file names the host and, for each run, its
class and, for each map, `exact` or the number of values that differ in
`Srf.Data`, in its imaginary parts and in the GIfTI. Any change, better or worse,
fails until `web_cli_outcome.py freeze` rewrites the file, so its diff shows what
moved. This is agreement with source MATLAB on one AMD host, not compiled-image
parity.

The `runtime_cli` and `runtime_image` jobs run both runners and the comparator
against every MATLAB execution they make. The build job runs them after
publication, so a web difference never blocks a validated image.
`licensed-host/build_and_validate.sh` runs the Node runner offline in a pinned
image. Its Chromium run is an open gate: it needs this repository's pnpm
install, and the maintainers run it on the returned evidence:

```sh
pnpm install --frozen-lockfile --filter @neurodesk/samsrf
pnpm --filter @neurodesk/samsrf exec playwright install chromium
m=packages/samsrf/validation/matlab; e=samsrf-cli   # the extracted evidence
node $m/run_browser_matrix.mjs $e/plan.json $e/bundle $e/bundle-sha256.json $e/browser-1
python3 $m/compare_web_cli.py $e/plan.json $e/bundle-sha256.json $e/browser-1 $e/compiled-1 \
  browser-1-vs-compiled.json --expect compiled-runtime
```

**Interim result against source MATLAB (not the compiled image).** The pinned
source recording ([run 42928350417](#pinned-source-recording)) was compared on
2026-11-16. The web engine was package 0.6.20261115 with WASM SHA-256
`f069b06b0473a4538353063b5acda52c8da4351e812ed870e6dc177132a90f9f`, run on an
AMD EPYC-Milan host, under Node 24.19.0 and in `node@sha256:7702d8aa…` (Node
22.23.4), and in Chromium 156.0.8078.4. The two Node runs gave identical
`maps.f64` and GIfTIs. The strict comparator was rerun on fresh runs, each on
the bundle of the host it is compared with (the hosts' bundles differ only in
MAT-file timestamps), with the source inputs reported as unattested.

On both bundles, Chromium (through the app's engine, with the replayed merge
equal to the export) gave the same `maps.f64` and all 176 GIfTIs byte for byte
for its 18 succeeded runs. Not compared: the polar angle and eccentricity
GIfTIs that the web exports and SamSrfAnalysis does not, 44 files in Node and
36 in the browser. Each cell gives the maps that are exact:

| Run | Node vs AMD | Browser vs AMD | Node vs Intel | Browser vs Intel |
| --- | --- | --- | --- | --- |
| `prf_gaussian_lh_average_double` | 0/8 | 0/8 | 0/8 | 0/8 |
| `prf_gaussian_lh_average_single` | 6/8 | 6/8 | 1/8 | 1/8 |
| `prf_gaussian_lh_concatenate_double` | 0/6 | 0/6 | 0/6 | 0/6 |
| `prf_gaussian_lh_concatenate_single` | 6/6 | 6/6 | 0/6 | 0/6 |
| `prf_gaussian_rh_double` | 0/6 | 0/6 | 0/6 | 0/6 |
| `prf_gaussian_rh_single` | 6/6 | 6/6 | 0/6 | 0/6 |
| `prf_css_lh_double` | 0/9 | 0/9 | 0/9 | 0/9 |
| `prf_css_lh_single` | 1/9 | 1/9 | 1/9 | 1/9 |
| `prf_custom_hrf_lh_double` | 0/8 | unsupported | 3/8 | unsupported |
| `prf_custom_hrf_lh_single` | 8/8 | unsupported | 1/8 | unsupported |
| `rc_hull_lh_double` | 0/6 | 0/6 | 0/6 | 0/6 |
| `rc_hull_lh_single` | 6/6 | 6/6 | 4/6 | 4/6 |
| `rc_gaussian_lh_double` | 0/7 | 0/7 | 0/7 | 0/7 |
| `rc_gaussian_lh_single` | refused | refused | refused | refused |
| `rc_custom_hrf_lh_double` | 0/6 | unsupported | 0/6 | unsupported |
| `rc_custom_hrf_lh_single` | 6/6 | unsupported | 4/6 | unsupported |
| `cf_hull_lh_double` | 4/10 | 4/10 | 4/10 | 4/10 |
| `cf_hull_lh_single` | 8/10 | 8/10 | 5/10 | 5/10 |
| `cf_summary_lh_double` | 5/7 | 5/7 | 5/7 | 5/7 |
| `cf_summary_lh_single` | 7/7 | 7/7 | 6/7 | 6/7 |
| `cf_gaussian_lh_double` | 2/9 | 2/9 | 2/9 | 2/9 |
| `cf_gaussian_lh_single` | refused | refused | refused | refused |
| `cf_hull_smooth_global_lh_double` | 4/10 | 4/10 | 4/10 | 4/10 |
| `cf_hull_smooth_global_lh_single` | 8/10 | 8/10 | 5/10 | 5/10 |

Totals against the AMD host: Node 6 of 24 runs and 77 of 168 maps exact;
browser 4 runs and 63 of 140 maps exact, with 4 runs unsupported. Against the
Intel host: no run exact; 45 of 168 and 37 of 140 maps exact. The single
reverse-correlation Gaussian and single CF Gaussian runs are the public
refusals (#729).

What the differences are (AMD host):

- **Double preprocessing.** This is the earliest divergence. MATLAB's double
  `Srf.Y` (detrended and z-scored courses over the ROI) differs from the
  engine's in 4,985 of 5,250 samples (`prf_gaussian_lh_average_double`) and in
  5,161 of 5,250 on the one-run right hemisphere, by at most 1.2e-14. The two
  MATLAB hosts differ from each other in 5,051 and 5,165 samples. The engine
  matches neither; it differs from the Intel host in 5,101 and 5,209 samples.
  Single `Srf.Y` is identical to the engine's. Every double noise ceiling then
  differs at all 18 vertices, by up to 2,250 ULP (2.6e-13 relative), and the
  double R², Beta, Baseline and reverse-correlation maps differ in the last
  bits. Fits that land on another optimum differ by more: one or two vertices
  in each double Gaussian pRF, one vertex of `prf_custom_hrf_lh_double`, and
  the 11 diverged vertices of `cf_gaussian_lh_double`.
- **CSS from SamSrfAnalysis.** MATLAB saves a complex `Srf.Data` in both
  precisions. Single CSS differs at 12 to 13 of 21 vertices and double CSS at
  14 to 15, by up to 1.8 in x0. The zero masks of single CSS disagree. (Since
  resolved on the AMD host: [CSS through SamSrfAnalysis](#css-through-samsrfanalysis).)
- **Single forward fits.** `prf_gaussian_lh_average_single` differs at one
  vertex in Beta (1 ULP) and Baseline (5 ULP); its other maps are exact.
- **Signed zeros.** The `cf_hull` x0 and y0 maps, and Sigma, Beta and Baseline
  at the 11 rejected vertices of `rc_gaussian_lh_double`, differ only in the
  sign of zero.

These comparisons are with source MATLAB. They are not compiled-image parity,
which needs the build.

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

General double-precision fine-fit plateaus (diagnosed in
[Double forward fine fits](#double-forward-fine-fits-730)) and the
remaining double CSS fits are diagnostic cases in this comparator; single reverse-correlation and CF
arithmetic is gated separately (`revcor_reference.rs`, below). Every map value
of the recorded single CSS pipeline, Beta and Baseline included, now equals
MATLAB's; the gate keeps its per-value least-squares tolerance for coefficients.
A successful source gate does not assert the diagnostic paths, arbitrary-input
parity, or a rebuilt container.

## Double detrend and z-score

#866's web-versus-SamSrfAnalysis comparison found the earliest difference of the
double pipelines in `samsrf_gii2srf`'s preprocessing: up to 1.2e-14 in 95% of the
values of `Srf.Y`. It is reproduced from the pinned SamSrfAnalysis recording
(`cli-reference.json`, run 42928350417; AMD EPYC 9V74 with MKL CNR `auto`, Intel
Xeon Platinum 8573C with `AVX512_E1`). MATLAB R2023b converts every run to double,
then for each run:

- `detrend(Data)` subtracts `a * (a \\ Data)` with `a = [linspace(0,1,n)' ones]`
  (the column order is immaterial: pivoting takes the ones column first). The
  solve is one QR for every vertex of the run, and MKL's `?ormqr` rounds each
  vertex by its place among them (`lstsq::DoubleDesign`). The fit is `a1*c1 +
  a2*c2` with each product rounded. Searched over seven time scalings, both
  column orders, one solve per vertex or one for all, five residual orders and
  two `zscore` forms, only this combination reproduces the courses (5,250 of
  5,250 on one case; the port before matched 227).
- `zscore` with MATLAB's `mean` and `sum`.
- `nanmean(Data, 3)` sums the runs in order. The port used to sum odd and even
  runs separately when the noise ceiling was wanted, a last-bit difference in
  2,124 of 5,250 averaged values.

`cli_preprocess.rs` drives `RunAccumulator` on the recording's own GIfTI runs
and compares `Srf.Y`, which `extract_cli_courses.py` writes from the MAT files.
On the AMD host every double and single value of the 22 runs whose `Srf.Y` is
this stage's output equals MATLAB's (168,000 of 168,000; 86,876 before). The two
connective-field runs with global-signal correction and smoothing save `Srf.Y`
after `samsrf_removenoise` and smoothing and are counted, not compared. On the
Intel host 88,033 of 168,000 are identical: its MKL orders the double solve
differently, and AMD and Intel MATLAB themselves differ in 5,051 of 5,165
values, so one output cannot equal both. Constant, ramp and near-constant raw
courses, one- and two-sample courses and runs of 134,257-134,259 vertices (every
leftover position) were recorded later (`constants-gamma-gemv-predictions.md`,
run 43882331042): on the AMD host the port matches every recorded selected
course value and noise ceiling. A constant non-zero course can become unit-variance
noise when QR leaves a varying residual; other recorded constants remain zero
with NaN ceilings. Direct arithmetic was tested in double at lengths 1, 2, 3, 37
and 250; the full pipeline was tested in both precisions at 250 samples. All-zero
courses stay zero. That run's global signal (`nanmean(Srf.Data, 2)` over every
vertex) matched in 15 of 2,000 values; its across-vertex order is not MATLAB's.

With the courses exact, the Node package API using the committed WASM was
compared against the AMD source execution of the 24-run matrix. The copied
`run_web_matrix.mjs` and `compare_web_cli.py` match #866 at `dd36baa32`.
Recomparison with the corrected comparator at `d12064c9a` preserves the final
11-run, 119-map result. This is not a browser or production UI comparison;
the Node runner also accepts custom HRFs unavailable through the app interface.

| Change | Exact runs | Exact maps (of 168) |
| --- | --- | --- |
| `main` (#866's report) | 6 | 77 |
| detrend, z-score, run order | 6 | 93 |
| `corr` order for the noise ceiling | 6 | 105 |
| MATLAB `conv` for every HRF convolution | 11 | 115 |
| one QR for double RC profiles, `corr` order for RC `R^2` | 11 | 119 |
| MATLAB's double `corr(Y, X)` for CF profiles (`lstsq::gemv_t_double`, run 43890832220's module `d5ae6ba2`; Intel 0 runs, 42 maps) | 13 | 129 |
| `Css_Convention: "samsrf"` for forward models and MATLAB's complex `Srf.Data` (`imaginary`, [below](#css-through-samsrfanalysis); Intel 0 runs, 46 maps) | 15 | 145 |

The two refused single fits stay refused. What still differs, earliest stage first:

- double convex-hull RC centroids: from MATLAB's own profile, `x0` and `y0` of
  `polyshape.centroid` differ by 1-3 ULP (one by 38 ULP); areas are exact.
  This is geometry (#732).
- double RC Gaussian fits: `samsrf_fit2dprf`'s `errfun` (`sum(Ds(:).^2)`) and
  `R^2` now use the modelled MATLAB `sum` and `mean` orders in the double port.
  The fits still differ in the last bits (R^2 and x0 at 9 accepted vertices, y0
  at 6); the first optimizer divergence requires a MATLAB trace to locate. The
  11 rejected vertices hold MATLAB's NaN, whose sign bit the engine does not
  reproduce. The double CF Gaussian run equals MATLAB's since the double CF
  profiles below.
- double CF profiles: fixed since by `lstsq::gemv_t_double` (FPRev recording
  `constants-gamma-gemv-reference.json`): full blocks of four columns use two
  lanes, and the remaining columns the right-hand-side trees `?ormqr` uses at
  their position. Every unsmoothed double CF profile of the pinned
  reverse-correlation recordings equals MATLAB's on its AMD hosts (26 cases,
  4,914 values; `double_cf_profiles_equal_matlab_on_amd_hosts`).
- double global-signal regression (`samsrf_removenoise`) still solves normal
  equations, where MATLAB solves `[X ones] \\ Y`.
- every Intel host.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-cli" packages/samsrf/validation/matlab/cli-reference.json
python3 -I packages/samsrf/validation/matlab/extract_cli_courses.py "$TMPDIR/samsrf-cli" "$TMPDIR/samsrf-cli-courses"
SAMSRF_CLI_REFERENCE_DIR="$TMPDIR/samsrf-cli" SAMSRF_CLI_COURSES_DIR="$TMPDIR/samsrf-cli-courses" \
  cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test cli_preprocess -- --nocapture
```

### CSS through SamSrfAnalysis

The two CSS runs (`prf_css_lh_double`, `prf_css_lh_single`) differed at 12 to 15
of 21 vertices in every map but the noise ceiling, by up to 1.8 in x0. The first
stage that differs is the power itself. The bars apertures (`aps_bars_vec`) hold
36,203 negative values (down to -0.074, from their interpolation), so some
predicted responses are negative. SamSrf raises them to the fitted exponent as
complex numbers, which makes the objective, the fit and the betas complex, and it
saves R^2, nR^2, Beta and Baseline with their imaginary parts. The runners passed
the CLI model unchanged, so the engine used its default `Css_Convention`,
`nonnegative`, which clips negative responses first. With `Css_Convention:
"samsrf"`, the real part of every map equals MATLAB's on the AMD host, at every
vertex in both precisions.

The imaginary parts were then the only difference. The engine computed them but
kept only the real parts. `Job.merge` now returns them (`imaginary`), and they
equal MATLAB's bit for bit, zero signs included. A rejected fit is `0 + 0i`. At
the four vertices whose noise ceiling is negative, MATLAB's nR^2 is `-0 + 0i`.
Dividing the zeroed R^2 by the ceiling gives its real part the quotient's sign,
while the zero imaginary part stays `+0`. Every nonzero part is the plain
quotient. A zero real part with a nonzero imaginary part was not recorded. The
exported GIfTIs keep only real parts, as `samsrf_expand_srf` does, and equal
MATLAB's. Chromium gives the same bytes as Node. The engine's default convention
is unchanged; the runners now declare SamSrf's, as they declare `Data_Precision`.

The Intel host still differs. There the double fits reach MATLAB's x0, y0, Sigma
and Exponent, but R^2, Beta and Baseline differ in its MKL's last bits, and the
single fits differ at 10 to 14 vertices.

## Double forward fine fits (#730)

The 741-case pin, recorded on an AMD host (MKL CNR `auto`), holds nine double
forward (non-CSS) Gaussian pipelines that `compare.mjs` does not compare: the
coarse and fine fits of X001 LH (averaged and concatenated) and RH and of the
analyzePRF participant, and the thresholds case. `double_forward_diagnostics.rs`
runs each natively from MATLAB's preprocessed courses. Since 0.6.20261114 it is a
gate (the file kept its name):

- x0, y0, Sigma and the noise ceiling equal MATLAB's bit for bit at every vertex
  of every case, so every keep and reject decision is MATLAB's. With fine fits,
  R² and nR² do too.
- Every map's zero and NaN masks equal MATLAB's.
- Beta, Baseline and the coarse-only cases' R² and nR² stay within
  `1e-12 * max(1, abs(MATLAB value))`; infinities fail. This ceiling is for these
  recordings, not a general error bound.
- `HISTORICAL` lists the 14 case/vertex entries that differed before (below); each
  is now among the exact vertices.

No map is gated by a count of differing vertices: it is exact everywhere or held
to the ceiling everywhere. Measured on the pin (`SAMSRF_DOUBLE_FORWARD_REPORT`):

| Case | Vertices | Volumes | Kept fine fits | Beta bit-different | Baseline bit-different | R² bit-different |
| --- | --- | --- | --- | --- | --- | --- |
| LH averaged, coarse | 96 | 250 | — | 69 | 72 | 82 (≤ 1.9e-15) |
| LH averaged, fine | 96 | 250 | 59 | 37 | 47 | 0 |
| thresholds (LH averaged, fine) | 96 | 250 | 32 | 20 | 27 | 0 |
| LH concatenated, coarse | 96 | 1500 | — | 69 | 87 | 88 (≤ 3.1e-15) |
| LH concatenated, fine | 96 | 1500 | 49 | 33 | 45 | 0 |
| RH averaged, coarse | 76 | 250 | — | 51 | 60 | 72 (≤ 1.1e-15) |
| RH averaged, fine | 76 | 250 | 40 | 19 | 30 | 0 |
| analyzePRF, coarse (downsampling 2) | 10 | 600 | — | 9 | 9 | 10 (≤ 1.2e-15) |
| analyzePRF, fine (downsampling 2) | 10 | 600 | 9 | 6 | 8 | 0 |

Beta and Baseline differ by at most 1.2e-15 and 3.2e-14 relative. They remain
because the export still solves them on a prediction convolved with plain sums,
and the coarse fit's R² comes from the search grid's plain correlation; neither
is the objective, and this change leaves both alone.

### MATLAB's optimizer, evaluation by evaluation

The pin also records MATLAB's `fminsearch` runs of the double non-CSS objective
(`kind: "fit"`): every evaluated parameter vector and objective value of 20 fits
with SamSrf's HRF, 6 with a custom HRF kernel and 6 that fit the HRF with the pRF.
`double_objective_follows_matlabs_fminsearch_evaluation_by_evaluation` replays all
32 fits through the port's `fminsearch` and requires MATLAB's number of
evaluations and the bits of every parameter vector, objective value and endpoint:
12,604 evaluations. With the plain-sum objective, only 272 of the 3,186
fixed-kernel objective values equalled MATLAB's at MATLAB's own parameters. The
six fitted-HRF fits joined the gate in 0.6.20261114, after their kernel was traced
to `gampdf`'s normaliser ([fitted-HRF kernels](#fitted-hrf-kernels-730)); before,
they first diverged after 15 to 35 identical evaluations.

### Why the operation order removes the divergence

`prf_errfun` builds the prediction, convolves it with the HRF
(`prf_convolve_hrf`, MATLAB's `conv`), correlates it with the data (`corr`) and
returns `1 - R^2`; with CSS it first raises the prediction to the exponent, and
nothing else changes. The port's CSS objective already followed MATLAB's `conv`
and `corr` operation orders (`matlab_math::convolve_real`, `css::objective`,
108 CSS optimizer traces bit for bit). Its double non-CSS objective did not: it
convolved with a plain sequential sum and correlated with `pearson`. The fix
routes that one branch through the same two functions; at exponent 1 the CSS
objective and the non-CSS objective are now the same bits by construction
(`double_objective_without_css_is_the_css_objective_at_exponent_one`).

`fminsearch` is deterministic: from the same seed, the same objective bits at
every evaluation give the same simplex steps and the same endpoint. Two
differences broke that:

1. **Summation order.** At the kept fine fits' endpoints the two orders give
   predictions up to 2.6e-13 apart (relative) and objectives up to 4e-15 apart;
   the objective differed at 152 of the 189 kept fine fits (one of them NaN,
   below). On the near-flat
   objectives of sub-pixel Sigma (0.005 to 0.041, against the grid's smallest
   1.19), such last-bit differences decide simplex comparisons, so the search
   took other steps and ended elsewhere on the plateau, or on the other side of
   Sigma = 0, which `samsrf_fit_prf` rejects.
2. **Underflow (the former different optimum, RH vertex 75).** MATLAB's
   endpoint, Sigma 0.064 at the edge of the field, predicts a time course whose
   largest value is 4.3e-317, a subnormal number. `pearson` squares its deviations, which underflow to
   zero, and returns NaN; `corr`'s `nrm2` rescales before squaring and gives
   MATLAB's R² 0.043. With NaN there, the port's search could not follow
   MATLAB's into that region and ended elsewhere (R² 0.44).

What this shows: on these recordings, with this objective, the port evaluates
what MATLAB evaluates. What it does not show: MATLAB's internal `conv` and `corr`
algorithms. `convolve_real`, `ddot` and `nrm2` are empirical models checked on
recorded inputs on AMD hosts
([Double CSS arithmetic](#double-css-arithmetic), [arithmetic order](#arithmetic-order-729-730)).
MKL's Intel AVX-512 branch sums `x'*y` of 51 or more elements in another tree,
and Intel `corr` differs at shorter lengths too, so this agreement is not
claimed for Intel hosts. These nine pipelines and the optimizer traces were
recorded once, on one AMD host; MATLAB's repeats of them on other hosts were not
recorded. Agreement covers these recordings: Gaussian pRFs with Nelder-Mead
fine fits, fixed kernels, downsampling 1 and 2. Hooke-Jeeves fine fits of the
double non-CSS objective and other pRF functions have no MATLAB recording.

Run time, same data and method: natively and single-threaded on one 8-core x86
machine, `Job::run` on the five fine-fit pipelines took 66.3 s against 55.9 s
with the previous objective (median of three runs each, +19 %; +12 % to +23 %
per case); the coarse-only cases are unaffected. The searches also make
different numbers of evaluations, so this is not the cost of one evaluation,
and other machines, WebAssembly and other inputs will differ.

### Before 0.6.20261114 (historical diagnosis)

The previous objective left 14 case/vertex entries differing. Vertex numbers are
zero-based fixture positions; a vertex in two pipelines counts twice.

| Case | Plateau (vertices) | Acceptance (vertices) | Different optimum (vertices) |
| --- | --- | --- | --- |
| LH averaged, fine | 4 | 2 | |
| thresholds (LH averaged, fine) | 4 | 2 | |
| LH concatenated, fine | 2, 4, 23 | 81 | |
| RH averaged, fine | 17, 46 | 29, 58 | 75 |
| analyzePRF, fine | 6 | | |

- **Plateau:** both kept a fit, at different parameters, with R² within 1e-9;
  the old objective was the same at both endpoints to 3e-11 relative or better.
- **Acceptance:** one side kept the fit and the other zeroed it (four times the
  port kept a fit MATLAB rejected, once the reverse at vertex 58).
- **Different optimum (vertex 75):** both kept a fit, with R² 0.043 (MATLAB) and
  0.44 (port).

Every other vertex already had MATLAB's parameter bits, with R² within 1e-12.

```sh
SAMSRF_MATLAB_REFERENCE_DIR="$TMPDIR/samsrf-reference" SAMSRF_DOUBLE_FORWARD_REPORT="$TMPDIR/double-forward.json" \
  cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test double_forward_diagnostics
```

## Fitted-HRF kernels (#730)

Fitting the HRF with the pRF (`Hrf = -1`) makes `prf_errfun` build a kernel
from the last five parameters at every evaluation:
`samsrf_doublegamma(1, P(end-4:end))`, that is
`gampdf(T, P1/P3, P3) - gampdf(T, P2/P4, P4) / P5` on `T = 0:32`. The pin's six
such fits (`fit_double_fitted_hrf`, 9,418 evaluations) first diverged from
MATLAB after 15 to 35 identical evaluations, while every fixed-kernel fit
matched. The design and competing predictions were committed before the
recording ([fitted-hrf-predictions.md](fitted-hrf-predictions.md), `dc41f25b`).

`record_fitted_hrf.m` ([run 43590490083](https://github.com/neurodesk/webapps/actions/runs/43590490083),
recorder `be136fdf`) replays every evaluation at the pinned parameters on an AMD
EPYC 7763 (`ubuntu-22.04`, MKL CNR `auto`, the same CPU model as the 741-case
pin) and an Intel Xeon Platinum 8573C (`ubuntu-24.04`, `AVX512_E1`), each twice
in fresh MATLAB processes with identical results. It records `samsrf_doublegamma`'s
stages, MATLAB's `gampdf` as a vector and per sample, the port's `gampdf`
algorithm evaluated by MATLAB with MATLAB's `log`, `exp` and `gammaln`,
`prf_errfun`'s `err`, `prf_errfun`'s stages around each first divergence, and
200 generated held-out shape and scale pairs. `fitted-hrf-reference.json` pins
the pack (HF commit `87189e75`, SHA-256 `020e6f8c…4491`, 181,111,493 bytes;
`run.json` lists all 1,624 files with SHA-256 and byte counts).

| Prediction | Outcome |
| --- | --- |
| H0, the trace is not reproducible | Refuted: on the AMD host MATLAB's `err` equals the pinned trace at all 9,418 evaluations, and repeats are identical. The Intel host differs at 7,481 (its `corr` tree, [arithmetic order](#arithmetic-order-729-730)) |
| H1, the kernel is the first stage to differ | Supported: the kernel first differs at evaluation 15 in five traces and 26 in the sixth, never after the objective; `g1 - g2`, `g2raw / P5` and the shape and scale divisions equal MATLAB's |
| H1a, `gammaln` | Refuted: it differs at 42 of 18,836 shapes, all half-integers (`k` 5 or 15), where `stirlerr` uses its table instead (gated) |
| H1b, `log` or `exp` | Refuted: `log(k)`, `log(2 pi k)` and `exp` on MATLAB's own arguments equal MATLAB's everywhere, and MATLAB's vector and scalar `exp` and `gampdf` agree |
| H1c, MATLAB's `gampdf` is not the port's formula | Supported: the port's algorithm evaluated by MATLAB with MATLAB's primitives differs from MATLAB's `gampdf` at 48,554 of 621,588 trace densities (up to 63 ULP), and at 1,141 of 14,600 generated ones, identically on both hosts |
| H2, a later stage | Not reached: with the corrected kernel every recorded stage matches |
| H3, host | MATLAB's densities and kernels are the same bits on AMD and Intel |

Which part of the formula. All 50 half-integer shapes of the discovery traces
(1,600 samples) matched; every other shape could differ, on both sides of
`k = 15` and on both `bd0` branches. For each discovery shape, one value of the
constant term `c` reproduces all 32 nonzero samples as `exp(c - bd0(k, x/b)) / b`
with the port's own `bd0` and `exp`, and it lies within two ULPs of the port's
`-log(2 pi k)/2 - stirlerr(k)`. Correctly rounded `stirlerr` (60 digits)
reproduced far fewer shapes (1,115 of 8,293 below 15) than the port's, so MATLAB is
not more accurate. Among operation orders of the two terms, only taking
`log(2 pi)` and `log(k)` separately, `-(log(2 pi) + log(k))/2`, reproduced every
discovery shape (9,338 of 9,338). Every other combination tried, with
`-log(2 pi k)/2`, `-log(2 (pi k))` or `-log(sqrt(2 pi k))`, five
re-associations of `stirlerr`'s `gammaln` formula, or six or seven Stirling
terms above 15, reproduced 2,873 to 9,040. Chosen on traces 1-3
alone, it then reproduced the held-out traces 4-6 (9,498 of 9,498 shapes) and
every generated held-out density. The 9,760 numerics2 densities, which cover one
non-half-integer shape below 15, do not distinguish the two forms.

`matlab_math::gampdf` now uses that normaliser. No constant or threshold was
fitted: it is one operation order in the existing formula. `fitted_hrf_probes`
(test-only, `exes/samsrf/core/src/fitted_hrf_probes.rs`) requires, on both hosts,
every recorded kernel and density (vector, per sample and generated), receptive-field
profile, unconvolved prediction and retained convolution output to equal the port's, MATLAB's
densities and kernels to be identical across the hosts, and, on the AMD host,
MATLAB's `err` to equal the pin and the port's objective at every evaluation. It
also requires the old normaliser to differ from the new one on this data, and
fails on a changed byte, a missing or extra file, and a one-ULP change to a
recorded density. With the old normaliser restored, it fails at fit 0's kernel
(4 ULP) and the trace gate at fit 0, evaluation 16.
Each fit must contain all eight preregistered stage indices exactly once and in
order, with the specified real-double descriptors, shapes and payload lengths.
The first and repeat numerical records must agree, including stage descriptors
and scalar results; changing CPU-frequency metadata is separate. Rejection
tests cover missing, duplicate and reordered stages, invalid descriptors and
inconsistent repeat records.

What this does not show: MATLAB's `gampdf` source, which was not read. The
agreement is with these recordings: shapes 1.5 to 20 and scales 0.5 to 3, on
two hosts. Shapes below 1 keep the closed form ([below](#double-css-arithmetic)).
The Intel host's objective differs through `corr`, not the kernel.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-fitted-hrf" packages/samsrf/validation/matlab/fitted-hrf-reference.json
SAMSRF_FITTED_HRF_DIR="$TMPDIR/samsrf-fitted-hrf" SAMSRF_MATLAB_REFERENCE_DIR="$TMPDIR/samsrf-reference" \
  cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --lib fitted_hrf_probes
```

To record again: dispatch `samsrf-native` with `record_matlab`, `include_matrix=false`
and `fitted_hrf`, then `python3 -I packages/samsrf/validation/matlab/pack_fitted_hrf.py`
on the downloaded artifacts.

## Requested and effective MKL controls (#730)

The recorders set `MKL_CBWR=COMPATIBLE`, `MKL_NUM_THREADS=1`,
`OMP_NUM_THREADS=1`, `MKL_DYNAMIC=FALSE` and `OMP_DYNAMIC=FALSE`, and call
`maxNumCompThreads(1)`. Those are requests. `controls_only` records what MKL
reports from inside MATLAB. The design and competing predictions were committed
first ([controls-preregistration.md](controls-preregistration.md), commit
`b74f636e9`).

- `mkl_controls.c` calls oneMKL's support functions on the MKL MATLAB loaded,
  one control per call. The first dispatch (run 43565576247) crashed MATLAB in
  all six jobs before any receipt: it called `mkl_cbwr_get`, MKL's Fortran
  interface, with a C argument. The fixed recorder (`2e043aee`) calls the C
  names.
- [Run 43565932237](https://github.com/neurodesk/webapps/actions/runs/43565932237)
  ran three requests (`documented`, `none`, `contrast`) on both runner labels,
  twice per host. `controls-reference.json` pins the receipts (HF commit
  `f0c0b4af`).
- `analyse-controls.py` (CI) requires every file with its hash, the
  environment each MATLAB saw, identical receipts at start, after
  `maxNumCompThreads(1)` and after a BLAS call, identical repeats, and
  `dgemv`/`sgemv` trees equal to the pinned kernel recording's trees for the
  same CPU vendor.

| Job | CPU | MKL branch (`MKL_CBWR_Get`) | `MKL_CBWR_Get_Auto_Branch` | OpenMP threads, dynamic |
| --- | --- | --- | --- | --- |
| ubuntu-22.04 documented | Intel Xeon 8370C | 14 (`AVX512_E1`) | 14 | 1, 0 |
| ubuntu-22.04 none | AMD EPYC 9V45 | 2 (`AUTO`) | 2 | 1, 0 |
| ubuntu-22.04 contrast | Intel Xeon 8573C | 14 | 14 | 1, 1 |
| ubuntu-24.04 documented | AMD EPYC 7763 | 2 | 2 | 1, 0 |
| ubuntu-24.04 none | AMD EPYC 7763 | 2 | 2 | 1, 0 |
| ubuntu-24.04 contrast | Intel Xeon 6975P-C | 14 | 14 | 1, 1 |

What this establishes:

- **CNR branch.** MKL runs its CPU's own branch whatever is requested: `AUTO` (2)
  on AMD and `AVX512_E1` (14) on Intel, equal to `MKL_CBWR_Get_Auto_Branch`.
  `COMPATIBLE` (3) and `AVX2` (10) never take effect. Predictions C1-B and C2-B
  are refuted. C1-A predicted `AUTO` on every host and holds only on AMD. C3-A
  predicted `AVX2` as AMD's auto branch, but MKL reports `AUTO` there. No AMD
  host drew the `contrast` request, so on AMD only `documented` and `none` were
  observed.
- **The branch decides the arithmetic.** On every process the summation trees
  equal the pinned trees of its vendor, across three Intel models and two AMD
  models, under all three requests (E1-A). Every repeat equals its first
  process (R1-A).
- **Threads.** `maxNumCompThreads` was 1 in every process before and after the
  call. OpenMP reports one thread under every request, including
  `OMP_NUM_THREADS=4`. `omp_get_dynamic` follows `OMP_DYNAMIC` (1 under
  `contrast`), with no effect at one thread. `MKL_NUM_THREADS` never reaches
  MATLAB's environment: the workflow set it, and `getenv` returned nothing in
  all twelve processes.
- **Unavailable.** Neither MKL's C nor its Fortran thread functions
  (`MKL_Get_Max_Threads`, `MKL_Get_Dynamic`) resolve in MATLAB's process (S1-B),
  so MKL's own thread count and dynamic adjustment remain unobserved (T1 and T2
  undecided). The MATLAB computational limit, OpenMP query and deterministic
  trees do not establish MKL's actual thread count or dynamic setting.

So the reference recordings ran each CPU's automatic branch, and the
`MKL_CBWR` request in the recorders is ineffective. MATLAB on Intel and AMD
hosts therefore uses different arithmetic by design, which is why Intel
results differ. Choosing one of them as the reference remains a proposal for
the maintainers (see "Intel AVX-512 and the reference host").

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
No Intel host ran this recording (the kernel recording below has one). `qr-reference.json` pins the archive
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
  accumulators and complex double in sequence, and complex right-hand sides
  all use that single-column kernel whatever their number and position (Q^H y
  of every recorded complex 8-column solve). No order depends on memory
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
  recorded multi-column solve). A real reciprocal is 1 / c. `ctrsm` and
  `ztrsm` form (c, -d) / (c² + d²), rounded once from double for single, and
  multiply by it as a complex number. Near the ends of the exponent range
  (the 1e155 and 1e300 designs) MKL's reciprocal equals that formula on c and d
  prescaled by a power of two, which is exact; dividing directly or scaling by
  1 / max(|c|, |d|) gave other last bits. `ztrsv` divides by (a c + b d) / (c² + d²).
  `ctrsv` evaluates the same formula in double and rounds to single: its
  coefficients, signed zeros included, equal that in all 64 complex single
  chains, while dividing each part gave -0 for 0 / a negative diagonal in 13.
  `?larfg` uses LAPACK's `?ladiv` (Baudin and Smith).
- `qr(A,0)` and `mldivide` share the factorisation, but `mldivide` matched the
  MEX chain where `qr(A,0)`'s R12 alone did not settle the order: R is no
  evidence of Q'y.

`lstsq.rs` implements these kernels.

#### Current behaviour

`lstsq::mldivide` (one right-hand side) and `lstsq::mldivide_many` (several, in
MATLAB's column order) run the chain above in the design's class: column
norms with MKL's `?nrm2` orders, column pivoting, `xLARFG` reflectors, the
`?gemv` column update ending each reflector at its last nonzero entry
(`xLARF`'s `ILADLR`), `?ormqr`/`?unmqr` on the whole reflector, MATLAB's rank
rule, then `?trsv` division or `?trsm` reciprocal multiplication. The summation
trees are those of MKL's CNR `auto` branch on AMD. Nothing selects another
branch: MATLAB on an Intel host with MKL's `AVX512_E1` branch rounds
differently, and the port does not follow it. Nonfinite inputs and the
extreme-range guards are described below.

#### Recorded evidence and acceptance checklist

This is agreement with MATLAB R2023b Update 11 and MKL 2021.3 (CNR `auto`, AMD
EPYC hosts) on a finite set of recorded designs, not a proof for arbitrary
inputs. Every item is a test that fails the native workflow:

- `qr_reference.rs`, 348 designs: MATLAB's rank for all, and its printed
  tolerance for the 89 rank warnings. 346 coefficients are bit-identical. The
  other two (`trace_single_v58_nonnegative0_recorded` and `_recomputed`) have
  MATLAB results 0 + 0i that MATLAB stores as a real array, so the recording
  holds no sign for the port's -0 imaginary part. The test requires their real
  parts at 0 ULPs from MATLAB's and their imaginary parts equal to zero. `qr-outcomes.json` keeps
  each case's frozen distance (now 0 ULPs in every part), and the empirical
  acceptance scale below still applies.
- `qr_kernels.rs`, 8,640 FPRev probes (23.6 million sums): every `?gemv` and
  `?ormqr` sum equals MKL's on the first AMD recording, and the other four AMD
  recordings are identical to it.
- `every_recorded_chain_step_matches_mkl_on_amd`: pivot, packed factor,
  reflector scalars, Q^H y and coefficients of all 345 chains in the port's
  class, bit for bit. The three single designs with subnormal imaginary parts
  have no chain in that class and are counted.
- `multiple_right_hand_sides_match_matlab_on_amd`: all 696 recorded 8-column
  solves (214 single and 190 double real, 134 single and 158 double complex).
  Q^H y equals the MEX chain's bit for bit. Coefficients equal MATLAB's bit for
  bit, except where MATLAB stored an all-zero imaginary result as a real array
  (30 complex solves). There the real parts must match bit for bit and the
  imaginary parts must be zero. In 26 of those 30 the port's imaginary zeros
  are -0. The 30 are a fixed count, so a new real-stored result fails the test.
- Unit tests without recordings cover the extreme ranges: halved reflectors
  near the largest value, prescaled complex division, the `ztrsv` and
  `ztrsm` guards at 2^1020 and 2^-1000 (single 2^125 and 2^-100), subnormal
  real and complex diagonals in multi-column solves, and NaN coefficients for
  nonfinite inputs.
- Through the pipelines, the reverse-correlation gates hold the single RC
  profiles (`[Y ones] \ X` over 400 aperture pixels) and the single global
  regression (`[X ones] \ Y` over every ROI course) to MATLAB's bits on the AMD
  hosts.

Diagnostics, not gates: `cargo run -p samsrf-core --example qr_steps` with
`qr-steps.py` reports the first numerically differing step per design (none on
AMD); it does not distinguish signed zeros.

#### Remaining limits

- MKL's AVX-512 branch on Intel hosts is not reproduced (next section).
- Signed zeros of MATLAB results that MATLAB itself returns as real cannot be
  recorded through MATLAB. A MEX-level recording of `?trsm`'s own output could
  show MKL's sign there, but MATLAB's visible result has none, so it would not
  change what the port must match.
- Designs, sizes and right-hand-side counts other than those recorded (two
  columns; 16 and 250 rows; 1 and 8 right-hand sides in the QR recordings, 400
  pixels and the ROI courses in the pipelines; the probe lengths) rest on the
  kernel probes and the tree model, not on recorded MATLAB outputs. Other
  MATLAB or MKL releases were not recorded.

#### Intel AVX-512 and the reference host

The pinned kernel recording includes one Intel Xeon 8370C host (MKL CNR
branch `AVX512_E1`, `ubuntu-22.04-3` in `qr-kernels-reference.json`). It
answers where Intel's arithmetic departs from the AMD reference and whether a
second, explicit reference could be built from existing data. No new recording
was made for this.

Where Intel first departs, per design (`qr_steps` with `qr-steps.py` against
the Intel recording; numeric comparison):

| Class (designs) | Port equals Intel's `mldivide` | First differing step |
| --- | --- | --- |
| double real (95) | 10 | R(1,2) 54, R(1,1) 25, R(2,2) 9, v(2) 6, Q^H y 1 |
| double complex (79) | 0 | R(1,2) 49, R(1,1) 23, v(1) 7 |
| single real (110) | 38 | R(1,2) 87, v(2) 12, R(2,2) 4, Q^H y 4 |
| single complex (64) | 8 | R(1,2) 41, v(1) 21, v(2) 2 |

So the column update (`?gemv` inside `?geqp3`) differs first in most designs,
`dnrm2` (R(1,1)) in 48 double designs, and the complex reflector's scaling (v(1))
in 28 complex designs.

What the existing Intel data establishes:

- Every Intel tree is deterministic and independent of memory alignment (one
  tree per length across the eight recorded offsets), as on AMD.
- `qr-lane-models.py` fits lane-tree models to a host's FPRev probes. On the
  AMD recording it recovers every model `lstsq.rs` implements: all four
  `?gemv` classes, both complex `?ormqr` classes, and the real `?ormqr` groups
  whose block equals their lane count. On Intel:
  - `dgemv`: one model at all 49 lengths, with c(1) as element 0, 16 lanes
    (two 8-wide registers), the remainder in power-of-two chunks (8, 4, 2, 1)
    from lane 0, then folds with strides 8, 4, 1, 2.
  - `cgemv` (real-v probes): one model, with 8 lanes, folds 4, 2, 1 and the
    remainder round-robin.
  - `sgemv`: the products go round-robin and c(1) is added last, but the lane
    count grows with the length (2, 4, 8, 16, 32). That fits 45 of 49 lengths,
    and none fits at 127, 128, 249 and 250.
  - `zgemv`: no model of this family at 15 lengths.
  - `?ormqr`: complex single fits one model in 21 of 21 column groups and
    complex double in 18 of 21, but double only in 7 of 21 and single in none.
- `snrm2` gives Intel's R(1,1) in all 49 non-constant single designs with the
  AMD order. `dnrm2` does not: the AMD scaled sum gives 26 of 51 double
  designs, and no plain or lane-wise sum of squares tried gives more than 34.
  Intel's `dnrm2` is another algorithm, not identified.
- FPRev probes use real ones, so they cannot see fused multiply-adds or how
  complex products are formed. The complex v(1) differences (28 designs) are
  such arithmetic and are not identified.

Feasibility of a second reference: the summation trees are recoverable from
the existing probes for some kernels. A faithful Intel reference would still
need `dnrm2`, the complex reflector scaling, real `?ormqr`, `zgemv` and long
`sgemv` identified, and then every chain gated as the AMD ones are. Probes
cannot decide the non-tree parts. The recorded chains could, but each
candidate would be fitted on the same 348 designs it is judged on. A held-out
recording would then be needed before calling it a reference.

Recommended reference-host policy (a proposal; the current contract is
unchanged):

- Keep one deterministic reference: MATLAB R2023b Update 11 with MKL's CNR
  `auto` branch on the recorded AMD EPYC hosts. The port's arithmetic is fixed
  in its code and gives the same bits on every user's machine. Choosing
  arithmetic from the user's CPU would make results depend on hardware and
  would still not match a MATLAB run elsewhere, since MATLAB's own results
  differ between hosts.
- Report agreement as "with MATLAB on the AMD reference". Intel MATLAB
  results are a different, documented target, not a failure of the port, and
  not covered by AMD evidence.
- Build an Intel model only if someone needs to reproduce Intel MATLAB runs.
  It would be an explicit, opt-in reference identifier, never a default or
  an automatic choice, and it would need the identifications above and a
  held-out Intel recording first.

```sh
python3 -I packages/samsrf/validation/matlab/qr-lane-models.py "$TMPDIR/samsrf-qr-kernels/ubuntu-22.04-3" "$TMPDIR/intel-lanes.json"
cargo run --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --example qr_steps -- "$TMPDIR/samsrf-qr/ubuntu-24.04/compatible" "$TMPDIR/port-steps.json"
python3 -I packages/samsrf/validation/matlab/qr-steps.py "$TMPDIR/samsrf-qr-kernels/ubuntu-22.04-3" "$TMPDIR/port-steps.json" "$TMPDIR/intel-steps.json"
```

#### History

In order, for #731: #812 added MKL's `snrm2` order, the two-accumulator
`?unmqr` and `ctrsv` in double, taking the bit-identical single-RHS count from
300 to 346. #818 trimmed `?geqp3`'s reflector (next paragraph). The complex
`?trsm` reciprocal then took the 292 recorded complex 8-column solves to
MATLAB's values (20 single and 2 double had them before; Q^H y already matched
in all 292, so the difference was only in the back substitution).

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

The table and paragraph below record the state before #812.

| Family (cases) | Bit-identical, measured order (#773) → MKL kernels (#795) | Max ULP of any part (#773 → #795) |
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

In total 123 → 300 of 348. Every real double design is bit-identical. Three
single designs with subnormal imaginary parts (`glm_single_1e+06/08/10_1e-50`)
equal MATLAB's values and differ only in the sign of a zero imaginary part. No
bit-identical case was lost. In 13 complex designs one
part moved further from MATLAB while the others came closer (for example
`random_double_3`'s imaginary intercept, 49 to 437 ULPs); `qr-outcomes.json`
records them. What remains: the single `?nrm2` in two designs (reference
LAPACK 3.9's scaled sum matches 91 of 93 single R(1,1) values; no candidate
tried fixes both without breaking others), R(2,2) in nine single designs,
complex `?unmqr` in 21 double and 12 single designs, and the Intel branch.
The zero-based single CSS vertices 47 and 58 had exact zero baselines in
MATLAB, where cancellation of the observation sum gave the port about 4e-9
(within the acceptance scale). Both now equal MATLAB's (v58 up to the
unrecorded sign of an imaginary zero).

Extreme-range guards (current behaviour). In `ztrsv`, where c² + d² is not a
finite normal number the port uses the guarded division; MKL's result there
matched it at the two recorded scales (1e155, 1e300), but its formula is not
otherwise evidenced. The same safe division protects overflowing numerator
products and sums and products that flush to zero; finite subnormal products
keep the measured arithmetic. Multi-column real solves divide directly when the
reciprocal overflows (a subnormal diagonal). Multi-column complex solves use the
prescaled reciprocal, which the 1e155 and 1e300 recordings support, and fall
back to the guarded division only for a diagonal whose largest part is zero or
subnormal. These fallbacks have analytic regression tests, not MATLAB bit-parity
evidence.

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

- 7 polygon families, 26,057 polygons: thin triangles one ULP of the apex height
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
  of MATLAB's shoelace on untranslated vertices. 25,964 of the 26,057 recorded
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

It gives MATLAB's hull vertices on 26,013 of the 26,057 original polygons
(production: 25,964) and on all 253 reference polygons. The 44 that differ are
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
gain one held-out cloud. Two structural hypotheses tested on 2026-11-13,
with predictions written before running them, are rejected too:

- Clipper's `PreserveCollinear` option, which in 6.4.2 only keeps input
  vertices exactly collinear with and between their neighbours. None of the
  four clouds has such a vertex on the grid, so it cannot change them.
- Keeping a union ring that the clean would delete entirely. It fixes none of
  the four, and loses 129 original clouds, 459 held-out probe clouds and 407
  causal polygons.

No general correction has been established from the current evidence.

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

### Reduced reproducers of the four regressions

`polyshape_reduce.py` reduces each of the four clouds by deleting points,
keeping their order (SamSrf passes clusters in breadth-first order). A
reduction is kept while the witness input points still separate the models:
on the full cloud, MATLAB's and the experimental hull disagree about whether
those points are hull vertices, and the shipped model, which equals MATLAB
there, must still agree with MATLAB on them. That is only a prediction. Both
models' hulls for every candidate were committed before MATLAB recorded it:

- `polyshape-reproducers.json` (113 cases), recorded first in run
  [43523651415](https://github.com/neurodesk/webapps/actions/runs/43523651415):
  the full clouds as controls, each reduction, every one-point deletion of the
  smallest, and its other starts, reversal, translation and two scales.
- `polyshape-reproducers-2.json` (80 cases), first in run
  [43525037841](https://github.com/neurodesk/webapps/actions/runs/43525037841):
  each cloud's smallest measured reproducer and its one-point deletions.
- `polyshape-reproducers-3.json` (51 cases), first in run
  [43526041360](https://github.com/neurodesk/webapps/actions/runs/43526041360):
  cloud 932's 17-point reproducers and their one-point deletions.
- `polyshape-reproducers-4.json` (12,873 cases), first in run
  [43564016762](https://github.com/neurodesk/webapps/actions/runs/43564016762):
  every order-preserving subset that deletes 1 to 4 points from one of 932's
  nine 16-point reproducers. Its frontier came from recorded verdicts only.
- `polyshape-reproducers-5.json` (12,897 cases), in run
  [43564536819](https://github.com/neurodesk/webapps/actions/runs/43564536819):
  every subset that deletes 1 or 2 points from one of round 4's 302 twelve-point
  reproducers.

Rounds 4 and 5 are compact. They store bitmasks of indices into cloud 932, and
a `predictionsSha256` over both models' predicted hull bytes, committed with
the decision rules (`polyshape-reproducers-{4,5}-predictions.md`) before each
was first recorded. The models are not MATLAB oracles: the shipped model's
predictions failed on many reductions.

`polyshape-reproducers-reference.json` pins run
[43590132739](https://github.com/neurodesk/webapps/actions/runs/43590132739),
which records rounds 1 to 6 (HF commit
077795cc9f53fc52670f11f2f7e2cb473bc67691, SHA-256
`0a82c839b47d064e4375aeceb6aef8569a6e92bcbea1b47089966383f60ca05d`,
12,067,976 bytes, recorder commit 72e621ba5a502c1ff79c5abc7d451f3678125fd0).
- Both hosts passed an exact same-host repeat, and their 144 arrays are
  byte-identical. Both runner labels received AMD EPYC 7763 CPUs in that run.
- Every earlier batch equals its first recording bit for bit. Those recordings
  ran on different CPU pairs and agreed:
  - rounds 1-3: Intel 8573C and AMD EPYC 7763;
  - round 4: AMD EPYC 9V74 and Intel Xeon 6975P-C;
  - round 5: Intel 8573C and AMD EPYC 9V74.
- The full-cloud controls reproduce the original recording's verdicts.

The proxy failed often. Of the reductions it predicted, MATLAB agreed with the
shipped model and not the experimental one only for some. On several, MATLAB
matched the experimental model, or neither model: both are wrong there. The
smallest recorded 1-minimal reproducers, where MATLAB's hull equals the shipped
model's and not the experimental one:

| Cloud | Points | 1-minimal in MATLAB | Experimental area / CF sigma error | MATLAB default: regions, holes, rings (kept) | Experimental output: rings | `polyshape` of kept / of default = default |
| --- | ---: | --- | --- | --- | --- | --- |
| 177 | 6 of 18 | yes | +6.5 % / +3.2 % | 2, 0, 2 (3) | 3 | yes / yes |
| 932 | 11 of 18 | yes | -56.3 % / -33.9 % | 2, 1, 3 (10) | 3, no hole | no / no |
| 1607 | 8 of 40 | yes | -2.9 % / -1.5 % | 5, 1, 6 (7) | 6, no hole | no / no |
| 1937 | 8 of 24 | yes | -24.4 % / -13.0 % | 1, 0, 1 (4) | 1, other vertices | no / yes |

1-minimal means that every one-point deletion was recorded and none still
reproduces. For cloud 932, rounds 4 and 5 certify eight 11-point, two 12-point
and two 13-point 1-minimal reproducers. They also hold 662 ten-point
reproducers whose deletions were not recorded, so the smallest reproducer of
932 is not known: 932 is at most 10 points and has 1-minimal reproducers of 11.
Rounds stopped there by the budget pre-registered for round 5. Of the 25,849 distinct
untransformed subsets of 932 recorded, MATLAB matched the shipped model and not
the experimental one in 1,658, the experimental model and not the shipped one
in 10,537, both in 4,099, and neither in 9,555. Smaller reductions often defeat both models, so
the shipped model is not a usable MATLAB oracle for this cloud.

Topology at the corresponding public outputs (MATLAB's default against the
experimental model's final output): the ring counts agree for 932, 1607 and
1937. For 177, MATLAB has one region fewer. MATLAB's default has a hole in 932
and 1607 where its `KeepCollinearPoints` output has none and the experimental
model has none either: all its output rings on these four inputs have the
same orientation.

`polyshape_regression_reproducers.m` holds the four as exact hex doubles with
MATLAB's and the experimental hull rows. On all four, MATLAB's hull vertices
are input points:

- 177, 1607 and the 932 reproducer: the experimental model puts another input
  point on the hull, or leaves one out (932's experimental hull has three of
  MATLAB's four vertices).
- 1937: it replaces the extreme input point (0.99963, 2.99927) with a crossing
  of two edges. Its first clean leaves one ring of its four union rings, and
  MATLAB's default keeps the region that reaches that point.

The 177 reproducer is idempotent and its `KeepCollinearPoints` shape rebuilds
the default, so the regression does not need non-idempotence or a kept/default
difference. On it, the difference is one ring. MATLAB's default drops the
4-vertex `KeepCollinearPoints` ring through input points 4 and 5. The
experimental model cleans the same ring, as Clipper's union returns it, to a
triangle and keeps it. Clipper's `CleanPolygon` empties that ring for 6 of its
8 start and direction choices, and keeps a triangle only when it starts at
input point 5, where the union's ring starts. This is the start dependence
already documented; no start rule tested reproduces MATLAB generally. The
winding rule changes none of the 244 hulls of rounds 1 to 3.
`polyshape_reproducers_match_recording` (experimental gate, both hosts, 26,014
cases each) holds:
- every recorded polygon to the spec, and every descriptor to its class,
  realness and byte length;
- both models to the hulls predicted before recording, per case for rounds 1
  to 3 and through the committed digest for rounds 4 and 5;
- MATLAB's per-case verdicts to `matlab_polyshape_reproducers.json`;
- the smallest measured reproducers keeping on reproducing;
- each listed 1-minimal reproducer (all four clouds) reproducing, with every
  one-point deletion recorded and none still reproducing.

A flipped verdict, a changed digest, a grid change and a non-minimal
reproducer listed as 1-minimal each make it fail.

Two more premises suggested by the reproducers, written down before running
them on 2026-11-14, are rejected:
- MATLAB merging distinct vertices of different rings that lie within the
  tolerance. On all four reproducers, no two distinct union vertices are within
  20 tolerances of each other, so there is nothing to merge.
- An effective near-collinear threshold of sqrt(2) tolerances. 177's dropped
  ring is 1.26 tolerances thick at its thinnest and 1607's thinnest kept ring
  1.63, which that threshold would separate. Applied to the near-collinear test
  alone or to both clean tests, it fixes 177 but not 932, 1607 or 1937. It also
  loses 6,474 of the 11,907 one-ULP thin triangles and most other families, so
  the vertex threshold is the tolerance itself.

### Perturbation sweeps of the 177 reproducer (round 6)

On cloud 177's 6-point reproducer, MATLAB's default drops the sliver ring
through input points 4 and 5 and two crossings. Clipper's `CleanPolygon`
empties it from 6 of 8 start and direction choices, and the experimental model,
which starts where the union does, keeps it. Round 6
(`polyshape-reproducers-6.json`, 1,212 cases) replaces one coordinate of point
4 or 5 in steps of 0.05 tolerance from -2.5 to +2.5. Each sweep is recorded as
drawn, translated, and scaled by 1e2, the last two as held-out copies.

The hypotheses, controls, decision rules, stop criteria and a two-recording
budget were committed before the first recording
(`polyshape-reproducers-6-predictions.md`, commit 72e621ba5). The per-case
predictions, of whether point 4 is a vertex of the default output, were:

- H_X, the experimental model;
- H_I, start-independent cleaning: the ring survives only if every start and
  direction keeps it;
- H_B, a region-level (thickness or area) criterion, which predicts
  transitions where no clean regime changes.

Results (both hosts identical):

| Sweep | Regimes by step (MATLAB / H_X / H_I survival) |
| --- | --- |
| point 5, y | -2.50: 0/0/0; -0.20: 0/1/0; +0.70: 0/0/0; +1.05: 1/1/1 |
| point 5, x | -2.50: 1/1/1; -0.50: 0/0/0; -0.30: 0/1/0; +0.15: 0/0/0; +2.15: 1/1/1 |
| point 4, y | -2.50: 1/1/1; -1.90: 0/1/0; +1.70: 0/0/0 |
| point 4, x | -2.50: 1/1/1; -2.45: 0/0/0; -0.80: 0/1/0; +1.00: 1/1/1 |

- H_I predicts MATLAB on all 1,212 cases, including both held-out copies.
  Every transition MATLAB shows falls on a step where the clean regime of
  Clipper's `CleanPolygon` changes.
- H_X is refuted on 405 cases, exactly where the clean depends on its start.
- H_B is not supported: there is no transition inside a regime where H_I is
  constant.
- MATLAB's hull equals the shipped model's on 1,200 cases and the experimental
  model's on 807.

The evidence is local. On this ring, MATLAB behaves as vertex-level cleaning
with Clipper's tolerance and comparisons whose result does not depend on where
the ring starts. It does not show how MATLAB achieves that, or that it does
this on every ring.

The general form, H_I*, was tested on every earlier recording with
predictions written first. Each union ring is dropped if any start or
direction of the clean empties it, and otherwise cleaned as before. It fixes
original cloud 177 but not 932, 1607 or 1937. It newly loses accepted cases:
- 3 original clouds;
- 12 held-out near-collinear clouds and 3 held-out mixed clouds;
- 5 held-out causal strip pairs;
- 243 reproducer-round cases.

H_I* is therefore rejected as a model, and the experimental model is
unchanged. The pre-registered follow-up on hole formation in 932 and 1607
needed a rule that predicts holes. H_I only removes rings, so the round stopped
after one recording.

Also rejected this round, locally: cleaning the input ring before the union.
It fixes 177 and 1937, loses 55 original clouds and hundreds of probe, causal
and reproducer cases, and leaves 932 and 1607.

`polyshape_reproducers_match_recording` holds round 6 too:
- every polygon rebuilt from the spec;
- the predictions digest;
- the frozen hull verdicts;
- MATLAB's survival of point 4 equal to H_I on every case, and different from
  H_X on exactly 405.

A flipped H_I prediction, a changed perturbation value and a flipped verdict
each make it fail.

### Hole formation in the 932 and 1607 reproducers (existing recordings only)

MATLAB's default output for the 1-minimal reproducers of 932 and 1607 has a
hole. Neither its `KeepCollinearPoints` output nor the experimental model has
one. This round used the pinned recordings only and spent none of its
two-recording budget. No rule below was clear enough to justify a focused
recording.

**What the geometry shows** (`core/examples/polyshape_hulls.rs --oracle`, and
the experimental model's first-union rings, with crossings labelled by position):

- **1607:** three union rings touch pairwise at single crossings, x4, x10 and
  x7, and enclose an unfilled triangle. One of them is a sliver that the
  experimental clean removes on its own, which opens the void. MATLAB's default
  equals the result of merging the three rings first:
  - the cleaned outer boundary of the merged rings, [p2, x3, x4, x5, x6, p3],
    is MATLAB's solid ring;
  - the cleaned void, [p5, x7, x4], is MATLAB's hole.
- **932:** MATLAB's hole [x2, x3, x4] is the cleaned void enclosed by four
  touching union rings. Its solid triangle [p3, p7, p4] is the cleaned outline
  of the merged touching set.

**Rules tested.** Each is an opt-in `experimental::Hypothesis` variant, so the
experimental model's default output is unchanged, and each was written down
before it ran:

- H_M merges every connected set of touching union rings, by tracing their
  boundary (taking the most clockwise turn at a touch vertex) and cleaning the
  merged outer and void cycles.
- H_M1 merges only across contacts of rings that share exactly one vertex. In
  the strip pairs, where two rings share two vertices, MATLAB follows per-ring
  cleaning.
- H_N1 uses Clipper's own non-strict union (StrictSimple off in all four places
  it acts) followed by the existing clean and a strict second union. It was
  tested as a scratch change and is not kept as a variant.

Exact hull vertex sets equal to MATLAB's:

| Recording | Experimental model | H_M | H_M1 |
| --- | ---: | ---: | ---: |
| Original clouds | 2,456 / 2,500 | 2,424 | 2,425 |
| Of the four regressions, still different | 177, 932, 1607, 1937 | 1607 | 1607 |
| Held-out near-collinear / mixed | 1,352 / 1,470 | 1,235 / 1,450 | 1,234 / 1,450 |
| Strip pairs / bisection | 8,424 / 1,152 | 8,214 / 1,149 | 8,424 / 1,152 |
| Causal real-cloud transforms / held-out strips | 157 / 600 | 286 / 582 | 286 / 600 |
| Reproducer rounds 1-6 | 54 / 21 / 12 / 6,335 / 8,278 / 807 | 43 / - / - / 2,638 / 6,052 / 1,212 | 41 / 42 / 12 / 2,699 / 5,924 / 1,212 |

The families not listed match fully under H_M1. H_M also matches the one-ULP and
random thin triangles, the collinear-vertex and spike families, the grid sweep
and the hole contacts; it was not run on the relative sweep, the degenerate
inputs or the grid bisection.

H_N1 reproduces neither reproducer's hole. On 1607 it gives MATLAB's ring count
but no hole; on 932 it gives two rings and no hole, where MATLAB has a hole.

Hole counts against MATLAB's per-boundary hole flags
(`polyshape_hole_census.py`; equal / with holes where MATLAB has holes / with
holes where MATLAB has none):

| Recording (polygons, with MATLAB holes) | Experimental model | H_M | H_M1 |
| --- | --- | --- | --- |
| Strip pairs (8,424, 0) | 5,634 / 0 / 2,790 | 4,714 / 0 / 3,710 | 5,634 / 0 / 2,790 |
| Bisection (1,152, 0) | 615 / 0 / 537 | 609 / 0 / 543 | 615 / 0 / 537 |
| Causal real-cloud transforms (403, 251) | 111 / 212 / 61 | 51 / 251 / 101 | 51 / 251 / 101 |
| Reproducer round 4 (12,873, 3,852) | 9,372 / 845 / 224 | 4,537 / 3,534 / 6,321 | 5,132 / 3,136 / 5,629 |
| Reproducer round 5 (12,897, 3,412) | 9,777 / 957 / 469 | 6,949 / 3,049 / 4,838 | 7,487 / 2,494 / 3,828 |

What this establishes:

- **Hole presence:** H_M produces at least one hole on all 251 causal
  transforms where MATLAB has a hole, and on 3,534 of round 4's 3,852.
  These are presence comparisons, not matched hole boundaries. On the causal
  real-cloud family, H_M matches the exact hole count on only 51 of 403 cases.
- **Over-prediction:** the merged rules also produce holes on many polygons
  where MATLAB has none. Counts alone do not establish which geometric voids
  correspond to MATLAB's holes or explain MATLAB's internal operations.
- **The experimental model** produces holes MATLAB does not show: on 2,790
  strip pairs it keeps the enclosed sliver as a hole.

H_M1 recovers 177, 932 and 1937 and all of round 6. It restores the strip
pairs, but still loses near-collinear clouds and reproducer cases, so it is
rejected like H_M. The experimental model is unchanged.

**The open question** is whether a rule for touching regions and enclosed
voids can predict MATLAB's hole boundaries as well as their counts. Merging
touching rings before cleaning remains a hypothesis, supported by the specific
932/1607 boundary correspondences above, not an observed MATLAB operation. A controlled
experiment would use shapes whose voids are bounded by k regions touching at
single vertices (star polygons and their one-vertex perturbations), with the
void's size swept across the tolerance, and two-vertex contacts as controls.
It would need its own pre-registration; its predictions under H_M1 and under
the experimental model would come from the committed variants.

### Controlled touching regions and enclosed voids (round 7)

The previous section left open whether MATLAB merges regions that touch at
single vertices around an enclosed void, which is how H_M and H_M1 explain the
932 and 1607 holes. Round 7 tests that on shapes built for it.

**Shapes** (`polyshape-reproducers-7.json`, from `polyshape_controlled.py`): 148
single-ring shapes, 592 cases.
- Pinwheels: k = 3-6 tips touching at single corners around a regular void,
  swept from 0.5 to 1e4 x 2e-8.
- Lenses: two regions touching at two vertices around a void.
- Controls: the pinwheel with the void filled, the pinwheel with its corners
  split so that the tips do not touch, and the 932 and 1607 reproducers.
- Each shape is drawn at two rotations and recorded four ways: as drawn,
  reversed from another start, translated, and scaled.

43 cases are discovery cases and 549 held out.

**Pre-registration.** The experimental model's, H_M's and H_M1's hulls and
final rings (hole flags and vertex sets) were frozen by a SHA-256 before the
first recording, together with the comparison and decision rules, stop rules
and a two-dispatch budget (`polyshape-reproducers-7-predictions.md`, commit
bc8ce6313). The models' predictions differed on 464 to 496 cases.

**Recording.** Run
[43697002946](https://github.com/neurodesk/webapps/actions/runs/43697002946)
recorded the round on two AMD CPUs, an EPYC 9V74 and an EPYC 7763.
- Same-host repeats are exact, and all 168 arrays are byte-identical across
  the hosts.
- Rounds 1-6 equal the earlier pin.
- There was no Intel host in this run.

Agreement with MATLAB, as pre-registered (hull and every ring's hole flag and
vertex set; for the reproducers hull and ring counts), discovery / held out:

| Family | Experimental model | H_M | H_M1 | MATLAB's topology |
| --- | --- | --- | --- | --- |
| pinwheel | 18/18, 270/270 | 0/18, 0/270 | 0/18, 0/270 | k separate solids, no hole, at every void size |
| filled | 2/2, 30/30 | 2/2, 30/30 | 2/2, 30/30 | one solid |
| lens | 6/9, 34/63 | 0/9, 16/63 | 6/9, 34/63 | two solids, or one where the rotated void is at most 2 x 2e-8 wide |
| gapped | 1/12, 45/180 | 0/12, 0/180 | 0/12, 0/180 | 3-12 solids, some holes |
| reproducer | 0/2, 0/6 | 0/2, 0/6 | 0/2, 0/6 | 2 solids and 1 hole (932), 5 and 1 (1607) |

Results:

- **H_M and H_M1 are rejected.** On every pinwheel, at every void size,
  rotation, start, direction, translation and scale, MATLAB keeps the k tips as
  separate solids and reports no hole. Each ring's hole flag and vertex set
  match the experimental model bit for bit. This comparison does not check
  edge connectivity or boundary order. MATLAB therefore does not merge regions merely
  because they touch at single vertices around a void. The touching-ring
  account of the 932 and 1607 holes, which their geometry suggested, does not
  hold as a general rule.
- **Lenses.** MATLAB keeps two solids where the experimental model gives:
  - one solid, when the unrotated void is at most 1.5 x 2e-8 wide;
  - one solid with a touching hole, when the rotated void is at least
    3 x 2e-8 wide (the same point set, represented differently).
- **The reproducers' holes** remain unexplained by all three models.

By the pre-registered stop rule, the round ended after one dispatch: no
model failed only across a single interval between adjacent sizes. The
experimental model, production and their baselines are unchanged.

What the hole really depends on in 932 and 1607 is open. It is not touching at
single vertices alone, since the pinwheels touch that way and keep no hole.

`polyshape_reproducers_match_recording` holds round 7 on both hosts:
- every case rebuilt from the exact base shapes, with unique identities;
- the predictions digest;
- MATLAB's hole flags read as binary, one per boundary;
- an independent frozen digest of MATLAB's ring membership, hole flags and
  hull vertex bits, with case, ring and vertex counts separating the records;
- each model's frozen agreement, per case;
- the family inventory: pinwheels 288 / 288 / 0 / 0, filled 32 for all
  models, reproducers 0 for all.

`controlled_predictions_match_their_preregistered_digest` recomputes the
digest without a recording. Each of the following makes the gate fail:
- deleting the lens family;
- duplicating a case;
- duplicating a shape identity;
- changing one recorded boundary vertex by one ULP with the ring counts
  unchanged, including a case where all three models already disagree;
- flipping a frozen agreement;
- changing the prediction digest.

### Ordered boundaries (2026-11-16, existing recordings only)

Every polygon batch records MATLAB's `polyshape(P).Vertices` in order, one NaN
row between boundaries. The comparisons above sorted those vertices, so they
could not see edges, connectivity or which solid a hole belongs to.
`polyshape_ordered_rings.py` reads each boundary as a cycle, normalised only
for start and direction, and compares it with the experimental model's final
rings. It reports the first observable that differs:

1. vertex survival: the union of ring vertices;
2. connectivity: the undirected edge set;
3. cycles: how those edges are partitioned into rings;
4. hole flags: MATLAB's `ishole` where recorded, else the exact shoelace sign;
5. containing solid: the smallest solid whose closed polygon contains every
   vertex of a hole.

Orientation and containment use exact rational arithmetic. A double shoelace
flipped the orientation of 921 thin triangles. In the causal recording, all
24,827 recorded hole flags equal the exact shoelace sign, and MATLAB winds solids
clockwise. No MATLAB dispatch was spent.

The experimental model against MATLAB on ubuntu-22.04 follows. The arrays of both
hosts are byte-identical. Columns: rings equal (hull equal / hull differs), then
first difference at hole flags or containing solid, cycles, connectivity, and
survival (hull equal / hull differs). The four extreme grids the model refuses
are left out.

| Batch | Polygons | Rings equal | Holes | Cycles | Connectivity | Survival |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| Thin, collinear-vertex, spike and degenerate families | 23,557 | 23,557 / 0 | 0 | 0 | 0 | 0 / 0 |
| Original point clouds | 2,500 | 981 / 0 | 1 | 770 | 152 | 552 / 44 |
| Grid sweep and bisection (probe) | 27,648 | 27,648 / 0 | 0 | 0 | 0 | 0 / 0 |
| Held-out near-collinear (probe) | 1,500 | 1,012 / 8 | 0 | 23 | 10 | 307 / 140 |
| Held-out mixed (probe) | 1,500 | 625 / 1 | 2 | 443 | 81 | 319 / 29 |
| Strip pairs (causal) | 8,424 | 4,986 / 0 | 0 | 2,430 | 1,000 | 8 / 0 |
| Sliver bisection (causal) | 1,152 | 609 / 0 | 0 | 534 | 9 | 0 / 0 |
| Holes at one contact (causal) | 170 | 170 / 0 | 0 | 0 | 0 | 0 / 0 |
| Real-cloud transforms (causal) | 403 | 0 / 0 | 0 | 0 | 1 | 156 / 246 |
| Held-out strip pairs (causal) | 600 | 453 / 0 | 0 | 0 | 146 | 1 / 0 |
| Reproducer rounds 1-3 | 244 | 65 / 2 | 0 | 3 | 0 | 19 / 155 |
| Reproducer round 4 | 12,873 | 2,979 / 124 | 3 | 0 | 75 | 3,281 / 6,411 |
| Reproducer round 5 | 12,897 | 4,890 / 130 | 3 | 13 | 155 | 3,220 / 4,486 |
| Reproducer round 6 | 1,212 | 678 / 0 | 0 | 0 | 0 | 129 / 405 |
| Reproducer round 7 | 592 | 406 / 0 | 0 | 20 | 12 | 146 / 8 |

What this localises:

- **Survival differs on all 44 original cloud failures and all 246 real-cloud
  transform failures.** This does not hold for every reduced reproducer.
  `reproducer_cases[29,30]`, both reductions of cloud 932, have matching ordered
  rings but different hulls.
- **Hull agreement hides ring disagreement.** 552 original clouds have MATLAB's
  hull but other vertices, and 922 have MATLAB's vertices but other edges or
  rings.
- **Round 7, with edges.** All 288 pinwheels equal MATLAB in every ordered
  observable, so the rejection of H_M and H_M1 now holds for edge order and
  connectivity too. Of the 72 lenses, 40 are equal, 20 differ in cycles and 12
  in connectivity, and their hulls agree.
- **A later stage, separately.** 256 reproducer polygons and 9 held-out probe
  clouds have MATLAB's rings exactly but another hull.

The gates now freeze MATLAB's ordered observable, independent of any model.
`matlab_polyshape_reproducers.json` and `matlab_polyshape_causal.json` hold
`orderedRecordedSha256`: one SHA-256 per batch over the canonical cycles and
hole flags. `polyshape_ordered_rings.py digest` computes it, the two hosts give
the same value, and `polyshape_reproducers_match_recording` and
`polyshape_causal_matches_matlab` recompute it in Rust.

The previous round-7 digest sorts vertices. With two vertices of one recorded
ring swapped (a copy of the pin, round 7, polygon 36), that gate still passes
on both hosts and the ordered digest fails.
`ordered_observable_keeps_edges_and_ignores_start_and_direction` holds the
same property without a recording.

**Rules tested on these recordings.** Each rule is an opt-in
`experimental::Hypothesis` variant (`polyshape_hulls` `h-touch-pre`,
`h-touch-post`, `h-nonstrict-post`, `h-hull-grid`, `h-hull-polyshape`).
Predictions and decision rules were committed before each run, in
`polyshape-touch-pairing-predictions.md`.

- **H_T, touch-vertex pairing.** Where edges agree but cycles do not, MATLAB's
  two rings at a touch vertex are mostly two solids. With the region on the
  left, they take the most counter-clockwise turn. The model has a solid and a
  touching hole there. H_T traces every ring that way and splits each cycle at
  repeated vertices.
  - Applied to the final rings (H_T-post), it fixes 749 of the 770 "cycles"
    clouds, 2,790 strip pairs, 537 bisection polygons and 20 lenses, with no
    hull change.
  - It breaks five equal clouds (485, 1278, 1399, 1935, 1993) and the four
    copies of `gapped-k6-s3-g10-r0`. There MATLAB keeps a hole that touches its
    solid at two vertices.
  - Applied before cleaning (H_T-pre), it loses 1,040 and 964 hulls in rounds 4
    and 5.
  - Both placements are rejected. MATLAB's pairing rule is open.
- **H_NS, Clipper's non-strict union then splitting at repeated vertices.** It
  equals the experimental model on rounds 1-7, so it does not explain MATLAB's
  pairing. Rejected.
- **H_G, the hull on the final vertices' own grid.** In 251 of the 256
  ring-equal, hull-different reproducer polygons, the final vertices span less
  than the input. H_G gains 393 hulls and loses 88, 27 of them ring-equal.
  Rejected.
- **H_G2, `convhull` as the model's own `polyshape` of the convex hull of the
  final vertices.** It runs on the hull's own grid, with Clipper's union deciding
  where the clean starts.
  - It gains 396 hulls: round 4 +205, round 5 +180, round 1 +2, held-out probe
    +9.
  - It loses 23: round 4 -8, round 5 -13, reproducer case 28, held-out
    near-collinear cloud 490.
  - None of the 23 losses had MATLAB's rings. Each matched MATLAB's hull while
    its rings already kept other vertices.
  - Among polygons whose rings equal MATLAB's, it fixes 259 hulls, loses none
    and leaves 6: round 4 indices 11058, 11150 and 11169, and round 5 indices
    6446, 9096 and 9891 (zero-based).
  - By its pre-registered rule it is rejected: it would change frozen accepted
    hulls. These results support further testing of this empirical candidate,
    not identification of MATLAB's hull algorithm. The six matching-ring
    failures leave the hull stage unresolved.

None of these changes the experimental model's default, the production model or
any frozen baseline.

To reproduce, set `geometry`, `probe`, `causal` and `reproducers` to the
extracted recordings, then run from the repository root:

```sh
cargo build --release --manifest-path exes/samsrf/Cargo.toml \
  -p samsrf-core --features polyshape-experimental --example polyshape_hulls
oracle="$PWD/exes/samsrf/target/release/examples/polyshape_hulls"
cd packages/samsrf/validation/matlab
python3 -I polyshape_ordered_rings.py compare "$oracle" "$reproducers/ubuntu-22.04" \
  reproducer_round4 > round4.json
python3 -I polyshape_ordered_rings.py table h-touch-post,h-hull-grid,h-hull-polyshape round4.json
python3 -I polyshape_ordered_rings.py digest "$causal/ubuntu-22.04" causal_real
```

`compare` takes any polygon batch of the four recordings; its `summary` gives
each variant's first-difference counts.

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
- On 177's sliver ring, MATLAB's drop/keep follows start-independent
  vertex cleaning across 1,212 perturbations and two held-out copies, while
  that rule applied to every ring loses accepted cases elsewhere.
- 1-minimal reproducers of 6, 11, 8 and 8 points (above), with exact inputs,
  MATLAB's outputs on two hosts and both models' predictions made before
  recording.
- MATLAB's ordered rings: each causal and reproducer batch's canonical cycles
  and hole flags are frozen by digest. The first differing observable for every experimental hull failure on
  the original and real-cloud recordings is vertex survival.
- On the recorded polygons whose rings equal MATLAB's, the experimental
  model's additional convex-hull pass (H_G2) fixes 259 hulls and leaves 6
  unexplained. This does not establish MATLAB's internal operation.

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
- MATLAB's rule for pairing edges at touch vertices: mostly separate solids,
  but holes touching twice survive in some clouds (H_T above).
- Why MATLAB's vertex survival differs on near-collinear clouds, and why the
  six matching-ring cases still have different hulls under H_G2. Both vertex
  survival and the hull stage remain unresolved.

### Shipped and experimental models on the probe recordings

Report-only: no gate depends on this table, and it changes no baseline.
`core/examples/polyshape_hulls.rs` (built with the feature) counts the
polygons whose hull vertex set equals MATLAB's exactly; the gates also bound
area and centroid, which changes no count on the original families. Both
hosts give the same counts.

| Recording | Polygons | Shipped model | Experimental model |
| --- | ---: | ---: | ---: |
| Original families (`geometry-reference.json`) | 26,057 | 25,964 | 26,013 |
| Grid sweep and bisection (probe) | 27,648 | 27,648 | 27,648 |
| Held-out near-collinear clouds (probe) | 1,500 | 1,192 | 1,352 |
| Held-out mixed clouds (probe) | 1,500 | 1,435 | 1,470 |
| Extreme grids (probe) | 7 | 6 | 3, refuses 4 |
| Strip pairs (causal) | 8,424 | 7,866 | 8,424 |
| Sliver-width bisection (causal) | 1,152 | 954 | 1,152 |
| Holes at one contact (causal) | 170 | 170 | 170 |
| Held-out strip pairs (causal) | 600 | 568 | 600 |
| Real-cloud transforms (causal) | 403 | 308 | 157 |

The original family inventories are 11,907 boundary-ULP polygons, 6,480
relative-boundary polygons, 4,000 random thin polygons, 656 collinear-vertex
polygons, 498 spikes, 16 degenerate polygons and 2,500 point clouds. Their sum
is 26,057. Earlier totals overstated the inventory and both models' agreement
by 16; the 93 shipped and 44 experimental exceptions are unchanged.

To reproduce the original totals, set `geometry` to the directory extracted
from `geometry-reference.json` and run from the repository root in Bash:

```sh
set -euo pipefail
for model in production experimental; do
  printf '%s: ' "$model"
  for family in polygon_boundary_ulp polygon_boundary_relative polygon_random_thin \
    polygon_collinear_vertex polygon_spikes polygon_degenerate polygon_point_clouds; do
    cargo run --quiet --release --manifest-path exes/samsrf/Cargo.toml \
      -p samsrf-core --features polyshape-experimental --example polyshape_hulls \
      -- "${geometry:?Set geometry to the extracted recording}/ubuntu-22.04" "$family" "$model"
  done | awk '/ hull vertex sets equal / { equal += $3; total += $5 }
    END { printf "%d of %d hull vertex sets equal MATLAB\n", equal, total }'
done
```

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
| `conv` | Empirical | the shorter vector slides over the longer one (a kernel at least as long as the course swaps roles). When fewer than a quarter of the samples are nonzero (kernels of 9 taps or more, or of 2-8 taps shorter than the course), they are scattered in order, with each product fused or rounded and then added by the [block rule](#sparse-conv-blocks-730). Otherwise, kernels of fewer than 9 taps: one ascending accumulator, unfused for courses of at most 16 samples and fused otherwise; and longer kernels: fused multiply-adds over blocks of 24 input samples (8 for complex) with taps in `tap % 4` (`% 2`) order. A final partial block is grouped in whole vectors of 8 (4) samples, and its last samples follow in input order | every recorded prediction; the kept (first n) outputs of 294 + 1,318 probe convolutions; 105 pre-registered sparse courses (`conv_boundary.rs`) |
| `gampdf`, `a ≥ 1` | Empirical | Loader's saddle point as MATLAB evaluates it: `exp((-(log(2π) + log(k))/2 - stirlerr(k)) - bd0(k, x/b)) / b` with `k = a - 1` (the two logarithms separately since 0.6.20261114, [fitted-HRF kernels](#fitted-hrf-kernels-730)); `stirlerr` from a table at half-integers up to 15, Cody's `gammaln` elsewhere below 15 and the Stirling series above; `bd0` by its series near the mode, `x log(x/np) + np - x` away from it; `exp(-x/b)/b` for `a = 1` | 9,760 probe densities per host; out of sample, all six TRs' HRF kernels of the first recording and the pipeline's recorded kernel |
| `corr` | Empirical | real `x'*y` by MATLAB's pair tree below 51 elements and MKL 2021.3 `ddot` from 51, complex by `zdotc`, norms by `dnrm2`/`dznrm2` (reference-BLAS scaled sums), `dot/‖x‖/‖y‖`, then values beyond 1 in magnitude divided by their magnitude | every recorded objective; AMD probe kernels |

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
- every output SamSrf keeps (the first n) for all 294 convolutions of 1-129-tap
  kernels, dense and sparse (the 6 sparse complex courses of 1,000 samples since
  the [sparse conv block rule](#sparse-conv-blocks-730));
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
- the kept outputs of every convolution (1,318), including the 10 sparse complex
  courses longer than 800 samples, whose 95 outputs differed by one ULP near
  multiples of 512 before the [sparse conv block rule](#sparse-conv-blocks-730).
  `candidate_exclusions.rs`
  (`sparse_complex_conv_residual_lies_near_multiples_of_512`) localises them on
  the AMD host. With k the 0-based index into `conv(y, kernel)` (MATLAB's
  k + 1) and only the first numel(y) outputs compared, every one of the 95 lies
  between 15 below and 14 above the nearest multiple of 512 (all ten courses use
  33 taps). Of the 111 real or imaginary parts that differ, 26 match the port's
  dense path and 85 neither; 84 match a sum of two partial sparse sums split at
  some index, 27 match none. The test first requires its reconstruction of the
  sparse path to equal `convolve_complex` at every output. A recording that
  fingerprints the summation tree around 512 (FPRev's pair method, as
  `record_gemv_order.m` does for `y' * A`) would distinguish the hypotheses;
  the [focused probes](#focused-probes-729-730) made one with a ones kernel on
  these courses' nonzero patterns. There every output adds the window's nonzero
  samples in index order, so the split and tile hypotheses are rejected for those
  patterns; a summation-order change on the weighted inputs is not excluded.

None of the six closed-form candidates matches `gampdf` anywhere it matters, and
the identified formula was fitted on these probes. A bit-for-bit match on probes
shows agreement, not MATLAB's internal code. The out-of-sample checks are the
first recording's kernels at TR 0.5-3 (TR 2.5 and 3 were never used in fitting)
and the recorded pipeline kernel, all equal bit for bit.

Real `x'*y` below 51 elements takes MATLAB's own pair tree, which the port
follows since 0.6.20261114 ([arithmetic order](#arithmetic-order-729-730)). The
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

- **Coefficients beyond these cases.** Every kept Beta and Baseline of the three
  pinned AMD pipelines is bit-identical (the table above). The policy above
  stays in the gate for any coefficient that differs; it compares exact errors
  at a first-order scale and does not bound them. Other inputs, and MATLAB's
  AVX-512 host, are not covered.
- `gampdf` with shape below 1 and the zero signs.

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

## Constants, small-shape gampdf and double y' * A

`constants-gamma-gemv-reference.json` pins run
[43882331042](https://github.com/neurodesk/webapps/actions/runs/43882331042)
(`record_constants_gamma_gemv.m`, `probes=constants-gamma-gemv`, recorder
`a7014f1eb`): an AMD EPYC 9V74 (CNR `auto`) and an Intel Xeon 6975P-C
(`AVX512_E1`), each repeated exactly in a new process. The questions, models,
inputs and decision rules were committed before the run in
[`constants-gamma-gemv-predictions.md`](constants-gamma-gemv-predictions.md),
which also lists the results: the port's constant-course detrend and z-score are
MATLAB's on the AMD host, the small-shape gampdf candidate is rejected, and
production adopts the identified double `y' * A` order for connective-field
profiles. The Intel host is reported only.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-cgg" packages/samsrf/validation/matlab/constants-gamma-gemv-reference.json
python3 packages/samsrf/validation/matlab/fetch_x001_runs.py "$TMPDIR/samsrf-x001-runs"
SAMSRF_CGG_DIR="$TMPDIR/samsrf-cgg" SAMSRF_CGG_RUNS_DIR="$TMPDIR/samsrf-x001-runs" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test constants_gemv -- --nocapture
SAMSRF_CGG_DIR="$TMPDIR/samsrf-cgg" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --lib held_out_gamma -- --nocapture
```
