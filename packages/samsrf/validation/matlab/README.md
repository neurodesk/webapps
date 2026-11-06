# Real MATLAB source references

This recorder runs the web port's pinned SamSrf source in MATLAB R2023b. It
uses MATLAB's own optimizers, correlation, single arithmetic and geometry.
The existing [compiled container reference](../container/README.md) remains
an independent baseline for the unmodified Neurodesk application.

The source recorder is under development. Recording successfully is not a
parity assertion; its results must be compared with the web core before a
compatibility mode or new tolerance is accepted.

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
Public GitHub Actions runs are licensed by MathWorks
for MATLAB and the required toolboxes. A MATLAB Compiler license is needed
only to package a new standalone Runtime application; it is not needed for
this source-level comparison.

On a machine with MATLAB and the required toolboxes:

```sh
git clone https://github.com/samsrf/samsrf.git "$TMPDIR/samsrf-source"
git -C "$TMPDIR/samsrf-source" checkout 41ed1e96cc4d9b8b750f5594a61845df21ab8984
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-input"
python3 packages/samsrf/validation/matlab/prepare.py "$TMPDIR/samsrf-source" "$TMPDIR/samsrf-matlab"
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

On a Linux x86-64 host with MATLAB R2023b, MATLAB Compiler, the Statistics,
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
older Neurodesk image's Runtime.

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

`reference.json` pins the 584-case archive from runs
[42187489864](https://github.com/neurodesk/webapps/actions/runs/42187489864) and
[42194676865](https://github.com/neurodesk/webapps/actions/runs/42194676865).
The archive manifest hashes every file and identifies the supplemental cases.
It includes retained discrepancies; case count is not a passing-gate count.

`record_matlab=true, diagnostics_only=true` runs `record_css_diagnostics`
against those pinned inputs. This isolates full-pipeline CSS optimizer paths,
complex predictions, QR factors and least-squares coefficients without
rerunning the entire participant matrix. It records actual MATLAB arithmetic;
Octave is used only for a syntax check of the recorder.

The source gate is now executable:

```sh
python3 packages/samsrf/validation/container/download.py "$TMPDIR/samsrf-source-reference" packages/samsrf/validation/matlab/reference.json
node packages/samsrf/validation/matlab/compare.mjs "$TMPDIR/samsrf-source-reference" "$TMPDIR/samsrf-matrix-input"
SAMSRF_MATLAB_REFERENCE_DIR="$TMPDIR/samsrf-source-reference" cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-core --test matlab_reference
```

The Node comparator verifies every archive file hash, requires each tested case,
and checks individual vertices without map-wide error normalization. Its 105
required gates cover preprocessing, Benson import, single-precision Gaussian
forward pipelines and double-precision reverse-correlation pipelines. Fine-fit
parameters and scores in the single mode must match exactly; coarse scores and
least-squares coefficients have small absolute/per-value tolerances. No differing
vertex quota is allowed.

Native gates additionally cover all 14 raw optimizer cases, nine double-precision
CF modes from identical recorded profiles, and 251 polygon cases. Two polygons
(`polygon_191`, `polygon_193`) sit exactly on the inferred relative simplification
cutoff and retain scale-dependent rounding differences; they are explicitly
excluded from that assertion. CF checks from identical profiles isolate parameter
estimation, and do not establish full single-precision CF pipeline parity.

Full CSS pipeline fits, general double-precision fine-fit plateaus, and single
reverse-correlation/CF arithmetic remain diagnostic cases. A successful source
gate does not assert those paths, arbitrary-input parity, or a rebuilt container.
