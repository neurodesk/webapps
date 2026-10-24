# spinalcordtoolbox

## 0.9.20261024

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/spinalcordtoolbox@0.9.20261024
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/spinalcordtoolbox@0.9.20261024
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/spinalcordtoolbox@0.9.20261024
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/spinalcordtoolbox@0.9.20261024
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/spinalcordtoolbox@0.9.20261024
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/spinalcordtoolbox@0.9.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
  - @neurodesk/spinalcordtoolbox@0.9.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/spinalcordtoolbox@0.9.20261024

## 0.9.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/spinalcordtoolbox@0.9.20261022

## 0.9.20261020

### Patch Changes

- The FreeBrowse viewer's eye button now hides a volume through NiiVue's own `visible` flag, which NiiVue draws from 1.0.0-rc.24, instead of a shim that set the volume's opacity to 0. A hidden volume keeps its opacity, so the Opacity slider shows the real value while it is hidden. Spinal Cord Toolbox's Results eye buttons hide a stage the same way, keeping its opacity, so either eye can show what the other hid, in the main viewer and in Compare. TopoFit's 3D anatomy clip and its patch QC result follow the flag: hiding the QC volume with FreeBrowse's eye clears its measurements as before.
  - @neurodesk/spinalcordtoolbox@0.9.20261020
- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/spinalcordtoolbox@0.9.20261020
- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/spinalcordtoolbox@0.9.20261020

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/spinalcordtoolbox@0.9.20261020

- Updated dependencies [ea2a6d2]

- Updated dependencies [3f1d770]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/spinalcordtoolbox@0.9.20261020

- Updated dependencies [d9718cd]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/spinalcordtoolbox@0.9.20261020

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/spinalcordtoolbox@0.9.20261020

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/spinalcordtoolbox@0.9.20261020

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/spinalcordtoolbox@0.9.20261020

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/spinalcordtoolbox@0.9.20261020

- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/spinalcordtoolbox@0.9.20261020
- Updated dependencies [4b40da1]

- NiiVue moves to 1.0.0-rc.26 in Brain Extraction, Carotid Flow, SYNcro, SynthSeg, White Matter Lesions, and, through the shared FreeBrowse viewer, Spinal Cord Toolbox, DICOM View and TopoFit. From rc.25, NiiVue places a loaded drawing on the right voxels of a sagittal or otherwise permuted image (niivue/mono#251), so the mask editor no longer probes and reverses NiiVue's load on opening a mask. Opening a mask for editing now takes one load instead of up to five on such images. MuscleMap, SeedSeg and VesselBoost run NiiVue 0.68, which already loaded drawings correctly; they pick up the simpler editor.

  From rc.22 NiiVue renders with WebGL2 by default, so the five apps that pinned rc.11 or rc.14 draw their viewer with WebGL2 even where WebGPU is available; segmentation and other processing keep their own WebGPU backends.

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/spinalcordtoolbox@0.9.20261020
- Updated dependencies [14db080]

## 0.9.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]
  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/spinalcordtoolbox@0.9.20261019

## 0.9.20261018

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/spinalcordtoolbox@0.9.20261018

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/spinalcordtoolbox@0.9.20261018

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]

  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/spinalcordtoolbox@0.9.20261018

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/spinalcordtoolbox@0.9.20261018

