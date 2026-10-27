# @neurodesk/white-matter-lesions

## 0.5.20261027

### Patch Changes

- Retry bounded transient CI download failures without weakening checksums, handle Windows lockfile line endings, and improve NODDI input mismatch diagnostics. Add early catalog integration checks and register generated app offline workflows and standalone exceptions.
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1
  - @neurodesk/synthsr@0.6.20261027
  - @neurodesk/synthstrip@0.2.0

## 0.5.20261025

### Patch Changes

- @neurodesk/synthsr@0.6.20261025
- @neurodesk/synthstrip@0.2.0
- Updated dependencies [99037b6]
  - @neurodesk/synthsr@0.6.20261025
  - @neurodesk/synthstrip@0.2.0

## 0.5.20261024

### Patch Changes

- @neurodesk/synthsr@0.6.20261024
- @neurodesk/synthstrip@0.2.0
- Updated dependencies
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/synthstrip@0.2.0

## 0.5.20261022

### Patch Changes

- 330f5b3: Keep the exact NiiVue rc.33 release-age exception effective by removing its obsolete rc.14 exception. Frozen installs can use the reviewed rc.33 build immediately without relaxing the age policy for other versions.

  Reject duplicate exact package names in the release-age exclusions, which pnpm evaluates using the first match. Keep exact version unions and distinct package patterns valid, and remove the obsolete shadowing niimath exception.

- @neurodesk/synthsr@0.6.20261022
- @neurodesk/synthstrip@0.2.0

## 0.5.20261020

### Patch Changes

- @neurodesk/synthsr@0.6.20261020
- @neurodesk/synthstrip@0.2.0
- @neurodesk/synthstrip@0.1.5
- Updated dependencies [d1fa022]

  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5

- Updated dependencies
  - @neurodesk/synthstrip@0.2.0
- @neurodesk/synthsr@0.6.20261020

- @neurodesk/synthstrip@0.1.5

- Updated dependencies [d1fa022]
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5

## 0.5.20261019

### Patch Changes

- @neurodesk/synthsr@0.6.20261019

- @neurodesk/synthstrip@0.1.5

- Updated dependencies [da2584b]
  - @neurodesk/synthsr@0.6.20261019
  - @neurodesk/synthstrip@0.1.5

## 0.5.20261018

### Patch Changes

- @neurodesk/synthsr@0.6.20261018
- @neurodesk/synthstrip@0.1.5

- @neurodesk/synthsr@0.6.20261018

- @neurodesk/synthstrip@0.1.5

## 0.4.20261018

### Patch Changes

- @neurodesk/synthsr@0.6.20261018
- @neurodesk/synthstrip@0.1.5

- @neurodesk/synthsr@0.6.20261018

- @neurodesk/synthstrip@0.1.5

## 0.4.20261017

### Patch Changes

- 202fd16: Step through segmented lesions in the viewer. ‹ and › centre the crosshair on each lesion in turn, largest first, and the Overlay toggle hides the mask or probability map to check the FLAIR beneath. The Output section shows the lesion count and the total, largest, median and smallest lesion volume. `lesionResults` now also returns the ranked lesions (`lesions`: volume and centroid in mm).
  - @neurodesk/synthsr@0.6.20261017
  - @neurodesk/synthstrip@0.1.5

## 0.3.20261016

### Patch Changes

- @neurodesk/synthsr@0.6.20261016
- @neurodesk/synthstrip@0.1.5
- @neurodesk/synthstrip@0.1.5

- @neurodesk/synthsr@0.6.20261016

## 0.3.20261015

### Patch Changes

- @neurodesk/synthsr@0.6.20261015
- @neurodesk/synthstrip@0.1.5
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
- Updated dependencies [84d192a]

  - @neurodesk/synthsr@0.6.20261015

- @neurodesk/synthsr@0.6.20261015

- @neurodesk/synthstrip@0.1.5

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

- Updated dependencies [84d192a]
  - @neurodesk/synthsr@0.6.20261015

## 0.3.20261014

### Patch Changes

- Updated dependencies [850e642]
  - @neurodesk/synthsr@0.6.20261014
  - @neurodesk/synthstrip@0.1.5

## 0.3.20261012

### Patch Changes

- @neurodesk/synthsr@0.6.20261012
- @neurodesk/synthstrip@0.1.5

- @neurodesk/synthsr@0.6.20261012

- @neurodesk/synthstrip@0.1.5

## 0.3.20261010

### Minor Changes

- Load each verified FLAMeS fold after the previous inference session is released, rather than retaining all five model graphs. Stream the command line's model preflight checks while preserving early missing or corrupt file refusal. Keep the model pins, inference parameters and output reference gates unchanged, and measure the complete five-fold browser workflow in Chrome and native Safari.

### Patch Changes

- @neurodesk/synthsr@0.6.20261010
- @neurodesk/synthstrip@0.1.5
- Updated dependencies

  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5

- @neurodesk/synthsr@0.6.20261010

- @neurodesk/synthstrip@0.1.5

- Updated dependencies
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5

## 0.2.20261009

### Patch Changes

- Updated dependencies [bb10737]
  - @neurodesk/synthstrip@0.1.4
  - @neurodesk/synthsr@0.6.20261009

## 0.2.20261007

### Minor Changes

- 5ec8fe3: Add the `flames` command line: FLAMeS lesion segmentation on the CPU with ONNX Runtime Node, writing the web app's lesion mask, probability map and lesion table under the same names. It takes the app's `--folds 1|5` and `--skull-stripped` settings, installs SynthStrip and all five folds with SHA-256 checks on every load, and ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer that each bundle Node and the models. Each release must reproduce the web app's lesion count, mask volume and summed probability, as recorded in a browser, on the pinned example with one fold and with the ensemble. With one fold it must also match the web app's WebAssembly pipeline at mask Dice 0.998 or better, with no probability more than 0.1 apart. The pipeline moves into the new `@neurodesk/white-matter-lesions` package, which the web app now uses.

### Patch Changes

- @neurodesk/synthstrip@0.1.3
- @neurodesk/synthsr@0.6.20261007
- @neurodesk/synthstrip@0.1.2
- @neurodesk/synthsr@0.6.20261007

- @neurodesk/synthstrip@0.1.3
