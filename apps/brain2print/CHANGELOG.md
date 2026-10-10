# brain2print

## 0.5.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.4.0
  - @neurodesk/brain2print@0.5.20261010

## 0.5.20261009

### Minor Changes

- 66bf9e9: Add the `brain2print` command line: `brain2print IMAGE OUTPUT_DIR` runs the web app's create-mesh operation in Node, with MindGrab on the CPU and the same niimath WebAssembly, and writes the web app's three downloads under the same names. Its options are the app's automation parameters: `--model`, `--backend` (the command line always runs on the CPU), `--simplify`, `--smooth`, `--[no-]largest-only` and `--[no-]fill-bubbles`. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check runs the app's pinned example, the template of the app's CPU e2e test and the right- and left-handed test fixtures, and requires every file to match the web pipeline's output in Chromium byte for byte; the app's CPU e2e test is held to the same pins.

  The app's pipeline moves into `@neurodesk/brain2print`, which the app and the command line share. The app now gives MindGrab NIfTI files as stored rather than as NiiVue rewrites them, and uses MindGrab 0.1.20260925. Breaking for `@neurodesk/topofit`: `readMz3`, `writeMz3` and `writeStl` are no longer exported from `@neurodesk/topofit/results`; import them from `@neurodesk/webapp-components/file-io/mesh`. The package is not published to npm and no workspace consumer imports them from TopoFit any more.

### Patch Changes

- e525c91: Segment on the CPU when the only GPU is a software renderer. On machines without a usable GPU (virtual machines, remote desktops, blocklisted drivers) `auto` picked emulated WebGL2 and did not finish in 9 minutes; it now prefers hardware WebGPU, then hardware WebGL2, then the threaded CPU module, which takes about 30 s. Automation's `create-mesh` also accepts `backend: 'cpu'`.

  Mesh the brain mask rather than the label values for the label models (16chan18cls, mindmap labels, mindsnap). Meshing the raw labels at isovalue 0.5 placed the surface almost at the background voxel, so printed brains came out 17–20 % too large (87 % for mindsnap); the mesh now encloses the labelled voxels to within 5 %.

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
- Updated dependencies [64ffefa]
  - @neurodesk/brain2print@0.5.20261009
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0

## 0.4.20261007

### Patch Changes

- Updated dependencies [f470c7b]
- Updated dependencies [22aa4bf]
  - @neurodesk/topofit@0.14.20261007
  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/topofit@0.13.20261007
- Updated dependencies [70f2770]
- Updated dependencies [6be20aa]
  - @neurodesk/webapp-components@0.10.2
  - @neurodesk/topofit@0.13.20261007

## 0.4.20261005

### Patch Changes

- @neurodesk/topofit@0.12.20261005

## 0.4.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/topofit@0.12.20261004
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/topofit@0.12.20261004
- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3
  - @neurodesk/topofit@0.12.20261004
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/topofit@0.12.20261004

## 0.4.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0
  - @neurodesk/topofit@0.12.20261003

## 0.4.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/topofit@0.12.20260930

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/topofit@0.12.20260930

## 0.4.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1
  - @neurodesk/topofit@0.12.20260928

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- Updated dependencies
- Updated dependencies [93381e8]
- Updated dependencies [93381e8]
  - @neurodesk/webapp-components@0.6.0
  - @neurodesk/topofit@0.12.20260928

## 0.3.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0

## 0.3.20260924

### Minor Changes

- 6ebab97: Upgrade MindGrab to 0.1.20260923 and offer its segmentation models: fast 16chan18cls, mindmap 24chan18cls, mindmap partial volume (the new default, meshing the grey plus white matter fraction for a smoother surface) and mindsnap 24chan104cls with its own colormap. Add a mesh smoothing slider (niimath `-s`, 0–20 iterations).

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

### Minor Changes

- Add the Brain2Print segmentation and printable mesh workflow. Preserve user-selected images when the startup example is delayed, invalidate stale results on reload, and use the shared viewer controls.
