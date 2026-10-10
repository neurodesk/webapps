# SeedSeg command line

Run the web app's four-checkpoint prostate fiducial-marker pipeline on a CPU.
The shared pipeline preserves QSM bias correction, centered padding to multiples
of 32, normalization, tensor layout, three-class softmax, Float32 ensemble
averaging and component ranking by mean probability.

```sh
seedseg self-check
seedseg image.nii.gz results --ensemble 4 --threshold 0.1 --top-n 3 --threads 4
```

Portable releases include a private Node runtime, ONNX Runtime, QSM WASM and all
four checksummed models. They run offline from an empty home directory. Linux
and Windows use archives; Apple silicon uses a signed, notarized installer when
published. Local source usage needs `pnpm --filter @neurodesk/seedseg build` and
`seedseg download-models` before `--offline` inference.

`--ensemble 1` through `4` selects the first checkpoints in published order.
`--models 42,456` selects a distinct subset, also in published order, matching
the app's model checkboxes. These options are mutually exclusive. `--top-n`
(or automation-compatible `--markers`) accepts 1–10; `--threshold` accepts
0–1. `--threads` defaults to `SLURM_CPUS_PER_TASK`, or at most four local cores.

Outputs match browser downloads: `model1.nii` through `modelN.nii`,
`avgProb.nii` and `consensus.nii`. Their dimensions and affine come from the
single 3D input. The output directory must be new or empty. Progress goes to
stderr; stdout contains one JSON result. DICOM conversion and manual mask
editing remain web workflows.

Models are size- and SHA-256-verified on every load, including cache hits.
`NEURODESK_SEEDSEG_MODEL_DIR` or `--cache-dir` selects the model directory;
`NEURODESK_OFFLINE=1` or `--offline` refuses missing files. A corrupt file fails
without silently downloading a replacement. The source and browser adapters
also verify the QSM runtime and model pins respectively.

## Validation and limits

`validation/cli-check.mjs` runs the actual command and production browser
pipeline sequentially on the existing synthetic prostate fixture. It covers
ensemble sizes 1–4, top-1/top-2 selection and a changed threshold. Marker masks
must agree exactly; probability differences are reported without inventing a
new numerical tolerance. The default four-model result retains the independent
fixture gates: three components, centroids within one voxel of planted seeds,
at least 90% planted-voxel recall and at most ten times the planted volume.
Dice against the planted voids is diagnostic, not an accuracy gate.

```sh
NEURODESK_SEEDSEG_MODEL_DIR=/path/to/models node packages/seedseg/validation/cli-check.mjs --composite
```

`--composite` requires a freshly assembled catalog; the default uses the fresh
standalone production app, as provisioned by portable CI. Browser development
dependencies stay outside the shipped archive. This is software and geometric
fixture validation, **not clinical accuracy validation**. A representative,
approved clinical scan and its reference remain pending. The app deliberately
has no public example; this fixture does not replace one.

Source code is MIT. Existing model licensing remains `NOASSERTION`; the command
line adds no new license claim. See `NOTICE` and the pinned manifests.
