# easy-mp2rage

## 0.7.20261009

### Patch Changes

- @neurodesk/easy-mp2rage@0.7.20261009

## 0.7.20261007

### Minor Changes

- b7dd98f: Add the `easy-mp2rage` command line with `correct` and `denoise`, the web app's batch operations with the same parameters and output files. It runs the web app's WebAssembly core with Node, and portable Linux x64, Windows x64 and macOS arm64 archives bundle the Node runtime. Before release, each archive must reproduce the Python golden phantom and match the web worker on the pinned 7 T example voxel for voxel. The web app now loads its WebAssembly core and NIfTI code from `@neurodesk/easy-mp2rage`, and `parameters.json` from denoising records the regularization instead of unused MP2RAGE settings.

### Patch Changes

- @neurodesk/easy-mp2rage@0.7.20261007
- b7dd98f: The web app and the command line refuse INV1 or INV2 images that have UNI's dimensions but a different orientation, voxel size or origin, instead of combining them voxel for voxel with the wrong anatomy. `parameters.json` now records every setting that changes a result: the tfl reference angle, FOV extension, the uncorrected fallback and whether the mask came from INV2 or UNI. Each release archive is checked against Python pipeline outputs for every option, and the committed WebAssembly core is rebuilt from source and compared before packaging.
- Updated dependencies [b7dd98f]
- Updated dependencies [b7dd98f]
  - @neurodesk/easy-mp2rage@0.7.20261007

## 0.6.20260928

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

## 0.5.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.

## 0.5.20260920

### Patch Changes

- efd8af3: Show the Example control before the file picker in every app, replace the registration apps' stale "Loading the default images" empty state, give FireANTs a CPU time budget and progress messages, ship BrowserQC's CPU MindGrab bundle with a longer segmentation budget, select CPU processing in SynthSR and brain extraction when no WebGPU adapter exists, start MuscleMap at 50 % overlap without WebGPU, and run VesselBoost's hosted example workflow in its browser tests.

## 0.5.20260918

### Minor Changes

- Replace the synthetic example with the original 7 T MP2RAGE reference brain: UNI, INV1, INV2 and a measured B1 map. Apply the published acquisition settings and documented relative-B1 scaling, preserve image geometry, and include pinned provenance and licensing. Verify real-brain T1 mapping, denoising and downloads in the browser.

  Use the NIfTI affine to orient native viewer slices, so sagittally stored data displays under the correct anatomical plane labels without changing processing or downloads.

## 0.4.20260918

### Minor Changes

- Move Easy MP2RAGE to the shared imaging workspace with an input and processing sidebar, persistent three-plane viewer, View/Download result rows, collapsed technical console and visible status. Keep BIDS sessions in the same viewer and restore reachable controls on desktop and phones. Add browser coverage for scrolling, the synthetic T1/B1 example, downloads and BIDS processing.

  Add shared raster-panel sizing, wrapping slice controls and scrollable file tables. Preserve primary-action and selected-button styling inside the sidebar.

### Patch Changes

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.1

## 0.3.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.

## 0.3.20260915

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

## 0.2.20260910

### Minor Changes

- Release the complete application catalog after integrating BrowserQC, dwi2trx and SynthSeg. Preserve shared interface behavior and publish bundles with synchronized date versions.

## 0.1.20260910

### Changes

- Adopt MAJOR.MINOR.YYYYMMDD versioning, link every app to the lightNIIng ecosystem (lightniing.org) from the app bar and About dialog, and keep build scratch files off the shared /tmp volume.

## 0.1.8

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).

## 0.1.7

### Patch Changes

- cd790d5: Finish shared imaging convergence by centralizing worker sessions, input handling, app-specific controllers, workspace styles, and runtime clients. Strengthen shell contracts and regression coverage.

## 0.1.6

### Patch Changes

- 5560336: Consolidate imaging workers, pipeline execution, viewer behavior, NIfTI serialization, runtime wrappers, shared styling, and hosted shell controls. Fix CALMaR analysis startup and layout, and remove horizontal overflow from Deface controls.

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
