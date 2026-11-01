# @neurodesk/hmc-registration

ANTs `antsRegistration`, `antsApplyTransforms`, `AverageImages`, `AverageAffineTransform`, a small `ImageMath ... Laplacian` entry and the legacy antsApplyTransforms-style `--apply`, compiled to WebAssembly with a generic `run(argv)`, for DWI head-motion correction (and later susceptibility distortion correction).
It is a separate module from `@neurodesk/registration`, at the same pinned ANTs commit and ITK-Wasm toolchain, so the SYNcro and ANTs kernels do not change.

## Use

In Node:

```js
import { readMatTransform } from '@neurodesk/hmc-registration';
import { loadHmcRegistration } from '@neurodesk/hmc-registration/node';

const ants = await loadHmcRegistration();
const { outputs, log } = ants.run(
  ['--dimensionality', '3', '--float', '1', '--random-seed', '1234',
   '--transform', 'Rigid[0.1]', '--metric', 'Mattes[fixed.nii,moving.nii,1,32,Regular,0.25]',
   '--convergence', '[100x50,1e-6,10]', '--shrink-factors', '2x1', '--smoothing-sigmas', '1x0vox',
   '--output', '[out]'],
  { 'fixed.nii': fixedBytes, 'moving.nii': movingBytes },
);
const { parameters, fixed } = readMatTransform(outputs['out0GenericAffine.mat']);
```

In a browser, run it in the module worker:

```js
const worker = new Worker(new URL('@neurodesk/hmc-registration/worker', import.meta.url), { type: 'module' });
worker.postMessage({ id: 1, argv, inputs: { 'fixed.nii': fixedBytes, 'moving.nii': movingBytes } });
worker.onmessage = ({ data }) => { /* { id, outputs, log } or { id, error, log } */ };
```

The kernel is linked with `-pthread`, so its memory is a `SharedArrayBuffer`: the page must be cross-origin isolated (COOP `same-origin`, COEP `require-corp`).
A message can carry `kernel: { module, wasm }` URLs when a bundler moved the kernel files.

`run(argv, inputs)` writes each input into a new directory of the virtual file system, runs the program there (argv names files relative to it), returns every file the run wrote, and removes the directory.
A `.nii.gz` input is read as gzipped NIfTI; ANTs picks the reader by file name.
A failed run throws an error whose message ends with the last log lines; `error.log` holds the whole log.
A run that exits non-zero leaves the kernel usable.
Some mistakes, such as an input that argv names but `inputs` does not hold, make the kernel abort (trap) instead: the error then has `aborted: true`, and that instance refuses later runs, so load a new one.
The worker does this itself: its next message loads a new kernel.
`run` refuses an `--output` prefix whose directory does not exist before the kernel runs, as ANTs aborts on it.

## Programs

`argv[0]` selects the program; any other argv is `antsRegistration`'s, without the program name.
The worker takes the same argv.

| `argv[0]` | Arguments after it | Source |
| --- | --- | --- |
| `AverageImages` | `3 output.nii normalize image...` | ANTs `Examples/AverageImages.cxx`, unchanged |
| `AverageAffineTransform` | `3 output.mat [-R reference] {[-i] transform [weight]}...` | ANTs `Examples/AverageAffineTransform.cxx`, unchanged |
| `--apply` | `fixed moving output interpolation fill transform...` | `src/apply.cxx` |
| `antsApplyTransforms` | Native CLI argv, including `-n MultiLabel`, BSpline, `.h5` composites and inverse flags | Unmodified ANTs `Examples/antsApplyTransforms.cxx` |
| `ImageMath` | `3 output.nii Laplacian input.nii [sigma [normalize]]` | Small copy of pinned `LaplacianImage`, `src/laplacian.cxx` |

The SHORELine template step of QSIPrep, in this module:

```js
ants.run(['AverageImages', '3', 'template.nii', '1', 'b0-1.nii', 'b0-2.nii'], images);
ants.run(['AverageAffineTransform', '3', 'average.mat', 'a.mat', 'b.mat'], transforms);
ants.run(['--apply', 'template.nii', 'template.nii', 'updated.nii', 'HammingWindowedSinc', '0', 'inverse:average.mat'], files);
```

