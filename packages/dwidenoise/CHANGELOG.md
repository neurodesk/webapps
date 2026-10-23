# @neurodesk/dwidenoise

## 0.2.20261023

## 0.2.20261022

## 0.2.20261020

## 0.2.20261019

## 0.2.20261018

### Minor Changes

- eed5007: Dwidenoise is a new app that denoises diffusion MRI in the browser with Patch2Self (Fadnavis et al. 2020). Load a 4D NIfTI with its bval (and optionally its bvec and sidecar) or a DICOM diffusion series and choose Denoise. Each volume is predicted from the other volumes of its group, b0 (b below 50 s/mm²) or diffusion-weighted, by one regression over all voxels; a single b0 is kept unchanged, and a series with fewer than 2 diffusion-weighted volumes is refused with a clear status. Up to 4 Web Workers add the Gram sums of voxel chunks, the main thread solves each group once, and the workers apply the fit, with progress and a cancel in the status bar. The image downloads as `<stem>_desc-denoised_<suffix>.nii.gz` (float32), with the bval, bvec and sidecar under the same name, so degibbs can read them next.

- e40b401: `@neurodesk/dwidenoise` holds the WebAssembly port of DIPY 1.12.1 Patch2Self version 1 (patch radius 0, ordinary least squares; BSD-3-Clause), built from `exes/dwi/denoise`. Each volume is predicted from the other volumes of its group (b0 or diffusion-weighted) by one regression over all voxels. The data stays in module memory and is denoised in place, and voxel ranges can be split across workers. On the ds005134 slab its output equals DIPY's (with the regressors not centred in place) bit for bit in float32.

### Patch Changes

- e4e1ad9: Refuse non-finite values throughout a diffusion series, including a single b0 volume that is kept unchanged. Use the shared NIfTI header reader when preserving input metadata.

- c288832: Synchronize the denoising app, its pipeline package and its embedded version when applying a release.
