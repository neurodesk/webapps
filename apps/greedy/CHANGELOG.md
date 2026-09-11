# greedy

## 0.1.20260911

### Patch Changes

- dc50e56: Normalize NIfTI spatial units to millimetres and preserve scaled integer intensities when writing registered images. Isolate registration workers so cancelled input reads cannot affect a subsequent run.

  Use the shared download helper in both registration apps and expose Greedy command-line instructions through the application bar.

- Updated dependencies [dc50e56]
  - @neurodesk/greedy@0.1.20260911


### Patch Changes

- Updated dependencies
  - @neurodesk/greedy@0.1.20260911

### Minor Changes

- Add the reusable Greedy Rust/WebAssembly registration package and the Greedy browser app with affine and deformable modes, brain-only defaults, and MindGrab extraction for custom images.
- Validate NIfTI spatial geometry, exercise both registration modes in the routine browser suite, and document the pinned MindGrab retry limitation.

### Patch Changes

- Updated dependencies
  - @neurodesk/greedy@0.1.20260911
