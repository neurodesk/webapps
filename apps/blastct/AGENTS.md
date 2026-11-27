# BLAST-CT webapp instructions

- **Model & preprocessing contract:** BLAST-CT runs upstream `biomedia-mira/blast-ct` v2.1.0 (`613acbc1b6be455a44a9e6741eb899fbf082e6fd`, Apache-2.0) v2 multi-centre DeepMedic model, checkpoint 1 (`model_1.torch_model`), exported to one dynamic-shape float32 ONNX graph (`packages/blastct/scripts/export_model.py`, `models/blastct.manifest.json`). Keep the exact preprocessing contract: upstream `reorient_image` + `rescale([1, 1, 1])` linear resampling (using each pass's image minimum intensity as the out-of-bounds fill value, in float32), HU clamping to `[-15, 100]` linearly mapped to `[-1, 1]`, dynamic non-overlapping DeepMedic patch tiling (`(80 + 15k) -> 15k`), and nearest-neighbour resampling of the 5-class `uint8` labels back to native geometry.
- **Label convention (Monteiro et al. 2020, upstream `blast-ct`):**
  - `1`: IPH — Intraparenchymal haemorrhage
  - `2`: EAH — Extra-axial haemorrhage
  - `3`: Oedema — Perilesional oedema
  - `4`: IVH — Intraventricular haemorrhage
- **Backend & patch sizing:** WebGPU uses `125^3 -> 45^3` patches (max intermediate buffer ~91 MiB, safely under WebGPU's 128 MiB storage buffer limit). WASM CPU uses `155^3 -> 75^3` patches with shrunk edge tiles (`(80 + 15k)`), which is algebraically identical to upstream `110^3 -> 30^3` while ~2x faster on CPU. Never silently change patch alignment away from `80 + 15k` (`RECEPTIVE_FIELD_MARGIN = 80`, `STRIDE_LCM = 15`).
- **Safety bounds:** Refuse volumes whose 1 mm reoriented grid exceeds `MAX_WORKING_VOXELS` (`32_000_000`) or whose native grid exceeds `MAX_NATIVE_VOXELS` (`150_000_000`) before allocating resample buffers. Thin-slice clinical head CTs (e.g. `512×512×320` at `0.45×0.45×0.625 mm` = `10.7M` 1 mm voxels) are accepted.
- **Documented edge cases:** Float32 resampling avoids SimpleITK's `int16` resample truncation on identity-scaled integer NIfTIs; 3-cycle sagittal axis permutations reproduce upstream's `new_size = size[ind]` orientation; NIfTI affines follow NiBabel `sform`-first precedence. See `docs/quality/blastct-native-parity.md`.
- **DICOM & NIfTI inputs:** Always convert mixed NIfTI/DICOM inputs through `readImageFiles` / `runDcm2niix` from `@neurodesk/runtime-support/dcm2niix-client`. Never add app-local dcm2niix glue.
- **Parity validation:** Whenever changing `packages/blastct` geometry, normalization, tiling, or model export, re-run `packages/blastct/validation/generate_oracles.py` and `packages/blastct/validation/parity.mjs` against real upstream `blast_ct` (`ModelInference` + `NiftiPatchSaver`, `110^3` config).
