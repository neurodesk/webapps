# @neurodesk/synthsr

SynthSR v2 brain image synthesis for standalone computers, HPC jobs and browsers.
Node.js 22+ runs the pretrained model with **native ONNX Runtime**, without Python,
a browser, a display server or a service. The Neurodesk SynthSR webapp imports the
same spatial processing, inference, augmentation and serialization code.

## Install the standalone npm package

On an internet-connected Linux x64 machine, paste these commands. They download
Node.js and SynthSR and install into the current folder without administrator access:

```sh
curl -fLO https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz
tar -xf node-v22.22.0-linux-x64.tar.xz
export PATH="$PWD/node-v22.22.0-linux-x64/bin:$PATH"
curl -fLO https://webapps.neurodesk.org/synthsr/downloads/neurodesk-synthsr-<version>.tgz
ONNXRUNTIME_NODE_INSTALL=skip npm install --prefix ./synthsr-cli ./neurodesk-synthsr-<version>.tgz
./synthsr-cli/node_modules/.bin/synthsr input.nii.gz output_synthsr.nii.gz --threads 8
```

Replace `input.nii.gz` with your scan. If Node.js 22+ is already installed, skip
the first three lines. The first run downloads the pinned 53 MB model and verifies
its SHA-256. Add `--ct` for CT. Output includes a synthetic NIfTI image and JSON
provenance. Existing outputs require `--force` to replace them.

The CPU binaries are included in the native dependency; `ONNXRUNTIME_NODE_INSTALL=skip`
avoids downloading optional GPU providers. The standalone tarball is served by the
webapp and is not published to the npm registry. Use `--help` for all options.

## Options and scientific behavior

Run `synthsr --help` for the complete interface. Defaults are MRI, full-volume
inference, left–right averaging and sharpening. `--ct` clips CT intensities to
[0,80] HU. `--no-flip` and `--no-sharpen` disable the corresponding operations.
`--tiled` uses approximate 96³ patches and changes receptive-field context; it can
introduce seams. Tiled mode is recorded in provenance and default output names.

`--device cpu` is the tested default. `--device cuda` selects the native CUDA
provider and disables CPU fallback. It requires a CUDA-enabled ONNX Runtime
installation plus compatible CUDA/cuDNN libraries, and was not validated on this
host. The CPU-only installation above skips optional providers; see the pinned
[ONNX Runtime Node installation script](https://github.com/microsoft/onnxruntime/blob/v1.29.0/js/node/script/install.js)
and [CUDA requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
when preparing a GPU installation. This is native CUDA, not browser WebGPU.

The package preserves the pinned Python implementation's 1 mm resampling, RAS
alignment, multiple-of-32 padding, intensity normalization, network scaling,
flip averaging, sharpening, restored orientation and uint8 serialization.
Synthetic contrast may alter or fill lesions; preserve original scans for
interpretation. No skull stripping or spatial normalization is performed.

## JavaScript API

Install the tarball as a project dependency with `npm install ./neurodesk-synthsr-<version>.tgz`.

```js
import { synthesize } from '@neurodesk/synthsr/node';
const result = await synthesize({
  input: 'input.nii.gz', output: 'output_synthsr.nii.gz',
  threads: 8, device: 'cpu',
  onProgress: (fraction, message) => console.error(message),
});
console.log(result.output, result.reportPath, result.provenance.timings);
```

The browser-safe root export exposes `runSynthsr`, spatial helpers and `runTiled`.
`runSynthsr` accepts NIfTI bytes, the runtime's Tensor class, a model loader and a
session factory. Only `@neurodesk/synthsr/node` imports Node filesystem/native APIs.

## Build and validate from the monorepo

```sh
pnpm install
pnpm --filter @neurodesk/synthsr test
pnpm --filter synthsr test
pnpm --filter synthsr build
```

The app build creates `apps/synthsr/dist/downloads/neurodesk-synthsr-<version>.tgz`.
To package just this library, run `npm pack` inside `packages/synthsr`. The tarball
contains its own pinned model manifest, source, CLI and attribution. It has no
workspace dependencies and excludes model weights, test images and web assets.
The canonical manifest lives at `models/synthsr.manifest.json`; keep this package's
copy synchronized (covered by the repository test).

Set `SYNTHSR_MODEL_PATH=/path/to/synthsr-v2.onnx` for the native numerical parity
test. The app's browser suite compares the same TensorFlow fixture on WASM and
WebGPU. Spatial fixtures cover anisotropic/permuted geometry, CT and NIfTI scaling.

The independently installed tarball also completed the full public FLAIR example
offline using two CPU threads. Across 6,598,560 output voxels, 102 differed from
the saved native reference by one uint8 intensity step and all others matched.
This is engineering parity evidence, not clinical validation. Details are recorded
in `test/native-validation.json` in the source repository.

Apache-2.0. See LICENSE and NOTICE. Model attribution: Iglesias et al., NeuroImage
237 (2021), 118206. https://doi.org/10.1016/j.neuroimage.2021.118206.

## Shared browser GPU runtime

`@neurodesk/synthsr/browser` exports `createBrowserSession(ort, bytes, backend, paddedShape, gpuOptions)`
and `browserRuntime(backend)`. Both SynthSR and SYNcro use this adapter with the shared
`runSynthsr` pipeline. SYNcro selects WebGPU by default; the adapter defaults to WASM when no backend is supplied. The `webgpu` backend runs the
checksum-pinned `synthsr-blocked-fp32-v1` executor from upstream commit `eeb9863`,
with blocked FP32 Conv3D, fused activations and graph-lifetime buffer reuse. It does
not fall back to ONNX Runtime GPU or CPU when the GPU cannot run the volume.

Pass the pipeline's session arguments through unchanged so GPU allocation uses the
prepared/padded dimensions. Supply the app's own ONNX Runtime instance and WASM URLs;
use `browserRuntime` in provenance to distinguish the custom GPU executor from ORT.
The optional `gpuOptions.bufferLimitHelp` lets a caller describe only recovery
paths its interface actually offers. SynthSR has no fixed single-buffer ceiling:
it attempts the allocation when the adapter's `maxBufferSize` and
`maxStorageBufferBindingSize` permit it. Other users of the shared executor keep
the conservative 2 GiB ceiling unless they explicitly provide their own policy.
The GPU graph index and kernels ship inside this npm package; no additional model
weights are required. Native Node/HPC CPU and CUDA execution still uses `./node`.

The browser adapter needs `@neurodesk/runtime-support` in the consuming app.
It is a development dependency here so standalone Node deployments omit the
browser runtime and its dependencies.
