# Tile stitching

Stitches a mosaic of overlapping 2D or 3D microscopy tiles into one image in the browser, on the
CPU in module workers. Inputs are greyscale TIFF or OME-TIFF tiles, one tile per file (a 3D tile
is a z stack), read with the shared `@neurodesk/webapp-components/file-io/tiff`.

## Method

Written from Preibisch, Saalfeld & Tomancak (2009), *Globally optimal stitching of tiled 3D
microscopic image acquisitions*, Bioinformatics 25:1463. Fiji's Stitching plugin and BigStitcher
are GPL-2.0; neither was read or copied, and Fiji ran only as an external reference in Docker.

1. **Approximate layout** (`src/core/tile-layout.js`): a regular grid in natural file-name order
   (row by row, column by column or snake, from any corner; the step is the tile size times
   (1 − overlap), truncated as Fiji writes it), a Fiji `TileConfiguration.txt`, or the OME
   `Plane` `PositionX/Y(/Z)` divided by the pixel size. Every pair that overlaps under the layout
   is registered, diagonal neighbours included.
2. **Pairwise registration** (`src/core/pairwise.js`): both tiles are cut to the region they
   share under the layout, mean-subtracted, mirrored and faded to zero into a power-of-two FFT
   frame. The phase correlation's 5 strongest peaks each give 2^d candidate shifts (the
   correlation is periodic); a candidate must keep 25 % of the region per axis, and the one
   with the highest Pearson correlation wins. It is moved uphill in cross-correlation to its
   integer maximum and refined by a parabola through the correlation along each axis.
3. **Global optimisation** (`src/core/global.js`): weighted least squares of translations
   (weight = r × overlapping pixels), the first tile fixed. Pairs with r < 0.3 are not used;
   after each solve the worst pair is dropped while its residual is above 2.5 × the mean and
   3.5 px (Fiji's defaults). A tile group without usable pairs keeps its layout, moved by the
   main group's mean correction.
4. **Fusion** (`src/core/fusion.js`): linear blending, weight = product over axes of the distance
   to the tile's nearest edge, linear interpolation at sub-pixel positions, in the tiles' sample
   type.

Outputs: the fused image as TIFF (ImageJ description, pixel size kept) and zipped OME-Zarr 0.5
(`.ozx`, ngff-zarr), Fiji's `TileConfiguration.registered.txt`, the pair table (CSV) and
provenance (JSON).

### Deliberate differences from Fiji's Grid/Collection stitching

- Sub-pixel shifts come from the cross-correlation surface, not from the phase correlation
  peak: a fit to the phase-correlation peak was biased by up to a pixel on synthetic pairs with
  partial overlap (measured, `validation/` and `test/pairwise.test.js`).
- Pair weights include the number of overlapping pixels, so a small diagonal overlap cannot pull
  tiles as hard as a full edge. On a synthetic 3 × 2 mosaic a wrong diagonal measurement
  (r = 0.58) moved tiles by 1.4 px with r-only weights and 0.09 px with these.
- A tile without usable pairs keeps its layout position (moved with the rest). Fiji 3.1.8 put
  such tiles at (0, 0) on the sparse Cy5 MIST set.

Not in v1: illumination (flat-field) correction, multi-channel or time-lapse tiles, rotation or
affine models, multi-series files and multi-resolution output.

## Validation

- **Fiji** (`validation/fiji-example.mjs`, `validation/fiji/`): Fiji's Grid/Collection stitching
  (Stitching 3.1.8, `fiji/fiji@sha256:6ca1105d…`, run headless by `validation/fiji/run-fiji.sh`)
  on the example with an 18 % grid. Every pair offset is within 0.73 px of Fiji's and every tile
  position within 0.31 px. `validation/example-reference.json` holds the numbers and the
  SHA-256 of the app's registered configuration and fused TIFF, which the browser test
  reproduces byte for byte.
- **Real image, known offsets** (`validation/synthetic_real.py`, `validation/synthetic-real.mjs`):
  a 3 × 3 mosaic cut from one real example tile with numpy Fourier shifts to known sub-pixel
  positions, independent noise per tile, layout up to 25 px off. Largest error 0.17 px, mean
  0.07 px (`validation/synthetic-real.json`).
- **Analytic mosaics** (`test/`): Gaussian-blob textures rendered exactly at sub-pixel
  positions, 2D and 3D, recovered within 0.5 px (2D 3 × 3 within 0.2 px).

## Example

Rows 1-4, columns 1-4 of NIST MIST's `Small_Phase_Test_Dataset` (phase contrast, 1392 × 1040
uint16, stem cell colonies), losslessly re-compressed, with the TileConfiguration Fiji writes
for an 18 % grid. Source: https://github.com/usnistgov/MIST (Chalfoun et al. 2017, Sci Rep
7:4988). A work of the US Government (NIST), distributed under the NIST notice; acknowledge
NIST as the source. The README beside the files on Hugging Face (`stitching/example/`) records
creators, licence and modifications.
