# elastix

## 0.5.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.1
  - @neurodesk/elastix@0.5.20261027
  - @neurodesk/runtime-support@0.9.17

## 0.5.20261025

### Patch Changes

- Updated dependencies [74b9c63]
  - @neurodesk/runtime-support@0.9.16
  - @neurodesk/elastix@0.5.20261025
- Updated dependencies [99037b6]
  - @neurodesk/runtime-support@0.9.15
  - @neurodesk/elastix@0.5.20261025

## 0.5.20261024

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
  - @neurodesk/elastix@0.5.20261024
  - @neurodesk/runtime-support@0.9.12
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/elastix@0.5.20261024
  - @neurodesk/runtime-support@0.9.11
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/elastix@0.5.20261024
  - @neurodesk/runtime-support@0.9.10
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/elastix@0.5.20261024
  - @neurodesk/runtime-support@0.9.9
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/elastix@0.5.20261024
  - @neurodesk/runtime-support@0.9.14
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/elastix@0.5.20261024
  - @neurodesk/runtime-support@0.9.13
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/elastix@0.5.20261024
  - @neurodesk/runtime-support@0.9.12
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
  - @neurodesk/elastix@0.5.20261024
  - @neurodesk/runtime-support@0.9.11
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/elastix@0.5.20261024
  - @neurodesk/runtime-support@0.9.10

## 0.5.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/elastix@0.5.20261022
  - @neurodesk/runtime-support@0.9.8

## 0.5.20261020

### Minor Changes

- 3329c39: The registration apps load their images through one shared fixed/moving pair
  (`nd-image-pair`, `createImagePair`). Each app now says fixed and moving, never
  stationary. The fixed card comes first. Each card has explicit "Load fixed
  image…" / "Load moving image…" and "Folder…" pickers, a drop zone, a summary
  of size and spacing, a series select and a clear ×, and Swap exchanges the two.
  Examples fill the slots by role through the same path as a user's file, and a
  failed load keeps the previous image. The fixed card offers built-in templates from
  the new `registry/templates.json`: FSL MNI152 1 mm brain and head and the ICBM152
  avg152 2 mm head, downloaded and checked with `fetchModel`, and cited in each app.
  elastix offers them for 3D images only. SYNcro shows its MNI152 template as a
  locked fixed image, its scan is the moving image, and it fetches the template from
  the catalogue address. Brain extraction in ANTs, Greedy and FireANTs has its own
  Fixed and Moving buttons below the pair.

  Cancelling an example preserves the previous image even when the app supplies
  its own cancellation signal. Image summaries convert NIfTI spatial units to
  millimetres before showing voxel spacing.

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
  - @neurodesk/elastix@0.5.20261020
- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/elastix@0.5.20261020
  - @neurodesk/runtime-support@0.8.2
- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/elastix@0.5.20261020
  - @neurodesk/runtime-support@0.9.5

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/elastix@0.5.20261020
  - @neurodesk/runtime-support@0.9.4

- Updated dependencies [ea2a6d2]

- Updated dependencies [3f1d770]

- Updated dependencies [14b8248]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [1f4aecd]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/elastix@0.5.20261020

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/elastix@0.5.20261020

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/elastix@0.5.20261020
  - @neurodesk/runtime-support@0.9.4

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/elastix@0.5.20261020

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/elastix@0.5.20261020
  - @neurodesk/runtime-support@0.8.1

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/elastix@0.5.20261020
  - @neurodesk/runtime-support@0.8.2

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/elastix@0.5.20261020
- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/elastix@0.5.20261020
- Updated dependencies [14db080]

## 0.5.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/elastix@0.5.20261019
  - @neurodesk/runtime-support@0.9.3

- Updated dependencies [da2584b]
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/elastix@0.5.20261019

## 0.5.20261018

### Minor Changes

- 3329c39: The registration apps load their images through one shared fixed/moving pair
  (`nd-image-pair`, `createImagePair`). Each app now says fixed and moving, never
  stationary. The fixed card comes first. Each card has explicit "Load fixed
  image…" / "Load moving image…" and "Folder…" pickers, a drop zone, a summary
  of size and spacing, a series select and a clear ×, and Swap exchanges the two.
  Examples fill the slots by role through the same path as a user's file, and a
  failed load keeps the previous image. The fixed card offers built-in templates from
  the new `registry/templates.json`: FSL MNI152 1 mm brain and head and the ICBM152
  avg152 2 mm head, downloaded and checked with `fetchModel`, and cited in each app.
  elastix offers them for 3D images only. SYNcro shows its MNI152 template as a
  locked fixed image, its scan is the moving image, and it fetches the template from
  the catalogue address. Brain extraction in ANTs, Greedy and FireANTs has its own
  Fixed and Moving buttons below the pair.

  Cancelling an example preserves the previous image even when the app supplies
  its own cancellation signal. Image summaries convert NIfTI spatial units to
  millimetres before showing voxel spacing.

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/elastix@0.5.20261018
  - @neurodesk/runtime-support@0.9.1

- Updated dependencies

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/elastix@0.5.20261018

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [a07f659]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/elastix@0.5.20261018

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/elastix@0.5.20261018

## 0.4.20261018

### Patch Changes

- Updated dependencies [b67e4e9]

  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/elastix@0.4.20261018

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/elastix@0.4.20261018

- Updated dependencies [67a5a8f]

- Updated dependencies [b8b37d6]

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/elastix@0.4.20261018

- Updated dependencies [67a5a8f]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/elastix@0.4.20261018

- Updated dependencies [b67e4e9]
  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/elastix@0.4.20261018

## 0.4.20261017

### Minor Changes

- Add registered-image OME-TIFF export in the browser and command line using one shared fiff writer. Preserve float32 pixels on the selected registration grid, spacing and stationary input units. Explain when TIFF is unavailable because the pinned writer cannot retain the image origin, direction or unknown units.

### Patch Changes

- d7d3420: Bind OME-TIFF export calibration to the selected Image and its verified local TIFF directories or SubIFDs. Parse original XML with namespace semantics and strict numbers. Preserve valid quoting and character references at TIFF import, refuse unknown explicit units and calibration disagreements, and ignore positions on unselected Images. Keep alternate outputs when TIFF is unsafe. Registration grids with conflicting multi-image metadata remain unchanged and are documented.

  Require a local TiffData element for directory association. Metadata-only Images cannot supply another Image's calibration, even when their plane counts match the file. Preserve mapping defaults for an existing empty TiffData element and verified reduced-resolution SubIFDs.

- Updated dependencies [d7d3420]

  - @neurodesk/elastix@0.4.20261017

- Refuse OME-TIFF export when the selected TIFF Image's original physical sizes are unknown or its Plane positions cannot be preserved. Keep schema-default micrometer units for known sizes and normalize supported length symbols, including pm and Å. Preserve required CLI outputs after optional TIFF encoder or partial-write failures, and cover cancellation during compression.

- Updated dependencies

- Updated dependencies
  - @neurodesk/elastix@0.4.20261017

## 0.3.20261017

### Patch Changes

- Updated dependencies [b0797ba]

  - @neurodesk/elastix@0.3.20261017

- Updated dependencies [b547d52]

  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/elastix@0.3.20261017
  - @neurodesk/runtime-support@0.6.4

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

  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/runtime-support@0.4.1

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
