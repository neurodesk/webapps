# Brainchop

Whole-brain segmentation and continuous tissue fraction mapping of 3D T1-weighted MRI
using Brainchop v4.0 MeshNet models from `@brainchop/core`:

- **Subcortical + tissue (MindMap-24)** — 18-class cortical and subcortical segmentation
- **Subcortical + tissue, fast (MindMap-16)** — lightweight 18-class preview
- **Desikan-Killiany 104 (MindSnap-104)** — 104-region cortical, subcortical and 5-part corpus callosum atlas
- **Tissue fraction maps (GM/WM/CSF)** — CAT-lite continuous grey matter, white matter, CSF and brain partial-volume fractions

Brain extraction and binary skull stripping live in the Brain extraction app.

Select an example or load one NIfTI image or DICOM series, choose a model, and run
segmentation. Outputs return on the input image's own voxel grid by default (or on
the conformed 256³ 1 mm grid when enabled in Advanced settings). Label maps on the
input grid can be corrected with **Edit** in the Output list before downloading.

Processing stays in the browser via `@brainchop/core` (`@neurodesk/runtime-support/mindgrab`):
pure-JS WebGPU V4 (`models/*.bin`), falling back to hardware WebGL2 WASM, then to
the threaded CPU WASM module on cross-origin isolated pages. Software rasterizers are
skipped in favour of the threaded CPU module. The worker is terminated on cancellation.
These models are for research, not diagnosis.

Run `pnpm --filter brainchop build`, `pnpm --filter brainchop test`, and
`pnpm --filter brainchop test:e2e`. Browser tests run against production output.
