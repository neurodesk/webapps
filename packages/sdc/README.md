# @neurodesk/sdc

Reverse phase-encoding susceptibility distortion correction for the `sdc` web app.
The numerical code is the Rust workspace [`exes/sdc`](../../exes/sdc), a port of PyHySCO 0.0.4, compiled to `src/sdc.wasm`.
It is GPL-3.0-or-later, as PyHySCO is GPL-3.0.

## Use

```js
import { loadSdc } from '@neurodesk/sdc';

const { pyhysco } = await loadSdc(fetch(new URL('@neurodesk/sdc/wasm', import.meta.url)));
const { field, corrected1, corrected2 } = pyhysco(ap, pa, [nx, ny, nz], voxel, {
  phaseEncodingDirection: 'j-',
  totalReadoutTime: 0.038,
});
```

`ap` and `pa` are Float64Array volumes, first index fastest, with opposite phase-encoding directions and in one space.
`field` is in Hz with FSL topup's sign: image 1 corrected is image1(x + field · TotalReadoutTime · sign) voxels along the phase-encoding axis.

`estimate` takes the same arguments and returns a promise of the same result, with `backend` set to `"webgpu"` or `"cpu"`:

```js
const { estimate } = await loadSdc(fetch(new URL('@neurodesk/sdc/wasm', import.meta.url)));
const { field, backend, gpuError } = await estimate(ap, pa, [nx, ny, nz], voxel, options);
```

