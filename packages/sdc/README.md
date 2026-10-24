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
