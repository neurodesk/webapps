# @neurodesk/n4

## 0.4.20261023

## 0.4.20261022

## 0.3.20261022

## 0.3.20261020

## 0.3.20261019

## 0.2.20261018

### Minor Changes

- 80bd5e9: N4 is a new app that corrects the bias field of MRI in the browser with ANTs N4BiasFieldCorrection. Load a 3D image, or a DWI with its bval and bvec, or a DICOM series, and choose Correct bias field. For a DWI it follows MRtrix `dwibiascorrect ants`: N4 on the mean b0 weighted by the brain mask, the field rescaled to keep the brain's total signal, and every volume divided by it. A 3D image is corrected directly. The mask is one you supply, or an Otsu threshold of the mean b0. N4 runs in a worker with a cancel. The corrected image, the bias field and the mask download with BIDS derivative names, and a bval, bvec and sidecar pass through under the new name.

  `@neurodesk/n4` is ANTs N4BiasFieldCorrection compiled to WebAssembly, separate from `@neurodesk/registration` at the same ANTs commit and ITK-Wasm toolchain. Its bias field on the ds005134 example slab equals native ANTs 2.6.5 exactly.
