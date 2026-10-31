# hmc

## 0.4.20261031

### Patch Changes

- Updated dependencies [f860d91]
- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/hmc-registration@0.4.0
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/webapp-components@0.22.3
  - @neurodesk/hmc@0.4.20261031
  - @neurodesk/dwi2trx@0.8.20261031

## 0.4.20261029

### Patch Changes

- 72861b0: Refuse inputs the motion model cannot hold, with a clear message, instead of failing with "unreachable": a series is checked when it loads (decoded size and DWI volume count), again for the selected model before automatic masking, and with the brain mask before the run. The estimate counts initialisation's whole-grid arrays and the GP prediction's buffers, is measured on the estimator's 1 GiB WebAssembly memory and is shared with the `hmc` command line.
- Updated dependencies [72861b0]
- Updated dependencies [f1ac9b2]
- Updated dependencies [ac283dd]
  - @neurodesk/hmc@0.4.20261029
  - @neurodesk/hmc-registration@0.3.1
  - @neurodesk/dwi2trx@0.8.20261029

## 0.4.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
  - @neurodesk/dwi2trx@0.8.20261027
  - @neurodesk/hmc@0.4.20261027
  - @neurodesk/runtime-support@0.9.18
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1
  - @neurodesk/dwi2trx@0.8.20261027
  - @neurodesk/hmc@0.4.20261027
  - @neurodesk/runtime-support@0.9.17

## 0.4.20261025

### Patch Changes

- Updated dependencies [74b9c63]
  - @neurodesk/runtime-support@0.9.16
  - @neurodesk/dwi2trx@0.8.20261025
  - @neurodesk/hmc@0.4.20261025
- Updated dependencies [3226bb7]
  - @neurodesk/hmc-registration@0.3.0
  - @neurodesk/hmc@0.4.20261025
- @neurodesk/dwi2trx@0.8.20261025
- @neurodesk/hmc@0.4.20261025
- Updated dependencies [99037b6]
  - @neurodesk/runtime-support@0.9.15
  - @neurodesk/dwi2trx@0.8.20261025
  - @neurodesk/hmc@0.4.20261025
- ab5824c: Default the app, automation and command line to two registration workers based on the completed GP benchmark. Keep explicit worker overrides and the same default for both estimators.
- Updated dependencies [ab5824c]
  - @neurodesk/hmc@0.4.20261025

## 0.4.20261024

### Minor Changes

- 328cb77: Add a browser workspace and Node command line for GP and trivial diffusion head-motion correction, with pinned CPU brain masking, explicit worker controls, BIDS derivatives and effective-mask provenance. Verify the hosts against actual production-browser reference outputs.

### Patch Changes

- @neurodesk/dwi2trx@0.8.20261024
- @neurodesk/hmc@0.4.20261024
- 3e7ff03: Keep HMC's loaded files synchronized with page-drop routing and Undo. Serialize paired imports, preserve the last valid input after failures, and cancel pending imports together while retaining the prior mask. Cite MindGrab's method paper. Run the full pinned dmipy white-matter slab through production browser downloads in CI, with all 19 reference files verified by size and checksum.
  - @neurodesk/hmc@0.4.20261024
- Updated dependencies [ecaf40a]
  - @neurodesk/hmc@0.4.20261024
  - @neurodesk/dwi2trx@0.8.20261024
- cd75826: Bundle one registration kernel pair through the worker's existing URLs instead of staging a duplicate, and declare the scoped MindGrab runtime in the site registry.
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/dwi2trx@0.8.20261024
  - @neurodesk/hmc@0.4.20261024
  - @neurodesk/runtime-support@0.9.14
- d73bb8b: Use the shared scan picker and DICOM conversion for supplied brain masks, rejecting selections containing more than one mask image.
  - @neurodesk/hmc@0.4.20261024
- 3e93e32: Restore the previous BIDS run selection when loading another run fails, preserving the retained input, supplied mask and completed results.
  - @neurodesk/hmc@0.4.20261024
- Updated dependencies [328cb77]
- Updated dependencies [14d97d8]
- Updated dependencies [25f296e]
  - @neurodesk/hmc@0.4.20261024
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/dwi2trx@0.8.20261024
  - @neurodesk/runtime-support@0.9.13
