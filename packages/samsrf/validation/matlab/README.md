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
does not change the computed maps. Replay still needs to resolve recorded
relative input paths and provide the recorded preprocessing and template data;
the port does not yet accept single-precision RC/CF models.

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
not port parity. There is no port acceptance gate or compiled Runtime evidence
for this new matrix yet. The new archives are separate from the 741-case pin.

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

## Building a matching Runtime container

`build_container.py` is the build recipe for the repaired, version-matched
command-line reference. It verifies the SamSrf commit and exact repair bytes,
rejects additional tracked changes, and checks the SPM commit before invoking
MATLAB Compiler. It records the MATLAB environment and resulting local image
ID. It does not publish the image.

This recipe has not been executed with MATLAB Compiler. The source checks
have been exercised locally; successful source recordings do not validate the
compiled application or its container packaging.

The source matrix above keeps numerical work independent of this build.
Free public MATLAB Actions [exclude Compiler](https://github.com/matlab-actions/setup-matlab#licensing).
A standard trial does not provide a durable substitute: MathWorks states that
[trial-built applications expire](https://www.mathworks.com/matlabcentral/answers/515199-do-apps-compiled-using-simulink-compiler-under-a-trial-license-expire)
and [trials cannot download previous releases](https://www.mathworks.com/matlabcentral/answers/2026102-how-do-i-download-and-install-previous-releases-of-matlab-or-the-mathworks-product-installer).
The public Neurodesk binaries remain the older stock baseline documented
separately. None of these routes establishes the matching compiled image.

On a Linux x86-64 host with MATLAB R2023b Update 11, MATLAB Compiler, the Statistics,
Image Processing and Parallel Computing toolboxes, and Docker:

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
the build process and generated container.

Run the image from a fresh writable results directory containing a copy of
the generated `SamSrf_defaults.json`. Set its `def_64bit` field to `true` for
the double reference or `false` for the default single reference. The
standalone application's defaults loader uses its starting directory. Mount
input files separately and pass their absolute container paths:

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$INPUT:/input:ro" -v "$RESULTS:/results" -w /results \
  samsrf-reference:41ed1e96-r2023b \
  prf /input/model '/input/lh_*.gii' -outpath=/results
```

The model argument omits `.json`, as required by `SamSrfAnalysis`; aperture
and other paths in that model must also resolve inside the container. Use a
new results directory for each case to avoid MATLAB's source/regressor
caches. Before publishing an image, run the same matrix through the compiled
CLI, compare its saved maps with the source reference, and record its immutable
registry digest. Until then, it is a build recipe, not a validated replacement
for the existing Neurodesk container.

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
coefficient comparisons use per-value relative tolerances (16 single-precision
epsilon units, approximately 1.9e-6, or 1e-12 for double), never a map-wide
scale. This allows the recorded rounding difference between MATLAB's single QR
and the stable double solve on rounded inputs. A 60-digit independent solve
confirmed the web result in the largest observed coefficient discrepancy.
Two polygons
(`polygon_191`, `polygon_193`) sit exactly on the inferred relative simplification
cutoff and retain scale-dependent rounding differences; they are explicitly
excluded from that assertion. CF checks from identical profiles isolate parameter
estimation, and do not establish full single-precision CF pipeline parity.

General double-precision fine-fit plateaus, remaining double CSS fits, and single
reverse-correlation/CF arithmetic remain diagnostic cases. The single CSS
parameters and scores match exactly for this recorded pipeline; beta and baseline
retain the documented least-squares rounding tolerance. A successful source
gate does not assert those paths, arbitrary-input parity, or a rebuilt container.

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

The new traces isolate a second overflow: the sequential dot accumulator
overflows before cancellation makes the final sum finite. At MATLAB column
60, evaluation 787 (zero-based), MATLAB's dot is 1.7973782649551213e308;
at column 69, evaluation 590, it is -1.7971496736890576e308. The old port
returned a nonfinite objective for both. Recomputing only overflowed dot
components with scaled inputs restores these calls and the complete native
optimizer parameter sequences, 800 and 723 evaluations respectively.
The scale is restored before norm division, preserving MATLAB's rejection
when the final dot itself overflows. Native tests require every objective's
finite/nonfinite decision across both vertices, both seeds and nonnegative
controls; the two failing calls additionally have a 16-double-epsilon absolute
objective bound. A pure-imaginary rotation checks the same correlation identity.
Remaining CSS differences, including column 82 and cancellation-sensitive
columns 16/17, are not treated as equivalent fits by these tests.

Double CSS squared norms could underflow or overflow even when predictions
were finite. A scaled norm for those extremes restores the recorded fit at
zero-based vertex 46 (R² 0.4461133943 becomes 0.04894233754) and the rejected
all-zero output at vertex 87. At vertex 80, MATLAB's rank warning reports a
tolerance of 24.78495. This is ten times the real QR tolerance; the earlier
`eps(norm(A,1))` inference gives 15.625 and wrongly retains the baseline column,
whose QR diagonal is 15.81078. The corrected rule passes the original 146
scale cases and the newly recorded pipeline regression.
The factor is measured directly for double precision. The same factor is used
for single precision, whose recorded cases agree but do not distinguish the
two rules. A separate native gate checks the overflowing design's tiny
amplitude against MATLAB within eight ULP, even though its final map is rejected.

The required CSS replay checks all 96 vertices' zero and nonfinite decisions.
At vertices 46, 59, 68, 80 and 87 it also requires exact parameters, noise ceilings and
zero coefficients. Nonzero amplitudes have a 16-double-epsilon relative bound;
R² and near-zero baselines have a 16-double-epsilon absolute bound. Every
remaining per-value difference is written to the report without a widened
tolerance. This is a focused regression gate, not full double CSS equivalence.
The existing single CSS and Gaussian gates remain required.

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-css-diagnostics" packages/samsrf/validation/matlab/diagnostics-reference.json
SAMSRF_CSS_DIAGNOSTICS_DIR="$TMPDIR/samsrf-css-diagnostics" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test css_diagnostics
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
