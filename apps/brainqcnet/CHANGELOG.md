# brainqcnet

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0
  - @neurodesk/brainqcnet@0.1.20261109
  - @neurodesk/runtime-support@0.9.24

## 0.1.20261108

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
  - @neurodesk/brainqcnet@0.1.20261108
  - @neurodesk/runtime-support@0.9.23

## 0.1.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0
  - @neurodesk/brainqcnet@0.1.20261104
  - @neurodesk/runtime-support@0.9.22

## 0.1.20261103

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
  - @neurodesk/brainqcnet@0.1.20261103
  - @neurodesk/runtime-support@0.9.21
- Updated dependencies [8e9346d]
- Updated dependencies [239dedd]
  - @neurodesk/webapp-components@0.22.4
  - @neurodesk/brainqcnet@0.1.20261103
  - @neurodesk/runtime-support@0.9.20

## 0.1.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/webapp-components@0.22.3
  - @neurodesk/brainqcnet@0.1.20261031

## 0.1.20261030

### Minor Changes

- d999f9a: Add BrainQCNet, an app that checks a T1-weighted MRI for motion and other artifacts in the browser. It classifies every x, y and z slice with the authors' ResNet152 ProtoPNet through ONNX Runtime Web (WebGPU when available, otherwise WebAssembly), reports whether the image shows artifacts and the share of slices flagged, and downloads the BIDS app's table.csv, tot_df.csv and per-axis local results with a map of the flagged slices. The method and the number of areas per axis are the BIDS app's `--pred_method` and `--n_areas`. On the two MR-ART examples, a still scan and one with deliberate head motion, the tables equal those of the original `garciaml/brainqcnetcpu` container byte for byte, apart from the processing time.

### Patch Changes

- Separate image, method and verdict messages in the Analysis log from model, backend and timing diagnostics in the Technical log. Clearing one log preserves the other.
