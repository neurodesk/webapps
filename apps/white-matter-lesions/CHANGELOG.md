# white-matter-lesions

## 0.1.20261005

### Patch Changes

- Updated dependencies
  - @neurodesk/synthsr@0.6.20261005

## 0.1.20261004

### Patch Changes

- f12d686: Fall back to the CPU when WebGPU returns blank lesion scores. Some virtual GPUs, including GitHub's macOS runners, complete a WebGPU run but return all zeros, which reported no lesions. Non-finite or constant network output now counts as a WebGPU failure, so the segmentation restarts on WebAssembly.
- Updated dependencies
  - @neurodesk/synthsr@0.6.20261004
- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/synthsr@0.6.20261004
- df84067: Correct the lesion mask in the viewer before downloading it. Edit on the lesion mask row opens the shared editor over the FLAIR with Draw, Erase and Fill tools. Apply replaces the mask in the Output list and recomputes the lesion count, volume and lesion table from the edited mask, marking both rows `(edited)`. Download returns the edited mask under the same name as a uint8 NIfTI. Cancel discards the strokes. Loading a new image or segmenting again closes an open edit. The probability map and the run report remain as the model produced them.
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/synthsr@0.6.20261004
- Updated dependencies [257192b]
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/synthstrip@0.1.1
  - @neurodesk/runtime-support@0.1.3
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/synthsr@0.5.20261004

## 0.1.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0
  - @neurodesk/synthsr@0.5.20261003

## 0.1.20260930

### Patch Changes

- 5909f26: Fix the lesion probability overlay by using NiiVue's supported display-range options. Probabilities below 0.1 stay transparent instead of tinting the entire FLAIR image orange; downloaded probabilities are unchanged. Open Advanced settings by default so skull stripping, model and processing options are immediately visible.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/synthsr@0.5.20260930

### Minor Changes

- Add White matter lesions: FLAMeS lesion segmentation of a single FLAIR image in the browser, after SynthStrip brain extraction, with a lesion mask, probability map and lesion table. Result lists can mark a result as not viewable, which keeps its row and disables View.
- Expose FLAIR lesion segmentation through the shared automation contract, with awaited completion, cancellation, artifacts and model provenance.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/synthsr@0.5.20260930
