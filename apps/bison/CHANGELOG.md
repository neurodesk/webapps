# bison

## 0.2.20261111

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0
  - @neurodesk/bison@0.2.20261111
  - @neurodesk/runtime-support@0.9.25

## 0.2.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0
  - @neurodesk/bison@0.2.20261109
  - @neurodesk/runtime-support@0.9.24

## 0.2.20261108

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
  - @neurodesk/bison@0.2.20261108
  - @neurodesk/runtime-support@0.9.23

## 0.2.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0
  - @neurodesk/bison@0.2.20261104
  - @neurodesk/runtime-support@0.9.22

## 0.2.20261103

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
  - @neurodesk/bison@0.2.20261103
  - @neurodesk/runtime-support@0.9.21
- Updated dependencies [8e9346d]
- Updated dependencies [239dedd]
  - @neurodesk/webapp-components@0.22.4
  - @neurodesk/bison@0.2.20261103
  - @neurodesk/runtime-support@0.9.20

## 0.2.20261031

### Minor Changes

- 29c6db9: The `bison` command line now ships as portable archives for Linux, Windows and macOS, with the model files and its own Node runtime, so it runs offline. Each archive passes the command-line check against the web app's outputs before release.
- f860d91: BISON registers the T1 to the ICBM 2009c template (affine) and the FLAIR to the T1 (rigid) with Greedy instead of ANTs. On the five native validation subjects every label gate still holds and these two steps take about 30 s each instead of 94 and 130 s. The nonlinear registration stays on ANTs SyN. Greedy's WebAssembly gains a rigid (6 DOF) export and a browser worker for its single-threaded build, which BISON runs in the browser and in Node so that both give the same files. hmc-registration can write ITK `.mat` transforms (`writeMatTransform`).
- 1a4882c: BISON's nonlinear registration to ICBM 2009c runs on Greedy with neighbourhood cross-correlation (radius 2, to 1 mm, from the inverse T1 affine) instead of ANTs SyN, so every BISON registration now runs on Greedy. On the five native validation subjects every label gate still holds and agreement is 0.936 to 0.946. The step takes about 10 minutes instead of 23 to 27, and its WebAssembly heap is 1.5 GB instead of 2.2 GB. Labels and probabilities change slightly; the browser reference is rerecorded.

### Patch Changes

- d0ea0ef: A registration group no longer loads a new kernel after 20 runs. The limit worked around #537, which the hmc kernel fixed by restoring its stack after each run. No group runs more than 19 commands, so every output stays the same. Each group still gets its own instance, and an abort still loads a new one.
- Updated dependencies [29c6db9]
- Updated dependencies [f860d91]
- Updated dependencies [1a4882c]
- Updated dependencies [d0ea0ef]
- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/bison@0.2.20261031
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/webapp-components@0.22.3

## 0.1.20261029

### Patch Changes

- @neurodesk/bison@0.2.4

## 0.1.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
  - @neurodesk/bison@0.2.3
  - @neurodesk/runtime-support@0.9.18
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
