# Quickstart: SCT Model Integration

## 1. Confirm Feature Context

```bash
cat .specify/feature.json
sed -n '1,220p' specs/001-sct-model-integration/spec.md
sed -n '1,260p' specs/001-sct-model-integration/plan.md
```

## 2. Prepare Dependencies

```bash
npm install
cd web
bash setup.sh
cd ..
```

## 3. Discover and Prepare SCT Model Assets

The implementation phase will provide SCT-specific scripts. The expected
workflow is:

```bash
python scripts/download_sct_models.py --stable --output .tmp_sct_models
python scripts/convert_sct_models.py --input .tmp_sct_models --output web/models
python scripts/validate_sct_models.py --manifest web/models/manifest.json
```

The scripts must produce `web/models/manifest.json` and browser-runnable model
assets for supported tasks. Tasks that cannot be converted or validated must be
listed in the manifest as unsupported or unvalidated with reasons.

## 4. Run Local App

```bash
cd web
bash run.sh
```

Open `http://localhost:8080`.

## 5. Validate Default Workflow

1. Load a representative non-patient or de-identified spinal cord MRI.
2. Select the default SCT `spinalcord` task.
3. Run segmentation.
4. Confirm the overlay appears with spinal cord labels.
5. Download the output NIfTI.
6. Compare output metadata and mask agreement against SCT stable reference
   output using the validation script.

## 6. Required Checks Before Commit

```bash
npm run lint
python scripts/validate_sct_models.py --manifest web/models/manifest.json
```

Also perform documented browser workflow verification and confirm no obsolete
obsolete model terminology remains in active UI, docs, config, scripts, or model
filenames.

## Current Validation Outcome

As of 2026-04-27, the SCT stable task inventory is represented in
`web/models/manifest.json`, JavaScript lint passes, and manifest validation
passes. The default `spinalcord` task remains non-runnable because no
browser-compatible SCT ONNX asset has been converted and validated yet.
