# @neurodesk/n4

ANTs N4BiasFieldCorrection compiled to WebAssembly, for the `n4` web app and its command line, with the DWI procedure of MRtrix `dwibiascorrect ants`.
It is a separate module from `@neurodesk/registration`, at the same pinned ANTs commit and ITK-Wasm toolchain, so the SYNcro and ANTs kernels do not change.

## Use

```js
import { createN4, rescaleBias, divideVolumes } from '@neurodesk/n4';
import createModule from '@neurodesk/n4/module';

const n4 = await createN4({ createModule, wasmBinary });
const { corrected, bias } = await n4.correct({ image: meanB0Nifti, weight: maskNifti });
```

`correct` runs `N4BiasFieldCorrection -d 3 -i IN -w WEIGHT -o [CORRECTED,BIAS] -s 4 -b [100,3] -c [1000,0.0]`, the `dwibiascorrect ants` defaults, and returns NIfTI bytes.
For a DWI series, `rescaleBias` keeps the brain integral as `dwibiascorrect` does, and `divideVolumes` corrects every volume.
Run it in a worker: N4 is synchronous.

## Parity

On the mean b0 and `bet` mask of the ds005134 sub-01 example slab (44 521 mask voxels, field 0.97-2.02), the module's bias field equals native ANTs 2.6.5 `N4BiasFieldCorrection` (Neurodesk container, one thread) exactly: correlation 1, maximum relative difference 0. It took 1.9 s in Node.

## Rebuild

Docker, curl and tar are required:

```bash
bash packages/n4/scripts/build.sh /var/tmp/n4-build
```

The script downloads ANTs at `52bc0ab588102682587303d31c720de94e6ef6c1` and compiles in `itkwasm/emscripten@sha256:d6c35290…`, one job, with an 8 GB container limit (`N4_BUILD_MEMORY`).
