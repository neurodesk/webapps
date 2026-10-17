# @neurodesk/elastix

## 0.4.20261017

### Minor Changes

- Add registered-image OME-TIFF export in the browser and command line using one shared fiff writer. Preserve full-resolution float32 pixels, spacing and stationary input units. Explain when TIFF is unavailable because the pinned writer cannot retain the image origin, direction or unknown units.

## 0.3.20261017

## 0.3.20261016

## 0.3.20261015

## 0.3.20261014

### Minor Changes

- d926b19: Add the `elastix-register` command line: `elastix-register MOVING FIXED OUTPUT_DIR [--method rigid|affine|bspline]` runs the web app's presets in Node with the same ITK-Wasm elastix 2.1.0 pipelines, read from the installed packages rather than a CDN, and writes the web app's downloads: the registered NIfTI, the chained TransformParameters TOML files, the ITK HDF5 transform and the OME-Zarr RFC-5 transform. It reads NIfTI, ITK formats, TIFF/OME-TIFF and OME-Zarr `.ozx`, and accepts elastix parameter files instead of a preset. The presets, float32 cast, parameter-file chain, source handling and transform estimate now live in `@neurodesk/elastix`, which the web app imports. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline; their release check holds every output of every preset to the web app's own downloads of the pinned example. B-spline runs no longer offer the ITK HDF5 transform: transform-io 1.1.0 cannot write a B-spline transform and crashed the tab.
