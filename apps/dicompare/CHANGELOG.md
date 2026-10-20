# dicompare

## 0.15.20261020

### Patch Changes

- DICOM View's "Open in White matter lesions" button is now an "Open in another webapp"
  menu that lists every app of the site from the registry. Most apps receive the converted
  NIfTI image; apps the registry marks `handoff: dicom` (dicompare, QSMbly, dwi2trx, NODDI,
  Carotid Flow) receive the series' DICOM files, and `handoff: none` keeps an app that cannot
  use a single series (Zarro, FastPrep, SurfAnnotate, LCModel) out of the menu. The shared shell
  receives a handoff for every app the way a page drop opens files, through the app's own
  inputs; dicompare opens the files as reference acquisitions, and White matter lesions
  keeps its own receiver.

  A multiframe DICOM whose frames lie in different planes, such as a scanner's MPR head
  scout, which dcm2niix refuses, now shows each frame as its own correctly placed slice
  instead of failing with exit code 2. `readDicomFrames` in `@neurodesk/dicom2vid` reads a
  file's frames with their own position, orientation and pixel spacing.

  Dropping files or a folder on the image now opens them. FreeBrowse draws NiiVue inside a
  shadow root, so the page drop never saw the canvas and NiiVue swallowed the drop; the page
  drop now reads the event's composed path. It also no longer routes files to the
  automation contract's hidden input.

  DICOM View opens series in the ACS layout, without the 3D render, with FreeBrowse's
  panel closed.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.17.0
- Updated dependencies [ea2a6d2]
- Updated dependencies [3f1d770]
- Updated dependencies [d9718cd]
- Updated dependencies [c1a4dda]
- Updated dependencies [3329c39]
- Updated dependencies [46935f7]
  - @neurodesk/webapp-components@0.16.0

## 0.15.20261018

### Patch Changes

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0
- 6e46e80: Restore schema catalog and detail URLs on direct entry and reload on the composite GitHub Pages site, including browser-local schema IDs and external schema query URLs.
- 45ae49a: Remove verified dead code from the unused-code report (#256): dicompare's unused technical-log helpers, QSMbly's duplicate `QsmEchoViewer` export and Deface's unused `@neurodesk/webapp-components` devDependency. The calmar and SCT task tests now import the modules they check by literal path.
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]
  - @neurodesk/webapp-components@0.14.4

## 0.15.20261017

### Patch Changes

- 5b32319: Keep the schema catalog and read-only viewer technical log reachable above the status footer, including multiline clipboard errors.
- 0ca8624: Preserve empty contains constraints and arbitrary acquisition names in browser schema downloads. Report clipboard failures through the status footer and technical log on both workspace and schema viewer pages.
- Report asynchronous UI failures through the status footer and technical log, retain awaited session loading, and allow failed thumbnail preparation to retry.

  Retain the command line's schema-generation Python after upstream moved web schema exports to JavaScript. Its generated schema and reference outputs are unchanged.

