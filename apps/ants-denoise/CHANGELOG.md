# ants-denoise

## 0.1.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
- Updated dependencies [9312d3a]
  - @neurodesk/webapp-components@0.28.0
  - @neurodesk/runtime-support@0.9.26

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
  - @neurodesk/runtime-support@0.9.25

## 0.1.20261110

### Patch Changes

- 3877250: The musculoskeletal and microscopy catalogues are now titled "MSK Webapps" and "Microscopy Webapps", without "SciGet". The page title and the app bar's "More … web apps" link follow; the SciGet logo and hub link stay.
- 0745d63: Also served from the new Preclinical Webapps catalogue (preclinicalapps.sciget.org). dcm2niix, DICOM View, dicompare, MRI2vid, niimath, ANTs Denoise and elastix are also served from mskapps.sciget.org, where DICOM View hands off to MuscleMap, SeedSeg and Carotid Flow again; niimath and MRI2vid are also served from microscopyapps.sciget.org. QSMbly serves its deep-learning WebAssembly gzipped (6.5 MB instead of 24.8 MB) and inflates it in the browser.

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0
  - @neurodesk/runtime-support@0.9.24

## 0.1.20261108

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
  - @neurodesk/runtime-support@0.9.23

## 0.1.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0
  - @neurodesk/runtime-support@0.9.22

## 0.1.20261103

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
  - @neurodesk/runtime-support@0.9.21
- Updated dependencies [8e9346d]
- Updated dependencies [239dedd]
  - @neurodesk/webapp-components@0.22.4
  - @neurodesk/runtime-support@0.9.20

## 0.1.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/webapp-components@0.22.3

## 0.1.20261029

### Minor Changes

- 503a02e: Add ANTs DenoiseImage, a standalone app for the adaptive non-local means filter that BISON runs. It denoises one 3D MRI volume in the browser with `@neurodesk/ants-denoise`, with the Gaussian or Rician noise model, an optional mask and the patch and search radii, and downloads the float32 result on the input grid. On the MS FLAIR example its voxels equal native ANTs 2.6.5 DenoiseImage run with one thread and the same options; the run report gives that native command.
