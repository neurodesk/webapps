# @neurodesk/spinalcordtoolbox

## 0.9.20261020

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [3f1d770]

- Updated dependencies [d9718cd]

  - @neurodesk/webapp-components@0.16.3

- Updated dependencies [ea2a6d2]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [d9718cd]
  - @neurodesk/webapp-components@0.16.3

## 0.9.20261018

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]

  - @neurodesk/webapp-components@0.15.1

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]

  - @neurodesk/webapp-components@0.15.1

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0

## 0.9.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.9.20261016

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2

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
