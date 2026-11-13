# microscope-qc

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

- 1edec7e: Add Microscope QC, a browser app for light-microscope quality control with MetroloJ_QC's definitions. PSF from beads detects sub-resolution beads in a z-stack by prominence, fits ImageJ's Gaussian to their x, y and z profiles and reports FWHM per bead and summarised against the theoretical resolution; field illumination reports uniformity, field uniformity, centering accuracy, profiles and iso-intensity zones. Optics and voxel size come from OME-XML when recorded. On the 100 nm bead example the FWHMs equal MetroloJ_QC's own fitter in Fiji to 1e-6, and the field metrics equal ImageJ's GaussianBlur with the formulas restated in Groovy; a unit test pins those formulas to a published MetroloJ_QC field illumination report.

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
