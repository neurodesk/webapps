# calcium-imaging

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.1.20261108

### Minor Changes

- fbe693d: Add Calcium imaging, a browser app for two-photon calcium imaging preprocessing. It loads a multi-page or OME-TIFF movie, corrects motion rigidly or piecewise rigidly (NoRMCorre-style patches) with sub-pixel Fourier cross-correlation or phase correlation, computes mean, max and local-correlation images, detects active cells from the correlation image (users can add or remove ROIs at the cursor), extracts neuropil-corrected ΔF/F and deconvolves spikes with OASIS AR(1), all in web workers. On the DANDI 000249 example its rigid shifts equal CaImAn's for every frame given the same template, and its OASIS matches the reference implementation on test traces.

  `@neurodesk/webapp-components/file-io/tiff` reads greyscale TIFF, ImageJ and OME-TIFF stacks with geotiff (refusing multi-sample and palette pages and over-budget stacks before decoding) and writes uncompressed ImageJ-compatible TIFF stacks.

### Patch Changes

- a2cb43f: Calcium imaging and Spot detection join the SciGet Microscopy catalogue at https://microscopyapps.sciget.org/, with StarDist and ZARRo.
- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
