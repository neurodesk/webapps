# Tasks: Batch Processing Parity

**Input**: Design documents from `/specs/002-batch-processing-parity/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/batch-parity-contract.md, quickstart.md

**Tests**: Required. This feature is a validation-gate enhancement and must be implemented through the existing test framework.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the shared validation helpers and fixture policy structure used by all stories.

- [x] T001 Create shared batch parity helper module skeleton in `scripts/batch-parity-lib.cjs`
- [x] T002 Create explicit fixture policy table skeleton in `scripts/batch-parity-fixtures.cjs`
- [x] T003 [P] Add exports/import wiring from `scripts/batch-parity-lib.cjs` into `scripts/test_batch_processing_cases.cjs`
- [x] T004 [P] Document the local implementation checklist in `specs/002-batch-processing-parity/quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Define the core data contracts and parsing primitives that must be complete before any user story can be implemented.

**CRITICAL**: No user story work can begin until this phase is complete.

- [x] T005 Implement active command parsing for executable `sct_` lines in `scripts/batch-parity-lib.cjs`
- [x] T006 Implement Batch Step validation for unique source line, section, command, taskId, contrast, and artifactProducing fields in `scripts/batch-parity-lib.cjs`
- [x] T007 Implement Browser Equivalent validation states and reject unsupported/native-only classifications in `scripts/batch-parity-lib.cjs`
- [x] T008 Implement Parity Result object creation with non-patient failure categories in `scripts/batch-parity-lib.cjs`
- [x] T009 [P] Populate initial fixture case policies for existing `test_data/batch_*` directories in `scripts/batch-parity-fixtures.cjs`
- [x] T010 Add privacy-safe diagnostic string helpers in `scripts/batch-parity-lib.cjs`

**Checkpoint**: Foundation ready; user story implementation can begin.

---

## Phase 3: User Story 1 - Verify Every Batch Step Has Browser Coverage (Priority: P1) MVP

**Goal**: Every active processing step in `test_data/batch_processing.sh` is represented by an equivalent browser capability or mapped browser-runnable segmentation task.

**Independent Test**: Run `npm run test:batch:webapp` and confirm unmatched commands, stale command mappings, unsupported/native-only states, and unvalidated supported tasks fail with section and line diagnostics.

### Tests for User Story 1

- [x] T011 [US1] Add stale active-command mapping test cases in `scripts/test_batch_processing_cases.cjs`
- [x] T012 [US1] Add unsupported/native-only classification failure test cases in `scripts/test_batch_processing_cases.cjs`
- [x] T013 [US1] Add browser task readiness failure test cases for unsupported or unvalidated manifest tasks in `scripts/test_batch_processing_cases.cjs`

### Implementation for User Story 1

- [x] T014 [US1] Replace static RAW_CASES-only coverage with parser-backed active command verification in `scripts/test_batch_processing_cases.cjs`
- [x] T015 [US1] Move batch step classification into reusable Browser Equivalent mapping functions in `scripts/batch-parity-lib.cjs`
- [x] T016 [US1] Enforce exactly one browser equivalent for each active Batch Step in `scripts/test_batch_processing_cases.cjs`
- [x] T017 [US1] Enforce browser task readiness against `web/models/manifest.json` in `scripts/test_batch_processing_cases.cjs`
- [x] T018 [US1] Enforce setup/install/QC/report-only coverage through app capability or status checks in `scripts/test_batch_processing_cases.cjs`
- [x] T019 [US1] Run `npm run test:batch:webapp` and resolve US1 failures in `scripts/test_batch_processing_cases.cjs`

**Checkpoint**: User Story 1 is independently functional and testable as the MVP.

---

## Phase 4: User Story 2 - Verify Outputs Match Reference Fixtures (Priority: P1)

**Goal**: Every artifact-producing batch step has an expected fixture and browser-equivalent outputs match the fixture-specific tolerance policy.

