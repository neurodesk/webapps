# @neurodesk/tumour-report

## 0.2.0

### Minor Changes

- 70d8d24: Add Brain Tumour Report (`tumour-report` and `@neurodesk/tumour-report`): single-scan native-space contrast-enhancing brain tumour segmentation using Raidionics v1.3 (`MRI_Brain` + `MRI_TumorCore/t1c`, WebGPU-compatible ONNX export with automatic CPU WASM fallback), per-lesion native-space morphometry with clickable NiiVue centroid navigation, and optional MNI ICBM152 2009a RADS anatomical characterization via Greedy WebAssembly (laterality, MNI lobes, Schaefer 7/17 networks, 64 BCB subcortical white-matter tracts, and Kommers et al. glioblastoma resectability). Verified against `dbouget/raidionics-rads:v1.3.2-py39-cpu` on BEAMSTER native T1c (`Dice = 1.00000` in Node, `0.99971` in Chromium WASM).

### Patch Changes

- Updated dependencies [01e85d7]
  - @neurodesk/greedy@0.10.20261124
  - @neurodesk/synthsr@0.6.20261124
