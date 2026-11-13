# histo2mri

## 0.1.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
  - @neurodesk/webapp-components@0.28.0
  - @neurodesk/greedy@0.9.20261113

## 0.1.20261111

### Minor Changes

- 3beb743: Add Histology to MRI, a browser app that registers 2D histology sections (RGB or greyscale TIFF, PNG or JPEG) to an MRI volume. The user gives the slice axis and an approximate slice; the app samples the MRI on that plane, chooses the section's orientation, registers it rigidly and affinely with Greedy's NMI metric, optionally searches the plane's offset and tilt, and finishes with a Greedy stationary-velocity warp, all in one worker per run. It downloads the section warped onto the MRI plane (RGBA NIfTI), the sections drawn into the MRI grid, and Greedy-compatible affine and warp files in world coordinates, and overlays the result on the MRI with adjustable opacity. On a synthetic test (an MRI slice deformed by a known affine and smooth warp and re-coloured as H&E) the mean landmark error falls from 7.5 mm (12.5 voxels of 0.6 mm) to 0.21 mm (0.35 voxels); on the AHEAD example it falls from 6.8 mm (11.3 voxels) to 1.8 mm (3.0 voxels) at six manual landmarks, where the plane search and warp did not reduce it (the affine alone gives 1.7 mm).

  `@neurodesk/webapp-components/file-io/tiff` gains `readTiffImage`, which reads one greyscale or colour image (RGB with alpha dropped, white-is-zero inverted, palette, YCbCr, CMYK and CIELab converted to RGB) and refuses stacks, channel stacks and over-budget images before decoding. The new `@neurodesk/webapp-components/file-io/raster-image` reads PNG and JPEG sizes from their headers (walking JPEG segments) and decodes them to RGBA without EXIF rotation.

  `@neurodesk/greedy`'s `registerAffineGreedy` and `registerRigidGreedy` take an optional `initial` matrix, and the package exports its single-threaded build as `@neurodesk/greedy/wasm-single` for bundled workers.

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0
  - @neurodesk/greedy@0.9.20261111

## 0.0.20261109

### Patch Changes

- Reject unflagged extra TIFF images and restore the previous viewer when MRI import fails or is cancelled.
