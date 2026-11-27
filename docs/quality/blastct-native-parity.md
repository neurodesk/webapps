# BLAST-CT Browser vs Native Upstream Parity

This report documents numerical parity between the browser/Node JavaScript implementation (`@neurodesk/blastct` + `apps/blastct`) and upstream **BLAST-CT v2.1.0** (`biomedia-mira/blast-ct` commit `613acbc1b6be455a44a9e6741eb899fbf082e6fd`, v2 multi-centre model, checkpoint 1, Apache-2.0; packaged in NeuroContainers as `vnmd/blastct_2.0.0:20260512`).

## Model & preprocessing scope

- **Weights:** Upstream checkpoint 1 (`blast_ct/data/saved_models/model_1.torch_model`, SHA-256 `f15cb328b1948a3cf47386cf8b5e3fa1f9931d9c69b8d2ad413e853d4bb23d39`, 4.20 MB) exported to one dynamic-shape opset-17 float32 ONNX graph (`blastct-deepmedic-m1.onnx`, 4.19 MB, SHA-256 `e7ea71e4a869e484ceaf3d0988e8a1af452791e870a6414751d64265af3e15cd`) by `packages/blastct/scripts/export_model.py`.
- **Single-model vs 12-model ensemble:** Upstream `blast-ct` ships 12 checkpoints and defaults to checkpoint 1 when running without `--ensemble`. The browser webapp executes checkpoint 1 (`model_1.torch_model`) directly in client-side WebGPU or threaded WebAssembly; users needing the 12-model ensemble or headless batch processing can run the NeuroContainers `blastct 2.0.0` container (`vnmd/blastct_2.0.0:20260512`).
- **Dynamic patch equivalence:** For DeepMedic's 3 pathways (`scale_factors = (5, 3, 1)`, 8 valid `3×3×3` convolutions), any input shape `(80 + 15k_d, 80 + 15k_h, 80 + 15k_w)` yields exact `(15k_d, 15k_h, 15k_w)` outputs with static `[16:-16]` and `[32:-32]` pathway slicing (`0.00e+00` PyTorch difference vs upstream `DeepMedic(110³)` and `<= 3.62e-5` ORT float32 difference across `95³`, `110³`, `125³`, and `(140, 155, 155)`). WebGPU runs `125³ → 45³` patches (peak buffer ~91 MiB, safely below WebGPU's 128 MiB storage buffer limit) and WASM CPU runs `155³ → 75³` patches with shrunk edge tiles (`0` differing voxels vs `125³` across all 6,019,749 voxels of `scan_0_head_ct.nii.gz`).
- **Pre/post-processing:** Exact port of upstream `reorient_image` + `rescale([1, 1, 1])` linear resampling (using each pass's **image minimum intensity** as the out-of-bounds default value, matching SimpleITK `ResampleImageFilter`), HU clamping to `[-15, 100]` linearly mapped to `[-1, 1]` (`IntensityWindowNormalization`), non-overlapping sliding-window inference with edge padding, argmax over 5 classes (`0` background, `1` IPH, `2` EAH, `3` oedema, `4` IVH), and nearest-neighbour resampling back to native scan geometry.

## Parity results against real upstream `blast_ct` (`ModelInference` + `NiftiPatchSaver`, `110³` config)

Verified against upstream `blast_ct.assets.get_config_path`, `blast_ct.read_config.get_model`, `blast_ct.read_config.get_test_loader`, `blast_ct.nifti.savers.NiftiPatchSaver`, and `blast_ct.trainer.inference.ModelInference` (checkpoint 1, upstream `110³` test config) and evaluated by `packages/blastct/validation/parity.mjs`:

### Float32 and scaled integer NIfTI inputs (exact precision match)

| Case | Native grid & geometry | Differing voxels | IPH Dice (pred / ref) | EAH Dice (pred / ref) | Oedema Dice (pred / ref) | IVH Dice (pred / ref) |
| --- | --- | --- | --- | --- | --- | --- |
| `scan_0_head_ct.nii.gz` (pinned example, integer-HU `float32`) | `201 × 201 × 149`, `1.0 mm` | **1 / 6,019,749** (0.00002%) | **1.000000** (`48,087 / 48,087`) | **1.000000** (`23,595 / 23,595`) | **0.999992** (`62,721 / 62,720`) | **1.000000** (`327 / 327`) |
| `scaled_u16` (`uint16` with `scl_inter = -1024`) | `201 × 201 × 149`, `1.0 mm` | **0 / 6,019,749** (0.00000%) | **1.000000** | **1.000000** | **1.000000** | **1.000000** |
| `scan_0_oblique_aniso.nii.gz` (12° pitch + 6° roll, X-flipped, `0.85 × 0.85 × 3.0 mm`, `float32`) | `220 × 220 × 52`, oblique | **697 / 2,516,800** (0.027%) | **0.994449** (`19,586 / 19,595`) | **0.994719** (`9,745 / 9,759`) | **0.993084** (`25,990 / 25,922`) | **0.973783** (`131 / 136`) |

## Known deviations & edge cases

1. **Unscaled `int16` NIfTI inputs (SimpleITK integer truncation):** When an input NIfTI is stored as `int16` with identity scaling (`scl_slope = 1, scl_inter = 0`) and requires resampling, upstream SimpleITK keeps an `int16` output pixel type across both `ResampleImageFilter` passes, truncating interpolated Hounsfield Units toward zero (introducing a `−0.5` to `−0.9` HU systematic bias inside `[−15, 100]` HU; on `oblique_i16` vs `oblique_float32` of the same anatomy, upstream itself shifts predicted oedema volume from `67.03 mL` to `72.35 mL`). `@neurodesk/blastct` resamples in `float32` without integer truncation, so it matches upstream `float32` and scaled `uint16` scans to 0–1 voxels while differing on unscaled `int16` resampled scans:
   - `oblique_i16` (`220 × 220 × 52`, `0.85 × 0.85 × 3.0 mm`, `int16`): 4,703 differing voxels — IPH Dice `0.980`, oedema Dice `0.943`, IVH Dice `0.820`
   - `axial_aniso_i16` (`0.45 × 0.45 × 5.0 mm`, non-oblique `int16`): 6,623 differing voxels — IPH Dice `0.977`, oedema Dice `0.967`
   - `sagittal_i16` (`int16`): 5,834 differing voxels — oedema Dice `0.980`
2. **3-cycle axis permutations (sagittal reformats):** Upstream `create_reference_reoriented_image` indexes `new_size = size[ind]`, which maps 3-cycle permutations (such as sagittal reformats) to a non-axial `(S, L, P)` axis order rather than canonical `(L, P, S)`. `@neurodesk/blastct` reproduces upstream's exact permutation for parity (`Dice >= 0.98` on `sagittal_i16`).
3. **NIfTI `sform` vs `qform` precedence:** `@neurodesk/blastct` follows NiBabel `sform`-first precedence (`@neurodesk/webapp-components/file-io/nifti`), whereas SimpleITK 2.5.8 prefers `qform` when `sform_code = 2` and `qform_code = 1` disagree. Standard `dcm2niix` outputs write consistent `sform` and `qform` matrices.

## Reproduction

```bash
# 1. Generate upstream PyTorch + SimpleITK reference oracles (real 110^3 ModelInference + NiftiPatchSaver)
python3 packages/blastct/validation/generate_oracles.py \
  --blast-ct-repo "$TMPDIR/blastct-spike/blast-ct" \
  --out-dir "$TMPDIR/blastct-oracles"

# 2. Verify @neurodesk/blastct JS + ONNX Runtime against each oracle
node packages/blastct/validation/parity.mjs \
  "$TMPDIR/blastct-oracles/scan_0_head_ct.nii.gz" \
  "$TMPDIR/blastct-spike/blastct-deepmedic-m1.onnx" \
  "$TMPDIR/blastct-oracles/oracle_scan0.nii.gz"

node packages/blastct/validation/parity.mjs \
  "$TMPDIR/blastct-oracles/scan_0_oblique_aniso.nii.gz" \
  "$TMPDIR/blastct-spike/blastct-deepmedic-m1.onnx" \
  "$TMPDIR/blastct-oracles/oracle_oblique.nii.gz"

# Optional documented int16 ITK truncation comparison:
node packages/blastct/validation/parity.mjs --allow-int16-truncation \
  "$TMPDIR/blastct-oracles/scan_0_oblique_i16.nii.gz" \
  "$TMPDIR/blastct-spike/blastct-deepmedic-m1.onnx" \
  "$TMPDIR/blastct-oracles/oracle_oblique_i16.nii.gz"
```
