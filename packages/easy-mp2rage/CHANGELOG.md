# @neurodesk/easy-mp2rage

## 0.7.20261007

### Minor Changes

- b7dd98f: Add the `easy-mp2rage` command line with `correct` and `denoise`, the web app's batch operations with the same parameters and output files. It runs the web app's WebAssembly core with Node, and portable Linux x64, Windows x64 and macOS arm64 archives bundle the Node runtime. Before release, each archive must reproduce the Python golden phantom and match the web worker on the pinned 7 T example voxel for voxel. The web app now loads its WebAssembly core and NIfTI code from `@neurodesk/easy-mp2rage`, and `parameters.json` from denoising records the regularization instead of unused MP2RAGE settings.

### Patch Changes

- b7dd98f: The web app and the command line refuse INV1 or INV2 images that have UNI's dimensions but a different orientation, voxel size or origin, instead of combining them voxel for voxel with the wrong anatomy. `parameters.json` now records every setting that changes a result: the tfl reference angle, FOV extension, the uncorrected fallback and whether the mask came from INV2 or UNI. Each release archive is checked against Python pipeline outputs for every option, and the committed WebAssembly core is rebuilt from source and compared before packaging.
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2
