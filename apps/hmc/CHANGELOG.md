# hmc

## 0.4.20261024

### Minor Changes

- 328cb77: Add a browser workspace and Node command line for GP and trivial diffusion head-motion correction, with pinned CPU brain masking, explicit worker controls, BIDS derivatives and effective-mask provenance. Verify the hosts against actual production-browser reference outputs.

### Patch Changes

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
