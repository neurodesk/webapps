# @neurodesk/n4

## 0.6.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1

## 0.6.20261025

### Patch Changes

- 0813685: Preserve LF line endings in the checksum-pinned N4 factory on Windows checkouts so portable validation uses the exact reviewed module bytes.

## 0.6.20261024

### Minor Changes

- Add the niworkflows EPI-reference N4 argv builder and allow the existing runtime to select it without changing the default MRtrix profile or WASM bytes. This is independent entry-point wiring; the full SyN-SDC accuracy and memory gates remain pending.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.21.1

## 0.5.20261024

### Minor Changes

- 9eef4c7: Add a portable `n4` command line for Linux, Windows and macOS. It runs the app's ANTs N4 WebAssembly module with the `dwibiascorrect ants` options (`-s 4 -b [100,3] -c [1000,0.0]`): it corrects a 3D image directly, and for a DWI it fits the field to the mean b0, rescales it and divides every volume by it. The fit is weighted by a MindGrab brain mask of the mean b0 (or the image) on the CPU, through `@neurodesk/node-drivers/mindgrab`; `--mask FILE` gives another mask. It writes the app's downloads: the corrected image, the bias field, the brain mask, and the passed-through bval, bvec and sidecar. It pairs `<stem>.bval`/`.bvals`, `<stem>.bvec`/`.bvecs` and `<stem>.json` beside the image, and for a series FSL's `bvals` and `bvecs`; a sidecar named with `--json` must hold a JSON object. The b-value rules, output names and sidecar live in `@neurodesk/n4/pipeline` and the mean b0 and mask reader in `@neurodesk/webapp-components`, shared by the app and the command line. Its release check runs the three pinned examples and holds every output to the web app's recorded download: each image by its decompressed bytes, the other files byte for byte.

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
- 9f46059: Create a fresh N4 kernel for each command-line correction and self-check so repeated API calls cannot exhaust the WebAssembly argument stack. Use the shared b-value parser in the app and command line.
- 00005df: `scripts/build.sh --check` rebuilds the N4 WebAssembly module and fails unless `n4-bias.wasm` and `n4-bias.mjs` equal the committed files. The build sets `SOURCE_DATE_EPOCH`, so ANTs' compiled-in build date no longer changes the bytes, and the weekly `n4-wasm-source` workflow runs the check. The committed module is unchanged.
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [5b5ff35]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/node-drivers@0.3.0

## 0.4.20261024

### Patch Changes

- Restore the WebAssembly stack after each kernel call so repeated corrections and transform applications do not exhaust the stack. Export the stack functions from the pinned builds and verify 200 runs on one instance.

## 0.4.20261022

## 0.3.20261022

## 0.3.20261020

## 0.3.20261019

## 0.2.20261018

### Minor Changes

- 80bd5e9: N4 is a new app that corrects the bias field of MRI in the browser with ANTs N4BiasFieldCorrection. Load a 3D image, or a DWI with its bval and bvec, or a DICOM series, and choose Correct bias field. For a DWI it follows MRtrix `dwibiascorrect ants`: N4 on the mean b0 weighted by the brain mask, the field rescaled to keep the brain's total signal, and every volume divided by it. A 3D image is corrected directly. The mask is one you supply, or an Otsu threshold of the mean b0. N4 runs in a worker with a cancel. The corrected image, the bias field and the mask download with BIDS derivative names, and a bval, bvec and sidecar pass through under the new name.

  `@neurodesk/n4` is ANTs N4BiasFieldCorrection compiled to WebAssembly, separate from `@neurodesk/registration` at the same ANTs commit and ITK-Wasm toolchain. Its bias field on the ds005134 example slab equals native ANTs 2.6.5 exactly.
