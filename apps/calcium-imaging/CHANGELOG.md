# calcium-imaging

## 0.1.20261111

### Patch Changes

- a73f0ae: Every hosted app page names its home page as canonical, so search engines index one page for an app that several catalogues serve. A copy keeps its own share link (`og:url`). When a catalogue's search finds no app of its own, its landing page lists the matching apps of other catalogues, each linking to the host that serves it.
- 65a2e2b: Move the complex FFT (radix-2 with Bluestein for other lengths, in any number of dimensions) to `@neurodesk/webapp-components/fft` and use it from calcium imaging and stitching, replacing their two app copies. Results are unchanged.
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
