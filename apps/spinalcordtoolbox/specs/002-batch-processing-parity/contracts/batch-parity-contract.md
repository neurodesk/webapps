# Contract: Batch Processing Parity Validation

## Test Entry Points

The batch parity contract is exercised through existing project scripts:

```bash
npm run test:batch:webapp
npm test
```

`npm run test:batch:webapp` must fail when this contract is violated.

## Active Command Coverage

The validator must derive or verify the active executable SCT commands in
`test_data/batch_processing.sh`.

Required checks:
- Every active command beginning with `sct_` is represented exactly once.
- Commented examples, documentation text, and manual-only notes are not counted.
- Source line, section, and command text are stale-mapping guards.
- Unknown commands fail with section, line, and command text.

## Browser Equivalent Coverage

Each active command must map to one browser equivalent:
- `browser-task`: a task in `web/models/manifest.json` with validated
  browser-runnable assets when marked supported.
- `browser-capability`: a browser-local processing capability available through
  current app workflow or processing modules.
- `not-applicable`: only for non-executable documentation or manual-only notes.

Failing classifications:
- `unsupported`
- `native-only`
- missing browser equivalent
- supported task without validated runnable browser asset

## Fixture Parity

Artifact-producing commands require a fixture case.

Minimum fixture case fields:

```json
{
  "id": "batch_t2_deepseg_spinalcord",
  "batchStep": {
    "section": "t2",
    "sourceLine": 72
  },
  "inputPath": "test_data/batch_t2_deepseg_spinalcord/input.nii.gz",
  "expectedOutputPath": "test_data/batch_t2_deepseg_spinalcord/batch_output.nii.gz",
  "producedOutputName": "batch_output.nii.gz",
  "outputType": "nifti",
  "tolerancePolicy": {
    "dataComparison": "exact",
    "metadataFields": [
      "dimensions",
      "spacing",
      "affine_or_orientation",
      "datatype",
      "label_semantics",
      "output_name"
    ]
  }
}
```

The implementation may store this contract as inline test data or fixture
metadata, but every fixture must be explicit and reviewable.

Current implementation stores fixture policies in
`scripts/batch-parity-fixtures.cjs` and reusable validation helpers in
`scripts/batch-parity-lib.cjs`.

## NIfTI Comparison

For `outputType: "nifti"`, comparison must validate:
- dimensions
- spacing/pixdim behavior
- affine/orientation-relevant behavior
- datatype or documented output datatype policy
- binary label semantics when applicable
- voxel data according to the fixture tolerance policy
- expected output name

For numeric tolerance failures, the diagnostic must include maximum observed
difference. For exact failures, the diagnostic must identify the first or count
of mismatched elements without dumping image contents.

## Reporting Contract

A successful run reports:
- active command count
- browser-equivalent coverage count
- fixture parity count
- failed count of zero
- incomplete count of zero

Until a manifest task has browser-runnable assets and passed validation,
manifest-readiness gaps may be reported as `incomplete` to preserve the
regression signal without marking unsupported model assets as supported.

A failing run reports each failing case with:
- section
- source line
- command or fixture id
- failure category
- expected output identifier when applicable
- non-patient mismatch summary

Logs must not include patient image data, voxel arrays, screenshots, or
patient-derived metadata.
