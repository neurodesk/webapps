# greedy

## 0.3.20260918

### Patch Changes

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.0
  - @neurodesk/greedy@0.3.20260918

## 0.3.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0
  - @neurodesk/greedy@0.3.20260916

## 0.3.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.2
  - @neurodesk/greedy@0.3.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.1
  - @neurodesk/greedy@0.3.20260915

### Patch Changes

- Reject out-of-field registration trial coordinates before integer conversion, preventing a threaded WebAssembly crash during SYNcro normalization. Include complete desktop and HPC release packaging with offline workflow gates.
  - @neurodesk/greedy@0.3.20260915

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.0
  - @neurodesk/greedy@0.3.20260915

## 0.2.20260914

### Patch Changes

- Write native release checksums with LF line endings on every platform so Linux and macOS uploaders can verify Windows archives.
  - @neurodesk/greedy@0.2.20260914

### Patch Changes

- Allow the isolated Apple signing job to look up draft releases before notarization.
  - @neurodesk/greedy@0.2.20260914

### Minor Changes

- Add offline Greedy native packaging for Linux x64, Windows x64 and Apple ARM, with an isolated signed and notarized macOS installer release. Add an npm-installable CLI that bundles native binaries and validates installed packages on each target. Document the catalog-wide CLI rollout and remaining pipeline ports.

### Patch Changes

- Updated dependencies
  - @neurodesk/greedy@0.2.20260914

## 0.1.20260914

### Patch Changes

- 7bda502: Restore cross-origin isolation for Greedy on GitHub Pages with the scoped COI service-worker fallback. Build the browser runtime from source and ship it only in the versioned standalone web release. Add `-rb VALUE|AUTO` to set the reslice background, including CT air-background detection.
- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.
- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/greedy@0.1.20260914
  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.1.4
  - @neurodesk/greedy@0.1.20260914

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
