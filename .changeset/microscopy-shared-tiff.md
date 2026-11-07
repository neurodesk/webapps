---
"@neurodesk/webapp-components": patch
"stardist": patch
"microsam": patch
---

`@neurodesk/webapp-components/file-io/tiff` reads the planes of a 2D image TIFF (`openTiffPlanes`: RGB, palette, multi-sample and one-page-per-channel images, pyramid levels and alpha left out), reports OME channels and TiffData, and writes label TIFFs (`writeLabelTiff`). StarDist and micro-sam read and write TIFF through it instead of their own copies; a palette TIFF now opens in StarDist as its red, green and blue colours rather than its colour indices.
