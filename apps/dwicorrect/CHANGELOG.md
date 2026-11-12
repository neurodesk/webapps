# dwicorrect

## 0.1.20261112

### Patch Changes

- @neurodesk/sdc@0.5.20261112

## 0.1.20261111

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0
  - @neurodesk/runtime-support@0.9.25
  - @neurodesk/sdc@0.5.20261111

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0
  - @neurodesk/runtime-support@0.9.24
  - @neurodesk/sdc@0.5.20261109

## 0.1.20261108

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
  - @neurodesk/runtime-support@0.9.23
  - @neurodesk/sdc@0.5.20261108

## 0.1.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0
  - @neurodesk/runtime-support@0.9.22
  - @neurodesk/sdc@0.5.20261104

## 0.1.20261103

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
  - @neurodesk/sdc@0.5.20261103
  - @neurodesk/runtime-support@0.9.21
- Updated dependencies [8e9346d]
- Updated dependencies [239dedd]
- Updated dependencies [9868d87]
- Updated dependencies [71881c8]
  - @neurodesk/webapp-components@0.22.4
  - @neurodesk/sdc@0.4.20261103
  - @neurodesk/runtime-support@0.9.20

## 0.1.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/webapp-components@0.22.3
  - @neurodesk/sdc@0.3.20261031

## 0.1.20261029

### Patch Changes

- @neurodesk/sdc@0.3.20261029

## 0.1.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
  - @neurodesk/runtime-support@0.9.18
  - @neurodesk/sdc@0.3.20261027
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1
  - @neurodesk/runtime-support@0.9.17
  - @neurodesk/sdc@0.3.20261027

## 0.1.20261025

### Patch Changes

- Updated dependencies [74b9c63]
- Updated dependencies [4bc35f7]
  - @neurodesk/runtime-support@0.9.16
  - @neurodesk/sdc@0.3.20261025
- Updated dependencies [99037b6]
  - @neurodesk/runtime-support@0.9.15
  - @neurodesk/sdc@0.2.20261025

## 0.1.20261024

### Minor Changes

- 3fc9cf2: DWI Correct is a new app that corrects a diffusion MRI series in the browser, as FSL eddy does: head motion, eddy-current distortion, susceptibility distortion and slices that lost signal are estimated together, and each volume is resampled once with Jacobian modulation. Drop the series with its bval, bvec and JSON sidecar, as loose files or a BIDS folder, with an optional reverse phase-encoding b0, topup `_fieldcoef` image or field map in Hz. Each volume is registered to a prediction from the others (3dSHORE for 72 or more diffusion-weighted volumes, else a Gaussian process); slices far below their prediction are replaced, tested as single slices and as multiband groups. The field comes from the reverse-PE b0 through the SDC app's PyHySCO port and the brain mask from MindGrab. The outputs are BIDS derivatives: the corrected series with its bval, rotated bvec and sidecar, the movement and outliers per volume, the mask, the field, a before/after GIF and the log. The example is OpenNeuro ds006676 sub-001 (CC0), a multiband 3 series of 141 volumes with a PA b0.

  `@neurodesk/shoreline` holds the threaded and single-threaded WebAssembly builds of `exes/dwi/shoreline`, the Rust command line that the app runs on files held in memory. It is implemented from the eddy papers without FSL code.

  `@neurodesk/webapp-components`: numeric table cells do not wrap; a wide table scrolls instead. `parseNiftiHeader` gives the header's `intentCode`. `assertImageValues` refuses an image with NaN or infinite values, or with one value in every voxel, and names it in the message. The imaging workspace has `.nd-viewer-image`, an image shown in place of the viewer canvas, and `.nd-file-info-lines`, file information with one item per line and `.nd-file-info-gap` before a group.

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
  - @neurodesk/runtime-support@0.9.12
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/runtime-support@0.9.11
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [3fc9cf2]
  - @neurodesk/shoreline@0.2.0
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/runtime-support@0.9.9
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/runtime-support@0.9.14
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/runtime-support@0.9.13
  - @neurodesk/sdc@0.2.20261024
- @neurodesk/sdc@0.2.20261024
- Updated dependencies
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/runtime-support@0.9.12
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
  - @neurodesk/runtime-support@0.9.11
  - @neurodesk/sdc@0.2.20261024
- Pair acquisition JSON and gradient inputs by automation role so metadata survives diffusion pipelines. Split DWI Correct and SDC inputs into single-image roles, require explicit acquisition values for automated correction, and expose correction settings. Export a corrected mean-b0 image for downstream brain masks. Use a generic single-volume error for shared image readers.
- Generate artifact format qualifiers from MIME types and gradient roles, and preserve explicit artifact encodings. Keep gradient input formats in contract metadata until NeuroFlow gains inspectors. Type DWI brain masks as masks so pipeline bindings reject scalar images.
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/sdc@0.2.20261024
