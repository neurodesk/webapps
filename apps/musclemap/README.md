# MuscleMap Web App

MuscleMap performs client-side MRI and CT muscle segmentation with official MuscleMap model definitions and ONNX Runtime Web. Images stay in the browser.

Whole-body v1.4 is the default model. Whole-body v1.3 and the five regional v0.0 models remain selectable as legacy models.

## Run locally

From the monorepo root:

```bash
corepack pnpm --filter musclemap dev
```

Open the URL printed by the development server. The setup command vendors ONNX Runtime support. Model binaries are fetched from the immutable URL generated from `model-sources/release.json` and are checked by byte length and SHA-256 before ONNX Runtime receives them.

## Use the app

1. Add a NIfTI image, a segmentation NIfTI, or a DICOM series.
2. Assign each input its role. Anatomical segmentation accepts MRI or CT; Dixon inputs support fat metrics.
3. Select an official model and run segmentation, or calculate metrics directly from an uploaded label map.
4. Inspect the class-index display overlay and statistics.
5. Optionally correct a segmentation with Edit, which paints its class-index labels in the viewer. Apply replaces the result; it is then labelled `(edited)`. Metrics already shown stay as computed; Calculate Metrics again reads the edited labels.
6. Download the NIfTI segmentation. Downloads use the model's official anatomical label values, not internal class indices. An edited segmentation downloads as the uint8 class-index map that was edited, under the same file name.

Edit is offered for a label map whose display copy shares its voxel grid. A display copy that was resampled for the viewer, and an uploaded map before its first metrics run, cannot be edited.

Uploaded segmentation filenames containing `dseg`, `seg`, `label`, or `mask` are recognized as label maps. The selected model supplies the default label-space release, which remains explicit because partial masks cannot reliably distinguish releases. Label encoding defaults to automatic detection of official sparse values, browser class indices, or the reversible OpenRecon int12 mapping. Manual choices remain available for ambiguous files. Metrics and consolidation fail closed when attribution is missing, labels are unknown or meaningfully ambiguous, label spaces differ, or affine geometry differs. A successful metrics run makes a normalized NIfTI with official sparse labels available for download.

## Model release workflow

The release workflow separates conversion, scientific validation, publication, and activation. Do not activate a model from conversion results alone.

Create the pinned Python 3.11 environment and convert the official v1.4 checkpoint:

```bash
corepack pnpm --filter musclemap model:env
corepack pnpm --filter musclemap model:convert
```

Conversion verifies the checkpoint declared in `model-sources/release.json`, exports the FP32 release candidate, checks ONNX structure, and compares three seeded patches against PyTorch. Q8 remains available only as an explicit experimental conversion because it did not meet the per-label fidelity gate. Outputs are staged under `.tmp_model_release/wholebody-v1.4/`.

Create a private fixture manifest outside source control:

```json
{
  "schemaVersion": 1,
  "cases": [
    {
      "id": "mr-1",
      "modality": "MR",
      "image": "/approved/mr.nii.gz",
      "sha256": "<64 lowercase hexadecimal characters>",
      "deidentified": true,
      "approvedForLocalValidation": true,
      "approvalReference": "<local approval record>"
    },
    {
      "id": "ct-1",
      "modality": "CT",
      "image": "/approved/ct.nii.gz",
      "sha256": "<64 lowercase hexadecimal characters>",
      "deidentified": true,
      "approvedForLocalValidation": true,
      "approvalReference": "<local approval record>"
    }
  ]
}
```

Validate one candidate against the official PyTorch checkpoint:

```bash
corepack pnpm --filter musclemap model:validate -- \
  --fixtures /approved/fixtures.json \
  --checkpoint /approved/contrast_agnostic_wholebody_model.pth \
  --precision fp32
corepack pnpm --filter musclemap model:validate-browser -- --precision fp32
corepack pnpm --filter musclemap model:validate-upstream -- \
  --reference-manifest model-sources/upstream-reference-cases.json \
  --case vhp-neck \
  --reference-root /approved/musclemap-e2e \
  --conversion-report .tmp_model_release/wholebody-v1.4/conversion-report.json
```

