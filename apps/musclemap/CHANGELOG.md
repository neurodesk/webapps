# musclemap

## 1.4.20261007

### Patch Changes

- 70f2770: Space the technical log's Copy and Clear buttons apart by grouping them in the shared `nd-console-actions` row; they had run together as "CopyClear". Remove the unused legacy `.console-clear` styles.
- dd05e46: Ship whole-body v1.3 and the regional models as FP32 exports, which match upstream MuscleMap voxel for voxel on public parity cases. The previous Q8 exports could drop a whole label on partial-coverage scans. Each regional model download grows from about 39 MB to 104 MB.
- 03a9e8c: Run every model, including whole-body v1.3 and the regional models, through the upstream MONAI pipeline, and pad slices to upstream's 256 x 256 before 128 x 128 sliding windows. Remove the slice-thickness and low-res controls and their automation parameters, which only that older path used.
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2

## 1.4.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
- e6baa09: Correct a segmentation in the viewer before downloading it. Generated, consolidated and uploaded label maps whose display copy shares their voxel grid show Edit in the Results list, which opens the shared mask editor with the muscle names in its Label select. Apply replaces the result, labels it `(edited)`, reloads the overlay and makes Download return the edited uint8 class-index map under the same file name; Calculate Metrics then reads the edited labels. A new run, new input, consolidation or Clear All closes an open edit without applying it.
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
- Match upstream positive foreground cropping, MONAI and PyTorch grid arithmetic, and integer temporary-chunk storage with MONAI float64 decoding. Keep the per-label Dice gate and add upstream-derived regression fixtures, checksummed public full-volume references, browser parity CI, and explicit WebGPU execution evidence. Retain provenance for failed comparisons, prevent stale passing reports, and use portable CI scratch directories. Document the isolated inference-runtime boundary differences.
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0

## 1.4.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 1.4.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2

## 1.4.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- 93381e8: Remove the static bottom bar (version, privacy sentence, duplicate More Apps and GitHub links) from the six inference-workspace apps. The shared app bar already shows the version and links, and Privacy has its own dialog. The unused `.app-footer` and `.nd-app-footer` rules leave the shared stylesheets and the hosted theme.
- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

- Updated dependencies
- Updated dependencies [93381e8]
- Updated dependencies [93381e8]
  - @neurodesk/webapp-components@0.6.0

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0

## 1.4.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5

## 1.4.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.

## 1.4.20260920

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

## 1.4.20260918

### Patch Changes

- Clarify that each input's image type describes the uploaded file. Rename View to Preview file and the per-file checkbox to Include in segmentation.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.1

### Patch Changes

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies

  - @neurodesk/webapp-components@0.4.0

- Updated dependencies
  - @neurodesk/webapp-components@0.3.1

## 1.4.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0

## 1.4.20260915

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

### Patch Changes

- Add Run offline instructions through the shared Standalone action, linking the MuscleMap 1.4 Neurodesk container on Zenodo with its checksum, setup guidance and copyable CPU segmentation command.
- Restore the 1.4 model release series after the catalog-wide release incorrectly advanced it to 1.5. Pin the series in the release planner so webapp and shared dependency changes only advance the UTC date. Synchronize the application and generated model catalog versions.

## 1.5.20260914

### Patch Changes

- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/webapp-components@0.1.5

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.1.4

## 1.5.20260910

### Minor Changes

- Release the complete application catalog after integrating BrowserQC, dwi2trx and SynthSeg. Preserve shared interface behavior and publish bundles with synchronized date versions.

## 1.4.20260910

### Changes

- Adopt MAJOR.MINOR.YYYYMMDD versioning, link every app to the lightNIIng ecosystem (lightniing.org) from the app bar and About dialog, and keep build scratch files off the shared /tmp volume.

## 1.4.7

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).
- Updated dependencies
  - @neurodesk/webapp-components@0.1.3

## 1.4.6

### Patch Changes

- Restore the MuscleMap segmentation overlay by preserving label indices when the shared viewer configures the segmentation display range. Add regression coverage for the label-to-colormap mapping.

## 1.4.5

### Patch Changes

- cd790d5: Finish shared imaging convergence by centralizing worker sessions, input handling, app-specific controllers, workspace styles, and runtime clients. Strengthen shell contracts and regression coverage.

## 1.4.4

### Patch Changes

- 5560336: Consolidate imaging workers, pipeline execution, viewer behavior, NIfTI serialization, runtime wrappers, shared styling, and hosted shell controls. Fix CALMaR analysis startup and layout, and remove horizontal overflow from Deface controls.

## 1.4.3

### Patch Changes

- Keep ONNX Runtime inside the MuscleMap service worker scope so all available WebAssembly threads can start on GitHub Pages.

## 1.4.2

### Patch Changes

- Keep whole-body v1.3 available as a legacy model without changing the v1.4 default.

## 1.4.1

### Patch Changes

- Prepare the official whole-body MuscleMap v1.4 model as a gated release. Canonical upstream model contracts now generate all runtime and registry metadata.
- Preserve official sparse anatomical labels in downloaded NIfTI files and require explicit label-space attribution for imported segmentations.
- Verify remote model bytes by SHA-256 and replace the large-slice centered fallback with bounded full-coverage accumulation.
- Add reproducible conversion, MR/CT fidelity validation, atomic publication, anonymous verification, activation, and rollback-friendly v1.3 retirement tooling.
- Match v1.4 upstream inference with affine-aware MONAI geometry, source-axis preprocessing chunks, logit-space inverse transforms, Gaussian scan intervals, and 6-connected component cleanup; gate release on a full browser-to-upstream volume comparison.
- Analyze uploaded segmentation NIfTI files without model inference, auto-detect browser, official, and OpenRecon int12 label encodings, and provide normalized official-label downloads.
- Make the validated FP32 whole-body v1.4 model the default selectable model.

## 1.2.43

### Patch Changes

- 90762b0: Fix ONNX Runtime WASM URLs in composite-site builds so inference loads the shared runtime without duplicating the `/_runtime/` path.

## 1.2.42

### Patch Changes

- 46be48e: Add a persistent light and dark theme switch to the webapp catalog and every hosted or standalone webapp bundle.

## 1.2.41

### Patch Changes

- Standardize the Neurodesk app shell and add DNT/GPC-respecting page-view analytics with aggregate per-app usage statistics.

## 1.2.40

### Patch Changes

- Align the application interfaces with the Neurodesk design system and point app source links at the webapps monorepo.

## 1.2.39

### Patch Changes

- 4a4dd72: Apply the Neurodesk designer-guide theme to hosted and standalone webapp bundles.
