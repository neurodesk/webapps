# SynthSeg (web)

Segments a 3D brain scan into FreeSurfer labels in the browser. Preprocessing,
post-processing and NIfTI I/O are the native CLI's Rust compiled to WASM
(`@neurodesk/synthseg`); the U-Net runs on WebGPU through the shared
`@neurodesk/runtime-support/gpu-unet` executor.

WebGPU is required — there is no WASM fallback. Without it the app says so and
Run stays disabled.

Labels use the shared `@neurodesk/webapp-components/automation/freesurfer-lut`
mapping, also used by native automation reports. Regenerate its 33 SynthSeg label
entries with `node scripts/freesurfer-lut.mjs <FreeSurferColorLUT.txt>`.

## Controls

- **Input image** — NIfTI or DICOM (drag-drop supported), or the `T1_head` example.
- **Mode** — `default` reproduces the reference output (flip averaging plus
  topological correction); `fast` is a single pass.
- **CT** — auto-checked when the loaded image contains negative intensities.
- **Output** — label-overlay opacity, `<stem>_synthseg.nii.gz`, `<stem>_synthseg.json`.

## Automation limits

`automation.json` declares the browser's limit under
`operations.segment.limits.browser.inputs.image`. Desktop `apps_validate` and
`apps_run` read the NIfTI header before starting a run. They derive SynthSeg's
resampled, RAS-aligned grid and pad each axis to a multiple of 32, at least 128.
The current GPU graph needs 288 bytes per padded voxel in its largest activation
buffer. Its validated cap remains 2,147,483,647 bytes (7,456,540 padded voxels).

The 192×256×256 case therefore fails preflight with the required buffer size and
the native-engine alternative. A 96×128×128 source with 2 mm spacing reaches the
same limit after resampling; compressed file size and source voxel count cannot
predict this limit. The check uses the existing preprocessing rule: absolute
`pixdim` outside 0.95–1.05 triggers resampling using affine column lengths. It
preserves the runtime's numeric-spacing treatment of spatial units.

Uncompressed reads need only the 352-byte header. Compressed reads stop once that
header is available and accept at most 1 MiB of compressed prefix. This preflight
does not validate voxel data or guarantee that a particular adapter has enough
memory. Runtime adapter checks still apply. DICOM geometry is unavailable until
conversion, so its check remains deferred to that runtime guard. The native
engine is exempt from this browser limit.

## Develop

```sh
pnpm --filter synthseg dev      # SYNTHSEG_ASSET_DIR=<dir with synthseg-2.0.onnx> to serve the model locally
pnpm --filter synthseg test
pnpm --filter synthseg lint
pnpm --filter synthseg build
pnpm --filter synthseg test:e2e # real model on SwiftShader WebGPU; downloads the 53 MB weights
```

The model is fetched from Hugging Face and cached (Cache API) after a SHA-256
check against `@neurodesk/synthseg/manifest` (`packages/synthseg/model.manifest.json`);
it is never bundled.

## Validation

`pnpm --filter synthseg test:e2e` always runs the real model on the small fixture, in both modes,
and gates the labels against FreeSurfer's (mismatch ≤ 5e-6). It needs no GPU: Chromium's software
WebGPU adapter (SwiftShader) is enough, at a few minutes per mode.

`SYNTHSEG_HARDWARE_GPU=1 SYNTHSEG_ASSET_DIR=../../exes/synthseg/models SYNTHSEG_REFERENCE_DIR=~/src/synthseg-references pnpm --filter synthseg test:e2e`
adds both benchmark volumes on the real GPU (SwiftShader cannot hold their buffers) and
gates them like the native CLI (mismatch ≤ 2e-6, identical geometry). The last run is in
`validation/report.json`: 0–1 of 5.6 M voxels differ from FreeSurfer, 6–10 s per volume on an
M4 Pro.

## Standalone

The native CLI is `exes/synthseg` in this repository.
