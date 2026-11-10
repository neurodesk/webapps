# reproin

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.1.20261108

### Patch Changes

- 16e9097: Make the example retry browser test serve provisioned DICOM files after its injected failure, avoiding transient remote download failures. Report an unexpected terminal download error immediately with the selector's message.
- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0

## 0.1.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0

## 0.1.20261103

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
- Updated dependencies [8e9346d]
- Updated dependencies [239dedd]
  - @neurodesk/webapp-components@0.22.4

## 0.1.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/webapp-components@0.22.3

## 0.1.20261030

### Minor Changes

- 9f0a277: New app: convert a ReproIn DICOM session to a BIDS dataset in the browser with dcm2niix and the reproin-rs post-pass (the `@niivue/reproin` v0.1.20261030 release), with per-file results, NIfTI viewing, a ZIP download and a public Siemens XA60 ReproIn example session. Standalone links the `reproinx` command line from the same reproin-rs release (Linux, macOS, Windows).

### Patch Changes

- Keep cancellation during ZIP creation from publishing results, and let page-drop Undo restore the previously loaded example session.
