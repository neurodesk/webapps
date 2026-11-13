# @neurodesk/samsrf

A port of [SamSrf](https://github.com/samsrf/samsrf) (Samuel Schwarzkopf,
BSD-3-Clause, commit `41ed1e96`) for population receptive field (pRF) and
connective field (CF) mapping on the cortical surface. The Rust crate
`exes/samsrf/core` holds the port and `exes/samsrf/wasm` its wasm-bindgen
surface. This package wraps that one WebAssembly module for browsers
(`src/index.js`) and Node (`src/node.js`). The built module in `wasm/` is
committed.

```js
import { init, readGiftiRun, readApertures, RunAccumulator, parseModel } from '@neurodesk/samsrf';
await init();
const model = parseModel('prf', modelJsonText);
const apertures = readApertures(apertureBytes, 'mat');
const accumulator = new RunAccumulator(134260, roiVertices, { normalise: 'zscore', combine: 'average' });
for (const bytes of runFiles) {
  const run = readGiftiRun(bytes);
  accumulator.pushRun(run);
  run.free();
}
const { data, noiseCeiling } = accumulator.finish();
accumulator.free();
```

## Status

The port covers `SamSrfAnalysis` for GIfTI input: the file readers and
writers, apertures, model specifications, the MATLAB expression subset that
model files use, the pRF profile functions, HRFs, time-series preprocessing,
GIFTI export, and the three analyses (`samsrf_fit_prf`, `samsrf_revcor_prf`,
`samsrf_revcor_cf`) behind `createJob`. The options each analysis does not
support are listed under [Analyses](#analyses).

## API

Every function is synchronous after `init`. Errors are JavaScript `Error`s
whose message is SamSrf's, prefixed by the file format or `model:` where one
applies. Typed arrays returned to JavaScript are copies. Handles (`Run`,
`Apertures`, `RunAccumulator`) own WebAssembly memory: call `.free()` when
done.

Layouts. Coordinates are interleaved: `xy` holds `x` then `y` for each point,
and surface vertices hold `x, y, z`. Time courses are vertex-major: vertex
`v`'s course is `data[v * volumes .. (v + 1) * volumes]`. Map rows are
row-major: row `r` of vertex `v` is `data[r * vertices + v]`. Matrices
from the expression language and MAT files are column-major, as in MATLAB.
Vertex indices are 0-based.

### Loading

| Signature | Description |
| --- | --- |
| `init(input?) → Promise` | Loads the module once. `input` (a `WebAssembly.Module`, URL, `Response` or bytes) goes to the wasm-bindgen glue; without it the glue fetches `wasm/samsrf_wasm_bg.wasm` beside itself. |
| `initSync({ module })` | Loads the module synchronously from a `WebAssembly.Module` or its bytes. |
| `version() → string` | The crate version. |

### Readers

All readers take the file's bytes as a `Uint8Array`.

| Signature | Description |
| --- | --- |
| `readGifti(bytes) → { arrays: [{ intent, dataType, dims, data }] }` | Every DataArray of a GIFTI file. `dataType` is `'float32'`, `'int32'` or `'uint8'`; `data` is a `Float64Array`, column-major for 2-D arrays. |
| `readGiftiRun(bytes) → Run` | A functional run: one DataArray per volume over every vertex, stored float32 in WebAssembly memory. |
| `run.volumes`, `run.vertices` | The run's size. |
| `run.course(v) → Float32Array` | A copy of vertex `v`'s time course. |
| `run.free()` | Releases the run. |
| `readGiftiSurface(bytes) → { vertices, faces, faceSize }` | A GIFTI mesh: `vertices` is a `Float64Array` of `n * 3`, `faces` a `Uint32Array` of `m * faceSize`. |
| `readFreeSurferSurface(bytes) → { vertices, faces, faceSize }` | A FreeSurfer triangle (`faceSize` 3) or quad (`faceSize` 4) surface. |
| `readFreeSurferCurv(bytes) → Float64Array` | A curvature-format file (`lh.curv`, `lh.area`, `lh.thickness`). |
| `readFreeSurferLabel(bytes) → { vertices, coordinates, values }` | A `.label` file in file order: `Uint32Array` indices, `Float64Array` `x, y, z` triples and values. |
| `readAnatomy({ white, pial, inflated, sphere, curv, area, thickness? }) → { white, pial, inflated, sphere, curvature, area, thickness, normals }` | A FreeSurfer `surf` folder for one hemisphere. `white` is a mesh, the others `Float64Array`s; `thickness` is `null` when not given; `normals` is pial minus white. Every file must have the white surface's vertex count. |
| `readMat(bytes) → { [name]: { class, dims, data } }` | The numeric variables of a MAT v5 file. `class` is the MATLAB class name; `data` is a column-major `Float64Array`. Character, cell and struct variables are skipped; v7.3 files are refused. |
| `readOldSchoolHrf(bytes) → Float64Array` | The four `fP` values of an old-school `hrf_*.mat` fit. |

### Apertures

| Signature | Description |
| --- | --- |
| `readApertures(bytes, format) → Apertures` | Reads an aperture file. `format` is `'mat'` (`ApFrm`, vectorised or a movie), `'nii'` (`.nii` or gzipped `.nii.gz`) or `'gif'`. A movie is vectorised as `VectoriseApertures` does. |
| `apertures.width`, `.height`, `.volumes` | The aperture size. A vectorised file whose `ApXY` is not a grid has height 1. |
| `apertures.scaledXy(scalingFactor) → Float64Array` | `ApXY / max(abs(ApXY(:))) * scalingFactor`, interleaved, `pixels * 2`. |
| `apertures.toDense() → Float64Array` | `ApFrm`, pixels x volumes, column-major. |
| `apertures.serialize() → Uint8Array` | A compact binary copy to post to a Web Worker. |
| `Apertures.deserialize(bytes) → Apertures` | Rebuilds apertures from `serialize()` output; refuses truncated or damaged bytes. |
| `apertures.free()` | Releases the apertures. |

The serialised form is little-endian: the magic `SAMSRFAP`; u32 version (1),
width, height, volumes and a conditions flag; `width * height` f64 `(x, y)`
pairs; with the flag, one f64 condition label per volume; then for each frame
a u32 count, that many u32 pixel indices and that many f64 values.

### Model and expressions

| Signature | Description |
| --- | --- |
| `parseModel(kind, json) → object` | Parses a model JSON file for `'prf'`, `'rc'` or `'cf'` and applies `samsrf_model_defaults`. The result is the typed model with camelCase fields: `{ kind: 'prf', name, prfFunction: { source, params }, paramNames, scaledParam, onlyPositive, scalingFactor, tr, hrf, apertureFile, params, fineFit, ... }`. `hrf` is `{ type: 'spmCanonical' \| 'none' \| 'deHaas' \| 'fit' }`, `{ type: 'vector', values }` or `{ type: 'oldSchoolFile' \| 'vertexWiseFile', file }`. A non-finite number reads as `null`, as JSON has none. |
| `evaluateExpression(source, args) → { rows, cols, data }` | Evaluates an anonymous function such as `@(P,ApWidth) prf_gaussian_rf(P(1),P(2),P(3),ApWidth)`. Each argument is a number, an array (a column) or `{ rows, cols, data }`. |

### pRF

| Signature | Description |
| --- | --- |
| `prfProfile(source, params, xy) → Float64Array` | A pRF profile. `source` is a profile function name (`'prf_gaussian_rf'`, called with the parameters as scalars) or an anonymous function source (called as `f(params, xy)`). `xy` is interleaved coordinates (`n * 2`), or a number for the `xy x xy` screen grid, returned column-major. |
| `predictTimecourse(rfp, apertures) → Float64Array` | `prf_predict_timecourse`: the percent overlap of the profile with each frame. |
| `pearson(x, y) → number` | Pearson correlation; `NaN` for a constant input or one containing `NaN`. |
| `errfun({ prfFunction, apertures, xy, hrf, params, observed, downsampling = 1, cssNonlinearity = false }) → number` | `prf_errfun`: `1 - r^2` between the convolved prediction and `observed`. `prfFunction` is a source string or a parsed model's `prfFunction`. `hrf` is a kernel, or `{ fit: tr }` to build it from the last five parameters. |

### HRF

| Signature | Description |
| --- | --- |
| `hrf.doublegamma(tr, p?) → Float64Array` | `samsrf_doublegamma`: `p` replaces the leading SPM defaults `[6 16 1 1 6 0 32]`. |
| `hrf.spmCanonical(tr) → Float64Array` | SPM's canonical double gamma (`Hrf = 0`). |
| `hrf.deHaas(tr) → Float64Array` | `samsrf_hrf`, the de Haas et al. (2014) HRF (`Hrf = []`). |
| `hrf.oldSchool(tr, fp) → Float64Array` | The kernel of an old-school `hrf_*.mat` fit: `samsrf_doublegamma(TR, [fP(1:2) 1 1 fP(3) 0 32]) * fP(4)`. |
| `hrf.convolve(y, kernel, downsampling = 1) → Float64Array` | `prf_convolve_hrf`: the convolution truncated to `y`'s length, then every `downsampling`-th sample. |
| `hrf.resolve(spec, tr) → { type: 'kernel', values } \| { type: 'none' } \| { type: 'fit' }` | Resolves a parsed model's `hrf`. Throws for `oldSchoolFile` and `vertexWiseFile`, naming the file the caller must load. |

### Preprocessing

| Signature | Description |
| --- | --- |
| `new RunAccumulator(totalVertices, keep, options)` | Combines runs as `samsrf_gii2srf` does, one run at a time. `keep` is a `Uint32Array` of the vertices to keep, or `null` for all. `options` defaults to `{ normalise: 'zscore', combine: 'average', noiseCeiling: true, globalSignal: false, precision: 'double' }`: `normalise` is `'none'`, `'detrend'` or `'zscore'` (detrend, then z-score); `combine` is `'average'` or `'concatenate'`; `noiseCeiling` applies when averaging two or more runs; `globalSignal` keeps the mean across every vertex, kept or not; `precision` (`'double'` or `'single'`, the model's `Data_Precision`) computes that mean as MATLAB does on data of that class. |
| `accumulator.pushRun(run)` | Normalises a `Run` and folds it in. Every run must have the same size. |
| `accumulator.finish() → { kept, totalVertices, runs, volumes, vertices, data, noiseCeiling, globalSignal }` | The combined, vertex-major `data` of the kept vertices (`kept` is `null` when all are kept), with `noiseCeiling` and `globalSignal` as `Float64Array`s or `null`. |
| `accumulator.free()` | Releases the accumulator. |
| `detrend(x) → Float64Array` | MATLAB `detrend`: removes the least-squares line. |
| `zscore(x) → Float64Array` | MATLAB `zscore` with the `n - 1` standard deviation. |
| `noiseCeiling(odd, even) → number` | The Spearman-Brown noise ceiling `2r / (1 + r)` of the odd-run and even-run means. |
| `removeNoise({ volumes, vertices, data }, covariates, nCovariates) → Float64Array` | `samsrf_removenoise`: regresses z-scored covariates (column-major, `volumes x nCovariates`) and an intercept out of every course; a course containing `NaN` becomes zeros. |

### Export

| Signature | Description |
| --- | --- |
| `exportGiis({ values, vertices, data }, prefix, selection = null, convention = 'samsrf-10.4') → [{ name, bytes }]` | `samsrf_export_giis`: one GIFTI per map row, named `{prefix}_{lower(name)}.gii` with spaces as `_` (`lh_pRF_Gaussian_r^2.gii`, `lh_pRF_Gaussian_noise_ceiling.gii`), preceded by `{prefix}_pol.gii` and `{prefix}_ecc.gii` when the maps hold `x0`. `selection` names the rows to export, case-insensitive; `'Polar'` and `'Eccentricity'` select the derived maps. |
| `writeGiftiMap(values) → Uint8Array` | One float32 per-vertex map as SPM's `gifti/save` writes it. |
| `polarAndEccentricity({ values, vertices, data }, convention = 'samsrf-10.4') → { polar, eccentricity } \| null` | Polar angle in degrees and eccentricity from rows 2 and 3 (`x0`, `y0`), eccentricity 0 where row 1 (`R^2`) is 0; `null` without an `x0` row. |

`convention: 'samsrfx-10.003'` reproduces the older Neurodesk container's
float32 derived maps and eccentricity offset of −0.5. The app and CLI read
`Export_Convention` from model JSON; the app also exposes it under Advanced
settings. This affects map display/export, not fitting precision. The geometric
default has no offset. See the [actual container comparison](validation/container/README.md).

### Analyses

| Signature | Description |
| --- | --- |
| `createJob(spec, onProgress?) → Job` | Prepares an analysis (for `prf`, the search space: `onProgress(done, total)` reports grid points). `spec` is `{ kind: 'prf' \| 'rc' \| 'cf', model: string, apertures?: Uint8Array /* Apertures.serialize() */, hrf?: Float64Array \| 'fit' \| 'none', data: { volumes, vertices: Uint32Array, courses: Float64Array /* vertex-major */ }, roi?: Uint32Array, noiseCeiling?: Float64Array, globalSignal?: Float64Array, seed?: { vertices: Uint32Array, template: { values: string[], vertices, data: Float64Array } }, surface?: { vertices: Float64Array, faces: Uint32Array }, area?: Float64Array, seedFineFit?: { values, data }, totalVertices: number }`. `data.vertices` are the vertices with a time course (0-based, any order); `roi` is `mver` in label order (default: every kept vertex) and must be a subset of them; `noiseCeiling` is per kept vertex; `globalSignal` is per volume (`cf` with `Global_Signal_Correction`); `seed` (cf) is the seed label in file order and the template maps over every vertex (`readBensonTemplate`); `surface` is needed for `Smoothing`; `area` (cf) is `Srf.Area` over every vertex; `seedFineFit` (prf) replaces the coarse fit with `R^2` and parameter rows over every vertex. `hrf` overrides the model's HRF, for file-backed kernels. |
| `job.vertexCount` | `length(mver)`: the vertices the job analyses. |
| `job.analysed` | Those vertices, in label order. |
| `job.values` | `Srf.Values` of the per-vertex rows (before the noise ceiling and `nR^2`). |
| `job.modelName`, `job.outSuffix` | SamSrf's output name is `${hemisphere}_${modelName}${outSuffix}` (`_CrsFit`, `_Css`, `_Rcp`). |
| `job.run(start, end, onProgress?) → Uint8Array` | Analyses positions `[start, end)` of `analysed` and returns a self-describing partial result to `postMessage`; `onProgress(done, count)`. |
| `job.merge(partials) → { maps, raw, analysed }` | Merges partials that cover `[0, vertexCount)` exactly once into `Srf.Data` over every vertex (`maps`), with the `Noise Ceiling` row and, for `prf`, `samsrf_normr2` applied; `raw` is `Srf.Raw_Data` (`rc`) or `null`; `analysed` the sorted analysed vertices (`null` for all). |
| `mergePartials(job, partials)` | `job.merge(partials)`. |
| `job.free()` | Releases the job. |
| `readBensonTemplate(bytes, hemisphere = 'lh') → { values, vertices, data }` | `samsrf_benson2srf` on a Benson GIFTI (polar angle, eccentricity, ROI arrays): the template maps `R^2`, `x0`, `y0`, `Sigma` (NaN), `ROI`, computed in single precision as MATLAB does on the GIFTI's `single` data; `'rh'` flips `x0`. |

What each analysis implements, and the SamSrf options the job refuses with
`... is not supported by this port`:

- **`prf`** (`samsrf_fit_prf`): `prf_generate_searchspace` (including its
  `ndgrid(Param2, Param1, ...)` order and `Polar_Search_Space`), the HRF
  convolution with `Downsample_Predictions`, the coarse fit (`corr` with
  `Only_Positive_Coarse_Fits`, `Coarse_Fit_Percentile`, `Coarse_Fit_Only` with
  its betas), the fine fit with `fminsearch` (`Nelder_Mead_Tolerance`) or
  `samsrf_hookejeeves` (`Hooke_Jeeves_Steps`, scaled by `Scaling_Factor`),
  `Hrf = Inf` (the five HRF parameters appended, seeded with SPM's canonical),
  `Compressive_Nonlinearity`, `Fine_Fit_Threshold`, the bad-fit filter with
  `Only_Positive` 1 and -1, `Replace_Bad_Fits`, `Aperture_Mean_Response`,
  `Noise_Ceiling_Threshold`, `Seed_Fine_Fit` (as maps), the betas, the noise
  ceiling row and `samsrf_normr2`. Not supported: `Smoothed_Coarse_Fit`,
  vertex-wise HRF files and the pRF-from-CF analysis (`SeedRoi` in a pRF model).
- **`rc`** (`samsrf_revcor_prf`): the convolved pixel regressors, the profile
  `[Y 1] \ X`, peak, `Fwhm`, `Beta`, `R^2`, `Allow_Negative_Peaks`, the convex
  hull (`Prf_Function = 0`, `Convex_Hull_Threshold`) and the 2D model fit
  (`samsrf_fit2dprf` with `SeedPar_Function`, `R2_Threshold`, Nelder-Mead or
  Hooke-Jeeves). Not supported: `Micro_Probing`, `Save_Rmaps` (the `Rdim`
  downsampling only feeds the saved profiles) and a model fit on non-square
  apertures.
- **`cf`** (`samsrf_revcor_cf`): `Global_Signal_Correction`, the correlation
  with the seed courses, `Smoothing` (`samsrf_geomatrix` on the surface),
  `Fwhm`, `Vx` and `Fit_pRF` 0 (convex hull of the suprathreshold cluster on
  the Delaunay triangulation of the template coordinates), -1 (summary
  statistics) and 1 (2D Gaussian fit). Not supported: `Save_Rmaps`.

## Sharding an analysis in a browser

A browser runs one WebAssembly instance per Web Worker and splits the courses
between them:

1. The main thread reads the runs, preprocesses them with `RunAccumulator` and
   reads the apertures. It builds one `spec` for `createJob`, with
   `apertures: apertures.serialize()`.
2. It starts N workers and posts the same `spec` to each. Typed arrays are
   structured-cloneable, so the message needs no conversion.
3. Each worker calls `init()`, `createJob(spec)` (each worker generates the
   search space itself: about 10 s for the example grid) and
   `job.run(start, end, onProgress)` on disjoint ranges of
   `[0, job.vertexCount)`, posting each returned partial back.
4. One worker calls `job.merge` on all partials, then `exportGiis` on the
   merged maps with the prefix `${hemisphere}_${job.modelName}${job.outSuffix}`.

## Node helpers

`@neurodesk/samsrf/node` loads the module synchronously when imported and
re-exports the whole API, plus:

| Signature | Description |
| --- | --- |
| `readRunFile(path) → Run` | `readGiftiRun` on a file. |
| `readAperturesFile(path) → Apertures` | `readApertures` with the format from the extension: `.mat`, `.nii`, `.nii.gz` or `.gif`. |
| `readLabelFile(path)` | `readFreeSurferLabel` on a file. |
| `readAnatomyFolder(dir, hemisphere)` | `readAnatomy` on `dir/<hemisphere>.white`, `.pial`, `.inflated`, `.sphere`, `.curv`, `.area` and, when present, `.thickness`. `hemisphere` is `'lh'` or `'rh'`. |
| `preprocessRuns(paths, { keep, ...options }) → result` | Reads the runs one at a time into a `RunAccumulator`, freeing each, and returns `finish()`. |
| `readAnalysisInputs({ runs, roi?, seed?, apertures?, template?, white?, area?, hemisphere?, normalise = 'zscore', combine = 'average', precision = 'double' }) → inputs` | Reads an analysis's files as the web app does: the runs preprocessed keeping the ROI and seed vertices (every vertex without `roi`), with the noise ceiling and global signal (`precision` is the model's `Data_Precision`); the serialised apertures; the Benson template (`x0` flipped for `'rh'`); the white surface and areas. Paths left out are `null`. |
| `analysisSpec(inputs, kind, model, { roi }?) → spec` | The `createJob` spec for `kind` on `readAnalysisInputs` output. `model` is the JSON text or object; `roi` overrides the label's vertices. |
| `runJob(job, shards = 1, onProgress?) → merged` | `job.run` over `[0, vertexCount)` in `shards` pieces in this thread, then `job.merge`. |
| `shardRanges(total, shards) → [[start, end], ...]` | The ranges `runJob` and the command line split the vertices into. |

Errors from `readRunFile`, `readAperturesFile` and `readLabelFile` start with the file's path.

## Command line

`bin/samsrf.js` runs one analysis as `SamSrfAnalysis` does, on the same
WebAssembly module, and writes the files the web app downloads:

```sh
samsrf rc pRF.json results --runs lh_uBars1.gii lh_uBars2.gii --roi lh.V123.label \
  --apertures aps_Bars.mat
samsrf prf pRF_Gaussian.json results --runs lh_uBars*.gii --roi lh.V123.label \
  --apertures aps_Bars.mat --shards 8
samsrf cf CF_Rcp.json results --runs lh_uBars*.gii --roi lh.V123.label \
  --seed lh.V1_seed.label --template lh_benson.gii --surf surf
```

The first argument is the analysis (`prf`, `rc` or `cf`), then a SamSrf model
JSON file and an output directory that must be new or empty. Every file name
after `--runs` up to the next option is a run. The other options:

| Option | Meaning |
| --- | --- |
| `--roi FILE` | Label of the vertices to analyse; default every vertex. |
| `--apertures FILE` | `.mat`, `.nii`, `.nii.gz` or `.gif` apertures; required by `prf` and `rc`. |
| `--seed FILE`, `--template FILE` | Seed label and Benson template GIfTI; required by `cf`. |
| `--surf DIR` | Reads `<hemisphere>.white` (for `Smoothing`) and `<hemisphere>.area` (for `cf`) from a FreeSurfer `surf` folder. `--white FILE` and `--area FILE` name them one by one. |
| `--hemisphere NAME` | `lh`, `rh`, `bi` or `srf`. Inferred from matching FreeSurfer or BIDS names across runs, labels, template and anatomy. CF requires `lh` or `rh`; conflicting names are rejected. |
| `--no-normalise` | Keeps each run as it is (`samsrf_gii2srf` with normalisation off); default detrend and z-score. |
| `--concatenate` | Concatenates the runs; default average, with the noise ceiling for two or more runs. |
| `--shards N` | Splits the vertices over N worker threads, each with its own module. The maps do not depend on N. |

It reads the inputs with `readAnalysisInputs` (the runs keep the ROI and seed
vertices, so the noise ceiling is 0 outside them), runs the job with a progress
line on standard error, and writes `exportGiis(maps,
'<hemisphere>_<Name><suffix>')` (`lh_pRF_Rcp_r^2.gii`, ...) and
`<prefix>_provenance.json`: the package and core versions, the model, the
options, each input with its SHA-256, the analysed vertex count, the map names
and the wall time. Errors print one line on standard error, starting with the
file they concern, and exit with status 1.

`samsrf self-check` fits a coarse pRF to a course generated from a known
Gaussian on a 5 x 5 in-memory aperture and prints the runtime as JSON.
`samsrf download-models` installs nothing (SamSrf has no model files); the
portable packager calls it.

The portable archives come from `exes/node-cli` (`release.json`,
`.github/workflows/samsrf-native.yml`). Each must pass
`validation/cli-check.mjs`: `rc` on the example's whole V1-V3 label in three
shards, and the Nelder-Mead `prf` fit and `cf` on its first 200 vertices, each
GIfTI byte-identical to the same job run in-process through `src/node.js`, with
fixed file names, 134260 values per map and pinned counts of vertices with
R^2 > 0.1. It downloads the pinned example from `apps/samsrf/examples.json`
into a cache under the temporary directory, or reads it from
`SAMSRF_WEBAPP_EXAMPLE_DIR` when the bytes match. `test/cli.test.js` covers the
argument errors, `self-check` and, with `SAMSRF_WEBAPP_EXAMPLE_DIR`, a short
sharded `rc` run.

## Comparing with MATLAB

Use the same input bytes, model JSON, normalization, run combination and run
order. The app sorts selected runs lexically (`1, 10, 11, 2`), as MATLAB's
`dir` does; the CLI and automation preserve an explicitly supplied order.
Odd/even run splitting changes the noise ceiling when order changes. Mixed
hemispheres cannot run and ambiguous folder slots are rejected. Individual
inputs can be replaced while Run is disabled; Clear inputs starts a new dataset.
Template, area and
analysis surface vertex counts must match the functional runs.

The bundled X001 example now contains the original whole-surface functional
runs. Earlier releases zeroed vertices outside V1–V3: pRF inputs within that
ROI were unchanged, but CF's global-signal regressor was different. Use the
current pinned example when comparing CF maps.

Presets follow SamSrf's model scripts except horizontal tuning, which follows
the GUI `.mod` grid (unscaled Mu). Circular tuning fixes the scale at 1.
Imported or manually edited JSON grids are preserved when the radius changes.
Custom HRF kernels can be supplied in JSON; HRF file loading is not exposed by
the app. Model wrapper scripts can additionally wrap angles or derive aspect
ratio; this app implements the `SamSrfAnalysis` path without those wrappers.

Run MATLAB in a fresh results directory. Its `src_<Name>.mat` search-space
cache and `reg_<aperture>.mat` convolved-regressor cache validate dimensions,
not all input contents and settings. Reusing those files after changing an
aperture, grid, HRF, TR or scale can silently change the comparison.

## Building the WebAssembly module

After changing `exes/samsrf/core` or `exes/samsrf/wasm`, rebuild and commit
`wasm/`:

```sh
pnpm --filter @neurodesk/samsrf build:wasm
```

`scripts/build-wasm.sh` needs Rust 1.98.1 (through rustup), wasm-pack 0.13.1
and binaryen `version_117` `wasm-opt` first on `PATH`. The build removes the
optional WASM `producers` section: the release and cargo-installed binding
generators identify the same version differently. The `wasm-source` job in
`.github/workflows/samsrf-native.yml` on `ubuntu-24.04` is the canonical release
builder. It runs `build-wasm.sh --check`, which fails when any file differs from
`wasm/`. Matching tool versions alone do not guarantee byte equality elsewhere:
local and CI Rust builds produced different JSON deserializer inlining.

CI retains a differing rebuild, the raw Rust module, the optimizer input and
tool identities as an artifact. Locally, set `SAMSRF_REBUILD_DIR` to capture the
optimizer input and keep the files after a failed check. Dispatch `samsrf-native`
with `wasm_only: true` while the PR stays in draft, download
`samsrf-differing-rebuild`, and validate its `samsrf_wasm_bg.wasm` with the reference
gates before committing it. The final ready PR must pass the full workflow,
including a fresh byte-for-byte rebuild of that committed module.
The same workflow runs the core tests, clippy and `node --test
packages/samsrf/test/*.test.js` on the committed module.

`test/example.test.js` reads SamSrf's example subject X001 when
`SAMSRF_EXAMPLE_DIR` names its folder, and skips otherwise.

## Validation

[validation/README.md](validation/README.md) compares this package on the
example subject with SamSrf's own code run in Octave, and lists every check
with its result and the native and WebAssembly errfun timings.
[validation/octave/README.md](validation/octave/README.md) describes how the
reference is produced.
[validation/container/README.md](validation/container/README.md) adds actual
MATLAB Runtime references, a controlled precision comparison and CI gates.
[validation/matlab/README.md](validation/matlab/README.md) adds the pinned
MATLAB R2023b source matrix, per-vertex gates and the limits of each assertion.

## Divergences from SamSrf

- **Precision.** Double arithmetic remains the default. Model JSON can select
  `"Data_Precision": "single"`: processed courses and noise ceilings are
  rounded before selection, the fitting objective uses mixed single/double
  arithmetic, and saved maps are rounded as in SamSrf. Reverse correlation
  with the convex hull (`rc` without `Prf_Function`) and connective fields with
  `Fit_pRF` 0 or -1 follow MATLAB's single correlations, regressions, smoothing,
  thresholds and medians; preprocessing's `precision` option makes the global
  signal single too. Single `cf` Gaussian and `rc` 2D fits remain refused:
  no end-to-end acceptance bound is established outside the recorded cases.
  Internal raw-input CF tests match the AMD reference, but the empirical single
  `exp`, `sin` and `cos` candidates retain discrepancies. On the whole X001
  Benson atlases, 10 LH and 9 RH vertices have a one-ULP coordinate difference;
  affected seed regions can change Gaussian fits. The internal evidence does
  not enable those fits through the API, command line or app. Internally, single
  `rc` 2D fits evaluate `samsrf_fit2dprf`'s objective and `R^2` in single as
  MATLAB does and equal its recorded maps on the AMD host from raw runs; they
  stay refused for the same reason.
  [validation/matlab/README.md](validation/matlab/README.md#reverse-correlation-port-gates)
  lists the limits and the remaining MKL differences. It does not promise
  bit parity: MATLAB's BLAS backend, coarse matrix products and the final GLM can differ by single-
  precision rounding. The GLM runs in single arithmetic, as MATLAB's mixed
  `[ones x] \ y` does (see Correlations and regressions). The reduction order targets
  the recorded R2023b compatible backend; MATLAB's AVX-512 path can itself
  produce different fits on identical inputs. SamSrf converts Srf data to
  single precision (`samsrf_32bit_srf`). Its 64-bit opt-out tests
  `exist('SamSrfDefs.defs_64bit', 'var')`, a variable that never exists, so the
  conversion always happens. This can change coarse seeds and fine-fit optimizer
  paths, not just the final rounding. The Octave harness defaults to double; its
  `SAMSRF_REFERENCE_PRECISION=single` mode retains the upstream conversion.
  Neither Octave mode establishes equivalence to an actual MATLAB run. A separate
  compiled MATLAB Runtime probe now matches the web core's Gaussian fine-fit
  parameters within 2.8e-14 on 20 vertices when observations use the same double
  precision; the default-single container still differs by up to 0.001318° in y0.
- **Detrending.** `detrend` solves the centred normal equations, where MATLAB
  uses QR. The two agree to about 1e-14 of the course's scale.
- **Double gamma.** `samsrf_doublegamma` with more than seven parameters
  ignores the extra values; MATLAB errors.
- **z-score.** A zero standard deviation gives zeros, as MATLAB's `zscore`
  does, so a constant course (the medial wall) is 0, not `NaN`.
- **Averaging with the noise ceiling.** The odd and even runs are summed
  separately and the mean is their combined sum, so the summation order
  differs from SamSrf's run-by-run average (within rounding).
- **Export defaults.** `exportGiis` without a selection exports the polar angle
  and eccentricity maps, as the help text of `samsrf_export_giis` says. The
  code's default selects only the rows of `Srf.Values`, which leaves them out.
- **Labels.** The label reader parses five columns per line (index, x, y, z,
  value). `Read_FreeSurfer` reads six `%n` fields per row.
- **gampdf.** For shapes of at least 1, which every HRF uses, `gampdf` is
  Loader's saddle-point form as MATLAB evaluates it (`stirlerr`, `bd0`), and the
  de Haas and SPM kernels equal MATLAB's bit for bit. Shapes below 1 keep the
  closed form with `lgamma`, which differs from MATLAB by a few ULP. The formula
  was identified from MATLAB's recorded densities; see `validation/matlab/README.md`.
- **Old-school HRF.** An `hrf_*` file is turned into one kernel. Since
  26/08/2026, `samsrf_fit_prf`'s fine fit would mistake that kernel's row
  vector for vertex-wise HRFs.
- **Correlations and regressions.** `corr` is a dot product of centred,
  unit-norm courses. The forward and CSS Beta and Baseline come from
  `lstsq`, MATLAB's `[ones x] \ y`: column-pivoted Householder QR in the
  design's class (single when the observations are single, as MATLAB converts
  the design), MATLAB's rank rule and back substitution. Real and imaginary
  coefficients are both computed; the exported maps keep real parts, as
  `samsrf_expand_srf` does. The rank tolerance is `max(m, n) * eps * |R(1,1)|`,
  ten times that when an imaginary part survives conversion to the class. A
  constant prediction, or one constant to rounding, leaves the column with the
  larger norm its coefficient and the other 0. Octave's `\` uses no such
  tolerance, so on the example's coarse fit it reports amplitudes near 1e13 on
  9 vertices where the port reports 0. Scalar steps follow reference LAPACK
  3.9, the version MATLAB's MKL reports. The inner products, divisions and
  multi-column back substitution follow MKL's own kernels as MATLAB runs them
  on AMD hosts, read from MKL's summation trees and recorded chains (validation
  README, "MKL's kernels"): `?nrm2`, `?gemv` inside `?geqp3`, `?ormqr` and
  `?unmqr` by number and position of right-hand sides, `?trsv` and `?trsm`.
  `?geqp3`'s column update ends each reflector at its last nonzero entry, as
  `xLARF` does. On the 348 recorded designs every rank and rank warning
  tolerance matches, every step of every recorded MKL chain is reproduced bit
  for bit, 346 are bit-identical to MATLAB and the other two differ only in
  the sign of an imaginary zero MATLAB stores as real. All 404 recorded real
  8-column solves are bit-identical. MKL's AVX-512 branch on Intel rounds
  differently, and MATLAB ignores MKL branch requests, so results on Intel
  hosts are not reproduced. `mldivide_many` solves several right-hand sides
  at once as MATLAB's `A \ B` does, which the single RC profile and global
  regression use; complex multi-column solves are not modelled. Nonfinite
  converted inputs give NaN coefficients.
- **Compressive nonlinearity.** `Css_Convention: "nonnegative"` (the default)
  clips negative responses before the CSS power and uses the fitted Exponent
  for post-fit betas. `Css_Convention: "samsrf"` retains MATLAB's complex
  powers and its final-parameter post-fit formula: with concurrent HRF fitting
  that parameter is AmpRat. Exported maps retain real components, as SamSrf
  10.4's `samsrf_expand_srf` does. Raw optimizer cases match the actual
  MATLAB recordings in both precisions, and the recorded single-precision
  pipeline (`pipeline_single_css`) matches every map value exactly, Beta and
  Baseline included (`compare.mjs`). The 741-case reference's general double
  fine-fit plateaus and other double CSS fits are diagnostic there, not gated.
  The double objective follows MATLAB R2023b stage by stage
  (`exes/samsrf/core/src/matlab_math.rs`). It uses ported fdlibm `log`, `sin` and
  `cos` with `libm` `exp` and `pow`. MATLAB's complex power of a negative
  response, its `conv` and the MKL dot products and norms inside `corr` are
  empirical models, checked on recorded inputs.
  All 108 recorded CSS optimizer traces (54 double, 54 single) follow MATLAB's
  parameter sequences bit for bit. With the port's own HRF, which equals MATLAB's
  kernel, the recorded 96-vertex double pipelines (original apertures and a
  nonnegative control, on MATLAB's AMD reference host) match every fitted
  parameter, R², nR², noise ceiling, Beta and Baseline exactly: 138 of 138 kept
  coefficients of the original pipeline and 126 of 126 of the nonnegative one.
  The gate still compares any differing coefficient with the exact
  least-squares solution under a stated policy; that policy is a scale, not a
  bound, and the bit-identical counts hold for these recorded cases only.
  The limits of each operation,
  and why MATLAB on Intel hosts gives other results, are in
  `validation/matlab/README.md#double-css-arithmetic`.
  The coefficient QR solve takes scaled norms, so large regressors do not overflow.
  This option does not imply arbitrary-input bit parity.
- **Maps outside the ROI.** `samsrf_compress_srf` keeps the ROI's columns and
  `samsrf_expand_srf` zero-fills the rest, so every exported map is 0 outside
  the analysed vertices, the `Noise Ceiling` row and the NaN rows of a rejected
  `rc` model fit included; `nR^2` is 0 there too.
- **Template precision.** `readBensonTemplate` retains double scalar constants
  until each mixed operation is rounded to single, as MATLAB does, and uses
  empirical candidates for MATLAB's single `sin` and `cos`: fdlibm's float kernels with the x/4 term of
  `__kernel_cosf` keeping 11 fraction bits. Every recorded MATLAB template
  equals the reader's. Over every single angle up to 2^7 pi/2 the functions
  differ from MATLAB's on 36,350 (`sin`) and 32,406 (`cos`) of 2,257,723,138
  inputs, at the sine kernel's polynomial; on the whole X001 Benson
  hemispheres that is one ULP of `x0` or `y0` on 10 (LH) and 9 (RH) vertices
  ([single sin and cos](validation/matlab/README.md#single-sin-and-cos)).
- **`fminsearch` stop.** SamSrf stops a fine fit when its `OutputFcn` sees a
  non-finite best value; that can only be the first value (NaN sorts last), and
  the port does the same. MATLAB's exit flag for that case is not reproduced;
  SamSrf does not read it.
- **Degenerate geometry.** Where MATLAB's `delaunay` or `convexHull` would
  error on fewer than three non-collinear points, the port gives the empty
  `polyshape` result SamSrf's own `catch` or `polyshape` produces: a zeroed
  column in `rc`, area 0 and NaN centroid in `cf`. A seed region whose template
  coordinates are all collinear makes `samsrf_revcor_cf` fail in MATLAB; here
  the cluster is the peak alone. The triangulation decides incircle tests
  exactly and breaks cocircular ties with CGAL's symbolic perturbation, which
  gives MATLAB's `delaunay` edges on every recorded grid, ring and shuffled
  tie. `polyshape(...).convhull` follows MATLAB's fixed-point grid, even-odd
  resolution and 1e-8 cleaning, and gives MATLAB's hull vertices on every
  recorded polygon except 93 nearly collinear point clouds, whose crossings of
  nearly parallel edges MATLAB resolves by snapping vertices the port does not
  reproduce ([geometry gates](validation/matlab/README.md#geometry-polyshape-delaunay-and-real-templates)).
  An experimental Clipper-based model that matches more of them but not four
  that this one matches is kept out of every shipped build
  ([experimental model](validation/matlab/README.md#experimental-clipper-model-not-in-production-732-open)).
- **`cf` quirks kept on purpose.** `Fwhm` sums `Srf.Area(R > mR/2)`, which in
  SamSrf indexes the first `nsvx` vertices of the hemisphere, not the seed
  vertices; the `Fit_pRF = 1` residual subtracts a column from a row and so
  sums over every pair of seed vertices in the source order. This costs
  quadratic work per objective evaluation in unsmoothed Gaussian mode;
  smoothing uses an elementwise residual. `Vx` is the 1-based MATLAB index of
  the peak seed vertex. The template coordinates are single precision
  (MATLAB computes them on the GIFTI's `single` data). With double data every
  later step is f64; with `Data_Precision` single the estimators stay single
  as SamSrf's do.
- **`samsrf_fit2dprf` seeds.** Only the first `n - 2` seed parameters are
  divided by the scaling factor, as the MATLAB loop bound (written for a vector
  that does not yet hold the two betas) does.