The fixture validator requires both MR and CT, at least 99% aggregate voxel agreement, at least 0.95 Dice for every present reference class, and reference-output coverage of every changed or new class index from 86 through 113. The browser validator creates a real ONNX Runtime Web WASM session and requires at least 99% argmax agreement with three deterministic PyTorch reference maps. The upstream validator additionally runs the complete browser worker and checks affine, voxel agreement, foreground Dice, and per-label Dice against a full-volume upstream result made with the same source chunk size and overlap. Select `--backend webgpu` to require a WebGPU adapter and evidence of executed WebGPU kernels. The default model is the published FP32 release; pass `--conversion-report` explicitly to validate a new candidate.

After the report passes, publish with a rotated write token supplied only through the environment:

```bash
HF_TOKEN=... corepack pnpm --filter musclemap model:publish
corepack pnpm --filter musclemap model:activate
```

The v1.4 FP32 model and its provenance report are immutable model-release assets. During the web build, `prepare_model_assets.mjs` verifies the full model and creates five deployment parts below Cloudflare Pages' per-file limit. The browser downloads those parts from the app origin, verifies each part, reconstructs the model, and verifies the full SHA-256 before inference. The publication scripts remain available for future Hugging Face releases that have matching conversion, fidelity, browser, upstream, and publication receipts.

Never commit fixture data, checkpoints, staged ONNX files, reports that contain private paths, or access tokens.

## Canonical contracts

`model-sources/release.json` and the pinned upstream JSON files are authoritative. The checked-in JSON files are normalized semantic copies; the release descriptor records both their local digests and the exact published byte digests. Run:

```bash
corepack pnpm --filter musclemap models:generate
corepack pnpm --filter musclemap models:check
```

The generator validates architecture, class counts, label uniqueness, config digests, publication metadata, and release status. It produces:

- `web/js/app/model-catalog.generated.js` for the browser
- `/models/musclemap.manifest.json` for hosted assets

The app owns its generated scientific model contract; shared UI and runtime code do not duplicate these defaults.

## Inference contract

Every model runs the same browser pipeline, as upstream `mm_segment.py` does for every region and version. It reproduces the upstream source-axis chunk boundary before preprocessing. Each chunk is oriented to RAS, resampled with its affine to 1 mm in-plane spacing while keeping native through-plane spacing, normalized over nonzero voxels, cropped around positive normalized voxels with a 20-voxel margin, and padded at the end to at least 256 x 256, also for models with a 128 x 128 window. Negative intensities inside the crop are preserved. It performs 2D sliding-window inference with Gaussian weighting, applies the inverse transforms to logits before argmax, and keeps the largest 6-connected component per label only after rebuilding the full source volume. When processing multiple source chunks, the browser also reproduces the integer-storage roundtrip of upstream temporary NIfTI files. Temporary-file decoding uses float64 scaling before conversion to float32, matching MONAI's loader. Full-depth processing bypasses that roundtrip. Use the chunk size and overlap pinned in `model-sources/parity-reference.json` when reproducing a controlled upstream result. Each parity case names its model; outside a case, `--model <id> --model-version <version>` selects one, and the validator downloads and verifies the published asset when it is not staged.

The browser reproduces upstream voxel for voxel when it runs an FP32 export: whole-body v1.3 and the thigh, pelvis, abdomen and leg models matched every label on their public slabs (agreement 1.0). The published regional and v1.3 assets are Q8. Q8 thigh, pelvis, abdomen and full-knee leg results pass the per-label gate, but Q8 whole-body v1.3 does not (agreement 0.988), and on a 96-slice calf slab Q8 leg lost a whole label when the largest-component cleanup kept a different fragment. No openly licensed forearm MRI was found, so the forearm model is not compared.

Legacy models default to 50 % sliding-window overlap; upstream's command defaults to 90 %. The lower default keeps CPU runs practical, and upstream recommends 50 % for large images. Select 90 % to reproduce an upstream default run.

Sampling-grid calculations use float64, as pinned MONAI does, with the pinned PyTorch linspace rounding and accumulation order. Their arithmetic order matters: rounding can turn an exact zero into a tiny nonzero value, changing which voxels enter normalization. The synthetic MONAI fixture checks both intensities and exact zeros. Regenerate it with `.tmp_model_env/bin/python scripts/emit_monai_test_fixture.py` from the app directory after setting up the pinned conversion environment.

