---
"omezarr-convert": minor
"@neurodesk/webapp-components": minor
---

Add OME-Zarr Converter, which converts a microscopy TIFF, OME-TIFF, ImageJ hyperstack, TIFF/PNG/JPEG sequence or NIfTI image to a multiscale OME-Zarr in the browser: OME-NGFF 0.5 (Zarr v3, an RFC-9 .ozx archive) or 0.4 (Zarr v2), or straight into a folder. It keeps each axis's voxel size and unit, the channels and their names and colours, and builds a mean or nearest XY pyramid. On the OME retina example the nearest pyramid equals bioformats2raw 0.14.0's byte for byte with the same chunks, axes, scales and channel windows, the mean pyramid equals NumPy's, and both versions pass the OME-NGFF strict image schemas. `@neurodesk/webapp-components/file-io/tiff` gains `openTiffPages`, a page-at-a-time reader that keeps RGB samples apart, skips reduced-resolution pages and hands OME-TIFF to fiff, and its OME attribute parser reads single-quoted attributes and character references.
