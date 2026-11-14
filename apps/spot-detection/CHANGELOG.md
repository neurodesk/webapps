# spot-detection

## 0.1.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
  - @neurodesk/webapp-components@0.28.0

## 0.1.20261111

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0

## 0.1.20261110

### Patch Changes

- 3877250: The musculoskeletal and microscopy catalogues are now titled "MSK Webapps" and "Microscopy Webapps", without "SciGet". The page title and the app bar's "More … web apps" link follow; the SciGet logo and hub link stay.

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.1.20261108

### Minor Changes

- 9c0291f: Add Spot detection, a browser port of Big-FISH's smFISH spot detector: LoG filter sized from the voxel size and spot radius, local maxima, the automatic elbow threshold and a Gaussian sub-pixel fit, on one 2D image or 3D TIFF stack or its maximum projection, with optional per-cell counts from a label image. It writes a spots CSV, a NIfTI overlay viewed over the image in NiiVue, and a per-cell counts CSV. On Big-FISH's example stack it finds the same 771 spots at the same automatic threshold (355) as Big-FISH 0.6.2, with a voxel-identical filtered image.

### Patch Changes

- a2cb43f: Calcium imaging and Spot detection join the SciGet Microscopy catalogue at https://microscopyapps.sciget.org/, with StarDist and ZARRo.
- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