**Independent Test**: Run `npm run test:batch:webapp` and confirm missing fixtures, missing tolerance policies, malformed NIfTI data, metadata mismatches, and output data mismatches fail with fixture-specific diagnostics.

### Tests for User Story 2

- [x] T020 [US2] Add fixture policy validation tests for missing input, missing output, and missing tolerance policy in `scripts/test_batch_processing_cases.cjs`
- [x] T021 [US2] Add NIfTI metadata mismatch tests for dimensions, spacing, datatype, and output name in `scripts/test_batch_processing_cases.cjs`
- [x] T022 [US2] Add NIfTI data mismatch tests for exact and numeric tolerance policies in `scripts/test_batch_processing_cases.cjs`

### Implementation for User Story 2

- [x] T023 [US2] Implement fixture discovery and artifact-producing step requirement checks in `scripts/batch-parity-lib.cjs`
- [x] T024 [US2] Implement fixture-specific tolerance policy validation in `scripts/batch-parity-lib.cjs`
- [x] T025 [US2] Implement NIfTI `.nii.gz` loading with `nifti-reader-js` in `scripts/batch-parity-lib.cjs`
- [x] T026 [US2] Implement browser-equivalent output generation from fixture inputs in `scripts/batch-parity-lib.cjs`
- [x] T027 [US2] Implement NIfTI metadata comparison for dimensions, spacing, affine/orientation-relevant fields, datatype, label semantics, and output naming in `scripts/batch-parity-lib.cjs`
- [x] T028 [US2] Implement NIfTI voxel comparison with exact, absolute tolerance, relative tolerance, and maximum difference summaries in `scripts/batch-parity-lib.cjs`
- [x] T029 [US2] Wire fixture parity checks into `scripts/test_batch_processing_cases.cjs`
- [x] T030 [US2] Run `npm run test:batch:webapp` and resolve US2 failures in `scripts/test_batch_processing_cases.cjs`

**Checkpoint**: User Stories 1 and 2 both pass independently through the existing batch test entry point.

---

## Phase 5: User Story 3 - Preserve Clear Regression Signals (Priority: P2)

**Goal**: Maintainers get actionable, privacy-safe summaries for coverage, fixture parity, incomplete cases, and failures from a single validation run.

**Independent Test**: Run `npm run test:batch:webapp` with deliberate local negative cases and confirm the output identifies each failing case without printing image data, voxel arrays, screenshots, or patient-derived metadata.

### Tests for User Story 3

- [x] T031 [US3] Add aggregate success summary assertion for active command count, coverage count, fixture parity count, failed count, and incomplete count in `scripts/test_batch_processing_cases.cjs`
- [x] T032 [US3] Add multi-failure diagnostic tests for unmatched command, missing fixture, and output mismatch in `scripts/test_batch_processing_cases.cjs`
- [x] T033 [US3] Add privacy guard tests ensuring diagnostics omit voxel arrays and image contents in `scripts/test_batch_processing_cases.cjs`

### Implementation for User Story 3

- [x] T034 [US3] Implement aggregate validation summary generation in `scripts/batch-parity-lib.cjs`
- [x] T035 [US3] Implement multi-failure collection before assertion failure in `scripts/test_batch_processing_cases.cjs`
- [x] T036 [US3] Replace ad hoc console output with privacy-safe summary reporting in `scripts/test_batch_processing_cases.cjs`
- [x] T037 [US3] Run `npm run test:batch:webapp` with temporary local negative cases and keep only production-safe assertions in `scripts/test_batch_processing_cases.cjs`

**Checkpoint**: All user stories are independently functional through the batch validation entry point.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, documentation consistency, and quality-gate checks across all stories.

