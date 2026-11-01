# SeedSeg command line

`seedseg` runs the browser's shared prostate fiducial-marker pipeline on a CPU.
The default is nnU-Net v2 fold 0, without mirroring, using the browser-format
weights. These weights use fp16 storage and fp32 computation.

```sh
seedseg self-check
seedseg image.nii.gz results
seedseg image.nii.gz ensemble --folds 0,1,2,3,4 --mirror
seedseg image.nii.gz legacy --pipeline legacy-v1
```

`--folds` accepts distinct folds 0 through 4 in published order. `--mirror`
averages the eight mirrored predictions per patch. `--model fp32` selects the
optional full-precision weights. Download those separately with
`seedseg download-models --model fp32` before offline use.

`--pipeline legacy-v1` runs the previous four-network consensus. The existing
`--ensemble 1` through `4` and `--models 42,456` options also select legacy v1.
`--model v1` and `--model v2` also select those pipelines for compatibility.
The legacy `--models` and `--ensemble` selections are mutually exclusive. V2 fold and mirror settings do not apply to legacy
v1. Both methods accept `--top-n` or its alias `--markers` from 1 through 10 and
`--threshold` from 0 through 1. The defaults are 3 and 0.1. `--threads` defaults
to `SLURM_CPUS_PER_TASK`, or at most four local cores.

V2 writes `probability.nii`, `markers.nii` and `detections.json`. Marker voxels
contain their candidate rank. The JSON contains weighted centroids in voxel and
world coordinates, probabilities, volumes and a flag when fewer than the
implant count are found. Legacy v1 retains `model1.nii` through `modelN.nii`,
`avgProb.nii` and its binary `consensus.nii`. NIfTI outputs preserve the input
grid and affine. The output directory must be new or empty. Progress goes to
stderr and stdout contains one JSON result.

Portable releases include a private Node runtime, ONNX Runtime, QSM WASM, five
v2 browser-format checkpoints and four legacy checkpoints. Default and legacy
inference run offline from an empty home directory. Optional fp32 weights need
a separate download. DICOM conversion and manual mask editing use the web app.

Models are size- and SHA-256-verified on each load, including cache hits.
`NEURODESK_SEEDSEG_MODEL_DIR` or `--cache-dir` selects the model directory.
`NEURODESK_OFFLINE=1` or `--offline` refuses missing files. A corrupt file fails
without silently downloading a replacement. Source usage needs
`pnpm --filter @neurodesk/seedseg build` and `seedseg download-models` before
offline inference.

## Validation and limits

`validation/cli-check.mjs` compares the actual command with the production
browser worker on the existing synthetic fixture. Cases cover v2 defaults,
all five folds, mirroring, legacy ensemble sizes 1 through 4,
top-1 and top-2 selection, and a changed threshold. Source validation also checks
the optional fp32 weights. Legacy marker masks must agree exactly. V2 follows
[upstream's parity criteria](https://github.com/astewartau/prostate/blob/c9b328a2e0bc1768c0b75640f5532e2853e7ef31/scripts/deploy/compare_parity.py):
the same top-K components in the same order, centroids within one voxel, and
matching candidate count and count flag. Probability differences are reported
alongside the fixed limits retained from the intervening repair: maximum
probability difference 0.05 (0.2 with mirroring); per-rank disagreement at most
five voxels, Dice at least 0.9 and geometric-centroid shift at most 0.25 voxel.
These limits supplement the upstream detection criterion.

The legacy four-model case retains the existing independent fixture gates:
three components, centroids within one voxel of planted seeds, at least 90%
planted-voxel recall and at most ten times the planted volume. Dice is diagnostic.
V2 cases establish adapter consistency and preserve ranked detections. They do
not establish accuracy on clinical data.

```sh
NEURODESK_SEEDSEG_MODEL_DIR=/path/to/models node packages/seedseg/validation/cli-check.mjs
```

`--case default-v2` selects one case. `--composite` uses a freshly assembled
catalog instead of the standalone app. Browser dependencies stay outside the
shipped archive. A representative, approved clinical scan and its upstream
reference remain pending. QSM homogeneity correction replaces training's N4,
and off-protocol resampling uses linear interpolation as in the upstream
browser. These differences also need clinical validation.

Source code is MIT. Model licensing remains `NOASSERTION` in the manifests.
See `NOTICE` for the runtime and model metadata.
