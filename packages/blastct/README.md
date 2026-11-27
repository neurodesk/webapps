# `@neurodesk/blastct`

Browser inference pipeline for **BLAST-CT** v2.1.0 (`biomedia-mira/blast-ct@613acbc1b6be455a44a9e6741eb899fbf082e6fd`, Apache-2.0) v2 multi-centre DeepMedic model (checkpoint 1) over ONNX Runtime Web.

## Pipeline contract

- **Input:** 3D head CT scan in NIfTI (`.nii` / `.nii.gz`) or DICOM (converted via `dcm2niix`), any orientation or voxel spacing (1 mm working volume capped at 32M voxels and native volume capped at 150M voxels before allocation).
- **Geometry & resampling:** Pure-JS port of SimpleITK `reorient_image` + `rescale([1, 1, 1])` trilinear resampling in LPS physical coordinates, followed by nearest-neighbour restoration back to the native CT grid (`save_image`).
- **Intensity normalization:** `IntensityWindowNormalization(-15, 100)` clamping Hounsfield Units to `[-15, 100]` and mapping linearly to `[-1, 1]`.
- **Model (`blastct-deepmedic-m1.onnx`):** Exact float32 dynamic-shape 3-pathway DeepMedic (`scale_factors = (5, 3, 1)`, `feature_maps = [30, 30, 40, 40, 40, 40, 50, 50]`, `fully_connected = [250, 250]`, 4.19 MB, opset 17: `Add`, `BatchNormalization`, `Concat`, `Constant`, `Conv`, `PRelu`, `Resize`, `Slice`). Accepts any `(80 + 15k_d, 80 + 15k_h, 80 + 15k_w)` patch shape, matching upstream `110³` logits identically (`125³` patches on WebGPU stay under 128 MiB max buffer; `155³` patches with shrunk edge tiles run ~2× faster on WASM CPU).
- **Outputs:** Native-grid 5-class segmentation NIfTI (`0` background, `1` IPH intraparenchymal haemorrhage, `2` EAH extra-axial haemorrhage, `3` perilesional oedema, `4` IVH intraventricular haemorrhage) and a native-space per-class lesion volume CSV (mL and voxels).
