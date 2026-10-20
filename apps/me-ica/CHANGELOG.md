# me-ica

## 0.1.20261020

### Minor Changes

- New ME-ICA app: tedana's multi-echo fMRI denoising (optimal combination, moving-average PCA, FastICA, decision trees, external regressors) in the browser through `@niivue/meica`, the WebAssembly build of niivue/meica-rs. On the examples its outputs match tedana's file for file and are byte-identical to the native `meica` CLI.

### Patch Changes

- Serialize ME-ICA previews and restore the previous image, overlay, frame and display window when an import fails or is cancelled. Replacement echoes clear stale echo times, superseded imports cannot replace newer inputs, and automation cancellation stops the processing worker. The shared queue retains the existing single-volume preview adapter.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.17.0