- b8b37d6: DICOM View shows the selected series in FreeBrowse instead of a bare NiiVue canvas. Its Volumes panel sets the contrast range (window and level), opacity and colormap, and its header switches between axial, coronal, sagittal, 3D and multiplanar layouts and between contrast and pan for right-drag. The panel starts open where it leaves the image uncovered and closed on narrow screens. The Image, Header and Protocol tabs above the viewer replace the 3-Plane, Axial, Coronal and Sagittal tabs. The image is listed under its download name, which carries no study date.

  The shared FreeBrowse viewer now runs FreeBrowse's development build (commit eae80a127f, vendored because it is not on npm) on NiiVue 1.0.0-rc.17. Wand fills in the Drawing panel can be undone. A volume's name in the Volumes and Surfaces panels is a button that Enter or Space selects, and the contrast, opacity and frame sliders are named for assistive technology. The eye button still hides a volume through its opacity, and now restores the opacity it had, until NiiVue releases volume visibility (niivue/mono#224).

- 45ae49a: Remove verified dead code from the unused-code report (#256): dicompare's unused technical-log helpers, QSMbly's duplicate `QsmEchoViewer` export and Deface's unused `@neurodesk/webapp-components` devDependency. The calmar and SCT task tests now import the modules they check by literal path.

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/spinalcordtoolbox@0.9.20261018

- Updated dependencies [b67e4e9]
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/spinalcordtoolbox@0.9.20261018

## 0.9.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/spinalcordtoolbox@0.9.20261017

## 0.9.20261016

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/spinalcordtoolbox@0.9.20261016

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/spinalcordtoolbox@0.9.20261016

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/spinalcordtoolbox@0.9.20261016

## 0.9.20261015

### Minor Changes

- 7269dab: Add `sct-webapp`, a portable command line for the app's SCT segmentation tasks.
  The inference pipeline moves into `@neurodesk/spinalcordtoolbox`, shared by the
  browser worker and the command line, with shared output formats and names. Native
  CPU and browser WebAssembly results can differ slightly. The release bundles
  the spinalcord model; `sct-webapp download-models --task TASK`
  fetches any other task's pinned model on first use. The web app now verifies
  each model's size and SHA-256 when it downloads or reads it from its cache, and
  no longer loads localforage from a CDN.

  Keep the staged SCT package's shared imports working after composite-site
  deduplication removes the app-local component copy, and resolve its CLI test
  entrypoint through the native file path on every platform.

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

- Updated dependencies [7269dab]

- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/spinalcordtoolbox@0.9.20261015

## 0.8.20261014

### Patch Changes

- 498263f: Cite always opens the shared citation list, which ends with the Neurodesk
  paper; the app's own Citations dialog is removed.

- 850e642: Remove code that nothing calls, found by the unused-code report and checked by
  repository-wide reference searches. The shared preview module no longer carries
  a second NIfTI parser and writer; NiftiUtils remains the only one. Outputs and
  behaviour are unchanged.

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.8.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.8.20261010

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

  - @neurodesk/webapp-components@0.12.1

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

- Updated dependencies
  - @neurodesk/webapp-components@0.12.1

## 0.8.20261009

### Minor Changes

- Add MS lesion segmentation (`lesion_ms`): SCT 7.3's contrast-agnostic MS lesion model, fold 1 of release r20250909. It produces a lesion mask and lesion-only browser metrics. On the SCT course axial T2w MS image the browser result has Dice 0.82 against SCT's single-fold output and misses the smallest 8-voxel lesion.

## 0.7.20261009

### Patch Changes

- d56383f: Keep Run segmentation disabled until an input is loaded. The section's styling blocked the mouse but not the keyboard, so Enter could start a segmentation with no image.

- Updated dependencies [66bf9e9]

- Updated dependencies [501ea0c]
  - @neurodesk/webapp-components@0.12.0

## 0.7.20261007

### Minor Changes

- SpinalCordToolbox now uses the FreeBrowse viewer (NiiVue 1.0) that TopoFit uses, through one shared mount helper in `@neurodesk/runtime-support/freebrowse-viewer`. Zoom and pan work in 2D and 3D with the wheel, right-drag and two-finger pinch, and a reset restores the view. FreeBrowse supplies layout, intensity window, opacity, colormap and image download, so SCT's duplicate toolbar controls are gone; the viewer is served from the app, not a CDN.

  The log below the viewer can be enlarged by dragging its top edge or from the keyboard, and keeps an Analysis log (tasks, parameters, result summaries, warnings) apart from the Technical log. The shared `nd-console` gained `resizable` and `channels`.

  Compare shows up to four loaded images side by side with linked layout, zoom, pan and crosshair (matched in scanner millimetres), which can be unlinked for unregistered follow-up scans. Each image keeps its own results, edits and analysis inputs when you switch between them.

  The shared mask editor now edits results on the FreeBrowse viewer; edited files are named `_edited` and the approximate browser lesion metrics are withdrawn when a mask they used is edited. The vertebral-labeling port and its PAM50 templates are removed; TotalSpineSeg provides disc labels. The SCT app is prepared for the MS lesion model (`lesion_ms`), which stays unavailable until the converted model is hosted.

### Patch Changes

- Updated dependencies [22aa4bf]

  - @neurodesk/webapp-components@0.11.1

- Updated dependencies

  - @neurodesk/webapp-components@0.11.0

- Updated dependencies
  - @neurodesk/webapp-components@0.11.0

## 0.6.20261007

### Patch Changes

- 70f2770: Space the technical log's Copy and Clear buttons apart by grouping them in the shared `nd-console-actions` row; they had run together as "CopyClear". Remove the unused legacy `.console-clear` styles.

- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2

## 0.6.20261004

### Minor Changes

- Add SCT cord morphometry and standalone lesion analysis for uploaded, generated or manually edited masks, without an anatomy image. Analysis runs in the browser by default, executing the pinned, unchanged SCT 7.3 Python in a Pyodide worker, or optionally on a paired Neurodesk compute server in the pinned SCT Docker image. Both keep SCT's CSV, XLSX, pickle and labeled NIfTI outputs and show where results were computed, because WebAssembly floating-point results can differ from native SCT. Server jobs can be recovered, cancelled and deleted; browser runs cancel by terminating their worker. Automatic browser lesion metrics stay labelled approximate. Shared compute connections support selected tools and explicit HTTPS reverse-proxy addresses.

### Patch Changes

- a866951: Remove the obsolete vertebral labeling controls. TotalSpineSeg remains available for disc labeling.

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1

## 0.5.20261004

### Patch Changes

- Give the viewer Zoom and Fit controls 44-pixel touch targets through the shared workspace stylesheet.

- 0e90fbf: Add a Zoom control to the viewer toolbar. With Zoom ticked the mouse wheel zooms 2D views and right-drag pans them; untick it to scroll slices again at the same zoom, and use Fit to restore the full view.

- Updated dependencies

  - @neurodesk/webapp-components@0.9.0

- a928230: Correct segmentation and label results by hand before downloading them. Every mask and label-map row in Results (cord, lesion, TotalSpineSeg labels and disc markers) now has an Edit button that opens the shared mask editor under the viewer toolbar, with the input image as the base. Apply replaces the result with the edited uint8 NIfTI under the same file name and labels the row `(edited)`; Download then returns the edit. Cancel, a new run, Clear results, a new input or hiding the edited overlay discard unapplied strokes. Lesion statistics and automation reports keep the values the pipeline computed.

- Updated dependencies [0204fe1]

- Updated dependencies [ec85a09]

  - @neurodesk/webapp-components@0.10.0

- Updated dependencies [ec85a09]

  - @neurodesk/webapp-components@0.10.0

## 0.5.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 0.5.20260930

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2

- Updated dependencies

  - @neurodesk/webapp-components@0.7.0

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2

  - @neurodesk/webapp-components@0.7.0

## 0.5.20260928

### Patch Changes

- 93381e8: Remove the static bottom bar (version, privacy sentence, duplicate More Apps and GitHub links) from the six inference-workspace apps. The shared app bar already shows the version and links, and Privacy has its own dialog. The unused `.app-footer` and `.nd-app-footer` rules leave the shared stylesheets and the hosted theme.

- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

- Updated dependencies

- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0

- Updated dependencies

  - @neurodesk/webapp-components@0.6.1

- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0

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

- Updated dependencies

  - @neurodesk/webapp-components@0.4.2

- Updated dependencies [4959500]

  - @neurodesk/webapp-components@0.4.4

- Updated dependencies

  - @neurodesk/webapp-components@0.4.3

- Updated dependencies

  - @neurodesk/webapp-components@0.4.2

  - @neurodesk/webapp-components@0.4.3

## 0.4.20260918

### Minor Changes

- Keep ONNX thread workers inside each application's service-worker scope so model loading completes on static hosting. Test threaded model loading across the composite site before deployment.

## 0.3.20260918

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/webapp-components@0.4.1

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.

- Updated dependencies
  - @neurodesk/webapp-components@0.4.0

## 0.3.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.

- Updated dependencies
  - @neurodesk/webapp-components@0.3.0

## 0.3.20260915

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.2.0

  - @neurodesk/webapp-components@0.2.2

- Updated dependencies

  - @neurodesk/webapp-components@0.2.1

- Updated dependencies

  - @neurodesk/webapp-components@0.2.2

- Updated dependencies

  - @neurodesk/webapp-components@0.2.0

  - @neurodesk/webapp-components@0.2.1

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

## 0.2.20260914

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.1.4

- Updated dependencies [3cd773f]

- Updated dependencies [4add8da]

  - @neurodesk/webapp-components@0.1.5

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
