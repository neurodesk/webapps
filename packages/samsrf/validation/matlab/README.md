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
The workflow runs two independent processes on each of `ubuntu-22.04` and
`ubuntu-24.04`. Runner labels do not guarantee a CPU vendor. Use each receipt's
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

## Building a matching Runtime container

`build_container.py` is the build recipe for the repaired, version-matched
command-line reference. It verifies the SamSrf commit and exact repair bytes,
rejects additional tracked changes, and checks the SPM commit before invoking
MATLAB Compiler. It records the MATLAB environment and resulting local image
ID. It does not publish the image.

This recipe has not been executed with MATLAB Compiler. The source checks
have been exercised locally; successful source recordings do not validate the
compiled application or its container packaging.

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
47 and 88 from #730 and columns 73 and 22 from #731. Each original-aperture
case runs with both the saved coarse seed and a seed recomputed on the current
host. A separate nonnegative control recomputes its own coarse seed.
The recorder saves every objective call, raw/compressed/convolved prediction,
correlation reduction, optimizer iteration procedure, termination reason,
acceptance decision, and final QR factors and complex coefficients.
The objective remains the actual source `prf_errfun`; diagnostic computations
do not supply its return value. The callback uses the source's nonfinite stop
rule. This isolates CSS optimizer paths without rerunning the participant
matrix. Each completed case has a JSON receipt so a later failure retains it. It records actual MATLAB arithmetic;
Octave is used only for a syntax check of the recorder.

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

General double-precision fine-fit plateaus, double CSS weak fits, and single
reverse-correlation/CF arithmetic remain diagnostic cases. The single CSS
parameters and scores match exactly for this recorded pipeline; beta and baseline
retain the documented least-squares rounding tolerance. A successful source
gate does not assert those paths, arbitrary-input parity, or a rebuilt container.
