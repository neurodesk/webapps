# synthsr

## 0.4.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5
  - @neurodesk/synthsr@0.4.20260924

## 0.4.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.
  - @neurodesk/synthsr@0.4.20260923

## 0.4.20260920

### Patch Changes

- Updated dependencies [4959500]
  - @neurodesk/webapp-components@0.4.4
  - @neurodesk/synthsr@0.4.20260920

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.3
  - @neurodesk/synthsr@0.4.20260920

### Patch Changes

- efd8af3: Show the Example control before the file picker in every app, replace the registration apps' stale "Loading the default images" empty state, give FireANTs a CPU time budget and progress messages, ship BrowserQC's CPU MindGrab bundle with a longer segmentation budget, select CPU processing in SynthSR and brain extraction when no WebGPU adapter exists, start MuscleMap at 50 % overlap without WebGPU, and run VesselBoost's hosted example workflow in its browser tests.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.2
  - @neurodesk/synthsr@0.4.20260920

## 0.4.20260918

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/webapp-components@0.4.1
  - @neurodesk/synthsr@0.4.20260918

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.0
  - @neurodesk/synthsr@0.4.20260918

## 0.4.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0
  - @neurodesk/synthsr@0.4.20260916

## 0.4.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.2
  - @neurodesk/synthsr@0.4.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.1
  - @neurodesk/synthsr@0.4.20260915

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.0
  - @neurodesk/synthsr@0.4.20260915

## 0.3.20260914

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.
- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2
  - @neurodesk/synthsr@0.3.20260914

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.1.4
  - @neurodesk/synthsr@0.3.20260914

## 0.3.20260910

### Minor Changes

- Release the complete application catalog after integrating BrowserQC, dwi2trx and SynthSeg. Preserve shared interface behavior and publish bundles with synchronized date versions.

### Patch Changes

- 8a8499b: Add diffusion tensor fitting and tractography, update BrowserQC segmentation, and unify development and production interfaces. Reject malformed QC reports and keep DICOM sidecars attached to their scans.
- Updated dependencies [3fe15c3]
  - @neurodesk/runtime-support@0.1.1
  - @neurodesk/synthsr@0.3.20260910
