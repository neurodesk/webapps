# calmar

## 0.4.20260920

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.3


### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.2

## 0.4.20260918

### Minor Changes

- Keep ONNX Runtime thread workers inside Calmar's isolation service-worker scope. This fixes SynthStrip hanging after normalization on GitHub Pages when shared runtime worker responses lack isolation headers.

## 0.3.20260918

### Patch Changes

- Load only the structural T1 in the stroke example so Run analysis computes the lesion mask for review before network mapping.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.1

### Patch Changes

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies

  - @neurodesk/webapp-components@0.4.0

- Updated dependencies
  - @neurodesk/webapp-components@0.3.1

## 0.3.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0

## 0.3.20260915

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

## 0.2.20260914

### Patch Changes

- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/webapp-components@0.1.5

### Patch Changes

- Add optional TopoFit mid-surface normals and flat cortical patches, matching OpenRecon's atlas eligibility, geodesic search, plane-fit criteria and local ribbon geometry. Export native-grid patch-and-normal QC, individual patch surfaces, paired geometry JSON, normals CSV and measurements; support hemisphere, radius, count, quality and native-grid ROI settings. Pin the fsaverage atlas on Hugging Face. Compare the geometry with OpenRecon on both full-resolution validation hemispheres.

  Keep anatomical surfaces in 3-Plane view and give registration sphere files the FreeSurfer parser extension for display. Remove the repeated sidebar warning and single-option contrast selector. Suppress consecutive duplicate technical-log messages across apps, including QSMbly and CALMaR, and report model-download progress when its percentage changes.

- Updated dependencies
  - @neurodesk/webapp-components@0.1.4

## 0.2.20260910

### Minor Changes

- Release the complete application catalog after integrating BrowserQC, dwi2trx and SynthSeg. Preserve shared interface behavior and publish bundles with synchronized date versions.

## 0.1.20260910

### Changes

- Adopt MAJOR.MINOR.YYYYMMDD versioning, link every app to the lightNIIng ecosystem (lightniing.org) from the app bar and About dialog, and keep build scratch files off the shared /tmp volume.

## 0.1.9

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).
- Updated dependencies
  - @neurodesk/webapp-components@0.1.3

## 0.1.8

### Patch Changes

- cd790d5: Finish shared imaging convergence by centralizing worker sessions, input handling, app-specific controllers, workspace styles, and runtime clients. Strengthen shell contracts and regression coverage.

## 0.1.7

### Patch Changes

- 5560336: Consolidate imaging workers, pipeline execution, viewer behavior, NIfTI serialization, runtime wrappers, shared styling, and hosted shell controls. Fix CALMaR analysis startup and layout, and remove horizontal overflow from Deface controls.

## 0.1.6

### Patch Changes

- 90762b0: Fix ONNX Runtime WASM URLs in composite-site builds so inference loads the shared runtime without duplicating the `/_runtime/` path.

## 0.1.5

### Patch Changes

- 46be48e: Add a persistent light and dark theme switch to the webapp catalog and every hosted or standalone webapp bundle.

## 0.1.4

### Patch Changes

- Standardize the Neurodesk app shell and add DNT/GPC-respecting page-view analytics with aggregate per-app usage statistics.

## 0.1.3

### Patch Changes

- Align the application interfaces with the Neurodesk design system and point app source links at the webapps monorepo.

## 0.1.2

### Patch Changes

- 4a4dd72: Apply the Neurodesk designer-guide theme to hosted and standalone webapp bundles.
