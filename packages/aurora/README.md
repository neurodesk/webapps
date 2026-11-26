# `@neurodesk/aurora`

Browser inference pipeline for **BrainLes AURORA** v0.2.7 brain metastasis segmentation (`t1c-o_best`, MONAI 3D `BasicUNet`) over ONNX Runtime Web.

## Pipeline contract

- **Input:** Single skull-stripped contrast-enhanced T1 (T1c) 3D NIfTI on the `240 × 240 × 155`, `1 mm` isotropic BraTS/SRI24 atlas grid.
- **Normalization:** `nan_to_num` followed by MONAI `ScaleIntensityRangePercentiles(lower=0.5, upper=99.5, b_min=0, b_max=1, clip=True)`. Volumes whose 0.5th and 99.5th percentiles are equal are refused as constant.
- **Sliding window:** `roi_size = (192, 192, 32)` in nibabel/MONAI `(X, Y, Z)` order, `overlap = 0.5`, Gaussian importance (`sigma_scale = 0.125`, clamped at `1e-3`), replicate padding, deterministic `tta = False` baseline.
- **Outputs:** Two independent sigmoid channels thresholded at `>= 0.5` (configurable):
  - `1`: Peritumoral oedema (channel 0 only; `# edema` upstream)
  - `2`: Metastasis (enhancing + necrosis, channel 1; overwrites label 1)
  - Separate binary masks (`whole_mask`, `metastasis_mask`), per-region volumes (mL), and 26-connected metastasis lesion counts (`>= 5` voxels).
