# Feature Specification: Batch Processing Parity

**Feature Branch**: `002-batch-processing-parity`  
**Created**: 2026-04-28  
**Status**: Draft  
**Input**: User description: "check that test_data/batch_processing.sh has a webapp equivalent function for each step and that it produces the same outputs as in test_data. This should be done via the existing testing framework."

## Clarifications

### Session 2026-04-28

- Q: Should missing fixture or unevaluable parity cases fail validation, or only be reported? → A: Missing fixture or unevaluable parity case fails validation.
- Q: Should output comparison use one global tolerance policy or fixture-specific policies? → A: Each fixture defines its own tolerance policy.
- Q: Which batch steps require output fixtures for parity validation? → A: Artifact-producing steps require output fixtures; setup/QC/report-only steps require coverage checks.
- Q: Should unsupported/native-only batch steps pass validation when documented? → A: Unsupported/native-only steps fail validation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Verify Every Batch Step Has Browser Coverage (Priority: P1)

A maintainer can run the project validation suite and confirm that every active processing step in `test_data/batch_processing.sh` is represented by an equivalent browser-app capability or a mapped browser-runnable segmentation task.

**Why this priority**: The web app should not silently omit processing behavior from the reference SCT batch workflow, especially when the app presents itself as supporting SCT workflows.

**Independent Test**: Can be fully tested by running the automated validation suite and reviewing the batch workflow coverage report; it delivers confidence that each active reference command has an explicit browser-app status.

**Acceptance Scenarios**:

1. **Given** the reference batch script contains an active processing command, **When** the validation suite checks coverage, **Then** the command is matched to exactly one browser-app capability or browser-runnable segmentation task.
2. **Given** a new active processing command is added to the reference batch script, **When** validation runs without a matching browser-app status, **Then** validation fails and identifies the unmatched command by section and source location.
3. **Given** a browser-runnable segmentation task is claimed for a batch step, **When** validation checks task readiness, **Then** the task has validated browser-runnable assets and is not marked supported solely by name or intent.

---

### User Story 2 - Verify Outputs Match Reference Fixtures (Priority: P1)

A maintainer can run the same validation suite and confirm that browser-app equivalents produce outputs matching the expected outputs stored under `test_data` for every batch-processing case with fixture data.

**Why this priority**: Step coverage alone does not prove functional parity; the web-app equivalent must produce the same observable results as the reference outputs.

**Independent Test**: Can be fully tested by running the automated validation suite against the fixture inputs and expected outputs in `test_data`.

**Acceptance Scenarios**:

1. **Given** a batch-processing fixture includes an input volume and expected output volume, **When** the browser-app equivalent is validated, **Then** the produced output matches the stored expected output within documented tolerance.
2. **Given** an expected output differs from the browser-app result beyond tolerance, **When** validation runs, **Then** validation fails and reports the case, compared output, and mismatch summary.
3. **Given** a batch-processing step has no output fixture yet, **When** validation runs, **Then** validation fails and reports the gap separately from output mismatches so maintainers can distinguish missing fixtures from incorrect outputs.

---

### User Story 3 - Preserve Clear Regression Signals (Priority: P2)

A maintainer can rely on one automated test entry point to catch regressions in batch-step coverage, fixture availability, and output parity before changes are merged or released.

**Why this priority**: The check should remain easy to run and interpret so maintainers use it consistently during SCT workflow changes.

**Independent Test**: Can be tested by intentionally changing a command mapping, fixture output, or expected capability status and confirming the validation suite fails with actionable diagnostics.

**Acceptance Scenarios**:

1. **Given** the validation suite is run after a web-app processing change, **When** all batch workflow checks pass, **Then** the output summarizes the number of covered commands, validated fixture cases, and failed or incomplete cases.
2. **Given** multiple failures occur in one run, **When** validation reports results, **Then** the report identifies each failing case without requiring maintainers to inspect patient image contents.
3. **Given** the reference script changes line numbers or command text, **When** validation runs, **Then** stale coverage expectations are detected rather than silently passing against old assumptions.

### Edge Cases

