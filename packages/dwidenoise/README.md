# @neurodesk/dwidenoise

Patch2Self denoising of diffusion MRI (Fadnavis et al. 2020) for the `dwidenoise` web app and its command line.
The numerical code is the Rust crate [`exes/dwi/denoise`](../../exes/dwi/denoise), a port of DIPY 1.12.1 `patch2self` version 1 (patch radius 0, `model="ols"`), compiled to `src/dwidenoise.wasm`.
It is BSD-3-Clause, as the DIPY source is.
The crate's README gives the method, the choices and why version 1 is used.

## Use

```js
import { loadDwidenoise } from '@neurodesk/dwidenoise';

const p2s = await loadDwidenoise(fetch(new URL('@neurodesk/dwidenoise/wasm', import.meta.url)));
const buffer = p2s.allocate(nvox * bvals.length);
buffer.view().set(volumes); // or decode the NIfTI straight into buffer.view()
p2s.denoise(buffer, nvox, bvals, { onProgress: (done, total) => {} });
const denoised = buffer.view();
buffer.free();
```

Data is volume-major Float32, as in NIfTI.
`allocate` puts it in the module's memory, and `denoise` works there in place, so the page holds one copy.
Call `view()` again after other calls: when the module's memory grows, earlier views detach.
`denoiseArray(data, nvox, bvals)` returns a denoised copy instead.

For workers, `accumulate(buffer, nvox, group, gram, first, count)` adds a voxel range to a group's Float64 Gram matrix, and the Gram matrices of separate ranges add element by element.
`solve(gram, group)` makes the coefficients, and `apply(buffer, nvox, group, coefficients, first, count)` replaces a range with its predictions.
`fittedGroups(bvals)` gives the groups to fit: the b0 volumes (b < 50 s/mm², `B0_THRESHOLD` from the module) when there are two or more, and the diffusion-weighted volumes.

## Parity

The WASM output of the ds005134 slab (67 × 92 × 10 × 137) equals the stage 1 DIPY reference (`dwidenoise/validation` in the dataset, float32) bit for bit.
`scripts/check-slab.mjs INPUT.nii.gz INPUT.bval REFERENCE.nii.gz` repeats the check and times the two passes.
In Node 22 on the development host, the Gram pass did about 0.5 million voxels per second and the apply pass about 0.24 million voxels per second (both groups, 137 volumes).

## Build

The module is committed. After a change to `exes/dwi/denoise` or `exes/dwi/denoise-wasm`, run `pnpm --filter @neurodesk/dwidenoise build:wasm`.
`check:wasm` fails when a rebuild does not give the committed bytes (Rust 1.98.0, binaryen `version_117`).
