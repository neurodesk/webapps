# lightsheet-atlas

## 0.1.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
  - @neurodesk/webapp-components@0.28.0
  - @neurodesk/greedy@0.9.20261113

## 0.1.20261111

### Minor Changes

- a2675b9: Add Light-sheet atlas, a microscopy app that registers a cleared mouse brain to the Allen Mouse Brain CCFv3 (50 µm, from the BrainGlobe Atlas API) with Greedy and counts cell candidates per brain region, following BrainGlobe's brainreg and cellfinder. It reads TIFF stacks and OME-Zarr images plane by plane, detects candidates with a port of cellfinder's classical detection (identical to cellfinder 1.10.1 on its test crop: every thresholded plane and all 38 candidates), and writes the registered atlas labels, the candidate list and a per-region table of candidate counts, volumes and densities. Counts are of unclassified candidates. The Allen atlas is for research and noncommercial use only. On BrainGlobe's test brain its labels agree with brainreg's with a whole-brain Dice of 0.97.

  `@neurodesk/webapp-components` gains `file-io/microscopy-stack`, plane-by-plane readers for TIFF stacks (multi-page or one file per plane, with OME-XML and ImageJ voxel sizes read by the shared `file-io/tiff` parsers; a single OME-TIFF's z planes are the pages its TiffData maps, and a mapping the reader cannot follow, such as planes in another file, is refused before any pixel is decoded; OME-TIFF folders and files with several image series are refused) and OME-Zarr folders. `micrometresPerUnit` also reads the NGFF spellings meter and centimeter. `@neurodesk/greedy` exports its single-threaded WebAssembly glue as `@neurodesk/greedy/wasm-single` for bundlers.

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0
  - @neurodesk/greedy@0.9.20261111

## 0.0.20261110

### Patch Changes

- Include newly registered applications in catalogue analytics when the saved usage report predates them, preserving usage ranking.

## 0.0.20261109

### Patch Changes

- Reject multi-page files in TIFF sequences and require an explicit channel for multi-channel OME-Zarr inputs.