`options.backend` is `"auto"` (the default), `"webgpu"` or `"cpu"`.
`auto` runs the Gauss-Newton evaluations and the CG solves on WebGPU (`src/webgpu.js`) when the browser has a hardware adapter and JSPI (`WebAssembly.Suspending`).
Otherwise, or when the WebGPU run fails, it runs the CPU path and gives the reason in `gpuError`.
After a WebGPU failure the instance stays on the CPU path. When the browser lost the device, the next run opens a new device.
`webgpu` also accepts a software adapter, or the device in `options.device`, and fails instead of falling back.
The WebGPU path computes in float32. Its field agrees with the native PyHySCO field to a median of 1.9e-5 Hz in the brain on ds005134 sub-01 ([measurements](../../exes/sdc/README.md#webgpu)).

## Parity

See [`exes/sdc`](../../exes/sdc/README.md#parity).

## Build

The module is committed. After a change to `exes/sdc/core` or `exes/sdc/wasm`, run `pnpm --filter @neurodesk/sdc build:wasm`.
`check:wasm` fails when a rebuild does not give the committed bytes (Rust 1.98.0, binaryen `version_117`).

## SyN field fitting

`@neurodesk/sdc/field-fit` is a separate Apache-2.0/BSD-3-Clause entry point backed by `src/sdc-field-fit.wasm` and [`exes/dwi/sdc`](../../exes/dwi/sdc). It does not use or replace the GPL PyHySCO implementation above.

```js
import { loadFieldFit } from '@neurodesk/sdc/field-fit';
const kernel = await loadFieldFit();
const grid = { shape: [nx, ny, nz], affine: voxelToRas };
const fitted = kernel.approximate(fieldHz, grid);
const reconstructed = kernel.evaluate(fitted.coefficients, fitted.grid, grid);
```

All scalar arrays are Float32 and x-fastest. `fieldToDisplacement` and `displacementToField` use interleaved LPS millimetre vectors and `{ readout, phaseEncodingDirection }`. Conversions require both acquisition fields; neither has a default. The latter takes the EPI grid's affine even when displacement samples lie on a different grid. Coefficient evaluation requires parallel corresponding grid axes; project to an aligned frame first. Conversions refuse unrepresentable readout times and nonfinite results. The fitting grid must have spacing of at least 1 mm; perform sdcflows' pre-resampling before calling this entry point on submillimetre data.

Fitting and evaluation refuse grids whose estimated CSR and buffers exceed a 3.5 GiB WebAssembly working budget. This budget is based on array storage and leaves 512 MiB of the 4 GiB address space for allocator and ABI overhead.

In Node, pass the committed module's bytes to `loadFieldFit`; the default URL is for browser asset loading. `build:field-fit` rebuilds it, and `check:field-fit` compares it byte for byte. See the crate README for pinned sources, numerical reduction and the full-brain reference gate.

## SyN-SDC pipeline

`@neurodesk/sdc/syn` corrects one DWI series with a T1w of the same session by sdcflows 2.17.1's fieldmap-less SyN-SDC, as the [SDC plan](../../docs/architecture/dwi-sdc-plan.md) ports it (Apache-2.0, `src/syn/`). The web app and a command line inject their runtimes, as `packages/brain2print` does: `/syn/node` runs every ANTs program in `@neurodesk/hmc-registration` worker threads, DenoiseImage (`@neurodesk/ants-denoise`) and N4 (`@neurodesk/n4`) in their own threads and MindGrab through `@neurodesk/node-drivers`; `/syn/browser` does the same with module workers and the app's MindGrab.

```js
import { correctFiles } from '@neurodesk/sdc/syn/node';

await correctFiles({
  dwi: 'sub-01_dir-AP_dwi.nii.gz', bval: 'sub-01_dir-AP_dwi.bval', bvec: 'sub-01_dir-AP_dwi.bvec', json: 'sub-01_dir-AP_dwi.json',
  t1w: 'sub-01_T1w.nii.gz', prior: 'sdc-prior/', output: 'derivatives/', signal,
});
```

`correctSusceptibility` (`/syn`) takes the same inputs as bytes with a `runtime`. The steps, each checked against the kept outputs of the native reference run:

| Step | Port | Check |
| --- | --- | --- |
| EPI reference | mean of the b < 50 volumes, `IntensityClip` 35/99.98, N4 (`--convergence [50x50x50x50x50,1e-07] --shrink-factor 4`), nipype's int16 round trip of the N4 output, `IntensityClip` 2/100 | equal to sdcflows' but 1 of 928,464 voxels (by 1/255): the WebAssembly N4 differs from native N4 within float rounding |
| Masks | MindGrab (`mindgrab`) of the mean b0 and of the T1w, or uploaded masks on those grids | equal to the reference's MindGrab masks |
| Anatomical reference | T1w × (mask > 0.5), `IntensityClip` 0/99.8, `DenoiseImage -n Gaussian -s 1` | equal (DenoiseImage in WebAssembly writes native ANTs's voxels) |
| epi2anat, T1w to MNI (Q59) | sdcflows `affine.json`, `--float 1 --random-seed`, in two kernels at once; the prior goes through `[epi2anat, 1]`, `[anat2std, 1]` and the atlas affine and is binarised at > 3 mm, or "no prior" uses the anat mask | the gate below |
| SyN inputs | the 1.2 mm sampling grid (Q68), anat and mask to it, `ImageMath Laplacian 1.5`, `_norm_lap`, dilations with `ball(3)`, the mask union, `_warp_dir` and `_mm2vox` | equal, and the argv strings are sdcflows' |
| Field | `displacementToField`, `antsApplyTransforms -u float BSpline`, `approximate` and `evaluate` (`./field-fit`) | the gate below |
| Unwarp | positive direction cosines, SciPy's cubic spline (`spline_filter`, `map_coordinates` order 3, mode `constant`), the Jacobian factor 1 + ∂vsm/∂pe, negative values to 0, every volume once | within half of the reference series' int16 quantisation step (0.0117, over 137 volumes) |

The phase-encoding direction and `TotalReadoutTime` come from the options, else the sidecar, else `EffectiveEchoSpacing × (N_PE − 1)`; without a direction or a readout time the run is refused, and the polarity is never guessed. An oblique DWI grid (≥ 0.5°) is refused, because sdcflows' deoblique step is not ported. The T1w is used as given (Q70).

Outputs (plan section 5): `*_desc-sdc_dwi.nii.gz` (every volume, b0 kept, float32), its `.bval` and `.bvec` unchanged and a `.json` with a `SusceptibilityDistortionCorrection` block, `*_desc-preproc_fieldmap.nii.gz` (Hz on the DWI grid) and `.json` (`Units: "Hz"`), `*_desc-coeff_fieldmap.nii.gz` and `.json`, `*_from-orig_to-sdc_mode-image_xfm.nii.gz` (the ITK displacement field) and `*_desc-brain_mask.nii.gz`. sdcflows writes the corrected series in the input's integer type with a slope; this port keeps float32.

An `AbortSignal` rejects the run and terminates its kernel, DenoiseImage, N4 and MindGrab workers.

### Gate

`test/syn-gate.test.js` runs the whole pipeline in Node on the full-brain ds005134 sub-01 and compares the field with the native double seed-1234 run on the 1.2 mm grid (`sdc/reference/grid-q68` at `e773666d`): the gate of Q66 is d ≤ max(spread, 0.05 Hz) and d < 0.5 Hz over the MindGrab mask of the mean b0, and without the 1.2 mm end-to-end spread only d ≤ 0.05 Hz decides the first condition. It also checks the unwarp against sdcflows' and reports the slab run against the native 2 mm slab runs. `.github/workflows/sdc-registration-gate.yml` (job `pipeline`) fetches the data with their SHA-256 and sets `SDC_REQUIRE_SYN_GATE=1`:

```sh
export $(python3 exes/dwi/sdc/validation/fetch_reference.py "$TMPDIR/sdc-reference" reference-run slab)
export $(python3 exes/dwi/sdc/validation/fetch_reference.py --folder grid "$TMPDIR/sdc-grid" replay-1.2mm)
export $(python3 exes/dwi/sdc/validation/fetch_reference.py --folder prior "$TMPDIR/sdc-prior" prior)
export $(node packages/sdc/validation/fetch-slab.mjs "$TMPDIR/sdc-slab")
(cd packages/sdc && node --test --test-concurrency=1 test/syn-gate.test.js)
```

`test/fixtures/syn-scipy.json` holds SciPy's outputs for the numeric ports on small random volumes (`validation/syn-scipy-fixture.py`, run in the reference's Python environment).
