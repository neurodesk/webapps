# fastprep

## 0.1.20261018

### Minor Changes

- 1c11f1c: New app: fastprep, fMRI preprocessing of one BIDS subject in the browser (Rust/WASM port of fastprep.py with greedy, niimath, MindGrab, SynthSR and glm), with an HTML report and zipped derivatives. Drop a BIDS folder anywhere on the page, or choose one from the input menu.

  Reject invalid BOLD repetition times and nonfinite confounds, escape report metadata, rerun the GLM when its BOLD sidecar changes, and restore example inputs through page-drop Undo.

### Patch Changes

- Updated dependencies [67a5a8f]
- Updated dependencies [b8b37d6]
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]
  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.5.20261018
- Stop preprocessing workers when automation cancels a run, restore the Run action, and keep completed runs from affecting later work. Build the required scientific runtimes before standalone browser tests, synchronize the GPU slot test on lock acquisition, and add Greedy and GLM method citations.
- Updated dependencies [1c11f1c]
  - @neurodesk/fastprep@0.1.20261017
