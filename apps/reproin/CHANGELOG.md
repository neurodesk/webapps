# reproin

## 0.1.20261030

### Minor Changes

- 9f0a277: New app: convert a ReproIn DICOM session to a BIDS dataset in the browser with dcm2niix and the reproin-rs post-pass (the `@niivue/reproin` v0.1.20261030 release), with per-file results, NIfTI viewing, a ZIP download and a public Siemens XA60 ReproIn example session. Standalone links the `reproinx` command line from the same reproin-rs release (Linux, macOS, Windows).

### Patch Changes

- Keep cancellation during ZIP creation from publishing results, and let page-drop Undo restore the previously loaded example session.
