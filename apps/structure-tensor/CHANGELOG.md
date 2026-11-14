# structure-tensor

## 0.1.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
  - @neurodesk/webapp-components@0.28.0

## 0.1.20261111

### Patch Changes

- a73f0ae: Every hosted app page names its home page as canonical, so search engines index one page for an app that several catalogues serve. A copy keeps its own share link (`og:url`). When a catalogue's search finds no app of its own, its landing page lists the matching apps of other catalogues, each linking to the host that serves it.
- a811ddf: Read the app version from package.json, so the config always reports the released version.
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
- 0745d63: Also served from the new Preclinical Webapps catalogue (preclinicalapps.sciget.org). dcm2niix, DICOM View, dicompare, MRI2vid, niimath, ANTs Denoise and elastix are also served from mskapps.sciget.org, where DICOM View hands off to MuscleMap, SeedSeg and Carotid Flow again; niimath and MRI2vid are also served from microscopyapps.sciget.org. QSMbly serves its deep-learning WebAssembly gzipped (6.5 MB instead of 24.8 MB) and inflates it in the browser.

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.1.20261108

### Minor Changes

- 6102c59: Add Structure Tensor, a fibre orientation app for microscopy using the OrientationJ method. It takes a 2D image or a 3D stack (TIFF, NIfTI, PNG, JPEG, or 2D slices) and computes Gaussian-derivative structure-tensor maps in the browser: orientation, coherency and energy, OrientationJ's HSB colour survey, an orientation distribution CSV and a dominant-direction summary. In 3D it also gives the fibre azimuth and elevation, a fibre coherency and an RGB direction map, with the fibre vectors as NIfTI. On the SHG collagen example the maps equal a scipy.ndimage reference to 1e-13°, and synthetic gratings and cylinder lattices give their true angles within 0.01°. The shared file-io gains `createRgb24Nifti` for colour NIfTI images.

  `@neurodesk/webapp-components/file-io/tiff` can inspect a Blob or File range by range (only its page directories and description are read), read RGB pages as the mean of red, green and blue with `rgb: 'mean'`, reports `samplesPerPixel`, and writes RGB pages with `rgb: true`. Structure Tensor reads and writes TIFF through it.

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
