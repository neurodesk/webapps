# n4

## 0.5.20261024

### Minor Changes

- 941884c: Accept a BIDS folder. A dropped folder gives each DWI run with its bval, bvec and inherited JSON sidecar. When the folder has more than one run, choose the run in the input section. The sidecar goes through to the outputs, as it does for NIfTI input.
- 9eef4c7: Add a portable `n4` command line for Linux, Windows and macOS. It runs the app's ANTs N4 WebAssembly module with the `dwibiascorrect ants` options (`-s 4 -b [100,3] -c [1000,0.0]`): it corrects a 3D image directly, and for a DWI it fits the field to the mean b0, rescales it and divides every volume by it. The fit is weighted by a MindGrab brain mask of the mean b0 (or the image) on the CPU, through `@neurodesk/node-drivers/mindgrab`; `--mask FILE` gives another mask. It writes the app's downloads: the corrected image, the bias field, the brain mask, and the passed-through bval, bvec and sidecar. It pairs `<stem>.bval`/`.bvals`, `<stem>.bvec`/`.bvecs` and `<stem>.json` beside the image, and for a series FSL's `bvals` and `bvecs`; a sidecar named with `--json` must hold a JSON object. The b-value rules, output names and sidecar live in `@neurodesk/n4/pipeline` and the mean b0 and mask reader in `@neurodesk/webapp-components`, shared by the app and the command line. Its release check runs the three pinned examples and holds every output to the web app's recorded download: each image by its decompressed bytes, the other files byte for byte.

### Patch Changes

- Updated dependencies [bd5f3a8]
  - @neurodesk/webapp-components@0.22.0
  - @neurodesk/n4@0.5.20261024
  - @neurodesk/runtime-support@0.9.12
- a028e96: Add `@neurodesk/webapp-components/file-io/bids-derivatives`: one module for the BIDS-derivative names (`splitName`, `sourceStem`, `outputNames(fileName, desc)`, `maskName`), the derivative sidecar (`derivativeSidecar(sidecar, description)`, `sidecarText`) and `gzipFile` of the DWI apps. degibbs, dwidenoise, n4, noddi and hmc use it in place of their own copies. Every output name and every file byte stays the same.
- 650ce5f: Share the DWI apps' input helpers. `@neurodesk/webapp-components/file-io/brain-mask` reads a user's brain mask (`readBrainMask`: decode, same grid as the image, one 3D volume, binarised) for noddi, n4 and the noddi command line, and `@neurodesk/webapp-components/volume/mean` holds `meanVolumes`. `@neurodesk/dwi2trx/gradients` adds `parseBval` (the bval half of `parseBvalBvec`, with an optional volume-count check), `B0_THRESHOLD`, `isB0` and `b0Volumes` (b < 50 s/mm², the rule of the `exes/dwi/gradients` crate, which a shared test case file now checks on both sides). dwidenoise and n4 parse their b-values with it, and dwidenoise's own `parseBvals` is removed. Outputs are unchanged; some bval error messages now use the shared wording.
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [9f46059]
- Updated dependencies [9eef4c7]
- Updated dependencies [00005df]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/n4@0.5.20261024
  - @neurodesk/runtime-support@0.9.11

## 0.4.20261024

### Patch Changes

- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/dwi2trx@0.6.20261024
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/n4@0.4.20261024
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/dwi2trx@0.6.20261024
  - @neurodesk/runtime-support@0.9.9
  - @neurodesk/n4@0.4.20261024

## 0.4.20261022

### Minor Changes

- 88883f8: A T1-weighted head example, and an Input image row in the results so the viewer can show the scan before correction.

  Select the corrected image by its label in the desktop workflow so adding the input row preserves output validation.

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/dwi2trx@0.6.20261022
  - @neurodesk/runtime-support@0.9.8
  - @neurodesk/n4@0.4.20261022

## 0.3.20261022

### Patch Changes

- Add the ds005134 sub-01 multi-shell slab (CC0, 137 volumes, with its acquisition sidecar) as the first example. It is the data of the N4 parity check against native ANTs. The single-shell DWI stays as the second example.
  - @neurodesk/n4@0.3.20261022

