---
"elastix": minor
---

New app: elastix registers a moving image to a stationary image in the browser with `@itk-wasm/elastix`: Rigid, Affine or Affine + B-spline presets built from elastix's default parameter maps, or the user's own elastix parameter files. Inputs are NIfTI, DICOM, any ITK image format, OME-Zarr (`.ozx`, a dropped `.zarr` folder or a URL, read with ngff-zarr) and TIFF or OME-TIFF (a local file or a URL read by range request, through fiff). Downloads are the registered image as NIfTI or OME-Zarr, the ITK HDF5 transform and chained elastix TransformParameters files.
