# @neurodesk/calmar

## 0.6.20261010

### Minor Changes

- c6e4804: Add a portable CALMAR CPU command line that shares preparation and reviewed-lesion mapping with the browser. Include immutable offline models and both connectivity packs, explicit candidate review, strict grid guards, and independent browser/scientific archive validation.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
- Reuse the shared NIfTI-1 reader in the CALMAR command line. Honour both byte orders and disable intercept scaling when the slope is zero; preserve source byte order in derived images.
- Updated dependencies
  - @neurodesk/webapp-components@0.12.1
