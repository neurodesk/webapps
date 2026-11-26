# totalsegmentator

## 0.1.20261124

### Minor Changes

- 36e91c5: Add the TotalSegmentator webapp to the `msk` catalogue (`mskapps.sciget.org`), powered by openly licensed Apache-2.0 TotalSegmentator v2 nnU-Net models running locally in the browser on WebGPU or WebAssembly. Supports whole-body CT (`total`, 117 structures, 3 mm fast or 1.5 mm 5-part with selectable anatomical subsets), whole-body MRI (`total_mr`, 50 structures, 3 mm fast or 1.5 mm 2-part with selectable subsets), MRI vertebrae (`vertebrae_mr`, 25 structures), and CT abdominal muscles (`abdominal_muscles`, 22 structures, automatically cropped to `body_trunc` with the 6 mm body model), with canonical RAS round-trip reorientation, per-structure volume and intensity statistics (Results tab and TSV export), interactive mask editing, DICOM/NIfTI loading, and WebMCP automation.

### Patch Changes

- Updated dependencies [f316dac]
- Updated dependencies [dce0e7f]
- Updated dependencies [36e91c5]
- Updated dependencies [94d6e09]
  - @neurodesk/runtime-support@0.10.0
  - @neurodesk/webapp-components@0.29.0
  - @neurodesk/totalsegmentator@0.2.0
  - @neurodesk/synthsr@0.6.20261124
