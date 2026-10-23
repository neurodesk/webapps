# degibbs

## 0.3.20261023

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/degibbs@0.3.20261023
  - @neurodesk/runtime-support@0.9.9

## 0.3.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/degibbs@0.3.20261022
  - @neurodesk/runtime-support@0.9.8

## 0.3.20261020

### Minor Changes

- 2fadf41: Add a portable `degibbs` command line for Linux, Windows and macOS. It runs the app's `degibbs.wasm` with the `mrdegibbs` options (`--nshifts`, `--min-w`, `--max-w`) and slice axes from the sidecar's `SliceEncodingDirection` (or `--axes`), and writes the app's downloads: the corrected image, the passed-through bval and bvec, and the sidecar. The output names and sidecar now live in `@neurodesk/degibbs/outputs`, shared by the app and the command line. Its release check runs the pinned example and holds every output to the web app's recorded download: the image by its decompressed bytes, the other files byte for byte. `@neurodesk/degibbs` now shares the app's version.

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
  - @neurodesk/degibbs@0.3.20261020
- Updated dependencies [a36fde4]

- Updated dependencies [2fadf41]

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/degibbs@0.3.20261020
  - @neurodesk/runtime-support@0.9.5

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/degibbs@0.3.20261020
  - @neurodesk/runtime-support@0.8.2

- The input size limit moves from dwi2trx to `@neurodesk/webapp-components/file-io/input-limits` (`MAX_INPUT_BYTES`, `InputTooLargeError`, `formatBytes`, `assertInputSize`). It adds `decodedFloat32Bytes`, the size of the Float32 array an image decodes to (voxels × frames × 4), and `assertNiftiDecodedSize`, which refuses a NIfTI above the 2 GB limit from its header alone; `readNiftiHeader` stops gzip streaming after the header when supported. dwi2trx imports the shared module. NODDI and Degibbs refuse a DWI whose decoded image is above the limit before reading it, and the status bar names the size and the limit.

- Updated dependencies [2fadf41]

- Updated dependencies
  - @neurodesk/degibbs@0.3.20261020
  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.8.1

## 0.2.20261020

### Patch Changes

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/degibbs@0.2.20261020

- Updated dependencies [3f1d770]

- Updated dependencies [14b8248]

- Updated dependencies [d9718cd]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/degibbs@0.2.20261020

- 4b40da1: The input size limit moves from dwi2trx to `@neurodesk/webapp-components/file-io/input-limits` (`MAX_INPUT_BYTES`, `InputTooLargeError`, `formatBytes`, `assertInputSize`). It adds `decodedFloat32Bytes`, the size of the Float32 array an image decodes to (voxels × frames × 4), and `assertNiftiDecodedSize`, which refuses a NIfTI above the 2 GB limit from its header alone; `readNiftiHeader` stops gzip streaming after the header when supported. dwi2trx imports the shared module. NODDI and Degibbs refuse a DWI whose decoded image is above the limit before reading it, and the status bar names the size and the limit.

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/degibbs@0.2.20261020

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/degibbs@0.2.20261020
- 4b40da1: The input size limit moves from dwi2trx to `@neurodesk/webapp-components/file-io/input-limits` (`MAX_INPUT_BYTES`, `InputTooLargeError`, `formatBytes`, `assertInputSize`). It adds `decodedFloat32Bytes`, the size of the Float32 array an image decodes to (voxels × frames × 4), and `assertNiftiDecodedSize`, which refuses a NIfTI above the 2 GB limit from its header alone; `readNiftiHeader` stops gzip streaming after the header when supported. dwi2trx imports the shared module. NODDI and Degibbs refuse a DWI whose decoded image is above the limit before reading it, and the status bar names the size and the limit.

- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/degibbs@0.2.20261020
- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/degibbs@0.2.20261020
- 4b40da1: The input size limit moves from dwi2trx to `@neurodesk/webapp-components/file-io/input-limits` (`MAX_INPUT_BYTES`, `InputTooLargeError`, `formatBytes`, `assertInputSize`). It adds `decodedFloat32Bytes`, the size of the Float32 array an image decodes to (voxels × frames × 4), and `assertNiftiDecodedSize`, which refuses a NIfTI above the 2 GB limit from its header alone; `readNiftiHeader` stops gzip streaming after the header when supported. dwi2trx imports the shared module. NODDI and Degibbs refuse a DWI whose decoded image is above the limit before reading it, and the status bar names the size and the limit.

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/degibbs@0.2.20261020

