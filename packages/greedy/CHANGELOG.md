# @neurodesk/greedy

## 0.1.20260911

### Patch Changes

- dc50e56: Normalize NIfTI spatial units to millimetres and preserve scaled integer intensities when writing registered images. Isolate registration workers so cancelled input reads cannot affect a subsequent run.

  Use the shared download helper in both registration apps and expose Greedy command-line instructions through the application bar.


### Patch Changes

- Add nearest-neighbor reslice interpolation for discrete masks and label maps.

### Patch Changes

- Add native Greedy command-line help, retain upstream Greedy attribution in the CLI and npm package, and align the package and native Rust versions.

## 0.1.0

### Minor Changes

- Add the reusable Greedy Rust/WebAssembly registration package and the Greedy browser app with affine and deformable modes, brain-only defaults, and MindGrab extraction for custom images.
- Reject invalid NIfTI spatial geometry and verify the Rust workspace alongside the browser wrapper.
