# @neurodesk/webapp-components

## 0.15.0

### Minor Changes

- b68209b: DICOM View can open the selected image in White matter lesions. Open in White matter lesions, under the series, sends the converted 3D image, named as its download is, and the same tab opens White matter lesions with the image loaded and ready to segment. A time series or a single slice keeps the button disabled and says why. Choosing another series while a send is in progress cancels it. DICOM View's automation contract now gives its image artifact the `application/x-nifti` media type.

  White matter lesions loads an image sent from DICOM View on opening and reports "Loaded <name> from DICOM View" in the status bar. It never starts segmentation itself.

  `@neurodesk/webapp-components/handoff` passes files between apps on one site: `sendHandoff` stores them in IndexedDB and opens the target app; `takeHandoff` claims them once and returns copies. An entry can be opened for 2 minutes, only by the tab that sent it, and is deleted when it is opened. The app shell deletes expired entries whenever an app opens.

  The cross-origin isolation service worker bootstrap publishes `coiWillReload`, which resolves once a page knows whether it is about to reload, and `coiHoldReloads`, which stops later automatic reloads. Pages that use neither behave as before.

## 0.14.4

### Patch Changes

- 2ae93ae: The input menu now reads "Load data or example…", and its file actions are **Load files…** and **Load folder…**. In Chrome and Edge on desktop they open the browser's Open and Select dialogs instead of the file input's, which asked to "Upload" files: nothing is uploaded, and the menu no longer says so. A folder's files keep their paths within it, as a dropped folder's do. Other browsers, and any browser where those dialogs fail, open the file input's picker as before.
- ccb2970: Remove closed class-toggled dialogs from the accessibility tree and keyboard navigation using synchronized inert and aria-hidden state, preserving fade transitions and focus restoration. This prevents repeated attempts to dismiss an already-closed SCT About dialog.
- 67a5a8f: Style report controls (`.nd-report-controls`): a sticky row of shared fields above a report shown in place of the canvas. Style dicompare compliance reports from design tokens in the shared stylesheet.

## 0.14.3

### Patch Changes

- b547d52: CALMaR shows its result tables in a Results view in the viewer instead of the sidebar, so the Lesion % and Map % columns are no longer cut off. The Results tab opens once an analysis finishes and stays disabled until there is an atlas overlap, during lesion-mask review and after Start over. The separate Analysis log is gone: every message now appears once, in full and with its level, in the technical log. Captions above shared data tables are styled as muted, left-aligned notes.

## 0.14.2

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.

## 0.14.1

### Patch Changes

- 7443048: Failures of actions started from the interface (fiber colour, display mode, FA floor,
  the vector previews and generator, loading files) now appear in the status bar and the
  technical log instead of being lost as unhandled rejections. A tensor fit or tracking
  run whose input was replaced is logged without overwriting the newer input's status.
  Files chosen while the viewer is still starting no longer fail with
  "Cannot access … before initialization". Tensor maps and streamlines are unchanged.

  `@neurodesk/webapp-components` declares types for its `./file-io/nifti` export and adds a
  typed `./file-io/download` export, so TypeScript apps can import them without `allowJs`.

## 0.14.0

### Minor Changes

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

### Patch Changes

- dcc74e7: Each app's Standalone dialog lists only that app's own command line, never the all-apps desktop suite or its model pack. The nightly suite release now announces itself to the standalone-catalog workflow, which writes its verified entry into `registry/standalone.json` instead of leaving it on 0.10.20260918. A contract test requires every app to ship a command line or state why it cannot.

## 0.13.0

### Minor Changes

- 27c9549: SynthSeg reports brain volumes against age. Segmentation now also returns the
  soft-posterior volumes of FreeSurfer's `mri_synthseg --vol`, within 0.03 % of
  FreeSurfer 8.2.0 on the T1 example in fast mode. A new Volumes view charts each
  structure's head-size-adjusted volume against the IXI reference cohort's 5th–95th
  and 25th–75th percentiles and median, with a table of volume, adjusted volume,
  z, percentile and a flag below the 5th or above the 95th percentile. Age and sex
  come from new Input fields, filled from the DICOM header when there is one. The
  reference norms are fetched from the neurocontainers SynthSeg recipe at a pinned
  commit and checked against their checksum. Research use only. Not for diagnostic
  use.

  - Fast mode is now the default processing mode in the app and the command line,
    because the norms were fitted on fast-mode volumes.
  - The Output section adds Download volumes (.csv). The run report and automation
    measurements carry the volumes and the volume report, and `segment` accepts
    optional `age` and `sex` parameters.
  - The `synthseg` command line writes `INPUT_synthseg_vol.csv` beside its other
    outputs. The native executable gains `--vol FILE.csv`.
  - `@neurodesk/runtime-support` adds `readImageSeries`, which pairs each converted
    or supplied NIfTI with its BIDS sidecar.
  - `@neurodesk/webapp-components` adds the `.nd-viewer-report` panel and the
    `.nd-chart` vocabulary for small-multiple SVG charts.

