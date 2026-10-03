# carotid-flow

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
