# degibbs

## 0.1.20261020

### Minor Changes

- c5908f7: Degibbs is a new app that removes Gibbs ringing from MRI in the browser. Load a 3D or 4D NIfTI (with its bval and bvec for a DWI) or a DICOM series and choose Remove ringing. Each 2D slice is shifted by subvoxel amounts and, at every sample, the shift with the least local variation is kept (Kellner et al. 2016). The slice plane follows the sidecar's `SliceEncodingDirection` and can be changed. Volumes are corrected in Web Workers with a cancel. The image downloads as `<stem>_desc-degibbs_<suffix>.nii.gz`, with the bval, bvec and sidecar under the same name, so the next app can read them.

  `@neurodesk/degibbs` holds the WebAssembly port of MRtrix3 3.0.8 `mrdegibbs` (MPL-2.0), built from `exes/dwi/degibbs`. On 10 volumes of OpenNeuro ds005577 it equals `mrdegibbs` to 2.3e-14.

  Cancellation remains effective while output files are compressed. Automation includes the acquisition sidecar, each optional gradient is retained independently, derivative names replace an earlier processing description, and DICOM derivative sidecars omit personal metadata. Guidance follows the denoise, degibbs, interpolation order.

### Patch Changes

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
