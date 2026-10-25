# @neurodesk/hmc

DWI head-motion correction for the `hmc` web app and command line: a pool of `@neurodesk/hmc-registration` kernels that registers each volume to a target, one resampling of the series with the per-volume transforms, and the BIDS-derivative outputs.
It also holds `src/hmc.wasm`, the WebAssembly build of the `exes/dwi/hmc` crate (`exes/dwi/hmc-wasm`): ITK `.mat` files, motion parameters and the motion TSV, b-vector rotation and NiFreeze's `advanced_clip`.

The lower-level `correctHeadMotion` accepts caller-supplied targets and registration arguments. `correctNiFreeze` adds the NiFreeze trivial and GP estimators. SHORELine (#458) can use the same lower-level path.

## Use

In Node:

```js
import { readFile, writeFile } from 'node:fs/promises';
import { correctHeadMotion, readSeries } from '@neurodesk/hmc';
import { loadHmcNode, nodeRuntime } from '@neurodesk/hmc/node';

const { files } = await correctHeadMotion({
  series: await readSeries(await readFile('sub-01_dwi.nii.gz')),
  bvals, bvecs,                                 // [b...], [[x...], [y...], [z...]]
  method: 'nifreeze',                           // or 'shoreline'
  target: (volume, b0) => (b0 ? null : template), // Float32Array on the series grid; null: keep the volume
  argv: (volume) => argv,                       // antsRegistration argv: fixed.nii, moving.nii, mask.nii, --output [out]
  mask,                                         // Uint8Array, one byte per voxel, or null
  fileName: 'sub-01_dwi.nii.gz',
  sidecar,                                      // the input's JSON sidecar, or null
  hmc: await loadHmcNode(),
  runtime: nodeRuntime({ workers: 4 }),
  signal,                                       // AbortSignal
  onProgress: ({ stage, volume, done, total }) => {},
});
for (const [name, bytes] of Object.entries(files)) await writeFile(name, bytes);
```

In a browser, inject the kernel's module worker and CompressionStream:

```js
import { correctHeadMotion } from '@neurodesk/hmc';
import { browserRuntime, loadHmcBrowser } from '@neurodesk/hmc/browser';

const runtime = browserRuntime({ workerUrl: new URL('@neurodesk/hmc-registration/worker', import.meta.url), workers: 4 });
const hmc = await loadHmcBrowser(new URL('@neurodesk/hmc/hmc.wasm', import.meta.url));
```

The kernel is linked with `-pthread`: the page must be cross-origin isolated.

## NiFreeze estimator

```js
import { correctNiFreeze } from '@neurodesk/hmc/nifreeze';

const result = await correctNiFreeze({
  series, bvals, bvecs, mask, hmc,
  model: 'gp', // or 'trivial'
  seed: 1234,
  fileName: 'sub-01_dwi.nii.gz',
  runtime: nodeRuntime({ workers: 4 }),
});
```

The input split, float64 median of the b0 volumes, GP fit and prediction, GP mask reduction and registration argv use the existing `dwi-hmc` Rust ports through `hmc.wasm`. The GP mask excludes voxels whose median b0 is below `1e-5`. The trivial model keeps the supplied mask. Both keep b0 frames unchanged and write identity transforms and motion rows for them.

Targets are prepared when a registration worker becomes free. The trivial model repeatedly clips its shared float64 bzero in visit order, including NiFreeze's in-place state change. Once an exact clip leaves it unchanged, later visits reuse that fixed point. Float input samples are clipped in place; integer source samples are left unchanged, as NiFreeze's `_to_nifti` does when it ignores `advanced_clip`'s return value. Resampling still uses each volume only once.

The default seeded visit order is the port's recorded permutation, not NumPy's. `visitOrder` can supply NiFreeze's DWI-only indices explicitly. The output sidecar records the model, seed and visit order. GP targets are fitted from the initial series and do not depend on the order.

`validation/nifreeze-loop.mjs ROOT OUT trivial|gp [WORKERS]` runs the complete estimator on the pinned ds005577 reference, rather than replaying saved targets. It verifies every consumed file against `exes/dwi/hmc/validation/reference.manifest.json`, checks volume/gradient/table counts and unchanged b0 frames, and writes the actual files and `estimator-report.json` outside this repository.

The completed trivial run writes 101 volumes, transforms and motion rows, including 11 unchanged b0 volumes. All 90 prepared targets equal NiFreeze's kept prediction exactly. This is a loop/software check, not a quality claim. Native NiFreeze's trivial model itself degrades the high-b shell on this data, as the HMC plan records.

The [2026-10-24 decision in #451](https://github.com/neurodesk/webapps/issues/451) compares WASM with native `--float 1`, using the existing per-volume, per-axis native-double seed-spread limits **about the world grid centre**. All 90 volumes and 540 cells pass. Of the transforms, 87 equal native float byte for byte; volumes 31, 52 and 88 differ but remain within those limits. Independent Rust `world_centre_motion` agrees with the JavaScript validation to 1e-12. `validation/nifreeze-gate-check.mjs ROOT OUT` rechecks an existing run against checksummed reference transforms.

The output TSV retains QSIPrep's pivot, which omits the affine origin. That additional comparison fails volume 52 translation-x (0.045133 mm versus a 0.016137 mm spread); at the documented world centre the same cell passes (0.029730 mm versus 0.036337 mm). Reports keep both conventions. The historical double comparison also remains visible: 48 volumes and 77 QSIPrep cells fail, as in `exes/dwi/hmc/validation/q53-replay.json`. No per-volume limit was increased.

The complete ds005577 GP run produces all 90 predictions exactly equal to native targets. Image QC uses Pearson correlation against the mean of raw same-shell volumes inside the 161,668-voxel GP mask:

| Shell | Before | WASM output | Native float, cubic | Native double, cubic |
| --- | ---: | ---: | ---: | ---: |
| b1000 | 0.894919 | 0.902327 | 0.902327 | 0.902354 |
| b3000 | 0.626808 | 0.635975 | 0.635975 | 0.634689 |

No volume drops by more than 0.02 in any path. The native columns apply the pinned matrices with NiFreeze's nitransforms 25.1.0 cubic-spline resampler. The older QC script uses **linear** interpolation, so its 0.909626/0.673994 native-double medians must not be compared directly with cubic outputs. Matched linear QC gives WASM/native-float medians 0.909596/0.672683, also with no drops over 0.02. `validation/nifreeze-native-quality.py ROOT OUT REPORT_JSON` reproduces both comparisons, checks every reference checksum, and records library versions. `validation/check-nifreeze-outputs.mjs` separately checks all 90 registration command lines.

## Performance measurements

Issue #452's measurement harness runs the complete NiFreeze estimator in isolated Node and Chromium processes. It uses the pinned ds005577 full series or ds005134 slab and checks every download's checksum. Input loading is outside the timed region; model preparation, registration, resampling and gzip are inside it. Output verification runs afterward and checks completed work, finite voxels in every frame, frame and table counts, unchanged b0 frames and scientific output hashes.

For a correctness preflight, with data and receipts on the storage volume:

```bash
node packages/hmc/validation/benchmark.mjs \
  --data slab --host node --model trivial --workers 1 \
  --cache "$TMPDIR/hmc-benchmark-cache" \
  --out "$TMPDIR/hmc-slab-node-preflight.json" --preflight
```

Use `--host chromium` for the browser path, `--data full` for ds005577 and `--model gp` for the GP estimator. Chromium requires Playwright's installed browser and permission to listen on loopback. `--provision` downloads and verifies inputs without running the estimator. Preflight receipts explicitly exclude performance conclusions.

After reserving a quiet host, the matrix driver runs five trials per configuration, rotating 1, 2 and 4 workers for both datasets, estimators and hosts:

```bash
node packages/hmc/validation/benchmark-matrix.mjs \
  "$TMPDIR/hmc-benchmark-cache" "$TMPDIR/hmc-benchmark-results"
```

Add `--resume` with the same paths to validate completed receipts and run only missing trials. Resume requires the same input pins, source hashes, settings, machine and runtime version. Preflights, failed or incomplete trials are rejected; archive those receipts before retrying. Existing trial receipts are never overwritten. Without `--resume`, a directory containing matrix receipts is refused.

The driver writes 120 individual receipts and `matrix.json`, and rejects differences in scientific outputs across worker counts or hosts. Receipts hash all HMC and registration source files, generated kernels, shared file IO, package manifests, the dependency lock and benchmark scripts. Each run checks the hashes before and after execution; the matrix rejects changes across all configurations. Receipts also include input pins, machine details, awaited runtime and externally sampled process-tree RSS. Memory sampling starts before input loading and continues through completed correction; preparation and completion are sampled explicitly in addition to the 100 ms interval. Output verification is excluded. This is an observed peak, and shared Chromium pages can be counted more than once. Inspect trial variation and separate profiling runs before choosing worker defaults or input limits.

The full matrix has not been measured. The Node and Chromium one-worker slab trivial preflights complete 124 registrations and resamplings across 137 frames, with identical hashes for all 142 scientific artifacts. The separate #451 gate determines scientific acceptance; performance measurements do not establish it.

Both datasets use precomputed pinned masks. Automatic MindGrab masking and the application
viewer are excluded. Their memory must be measured separately before these measurements
can justify a whole-app input-size limit. The app's dedicated MindGrab worker terminates
before HMC starts, but its earlier peak still matters. The matrix does not measure it.

## Pool

- Each worker holds one `@neurodesk/hmc-registration` kernel, which starts at the `INITIAL_MEMORY` of its build (256 MiB). The caller sets the worker count, and so the memory: 4 workers start at about 1 GiB.
- The workers speak the kernel worker's protocol, `{ id, argv, inputs }` to `{ id, outputs, log }` or `{ id, error, log }`. In a browser that is `@neurodesk/hmc-registration/worker`; in Node, `src/node-worker.js` on a worker thread.
- The NIfTI inputs of a volume are made when a worker is free, and moved (transferred) to it.
- Cancellation: the pool checks the `AbortSignal` before it sends each run. An abort terminates every worker at once, the run in progress included, and frees their memory; `correctHeadMotion` rejects with the signal's reason (`AbortError`).
- Progress: `onProgress({ stage, volume, done, total })` after each registration (`register`) and each resampling (`resample`) of a volume, then `write` (`done` 0, then 1).
- A volume's result depends only on its inputs and argv, and the results are put in volume order. The kernel uses one ITK thread, and it refuses an `antsRegistration` argv without `--random-seed`. The package does not set the seed: give the same `--random-seed` in `argv` to get the same bytes with any worker count. The tests (seed 1234) show that 1 and 4 workers write the same bytes.

## Outputs

`src/outputs.js` makes the names with the shared module of the DWI apps, `@neurodesk/webapp-components/file-io/bids-derivatives` (#413), so they have the form of the degibbs, dwidenoise, n4 and noddi outputs. Two rules are hmc's own: a path keeps only its file name, and a name without a suffix becomes `dwi`. For `sub-01_dwi.nii.gz`:

| File | Content |
| --- | --- |
| `sub-01_desc-hmc_dwi.nii.gz` | the corrected series, float32, every volume (b0 volumes kept, Q51) |
| `sub-01_desc-hmc_dwi.bval`, `.bvec` | every column: NiFreeze `%.2f` and `%.6f`, SHORELine `%i` and `%.8f` (`exes/dwi/hmc/src/bvec.rs`) |
| `sub-01_desc-hmc_motion.tsv` | `trans_x trans_y trans_z rot_x rot_y rot_z framewise_displacement` (SHORELine adds `scale_x scale_y scale_z`), one row per volume, RAS+, QSIPrep's formula on the series grid |
| `sub-01_desc-hmc_dwi.json` | the input's sidecar with `Description` and `HeadMotionCorrection`, no time or host |
| `sub-01_vol-0003_desc-hmc_xfm.mat` | the ITK transform of volume 3 (0-based), as antsRegistration wrote it; an identity transform for a volume that was not registered |

The shared module has no rule for per-volume files, so the motion table and transform names are hmc's own. They use the same source entities and `desc-hmc`.

## Resampling

Each registered volume is resampled once, by `--apply volume.nii volume.nii resampled.nii BSpline 0 transform.mat`: the forward transform (fixed to moving), on the series grid, fill 0.
A volume whose target is `null` (the b0 volumes in the NiFreeze path) is copied unchanged, not resampled through an identity transform.

NiFreeze 3bcfb00 resamples with `nitransforms.resampling.apply(..., order=3)`, a SciPy cubic spline (#534's README). `BSpline` (order 3) is the closest `--apply` interpolator.
`validation/nifreeze_resampling.py` applies NiFreeze's steps (`ITKLinearTransform.to_ras`, `apply(order=3)`, nitransforms 25.1.0, SciPy 1.16.2) to the same `.mat` files of the synthetic series (`validation/export-synthetic.mjs`). The largest difference, relative to the peak of the volume:

| Voxels | Largest difference | Mean difference |
| --- | --- | --- |
| at least 3 voxels from every face | 9.4e-8 | 4.0e-9 |
| all, faces included | 8.2e-3 | - |

Inside the grid the two agree to float precision. At the faces they differ, because SciPy pads with 0 (`mode="constant"`) and ITK's B-spline mirrors the image.
NiFreeze also casts the output back to the input type; this package writes float32.

## Node files and command line

The file adapter calls the existing `correctNiFreeze` estimator and output writer:

```bash
node packages/hmc/bin/hmc.js sub-01_dwi.nii.gz sub-01_dwi.bval sub-01_dwi.bvec results --mask brain.nii.gz
```

`--method gp` is the default; `--method trivial` uses the b0 template. The seed
defaults to 1234. The app, automation contract and `--workers` default to two registration
workers, following the [measured GP scaling](../../docs/architecture/dwi-hmc-plan.md#6-runtime-and-memory).
Explicit worker counts remain available; four workers improve mean-b0 throughput on the measured host.
Changing the method does not automatically change the worker count. Without `--mask`, the pinned MindGrab CPU runtime
extracts the brain from the mean b0, using the shared Float32 averaging helper and
NiFreeze's b0 classification. `--sidecar FILE` preserves input JSON metadata.
The output directory must be new or empty. Existing files are never overwritten.
SIGINT and SIGTERM cancel the registration pool; completed files may remain if
writing fails. Default CPU mask preparation finishes its current call before
cancellation is observed.

The same adapter is exported as `correctFiles` from `@neurodesk/hmc/node`.
`self-check` executes the pinned registration resampler on an identity phantom.
`download-models` initializes the pinned MindGrab CPU runtime; its models are bundled.

`test/node-files.test.js` runs both estimators with the real registration kernel
and checks every CLI output byte against an independent low-level Node invocation
on a synthetic series. This checks the adapter; it does not establish scientific
accuracy or browser parity.

Portable packaging uses `release.json` and the shared packager in
`exes/node-cli/README.md`. Every Linux, Windows and macOS archive must pass its
self-check and compare every derivative against the production browser reference
before publishing. The `hmc-native` workflow provides the remote target matrix.
A local Linux archive and remote verification receipts are recorded separately;
source tests alone do not establish portable archive acceptance.

`node packages/hmc/validation/cli-check.mjs --executable PATH` refuses to pass
without `validation/browser-reference.json`. Its reference contains
`source: "production-browser"` and a `cases` array. Each case records `method`,
`seed`, `inputs` (dwi, bval, bvec, and optional mask/sidecar, each with an immutable `url`, `name` and `sha256`, or a relative `path` and `sha256`), and `outputs` (every derivative filename and its `sha256`).
Keep the large input files in validation storage, record them from the fresh
production browser workflow, and run the command against the packaged executable.

## Module

`src/wasm.js` (`loadHmc`) drives the C ABI of `src/hmc.wasm`, as `packages/noddi` does: no wasm-bindgen.

| Function | Port |
| --- | --- |
| `readMat`, `writeMat` | ITK `.mat` (MATLAB v4), float or double |
| `motionParams`, `motionTsv` | QSIPrep 26.1.1 `get_ras_motion_params`, nipype framewise displacement |
| `b0Flags`, `rotateGradients` | the b0 and b-vector rules of NiFreeze 3bcfb00 and SHORELine (QSIPrep 26.1.1) |
| `advancedClipInPlace`, `advancedClip` | NiFreeze `advanced_clip`, with its in-place state (Q55): float volumes are overwritten, integer volumes are not |

## Tests

```bash
pnpm --filter @neurodesk/hmc test
```

`test/pipeline.test.js` runs the pool on worker threads with the real kernel on a synthetic series (`test/synthetic.js`): 32³, 2 mm, six volumes (two b0 volumes, three moved DWI volumes with known shifts up to 5.4 mm and one 4° rotation, and one DWI volume that does not move), sampled from a formula after each motion. The registration argv is not NiFreeze's: mean squares on every voxel, which finds this motion to 0.06 mm and 0.06°.
The test checks the transforms (0.1 mm, 0.1°), the names, the columns, the b0 volumes, byte-identical outputs with 1 and 4 workers, and that a cancel stops the pool within one volume with every worker thread ended.

## Rebuild the module

```bash
pnpm --filter @neurodesk/hmc build:wasm   # rebuild src/hmc.wasm
pnpm --filter @neurodesk/hmc check:wasm   # rebuild and compare byte for byte
```

Rust 1.98.0 with the `wasm32-unknown-unknown` target and binaryen `version_117` `wasm-opt` are required. `.github/workflows/dwi-native.yml` (`wasm-source`) runs the check.
