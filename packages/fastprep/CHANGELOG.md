# @neurodesk/fastprep

## 0.2.3

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/sdc@0.2.20261024

## 0.2.2

### Patch Changes

- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/sdc@0.2.20261024

## 0.2.1

### Patch Changes

- @neurodesk/sdc@0.2.20261024

## 0.2.0

### Minor Changes

- Estimate PEPOLAR fields from validated reverse phase-encoding EPI references using the existing PyHySCO solver, with a lazy browser runtime and Jacobian-modulated BOLD correction. Preserve phasediff processing and document the deliberate difference from Python's SuCor method.

## 0.1.20261018

### Patch Changes

- c93ed0b: Denoise runs with three or more echoes with ME-ICA (meica, a Rust port of tedana): components are classified on the motion- and distortion-corrected echoes and the rejected ones regressed from each preprocessed series (`desc-denoised`). The report adds a Multi-echo ICA section and runs the task GLM on both series. Adds a pinned multi-echo example.

  Reject undeclared ME-ICA browser options, extra scalar values and missing option values.

## 0.1.20261017

### Patch Changes

- 1c11f1c: New app: fastprep, fMRI preprocessing of one BIDS subject in the browser (Rust/WASM port of fastprep.py with greedy, niimath, MindGrab, SynthSR and glm), with an HTML report and zipped derivatives. Drop a BIDS folder anywhere on the page, or choose one from the input menu.

  Reject invalid BOLD repetition times and nonfinite confounds, escape report metadata, rerun the GLM when its BOLD sidecar changes, and restore example inputs through page-drop Undo.
