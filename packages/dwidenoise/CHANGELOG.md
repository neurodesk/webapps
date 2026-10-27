# @neurodesk/dwidenoise

## 0.4.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.1

## 0.4.20261025

## 0.4.20261024

### Minor Changes

- da92d32: Add the `dwidenoise` command line. It runs the web app's Patch2Self (the same `dwidenoise.wasm`, DIPY 1.12.1 version 1 port) on a NIfTI series and writes the app's four downloads. The worker pool (the three passes with one solve per volume), the worker handler, the gzip worker and the output names move to `@neurodesk/dwidenoise` (`./pool`, `./worker`, `./gzip`, `./pipeline`), so the app's Web Workers and the command line's worker threads run the same messages, and the output is the same for any number of threads. Like the app, the command line writes the result straight into the output NIfTI and takes `cal_max` from the workers, and it reads the .bval with the shared `parseBval`. Its release check holds every output to the downloads that the production app records.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1

## 0.3.20261024

### Minor Changes

- da92d32: Add the `dwidenoise` command line. It runs the web app's Patch2Self (the same `dwidenoise.wasm`, DIPY 1.12.1 version 1 port) on a NIfTI series and writes the app's four downloads. The worker pool (the three passes with one solve per volume), the worker handler, the gzip worker and the output names move to `@neurodesk/dwidenoise` (`./pool`, `./worker`, `./gzip`, `./pipeline`), so the app's Web Workers and the command line's worker threads run the same messages, and the output is the same for any number of threads. Like the app, the command line writes the result straight into the output NIfTI and takes `cal_max` from the workers, and it reads the .bval with the shared `parseBval`. Its release check holds every output to the downloads that the production app records.
- 343c256: Dwidenoise solves each Patch2Self volume in a worker. The page no longer runs a group solve, the NIfTI writer or gzip on its own thread, so it stays responsive and the footer × stops a run between two volumes. The status bar shows the Gram, solve and prediction passes, weighted by their cost. The workers write the result straight into the output NIfTI and find its `cal_max`, and a worker compresses the file without a copy. On the full-brain ds005134 DWI (509 MB as Float32), the renderer's peak memory went from about 3040 MB to about 2610 MB and the longest main-thread task from about 15 s to less than 0.5 s (packages/dwidenoise README). The output is the same, bit for bit, on the e2e fixtures, the slab and the full brain. Dwidenoise also refuses a DWI above the shared 2 GB input limit before decoding it.

  `@neurodesk/dwidenoise` adds `solveVolume` (one row of `solve`, from the new `solve_volume` WebAssembly export), `denoiseChunks` (the app's worker schedule in one thread) and `CHUNK_VOXELS`. `solve` and `solveVolume` refuse a group of fewer than 2 volumes with a message that says so. `scripts/check-slab.mjs --app OUTPUT.nii.gz` requires app outputs to equal `denoiseChunks` bit for bit.

  `@neurodesk/webapp-components/file-io` adds `allocateNifti`, the file `createNiftiFromData` writes with a typed view of its voxels to fill in place, so a page that writes a large image holds one copy of it. Its declaration types `ArrayType` as a view constructor (`NiftiViewConstructor`), as the function calls it.

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0

## 0.2.20261024

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
