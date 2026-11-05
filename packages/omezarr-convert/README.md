# @neurodesk/omezarr-convert

Convert microscopy images to multiscale OME-Zarr: OME-NGFF 0.5 in Zarr v3, or 0.4 in Zarr v2.
The OME-Zarr Converter app (`apps/omezarr-convert`) runs it in the browser; everything also
runs in Node (22+).

```js
import { openSource, writeOmeZarr, zipStore, archiveName } from "@neurodesk/omezarr-convert";

const source = await openSource(files);               // File[]: TIFF, OME-TIFF, PNG/JPEG/TIFF sequence, NIfTI
const store = new Map();
await writeOmeZarr(source, { set: (key, bytes) => store.set(key, bytes) }, { version: "0.5", method: "mean" });
const archive = zipStore(store, "0.5");                // RFC-9 .ozx; 0.4 gives a stored .zip
```

## What it writes

- A 5D image, axes `t, c, z, y, x` (as bioformats2raw writes them), at the store root.
- Level 0 holds the source pixels unchanged. Each further level halves Y and X, rounding
  down and never below 1, while the larger of the two exceeds the target (the chunk size by
  default). Z, C and T keep their size.
- `mean` averages each 2 × 2 block (2 × 1 or 1 × 2 when a side is 1); integers round halves up,
  `floor((sum + n / 2) / n)`; floats keep the float64 mean in their own precision. `nearest`
  keeps the pixel at (2y, 2x), bioformats2raw's SIMPLE scaler.
- Chunks are `(1, 1, 1, min(chunk, Y), min(chunk, X))`, padded with the fill value 0 at the
  edge. 0.4 uses Zarr v2 with `zlib` and `/`-nested keys; 0.5 uses Zarr v3 with `bytes` + `gzip`
  and the default chunk key encoding.
- `coordinateTransformations` is one `scale` per level, Y and X doubling per level. An axis
  gets a `unit` only when the source states one. `omero` holds each channel's label, colour
  and its level-0 range as the window, and `defaultZ` is the middle plane.
- The writer reads one plane at a time, so a folder store never holds more than one plane and
  its smaller copies in memory.

## Readers

| Input | Reader | Metadata kept |
| --- | --- | --- |
| OME-TIFF | fiff on the shared geotiff page reader | T, C, Z, physical sizes and units, channel names and colours, image name |
| ImageJ hyperstack | `openTiffPages` in `@neurodesk/webapp-components/file-io/tiff` | channels, slices, frames, `spacing`, `unit`, X/YResolution, `finterval` |
| Multi-page TIFF | same | pages as Z; a centimetre resolution as the pixel size |
| TIFF, PNG or JPEG sequence | same, fast-png, jpeg-js | files in natural name order as Z; PNG pHYs in metres |
| NIfTI-1 | the shared NIfTI header parser | pixdim with `xyzt_units`; stored values (scl_slope is reported, not applied) |

RGB becomes three channels (Red, Green, Blue); alpha is left out. A greyscale image stored as
RGB (equal samples in the first image) is one channel. Palette images, 1/4/12/24-bit TIFF
samples, OME channels with several samples, multi-file OME-TIFF and vendor formats are refused
with a message. `withMetadata` replaces the file's voxel sizes, unit, channel names or name.

## Deliberate differences from bioformats2raw

- The image is at the store root, not under `0/` with the `bioformats2raw.layout` group and
  `OME/METADATA.ome.xml`; it is the plain image layout ome-zarr-py writes.
- `multiscales[0].type` and `metadata` name this converter's method; bioformats2raw names
  `loci.common.image.SimpleImageScaler`.
- `omero.rdefs.model` is `greyscale` for one channel.
- The default pyramid is `mean`; bioformats2raw's default is SIMPLE (`nearest` here). Its AREA
  scaler is not a 2 × 2 block mean: on the example's level 1, 68,083 of 6,332,480 pixels (2 × 32 ×
  257 × 385) differ from the half-up block mean, by up to 5. Why was not established, so `mean`
  is validated against NumPy rather than against bioformats2raw.
- NIfTI orientation is not carried: OME-NGFF 0.4 and 0.5 have no affine.

## Validation

- `test/writer.test.js`: ten synthetic images (every integer and float type, odd sizes, a
  one-row and a one-column image) through both versions and both methods; each level read
  back by zarrita equals `test/synthetic-reference.json`, the sha256 of NumPy pyramids from
  `validation/synthetic_reference.py`, an independent implementation of the rules above. All
  40 conversions pass the vendored strict image schemas (`schemas/`, `validation/checks.mjs`).
- `validation/example-reference.json` records bioformats2raw 0.14.0 (Bio-Formats 9.0.0-rc2)
  on the app's example, read by zarr-python 3.4.2 (`validation/record_reference.py`):
  `--downsample-type=SIMPLE -w 256 -h 256 --target-min-size=256`, `-c zlib` for 0.4 and
  `-c gzip` for 0.5, run in the `eclipse-temurin:21-jre` image, plus the NumPy mean pyramid.
  `node validation/check-example.mjs` converts the example with each version and method, zips
  and unzips it, and requires level 0 to equal the source, the `nearest` levels to equal
  bioformats2raw's byte for byte, the `mean` levels to equal NumPy's, the chunk shapes to equal
  bioformats2raw's, and the axes, scales, image name, channel colours, labels and windows and
  `defaultZ` to equal its metadata. All four pass; the browser tests run the same check on the
  app's downloads.
- `validation/read_with_ome_zarr.py`: ome-zarr-py 0.21.0 detects 0.4 and 0.5 and reads every
  level with the reference pixels.
- `test/sources.test.js`: every reader on fixtures written by tifffile 2026.10.15 and Pillow
  (`test/fixtures/make_fixtures.py`, `packages/components/test/fixtures/tiff/make_fixtures.py`),
  pixel values recomputed from the generator's formula.
