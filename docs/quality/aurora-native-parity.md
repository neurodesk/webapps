# AURORA Browser ONNX Parity Evidence

This note records how the `aurora-t1c-o_best.onnx` model in `models/aurora.manifest.json` was exported
and validated against upstream `BrainLesion/AURORA` v0.2.7 (`t1c-o_best.tar`, `tta=False`).

## Pinned sources

- **Upstream code:** `BrainLesion/AURORA` v0.2.7 (`0d2b1d0`, Apache-2.0)
- **Upstream weights:** Zenodo record `10.5281/zenodo.10557069`, `t1c-o_best.tar` (`23,030,571` bytes, MD5 `5cbb214b74196c985bde38401e0474df`, SHA-256 `21f71222cbb4e8bf4fc1ae8ba9acfb1673f9fb16c1ef038bffa4d33a5c1a115d`, CC-BY-4.0)
- **Standalone container:** `vnmd/brainles-aurora_0.2.7:20261024` (`sha256:bf283ad8f84516b9906b3fd2dad3453312dad2a051587d0174c9c092847bcf30`)
- **Exported ONNX asset:** `neurodeskorg/webapps@9ea32f6bb6fc9d4c9e4259e3125b9bec432073f1/aurora/models/aurora-t1c-o_best.onnx` (`11,553,858` bytes, SHA-256 `020f8ac41e799878522c9b9abc48c75d54dd622a533623229f9244647dd8680d`)
- **Example scan:** `neurodeskorg/webapps@9ea32f6bb6fc9d4c9e4259e3125b9bec432073f1/aurora/examples/BraTS-MET-00110-000-t1c.nii.gz` (`2,137,224` bytes, SHA-256 `60dea0229037efb7f51e8c61697013094375ad02e24c1924de54035d41d777fe`, 240 × 240 × 155, 1 mm isotropic)

## Graph rewrites (`packages/aurora/scripts/export_model.py`)

1. `nn.Mish` decomposed to `x * tanh(softplus(x))` at opset 17 (`0.000e+00` max diff vs PyTorch `nn.Mish`).
2. All 4 `ConvTranspose3d` layers (`kernel == stride == 2`, zero padding) rewritten to `1×1×1 Conv + Reshape + Transpose + Reshape` for native WebGPU execution without CPU fallback.
3. Convolution weights stored as `float16` with `Cast` to `float32` compute (`max_logit_change = 0.02183` against `max_logit = 170.97`, relative error `1.27e-4`).

## Full-scan parity on `BraTS-MET-00110-000-t1c.nii.gz` (`tta=False`, 36 sliding windows)

Executed via `node packages/aurora/validation/parity.mjs` (`@neurodesk/aurora` + `onnxruntime-node`) against upstream `BrainLesion/AURORA` v0.2.7 `AuroraInferer(tta=False)` (MONAI `BasicUNet` + `SlidingWindowInferer`, 0 voxels differing from the standalone PyTorch/MONAI oracle):

| Metric | Upstream `AuroraInferer(tta=False)` | `@neurodesk/aurora` (JS + ORT) | Agreement |
| --- | ---: | ---: | ---: |
| Background (label 0) | 8,829,126 voxels | 8,829,126 voxels | Exact |
| Peritumoral oedema (label 1) | 47,078 voxels (47.078 mL) | 47,078 voxels (47.078 mL) | Exact |
| Metastasis: enhancing + necrosis (label 2) | 51,796 voxels (51.796 mL) | 51,796 voxels (51.796 mL) | Exact |
| Whole lesion (labels 1 + 2) Dice | — | — | **0.999980** |
| Metastasis (label 2) Dice | — | — | **1.000000** |
| Differing voxels across volume | — | — | **4 / 8,928,000** |
| Metastasis lesions (26-connected, ≥ 5 voxels) | 1 (51.796 mL) | 1 (51.796 mL) | Exact |
