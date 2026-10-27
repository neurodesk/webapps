# bison

## 0.1.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.1
  - @neurodesk/bison@0.2.2
  - @neurodesk/runtime-support@0.9.17

## 0.1.20261025

### Patch Changes

- Share the pinned ANTs registration WebAssembly binary with HMC in the composite site, keeping worker modules local and standalone builds self-contained. This removes a duplicate 15 MB kernel and keeps the site within its existing artifact budget.
- 718e8bb: Download the BISON and BISON-WMH classifiers, tissue priors, histograms and average FLAIR from their pinned dataset URLs, now published with the permission of the BISON authors. The app segments images without a local model folder, and the full example runs are in the browser tests.
- Updated dependencies [718e8bb]
  - @neurodesk/bison@0.2.1

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
