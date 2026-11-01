# @neurodesk/bison

## 0.2.20261031

### Minor Changes

- 29c6db9: The `bison` command line now ships as portable archives for Linux, Windows and macOS, with the model files and its own Node runtime, so it runs offline. Each archive passes the command-line check against the web app's outputs before release.
- f860d91: BISON registers the T1 to the ICBM 2009c template (affine) and the FLAIR to the T1 (rigid) with Greedy instead of ANTs. On the five native validation subjects every label gate still holds and these two steps take about 30 s each instead of 94 and 130 s. The nonlinear registration stays on ANTs SyN. Greedy's WebAssembly gains a rigid (6 DOF) export and a browser worker for its single-threaded build, which BISON runs in the browser and in Node so that both give the same files. hmc-registration can write ITK `.mat` transforms (`writeMatTransform`).
- 1a4882c: BISON's nonlinear registration to ICBM 2009c runs on Greedy with neighbourhood cross-correlation (radius 2, to 1 mm, from the inverse T1 affine) instead of ANTs SyN, so every BISON registration now runs on Greedy. On the five native validation subjects every label gate still holds and agreement is 0.936 to 0.946. The step takes about 10 minutes instead of 23 to 27, and its WebAssembly heap is 1.5 GB instead of 2.2 GB. Labels and probabilities change slightly; the browser reference is rerecorded.

### Patch Changes

- d0ea0ef: A registration group no longer loads a new kernel after 20 runs. The limit worked around #537, which the hmc kernel fixed by restoring its stack after each run. No group runs more than 19 commands, so every output stays the same. Each group still gets its own instance, and an abort still loads a new one.
- Updated dependencies [f860d91]
- Updated dependencies [d8ac48c]
- Updated dependencies [1a4882c]
- Updated dependencies [b84a269]
  - @neurodesk/hmc-registration@0.4.0
  - @neurodesk/webapp-components@0.22.3
  - @neurodesk/node-drivers@0.3.1
  - @neurodesk/greedy@0.8.20261031

## 0.2.4

### Patch Changes

- Updated dependencies [f1ac9b2]
- Updated dependencies [ac283dd]
  - @neurodesk/hmc-registration@0.3.1

## 0.2.3

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2

## 0.2.2

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.1

## 0.2.1

### Patch Changes

- 718e8bb: Download the BISON and BISON-WMH classifiers, tissue priors, histograms and average FLAIR from their pinned dataset URLs, now published with the permission of the BISON authors. The app segments images without a local model folder, and the full example runs are in the browser tests.

## 0.2.0

### Minor Changes

- bd5f3a8: Add BISON, brain tissue segmentation in the browser. From a T1-weighted image it classifies 8 tissue classes; with a FLAIR image, BISON-WMH adds white matter hyperintensities. `@neurodesk/bison` holds the pipeline that the app and the Node command line share: ANTs denoising, N4, registration to ICBM 2009c, the random forest features and the outputs on the T1 grid. The trained classifiers and priors are not published yet, so a run needs a local copy of them until the BISON authors allow publication.

### Patch Changes

- Keep repeated denoising calls stable by restoring the WebAssembly stack, and fix the pinned kernel rebuild. Reject invalid image geometry, accept DICOM series through the shared converter for T1 and FLAIR, and declare label maps and compressed outputs accurately. Keep both complete model workflows in the normal browser test tier. Public model publication remains required before the app can ship working examples.
- Updated dependencies [bd5f3a8]
- Updated dependencies
- Updated dependencies [bd5f3a8]
  - @neurodesk/ants-denoise@0.2.0
  - @neurodesk/webapp-components@0.22.0