### Patch Changes

- 850e642: Remove code that nothing calls, found by the unused-code report and checked by
  repository-wide reference searches. The shared preview module no longer carries
  a second NIfTI parser and writer; NiftiUtils remains the only one. Outputs and
  behaviour are unchanged.
- ad92e2f: Merge upstream astewartau/qsmbly 2f91e83..d2afebc:

  - One numerical path: total- and local-field maps and QSMART run through the same config-driven qsm-core stages as raw phase, so the same settings give the same numbers whichever input they start from (#142). Field strength is always required; TGV and MEDI on a field map ask for its echo time.
  - TGV's regularization level decides its alphas from the first run, and the exported command names the alphas that ran (#142). V-SHARP and iLSQR defaults come from the generated qsm-core defaults (#131).
  - Deep-learning tile patches are capped at 120 voxels so they fit browser memory (#137).
  - Gzipped NIfTI masks and field maps are decoded with their scaling, and field-map voxel sizes set the defaults (#130). A 4D mask is refused instead of silently truncated.
  - The WASM module failing to load is reported instead of hanging, and Cancel during loading settles (#128). Mask paths report errors that used to fail silently (#126).
  - File names are escaped in the mask list and the import triage (#132). dicompare loads on first use, so an unreachable dicompare.neurodesk.org only disables the report (#130).
  - Accessibility: labelled controls, hidden-attribute settings panels, and dialogs that take focus, trap Tab, close on Escape and return focus (#133, #139; the shared ModalManager now does this for every app). Tagify is pinned to 4.39.0 with subresource integrity.
  - The shared decodeNiftiBuffer can stop after the header (`{ maxBytes }`).

## 0.12.3

### Patch Changes

- Expose qform and sform codes from the shared NIfTI header parser so diagnostic messages and image geometry use the same interpretation.

## 0.12.2

### Patch Changes

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.

## 0.12.1

### Patch Changes

- Reuse the shared NIfTI-1 reader in the CALMAR command line. Honour both byte orders and disable intercept scaling when the slope is zero; preserve source byte order in derived images.

## 0.12.0

### Minor Changes

- 66bf9e9: Add the `brain2print` command line: `brain2print IMAGE OUTPUT_DIR` runs the web app's create-mesh operation in Node, with MindGrab on the CPU and the same niimath WebAssembly, and writes the web app's three downloads under the same names. Its options are the app's automation parameters: `--model`, `--backend` (the command line always runs on the CPU), `--simplify`, `--smooth`, `--[no-]largest-only` and `--[no-]fill-bubbles`. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check runs the app's pinned example, the template of the app's CPU e2e test and the right- and left-handed test fixtures, and requires every file to match the web pipeline's output in Chromium byte for byte; the app's CPU e2e test is held to the same pins.

  The app's pipeline moves into `@neurodesk/brain2print`, which the app and the command line share. The app now gives MindGrab NIfTI files as stored rather than as NiiVue rewrites them, and uses MindGrab 0.1.20260925. Breaking for `@neurodesk/topofit`: `readMz3`, `writeMz3` and `writeStl` are no longer exported from `@neurodesk/topofit/results`; import them from `@neurodesk/webapp-components/file-io/mesh`. The package is not published to npm and no workspace consumer imports them from TopoFit any more.

- 501ea0c: Remove the `@neurodesk/webapp-components/example-images` subpath export (`NIFTI_EXAMPLES`, `NIIMATH_EXAMPLE_BASE_URL`). Importing it now fails. No app has used it since examples moved to `examples.json`, and it pointed at unpinned NiiVue demo images; declare examples in an app's `examples.json` instead.

## 0.11.1

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

## 0.11.0

### Minor Changes

- SpinalCordToolbox now uses the FreeBrowse viewer (NiiVue 1.0) that TopoFit uses, through one shared mount helper in `@neurodesk/runtime-support/freebrowse-viewer`. Zoom and pan work in 2D and 3D with the wheel, right-drag and two-finger pinch, and a reset restores the view. FreeBrowse supplies layout, intensity window, opacity, colormap and image download, so SCT's duplicate toolbar controls are gone; the viewer is served from the app, not a CDN.

  The log below the viewer can be enlarged by dragging its top edge or from the keyboard, and keeps an Analysis log (tasks, parameters, result summaries, warnings) apart from the Technical log. The shared `nd-console` gained `resizable` and `channels`.

  Compare shows up to four loaded images side by side with linked layout, zoom, pan and crosshair (matched in scanner millimetres), which can be unlinked for unregistered follow-up scans. Each image keeps its own results, edits and analysis inputs when you switch between them.

  The shared mask editor now edits results on the FreeBrowse viewer; edited files are named `_edited` and the approximate browser lesion metrics are withdrawn when a mask they used is edited. The vertebral-labeling port and its PAM50 templates are removed; TotalSpineSeg provides disc labels. The SCT app is prepared for the MS lesion model (`lesion_ms`), which stays unavailable until the converted model is hosted.

## 0.10.2

### Patch Changes

- 70f2770: Space the technical log's Copy and Clear buttons apart by grouping them in the shared `nd-console-actions` row; they had run together as "CopyClear". Remove the unused legacy `.console-clear` styles.

## 0.10.1

### Patch Changes

- Add SCT cord morphometry and standalone lesion analysis for uploaded, generated or manually edited masks, without an anatomy image. Analysis runs in the browser by default, executing the pinned, unchanged SCT 7.3 Python in a Pyodide worker, or optionally on a paired Neurodesk compute server in the pinned SCT Docker image. Both keep SCT's CSV, XLSX, pickle and labeled NIfTI outputs and show where results were computed, because WebAssembly floating-point results can differ from native SCT. Server jobs can be recovered, cancelled and deleted; browser runs cancel by terminating their worker. Automatic browser lesion metrics stay labelled approximate. Shared compute connections support selected tools and explicit HTTPS reverse-proxy addresses.

## 0.10.0

### Minor Changes

- ec85a09: Add a shared editor for correcting masks and label maps in the viewer. The `nd-mask-editor` element (`createMaskEditor`) is a second viewer toolbar row with Draw, Erase and Fill tools, a Label select for label maps, brush size, Undo, Apply and Cancel. It edits through NiiVue's drawing layer in both the 0.x and 1.0 generations (`createDrawingAdapter` in `@neurodesk/webapp-components/viewer`). Apply returns the result on its own grid as a uint8 NIfTI with the result's name. `createResultList` shows an Edit button for results marked `editable` and labels edited results. On NiiVue 1.0 rc.11 to rc.14 the adapter corrects a NiiVue load error that put masks on the wrong voxels of images with permuted axes, such as sagittal acquisitions.

  Cancellation waits for pending editor work and prevents a cancelled export from applying to a replacement result. Removing the editor releases its drawing session and keyboard listener. Editing rejects masks whose voxel dimensions or affine differ from the displayed image, and exports preserve the source mask's header and extensions.

### Patch Changes

- 0204fe1: Style the `.nd-edit-btn` result action wherever it appears. Apps that build their own result rows, rather than using `createResultList`, now get the same Edit button as the shared list.

## 0.9.0

### Minor Changes

- Share SynthSR and SynthSeg worker model acquisition through fetchModel. Verify cached and downloaded weights before use, reject oversized streams early, and replace corrupt cached weights within the same run. Preserve SynthSR local model files, pinned hashes, progress allocation and worker cancellation. Restore app-specific connection and recovery guidance when model requests fail.

## 0.8.0

### Minor Changes

- Share operation parameter schemas across browser and desktop automation. Both callers now use the same defaults, enum values, bounds, recursive arrays, decimal multiples and safe integer rules. Preserve MCP parameter metadata and bundle the validator for native ESM development, standalone releases and the composite catalog.

## 0.7.0

### Minor Changes

- Add the shared remote compute client and connection panel for NeSVoR, including paired job ownership, recovery, cancellation and Linux/NVIDIA standalone server setup instructions. Keep credentials out of local storage and show the current webapp origin in server startup commands. Preserve the desktop automation input grants alongside the explicitly configured compute-server origins.

### Patch Changes

- Retry example downloads and OME-Zarr reads that the host rate-limits (HTTP 429), honouring Retry-After, instead of failing the example.

## 0.6.2

### Patch Changes

- Add White matter lesions: FLAMeS lesion segmentation of a single FLAIR image in the browser, after SynthStrip brain extraction, with a lesion mask, probability map and lesion table. Result lists can mark a result as not viewable, which keeps its row and disables View.

## 0.6.1

### Patch Changes

- Use portable underscore MCP tool names, explicit input cardinality, and declared SynthSeg browser geometry limits for preflight validation. Preserve duplicate DICOM filenames during conversion, release viewer sessions when their windows close, and prevent cancellation/retry races.

  Resolve QSM voxel-dependent defaults for supplied masks before reconstruction, so generated-mask and supplied-mask runs produce the same output. Add complete Mac scientific validation commands and evidence checks. The SynthSeg GPU buffer ceiling remains unchanged.

## 0.6.0

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- 93381e8: Remove the static bottom bar (version, privacy sentence, duplicate More Apps and GitHub links) from the six inference-workspace apps. The shared app bar already shows the version and links, and Privacy has its own dialog. The unused `.app-footer` and `.nd-app-footer` rules leave the shared stylesheets and the hosted theme.
- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

## 0.5.0

### Minor Changes

- Publish versioned app automation contracts and checksummed run reports for brain extraction and SynthSeg. Add shared run identities, explicit completion and cancellation, and SynthSeg label-volume summaries. Generate browser jobs from the contracts and expose discovery, validation, asynchronous execution, cancellation and artifact resources through the desktop's local MCP server, with an optional native SynthSeg engine.

## 0.4.5

### Patch Changes

- 39a9ea5: New app: Carotid Flow finds both carotid arteries in a gated phase-contrast neck slice and plots their flow over the cardiac cycle, with peak, time average and pulsatility index, a CSV of the curves and a NIfTI of the carotid labels. Signed velocity gives flow in ml/min: arteries are told from veins by direction and pulse, and each carotid is the artery carrying most flow on its side; on the open example (PCMCalculator's test data) the right carotid is within 6 % of PCMCalculator's manual measurement. Unsigned speed images go through a port of the requesting lab's MATLAB script, which names left and right from the image orientation where the script called the patient's right carotid the left one. Shared file I/O gains `readNiftiFrames`, which reads every frame of a 4D NIfTI.

## 0.4.4

### Patch Changes

- 4959500: Add an individual 3D View action for cortical surfaces, hide the MRI volume in surface scenes, and draw thin surface boundaries on the 2D slices. Keep visibility checkboxes for comparisons and STL export.

## 0.4.3

### Patch Changes

- Replace TopoFit's bare NiiVue viewer with FreeBrowse 2.5.0-next.1 and its matching NiiVue rc.13 event model. Keep mid-surface overlays, detected-patch RAS measurements, and STL exports synchronized with FreeBrowse's volume and surface controls. Add shared embedding styles for the existing application bar, theme, and phone layout.

## 0.4.2

### Patch Changes

- Style dialog inputs with the shared field controls and give them 44 px touch targets and 16 px text on phones. Verify TopoFit's STL settings at desktop and phone widths.

## 0.4.1

### Patch Changes

- Expose the example selector's resolved upload scope for interface auditing, complete the disabled-drop predicate type, preserve block layout before console and toolbar upgrades, and rename the drop helper module to match its API.

## 0.4.0

### Minor Changes

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.

Result lists now render a visibility checkbox whenever a result has a boolean `visible` field, including when no factory `onVisibilityChange` callback is supplied. Handle `nd-visibility-change` or provide that callback to apply the change; otherwise omit `visible` to retain a View button. This supports declarative event listeners and differs from the previous callback-gated behavior.

## 0.3.1

### Patch Changes

- Move Easy MP2RAGE to the shared imaging workspace with an input and processing sidebar, persistent three-plane viewer, View/Download result rows, collapsed technical console and visible status. Keep BIDS sessions in the same viewer and restore reachable controls on desktop and phones. Add browser coverage for scrolling, the synthetic T1/B1 example, downloads and BIDS processing.

  Add shared raster-panel sizing, wrapping slice controls and scrollable file tables. Preserve primary-action and selected-button styling inside the sidebar.

## 0.3.0

### Minor Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.

## 0.2.2

### Patch Changes

- Add OpenRecon scanner-console package links to Standalone for MuscleMap, QSMbly via QSMxT, Spinal Cord Toolbox, SynthSeg, TopoFit and VesselBoost. Link to Siemens teamplay C2P for official packages and neurodesk/openrecon for builds.

## 0.2.1

### Patch Changes

- Offer desktop and HPC downloads both with and without models. Put official Neurodesk Docker and Apptainer downloads first, simplify installation details, and separate standalone choices into clear sections.

## 0.2.0

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

## 0.1.5

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.
- 4add8da: Let TopoFit users show multiple cortical meshes together and reveal them inside the 3D volume with an adjustable X-ray control.

## 0.1.4

### Patch Changes

- Add optional TopoFit mid-surface normals and flat cortical patches, matching OpenRecon's atlas eligibility, geodesic search, plane-fit criteria and local ribbon geometry. Export native-grid patch-and-normal QC, individual patch surfaces, paired geometry JSON, normals CSV and measurements; support hemisphere, radius, count, quality and native-grid ROI settings. Pin the fsaverage atlas on Hugging Face. Compare the geometry with OpenRecon on both full-resolution validation hemispheres.

  Keep anatomical surfaces in 3-Plane view and give registration sphere files the FreeSurfer parser extension for display. Remove the repeated sidebar warning and single-option contrast selector. Suppress consecutive duplicate technical-log messages across apps, including QSMbly and CALMaR, and report model-download progress when its percentage changes.

## 0.1.3

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).
