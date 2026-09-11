# edgereg

## 0.1.20260911

### Patch Changes

- dc50e56: Normalize NIfTI spatial units to millimetres and preserve scaled integer intensities when writing registered images. Isolate registration workers so cancelled input reads cannot affect a subsequent run.

  Use the shared download helper in both registration apps and expose Greedy command-line instructions through the application bar.

## 0.1.20260910

### Minor Changes

- Add the EdgeReg browser app with affine registration, shared example datasets, and NIfTI/DICOM inputs.
