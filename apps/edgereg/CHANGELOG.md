# edgereg

## 0.4.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/edgereg@0.4.20261017
  - @neurodesk/runtime-support@0.6.4

## 0.4.20261016

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/edgereg@0.4.20261016
- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/edgereg@0.4.20261016
  - @neurodesk/runtime-support@0.6.2

## 0.4.20261015

### Patch Changes

- Updated dependencies [c74b26f]
  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/edgereg@0.4.20261015
- dd65e6a: Visual refresh: Inter, neutral greys with the Neurodesk logo green for action,
  focus and selection only, a compact 48px app bar, sentence-case section titles
  and a quieter status bar. The example menu is now the input control: examples,
  then Choose files… and Choose folder…. The whole window, the viewer included,
  accepts dropped files; a drop mid-session replaces the inputs with Undo in the
  status bar. Before any input the status reads "Drag and drop files". MuscleMap
  drops its separate drop box and Add File(s) button.

  Page drops fill empty image slots in order while keeping DICOM series together.
  New selections supersede unfinished drop traversal, and registration apps load
  each dropped image in order. The shared drop handler also respects the different
  native input and file-field event contracts.
  Failed imports leave only successfully loaded slots occupied, and Undo can
  restore loaded examples.

- Updated dependencies [0569da8]
- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]
  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/edgereg@0.4.20261015

## 0.4.20261014

### Patch Changes

- 850e642: Remove code that nothing calls, found by the unused-code report and checked by
  repository-wide reference searches. The shared preview module no longer carries
  a second NIfTI parser and writer; NiftiUtils remains the only one. Outputs and
  behaviour are unchanged.
- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]
  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0
  - @neurodesk/edgereg@0.4.20261014

## 0.4.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/edgereg@0.4.20261012
  - @neurodesk/runtime-support@0.4.3

## 0.4.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/edgereg@0.4.20261010
- Updated dependencies
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/edgereg@0.4.20261010
  - @neurodesk/webapp-components@0.12.1

## 0.4.20261009

### Minor Changes

- 20e97ab: Add the `edgereg` command line: `edgereg MOVING FIXED OUTPUT_DIR [--robust-fov]` runs the web app's `register` operation in Node with the same niimath `-allineate` WebAssembly build, and writes the web app's download under the same name. The method now lives in `@neurodesk/edgereg`, which the web app imports. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check registers the pinned example and requires the output's header and voxels to hash identically to the web app's own download; native niimath built from source is held to measured limits.

### Patch Changes

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
- Updated dependencies [20e97ab]
- Updated dependencies [64ffefa]
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/edgereg@0.4.20261009
  - @neurodesk/runtime-support@0.3.0

## 0.3.20261007

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2

## 0.3.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0

## 0.3.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 0.3.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2

## 0.3.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- Updated dependencies
- Updated dependencies [93381e8]
- Updated dependencies [93381e8]
  - @neurodesk/webapp-components@0.6.0

## 0.2.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0

## 0.2.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5

## 0.2.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.

## 0.2.20260920

### Patch Changes

- Updated dependencies [4959500]
  - @neurodesk/webapp-components@0.4.4

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.3

### Patch Changes

- efd8af3: Show the Example control before the file picker in every app, replace the registration apps' stale "Loading the default images" empty state, give FireANTs a CPU time budget and progress messages, ship BrowserQC's CPU MindGrab bundle with a longer segmentation budget, select CPU processing in SynthSR and brain extraction when no WebGPU adapter exists, start MuscleMap at 50 % overlap without WebGPU, and run VesselBoost's hosted example workflow in its browser tests.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.2

## 0.2.20260918

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/webapp-components@0.4.1

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.0

## 0.2.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0

## 0.2.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.2

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.1

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.0

## 0.1.20260914

### Patch Changes

- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.1.4

## 0.1.20260911

### Patch Changes

- dc50e56: Normalize NIfTI spatial units to millimetres and preserve scaled integer intensities when writing registered images. Isolate registration workers so cancelled input reads cannot affect a subsequent run.

  Use the shared download helper in both registration apps and expose Greedy command-line instructions through the application bar.

## 0.1.20260910

### Minor Changes

- Add the EdgeReg browser app with affine registration, shared example datasets, and NIfTI/DICOM inputs.
