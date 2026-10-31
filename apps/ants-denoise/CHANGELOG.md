# ants-denoise

## 0.1.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/webapp-components@0.22.3

## 0.1.20261029

### Minor Changes

- 503a02e: Add ANTs DenoiseImage, a standalone app for the adaptive non-local means filter that BISON runs. It denoises one 3D MRI volume in the browser with `@neurodesk/ants-denoise`, with the Gaussian or Rician noise model, an optional mask and the patch and search radii, and downloads the float32 result on the input grid. On the MS FLAIR example its voxels equal native ANTs 2.6.5 DenoiseImage run with one thread and the same options; the run report gives that native command.
