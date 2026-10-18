# fastprep

## 0.1.20261018

### Minor Changes

- 1c11f1c: New app: fastprep, fMRI preprocessing of one BIDS subject in the browser (Rust/WASM port of fastprep.py with greedy, niimath, MindGrab, SynthSR and glm), with an HTML report and zipped derivatives. Drop a BIDS folder anywhere on the page, or choose one from the input menu.

  Reject invalid BOLD repetition times and nonfinite confounds, escape report metadata, rerun the GLM when its BOLD sidecar changes, and restore example inputs through page-drop Undo.

### Patch Changes

- Updated dependencies [1c11f1c]
  - @neurodesk/fastprep@0.1.20261017