`--apply` resamples `moving` onto the grid of `fixed`.
`interpolation` is `Linear`, `NearestNeighbor`, `BSpline` (order 3), `BSpline[0]` to `BSpline[5]`, `HammingWindowedSinc` or `LanczosWindowedSinc`, as antsApplyTransforms names them (case does not matter).
`fill` is the value of voxels that map outside `moving`.
A transform written `inverse:name` is inverted, as `[name,1]` in antsApplyTransforms.
The last transform listed acts first on an **output-to-input sampling point**.
This positional list is the reverse of native antsApplyTransforms' `-t` list:
`--apply ... A B` corresponds to `antsApplyTransforms ... -t B -t A`.
For example, `--apply ... rot.mat trans.mat` samples at `R(T(p))`, not `T(R(p))`.
Apparent movement of image content uses the inverse mapping; it must not be used to name the sampling-point order.
The independent [native/WASM transform-order check](validation/transform-order.md) covers both orders and an inverse affine.
Pixels are float32 in and out; interpolation and transforms are double, as antsApplyTransforms without `--float`.
The interpolators are the ones antsApplyTransforms builds (`make_interpolator_snip.tmpl`): windowed sinc with radius 3 and a constant (zero) boundary, B-spline with double coefficients.
`packages/registration`'s `--apply` (SYNcro, ANTs) does not change: it still has only linear and nearest.

The kernel is built without C++ exception catching, so an ITK reader that fails on a missing file aborts it.
For these three programs `run` refuses, before the kernel runs, an input that argv names but `inputs` does not hold, and an argument that holds a directory.
`--apply` reports an unknown interpolation, a fill that is not a number, or no transform with exit 1; the kernel stays usable.

### Interpolators in the reference pipelines

- QSIPrep 26.1.1 writes the output DWI with antsApplyTransforms `--float` (`workflows/dwi/resampling.py`, `dwi_transform`). `ChooseInterpolator` (`interfaces/images.py`) picks `LanczosWindowedSinc`, or `Linear` when the output voxels are more than 10 % finer than the input or in sloppy mode.
  In SHORELine (`workflows/dwi/hmc.py`) the b0 template is averaged with `AverageImages` (normalize 1) and `AverageAffineTransform` and resampled through the inverse average with `HammingWindowedSinc`; the b0-based initial transforms use `BSpline`; the model images go back to the original space with `LanczosWindowedSinc`.
- NiFreeze 3bcfb00 does not use ANTs to write the output DWI. `to_nifti` (`nifreeze/data/base.py`) resamples each volume with `nitransforms.resampling.apply` at `order=3`: a cubic spline from SciPy, the nearest equivalent of `BSpline` here.

## Rules

