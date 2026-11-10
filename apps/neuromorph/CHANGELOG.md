# neuromorph

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

- 7539ad5: Add NeuroMorph, a browser app for neuron morphology from SWC reconstructions. It reads one or more SWC files or a folder, reports and repairs common SWC faults, draws each neuron as tubes coloured by soma, axon, basal and apical dendrite, and measures total length, branch and terminal points, path and radial distance, branch and Strahler order, bifurcation angles, surface area, volume and the Sholl profile with a configurable step, with CSV downloads. On both NeuroMorpho.Org examples and NeuroM's test morphologies every value agrees with NeuroM 4.0.6 to one part in a million and every Sholl count is identical.

  `writeMz3` takes optional per-vertex RGBA colours, and the example selector offers **Load folder…** for any input marked `data-neurodesk-folder`.

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
