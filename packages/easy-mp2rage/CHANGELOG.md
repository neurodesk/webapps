# @neurodesk/easy-mp2rage

## 0.8.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/webapp-components@0.22.3

## 0.8.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1

## 0.8.20261024

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2

## 0.8.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0

## 0.8.20261020

### Patch Changes

- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [ea2a6d2]

- Updated dependencies [3f1d770]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [d9718cd]

  - @neurodesk/webapp-components@0.16.3

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0

  - @neurodesk/webapp-components@0.16.3

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
- Updated dependencies [14db080]

## 0.8.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]
  - @neurodesk/webapp-components@0.16.3

## 0.8.20261018

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]

  - @neurodesk/webapp-components@0.15.1

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4

- Updated dependencies [b67e4e9]
  - @neurodesk/webapp-components@0.15.1

## 0.8.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.8.20261016

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.8.20261015

### Patch Changes

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.8.20261014

### Patch Changes

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.8.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.8.20261010

### Minor Changes

- Advance already released same-day consumers for the shared NIfTI reader fix without reusing immutable release versions.

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

  - @neurodesk/webapp-components@0.12.1

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

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

- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2