- For `antsRegistration`, `run` refuses argv without exactly one `--float 1`, in JavaScript, before the kernel runs. Only `antsRegistration3DFloat` is compiled; `src/unsupported.cxx` (a copy of `packages/registration`'s) refuses 2D, 4D and every double mode, 3D double included.
- For `antsRegistration`, `run` refuses argv without exactly one `--random-seed N`, N an integer from 1 to 2147483647. Without it ANTs seeds from the clock. The seed is never taken from the environment: `ENV` is not in `EXPORTED_RUNTIME_METHODS` (only `FS`, `callMain`, `stackSave` and `stackRestore`), so `ANTS_RANDOM_SEED` cannot reach the kernel.
- The kernel uses one ITK thread (`src/main.cxx`), so results do not depend on the host.
- Memory starts at 256 MiB (`INITIAL_MEMORY=268435456`) and grows to at most 4 GiB (`MAXIMUM_MEMORY`), as `packages/registration`: four workers start at about 1 GiB.
- The allocator is dlmalloc (`-sMALLOC=dlmalloc`), not the mimalloc that the toolchain image's `LDFLAGS` link. mimalloc reserves arenas from emmalloc in growing sizes and never returns them, which took the 1.2 mm SyN-SDC registration of #462 to the 4 GiB maximum (4,294,901,760 bytes of linear memory for 2.12 GB of live allocations). With dlmalloc its linear memory peaks at 2,155,610,112 bytes and it writes the same bytes. `test/memory.test.js` fails if a Laplacian on that grid grows the memory past its initial 256 MiB.
- Node and the worker refuse a `.wasm` whose SHA-256 is not `HMC_REGISTRATION_WASM_SHA256` (`src/pin.js`).

## Parity

`test/data` holds a 32³ 2 mm pair of three Gaussian blobs, the moving image moved by (3, −2, 4) mm RAS, both sampled from the formula (`scripts/make-test-data.mjs`).
Native `antsRegistration` built from ANTs 52bc0ab (SuperBuild, Release, `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1`) with this module's Mattes accumulation (see Rebuild) and this module, in Node and in a Chromium worker, write the same `out0GenericAffine.mat`, byte for byte, with the argv in `test/expected.mjs` (seed 1234).
Its translation is (−3.000, 2.009, 4.010) mm LPS, the shift within 0.011 mm (stock ANTs, with float accumulation: (−2.994, 2.008, 4.007) mm).
The tests pin that file's SHA-256.
On NiFreeze's own registrations (#446, `validation/nifreeze-replay.mjs`, held to `exes/dwi/hmc/validation/q53-replay.json` in the `dwi-native` workflow), the module writes the same transform as native `--float 1` for 98 of 101 runs; GP volumes 31, 52 and 88 differ by at most 0.03 mm.
A run takes about 0.5 s in Node.

One instance serves many runs: the replay uses one for all 101, and `test/run.test.js` and `validation/browser-worker.mjs` run the pair 200 times in one instance.
Emscripten's `callMain` puts argv on the kernel's 64 KiB stack and does not take it off, as it expects one call.
Before `run` restored the stack pointer (`stackSave` and `stackRestore`), each run left its argv there, and an instance aborted when the stack was full: on run 27 of NiFreeze's command lines and run 91 of the test pair ([#537](https://github.com/neurodesk/webapps/issues/537)).
`callMain` also put the program name in front of the argv array it was given, so a run that reused an array grew it; `run` now passes a copy.
`src/main.cxx` also registers ITK's IO factories in the first `main()` only, as ITK keeps every duplicate statically linked factory; that was not the cause of the abort.

`validation/native-reference.sh` runs the SHORELine steps with native ANTs 52bc0ab (the deriv64 build of `validation/sdc-gate/native/build.sh`) on the same pair: registrations with seeds 1234 and 4321, `AverageAffineTransform` of the two, `antsApplyTransforms -u float` with each interpolator, `HammingWindowedSinc` through the inverse average, and `AverageImages` with normalize 0 and 1.
Native `AverageImages` and `AverageAffineTransform` come from the same configuration as the native `antsRegistration` (the `ANTS-build` cache options, with `ANTS_BUILD_AverageImages` and `ANTS_BUILD_AverageAffineTransform` on).
`test/programs.test.js` (Node) and `validation/browser-worker.mjs` (Chromium worker) run the same steps in this module.
Every output file is native ANTs's, byte for byte (`NATIVE_SHA256` in `test/expected.mjs`): the tolerance is 0, inside the 1e-5 relative limit of #445.
The `--apply` outputs equal antsApplyTransforms in its default double precision; with `--float 1` native ANTs differs from them by at most 5.1e-7 of the image maximum.
Over the central 16³ voxels, `--apply` brings the moving image from 0.38 of the fixed maximum to 0.013 (Linear), 0.0025 to 0.0026 (B-spline), 0.0039 (Hamming), 0.0063 (Lanczos) and 0.075 (nearest neighbour); the tests hold these to 0.02 (0.1 for nearest neighbour).
`AverageImages` with normalize 0 is the voxel mean of its inputs, to float precision.

## Tests

```bash
pnpm --filter @neurodesk/hmc-registration test          # Node
pnpm --filter @neurodesk/hmc-registration test:browser  # Chromium module worker
```

To rerecord the native SHA-256 values: `bash packages/hmc-registration/validation/native-reference.sh <ants-bin-dir> <out-dir>`.

`test:browser` needs a Playwright Chromium (`node node_modules/@playwright/test/cli.js install chromium`).
CI runs `test` in `pnpm test:packages` and `test:browser` in `.github/workflows/hmc-registration.yml`.

## Rebuild

Docker, curl and tar are required:

```bash
bash packages/hmc-registration/scripts/build.sh /var/tmp/hmc-registration-build
```

The script downloads ANTs at `52bc0ab588102682587303d31c720de94e6ef6c1` and compiles in `itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d`, one job, with an 8 GB container limit (`HMC_REGISTRATION_BUILD_MEMORY`).
`SOURCE_DATE_EPOCH` fixes the `__DATE__` and `__TIME__` that `ANTsVersion.cxx` embeds at the ANTs commit time. The committed `.wasm` is 15,223,841 bytes, SHA-256 `d45192154b599244d96c0ad54e44f6aaca785db1792238680707e87fe8de19d1`; a second build wrote the same bytes.
A build took about 2.6 minutes.
When a source or the toolchain changes, put the printed SHA-256 in `src/pin.js`.

`cmake/mattes-pdf-double.cmake` compiles ITK's Mattes metric with float64 accumulation: build-tree copies of its header and `.hxx` make the joint and marginal PDFs, their sums, the metric value and the derivative of a transform with global support (an affine) accumulate in double and round to float once (#462, "deriv64"). Images, fields and transforms stay float, `--float 1` is still required, and no `antsRegistration3DDouble` is built. `src/mattes-pdf-double-check.cxx` fails the build if antsRegistration's include chain misses a copy. Registrations with other metrics (HMC's `GC`, SyN-SDC's `CC` stages) write the same bytes as before. The goldens in `test/expected.mjs` come from a native build with the same edit (`validation/sdc-gate/native/build.sh`, `deriv64`); the stock native build gives the previous goldens.

## SDC entry-point foundation (#462)

The full `antsApplyTransforms` entry retains native `-t` ordering. Its list is the reverse of the legacy `--apply` positional list when comparing output-to-input sampling transforms. For example, native `-t rot.mat -t trans.mat` matches legacy `--apply ... trans.mat rot.mat`. Noncommuting rotation/translation tests distinguish both orders and compare with independently generated single-affine transforms; see `validation/transform-order.md`. The full CLI also reads HDF5 composite transforms and native `[file,1]` inversion flags, also split over tokens as nipype renders them (`[`, `file,`, `1`, `]`). No interpolation is substituted for MultiLabel.

The Laplacian entry copies the float-image computation of `ImageMath_Templates.hxx:9183–9230` at ANTs `52bc0ab`. It deliberately preserves the pinned parser quirk: both sigma and normalization read the sigma argument; the final normalization argument is ignored. Thus `ImageMath 3 lap.nii Laplacian input.nii 1.5 1` normalizes to [0,1], as SDC requires, and changing its final argument to 0 gives the same output. Sigma 0.5 does not normalize even with a final 1. Only this 3D operation is exposed; unsupported ImageMath operations are rejected before ITK. Missing inputs and paths outside the private run directory are also refused before calling ITK.

`test/sdc-programs.test.js` compares thirteen complete output images, including decompressed warp images, byte for byte with native ANTs 2.6.2 at the exact pinned commit. The fixture includes an oblique label grid, distinct MultiLabel/nearest-neighbor results, BSpline through an HDF5/inverse transform chain, native transform order, Laplacian parsing, and two restricted-SyN stages with `--restrict-deformation 0.1x1.0x0.1` and fixed/moving masks. The displacement is nonzero, so this is not an identity registration test. `validation/sdc-entry-reference.json` records every input/output digest and the native executable identities. Regenerate with:

```bash
node packages/hmc-registration/validation/sdc-native-reference.mjs ANTS_BIN_DIRECTORY "$TMPDIR/sdc-entry-reference"
```

Use the immutable Ubuntu 22.04 ANTs v2.6.2 release archive recorded in that manifest. Its verified SHA256 is `650ac1827939ec4dd5438f4154ba08ed97065557a85b04707bc1e5ba4eb99a43`; the annotated v2.6.2 tag resolves to `52bc0ab588102682587303d31c720de94e6ef6c1`, and `antsRegistration --version` reports `2.6.2-g52bc0ab`. The generator rejects different executable digests. The build command and pinned ITK-Wasm image above apply to these entry points too.

The maintainer fixed the SyN grid at 1.2 mm and kept the field gate `d <= max(spread, 0.05 Hz)` and `d < 0.5 Hz` (#462). [`validation/sdc-gate/`](validation/sdc-gate/README.md) runs that gate through sdcflows' pinned drivers, and `.github/workflows/sdc-registration-gate.yml` requires the whole rule on the SyN-only replay. With float accumulation in the Mattes metric, the previous kernel passed the SyN-only replay (d = 0.084 Hz) and failed end to end (d = 0.538 Hz, from the float `epi2anat` affine). With float64 accumulation this kernel gives d = 0.040 Hz on the SyN-only replay and d = 0.031 Hz end to end (p95 0.142 and 0.128 Hz), both under the 0.05 Hz floor, so both conditions hold whatever the native seed spread. SyN grows linear memory to 2,258,173,952 bytes in Node and in a Chromium module worker, whose renderer process held 3.23 GB when the reply arrived (`validation/sdc-gate/results-kernel.json`). Whole-app memory and other browsers have not been measured. Section 6.2 of the [SDC plan](../../docs/architecture/dwi-sdc-plan.md#62-gates) records these results. No `antsRegistration3DDouble` implementation is built. DenoiseImage is owned by the separate `ants-denoise` work in PR #597. The EPI-reference N4 argv builder already exists in `packages/n4/src/epi-reference.js`; its WASM is unchanged by this work. `packages/registration` is untouched.
