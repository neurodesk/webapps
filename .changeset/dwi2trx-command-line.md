---
"dwi2trx": minor
"@neurodesk/dwi2trx": minor
---

Add the `dwi2trx` command line for the tensor fit: `dwi2trx DWI BVAL BVEC OUTPUT_DIR [--mask FILE | --no-mask]` runs the web app's MindGrab brain mask (on the CPU) and `niimath --dtifit` with the same vendored WebAssembly build, and writes all eleven dtifit maps under the web app's download names. Tractography is not included, because it needs WebGPU with subgroups. The fit now lives in `@neurodesk/dwi2trx`, which the web app imports. The app moves to MindGrab 0.1.20260925. Its `fit` and `tractography` automation operations accept an optional brain `mask` input and return every dtifit map. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check fits the pinned example and requires every map to match the web app's own download voxel for voxel.
