# Data Model: Batch Processing Parity

## Batch Step

Represents one active executable SCT command from `test_data/batch_processing.sh`.

**Fields**:
- `source`: canonical source identifier for the batch script.
- `sourceLine`: line number in the current script.
- `section`: workflow section such as `setup`, `t2`, `t2s`, `t1`, `mt`, `dmri`, or `fmri`.
- `command`: active command text.
- `taskId`: browser task identifier when the command maps to a model task; otherwise empty.
- `contrast`: expected input contrast when the command maps to a segmentation task.
- `artifactProducing`: whether the step produces a primary processing artifact that requires an output fixture.

**Validation Rules**:
- Every active executable SCT command must produce exactly one Batch Step.
- Source lines must be unique for a validation run.
- Command text and source location must be checked against the current script so stale mappings fail.
- Unsupported/native-only classification is a failing state.

## Browser Equivalent

Represents the browser-app capability that covers a Batch Step.

**Fields**:
- `status`: `browser-capability`, `browser-task`, `missing-fixture`, `not-applicable`, or failing `unsupported`.
- `feature`: capability name or app workflow surface.
- `taskId`: manifest task identifier for model-backed steps.
- `controls`: expected UI controls when coverage is user-facing.
- `workerMessages`: expected worker/executor messages when coverage uses the inference pipeline.
- `moduleFunctions`: expected processing functions for reusable browser-local equivalents.

**Validation Rules**:
- Each Batch Step must map to exactly one Browser Equivalent status.
- `browser-task` steps must exist in `web/models/manifest.json`.
- Supported browser tasks must have passed validation and at least one runnable browser asset.
- Unvalidated or unsupported task states must fail when used to satisfy an active batch step.

## Fixture Case

Represents repository-local input, expected output, and comparison policy for an
artifact-producing Batch Step.

**Fields**:
- `id`: stable fixture identifier, normally the `test_data/batch_*` directory name.
- `batchStepRef`: section plus source line or command identity for the covered Batch Step.
- `inputPath`: path to fixture input.
- `expectedOutputPath`: path to reference output.
- `producedOutputName`: expected browser-equivalent output name.
- `outputType`: `nifti`, `csv`, `html-report`, or another documented type.
- `tolerancePolicy`: fixture-specific comparison policy.

**Validation Rules**:
- Artifact-producing Batch Steps must have a Fixture Case.
- Missing input, missing expected output, unreadable data, malformed data, or missing tolerance policy fails validation.
- Setup, install, QC, and report-only steps do not require Fixture Cases unless they produce primary processing artifacts.

## Tolerance Policy

Defines how a Fixture Case compares produced and expected outputs.

**Fields**:
- `dataComparison`: `exact`, `absolute-tolerance`, `relative-tolerance`, or combined numeric policy.
- `absoluteTolerance`: numeric threshold when applicable.
- `relativeTolerance`: numeric threshold when applicable.
- `metadataFields`: required metadata checks such as dimensions, spacing, affine/orientation behavior, datatype, label semantics, and output naming.
- `labelSemantics`: expected label meaning for segmentation outputs.
- `failureSummary`: required mismatch fields to report on failure.

**Validation Rules**:
- Every Fixture Case must define a tolerance policy.
- Binary label policies must explicitly state whether voxel data is exact.
- Numeric policies must report maximum observed difference on failure.
- Metadata comparison must include dimensions, spacing, affine/orientation behavior, and output naming unless the fixture explicitly excludes a field with rationale.

## Parity Result

Represents the validation outcome for one Batch Step or Fixture Case.

**Fields**:
- `caseId`: fixture id or batch step identity.
- `status`: `pass`, `fail`, or `incomplete`.
- `failureCategory`: `missing-browser-equivalent`, `missing-fixture`, `stale-mapping`, `output-mismatch`, `metadata-mismatch`, `unsupported`, or `malformed-fixture`.
- `comparedArtifacts`: input and expected/produced output identifiers.
- `mismatchSummary`: non-patient aggregate details.
- `maxDifference`: numeric maximum difference when applicable.

**Validation Rules**:
- `incomplete` is a failing validation result.
- Results must not include patient-derived values, image contents, or metadata beyond local fixture identifiers and aggregate mismatch summaries.
- A validation run summary must include covered command count, matched fixture count, incomplete count, and failed count.

## State Transitions

```text
Batch Step discovered
  -> Browser Equivalent classified
  -> Fixture required? yes -> Fixture Case loaded -> Output compared -> Parity Result
  -> Fixture required? no  -> Coverage/status checked -> Parity Result

Any missing equivalent, unsupported/native-only classification, stale mapping,
missing fixture, malformed fixture, or mismatch transitions to failing Parity Result.
```
