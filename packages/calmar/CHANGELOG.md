# @neurodesk/calmar

## 0.7.20261018

### Patch Changes

- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]
  - @neurodesk/webapp-components@0.14.4

## 0.7.20261017

### Minor Changes

- dd64cf6: Segment acute stroke lesions on diffusion data. With DWI/TRACE plus ADC or b0, Run analysis seeds the lesion with DeepISLES SEALS (the ISLES'22-winning nnU-Net, fold 0, 59.5 MB) instead of the T1 model; without ADC it is computed from the b0. Without a T1, the b0 or DWI/TRACE is used for brain extraction and registration. A new b0 input sits beside DWI/TRACE and ADC. The benchmark-only NVAUTO candidate is removed.

## 0.6.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.6.20261016

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.6.20261015

### Patch Changes

- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.6.20261014

### Patch Changes

- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.6.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.6.20261010

### Minor Changes

- c6e4804: Add a portable CALMAR CPU command line that shares preparation and reviewed-lesion mapping with the browser. Include immutable offline models and both connectivity packs, explicit candidate review, strict grid guards, and independent browser/scientific archive validation.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
- Reuse the shared NIfTI-1 reader in the CALMAR command line. Honour both byte orders and disable intercept scaling when the slope is zero; preserve source byte order in derived images.
- Updated dependencies
  - @neurodesk/webapp-components@0.12.1
