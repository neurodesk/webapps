# @neurodesk/greedy

## 0.3.20260916

## 0.3.20260915

## 0.2.20260914

### Minor Changes

- Add offline Greedy native packaging for Linux x64, Windows x64 and Apple ARM, with an isolated signed and notarized macOS installer release. Add an npm-installable CLI that bundles native binaries and validates installed packages on each target. Document the catalog-wide CLI rollout and remaining pipeline ports.

## 0.1.20260914

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.

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
