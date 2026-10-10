# elastix

## 0.2.20261010

### Minor Changes

- Advance already released same-day consumers for the shared NIfTI reader fix without reusing immutable release versions.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/runtime-support@0.3.1

## 0.1.20261010

### Patch Changes

- Update the shared runtime-support dependency after moving portable Node drivers into their own dependency-free package.
- Recover OME-Zarr affine transforms with centered, scaled QR and reject invalid or inaccurate coefficients before export. Cancelled TIFF and OME-Zarr reads now stop before display serialization, pass cancellation to supported remote stores, and cannot create a fresh IO worker or delay the next import.

## 0.1.20261009

### Minor Changes

- f975d9c: New app: elastix registers a moving image to a stationary image in the browser with `@itk-wasm/elastix`: Rigid, Affine or Affine + B-spline presets built from elastix's default parameter maps, or the user's own elastix parameter files. Inputs are NIfTI, DICOM, any ITK image format, OME-Zarr (`.ozx`, a dropped `.zarr` folder or a URL, read with ngff-zarr) and TIFF or OME-TIFF (a local file or a URL read by range request, through fiff). Downloads are the registered image as NIfTI or OME-Zarr, the transform as ITK HDF5 or as an OME-Zarr archive (an RFC-5 affine, or a displacement field for B-spline), and chained elastix TransformParameters files in TOML.

  Reject single-slice inputs whose physical plane cannot be represented in 2D. Terminate late registration workers and invalidate pending IO after cancellation; preserve inputs during cancelled replacements. Replace the vulnerable ITK archive extractor with the maintained, patched implementation.
