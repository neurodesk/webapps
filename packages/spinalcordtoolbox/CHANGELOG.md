# @neurodesk/spinalcordtoolbox

## 0.9.20261016

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.9.20261015

### Minor Changes

- 7269dab: Add `sct-webapp`, a portable command line for the app's SCT segmentation tasks.
  The inference pipeline moves into `@neurodesk/spinalcordtoolbox`, shared by the
  browser worker and the command line, with shared output formats and names. Native
  CPU and browser WebAssembly results can differ slightly. The release bundles
  the spinalcord model; `sct-webapp download-models --task TASK`
  fetches any other task's pinned model on first use. The web app now verifies
  each model's size and SHA-256 when it downloads or reads it from its cache, and
  no longer loads localforage from a CDN.

  Keep the staged SCT package's shared imports working after composite-site
  deduplication removes the app-local component copy, and resolve its CLI test
  entrypoint through the native file path on every platform.

### Patch Changes

- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0
