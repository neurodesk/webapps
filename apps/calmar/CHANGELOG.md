# calmar

## 0.7.20261020

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/calmar@0.7.20261020
- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/calmar@0.7.20261020

- Updated dependencies [3f1d770]

- Updated dependencies [d9718cd]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/calmar@0.7.20261020

- Updated dependencies [ea2a6d2]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/calmar@0.7.20261020

- Updated dependencies [d9718cd]
  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/calmar@0.7.20261020

## 0.7.20261018

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/calmar@0.7.20261018

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/calmar@0.7.20261018

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]

  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/calmar@0.7.20261018

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/calmar@0.7.20261018

- 45ae49a: Remove verified dead code from the unused-code report (#256): dicompare's unused technical-log helpers, QSMbly's duplicate `QsmEchoViewer` export and Deface's unused `@neurodesk/webapp-components` devDependency. The calmar and SCT task tests now import the modules they check by literal path.

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/calmar@0.7.20261018

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/calmar@0.7.20261018

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/calmar@0.7.20261018

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]

  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/calmar@0.7.20261018

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/calmar@0.7.20261018

## 0.7.20261017

### Minor Changes

- dd64cf6: Segment acute stroke lesions on diffusion data. With DWI/TRACE plus ADC or b0, Run analysis seeds the lesion with DeepISLES SEALS (the ISLES'22-winning nnU-Net, fold 0, 59.5 MB) instead of the T1 model; without ADC it is computed from the b0. Without a T1, the b0 or DWI/TRACE is used for brain extraction and registration. A new b0 input sits beside DWI/TRACE and ADC. The benchmark-only NVAUTO candidate is removed.

### Patch Changes

- Updated dependencies [dd64cf6]
  - @neurodesk/calmar@0.7.20261017

## 0.6.20261017

### Patch Changes

- cedc83a: Show a DWI/TRACE or ADC image in the viewer when it is loaded: as the base when nothing else is loaded, otherwise as a colour overlay on the T1 or lesion, so analysis overlays stay on the T1.

- b547d52: CALMaR shows its result tables in a Results view in the viewer instead of the sidebar, so the Lesion % and Map % columns are no longer cut off. The Results tab opens once an analysis finishes and stays disabled until there is an atlas overlap, during lesion-mask review and after Start over. The separate Analysis log is gone: every message now appears once, in full and with its level, in the technical log. Captions above shared data tables are styled as muted, left-aligned notes. Loading a new T1 or lesion mask, confirming a mask, re-warping the lesion or changing the atlas now clears the previous results and their downloads, and a calculation that finishes after such a change is discarded instead of shown.

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/calmar@0.6.20261017

## 0.6.20261016

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/calmar@0.6.20261016

- 311a3fa: Use the shared info icon, so help icons stay round on phones instead of stretching to the 44 px touch height, and keep the Run analysis icon inside the sidebar.

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/calmar@0.6.20261016

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/calmar@0.6.20261016

## 0.6.20261015

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

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/calmar@0.6.20261015

## 0.6.20261014

### Patch Changes

- 498263f: Cite always opens the shared citation list, which ends with the Neurodesk
  paper; the app's own Citations dialog is removed. That dialog still named
  ADHD-200 as the connectivity source, which the development fMRI packs replaced.

- 850e642: Remove code that nothing calls, found by the unused-code report and checked by
  repository-wide reference searches. The shared preview module no longer carries
  a second NIfTI parser and writer; NiftiUtils remains the only one. Outputs and
  behaviour are unchanged.

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0
  - @neurodesk/calmar@0.6.20261014

## 0.6.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/calmar@0.6.20261012

## 0.6.20261010

### Minor Changes

- c6e4804: Add a portable CALMAR CPU command line that shares preparation and reviewed-lesion mapping with the browser. Include immutable offline models and both connectivity packs, explicit candidate review, strict grid guards, and independent browser/scientific archive validation.

### Patch Changes

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/calmar@0.6.20261010

- Reuse the shared NIfTI-1 reader in the CALMAR command line. Honour both byte orders and disable intercept scaling when the slope is zero; preserve source byte order in derived images.

- Updated dependencies

  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/calmar@0.6.20261010

- Updated dependencies [c6e4804]

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/calmar@0.6.20261010

- Updated dependencies
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/calmar@0.6.20261010

## 0.5.20261009

### Patch Changes

- 9a0f4ae: Make the DeepISLES DWI/ADC seed route runnable once its asset is validated: its helpers were declared inside the registration step and the affine reader was never imported, so the route would have stopped with a ReferenceError. Zero background voxels now stay zero under the nonzero z-score, as in MONAI's `NormalizeIntensity(nonzero=True)`. The atlas loader's fallback import of the bundled NIfTI parser now points at the file that exists.

- 501ea0c: Load every model, atlas, template and connectome from a fixed revision instead of `main`: `sbollmann/lnm-webapp-models` at commit `6fd71cdb`, the Schaefer400 2 mm atlas from CBIG commit `d1454a61` instead of a movable tag, and the Schaefer400 connectome index from `neurodeskorg/webapps` commit `4cc5b1a5`, a copy whose shard URLs are pinned to the same `lnm-webapp-models` commit. The bytes of every model, atlas and shard are unchanged.

- Updated dependencies [66bf9e9]

- Updated dependencies [501ea0c]
  - @neurodesk/webapp-components@0.12.0

## 0.5.20261007

### Patch Changes

- Updated dependencies [22aa4bf]

  - @neurodesk/webapp-components@0.11.1

- Updated dependencies

  - @neurodesk/webapp-components@0.11.0

- 70f2770: Space the technical log's Copy and Clear buttons apart by grouping them in the shared `nd-console-actions` row; they had run together as "CopyClear". Remove the unused legacy `.console-clear` styles.

- Updated dependencies [70f2770]

  - @neurodesk/webapp-components@0.10.2

- Updated dependencies [22aa4bf]

  - @neurodesk/webapp-components@0.11.1

- Updated dependencies
  - @neurodesk/webapp-components@0.11.0

## 0.5.20261004

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.10.1

- Updated dependencies [0204fe1]

- Updated dependencies [ec85a09]

  - @neurodesk/webapp-components@0.10.0

- Updated dependencies

  - @neurodesk/webapp-components@0.9.0

- Updated dependencies

  - @neurodesk/webapp-components@0.10.1

- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0

## 0.5.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 0.5.20260930

### Patch Changes

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.7.0

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2

- Updated dependencies
  - @neurodesk/webapp-components@0.7.0

## 0.5.20260928

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.6.1

- 93381e8: Remove the static bottom bar (version, privacy sentence, duplicate More Apps and GitHub links) from the six inference-workspace apps. The shared app bar already shows the version and links, and Privacy has its own dialog. The unused `.app-footer` and `.nd-app-footer` rules leave the shared stylesheets and the hosted theme.

- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

- Updated dependencies

- Updated dependencies [93381e8]

- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

## 0.4.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0

## 0.4.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5

## 0.4.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.

## 0.4.20260920

### Patch Changes

- Updated dependencies [4959500]

  - @neurodesk/webapp-components@0.4.4

- Updated dependencies

  - @neurodesk/webapp-components@0.4.3

- Updated dependencies

  - @neurodesk/webapp-components@0.4.2

- Updated dependencies [4959500]

  - @neurodesk/webapp-components@0.4.4

- Updated dependencies
  - @neurodesk/webapp-components@0.4.3

## 0.4.20260918

### Minor Changes

- Keep ONNX Runtime thread workers inside Calmar's isolation service-worker scope. This fixes SynthStrip hanging after normalization on GitHub Pages when shared runtime worker responses lack isolation headers.

## 0.3.20260918

### Patch Changes

- Load only the structural T1 in the stroke example so Run analysis computes the lesion mask for review before network mapping.

- Updated dependencies

  - @neurodesk/webapp-components@0.4.1

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.

- Updated dependencies

  - @neurodesk/webapp-components@0.4.0

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1

- Updated dependencies
  - @neurodesk/webapp-components@0.4.1

## 0.3.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.

- Updated dependencies
  - @neurodesk/webapp-components@0.3.0

## 0.3.20260915

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.2.2

- Updated dependencies

  - @neurodesk/webapp-components@0.2.1

- Updated dependencies

  - @neurodesk/webapp-components@0.2.0

- Updated dependencies

  - @neurodesk/webapp-components@0.2.2

- Updated dependencies
  - @neurodesk/webapp-components@0.2.1

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

## 0.2.20260914

### Patch Changes

- Updated dependencies [3cd773f]

- Updated dependencies [4add8da]

  - @neurodesk/webapp-components@0.1.5

- Add optional TopoFit mid-surface normals and flat cortical patches, matching OpenRecon's atlas eligibility, geodesic search, plane-fit criteria and local ribbon geometry. Export native-grid patch-and-normal QC, individual patch surfaces, paired geometry JSON, normals CSV and measurements; support hemisphere, radius, count, quality and native-grid ROI settings. Pin the fsaverage atlas on Hugging Face. Compare the geometry with OpenRecon on both full-resolution validation hemispheres.

  Keep anatomical surfaces in 3-Plane view and give registration sphere files the FreeSurfer parser extension for display. Remove the repeated sidebar warning and single-option contrast selector. Suppress consecutive duplicate technical-log messages across apps, including QSMbly and CALMaR, and report model-download progress when its percentage changes.

- Updated dependencies

  - @neurodesk/webapp-components@0.1.4

- Updated dependencies [4add8da]
  - @neurodesk/webapp-components@0.1.5

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
