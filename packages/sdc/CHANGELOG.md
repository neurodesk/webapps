# @neurodesk/sdc

## 0.3.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
  - @neurodesk/runtime-support@0.9.19

## 0.3.20261029

## 0.3.20261027

### Patch Changes

- @neurodesk/runtime-support@0.9.18
- @neurodesk/runtime-support@0.9.17

## 0.3.20261025

### Minor Changes

- 4bc35f7: Run the PyHySCO Gauss-Newton evaluations and the preconditioned CG solves on WebGPU when the browser has a hardware adapter and JSPI. The CPU path stays the fallback. On ds005134 sub-01 the WebGPU field agrees with the native PyHySCO field to a median of 1.9e-5 Hz in the brain (#506).

  Keep the hardware-adapter fallback check consistent with the WebGPU API, record the actual backend and any GPU failure in saved provenance, and run the native-field browser gate on hardware CI.

### Patch Changes

- Updated dependencies [74b9c63]
  - @neurodesk/runtime-support@0.9.16

## 0.2.20261025

## 0.2.20261024

### Patch Changes

- Add a separately licensed SyN-SDC field-fitting entry point shared by native Rust and WebAssembly. Convert PE displacements to Hz and fit the sdcflows cubic B-spline grid with deterministic reference arithmetic. Require full-brain native coefficient and field parity in CI and verify committed WASM rebuilds byte for byte.

## 0.2.20261022

## 0.2.20261020

### Minor Changes

- b7612b4: SDC is a new app that estimates the susceptibility field of an EPI acquisition from two b = 0 images with opposite phase-encoding directions, such as AP and PA, in the browser. Drop the pair with its JSON sidecars (and a DWI series' bval), as NIfTI or DICOM; the app pairs them by `PhaseEncodingDirection`, averages each input's volumes with b ≤ 50 and runs PyHySCO with its command-line defaults in a Web Worker with a cancel. It writes the field in Hz with FSL topup's sign as `<stem>_fieldmap.nii.gz` with a sidecar (`Units: Hz`), and the two corrected b = 0 means for quality control. The method was chosen in the reverse-PE options document: it was the closest fast method to topup on six subjects.

  `@neurodesk/sdc` holds the WebAssembly build of `exes/sdc`, a GPL-3.0-or-later Rust port of PyHySCO 0.0.4 that also builds the `sdc` command line. On ds005134 sub-01 the port equals a float64 PyHySCO run to 1e-14 from the same start, and the browser's field equals the command line's.

### Patch Changes

- 311cd3f: Reject nonfinite and constant-range images before field estimation. Restore the last committed image when a preview is cancelled, keep inactive output controls inert during work, and pin the published, checksummed example and native reference data.
- 8681691: SDC validates phase encoding and a finite positive TotalReadoutTime for both images, refusing unequal readouts because the current PyHySCO model assumes equal and opposite displacements. The command line keeps its explicit phase-direction flags and common --trt override. BIDS input uses the shared reader's IntendedFor associations to select one AP/PA fieldmap pair or a DWI with its reverse fieldmap, and refuses ambiguous pairs and unrelated subjects. Remove the unused app-config version placeholder so release metadata has one source. Keep the app and pipeline package on the same UTC release version.
