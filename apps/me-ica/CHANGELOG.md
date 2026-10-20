# me-ica

## 0.1.20261020

### Minor Changes

- 44bddc8: New ME-ICA app: tedana's multi-echo fMRI denoising (optimal combination, moving-average PCA, FastICA, decision trees, external regressors) in the browser through `@niivue/meica`, the WebAssembly build of niivue/meica-rs. On the examples its outputs match tedana's file for file and are byte-identical to the native `meica` CLI.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
- Exclude ME-ICA from single-image handoffs because processing requires the multi-echo image bundle and timing metadata.

- c865c0c: Serialize ME-ICA previews and restore the previous image, overlay, frame and display window when an import fails or is cancelled. Replacement echoes clear stale echo times, superseded imports cannot replace newer inputs, and automation cancellation stops the processing worker. The shared queue retains the existing single-volume preview adapter.

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

- Updated dependencies [4b40da1]
  - @neurodesk/webapp-components@0.17.0
