# brain-extraction

## 0.3.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.18
- bf52742: Correct the brain mask in the viewer before downloading it. Edit on the brain mask row shows the mask in red over the input image and opens the shared editor with Draw, Erase and Fill tools. Apply replaces the mask in the Output list, which then reads `Brain mask (edited)`, and Download returns the edited mask under the same name as a uint8 NIfTI. Cancel discards the strokes. Loading a new image or running extraction again closes an open edit. The brain image and the run report remain as extraction produced them.
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.17
- Updated dependencies [257192b]
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/synthstrip@0.1.1
  - @neurodesk/runtime-support@0.1.3
  - @neurodesk/brain-extraction@0.1.16
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/synthsr@0.5.20261004
  - @neurodesk/brain-extraction@0.1.15

## 0.3.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0
  - @neurodesk/synthsr@0.5.20261003
  - @neurodesk/brain-extraction@0.1.14

## 0.3.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.13

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.12

## 0.3.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.11

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
  - @neurodesk/brain-extraction@0.1.10

## 0.2.20260928

### Minor Changes

- Publish versioned app automation contracts and checksummed run reports for brain extraction and SynthSeg. Add shared run identities, explicit completion and cancellation, and SynthSeg label-volume summaries. Generate browser jobs from the contracts and expose discovery, validation, asynchronous execution, cancellation and artifact resources through the desktop's local MCP server, with an optional native SynthSeg engine.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0
  - @neurodesk/synthsr@0.4.20260928
  - @neurodesk/brain-extraction@0.1.9

## 0.1.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5
  - @neurodesk/synthsr@0.4.20260924
  - @neurodesk/brain-extraction@0.1.8

## 0.1.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.
  - @neurodesk/synthsr@0.4.20260923
  - @neurodesk/brain-extraction@0.1.7

## 0.1.20260920

### Patch Changes

- Updated dependencies [4959500]
  - @neurodesk/webapp-components@0.4.4
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.6

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.3
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.5

### Patch Changes

- efd8af3: Show the Example control before the file picker in every app, replace the registration apps' stale "Loading the default images" empty state, give FireANTs a CPU time budget and progress messages, ship BrowserQC's CPU MindGrab bundle with a longer segmentation budget, select CPU processing in SynthSR and brain extraction when no WebGPU adapter exists, start MuscleMap at 50 % overlap without WebGPU, and run VesselBoost's hosted example workflow in its browser tests.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.2
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.4

## 0.1.20260918

### Patch Changes

- Include and initialize the Rayon worker helpers required by QSMbly's updated BET runtime.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.1
- Updated dependencies

  - @neurodesk/webapp-components@0.4.1
  - @neurodesk/synthsr@0.4.20260918
  - @neurodesk/brain-extraction@0.1.3

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.0
  - @neurodesk/synthsr@0.4.20260918
  - @neurodesk/brain-extraction@0.1.2

## 0.1.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0
  - @neurodesk/synthsr@0.4.20260916
  - @neurodesk/brain-extraction@0.1.1

## 0.1.20260915

### Patch Changes

- Add T1 and T2 head MRI examples with cancellable downloads and retry. Remove the BET method description and clarify that the current browser SynthStrip adapter uses the CPU. Require declared, pinned examples and browser coverage for newly generated apps.

### Patch Changes

- Publish Brain extraction in a separately versioned offline suite.

### Patch Changes

- Include Brain extraction in the offline desktop suite with its SynthStrip model and a real BET extraction and download check. Reuse the shared MindGrab adapter in SYNcro.

### Minor Changes

- Add Brain extraction with QSMbly's Rust BET, MindGrab and SynthStrip. Load NIfTI or DICOM, view and download brain images and binary masks, and cancel processing. Offer BET's fractional intensity setting and optional MindGrab CPU processing. Share SYNcro's MindGrab adapter with the new app.
