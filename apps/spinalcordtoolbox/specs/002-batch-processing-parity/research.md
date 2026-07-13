# Research: Batch Processing Parity

## Decision: Keep parity validation in the existing Node test framework

**Rationale**: The repository already exposes `npm run test:batch:webapp` and
`npm test`, and the feature explicitly requires the existing testing framework.
Keeping the validation in `scripts/test_batch_processing_cases.cjs` makes the
batch workflow gate visible to local contributors and CI without adding a new
runner.

**Alternatives considered**:
- Browser end-to-end test harness: closer to UI behavior, but heavier and less
direct for fixture-level NIfTI comparisons.
- Python validation script: useful for SCT tooling, but would split this
browser-app parity gate away from existing JavaScript tests.

## Decision: Treat `test_data/batch_processing.sh` as the active-command source of truth

**Rationale**: The feature is specifically scoped to the script in `test_data`.
Validation must detect stale mappings when active command text or source
locations change. A table of expected active commands can remain in the test
only if it is checked against the current script content and fails on drift.

**Alternatives considered**:
- Manually maintained command inventory only: simple, but risks passing after
  script changes.
- Shell execution of the full batch script: too expensive and not appropriate
  for browser-app parity validation.

## Decision: Require output fixtures for artifact-producing batch steps

**Rationale**: Clarification established that setup, install, QC, and
report-only steps are covered by capability/status checks, while
artifact-producing steps must compare browser-equivalent output to expected
fixtures. This keeps parity strict for observable outputs without inventing
artificial fixtures for steps whose primary purpose is setup or diagnostics.

**Alternatives considered**:
- Require fixtures for every active command: over-constrains setup and QC-only
  steps.
- Require parity only for currently existing fixture directories: would allow
  artifact-producing gaps to pass silently.

## Decision: Use fixture-specific tolerance policies

**Rationale**: Batch outputs can include binary segmentations, continuous maps,
CSV metrics, labels, and metadata-sensitive NIfTI outputs. A single global
tolerance would either be too loose for labels or too strict for continuous
outputs. Each fixture must document the comparison policy for data and metadata.

**Alternatives considered**:
- Exact match for all outputs: correct for binary masks but brittle for numeric
  outputs.
- One numeric tolerance for all outputs: easier to implement but weakens binary
  label and metadata checks.

## Decision: Fail unsupported/native-only active batch steps

**Rationale**: The feature requires a webapp equivalent for each active batch
step. Unsupported/native-only classifications are useful diagnostics, but they
must be failing validation states rather than accepted outcomes.

**Alternatives considered**:
- Allow unsupported steps with rationale: conflicts with the clarified feature
  goal.
- Allow unsupported setup/QC-only steps: unnecessary because those steps can be
  covered by browser-app coverage or status checks.

## Decision: Compare NIfTI fixture outputs through parsed image metadata and data

**Rationale**: Existing fixtures are `.nii.gz` files. Using the repository's
NIfTI dependency allows validation to compare dimensions, datatype, pixdims,
affine/orientation-relevant fields, label/data values, and output naming without
uploading or rendering image data.

**Alternatives considered**:
- Byte-for-byte file comparison: catches everything but is too brittle for
  legitimate header serialization differences.
- Visual comparison only: insufficient for medical imaging semantics and label
  correctness.
