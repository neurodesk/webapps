# stitching

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.1.20261108

### Minor Changes

- 8327887: Add Tile stitching, a browser app that stitches overlapping 2D or 3D microscopy tiles (TIFF or OME-TIFF) from a grid layout, a Fiji TileConfiguration file or OME stage positions. Pairs are registered by phase correlation with cross-correlation checks of the strongest peaks (after Preibisch et al. 2009), positions are optimised by weighted least squares with outlier rejection, and the tiles are fused with linear blending into TIFF and zipped OME-Zarr, with Fiji's TileConfiguration.registered.txt. On the NIST MIST example every tile is within 0.31 px of Fiji's Grid/Collection stitching.

  `@neurodesk/webapp-components/file-io/tiff` now reads OME stage positions (`stagePosition`, micrometres, from the first image's first plane (TheZ = TheC = TheT = 0); null otherwise; always present).

  Compute Pearson correlation with stable incremental covariance so high-offset uint32 and float64 tiles retain correct matching scores.

  Reject source tile selections over the input budget before reading, check cancellation between file reads, and escape CSV fields so punctuation in filenames preserves report columns.

  Refresh the registered-position text reference after stable correlation changes its final floating-point digits; the example's fused TIFF and recorded Fiji accuracy comparison are unchanged.

  Require compatible tile calibration for translation-only stitching, allowing one part per million of metadata rounding, and convert relative stage displacement with a shared pixel size so absolute stage origins cannot distort placement.

  Share checksum-pinned Blosc and Zstd codec chunks in the composite runtime store to keep the catalogue within its duplicate-content budget. Standalone bundles retain their codecs.

  Resolve Vite preload-table paths from the app base when projecting catalogue sites so shared codecs are included alongside ordinary module imports.

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
