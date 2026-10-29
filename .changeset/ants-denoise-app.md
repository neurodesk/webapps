---
"ants-denoise": minor
---

Add ANTs DenoiseImage, a standalone app for the adaptive non-local means filter that BISON runs. It denoises one 3D MRI volume in the browser with `@neurodesk/ants-denoise`, with the Gaussian or Rician noise model, an optional mask and the patch and search radii, and downloads the float32 result on the input grid. On the MS FLAIR example its voxels equal native ANTs 2.6.5 DenoiseImage run with one thread and the same options; the run report gives that native command.