- Merge upstream astewartau/dicompare-web 7c56841..d3d0879:

  - Describe the third-party requests in Privacy
  - Scope the third-party requests to the website
  - fix: keep graded constraints and messages on imported series fields
  - fix: handle promise rejections that were silently dropped (#26)
  - chore: remove unused files, exports, types and dependencies
  - fix: show schema upload errors in the workspace schema library
  - fix: save graded constraints and custom messages when exporting schemas
  - fix: keep a rule's enabledSystemFields through import and save
  - Merge remote-tracking branch 'origin/fix/unhandled-promise-rejections' into chore/remove-unused-code
  - Merge pull request #27 from astewartau/fix/series-field-graded-import
  - Merge pull request #28 from astewartau/fix/unhandled-promise-rejections
  - Merge pull request #29 from astewartau/chore/remove-unused-code
  - Merge pull request #30 from astewartau/fix/graded-schema-export
  - chore: bump version to 0.15.4
  - fix: make no third-party requests from the desktop app
  - Merge pull request #31 from astewartau/fix/desktop-no-external-requests
  - Merge pull request #24 from stebo85/fix/privacy-third-party

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.15.20261016

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.15.20261015

### Minor Changes

- 81ec8a2: Add the `dicompare` portable command line. It runs the web app's Pyodide build
  and pinned dicompare wheel in Node, offline, with the worker's own Python calls:
  `analyze`, `compare` (the compliance report) and `build-schema`, plus the app's
  schema library. Its reports match the web app's downloads.

### Patch Changes

- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.14.20261014

### Patch Changes

- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.14.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.14.20261010

### Patch Changes

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.
- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
- Declare workspace dependencies without expanding SYNcro portable runtime installations. Mark dicompare type imports explicitly and separate the unchanged NeSVoR reference validator from worker orchestration to remove dependency cycles.
- Updated dependencies
  - @neurodesk/webapp-components@0.12.1

## 0.14.20261009

### Patch Changes

- 777c39f: State what dicompare actually requests in Privacy: on the website, the Pyodide runtime from cdn.jsdelivr.net, Python packages from PyPI, and Cloudflare Web Analytics page views, none carrying data from your files; the desktop and Standalone versions make none of these requests. Previously the app's own Privacy text said it used no analytics or external services.
- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
  - @neurodesk/webapp-components@0.12.0

## 0.14.20261007

### Patch Changes

- 118632c: Merge upstream astewartau/dicompare-web f0462e2..7c56841 (upstream 0.11.1 to 0.15.3):

  - Runs the dicompare Python package 0.11.1 (was 0.6.0) with the patched pydicom 2.4.5 it requires; the offline bundle ships both wheels.
  - Validation rules use dicompare's `ctx` rule API and can declare parameters, which the rule table and editor show and edit.
  - Field constraints have a severity (fail, or warn as reference only), notes, graded pass/warn/fail ranges set on a number-line editor, and custom messages; tables and printed reports show them.
  - The field picker reads dicompare's canonical field registry, including derived fields, and offers enumerated values.
  - Schema lint hints, a production-faithful rule test harness, and confirmation of custom schema uploads in the Schema Library.
  - New library schemas (HC-ChiSep, Axon diameter mapping, Protocols for DWI analysis); the validation-function library was rebuilt and existing schemas revised (tolerances, reference-only SAR/dB/dt).
  - The worker rejects requests after five minutes of silence and recovers from a crashed worker; dialogs share one accessible modal with focus trapping; tooltips render above sticky table headers.

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2

## 0.14.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0

## 0.14.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 0.14.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2

## 0.14.20260929

### Patch Changes

- Run DICOMpare's unit tests and Playwright workflows with their respective runners. Build each app before its browser CI checks so clean runners receive the generated scientific runtimes and contracts required by automation.

## 0.14.20260928

### Patch Changes

- ccece98: Keep populated reference and test-data controls from overlapping on narrow screens.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1

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

## 0.13.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0

## 0.13.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5

## 0.13.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.

## 0.13.20260920

### Patch Changes

- Updated dependencies [4959500]
  - @neurodesk/webapp-components@0.4.4

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.3

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.2

## 0.13.20260918

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/webapp-components@0.4.1

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.0

## 0.13.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0

## 0.13.20260915

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

## 0.12.20260910

### Minor Changes

- Release the complete application catalog after integrating BrowserQC, dwi2trx and SynthSeg. Preserve shared interface behavior and publish bundles with synchronized date versions.

## 0.11.20260910

### Changes

- Adopt MAJOR.MINOR.YYYYMMDD versioning, link every app to the lightNIIng ecosystem (lightniing.org) from the app bar and About dialog, and keep build scratch files off the shared /tmp volume.

## 0.11.9

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).

## 0.11.8

### Patch Changes

- cd790d5: Finish shared imaging convergence by centralizing worker sessions, input handling, app-specific controllers, workspace styles, and runtime clients. Strengthen shell contracts and regression coverage.

## 0.11.7

### Patch Changes

- 5560336: Consolidate imaging workers, pipeline execution, viewer behavior, NIfTI serialization, runtime wrappers, shared styling, and hosted shell controls. Fix CALMaR analysis startup and layout, and remove horizontal overflow from Deface controls.

## 0.11.6

### Patch Changes

- 46be48e: Add a persistent light and dark theme switch to the webapp catalog and every hosted or standalone webapp bundle.

## 0.11.5

### Patch Changes

- Standardize the Neurodesk app shell and add DNT/GPC-respecting page-view analytics with aggregate per-app usage statistics.

## 0.11.4

### Patch Changes

- Align the application interfaces with the Neurodesk design system and point app source links at the webapps monorepo.

## 0.11.3

### Patch Changes

- 4a4dd72: Apply the Neurodesk designer-guide theme to hosted and standalone webapp bundles.
