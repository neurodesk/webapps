---
"lightsheet-atlas": minor
"@neurodesk/webapp-components": minor
"@neurodesk/greedy": patch
---

Add Light-sheet atlas, a microscopy app that registers a cleared mouse brain to the Allen Mouse Brain CCFv3 (50 µm, from the BrainGlobe Atlas API) with Greedy and counts cell candidates per brain region, following BrainGlobe's brainreg and cellfinder. It reads TIFF stacks and OME-Zarr images plane by plane, detects candidates with a port of cellfinder's classical detection (identical to cellfinder 1.10.1 on its test crop: every thresholded plane and all 38 candidates), and writes the registered atlas labels, the candidate list and a per-region table of candidate counts, volumes and densities. Counts are of unclassified candidates. The Allen atlas is for research and noncommercial use only. On BrainGlobe's test brain its labels agree with brainreg's with a whole-brain Dice of 0.97.

`@neurodesk/webapp-components` gains `file-io/microscopy-stack`, plane-by-plane readers for TIFF stacks (multi-page or one file per plane, OME-XML and ImageJ voxel sizes) and OME-Zarr folders. `@neurodesk/greedy` exports its single-threaded WebAssembly glue as `@neurodesk/greedy/wasm-single` for bundlers.
