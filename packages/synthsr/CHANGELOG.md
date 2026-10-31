# @neurodesk/synthsr

## 0.6.20261031

## 0.6.20261027

## 0.6.20261025

### Patch Changes

- 99037b6: Submit and await each WebGPU U-Net layer separately so a full-volume inference does not occupy one long command buffer. Preserve shader arithmetic and graph order, report the recorded device-loss reason instead of a generic readback failure, and check actual submission boundaries in SynthSeg's unchanged native-parity tests.

## 0.6.20261024

### Patch Changes

- Pair acquisition JSON and gradient inputs by automation role so metadata survives diffusion pipelines. Split DWI Correct and SDC inputs into single-image roles, require explicit acquisition values for automated correction, and expose correction settings. Export a corrected mean-b0 image for downstream brain masks. Use a generic single-volume error for shared image readers.

## 0.6.20261022

## 0.6.20261020

### Patch Changes

- d1fa022: SynthSR no longer runs on a software WebGPU adapter. fastprep chooses WebAssembly when the adapter is a fallback (SwiftShader on a VM or a hosted runner) or cannot bind the volume's largest buffer, and the SynthSR app starts on CPU there. The GPU buffer-limit message gives both sizes in MiB, so a need just above the limit no longer reads as "1.0 GiB but this device allows 1.0 GiB".

## 0.6.20261019

### Patch Changes

- da2584b: SynthSR no longer runs on a software WebGPU adapter. fastprep chooses WebAssembly when the adapter is a fallback (SwiftShader on a VM or a hosted runner) or cannot bind the volume's largest buffer, and the SynthSR app starts on CPU there. The GPU buffer-limit message gives both sizes in MiB, so a need just above the limit no longer reads as "1.0 GiB but this device allows 1.0 GiB".

## 0.6.20261018

## 0.6.20261017

## 0.6.20261016

## 0.6.20261015

### Patch Changes

- 84d192a: FLAMeS no longer rejects high-resolution FLAIR. A 0.4 mm 3D FLAIR of
  544 × 544 × 480 voxels exceeded SynthSR's 128 Mi voxel reader cap and failed
  with "Unsupported image dimensions". An input finer than FLAMeS's
  1 × 0.9 × 0.9 mm grid is now downsampled to that grid with nnU-Net's cubic
  resampling before brain extraction. Inputs up to 512 Mi voxels are accepted.
  The mask, probability map and table then use the resampled grid; the web app
  shows them over the resampled FLAIR and offers it for download, and the
  `flames` command writes it as `INPUT_flair_resampled.nii`. Inputs at or
  coarser than 1 × 0.9 × 0.9 mm are unchanged. `readVolume` in
  `@neurodesk/synthsr` takes an optional `maxVoxels` cap.

## 0.6.20261014

### Patch Changes

- 850e642: Remove code that nothing calls, found by the unused-code report and checked by
  repository-wide reference searches. The shared preview module no longer carries
  a second NIfTI parser and writer; NiftiUtils remains the only one. Outputs and
  behaviour are unchanged.

## 0.6.20261012

## 0.6.20261010

### Patch Changes

- Move caller-pinned MindGrab and niimath Node drivers and their independent browser parity validation to dependency-free `@neurodesk/node-drivers`. Migrate every command line and remove the old runtime-support exports. Keep SynthSR and SynthStrip browser runtimes out of production Node deployments so portable brain-extraction and BrowserQC archives omit browser dependencies.

## 0.6.20261009

### Patch Changes

- Updated dependencies [64ffefa]
  - @neurodesk/runtime-support@0.3.0

## 0.6.20261007

### Patch Changes

- Updated dependencies [22aa4bf]

  - @neurodesk/runtime-support@0.2.1

- Updated dependencies

  - @neurodesk/runtime-support@0.2.0

- Updated dependencies [22aa4bf]
  - @neurodesk/runtime-support@0.2.1

## 0.6.20261005

### Patch Changes

- Share native result publication between SynthSR and SynthSeg. Clean up newly created temporary files after failed writes while preserving each caller’s publication order and overwrite policy. Keep native path bytes when naming sibling temporaries.

## 0.6.20261004

### Minor Changes

- 257192b: Stream SynthSR and SynthStrip CPU inference by operator to avoid oversized browser allocations while preserving the pinned models. Reject normalization with less than one percent positive brain support in the MNI template before exposing downloads. Add numerical parity, allocation, failure recovery, and cropped-head regressions.

### Patch Changes

- Share native affine inversion and RAS axis selection between SynthSR and SynthSeg,
  including SynthSeg WASM, while preserving each method's preprocessing and outputs.

- Share raw NIfTI-1 header and scalar decoding between native SynthSR, native
  SynthSeg and SynthSeg WASM while preserving each reader's validation, precision,
  scaling and geometry rules.

- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3

## 0.5.20261004

## 0.5.20261003

## 0.5.20260930

## 0.5.20260928

## 0.4.20260928

## 0.4.20260924

## 0.4.20260923

## 0.4.20260920

## 0.4.20260918

## 0.4.20260916

## 0.4.20260915

## 0.3.20260914

### Patch Changes

- Updated dependencies [3cd773f]
  - @neurodesk/runtime-support@0.1.2

## 0.3.20260910

### Patch Changes

- Updated dependencies [3fe15c3]
  - @neurodesk/runtime-support@0.1.1
