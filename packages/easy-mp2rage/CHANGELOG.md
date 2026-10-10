# @neurodesk/easy-mp2rage


## 0.8.20261010

### Minor Changes

- Advance already released same-day consumers for the shared NIfTI reader fix without reusing immutable release versions.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.1

## 0.7.20261010

### Patch Changes

- Align Rust/WASM with the Python reference: derive no-INV2 masks from absolute UNI contrast around its median, and use 0.35–1.7 for B1 extension fitting and extrapolation. Match the unregularized minimum-norm polynomial fit and even-sized median fallback. No-INV2 maps and optional extension results can change. Add independent Python goldens for both B1 sources, fallback, both clamp bounds, sparse samples and rank-deficient fits, and rebuild the shared WASM.

## 0.7.20261009

### Patch Changes

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
  - @neurodesk/webapp-components@0.12.0

## 0.7.20261007

### Minor Changes

- b7dd98f: Add the `easy-mp2rage` command line with `correct` and `denoise`, the web app's batch operations with the same parameters and output files. It runs the web app's WebAssembly core with Node, and portable Linux x64, Windows x64 and macOS arm64 archives bundle the Node runtime. Before release, each archive must reproduce the Python golden phantom and match the web worker on the pinned 7 T example voxel for voxel. The web app now loads its WebAssembly core and NIfTI code from `@neurodesk/easy-mp2rage`, and `parameters.json` from denoising records the regularization instead of unused MP2RAGE settings.

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
- b7dd98f: The web app and the command line refuse INV1 or INV2 images that have UNI's dimensions but a different orientation, voxel size or origin, instead of combining them voxel for voxel with the wrong anatomy. `parameters.json` now records every setting that changes a result: the tfl reference angle, FOV extension, the uncorrected fallback and whether the mask came from INV2 or UNI. Each release archive is checked against Python pipeline outputs for every option, and the committed WebAssembly core is rebuilt from source and compared before packaging.
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2
