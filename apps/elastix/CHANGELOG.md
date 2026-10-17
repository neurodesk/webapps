# elastix

## 0.3.20261017

### Patch Changes

- Updated dependencies [b0797ba]
  - @neurodesk/elastix@0.3.20261017
- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/elastix@0.3.20261017
  - @neurodesk/runtime-support@0.6.4

## 0.3.20261016

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/elastix@0.3.20261016
- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/elastix@0.3.20261016
  - @neurodesk/runtime-support@0.6.2

## 0.3.20261015

### Patch Changes

- Updated dependencies [c74b26f]
  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/elastix@0.3.20261015
- dd65e6a: Visual refresh: Inter, neutral greys with the Neurodesk logo green for action,
  focus and selection only, a compact 48px app bar, sentence-case section titles
  and a quieter status bar. The example menu is now the input control: examples,
  then Choose files… and Choose folder…. The whole window, the viewer included,
  accepts dropped files; a drop mid-session replaces the inputs with Undo in the
  status bar. Before any input the status reads "Drag and drop files". MuscleMap
  drops its separate drop box and Add File(s) button.

  Page drops fill empty image slots in order while keeping DICOM series together.
  New selections supersede unfinished drop traversal, and registration apps load
  each dropped image in order. The shared drop handler also respects the different
  native input and file-field event contracts.
  Failed imports leave only successfully loaded slots occupied, and Undo can
  restore loaded examples.

- Updated dependencies [0569da8]
- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]
  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/elastix@0.3.20261015

## 0.3.20261014

### Minor Changes

- d926b19: Add the `elastix-register` command line: `elastix-register MOVING FIXED OUTPUT_DIR [--method rigid|affine|bspline]` runs the web app's presets in Node with the same ITK-Wasm elastix 2.1.0 pipelines, read from the installed packages rather than a CDN, and writes the web app's downloads: the registered NIfTI, the chained TransformParameters TOML files, the ITK HDF5 transform and the OME-Zarr RFC-5 transform. It reads NIfTI, ITK formats, TIFF/OME-TIFF and OME-Zarr `.ozx`, and accepts elastix parameter files instead of a preset. The presets, float32 cast, parameter-file chain, source handling and transform estimate now live in `@neurodesk/elastix`, which the web app imports. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline; their release check holds every output of every preset to the web app's own downloads of the pinned example. B-spline runs no longer offer the ITK HDF5 transform: transform-io 1.1.0 cannot write a B-spline transform and crashed the tab.

### Patch Changes

- Updated dependencies [d926b19]
- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]
  - @neurodesk/elastix@0.3.20261014
  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0

## 0.2.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/runtime-support@0.4.3

## 0.2.20261010

### Minor Changes

- Advance already released same-day consumers for the shared NIfTI reader fix without reusing immutable release versions.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
- Updated dependencies
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/runtime-support@0.4.1

## 0.1.20261010

### Patch Changes

- Update the shared runtime-support dependency after moving portable Node drivers into their own dependency-free package.
- Recover OME-Zarr affine transforms with centered, scaled QR and reject invalid or inaccurate coefficients before export. Cancelled TIFF and OME-Zarr reads now stop before display serialization, pass cancellation to supported remote stores, and cannot create a fresh IO worker or delay the next import.

## 0.1.20261009

### Minor Changes

- f975d9c: New app: elastix registers a moving image to a stationary image in the browser with `@itk-wasm/elastix`: Rigid, Affine or Affine + B-spline presets built from elastix's default parameter maps, or the user's own elastix parameter files. Inputs are NIfTI, DICOM, any ITK image format, OME-Zarr (`.ozx`, a dropped `.zarr` folder or a URL, read with ngff-zarr) and TIFF or OME-TIFF (a local file or a URL read by range request, through fiff). Downloads are the registered image as NIfTI or OME-Zarr, the transform as ITK HDF5 or as an OME-Zarr archive (an RFC-5 affine, or a displacement field for B-spline), and chained elastix TransformParameters files in TOML.

  Reject single-slice inputs whose physical plane cannot be represented in 2D. Terminate late registration workers and invalidate pending IO after cancellation; preserve inputs during cancelled replacements. Replace the vulnerable ITK archive extractor with the maintained, patched implementation.
