# @neurodesk/ants-denoise

ANTs `DenoiseImage` (the adaptive non-local means filter of Manjón et al. 2010, from the ITKAdaptiveDenoising module) in WebAssembly, `wasm/ants-denoise.{mjs,wasm}` (8.24 MB).

`createDenoiser({createModule, wasmBinary, onLog})` initializes the module. `denoise({image, mask, noiseModel, shrinkFactor, patchRadius, searchRadius})` accepts NIfTI bytes, gzipped or not, and returns uncompressed float32 NIfTI-1 bytes. The defaults are the `DenoiseImage` defaults: `Gaussian`, shrink factor 1, patch radius 1, search radius 2. `noiseModel` can also be `Rician`. The adapter passes every setting explicitly and runs one ITK thread, so the result is the same on every host. The optional mask selects the patch centres that are denoised. Voxels farther than the patch radius from the mask keep their values up to float rounding. In Node, `loadDenoise({onLog})` from `@neurodesk/ants-denoise/node` checks `DENOISE_WASM_SHA256` (`src/pin.js`) before it loads the module.

The toolchain builds without C++ exception catching. An ITK error, such as an unreadable file or a mask on a different grid, aborts the module. `denoise()` then rejects, and the denoiser refuses further work; create a new one. The toolchain also sends module output to the console. The adapter passes the same lines to `onLog` after each run.

On a 193x229x193 T1 the module took 588 seconds in Node on the validation host with a 464 MB heap. Its output was byte-identical to a probe build of the same sources (sha256 `58c3e0e2…`). `test/denoise.test.js` repeats that check when `ANTS_DENOISE_REFERENCE` names the T1.

On the MS FLAIR example of the ANTs DenoiseImage app (240x240x81), the module's output equals native ANTs 2.6.5 `DenoiseImage` (Neurodesk container `ants_2.6.5_20261012`, `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1`) byte for byte: Gaussian and Rician noise, Rician inside a mask of the nonzero voxels, and patch and search radii of 2 and 2, 1 and 3, and 2 and 3. With its default threads, native ANTs gives other voxels (13.6 % of them, by up to 39.8 on a range of 2011), because the adaptive filter's estimates depend on how ITK splits the image. In Node the example took 57 seconds with a 802 MB heap (1058 MB with the Rician model), and a 166x210x160 whole-head T1 took 394 seconds. `apps/ants-denoise/e2e/expected.json` pins two of these native outputs, and the app's browser tests reproduce them.

Rebuild from the repository root:

```bash
bash packages/ants-denoise/scripts/build.sh /storage/tmp/ants-denoise-build
```

The script downloads the pinned ANTs and ITKAdaptiveDenoising source archives, checks their sha256 and compiles `native/` in the same digest-pinned toolchain with two jobs and no network. After a rebuild, update `src/pin.js` and the pinned phantom output in `test/denoise.test.js`.
