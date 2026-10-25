# me-ica

## 0.1.20261024

### Patch Changes

- Updated dependencies [0066f60]
  - @neurodesk/webapp-components@0.21.1
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2

## 0.1.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0

## 0.1.20261020

### Minor Changes

- 44bddc8: New ME-ICA app: tedana's multi-echo fMRI denoising (optimal combination, moving-average PCA, FastICA, decision trees, external regressors) in the browser through `@niivue/meica`, the WebAssembly build of niivue/meica-rs. On the examples its outputs match tedana's file for file and are byte-identical to the native `meica` CLI.

- New ME-ICA app: tedana's multi-echo fMRI denoising (optimal combination, moving-average PCA, FastICA, decision trees, external regressors) in the browser through `@niivue/meica`, the WebAssembly build of niivue/meica-rs. On the examples its outputs match tedana's file for file and are byte-identical to the native `meica` CLI.

### Patch Changes

- 14b5939: Exclude ME-ICA and SDC from the single-series application handoff menu. Their workflows require an echo bundle or an opposite-phase pair, so a lone converted image cannot supply their inputs.
- c865c0c: Serialize ME-ICA previews and restore the previous image, overlay, frame and display window when an import fails or is cancelled. Replacement echoes clear stale echo times, superseded imports cannot replace newer inputs, and automation cancellation stops the processing worker. The shared queue retains the existing single-volume preview adapter.
- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.1

- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0

- c865c0c: Serialize ME-ICA previews and restore the previous image, overlay, frame and display window when an import fails or is cancelled. Replacement echoes clear stale echo times, superseded imports cannot replace newer inputs, and automation cancellation stops the processing worker. The shared queue retains the existing single-volume preview adapter.

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [c865c0c]

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0

- Exclude ME-ICA from single-image handoffs because processing requires the multi-echo image bundle and timing metadata.

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
- Exclude ME-ICA from single-image handoffs because processing requires the multi-echo image bundle and timing metadata.
