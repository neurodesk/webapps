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
  --case vhp-neck \
  --reference-root /approved/musclemap-e2e \
  --precision fp32
```

The fixture validator requires both MR and CT, at least 99% aggregate voxel agreement, at least 0.95 Dice for every present reference class, and reference-output coverage of every changed or new class index from 86 through 113. The browser validator creates a real ONNX Runtime Web WASM session and requires at least 99% argmax agreement with three deterministic PyTorch reference maps. The upstream validator additionally runs the complete browser worker and checks affine, voxel agreement, foreground Dice, and per-label Dice against a full-volume upstream result made with the same source chunk size and overlap. It also checks WebGPU when the runner exposes it; release CI can pass `--require-webgpu` on a capable runner.

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

The v1.4 browser pipeline reproduces the upstream source-axis chunk boundary before preprocessing. Each chunk is oriented to RAS, resampled with its affine to 1 mm in-plane spacing while keeping native through-plane spacing, normalized over nonzero voxels, cropped with a 20-voxel margin, and padded at the end. It performs 2D sliding-window inference with Gaussian weighting, applies the inverse transforms to logits before argmax, and keeps the largest 6-connected component per label only after rebuilding the full source volume. Use the chunk size and overlap pinned in `model-sources/upstream-reference-cases.json` when reproducing a controlled upstream result.

The worker stores class indices internally in `uint8`. It exports official sparse label values as `uint8` or `uint16`, according to the generated label-space contract. Display overlays always use a separate class-index NIfTI. OpenRecon whole-body labels are detected from release-derived membership tables and restored with `original = 10 * floor(mapped / 3) + mapped % 3`; range-only guesses are not used.

## Verification

```bash
corepack pnpm --filter musclemap test
corepack pnpm --filter musclemap build
node --test test/registry.test.mjs test/app-plan.test.mjs
node scripts/audit-artifacts.mjs --app musclemap
```

The scientific fidelity command is a separate release gate because ordinary unit and browser tests cannot establish model parity.

## Sources and license

The model configuration, labels, and checkpoint metadata come from [MuscleMap](https://github.com/MuscleMap/MuscleMap) at the revision recorded in `model-sources/release.json`. Whole-body v1.4 is published in [Zenodo record 21929873](https://zenodo.org/records/21929873) under the MIT license. The app also uses MONAI, ONNX Runtime Web, and NiiVue.
