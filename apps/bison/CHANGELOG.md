# bison

## 0.1.20261024

### Minor Changes

- bd5f3a8: Add BISON, brain tissue segmentation in the browser. From a T1-weighted image it classifies 8 tissue classes; with a FLAIR image, BISON-WMH adds white matter hyperintensities. `@neurodesk/bison` holds the pipeline that the app and the Node command line share: ANTs denoising, N4, registration to ICBM 2009c, the random forest features and the outputs on the T1 grid. The trained classifiers and priors are not published yet, so a run needs a local copy of them until the BISON authors allow publication.

### Patch Changes

- Keep repeated denoising calls stable by restoring the WebAssembly stack, and fix the pinned kernel rebuild. Reject invalid image geometry, accept DICOM series through the shared converter for T1 and FLAIR, and declare label maps and compressed outputs accurately. Keep both complete model workflows in the normal browser test tier. Public model publication remains required before the app can ship working examples.
- Updated dependencies
- Updated dependencies [bd5f3a8]
- Updated dependencies [bd5f3a8]
  - @neurodesk/bison@0.2.0
  - @neurodesk/webapp-components@0.22.0
  - @neurodesk/runtime-support@0.9.12
