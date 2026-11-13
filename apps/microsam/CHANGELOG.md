# microsam

## 0.1.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
  - @neurodesk/webapp-components@0.28.0

## 0.1.20261111

### Patch Changes

- 8fca61b: `@neurodesk/webapp-components/file-io/tiff` reads the planes of a 2D image TIFF (`openTiffPlanes`: RGB, palette as colour or as indices, multi-sample and one-page-per-channel images, pyramid levels and alpha left out), names OME pages by their channels through TiffData (`omePageChannels`), and writes label TIFFs (`writeLabelTiff`). StarDist and micro-sam read and write TIFF through it instead of their own copies. StarDist now names OME channels by their TiffData mapping and refuses the TiffData layouts micro-sam refuses.
- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0

## 0.1.20261110

### Patch Changes

- 3877250: The musculoskeletal and microscopy catalogues are now titled "MSK Webapps" and "Microscopy Webapps", without "SciGet". The page title and the app bar's "More … web apps" link follow; the SciGet logo and hub link stay.

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.1.20261108

### Minor Changes

- aeb02c3: Add micro-sam, interactive 2D segmentation of light-microscopy images with Segment Anything for Microscopy (`vit_t_lm`). Positive and negative clicks and boxes segment one object at a time; accepted objects form a label TIFF and a per-object CSV table. On the BBBC038 example the browser gives micro-sam's PyTorch masks byte for byte for 24 fixed prompts.

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