The [2026-10-04 upstream comparison report](test/upstream-parity-20261004.json) records input derivations, reference provenance, per-label results, and reproduction commands. These scores are evidence, not test thresholds. The comparator still requires Dice ≥ 0.95 for every present label. The full-body run passes all 85 labels with minimum Dice 0.999956; three of 27,648,000 voxels differ. Identical upstream tensors with identical blending and inversion isolate those three differences to inference runtime arithmetic. They are explicitly accepted under the existing gate. Full-knee segmentation is voxel-exact for the published bounded reference.

The worker stores class indices internally in `uint8`. It exports official sparse label values as `uint8` or `uint16`, according to the generated label-space contract. Display overlays always use a separate class-index NIfTI. OpenRecon whole-body labels are detected from release-derived membership tables and restored with `original = 10 * floor(mapped / 3) + mapped % 3`; range-only guesses are not used.

## Reproduce public upstream parity

The [immutable validation bundle](https://huggingface.co/datasets/neurodeskorg/webapps/tree/1409093e00bd7cc072220752352bb8891e5f38c6/musclemap/parity/20261004) contains public MRI inputs, derived subsets, upstream masks and provenance. Its manifest checks byte lengths and SHA-256, including cached downloads. Install NumPy 1.26.4 and nibabel 5.2.1 in `.tmp_model_env` for comparison; inference itself runs in Chromium.

From the repository root:

```bash
python3 -m venv apps/musclemap/.tmp_model_env
apps/musclemap/.tmp_model_env/bin/pip install numpy==1.26.4 nibabel==5.2.1
python apps/musclemap/scripts/fetch_parity_reference.py "$TMPDIR/musclemap-reference"
corepack pnpm --filter musclemap build
node apps/musclemap/scripts/validate_upstream_parity.mjs \
  --case body-first17-multichunk --reference-root "$TMPDIR/musclemap-reference" \
  --backend wasm --output "$TMPDIR/musclemap-output.nii" \
  --report "$TMPDIR/musclemap-report.json"
```

Cases are `body-first17`, `body-first17-multichunk`, `knee-slab`, `body-single-slice`, `body-full` and `knee-full`. The knee full-volume reference explicitly uses bounded channel inversion because unmodified upstream exceeds this host's memory. The bundle includes exact before-component equivalence checks on three labeled subsets and one background subset. This validates the tested scheduling change; it does not make the full-knee reference an unmodified upstream run. Full-body references use unmodified upstream inference.

Run `body-single-slice` with `--backend webgpu`; `--software-webgpu` explicitly selects SwiftShader on hosts without hardware WebGPU. Reports record adapter details and require executed WebGPU kernels. Software results do not establish hardware GPU parity. The `musclemap-parity` workflow checks labeled WASM cases and the WebGPU single-slice case on pull requests; its manual `full_volumes` option adds both full-volume WASM cases.

To regenerate upstream masks, install `scripts/requirements-reference.txt` in the pinned conversion environment, obtain the upstream revision and checkpoint named in `model-sources/release.json`, then run `scripts/generate_upstream_reference.py --help`. Source and checkpoint hashes are checked before inference. Only `knee-full` uses `--bounded-channel-inversion`. References compare implementation behavior, not anatomical ground truth.

## Verification

```bash
corepack pnpm --filter musclemap test
corepack pnpm --filter musclemap build
apps/musclemap/.tmp_model_env/bin/python -m unittest discover -s apps/musclemap/tests -p test_upstream_comparison.py
node --test test/registry.test.mjs test/app-plan.test.mjs
node scripts/audit-artifacts.mjs --app musclemap
```

The scientific fidelity command is a separate release gate because ordinary unit and browser tests cannot establish model parity.

## Sources and license

The model configuration, labels, and checkpoint metadata come from [MuscleMap](https://github.com/MuscleMap/MuscleMap) at the revision recorded in `model-sources/release.json`. Whole-body v1.4 is published in [Zenodo record 21929873](https://zenodo.org/records/21929873) under the MIT license. The app also uses MONAI, ONNX Runtime Web, and NiiVue.
