# synthsr

## 0.6.20261005

### Patch Changes

- Share native result publication between SynthSR and SynthSeg. Clean up newly created temporary files after failed writes while preserving each caller’s publication order and overwrite policy. Keep native path bytes when naming sibling temporaries.
- Updated dependencies
  - @neurodesk/synthsr@0.6.20261005

## 0.6.20261004

### Minor Changes

- 257192b: Stream SynthSR and SynthStrip CPU inference by operator to avoid oversized browser allocations while preserving the pinned models. Reject normalization with less than one percent positive brain support in the MNI template before exposing downloads. Add numerical parity, allocation, failure recovery, and cropped-head regressions.

### Patch Changes

- Share native affine inversion and RAS axis selection between SynthSR and SynthSeg,
  including SynthSeg WASM, while preserving each method's preprocessing and outputs.
- Updated dependencies
  - @neurodesk/synthsr@0.6.20261004
- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/synthsr@0.6.20261004
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/synthsr@0.6.20261004
- Share raw NIfTI-1 header and scalar decoding between native SynthSR, native
  SynthSeg and SynthSeg WASM while preserving each reader's validation, precision,
  scaling and geometry rules.
- Updated dependencies [257192b]
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/runtime-support@0.1.3

## 0.5.20261004

### Patch Changes

- Share SynthSR and SynthSeg worker model acquisition through fetchModel. Verify cached and downloaded weights before use, reject oversized streams early, and replace corrupt cached weights within the same run. Preserve SynthSR local model files, pinned hashes, progress allocation and worker cancellation. Restore app-specific connection and recovery guidance when model requests fail.
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/synthsr@0.5.20261004

## 0.5.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0
  - @neurodesk/synthsr@0.5.20261003

## 0.5.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/synthsr@0.5.20260930

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/synthsr@0.5.20260930

## 0.5.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1
  - @neurodesk/synthsr@0.5.20260928

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

- Updated dependencies
- Updated dependencies [93381e8]
- Updated dependencies [93381e8]
  - @neurodesk/webapp-components@0.6.0
  - @neurodesk/synthsr@0.5.20260928

## 0.4.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0
  - @neurodesk/synthsr@0.4.20260928

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
