# @neurodesk/noddi

## 0.4.20261024

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/dwi2trx@0.6.20261024

## 0.4.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/dwi2trx@0.6.20261022
- Add the ds005134 sub-01 multi-shell slab (CC0; 13 b0, b = 500, 1000 and 2000) as the first example, so the example runs the tensor fit and NODDI and writes every map. The single-shell DWI stays as the second example and shows the NODDI refusal. The command line's release check now uses the slab: the browser reference is recorded again on it.

## 0.4.20261020

### Minor Changes

- 5312f0e: NODDI has a portable command line. `noddi DWI BVAL BVEC OUTPUT_DIR` runs the web app's fit in Node: a MindGrab brain mask of the mean b0 on the CPU (`--mask FILE` or `--no-mask` instead), the tensor fit and, with two or more shells, NODDI (AMICO), on worker threads (`--threads N`). The fit, its chunking and its output names move into `@neurodesk/noddi`, which the app imports, so both write the same files. Release archives for Linux x64, Windows x64 and macOS arm64 are checked against the web app's own downloads of the example and a two-shell phantom.

- Keep tensor backend selection in NODDI's shared fitting pipeline. The command line accepts
  `--tensor-fit niimath-dtifit` and uses the same corrected vendored runtime, volume selection,
  map conversion and optional NODDI fit as the browser. Weighted least squares remains the default.

### Patch Changes

- @neurodesk/dwi2trx@0.6.20261020
- @neurodesk/dwi2trx@0.6.20261020

- Updated dependencies [a36fde4]

- Updated dependencies [ccea86e]

- Updated dependencies [d0df450]

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/dwi2trx@0.6.20261020

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/dwi2trx@0.6.20261020

- Updated dependencies
  - @neurodesk/dwi2trx@0.6.20261020

## 0.3.20261020

### Minor Changes

- 5312f0e: NODDI has a portable command line. `noddi DWI BVAL BVEC OUTPUT_DIR` runs the web app's fit in Node: a MindGrab brain mask of the mean b0 on the CPU (`--mask FILE` or `--no-mask` instead), the tensor fit and, with two or more shells, NODDI (AMICO), on worker threads (`--threads N`). The fit, its chunking and its output names move into `@neurodesk/noddi`, which the app imports, so both write the same files. Release archives for Linux x64, Windows x64 and macOS arm64 are checked against the web app's own downloads of the example and a two-shell phantom.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/dwi2trx@0.5.20261020
- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/dwi2trx@0.5.20261020

## 0.3.20261019

## 0.3.20261018

## 0.2.20261018

### Minor Changes

- 0511cd7: NODDI is a new app that fits diffusion tensor and NODDI maps to a DWI in the browser. Load a DWI NIfTI with its bval and bvec, or a DICOM diffusion series, and choose Fit models. The tensor fit (weighted or ordinary least squares, on the b0 volumes and the shells up to b = 1200 s/mm², or the lowest shell when none is that low) gives FA, MD, AD, RD, S0 and the principal direction. With two or more shells, NODDI by AMICO gives ICVF, ISOVF, ODI and the fibre direction; with one shell the app says so and fits the tensor only. The fit uses an Otsu threshold of the mean b0 as the brain mask, or a mask you supply on the DWI grid, and runs in Web Workers with a cancel. Every map downloads with its BIDS diffusion derivative name, for example `sub-01_model-noddi_param-icvf_dwimap.nii.gz`.

  `@neurodesk/noddi` holds the WebAssembly fit, built from the Rust crates in `exes/dwi`. Its NODDI fit is a port of AMICO 1.5.4, the last BSD-licensed release, and agrees with AMICO 1.5.4 to a median of 1e-4 in white matter. It rotates each atom exactly instead of through AMICO's 1° lookup table.

  `readDiffusionSeries` in `@neurodesk/runtime-support/dcm2niix-client` returns each image with its bval, bvec and sidecar, from NIfTI files or a converted DICOM series. FSL's `bvals` and `bvecs` files count as gradients, with or without a stem: the image readers no longer pass them to dcm2niix as DICOM, and a page drop sends them to an app's gradients input.

  `createNiftiFromData` writes a 4D map when `dims` has a fourth entry greater than 1, so a direction map can be saved as three frames.

### Patch Changes

- a07f659: Cancelling NODDI input preparation, mask reading or map compression now prevents late results and permits retry. Mask reading blocks fitting and requires a single 3D mask. Model choices survive replacement imports and examples, including when single-shell data temporarily prevents NODDI. Its AMICO fit uses the shared strict b0 cutoff, so a volume with b = 50 s/mm² remains diffusion weighted rather than entering the mean b0. The committed WebAssembly module includes this correction.

  The shared diffusion reader pairs a single optional bval or bvec with a sole image independently. Supplying FSL `bvals` without `bvecs` now preserves the b-values for workflows that do not need gradient directions.

## 0.2.0

### Minor Changes

- c1a4dda: NODDI is a new app that fits diffusion tensor and NODDI maps to a DWI in the browser. Load a DWI NIfTI with its bval and bvec, or a DICOM diffusion series, and choose Fit models. The tensor fit (weighted or ordinary least squares, on the b0 volumes and the shells up to b = 1200 s/mm², or the lowest shell when none is that low) gives FA, MD, AD, RD, S0 and the principal direction. With two or more shells, NODDI by AMICO gives ICVF, ISOVF, ODI and the fibre direction; with one shell the app says so and fits the tensor only. The fit uses a MindGrab brain mask of the mean b0, or a mask you supply on the DWI grid, and runs in Web Workers with a cancel. Every map downloads with its BIDS diffusion derivative name, for example `sub-01_model-noddi_param-icvf_dwimap.nii.gz`.

  `@neurodesk/noddi` holds the WebAssembly fit, built from the Rust crates in `exes/dwi`. Its NODDI fit is a port of AMICO 1.5.4, the last BSD-licensed release, and agrees with AMICO 1.5.4 to a median of 1e-4 in white matter. It rotates each atom exactly instead of through AMICO's 1° lookup table.

  `readDiffusionSeries` in `@neurodesk/runtime-support/dcm2niix-client` returns each image with its bval, bvec and sidecar, from NIfTI files or a converted DICOM series. FSL's `bvals` and `bvecs` files count as gradients, with or without a stem: the image readers no longer pass them to dcm2niix as DICOM, and a page drop sends them to an app's gradients input.

  `createNiftiFromData` writes a 4D map when `dims` has a fourth entry greater than 1, so a direction map can be saved as three frames.

### Patch Changes

- 1f4aecd: Cancelling NODDI input preparation, mask reading or map compression now prevents late results and permits retry. Mask reading blocks fitting and requires a single 3D mask. Model choices survive replacement imports and examples, including when single-shell data temporarily prevents NODDI. Its AMICO fit uses the shared strict b0 cutoff, so a volume with b = 50 s/mm² remains diffusion weighted rather than entering the mean b0. The committed WebAssembly module includes this correction.

  The shared diffusion reader pairs a single optional bval or bvec with a sole image independently. Supplying FSL `bvals` without `bvecs` now preserves the b-values for workflows that do not need gradient directions.
