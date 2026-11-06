# @neurodesk/gliomoda

[GlioMODA](https://github.com/BrainLesion/GlioMODA) glioma segmentation for the browser. The
package is the method: nnU-Net 2.5.2's preprocessing and sliding-window prediction around an
injected patch runner, the model table and the outputs. `apps/gliomoda` adds the interface and
runs the patches with ONNX Runtime Web.

## Method

GlioMODA ships one nnU-Net v2 network (`fold_all`) per sequence combination it was trained on:
T1c, FLAIR, T2, T1c + T1, T1c + FLAIR, T1c + T2, FLAIR + T1, FLAIR + T2, T1c + T1 + T2,
FLAIR + T1 + T2 and all four, plus a larger residual-encoder (ResEncL) network for all four.
There is no model for T1 alone, T1 + T2, T1c + FLAIR + T1 or T1c + FLAIR + T2; the app says so
instead of guessing.

`src/pipeline.js` repeats what `nnUNetPredictor.predict_from_files` does in the container:

- The inputs must be on the 240 x 240 x 155, 1 mm BraTS/SRI24 grid, which every plan targets with
  `transpose_forward` [0, 1, 2], so nothing is reoriented or resampled.
- The brain is the union of nonzero voxels across the sequences with enclosed holes filled
  (`binary_fill_holes`, 6-connected background), cropped to its bounding box.
- Each sequence is z-scored inside that mask and zero outside, in float32.
- Patches of the plan's size (128 x 160 x 112, or 128³ for the models with T1c and FLAIR) slide
  with step 0.5; window origins round halves to even as numpy does.
- Each patch is the mean of the plain pass and the 7 mirrored passes, weighted by nnU-Net's
  Gaussian (sigma patch / 8, peak 10, stored as float16), and accumulated in float16, as
  nnU-Net does.
- Sigmoid > 0.5 per region (whole tumour, tumour core, enhancing tumour) is written in
  `regions_class_order`: 2, then 1, then 3.

Mirroring can be switched off (8 times fewer network passes); the container always mirrors.

## Models

`scripts/export_model.py` exports each `fold_all` checkpoint of the weights archive at its plan's
patch size without deep supervision, rewrites ConvTranspose as Conv plus depth-to-space for
WebGPU, and stores the weights as float16 (cast to float32 in the graph). Each step is checked
against ONNX Runtime; the float16 storage moves logits on a random patch by at most 0.03
(`float16_max_logit_change` in the manifest). The graphs are on Hugging Face and pinned by size and
SHA-256 in `model.manifest.json`, a copy of `models/gliomoda.manifest.json`.

## Validation

The reference is the Neurocontainers image `vnmd/gliomoda_0.0.4` at digest `aeaa0a4a…`, the
GlioMODA 0.0.4 package with weights v1.0.2 and nnU-Net 2.5.2 on the CPU.
`validation/container.sh` records its segmentation of the example (UPENN-GBM-00002, timepoint
11) for every model with the container's `gliomoda` command, and for the four-sequence model
without mirroring through `nnUNetPredictor(use_mirroring=False)`. The labels are committed in
`validation/container/`.

`validation/parity.mjs` runs this package with ONNX Runtime (Node, CPU) on the same files and
writes the comparison to `validation/container-reference.json`. The browser tests in
`apps/gliomoda/e2e` hold the app, on ONNX Runtime Web, to the same files and gates.

<!-- parity-table -->

The differing voxels are float rounding near region boundaries: float16 weights, a different
convolution library and float32 summation order. Every run is checked against the gates in
`container-reference.json` (Dice 0.99 per region, at most 500 differing voxels).
