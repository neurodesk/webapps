# AURORA app notes

- Engine and model manifest live in `packages/aurora` and `models/aurora.manifest.json`.
- Input contract is strictly a skull-stripped, 1 mm isotropic T1c volume on the 240 × 240 × 155 BraTS/SRI24 atlas grid; refuse off-grid images before running inference.
- MONAI `BasicUNet` expects nibabel `(X, Y, Z)` tensor order (`roi_size = [192, 192, 32]`), unlike nnU-Net's `(Z, Y, X)`; preserve the axis reordering in `packages/aurora/src/pipeline.js`.
- Preserve upstream's two independent sigmoid channels (label `1` peritumoral oedema, label `2` metastasis enhancing + necrosis overwriting `1`) and deterministic `tta = false` baseline.
- Keep `app_scoped_runtime_families: [ort-web-asyncify]` and `isolationFallback()` so threaded WASM and WebGPU work in both isolated and fallback contexts.