## 0.2.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/degibbs@0.2.20261019

- Updated dependencies [da2584b]
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/degibbs@0.2.20261019

## 0.2.20261018

### Minor Changes

- c8ee6d5: Degibbs is a new app that removes Gibbs ringing from MRI in the browser. Load a 3D or 4D NIfTI (with its bval and bvec for a DWI) or a DICOM series and choose Remove ringing. Each 2D slice is shifted by subvoxel amounts and, at every sample, the shift with the least local variation is kept (Kellner et al. 2016). The slice plane follows the sidecar's `SliceEncodingDirection` and can be changed. Volumes are corrected in Web Workers with a cancel. The image downloads as `<stem>_desc-degibbs_<suffix>.nii.gz`, with the bval, bvec and sidecar under the same name, so the next app can read them.

  `@neurodesk/degibbs` holds the WebAssembly port of MRtrix3 3.0.8 `mrdegibbs` (MPL-2.0), built from `exes/dwi/degibbs`. On 10 volumes of OpenNeuro ds005577 it equals `mrdegibbs` to 2.3e-14.

  Cancellation remains effective while output files are compressed. Automation includes the acquisition sidecar, each optional gradient is retained independently, derivative names replace an earlier processing description, and DICOM derivative sidecars omit personal metadata. Guidance follows the denoise, degibbs, interpolation order.

### Patch Changes

- 7c0d201: Restore the last committed image after cancelled or failed viewer loads. Share queued volume previews across NODDI, Degibbs, N4 and Dwidenoise, retaining source files and calibrated map ranges while rollback finishes before controls unlock.

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/degibbs@0.2.20261018

- Updated dependencies

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/degibbs@0.2.20261018

- Updated dependencies [ea2a6d2]

- Updated dependencies [c8ee6d5]

- Updated dependencies [0511cd7]

- Updated dependencies [a07f659]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/degibbs@0.2.20261018
  - @neurodesk/runtime-support@0.8.0

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/degibbs@0.2.20261018

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/degibbs@0.2.20261018

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/degibbs@0.2.20261018
  - @neurodesk/runtime-support@0.8.0

## 0.1.20261020

### Minor Changes

- c5908f7: Degibbs is a new app that removes Gibbs ringing from MRI in the browser. Load a 3D or 4D NIfTI (with its bval and bvec for a DWI) or a DICOM series and choose Remove ringing. Each 2D slice is shifted by subvoxel amounts and, at every sample, the shift with the least local variation is kept (Kellner et al. 2016). The slice plane follows the sidecar's `SliceEncodingDirection` and can be changed. Volumes are corrected in Web Workers with a cancel. The image downloads as `<stem>_desc-degibbs_<suffix>.nii.gz`, with the bval, bvec and sidecar under the same name, so the next app can read them.

  `@neurodesk/degibbs` holds the WebAssembly port of MRtrix3 3.0.8 `mrdegibbs` (MPL-2.0), built from `exes/dwi/degibbs`. On 10 volumes of OpenNeuro ds005577 it equals `mrdegibbs` to 2.3e-14.

  Cancellation remains effective while output files are compressed. Automation includes the acquisition sidecar, each optional gradient is retained independently, derivative names replace an earlier processing description, and DICOM derivative sidecars omit personal metadata. Guidance follows the denoise, degibbs, interpolation order.

### Patch Changes

- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/runtime-support@0.8.2
- The input size limit moves from dwi2trx to `@neurodesk/webapp-components/file-io/input-limits` (`MAX_INPUT_BYTES`, `InputTooLargeError`, `formatBytes`, `assertInputSize`). It adds `decodedFloat32Bytes`, the size of the Float32 array an image decodes to (voxels × frames × 4), and `assertNiftiDecodedSize`, which refuses a NIfTI above the 2 GB limit from its header alone; `readNiftiHeader` stops gzip streaming after the header when supported. dwi2trx imports the shared module. NODDI and Degibbs refuse a DWI whose decoded image is above the limit before reading it, and the status bar names the size and the limit.

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.8.1

- Updated dependencies [ea2a6d2]

- Updated dependencies [c5908f7]

- Updated dependencies [3f1d770]

- Updated dependencies [14b8248]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [1f4aecd]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

- Updated dependencies [d1fa022]
  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/degibbs@0.2.0
  - @neurodesk/runtime-support@0.8.0
