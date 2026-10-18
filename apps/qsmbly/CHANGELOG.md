# qsmbly

## 0.31.20261018

### Patch Changes

- 45ae49a: Remove verified dead code from the unused-code report (#256): dicompare's unused technical-log helpers, QSMbly's duplicate `QsmEchoViewer` export and Deface's unused `@neurodesk/webapp-components` devDependency. The calmar and SCT task tests now import the modules they check by literal path.
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]
  - @neurodesk/webapp-components@0.14.4

## 0.31.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.31.20261016

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.
- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.31.20261015

### Minor Changes

- c63094f: QSMbly has a portable command line for Linux, Windows and macOS: QSMxT 9.22.0,
  the native build of the qsm-core v0.38.0 pipeline the app runs. The command the
  app exports runs with `qsmbly` in place of `qsmxt`. Deep-learning weights
  download on first use from pinned URLs, or ahead of time with
  `qsmbly download-models`.

### Patch Changes

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

- 70fcd50: Require the complete verified native weight registry before every processing command, including QSMART, so native downloads from mutable URLs are unreachable. Both offline environment switches now reject incomplete model packs. Preserve explicit model-directory and offline settings in portable launchers, and permit first-use downloads for releases that do not bundle models.

  Mirror all native examples to a commit-pinned dataset and use it for CLI downloads. Offline mode rejects example downloads; help and example listing remain available. Reject native SLURM generation and the TUI because their scheduler jobs bypass verified model preflight.

  Always verify and re-extract native release archives before packaging, including source npm packs. Explain the browser's image +z B0 assumption and the phase-sidecar adjustment used by browser replay validation.

- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.30.20261014

### Patch Changes

