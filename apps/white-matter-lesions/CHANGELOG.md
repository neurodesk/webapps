# white-matter-lesions

## 0.1.20261004

### Patch Changes

- Updated dependencies [257192b]
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/synthstrip@0.1.1
  - @neurodesk/runtime-support@0.1.3


### Patch Changes

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
