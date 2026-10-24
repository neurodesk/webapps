# @neurodesk/ants-denoise

## 0.2.0

### Minor Changes

- bd5f3a8: Add `@neurodesk/ants-denoise`: ANTs `DenoiseImage` (adaptive non-local means, ITKAdaptiveDenoising) in its own WebAssembly module, with `createDenoiser` and the pinned Node loader `loadDenoise`. It runs one ITK thread, accepts an optional mask and returns float32 NIfTI.

### Patch Changes

- Keep repeated denoising calls stable by restoring the WebAssembly stack, and fix the pinned kernel rebuild. Reject invalid image geometry, accept DICOM series through the shared converter for T1 and FLAIR, and declare label maps and compressed outputs accurately. Keep both complete model workflows in the normal browser test tier. Public model publication remains required before the app can ship working examples.
