# spot-detection

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
