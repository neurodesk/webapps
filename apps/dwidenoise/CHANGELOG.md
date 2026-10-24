# dwidenoise

## 0.4.20261024

### Minor Changes

- da92d32: Add the `dwidenoise` command line. It runs the web app's Patch2Self (the same `dwidenoise.wasm`, DIPY 1.12.1 version 1 port) on a NIfTI series and writes the app's four downloads. The worker pool (the three passes with one solve per volume), the worker handler, the gzip worker and the output names move to `@neurodesk/dwidenoise` (`./pool`, `./worker`, `./gzip`, `./pipeline`), so the app's Web Workers and the command line's worker threads run the same messages, and the output is the same for any number of threads. Like the app, the command line writes the result straight into the output NIfTI and takes `cal_max` from the workers, and it reads the .bval with the shared `parseBval`. Its release check holds every output to the downloads that the production app records.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/dwidenoise@0.4.20261024
  - @neurodesk/runtime-support@0.9.14
- Updated dependencies [da92d32]
- Updated dependencies [328cb77]
  - @neurodesk/dwidenoise@0.4.20261024
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/runtime-support@0.9.13

## 0.3.20261024

### Minor Changes

- b3889f9: Accept a BIDS folder. A dropped folder gives each DWI run with its bval, bvec and inherited JSON sidecar. When the folder has more than one run, choose the run in the input section. The sidecar goes through to the outputs, as it does for NIfTI input.
- da92d32: Add the `dwidenoise` command line. It runs the web app's Patch2Self (the same `dwidenoise.wasm`, DIPY 1.12.1 version 1 port) on a NIfTI series and writes the app's four downloads. The worker pool (the three passes with one solve per volume), the worker handler, the gzip worker and the output names move to `@neurodesk/dwidenoise` (`./pool`, `./worker`, `./gzip`, `./pipeline`), so the app's Web Workers and the command line's worker threads run the same messages, and the output is the same for any number of threads. Like the app, the command line writes the result straight into the output NIfTI and takes `cal_max` from the workers, and it reads the .bval with the shared `parseBval`. Its release check holds every output to the downloads that the production app records.

### Patch Changes

- a028e96: Add `@neurodesk/webapp-components/file-io/bids-derivatives`: one module for the BIDS-derivative names (`splitName`, `sourceStem`, `outputNames(fileName, desc)`, `maskName`), the derivative sidecar (`derivativeSidecar(sidecar, description)`, `sidecarText`) and `gzipFile` of the DWI apps. degibbs, dwidenoise, n4, noddi and hmc use it in place of their own copies. Every output name and every file byte stays the same.
- 650ce5f: Share the DWI apps' input helpers. `@neurodesk/webapp-components/file-io/brain-mask` reads a user's brain mask (`readBrainMask`: decode, same grid as the image, one 3D volume, binarised) for noddi, n4 and the noddi command line, and `@neurodesk/webapp-components/volume/mean` holds `meanVolumes`. `@neurodesk/dwi2trx/gradients` adds `parseBval` (the bval half of `parseBvalBvec`, with an optional volume-count check), `B0_THRESHOLD`, `isB0` and `b0Volumes` (b < 50 s/mm², the rule of the `exes/dwi/gradients` crate, which a shared test case file now checks on both sides). dwidenoise and n4 parse their b-values with it, and dwidenoise's own `parseBvals` is removed. Outputs are unchanged; some bval error messages now use the shared wording.
- 343c256: Dwidenoise solves each Patch2Self volume in a worker. The page no longer runs a group solve, the NIfTI writer or gzip on its own thread, so it stays responsive and the footer × stops a run between two volumes. The status bar shows the Gram, solve and prediction passes, weighted by their cost. The workers write the result straight into the output NIfTI and find its `cal_max`, and a worker compresses the file without a copy. On the full-brain ds005134 DWI (509 MB as Float32), the renderer's peak memory went from about 3040 MB to about 2610 MB and the longest main-thread task from about 15 s to less than 0.5 s (packages/dwidenoise README). The output is the same, bit for bit, on the e2e fixtures, the slab and the full brain. Dwidenoise also refuses a DWI above the shared 2 GB input limit before decoding it.

  `@neurodesk/dwidenoise` adds `solveVolume` (one row of `solve`, from the new `solve_volume` WebAssembly export), `denoiseChunks` (the app's worker schedule in one thread) and `CHUNK_VOXELS`. `solve` and `solveVolume` refuse a group of fewer than 2 volumes with a message that says so. `scripts/check-slab.mjs --app OUTPUT.nii.gz` requires app outputs to equal `denoiseChunks` bit for bit.

  `@neurodesk/webapp-components/file-io` adds `allocateNifti`, the file `createNiftiFromData` writes with a typed view of its voxels to fill in place, so a page that writes a large image holds one copy of it. Its declaration types `ArrayType` as a view constructor (`NiftiViewConstructor`), as the function calls it.

- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [da92d32]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/dwidenoise@0.3.20261024
  - @neurodesk/runtime-support@0.9.11
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/dwi2trx@0.7.20261024
  - @neurodesk/dwidenoise@0.3.20261024
  - @neurodesk/runtime-support@0.9.12

## 0.2.20261024

### Patch Changes

- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/dwi2trx@0.6.20261024
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/dwidenoise@0.2.20261024
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/runtime-support@0.9.9
  - @neurodesk/dwidenoise@0.2.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
  - @neurodesk/runtime-support@0.9.11
  - @neurodesk/dwidenoise@0.2.20261024
- Pair acquisition JSON and gradient inputs by automation role so metadata survives diffusion pipelines. Split DWI Correct and SDC inputs into single-image roles, require explicit acquisition values for automated correction, and expose correction settings. Export a corrected mean-b0 image for downstream brain masks. Use a generic single-volume error for shared image readers.
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/dwidenoise@0.2.20261024

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
- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/dwidenoise@0.2.20261020
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

- Updated dependencies [c288832]

  - @neurodesk/dwidenoise@0.2.20261018
