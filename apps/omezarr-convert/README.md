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

Not read: CZI, LIF, ND2 and other vendor formats. No permissively licensed JavaScript or
WebAssembly reader exists: Bio-Formats is GPL, libCZI is LGPL-3.0 or commercial, readlif is
GPL, and nd2 is Python only. Convert them with bioformats2raw or export OME-TIFF.

## Output

Each result row has the archive (archive mode) and a JSON conversion report (settings, levels,
the written multiscales and omero metadata, timing). The viewer shows the largest level that
fits 1024 pixels, read back from the written store with zarrita, one NiiVue layer per channel
coloured from `omero`. NIfTI is in millimetres, so the preview converts nm and µm; an axis
without a unit is drawn as if its scale were millimetres.

An archive is built in memory, so the app refuses archives of images above 2 GB and offers the
folder write instead, which holds one plane at a time.

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
  system); cancellation and rerun; a failed download and retry; a checksum mismatch; an
  unsupported file; the automation operation.
