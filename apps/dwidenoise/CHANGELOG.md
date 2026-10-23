# dwidenoise

## 0.2.20261023

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/runtime-support@0.9.9
  - @neurodesk/dwidenoise@0.2.20261023

## 0.2.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/runtime-support@0.9.8
  - @neurodesk/dwidenoise@0.2.20261022
- Add the ds005134 sub-01 multi-shell slab (CC0, 137 volumes, with its acquisition sidecar) as the first example. It is the data of the Patch2Self check against DIPY. The single-shell DWI stays as the second example.
  - @neurodesk/dwidenoise@0.2.20261022

## 0.2.20261020

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
  - @neurodesk/dwidenoise@0.2.20261020
- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/dwidenoise@0.2.20261020

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/dwidenoise@0.2.20261020

- Updated dependencies [3f1d770]

- Updated dependencies [14b8248]

- Updated dependencies [d9718cd]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/dwidenoise@0.2.20261020

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/dwidenoise@0.2.20261020

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/dwidenoise@0.2.20261020
- Updated dependencies [14db080]

- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/dwidenoise@0.2.20261020
- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/dwidenoise@0.2.20261020
- Updated dependencies [14db080]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/dwidenoise@0.2.20261020

## 0.2.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/dwidenoise@0.2.20261019

- Updated dependencies [da2584b]
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/dwidenoise@0.2.20261019

## 0.2.20261018

### Minor Changes

- eed5007: Dwidenoise is a new app that denoises diffusion MRI in the browser with Patch2Self (Fadnavis et al. 2020). Load a 4D NIfTI with its bval (and optionally its bvec and sidecar) or a DICOM diffusion series and choose Denoise. Each volume is predicted from the other volumes of its group, b0 (b below 50 s/mm²) or diffusion-weighted, by one regression over all voxels; a single b0 is kept unchanged, and a series with fewer than 2 diffusion-weighted volumes is refused with a clear status. Up to 4 Web Workers add the Gram sums of voxel chunks, the main thread solves each group once, and the workers apply the fit, with progress and a cancel in the status bar. The image downloads as `<stem>_desc-denoised_<suffix>.nii.gz` (float32), with the bval, bvec and sidecar under the same name, so degibbs can read them next.

### Patch Changes

- e4801aa: Restore the previous image when an input or denoised preview is cancelled or fails, before another operation can start. Keep result viewing in the same ordered display workflow.

- 7c0d201: Restore the last committed image after cancelled or failed viewer loads. Share queued volume previews across NODDI, Degibbs, N4 and Dwidenoise, retaining source files and calibrated map ranges while rollback finishes before controls unlock.

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/dwidenoise@0.2.20261018

- e4e1ad9: Refuse non-finite values throughout a diffusion series, including a single b0 volume that is kept unchanged. Use the shared NIfTI header reader when preserving input metadata.

- c288832: Synchronize the denoising app, its pipeline package and its embedded version when applying a release.

- Updated dependencies [eed5007]

- Updated dependencies [e40b401]

- Updated dependencies [e4e1ad9]

- Updated dependencies [c288832]

  - @neurodesk/dwidenoise@0.2.20261018

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/dwidenoise@0.2.20261018

- Updated dependencies [c288832]

  - @neurodesk/dwidenoise@0.2.20261018
