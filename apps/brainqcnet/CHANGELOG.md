# brainqcnet

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
