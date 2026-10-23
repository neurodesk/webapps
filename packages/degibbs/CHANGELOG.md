# @neurodesk/degibbs

## 0.3.20261023

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1

## 0.3.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0

## 0.3.20261020

### Minor Changes

- 2fadf41: Add a portable `degibbs` command line for Linux, Windows and macOS. It runs the app's `degibbs.wasm` with the `mrdegibbs` options (`--nshifts`, `--min-w`, `--max-w`) and slice axes from the sidecar's `SliceEncodingDirection` (or `--axes`), and writes the app's downloads: the corrected image, the passed-through bval and bvec, and the sidecar. The output names and sidecar now live in `@neurodesk/degibbs/outputs`, shared by the app and the command line. Its release check runs the pinned example and holds every output to the web app's recorded download: the image by its decompressed bytes, the other files byte for byte. `@neurodesk/degibbs` now shares the app's version.

### Patch Changes

- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies
  - @neurodesk/webapp-components@0.17.0

## 0.2.20261020

## 0.2.20261019

## 0.2.20261018

### Minor Changes

- c8ee6d5: Degibbs is a new app that removes Gibbs ringing from MRI in the browser. Load a 3D or 4D NIfTI (with its bval and bvec for a DWI) or a DICOM series and choose Remove ringing. Each 2D slice is shifted by subvoxel amounts and, at every sample, the shift with the least local variation is kept (Kellner et al. 2016). The slice plane follows the sidecar's `SliceEncodingDirection` and can be changed. Volumes are corrected in Web Workers with a cancel. The image downloads as `<stem>_desc-degibbs_<suffix>.nii.gz`, with the bval, bvec and sidecar under the same name, so the next app can read them.

  `@neurodesk/degibbs` holds the WebAssembly port of MRtrix3 3.0.8 `mrdegibbs` (MPL-2.0), built from `exes/dwi/degibbs`. On 10 volumes of OpenNeuro ds005577 it equals `mrdegibbs` to 2.3e-14.

  Cancellation remains effective while output files are compressed. Automation includes the acquisition sidecar, each optional gradient is retained independently, derivative names replace an earlier processing description, and DICOM derivative sidecars omit personal metadata. Guidance follows the denoise, degibbs, interpolation order.

## 0.2.0

### Minor Changes

- c5908f7: Degibbs is a new app that removes Gibbs ringing from MRI in the browser. Load a 3D or 4D NIfTI (with its bval and bvec for a DWI) or a DICOM series and choose Remove ringing. Each 2D slice is shifted by subvoxel amounts and, at every sample, the shift with the least local variation is kept (Kellner et al. 2016). The slice plane follows the sidecar's `SliceEncodingDirection` and can be changed. Volumes are corrected in Web Workers with a cancel. The image downloads as `<stem>_desc-degibbs_<suffix>.nii.gz`, with the bval, bvec and sidecar under the same name, so the next app can read them.

  `@neurodesk/degibbs` holds the WebAssembly port of MRtrix3 3.0.8 `mrdegibbs` (MPL-2.0), built from `exes/dwi/degibbs`. On 10 volumes of OpenNeuro ds005577 it equals `mrdegibbs` to 2.3e-14.

  Cancellation remains effective while output files are compressed. Automation includes the acquisition sidecar, each optional gradient is retained independently, derivative names replace an earlier processing description, and DICOM derivative sidecars omit personal metadata. Guidance follows the denoise, degibbs, interpolation order.
