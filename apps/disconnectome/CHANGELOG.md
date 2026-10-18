# disconnectome

## 0.3.20261018

### Patch Changes

- Updated dependencies [67a5a8f]
- Updated dependencies [b8b37d6]
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]
  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/nii2tvx@0.3.20261018

## 0.3.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/runtime-support@0.6.4
  - @neurodesk/nii2tvx@0.3.20261017

## 0.3.20261016

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.
- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/nii2tvx@0.3.20261016
- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/runtime-support@0.6.2
  - @neurodesk/nii2tvx@0.3.20261016

## 0.3.20261015

### Patch Changes

- Updated dependencies [c74b26f]
  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/nii2tvx@0.3.20261015
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

- Updated dependencies [0569da8]
- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]
  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/nii2tvx@0.3.20261015

## 0.3.20261014

### Patch Changes

- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]
  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0
  - @neurodesk/nii2tvx@0.3.20261014

## 0.3.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/runtime-support@0.4.3
  - @neurodesk/nii2tvx@0.3.20261012

## 0.3.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/nii2tvx@0.3.20261010
- Updated dependencies
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/nii2tvx@0.3.20261010

## 0.3.20261009

### Patch Changes

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
- Updated dependencies [64ffefa]
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
  - @neurodesk/nii2tvx@0.3.20261009

## 0.3.20261007

### Minor Changes

- f075aab: Add the `disconnectome` command line. It scores a NIfTI lesion against the ENIGMA Symmetric or HCP1065 atlas with the app's WebAssembly query core and writes the app's TSV download byte for byte. Atlases come from the pinned manifest with SHA-256 checks on every load and an offline mode. A lesion off the MNI152 1 mm grid is refused with the app's SYNcro advice. Portable Linux x64, Windows x64 and macOS arm64 archives bundle a private Node runtime and both atlases. Each archive must reproduce the native `nii2tvx` table for every example lesion and atlas before release. The app now takes its table name and grid refusal from `@neurodesk/nii2tvx/disconnectome`.

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
  - @neurodesk/nii2tvx@0.3.20261007
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/nii2tvx@0.3.20261007
- Updated dependencies [70f2770]
- Updated dependencies [f075aab]
  - @neurodesk/webapp-components@0.10.2
  - @neurodesk/nii2tvx@0.3.20261007

## 0.2.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/nii2tvx@0.2.20261004
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/nii2tvx@0.2.20261004
- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3
  - @neurodesk/nii2tvx@0.2.20261004
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/nii2tvx@0.2.20261004

## 0.2.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0
  - @neurodesk/nii2tvx@0.2.20261003

## 0.2.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/nii2tvx@0.2.20260930

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/nii2tvx@0.2.20260930

## 0.2.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1
  - @neurodesk/nii2tvx@0.2.20260928

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
  - @neurodesk/nii2tvx@0.2.20260928

## 0.1.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0
  - @neurodesk/nii2tvx@0.1.20260928

## 0.1.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5
  - @neurodesk/nii2tvx@0.1.20260924

## 0.1.20260923

### Patch Changes

- Disconnectome gains the shared Support action along with every other webapp. It
  merged after the release that recorded the action for the other 25 apps, so this
  notes it against the same release date.
  - @neurodesk/nii2tvx@0.1.20260923

### Patch Changes

- c8a0be2: New app: Disconnectome scores which white-matter bundles a lesion disconnects, intersecting the lesion with a population tractography atlas in WebAssembly and drawing the damaged bundles coloured by a viridis ramp over their damage. Two atlases are selectable, the 65-bundle ENIGMA Symmetric atlas by default and the 87-bundle HCP1065 atlas; each downloadable TSV is byte-identical to the nii2tvx command-line tool for that atlas.
- Convert DICOM anatomy through the shared importer and preserve the previous inputs when an example is cancelled. Complete the offline atlas inventory. Reject truncated tract files and invalid TCK headers, honor TCK data offsets, and report allocation failures without corrupting WebAssembly memory. Add native, browser, and offline regression checks.
- Updated dependencies [c8a0be2]
- Updated dependencies
  - @neurodesk/nii2tvx@0.1.20260923
