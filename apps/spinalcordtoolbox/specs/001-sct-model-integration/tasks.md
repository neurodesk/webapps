# Tasks: SCT Model Integration

**Input**: Design documents from `/specs/001-sct-model-integration/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md
**Tests**: Testing and documented validation are required for every touched surface by the constitution and this feature spec.
**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because the task touches different files and has no dependency on incomplete tasks
- **[Story]**: User story label for story phases only
- Every task includes exact file paths

## Phase 1: Setup

**Purpose**: Prepare shared SCT migration scaffolding and remove ambiguity before story work starts.

- [X] T001 Create SCT task metadata module scaffold in `web/js/app/sct-tasks.js`
- [X] T002 Create initial SCT model manifest file in `web/models/manifest.json`
- [X] T003 [P] Add SCT model download script scaffold in `scripts/download_sct_models.py`
- [X] T004 [P] Add SCT model conversion script scaffold in `scripts/convert_sct_models.py`
- [X] T005 [P] Add SCT model validation script scaffold in `scripts/validate_sct_models.py`
- [X] T006 [P] Add validation report output directory with README in `specs/001-sct-model-integration/validation/README.md`

---

## Phase 2: Foundational

**Purpose**: Blocking prerequisites required before any user story can be completed.

**CRITICAL**: No user story work can begin until this phase is complete.

- [X] T007 Encode the `model-manifest.schema.json` contract into validation logic in `scripts/validate_sct_models.py`
- [X] T008 Implement SCT stable task inventory discovery or curated inventory loading in `scripts/download_sct_models.py`
- [X] T009 Define default `spinalcord` task metadata, labels, provenance fields, and cache keys in `web/models/manifest.json`
- [X] T010 Wire `web/js/app/config.js` to read SCT task/model defaults from `web/js/app/sct-tasks.js`
- [X] T011 Update `web/js/app/labels.js` to expose task-specific SCT label definitions instead of a single global segmentation label set
- [X] T012 Update model cache naming and invalidation to use SCT task/model asset keys in `web/js/app/config.js`
- [X] T013 Update worker inference parameter contract to accept `taskId`, `modelAssetId`, labels, and manifest provenance in `web/js/inference-worker.js`
- [X] T014 Update `web/js/controllers/InferenceExecutor.js` to pass selected SCT task metadata to the worker
- [X] T015 Confirm no patient-derived data is written to model manifest, cache keys, logs, or telemetry fields in `web/js/app/sct-tasks.js` and `web/js/inference-worker.js`
- [X] T016 Validate foundational JavaScript syntax with `npm run lint` using `package.json` and `scripts/check-syntax.mjs`
- [X] T017 Validate model manifest schema failure and success cases with `python scripts/validate_sct_models.py --manifest web/models/manifest.json`

**Checkpoint**: SCT task metadata, manifest validation, worker parameter contracts, and privacy boundaries are ready.

---

## Phase 3: User Story 1 - Run SCT Spinal Cord Segmentation (Priority: P1)

**Goal**: Users can run the default SCT `spinalcord` task from file load to overlay and NIfTI download.

**Independent Test**: Load representative non-patient spinal cord MRI data, select the default SCT `spinalcord` task, run segmentation, inspect overlay, download NIfTI, and compare metadata and mask behavior against SCT stable reference output.

### Tests and Validation for User Story 1

- [X] T018 [P] [US1] Add default spinal cord manifest validation fixture in `specs/001-sct-model-integration/validation/spinalcord-manifest.fixture.json`
- [X] T019 [P] [US1] Add SCT reference comparison instructions for default spinal cord output in `specs/001-sct-model-integration/validation/spinalcord-reference.md`
- [X] T020 [US1] Extend `scripts/validate_sct_models.py` to validate default `spinalcord` asset presence, checksum, labels, and provenance in `web/models/manifest.json`
- [X] T021 [US1] Add browser workflow validation notes for the default `spinalcord` task in `specs/001-sct-model-integration/validation/browser-spinalcord.md`

### Implementation for User Story 1

- [X] T022 [US1] Implement default SCT `spinalcord` asset download path in `scripts/download_sct_models.py`
- [X] T023 [US1] Implement default SCT `spinalcord` asset conversion path in `scripts/convert_sct_models.py`
- [X] T024 [US1] Replace default model filenames with SCT `spinalcord` assets in `web/models/manifest.json`
- [X] T025 [US1] Update default task selection and model loading in `web/js/app/sct-tasks.js`
- [X] T026 [US1] Update inference model resolution to use selected SCT model asset from the manifest in `web/js/inference-worker.js`
- [X] T027 [US1] Update output filename and provenance generation for SCT `spinalcord` downloads in `web/js/spinalcordtoolbox-app.js`
- [X] T028 [US1] Update overlay colormap registration for SCT spinal cord labels in `web/js/controllers/ViewerController.js`
- [X] T029 [US1] Update primary UI title, model selector copy, run controls, about modal, privacy modal, and footer for SCT `spinalcord` workflow in `web/index.html`
- [X] T030 [US1] Remove obsolete obsolete ONNX assets from active model references in `web/models/manifest.json`
- [X] T031 [US1] Run `python scripts/download_sct_models.py --stable --task spinalcord --output .tmp_sct_models`
- [X] T032 [US1] Run `python scripts/convert_sct_models.py --input .tmp_sct_models --task spinalcord --output web/models`
- [X] T033 [US1] Run `python scripts/validate_sct_models.py --manifest web/models/manifest.json --task spinalcord`
- [X] T034 [US1] Run `npm run lint` using `package.json` and `scripts/check-syntax.mjs`
- [ ] T035 [US1] Run local browser workflow from `specs/001-sct-model-integration/quickstart.md` and record result in `specs/001-sct-model-integration/validation/browser-spinalcord.md`

**Checkpoint**: Default SCT spinal cord workflow is complete, independently usable, and validated.

---

## Phase 4: User Story 2 - Choose Supported SCT Tasks (Priority: P2)

**Goal**: Users can inspect and select supported SCT tasks, while unsupported or unvalidated SCT stable tasks are visible with clear reasons.

**Independent Test**: Open the task selector, confirm SCT task metadata and statuses are shown, verify unsupported tasks cannot run, and run one additional supported task if available.

### Tests and Validation for User Story 2

- [X] T036 [P] [US2] Add SCT task inventory fixture covering supported, unvalidated, unsupported, and retired states in `specs/001-sct-model-integration/validation/task-inventory.fixture.json`
- [X] T037 [P] [US2] Add UI task contract validation checklist in `specs/001-sct-model-integration/validation/ui-task-contract.md`
- [X] T038 [US2] Extend `scripts/validate_sct_models.py` to validate supported, unvalidated, unsupported, and retired task states from `web/models/manifest.json`

### Implementation for User Story 2

- [X] T039 [US2] Add SCT stable task categories and task list to `web/models/manifest.json`
- [X] T040 [US2] Add task filtering, status helpers, and default task selection helpers in `web/js/app/sct-tasks.js`
- [X] T041 [US2] Replace existing model selector options with SCT task selector rendering in `web/js/spinalcordtoolbox-app.js`
- [X] T042 [US2] Add unsupported and unvalidated task disabled states in `web/js/spinalcordtoolbox-app.js`
- [X] T043 [US2] Add task detail copy for anatomy, contrast, asset status, validation status, and unsupported reason in `web/index.html`
- [X] T044 [US2] Update worker and executor error messages for missing, unsupported, stale, or oversized task assets in `web/js/inference-worker.js`
- [X] T045 [US2] Update cache lookup and retry behavior for task-specific assets in `web/js/inference-worker.js`
- [X] T046 [US2] Run `python scripts/validate_sct_models.py --manifest web/models/manifest.json --all-tasks`
- [X] T047 [US2] Run task selector browser validation and record results in `specs/001-sct-model-integration/validation/ui-task-contract.md`
- [X] T048 [US2] Run `npm run lint` using `package.json` and `scripts/check-syntax.mjs`

**Checkpoint**: SCT task selection is complete and independently verifiable.

---

## Phase 5: User Story 3 - Maintain SCT Documentation and Provenance (Priority: P3)

**Goal**: Developers and reviewers can understand SCT model provenance, setup, validation, citations, and supported task status from repository documentation.

**Independent Test**: Follow the documented setup and validation workflow from a fresh checkout and confirm no obsolete obsolete model terminology remains in active docs, UI, config, scripts, or model filenames.

### Tests and Validation for User Story 3

- [X] T049 [P] [US3] Add documentation validation checklist in `specs/001-sct-model-integration/validation/documentation-checklist.md`
- [X] T050 [P] [US3] Add obsolete terminology scan command and expected result to `specs/001-sct-model-integration/validation/documentation-checklist.md`
- [X] T051 [US3] Validate README setup commands against SCT scripts and record results in `specs/001-sct-model-integration/validation/documentation-checklist.md`

### Implementation for User Story 3

- [X] T052 [US3] Rewrite project overview, quick start, features, model assets, pipeline, validation, citations, and privacy sections in `README.md`
- [X] T053 [US3] Update agent guidance for SCT task inventory and model validation in `AGENTS.md`
- [X] T054 [US3] Update setup messaging and required model asset instructions in `web/setup.sh`
- [X] T055 [US3] Update development server banner and user-facing app naming in `web/run.sh`
- [X] T056 [US3] Update inline script help and examples in `scripts/download_sct_models.py`
- [X] T057 [US3] Update inline script help and examples in `scripts/convert_sct_models.py`
- [X] T058 [US3] Update inline script help and examples in `scripts/validate_sct_models.py`
- [X] T059 [US3] Remove obsolete model conversion, download, and validation wrapper scripts
- [X] T060 [US3] Update citation modal SCT references in `web/index.html`
- [X] T061 [US3] Run obsolete model terminology scan across README.md, AGENTS.md, web, and scripts
- [X] T062 [US3] Run `npm run lint` using `package.json` and `scripts/check-syntax.mjs`

**Checkpoint**: Documentation and provenance are complete and independently reviewable.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification across all stories and release/deploy surfaces.

- [X] T063 Run full manifest validation with `python scripts/validate_sct_models.py --manifest web/models/manifest.json --all-tasks`
- [X] T064 Run JavaScript syntax validation with `npm run lint` using `package.json` and `scripts/check-syntax.mjs`
- [X] T065 Run setup verification with `cd web && bash setup.sh`
- [X] T066 Verify browser app serves renamed SCT entrypoint with `cd web && bash run.sh`
- [X] T067 Verify model assets are cacheable and patient-derived data is not cached in `web/js/inference-worker.js`
- [X] T068 Verify release workflow still avoids manual version bumps in `.github/workflows/release.yml`
- [X] T069 Verify deploy workflow still runs JS lint and WASM setup in `.github/workflows/deploy-pages.yml`
- [X] T070 Update quickstart validation outcomes in `specs/001-sct-model-integration/quickstart.md`
- [X] T071 Final review of `web/models/manifest.json`, `web/js/app/sct-tasks.js`, `web/js/inference-worker.js`, `web/index.html`, and `README.md` against constitution gates

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational completion. This is the MVP.
- **User Story 2 (Phase 4)**: Depends on Foundational completion and can proceed after US1 task metadata conventions are stable.
- **User Story 3 (Phase 5)**: Depends on Foundational completion; final documentation examples depend on US1 and US2 outcomes.
- **Polish (Phase 6)**: Depends on all desired user stories.

### User Story Dependencies

- **US1**: Independent after Foundation; delivers default SCT spinal cord segmentation.
- **US2**: Builds on the shared manifest and task selector contracts; can be implemented after US1 default task shape is established.
- **US3**: Can start in parallel for general docs, but final setup/validation documentation depends on US1 and US2.

### Within Each User Story

- Tests and validation tasks come before implementation verification.
- Manifest/schema changes precede UI and worker integration.
- Asset download/conversion precedes model validation.
- Worker message contract changes precede UI execution wiring.
- Story checkpoint validation must pass before moving to the next priority if working sequentially.

## Parallel Opportunities

- Setup scaffolds T003, T004, T005, and T006 can run in parallel.
- US1 validation docs T018 and T019 can run in parallel.
- US2 inventory fixture T036 and UI checklist T037 can run in parallel.
- US3 documentation checklist tasks T049 and T050 can run in parallel.
- UI copy updates and script help updates in US3 can run in parallel after core behavior stabilizes.

## Parallel Example: User Story 1

```bash
# Parallel validation setup:
Task: "T018 [P] [US1] Add default spinal cord manifest validation fixture in specs/001-sct-model-integration/validation/spinalcord-manifest.fixture.json"
Task: "T019 [P] [US1] Add SCT reference comparison instructions for default spinal cord output in specs/001-sct-model-integration/validation/spinalcord-reference.md"
```

## Parallel Example: User Story 2

```bash
# Parallel task selector validation setup:
Task: "T036 [P] [US2] Add SCT task inventory fixture covering supported, unvalidated, unsupported, and retired states in specs/001-sct-model-integration/validation/task-inventory.fixture.json"
Task: "T037 [P] [US2] Add UI task contract validation checklist in specs/001-sct-model-integration/validation/ui-task-contract.md"
```

## Parallel Example: User Story 3

```bash
# Parallel documentation validation setup:
Task: "T049 [P] [US3] Add documentation validation checklist in specs/001-sct-model-integration/validation/documentation-checklist.md"
Task: "T050 [P] [US3] Add obsolete terminology scan command and expected result to specs/001-sct-model-integration/validation/documentation-checklist.md"
```

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 only.
3. Validate that the default SCT `spinalcord` workflow runs from load to output download.
4. Stop and review model provenance, output fidelity, and browser performance before adding more tasks.

### Incremental Delivery

1. Foundation: manifest, schema validation, task metadata, worker contract.
2. US1: default SCT spinal cord segmentation.
3. US2: supported/unvalidated/unsupported SCT task selector states.
4. US3: documentation, provenance, setup, and validation instructions.
5. Polish: full validation and release/deploy checks.

### Risk Controls

- Do not mark any SCT task `supported` until assets are downloaded/converted and reference validation is recorded.
- Do not cache patient-derived data.
- Do not manually bump `web/js/app/config.js` version.
- Keep heavy processing inside `web/js/inference-worker.js`.
- Preserve recoverable fallback states for missing assets, unsupported tasks, and unavailable browser acceleration.
