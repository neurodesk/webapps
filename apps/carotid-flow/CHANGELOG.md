# carotid-flow

## 0.4.20261007

### Minor Changes

- 56a9269: Add the `carotid-flow` command line. It detects both carotids in a NIfTI phase-contrast series, as one combined series or an amplitude and a phase file, and writes the web app's label map, temporal SD and curves CSV byte for byte. Settings are checked against the app's automation schema, raw ±4096 phase without `--venc` is refused, and portable Linux x64, Windows x64 and macOS arm64 archives bundle a private Node runtime. Each archive must match the PCMCalculator example pins before release. The detection code moves from the app into `@neurodesk/carotid-flow`, which the app now imports.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/carotid-flow@0.4.20261007
- 56a9269: Decode unrescaled raw Siemens phase (0–4095, zero velocity at 2048) with the VENC and measure it with the velocity method; it previously went to the variability method with the VENC ignored. Without a VENC such a series still takes the variability method, as before, with a note that it looks like raw phase. A VENC beside an unsigned series that cannot be told apart from a speed image is refused. An amplitude and phase pair whose affine or voxel spacing differ is now refused instead of being combined voxel for voxel.
- Updated dependencies [56a9269]
- Updated dependencies [56a9269]
- Updated dependencies [70f2770]
  - @neurodesk/carotid-flow@0.4.20261007
  - @neurodesk/webapp-components@0.10.2

## 0.3.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
- b0d872e: Correct the detected carotid labels in the viewer. Edit on the Carotid labels row opens the shared mask editor with each carotid in its overlay colour; Apply replaces the downloaded label map, marks the row edited and redraws both carotids from the edited labels. The flow curves, metrics, CSV and automation results still come from the detected vessels, as About now says.
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0

## 0.3.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 0.3.20260930

### Minor Changes

- Update unsigned-phase detection from the revised lab MATLAB script: estimate head tilt, pair vessels in head-aligned coordinates, filter by baseline-relative arterial polarity, and correct signal curves. Add optional search geometry controls and quality-check results while preserving affine-based patient labels and the signed-velocity method.

## 0.2.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2

## 0.2.20260928

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

## 0.1.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0

## 0.1.20260924

### Minor Changes

- 39a9ea5: New app: Carotid Flow finds both carotid arteries in a gated phase-contrast neck slice and plots their flow over the cardiac cycle, with peak, time average and pulsatility index, a CSV of the curves and a NIfTI of the carotid labels. Signed velocity gives flow in ml/min: arteries are told from veins by direction and pulse, and each carotid is the artery carrying most flow on its side; on the open example (PCMCalculator's test data) the right carotid is within 6 % of PCMCalculator's manual measurement. Unsigned speed images go through a port of the requesting lab's MATLAB script, which names left and right from the image orientation where the script called the patient's right carotid the left one. Shared file I/O gains `readNiftiFrames`, which reads every frame of a 4D NIfTI.

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5
