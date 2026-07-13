# Quickstart: Batch Processing Parity

## 1. Confirm Active Feature

```bash
cat .specify/feature.json
sed -n '1,220p' specs/002-batch-processing-parity/spec.md
sed -n '1,260p' specs/002-batch-processing-parity/plan.md
```

## 2. Install Dependencies

```bash
npm install
```

## 3. Inspect Current Fixtures

```bash
find test_data -maxdepth 2 -type f | sort
sed -n '1,280p' test_data/batch_processing.sh
```

Expected initial fixture pattern:

```text
test_data/batch_*/input.nii.gz
test_data/batch_*/batch_output.nii.gz
```

## 4. Run Existing Validation

```bash
npm run test:processing
npm run test:batch:webapp
```

Expected current batch parity summary:

```text
Batch parity summary: active=62 coverage=61 fixtures=8 failed=0 incomplete=1
INCOMPLETE unsupported t2s:116: {"taskId":"graymatter","unsupportedReason":"Model architecture and preprocessing are not yet ported to the browser worker."}
```

The incomplete count is intentional until the SCT gray matter task has
browser-runnable assets and passed validation in `web/models/manifest.json`.

## 5. Run Full Project Test Gate

```bash
npm test
```

## 6. Required Negative Checks During Implementation

Before considering the feature complete, verify the batch parity test has
production-safe assertions for:

- an active command in `test_data/batch_processing.sh` with no browser equivalent
- an artifact-producing active command with no fixture
- a fixture without a tolerance policy
- a changed expected output that exceeds its fixture tolerance policy
- a supported segmentation task without validated browser-runnable assets
- an unsupported/native-only active batch step

These negative cases live in `scripts/test_batch_processing_cases.cjs` and
exercise helpers from `scripts/batch-parity-lib.cjs` without leaving mutated
fixtures or generated outputs in `test_data/`.

## 7. Privacy and Diagnostic Check

Review failing diagnostics and confirm they include only local fixture
identifiers, aggregate counts, mismatch categories, and numeric summaries. They
must not print voxel arrays, patient-derived metadata, screenshots, or full
image contents.

## 8. Implementation Checklist

- `scripts/batch-parity-lib.cjs` parses active `sct_` commands from
  `test_data/batch_processing.sh`, classifies browser equivalents, validates
  manifest readiness, loads NIfTI fixtures, compares metadata/data, and formats
  privacy-safe summaries.
- `scripts/batch-parity-fixtures.cjs` owns the explicit fixture policy table for
  existing `test_data/batch_*` directories.
- `scripts/test_batch_processing_cases.cjs` is the single batch validation entry
  point for active command coverage, fixture policy checks, NIfTI parity, and
  regression diagnostics.
- Keep `test_data/` fixture files stable. Do not commit generated binary churn,
  screenshots, voxel dumps, or patient-derived data.