- [x] T038 [P] Update implementation notes and expected diagnostics in `specs/002-batch-processing-parity/quickstart.md`
- [x] T039 [P] Review `specs/002-batch-processing-parity/contracts/batch-parity-contract.md` against final helper names and fixture policy fields
- [x] T040 [P] Run `npm run test:processing` and resolve failures in `web/js/modules/sct-processing.js` or `scripts/test_sct_processing.cjs`
- [x] T041 Run `npm run test:batch:webapp` and resolve failures in `scripts/test_batch_processing_cases.cjs`
- [x] T042 Run `npm run lint` and resolve JavaScript syntax issues in `web/**/*.js`
- [x] T043 Run `npm test` and resolve full gate failures in `scripts/test_batch_processing_cases.cjs`, `scripts/test_sct_processing.cjs`, or `web/**/*.js`
- [x] T044 Verify git diff contains no patient data, voxel dumps, screenshots, or generated binary fixture churn in `test_data/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion; blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational; MVP.
- **User Story 2 (Phase 4)**: Depends on Foundational and benefits from US1 coverage mapping.
- **User Story 3 (Phase 5)**: Depends on Foundational and benefits from US1/US2 result objects.
- **Polish (Phase 6)**: Depends on desired user stories being complete.

### User Story Dependencies

- **US1 Verify Every Batch Step Has Browser Coverage**: Start after Phase 2; no dependency on US2 or US3.
- **US2 Verify Outputs Match Reference Fixtures**: Start after Phase 2; uses the Batch Step identities from US1 if US1 is already complete.
- **US3 Preserve Clear Regression Signals**: Start after Phase 2; most valuable after US1 and US2 produce failure results.

### Within Each User Story

- Test tasks should be written first and observed failing where practical.
- Helper implementation in `scripts/batch-parity-lib.cjs` should land before wiring assertions in `scripts/test_batch_processing_cases.cjs`.
- Diagnostics must stay privacy-safe before negative-case testing is considered complete.
- Story checkpoints require `npm run test:batch:webapp` to pass for that story's scope.

### Parallel Opportunities

- T003 and T004 can run in parallel after T001/T002 are clear.
- T009 can run in parallel with T005-T008.
- US1 test tasks T011-T013 should run serially because they edit the same test file.
- US2 test tasks T020-T022 should run serially because they edit the same test file.
- US3 test tasks T031-T033 should run serially because they edit the same test file.
- Polish documentation review T038-T039 and processing test run T040 can run in parallel.

---

## Parallel Example: User Story 1

```bash
Task: "Create shared batch parity helper module skeleton in scripts/batch-parity-lib.cjs"
Task: "Create explicit fixture policy table skeleton in scripts/batch-parity-fixtures.cjs"
Task: "Document the local implementation checklist in specs/002-batch-processing-parity/quickstart.md"
```

## Parallel Example: User Story 2

```bash
Task: "Populate initial fixture case policies for existing test_data/batch_* directories in scripts/batch-parity-fixtures.cjs"
Task: "Review specs/002-batch-processing-parity/contracts/batch-parity-contract.md against final helper names and fixture policy fields"
```

## Parallel Example: User Story 3

```bash
Task: "Implement aggregate validation summary generation in scripts/batch-parity-lib.cjs"
Task: "Update implementation notes and expected diagnostics in specs/002-batch-processing-parity/quickstart.md"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 setup.
2. Complete Phase 2 foundational helper contracts.
3. Complete Phase 3 User Story 1.
4. Stop and validate with `npm run test:batch:webapp`.

### Incremental Delivery

1. Deliver US1 to guarantee every active batch command has a browser equivalent.
2. Deliver US2 to enforce output fixture parity for artifact-producing steps.
3. Deliver US3 to improve regression diagnostics and privacy-safe reporting.
4. Complete Polish tasks and run `npm test`.

### Parallel Team Strategy

1. Complete Setup and Foundational phases together.
2. Split US1 test cases, US2 fixture comparison tests, and US3 diagnostic tests across separate workers.
3. Integrate through `scripts/batch-parity-lib.cjs`, then serialize final wiring in `scripts/test_batch_processing_cases.cjs`.
