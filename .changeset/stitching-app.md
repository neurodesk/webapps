---
"stitching": minor
"@neurodesk/webapp-components": minor
---

Add Tile stitching, a browser app that stitches overlapping 2D or 3D microscopy tiles (TIFF or OME-TIFF) from a grid layout, a Fiji TileConfiguration file or OME stage positions. Pairs are registered by phase correlation with cross-correlation checks of the strongest peaks (after Preibisch et al. 2009), positions are optimised by weighted least squares with outlier rejection, and the tiles are fused with linear blending into TIFF and zipped OME-Zarr, with Fiji's TileConfiguration.registered.txt. On the NIST MIST example every tile is within 0.31 px of Fiji's Grid/Collection stitching.

`@neurodesk/webapp-components/file-io/tiff` now reads OME stage positions (`stagePosition`, micrometres, from the first image's first plane (TheZ = TheC = TheT = 0); null otherwise; always present).

Compute Pearson correlation with stable incremental covariance so high-offset uint32 and float64 tiles retain correct matching scores.

Reject source tile selections over the input budget before reading, check cancellation between file reads, and escape CSV fields so punctuation in filenames preserves report columns.