- ad92e2f: Merge upstream astewartau/qsmbly 2f91e83..d2afebc:

  - One numerical path: total- and local-field maps and QSMART run through the same config-driven qsm-core stages as raw phase, so the same settings give the same numbers whichever input they start from (#142). Field strength is always required; TGV and MEDI on a field map ask for its echo time.
  - TGV's regularization level decides its alphas from the first run, and the exported command names the alphas that ran (#142). V-SHARP and iLSQR defaults come from the generated qsm-core defaults (#131).
  - Deep-learning tile patches are capped at 120 voxels so they fit browser memory (#137).
  - Gzipped NIfTI masks and field maps are decoded with their scaling, and field-map voxel sizes set the defaults (#130). A 4D mask is refused instead of silently truncated.
  - The WASM module failing to load is reported instead of hanging, and Cancel during loading settles (#128). Mask paths report errors that used to fail silently (#126).
  - File names are escaped in the mask list and the import triage (#132). dicompare loads on first use, so an unreachable dicompare.neurodesk.org only disables the report (#130).
  - Accessibility: labelled controls, hidden-attribute settings panels, and dialogs that take focus, trap Tab, close on Escape and return focus (#133, #139; the shared ModalManager now does this for every app). Tagify is pinned to 4.39.0 with subresource integrity.
  - The shared decodeNiftiBuffer can stop after the header (`{ maxBytes }`).

- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.30.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.30.20261010

### Minor Changes

- Release the shared endian-aware NIfTI reader integration under a new minor version, preserving the already released registry citation changes and fixing the input-grid test header.

### Patch Changes

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.
- Updated dependencies
  - @neurodesk/webapp-components@0.12.2

## 0.29.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.1
- Show the complete registry citation list through the shared Cite dialog, include the single-step TGV paper, and check upstream DOI coverage during sync.

## 0.29.20261009

### Patch Changes

- 501ea0c: Load Inter from `css/inter.css`, which names the Google Fonts v20 WOFF2 files directly, instead of the `fonts.googleapis.com` stylesheet, whose response can change. The page now loads one variable-weight file per script subset.
- 8ac4f60: Default the smallest V-SHARP kernel radius to twice the largest voxel dimension, as QSM.jl does. Anisotropic data previously started from twice the smallest dimension; isotropic data is unchanged.
- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
  - @neurodesk/webapp-components@0.12.0

## 0.29.20261007

### Patch Changes

- 22aa4bf: Merge upstream astewartau/qsmbly 6e01b15..2f91e83:

  - Load the uploaded mask instead of just listing it (#110)
  - Fix multi-echo DICOM imports, image classification, and gzip file filters (#111)
  - Fix the settings modal saving values no control ever supplied (#112)
  - Add explicit mask alignment repair and anatomical overlays (#114)
  - Classify BIDS part-mag/part-phase images (#113)
  - Automatically preview mismatched masks on the reference image (#115)
  - Bump qsmxt-config to v9.22.0 (#109)
  - Add mouse brain masking (RS2-Net, with voxel-scaled BET fallback) (#116)

  RS2-Net weights (63 MB, GPL-3.0) come through the shared downloader from the pinned
  qsmxt/qsm-onnx-weights revision and are listed in the offline inventory. The shared file-io
  module gains `classifyImageComponent` and `sameNiftiGrid`. The shared dcm2niix runtime moves to
  @niivue/dcm2niix 1.3.20260724, which converts enhanced multi-echo DICOM into one image per echo.

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
- 70f2770: Space the technical log's Copy and Clear buttons apart by grouping them in the shared `nd-console-actions` row; they had run together as "CopyClear". Remove the unused legacy `.console-clear` styles.
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2

## 0.29.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0

## 0.29.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 0.29.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2

## 0.29.20260928

### Patch Changes

- Use portable underscore MCP tool names, explicit input cardinality, and declared SynthSeg browser geometry limits for preflight validation. Preserve duplicate DICOM filenames during conversion, release viewer sessions when their windows close, and prevent cancellation/retry races.

  Resolve QSM voxel-dependent defaults for supplied masks before reconstruction, so generated-mask and supplied-mask runs produce the same output. Add complete Mac scientific validation commands and evidence checks. The SynthSeg GPU buffer ceiling remains unchanged.

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

## 0.28.20260928

### Minor Changes

- Update the shared webapp components to 0.5.0. Advance the minor version so the changed bundle does not reuse the existing 0.27.20260928 release version.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0

## 0.27.20260928

### Patch Changes

- Pin Tagify JavaScript and CSS to 4.38.0 so standalone offline verification keeps using the existing locked files after upstream releases.

## 0.27.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5

## 0.27.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.

## 0.27.20260920

### Patch Changes

- Updated dependencies [4959500]
  - @neurodesk/webapp-components@0.4.4

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.3

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.2

## 0.27.20260918

### Minor Changes

- Sync QSMbly with upstream 6e01b15: update QSM.rs to 0.35.0 and qsmxt-config to 9.21.0, add threaded classical and lazy-loaded deep-learning WASM, HD-BET, signal-based mask refinement and reconstruction fixes. Preserve the shared shell and real brain example, and credit the upstream application in About.

### Patch Changes

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.1

## 0.26.20260918

### Patch Changes

- Replace the example with real 3 T, 1 mm brain magnitude and phase MRI from the QSMxT OSF dataset, mirrored at a pinned Hugging Face revision with acquisition metadata and provenance.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.1

## 0.26.20260916

### Minor Changes

- Initialize upload controllers before fetching the example catalog. Keep file pickers disabled until initialization finishes, and preserve DICOM imports when the catalog is slow or unavailable.

## 0.25.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and mask worker messaging, fix TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0

## 0.25.20260915

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

## 0.24.20260914

### Patch Changes

- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/webapp-components@0.1.5

### Patch Changes

- Add optional TopoFit mid-surface normals and flat cortical patches, matching OpenRecon's atlas eligibility, geodesic search, plane-fit criteria and local ribbon geometry. Export native-grid patch-and-normal QC, individual patch surfaces, paired geometry JSON, normals CSV and measurements; support hemisphere, radius, count, quality and native-grid ROI settings. Pin the fsaverage atlas on Hugging Face. Compare the geometry with OpenRecon on both full-resolution validation hemispheres.

  Keep anatomical surfaces in 3-Plane view and give registration sphere files the FreeSurfer parser extension for display. Remove the repeated sidebar warning and single-option contrast selector. Suppress consecutive duplicate technical-log messages across apps, including QSMbly and CALMaR, and report model-download progress when its percentage changes.

- Updated dependencies
  - @neurodesk/webapp-components@0.1.4

## 0.24.20260910

### Minor Changes

- Release the complete application catalog after integrating BrowserQC, dwi2trx and SynthSeg. Preserve shared interface behavior and publish bundles with synchronized date versions.

## 0.23.20260910

### Changes

- Adopt MAJOR.MINOR.YYYYMMDD versioning, link every app to the lightNIIng ecosystem (lightniing.org) from the app bar and About dialog, and keep build scratch files off the shared /tmp volume.

## 0.23.4

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).
- Updated dependencies
  - @neurodesk/webapp-components@0.1.3

## 0.23.3

### Patch Changes

- cd790d5: Finish shared imaging convergence by centralizing worker sessions, input handling, app-specific controllers, workspace styles, and runtime clients. Strengthen shell contracts and regression coverage.

## 0.23.2

### Patch Changes

- 5560336: Consolidate imaging workers, pipeline execution, viewer behavior, NIfTI serialization, runtime wrappers, shared styling, and hosted shell controls. Fix CALMaR analysis startup and layout, and remove horizontal overflow from Deface controls.

## 0.23.1

### Patch Changes

- 46be48e: Add a persistent light and dark theme switch to the webapp catalog and every hosted or standalone webapp bundle.

## 0.23.0

### Minor Changes

- Sync with upstream QSMbly v0.23.0: adopt the QSMxT ecosystem landing flow, update QSM.rs to v0.23.0 and qsmxt-config to v9.11.0, add six FANSI-family dipole inversions, and add TFI reconstruction.

## 0.18.4

### Patch Changes

- Standardize the Neurodesk app shell and add DNT/GPC-respecting page-view analytics with aggregate per-app usage statistics.

## 0.18.3

### Patch Changes

- Align the application interfaces with the Neurodesk design system and point app source links at the webapps monorepo.

## 0.18.2

### Patch Changes

- 4a4dd72: Apply the Neurodesk designer-guide theme to hosted and standalone webapp bundles.
