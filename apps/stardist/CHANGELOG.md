# stardist

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.1.20261108

### Minor Changes

- b239d4a: Add StarDist, a new app that segments cell nuclei in 2D fluorescence microscopy with StarDist's pretrained `2D_versatile_fluo` model. It reads TIFF, OME-TIFF and PNG images (one chosen channel), runs the model with ONNX Runtime Web on the CPU in overlapping tiles, and ports StarDist's non-maximum suppression and label drawing. It downloads a label TIFF and a per-nucleus CSV table (centroid, area, mean intensity, probability) and shows the labels filled or as outlines. On the DSB 2018 example its 118 nuclei equal Python StarDist 0.9.1's pixel for pixel.

### Patch Changes

- d02feb7: StarDist and ZARRo move to the SciGet Microscopy catalogue at https://microscopyapps.sciget.org/. Links to their old addresses on webapps.neurodesk.org redirect there with the rest of the path, the query and the fragment. Their app bar, page title and privacy text name SciGet.

  elastix is now also served at https://microscopyapps.sciget.org/elastix/, under the SciGet brand. It stays at https://webapps.neurodesk.org/elastix/ as well.

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
