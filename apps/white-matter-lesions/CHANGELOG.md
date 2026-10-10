# white-matter-lesions

## 0.2.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.2.20261010

## 0.2.20261009

### Patch Changes

- Updated dependencies [bb10737]
- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
- Updated dependencies [64ffefa]
  - @neurodesk/synthstrip@0.1.4
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
  - @neurodesk/white-matter-lesions@0.2.20261009
  - @neurodesk/synthsr@0.6.20261009

## 0.2.20261007

### Minor Changes

- 5ec8fe3: Add the `flames` command line: FLAMeS lesion segmentation on the CPU with ONNX Runtime Node, writing the web app's lesion mask, probability map and lesion table under the same names. It takes the app's `--folds 1|5` and `--skull-stripped` settings, installs SynthStrip and all five folds with SHA-256 checks on every load, and ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer that each bundle Node and the models. Each release must reproduce the web app's lesion count, mask volume and summed probability, as recorded in a browser, on the pinned example with one fold and with the ensemble. With one fold it must also match the web app's WebAssembly pipeline at mask Dice 0.998 or better, with no probability more than 0.1 apart. The pipeline moves into the new `@neurodesk/white-matter-lesions` package, which the web app now uses.

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.3
  - @neurodesk/white-matter-lesions@0.2.20261007
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.2
  - @neurodesk/white-matter-lesions@0.2.20261007
- Updated dependencies [70f2770]
- Updated dependencies [5ec8fe3]
  - @neurodesk/webapp-components@0.10.2
  - @neurodesk/white-matter-lesions@0.2.20261007
  - @neurodesk/synthsr@0.6.20261007

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
