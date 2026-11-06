# GlioMODA

Segments adult gliomas on brain MRI that is already co-registered, skull-stripped and on the
240 x 240 x 155, 1 mm BraTS/SRI24 atlas grid, with the GlioMODA networks (Canisius et al.,
medRxiv 2025). The method, the models and the validation are in `packages/gliomoda`; this app is
the interface.

- Input: one to four NIfTI images. Each file takes the sequence its name states (`t1c`, `t1ce`,
  `t1gd`, `flair`, `t2f`, `fla`, `t1`, `t1n`, `t1w`, `t2`, `t2w`, and BIDS `ce-` T1w), the rest
  fill the free sequences, and four selects change the assignment. Files off the atlas grid are
  refused by name, as the container's command line refuses them.
- Model: the GlioMODA network for the assigned sequences, read from the manifest; the ResEncL
  network is offered when all four are present.
- Output: `<case>_gliomoda_seg.nii.gz` (uint8 BraTS labels: 1 necrotic core, 2 oedema,
  3 enhancing tumour, on the input grid and affine) and `<case>_gliomoda_volumes.tsv` (voxels and
  ml per label, whole tumour and tumour core). The case name is the files' shared stem.
- Runtime: `src/worker.js` downloads and checks the model, then runs ONNX Runtime Web on WebGPU,
  or on the CPU when WebGPU is missing or fails. One worker per run, terminated to cancel.

The example is UPENN-GBM-00002 (timepoint 11) from UPENN-GBM (TCIA, CC BY 4.0), mirrored on the
Neurodesk Hugging Face dataset. UPENN-GBM is part of the BraTS 2021 training data, so the example
shows the workflow, not out-of-sample accuracy.

## Tests

- `test/config.test.js`: sequence names, assignment, model choice for all 15 combinations, the
  label colours.
- `e2e/app.spec.js`: the example's assignment and model choice; refusal of an off-grid image; a
  run without mirroring on the CPU and the default run with mirroring, each held to the
  container's labels (`packages/gliomoda/validation/container-reference.json`); model download
  failure and retry; cancelling a run and an example download.
- `test/offline.mjs`: the desktop build segments the bundled example offline.
