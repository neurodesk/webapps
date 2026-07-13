---

description: "Task list template for feature implementation"
---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: The examples below include test tasks. Testing or documented
validation is REQUIRED for every touched current or replacement surface. Do not
add tasks or tests whose only assertion is that intentionally removed
functionality is absent; delete obsolete tests instead. JavaScript changes
require `npm run lint`. Imaging, inference, preprocessing, DICOM/NIfTI,
orientation, spacing, label, model-configuration, model asset, cache, export,
telemetry, or release workflow changes require concrete validation tasks.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Web app**: `web/js/app/`, `web/js/controllers/`, `web/js/modules/`,
  `web/js/spinalcordtoolbox-app.js`, `web/js/inference-worker.js`
- **Models/assets**: `web/models/`, `web/preprocessing-wasm/`
- **Conversion/runtime assets**: `web/dcm2niix/`, `web/nifti-js/`, `web/wasm/`
- **Rust WASM preprocessing**: `rust-preprocessing/`
- **Scripts and validation**: `scripts/`
- **Release/deploy workflows**: `.github/workflows/`
- Paths shown below are samples - adjust based on plan.md structure

<!-- 
  ============================================================================
  IMPORTANT: The tasks below are SAMPLE TASKS for illustration purposes only.
  
  The /speckit-tasks command MUST replace these with actual tasks based on:
  - User stories from spec.md (with their priorities P1, P2, P3...)
  - Feature requirements from plan.md
  - Entities from data-model.md
  - Endpoints from contracts/
  
  Tasks MUST be organized by user story so each story can be:
  - Implemented independently
  - Tested independently
  - Delivered as an MVP increment
  
  DO NOT keep these sample tasks in the generated tasks.md file.
  ============================================================================
-->

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create project structure per implementation plan
- [ ] T002 Initialize [language] project with [framework] dependencies
- [ ] T003 [P] Configure linting and formatting tools

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

Examples of foundational tasks (adjust based on your project):

- [ ] T004 Confirm patient data remains confidential and browser-local for the planned workflow
- [ ] T005 [P] Identify DICOM/NIfTI orientation, spacing, affine, dimension, intensity scaling, export, and label invariants
- [ ] T006 [P] Confirm optional WASM preprocessing, WebGPU/WASM provider, model cache, and asset fallback behavior
- [ ] T007 Define reference-pipeline, representative-data, script-based, or manual validation method
- [ ] T008 Confirm worker/WASM/ONNX Runtime Web compatibility, transferable buffer, memory, and abort constraints
- [ ] T009 Configure or update recoverable error handling, UI status reporting, and console output
- [ ] T010 Define required tests or documented validation for every touched current or replacement surface
- [ ] T011 Confirm telemetry fields are non-patient usage statistics if telemetry is touched

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - [Title] (Priority: P1) 🎯 MVP

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 1 (OPTIONAL - only if tests requested) ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T012 [P] [US1] Validation for imaging invariants in scripts/[validation].py or documented manual workflow
- [ ] T013 [P] [US1] Browser workflow verification for [user journey] in web/
- [ ] T014 [P] [US1] Telemetry payload inspection for approved non-patient fields if telemetry is touched

### Implementation for User Story 1

- [ ] T015 [P] [US1] Create [Entity1] model in src/models/[entity1].py
- [ ] T016 [P] [US1] Create [Entity2] model in src/models/[entity2].py
- [ ] T017 [US1] Implement [Service] in src/services/[service].py (depends on T015, T016)
- [ ] T018 [US1] Implement [endpoint/feature] in src/[location]/[file].py
- [ ] T019 [US1] Add validation and error handling
- [ ] T020 [US1] Add logging for user story 1 operations

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - [Title] (Priority: P2)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 2 (OPTIONAL - only if tests requested) ⚠️

- [ ] T021 [P] [US2] Contract test for [endpoint] in tests/contract/test_[name].py
- [ ] T022 [P] [US2] Integration test for [user journey] in tests/integration/test_[name].py

### Implementation for User Story 2

- [ ] T023 [P] [US2] Create [Entity] model in src/models/[entity].py
- [ ] T024 [US2] Implement [Service] in src/services/[service].py
- [ ] T025 [US2] Implement [endpoint/feature] in src/[location]/[file].py
- [ ] T026 [US2] Integrate with User Story 1 components (if needed)

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - [Title] (Priority: P3)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 3 (OPTIONAL - only if tests requested) ⚠️

- [ ] T027 [P] [US3] Contract test for [endpoint] in tests/contract/test_[name].py
- [ ] T028 [P] [US3] Integration test for [user journey] in tests/integration/test_[name].py

### Implementation for User Story 3

- [ ] T029 [P] [US3] Create [Entity] model in src/models/[entity].py
- [ ] T030 [US3] Implement [Service] in src/services/[service].py
- [ ] T031 [US3] Implement [endpoint/feature] in src/[location]/[file].py

**Checkpoint**: All user stories should now be independently functional

---

[Add more user story phases as needed, following the same pattern]

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] TXXX [P] Documentation updates in docs/
- [ ] TXXX Code cleanup and refactoring
- [ ] TXXX Performance optimization across all stories
- [ ] TXXX [P] Additional unit tests (if requested) in tests/unit/
- [ ] TXXX Privacy review for confidential browser-local patient-data handling
- [ ] TXXX Verify telemetry emits only documented non-patient usage statistics where telemetry is touched
- [ ] TXXX Verify optional preprocessing fallback behavior
- [ ] TXXX Verify WebGPU unavailable / WASM provider fallback behavior where inference is touched
- [ ] TXXX Verify model asset metadata, cache behavior, and config filename alignment where assets are touched
- [ ] TXXX Run `bash rust-preprocessing/build.sh` or `cd web && bash setup.sh` for Rust/WASM preprocessing changes
- [ ] TXXX Run `npm run lint` for JavaScript changes
- [ ] TXXX Run quickstart.md validation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - May integrate with US1 but should be independently testable
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - May integrate with US1/US2 but should be independently testable

### Within Each User Story

- Tests or validation tasks required by the constitution MUST be completed for every touched current or replacement surface
- Obsolete tests for intentionally removed functionality MUST be deleted rather than replaced with absence-only checks
- Data invariants before transforms
- Model/config/cache alignment before UI selection changes
- Worker message contracts before UI integration
- Core implementation before integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel (within Phase 2)
- Once Foundational phase completes, all user stories can start in parallel (if team capacity allows)
- All tests for a user story marked [P] can run in parallel
- Models within a story marked [P] can run in parallel
- Different user stories can be worked on in parallel by different team members

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together (if tests requested):
Task: "Contract test for [endpoint] in tests/contract/test_[name].py"
Task: "Integration test for [user journey] in tests/integration/test_[name].py"

# Launch all models for User Story 1 together:
Task: "Create [Entity1] model in src/models/[entity1].py"
Task: "Create [Entity2] model in src/models/[entity2].py"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently → Deploy/Demo
4. Add User Story 3 → Test independently → Deploy/Demo
5. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1
   - Developer B: User Story 2
   - Developer C: User Story 3
3. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
