# OME-Zarr Converter

Convert a microscopy image to multiscale OME-Zarr in the browser: OME-NGFF 0.5 (Zarr v3, one
`.ozx` archive, RFC-9) or 0.4 (Zarr v2, `.ome.zarr.zip`), or straight into a folder through the
File System Access API. The conversion, the readers and their validation are in
[`packages/omezarr-convert`](../../packages/omezarr-convert/README.md); this app is the
interface, the archive or folder, and a NiiVue preview read back from what was written.

## Inputs

TIFF and OME-TIFF (OME-XML through fiff, with or without a namespace prefix), ImageJ
hyperstacks, multi-page TIFF stacks, sequences of single-page TIFF, PNG or JPEG files (one per Z
plane, natural name order) and NIfTI. Files without a voxel size open **Voxel size and
channels**; the sizes, unit and channel names there replace the file's only when changed.

What the reader assumed, changed or left out shows as one line (at most 90 characters) under
the file description, with the full text in its tooltip, the console and the report: only the
first image of a multi-image OME-TIFF, the NIfTI affine dropped, NIfTI intensity scaling
applied, alpha dropped, JPEG decoded (lossy), min-is-white shown inverted.

Not read: CZI, LIF, ND2 and other vendor formats. The JavaScript and WebAssembly readers
evaluated were excluded: Bio-Formats is GPL, libCZI is LGPL-3.0 or commercial, readlif is GPL,
and nd2 is Python only. Convert them with bioformats2raw or export OME-TIFF.

## Output

Each result row has the archive (archive mode) and a JSON conversion report (settings, levels,
the written multiscales and omero metadata, the reader's notes, timing; for the example, its
source and CC BY 4.0 licence). Outputs are named after the input file (`retina-crop.ozx`); the
OME image name stays in `multiscales.name`. The viewer shows the largest level that fits 1024
pixels and 1 GB at t = 0 (C × Z × Y × X), read back from the written store with zarrita, one
NiiVue layer per channel coloured (and inverted) from `omero`; when no level fits, it says the
output is too large to preview. NIfTI is in millimetres, so the preview converts nm and µm; an
axis without a unit is drawn as if its scale were millimetres.

The conversion runs on the page's thread and yields to it at least every 25 ms between
chunks, so the progress bar moves and × cancels mid-conversion.

An archive is assembled in memory: the written chunks in a Map, then fflate's streaming `Zip`
into Blob parts without a second contiguous copy. Before converting, the app computes the
worst case, every padded pyramid chunk uncompressed (`archiveBudget`), and refuses an archive
above 1 GiB (`ARCHIVE_MAX_BYTES`) or above 65 535 files (no ZIP64), offering the folder write
instead; the writer also stops once the store passes 1 GiB. Measured peak at the limit
(Node 24.19, 1 × 1 × 1630 × 512 × 512 uint16 noise, budget 1.00 GiB, store and archive 0.99 GiB):
1.23 GiB resident after writing and 2.19 GiB with the archive Blob, which copies the store
(Chromium may keep large Blobs on disk instead of in the tab).

The folder write holds one plane at a time. A cancelled or failed folder write aborts its open
file and removes the `<stem>.ome.zarr` subfolder it created, so the same folder takes a retry.

## Example

`retina-crop.ome.tif` (1.8 MB, HF `neurodeskorg/webapps` `omezarr-convert/example/`, pinned in
`examples.json`): both channels, z 16–47, y 520–1034, x 640–1410 of the full-resolution level of
the OME Consortium's `sub-resolutions/Z-stack/retina_large.ome.tiff`
(<https://downloads.openmicroscopy.org/images/OME-TIFF/2016-06/sub-resolutions/Z-stack/>),
derived from a Bitplane Imaris sample, written as a zlib-compressed tiled OME-TIFF with its
original physical sizes (0.0229 × 0.0229 × 0.2 µm) and channel colours by tifffile 2025.5.10.
Licence: CC BY 4.0, © OME Consortium.

## Tests

- `pnpm --filter @neurodesk/omezarr-convert test`: readers, pyramid and writer (see the package).
- `pnpm --filter omezarr-convert test`: form logic and the preview NIfTI header in millimetres.
- `pnpm --filter omezarr-convert test:e2e`: the example through 0.5/mean and 0.4/nearest, each
  download unpacked and checked against the bioformats2raw reference and the schemas; edited
  voxel sizes and channel names; a PNG sequence; the folder write (into the origin-private file
  system); a cancelled folder write removing its subfolder, then a retry; cancellation and rerun;
  cancelling a 256 MB NIfTI archive conversion while its progress moves; the multi-image note
  and its tooltip; a failed download and retry; a checksum mismatch; an unsupported file; the
  automation operation. Port 4357.
