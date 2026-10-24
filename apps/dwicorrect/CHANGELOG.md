# dwicorrect

## 0.1.20261024

### Minor Changes

- 3fc9cf2: DWI Correct is a new app that corrects a diffusion MRI series in the browser, as FSL eddy does: head motion, eddy-current distortion, susceptibility distortion and slices that lost signal are estimated together, and each volume is resampled once with Jacobian modulation. Drop the series with its bval, bvec and JSON sidecar, as loose files or a BIDS folder, with an optional reverse phase-encoding b0, topup `_fieldcoef` image or field map in Hz. Each volume is registered to a prediction from the others (3dSHORE for 72 or more diffusion-weighted volumes, else a Gaussian process); slices far below their prediction are replaced, tested as single slices and as multiband groups. The field comes from the reverse-PE b0 through the SDC app's PyHySCO port and the brain mask from MindGrab. The outputs are BIDS derivatives: the corrected series with its bval, rotated bvec and sidecar, the movement and outliers per volume, the mask, the field, a before/after GIF and the log. The example is OpenNeuro ds006676 sub-001 (CC0), a multiband 3 series of 141 volumes with a PA b0.

  `@neurodesk/shoreline` holds the threaded and single-threaded WebAssembly builds of `exes/dwi/shoreline`, the Rust command line that the app runs on files held in memory. It is implemented from the eddy papers without FSL code.

  `@neurodesk/webapp-components`: numeric table cells do not wrap; a wide table scrolls instead. `parseNiftiHeader` gives the header's `intentCode`. `assertImageValues` refuses an image with NaN or infinite values, or with one value in every voxel, and names it in the message. The imaging workspace has `.nd-viewer-image`, an image shown in place of the viewer canvas, and `.nd-file-info-lines`, file information with one item per line and `.nd-file-info-gap` before a group.

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/shoreline@0.2.0
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/runtime-support@0.9.9
  - @neurodesk/sdc@0.2.20261024