## 0.3.20261020

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
  - @neurodesk/dwi2trx@0.6.20261020
  - @neurodesk/n4@0.3.20261020
- @neurodesk/dwi2trx@0.6.20261020

- @neurodesk/n4@0.3.20261020

- Updated dependencies [a36fde4]

- Updated dependencies [ccea86e]

- Updated dependencies [d0df450]

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/dwi2trx@0.6.20261020
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/n4@0.3.20261020

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/n4@0.3.20261020

- Updated dependencies [3f1d770]

- Updated dependencies [14b8248]

- Updated dependencies [d9718cd]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/n4@0.3.20261020

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/n4@0.3.20261020

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/n4@0.3.20261020
- Updated dependencies [14db080]

- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/n4@0.3.20261020
- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/n4@0.3.20261020
- Updated dependencies [14db080]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/n4@0.3.20261020

## 0.3.20261019

### Minor Changes

- f971bac: N4 now weights the bias-field fit by a MindGrab brain mask of the mean b0, or of the image when it is 3D, instead of an Otsu threshold. A mask you supply on the image grid still replaces it. The provenance records the MindGrab version and backend, and About credits MindGrab and Brainchop.

  Keep elapsed time across extraction and fitting, declare the scoped MindGrab runtime and optional GPU support, and correct the MindGrab citation authors in the shared catalog.

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/dwi2trx@0.5.20261019
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/n4@0.3.20261019

- Updated dependencies [da2584b]

  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/dwi2trx@0.5.20261019
  - @neurodesk/n4@0.3.20261019

- @neurodesk/n4@0.3.20261019

- Updated dependencies [da2584b]
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/dwi2trx@0.5.20261019
  - @neurodesk/n4@0.3.20261019

## 0.2.20261018

### Minor Changes

- 80bd5e9: N4 is a new app that corrects the bias field of MRI in the browser with ANTs N4BiasFieldCorrection. Load a 3D image, or a DWI with its bval and bvec, or a DICOM series, and choose Correct bias field. For a DWI it follows MRtrix `dwibiascorrect ants`: N4 on the mean b0 weighted by the brain mask, the field rescaled to keep the brain's total signal, and every volume divided by it. A 3D image is corrected directly. The mask is one you supply, or an Otsu threshold of the mean b0. N4 runs in a worker with a cancel. The corrected image, the bias field and the mask download with BIDS derivative names, and a bval, bvec and sidecar pass through under the new name.

  `@neurodesk/n4` is ANTs N4BiasFieldCorrection compiled to WebAssembly, separate from `@neurodesk/registration` at the same ANTs commit and ITK-Wasm toolchain. Its bias field on the ds005134 example slab equals native ANTs 2.6.5 exactly.

### Patch Changes

- 7c0d201: Restore the last committed image after cancelled or failed viewer loads. Share queued volume previews across NODDI, Degibbs, N4 and Dwidenoise, retaining source files and calibrated map ranges while rollback finishes before controls unlock.

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/dwi2trx@0.5.20261018
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/n4@0.2.20261018

- Updated dependencies

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/dwi2trx@0.5.20261018
  - @neurodesk/n4@0.2.20261018

- 4e3015f: Keep cancellation effective during mask import and output compression, and publish downloads only after processing and viewing finish. Preserve independently supplied gradient files, reject invalid b-values and multi-volume masks, replace existing BIDS description entities, report loaded files to the shared input controls, and anonymize converted DICOM sidecars.

  Register NODDI, Degibbs and N4 with the release tool so their apps, scientific packages and embedded version strings receive matching date versions. Their shared Rust diffusion workspace retains its own internal version.

- Updated dependencies [ea2a6d2]

- Updated dependencies [80bd5e9]

- Updated dependencies [0511cd7]

- Updated dependencies [a07f659]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/n4@0.2.20261018
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/dwi2trx@0.5.20261018

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/dwi2trx@0.5.20261018
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/n4@0.2.20261018

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/dwi2trx@0.5.20261018
  - @neurodesk/n4@0.2.20261018

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/n4@0.2.20261018
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/dwi2trx@0.5.20261018
