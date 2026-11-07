---
"@neurodesk/webapp-components": minor
"stardist": patch
"microsam": patch
---

`@neurodesk/webapp-components/file-io/tiff` reads the planes of a 2D image TIFF (`openTiffPlanes`: RGB, palette as colour or as indices, multi-sample and one-page-per-channel images, pyramid levels and alpha left out), names OME pages by their channels through TiffData (`omePageChannels`), and writes label TIFFs (`writeLabelTiff`). StarDist and micro-sam read and write TIFF through it instead of their own copies. StarDist now names OME channels by their TiffData mapping and refuses the TiffData layouts micro-sam refuses.
