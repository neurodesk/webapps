# gliomoda

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0
  - @neurodesk/synthsr@0.6.20261109
  - @neurodesk/gliomoda@0.1.2

## 0.1.20261108

### Minor Changes

- c798e49: Add GlioMODA, a new app that segments adult gliomas on skull-stripped MRI registered to the BraTS/SRI24 atlas grid. It takes any of GlioMODA's 11 sequence combinations of T1c, FLAIR, T1 and T2 (plus the ResEncL model for all four), recognises the sequences from BraTS, BraTS Toolkit, UPENN-GBM and BIDS file names, and runs the GlioMODA v1.0.2 networks with ONNX Runtime Web on WebGPU or the CPU, repeating nnU-Net 2.5.2's normalisation, mirrored sliding-window prediction and region labels. It downloads the BraTS label map (necrotic core, oedema, enhancing tumour) and a volume table. On the UPENN-GBM example its labels match the Neurocontainers GlioMODA 0.0.4 container's for every model.

  Store container validation volumes in the pinned Hugging Face dataset instead of Git. Verify their SHA-256 before parity and browser comparisons.

  Reject non-finite or degenerate spatial transforms and modalities whose voxel-to-world matrices differ by more than 1e-5 before segmentation.

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
  - @neurodesk/synthsr@0.6.20261108
  - @neurodesk/gliomoda@0.1.1