- A reference batch command is commented out, documentation-only, or manually performed; it must not be counted as an active command unless the script would execute it.
- A reference batch step uses the same SCT command with different inputs, modalities, options, or output names; each distinct active execution must be covered independently.
- A fixture input or expected output is missing, unreadable, malformed, or has incompatible dimensions, orientation, spacing, or datatype.
- A browser-app output is numerically close but differs in binary label semantics, affine/orientation metadata, dimensions, or expected file naming.
- A segmentation task is listed in the task inventory but lacks validated browser-runnable assets.
- Optional QC/report outputs exist in the batch workflow; parity expectations must clearly separate primary processing outputs from diagnostic/report artifacts.
- Validation output must not disclose patient-derived values, filenames beyond repository fixtures, image contents, or metadata outside the local automated test context.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The validation suite MUST identify every active executable SCT processing step in `test_data/batch_processing.sh`.
- **FR-002**: Each identified batch step MUST have exactly one declared browser-app status: equivalent browser capability, browser-runnable segmentation task, or not applicable because the script step is non-executable documentation; missing fixtures are failing validation categories, not browser-app statuses.
- **FR-003**: For each declared equivalent browser capability, validation MUST confirm the capability is available through the app's current workflow or processing surface.
- **FR-004**: For each declared browser-runnable segmentation task, validation MUST confirm the task is not marked supported unless its browser-runnable assets and validation status are present.
- **FR-005**: For every artifact-producing batch step, validation MUST run or evaluate the browser-app equivalent and compare the produced output to the expected output fixture.
- **FR-006**: Setup, install, QC, and report-only batch steps MUST be validated through browser-app coverage or status checks rather than output fixture parity.
- **FR-007**: Output comparison MUST include image data and observable output metadata needed for user-facing equivalence, including dimensions, orientation/affine behavior, spacing, datatype or label semantics, and expected output naming.
- **FR-008**: Each fixture case MUST define its own tolerance policy for data and metadata comparisons, including whether exact matching is required for binary labels, numeric values, metadata, and output naming.
- **FR-009**: When parity cannot be evaluated because an input, expected output, browser equivalent, or conversion asset is missing, validation MUST fail and report the specific gap as incomplete rather than passing the case.
- **FR-010**: Validation failures MUST identify the batch section, source command, fixture case, expected output, and mismatch category in a way maintainers can act on without inspecting the full dataset manually.
- **FR-011**: The validation suite MUST fail when the batch script changes in a way that leaves coverage mappings, fixture cases, or expected outputs stale.
- **FR-012**: Validation MUST preserve confidential browser-local handling of image data and derived outputs; any logs or reports MUST remain limited to local fixture identifiers, aggregate counts, and non-patient mismatch summaries.
- **FR-013**: The validation suite MUST remain part of the existing project testing flow used for SCT workflow checks so maintainers do not need a separate manual process to verify batch parity.
- **FR-014**: Unsupported or native-only classifications for active batch steps MUST fail validation even when a rationale is documented.

### Key Entities

- **Batch Step**: An active executable SCT command from `test_data/batch_processing.sh`, including its script section, source location, command text, input expectations, and output expectations.
- **Browser Equivalent**: The web-app workflow, task, or processing capability declared to represent a batch step for browser-local execution.
- **Fixture Case**: A test-data case containing at least one input artifact, the expected output artifact produced by the reference batch workflow when parity is required, and the tolerance policy used to compare produced and expected outputs.
- **Parity Result**: The validation outcome for a fixture case, including pass/fail/incomplete status, compared artifacts, tolerance applied, and mismatch summary.
- **Unsupported Classification**: A validation failure category for an active batch step that is not currently browser-runnable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of active executable SCT commands in `test_data/batch_processing.sh` are classified by the validation suite with no unmatched commands.
- **SC-002**: 100% of artifact-producing batch steps are validated against expected output fixtures during the existing automated SCT workflow tests.
- **SC-003**: For every fixture with expected output artifacts, parity validation applies that fixture's documented tolerance policy to dimensions, orientation/affine behavior, spacing, data values, label semantics, and expected output naming.
- **SC-004**: For numeric image or tabular outputs, parity validation reports the maximum observed difference for any failing case according to the fixture's tolerance policy.
- **SC-005**: Any missing browser equivalent, missing fixture, unevaluable parity case, unsupported/native-only step, or stale script mapping causes a failing validation result with a case-specific explanation.
- **SC-006**: A maintainer can determine from a single validation run how many batch steps are covered, how many fixture outputs matched, how many were incomplete, and which cases failed.
- **SC-007**: Validation logs and reports contain no patient image data or patient-derived metadata beyond local fixture identifiers and aggregate parity summaries.

## Assumptions

- The batch-processing script under `test_data` is the authoritative reference workflow for this feature.
- Existing `test_data` fixture directories represent the initial parity scope; artifact-producing steps without fixtures must fail validation as incomplete coverage rather than being treated as successful parity.
- Setup, install, QC, and report-only steps are not expected to have output fixtures unless they produce a primary processing artifact.
- Browser-app equivalents may be exposed as user-facing workflow steps, task inventory entries, or browser-local processing capabilities as long as users can reach the equivalent behavior through the app.
- Primary parity applies to generated processing outputs; QC/report artifacts may be validated separately unless a fixture explicitly defines their expected output.
- The existing project validation suite is the intended way to run these checks locally and in continuous validation.
