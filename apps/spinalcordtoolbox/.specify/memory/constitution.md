<!--
Sync Impact Report
Version change: 2.0.0 -> 2.0.1
Modified principles:
- Development Workflow, Testing, and Quality Gates (removed-feature testing clarified)
Added sections:
- None
Removed sections:
- None
Templates requiring updates:
- ✅ .specify/templates/plan-template.md
- ✅ .specify/templates/spec-template.md
- ✅ .specify/templates/tasks-template.md
- ✅ .specify/templates/checklist-template.md
- ✅ .specify/templates/commands/*.md (not present)
- ✅ README.md (reviewed; no update required)
- ✅ AGENTS.md (reviewed; no update required)
- ✅ .github/workflows/*.yml (reviewed; no update required)
Follow-up TODOs:
- None
-->
# spinalcordtoolbox Constitution

## Core Principles

### I. Confidential Patient Data and Usage Telemetry
All patient image data, DICOM metadata, NIfTI volumes, derived intermediate
volumes, masks, segmentation labels, filenames, console messages containing
patient-derived values, and downloaded outputs MUST remain confidential and MUST
NOT be uploaded or persisted to a remote service. Patient-derived content MUST
remain inside the user's browser session unless the user explicitly downloads an
output file.

Telemetry MAY be used to track non-patient usage statistics, including feature
usage events, application version, model selection identifiers, browser
capability categories, performance timings, and non-patient error categories.
Telemetry MUST NOT include patient image data, DICOM metadata, NIfTI headers,
filenames, voxel values, dimensions traceable to a specific patient, screenshots,
free-text patient-derived logs, masks, segmentations, or downloaded outputs.
Telemetry changes MUST document the collected fields, purpose, retention, and
user-facing disclosure before implementation.

The privacy modal, README privacy statement, and any new UI text about data
handling MUST stay consistent with this boundary. Any proposal for remote
patient-data processing, server-side conversion, or shared debugging artifacts
containing patient-derived content MUST be treated as a MAJOR governance change.

Rationale: The product promise is confidential medical imaging analysis with
permitted non-patient usage statistics for product and reliability improvement.

### II. Imaging Semantics and Output Fidelity
Features that read, convert, transform, display, or export DICOM, NIfTI, affine
metadata, orientation, voxel spacing, dimensions, intensity scaling, masks, or
labels MUST preserve medical imaging semantics unless a named pipeline step
intentionally changes them. DICOM conversion MUST remain traceable through the
vendored dcm2niix path. NIfTI output generation MUST preserve or deliberately
reconstruct header, affine, datatype, scaling, and pixel dimension behavior.

Binary segmentation semantics are fixed: `0` is Background and `1` is segmentation.
Changes to labels, colormaps, threshold defaults, component filtering, or mask
application MUST document the expected output meaning and include validation for
representative images.

Rationale: A segmentation output is useful only when spatial metadata and label
meaning are correct and inspectable.

### III. Reference Pipeline Parity
Changes to parsing, RAS orientation, target spacing, N4 bias correction, brain
extraction, denoising, padding to 64-voxel patch multiples, normalization,
sliding-window inference, sigmoid thresholding, connected-component filtering,
inverse resize, inverse orientation, or NIfTI export MUST preserve parity with
the validated workflow or document the deliberate divergence.

Validation MUST use the existing comparison scripts when applicable, including
`scripts/validate_sct_models.py`, SCT model conversion scripts, SynthStrip
checks, or a documented manual comparison when representative automated data
cannot be included. Inference behavior MUST be deterministic for the same input,
selected model, configuration, and available execution provider.

Rationale: The browser implementation is a translation of a scientific pipeline,
so reproducibility and traceable deviations are required.

### IV. Progressive Runtime Capability
The baseline app MUST remain usable when optional Rust WASM preprocessing is
missing, when WebGPU is unavailable, or when a user skips optional pipeline
steps. ONNX Runtime provider fallback from WebGPU to WASM MUST remain explicit.
N4, traditional BET, and NLM denoising MUST report unavailable, skipped, failed,
running, and completed states without corrupting worker state.

SynthStrip, Spinalcordtoolbox model variants, dcm2niix, local model cache behavior,
and preprocessing WASM loading MUST fail with visible, recoverable user feedback.
New features MUST NOT silently turn optional assets into required assets for the
core load-view-segment-download workflow.

Rationale: The codebase is intentionally structured around interactive pipeline
steps and browser capability differences.

### V. Browser Performance and Worker Discipline
Large 3D volume processing, model loading, DICOM conversion, preprocessing, and
inference MUST protect main-thread responsiveness. Long-running work MUST run in
the existing worker, a justified worker boundary, WASM, or a browser-native
asynchronous path. Plans that touch these paths MUST identify memory use,
transferable buffers, cache impact, abort behavior, and browser compatibility.

The inference worker MUST remain compatible with `importScripts()` and non-ES
module worker loading. JavaScript modules under `web/js/controllers/` and
`web/js/modules/` MUST preserve clear controller/module boundaries. Rust
preprocessing MUST remain buildable for the web target through `web/setup.sh`
and `rust-preprocessing/build.sh`.

Rationale: Client-side segmentation only works when the app stays responsive and
the runtime contracts between UI, worker, ONNX, WASM, and viewer remain stable.

## Model, Asset, and Cache Stewardship

Model assets under `web/models/` are part of the user-facing scientific
workflow. Any addition, replacement, renaming, quantization, or removal MUST
document the model source, intended modality, expected patch size, output class
count, and validation method. The configured spinalcordtoolbox variants and
SynthStrip model entries in `web/js/app/config.js` MUST stay consistent with the
actual files shipped in `web/models/`.

Model and runtime caching MUST respect the configured browser cache size and
MUST NOT cache patient-derived data. Cache invalidation MUST account for the app
version and model filename when model behavior changes.

## Architecture and Release Constraints

The main application orchestration lives in `web/js/spinalcordtoolbox-app.js`; file
I/O, DICOM conversion, inference execution, and viewer behavior belong in their
existing controller boundaries unless a plan justifies moving responsibilities.
Reusable UI and pipeline behavior belongs under `web/js/modules/`.

The inference worker at `web/js/inference-worker.js` owns pipeline state,
transferable intermediate artifacts, and compute-heavy processing. UI code MUST
interact with it through `InferenceExecutor` message contracts rather than
duplicating worker state.

Application version values in `web/js/app/config.js` MUST NOT be bumped manually;
the release workflow owns version bumping. Release and deployment changes MUST
preserve the staging/main GitHub Actions flow, JavaScript syntax lint gate,
Rust/WASM build, setup script, and GitHub Pages artifact layout unless a plan
documents a replacement with equivalent checks.

## Development Workflow, Testing, and Quality Gates

Every feature spec MUST include independently testable user scenarios and
acceptance criteria for the affected imaging workflow, UI workflow, model asset,
telemetry behavior, or release workflow. Specs that touch image data MUST
include patient confidentiality, orientation/spacing, label, and export
expectations. Specs that touch telemetry MUST include the permitted event fields,
retention expectations, disclosure requirements, and proof that patient-derived
content is excluded.

Every implementation plan MUST pass the Constitution Check before Phase 0
research and again after Phase 1 design. Any violation MUST be recorded in
Complexity Tracking with the rejected simpler alternative.

Tasks MUST include concrete testing or validation work for every touched
current or replacement surface. Testing MUST target supported behavior, data
contracts, migration effects, and user workflows that remain after the change.
When a feature, UI control, pipeline step, or code path is intentionally removed,
teams MUST NOT add or retain tests whose only assertion is that the removed
functionality is absent. Removal work SHOULD delete obsolete tests and validate
any remaining supported workflow affected by the removal.

JavaScript changes MUST run `npm run lint` before commit. Changes to Rust
preprocessing MUST include a WASM build check or documented reason it was
unavailable. Changes to inference, preprocessing, DICOM/NIfTI handling,
orientation, spacing, labels, model assets, model configuration, or export
behavior MUST include validation against representative imaging data, reference
pipeline output, or documented manual verification when automated data is
unavailable. Telemetry changes MUST include tests or documented inspection that
verify only approved non-patient fields are emitted.

## Governance

This constitution supersedes conflicting development practices and generated
Spec Kit guidance. Amendments require a written change to this file, an updated
Sync Impact Report, and review of dependent templates and runtime guidance.

Versioning follows semantic versioning. MAJOR changes remove or redefine a core
principle, permit remote patient-data processing, materially change telemetry
permissions, or redefine the supported baseline workflow. MINOR changes add a
principle, governance section, or materially expand required quality gates.
PATCH changes clarify language without changing obligations.

Compliance review is required for every feature plan, task list, and code review
that touches governed behavior. Reviewers MUST verify patient-data
confidentiality, telemetry field minimization, imaging fidelity, reference
parity, runtime fallbacks, worker discipline, model asset stewardship, release
constraints, and required testing or validation evidence before approval.

**Version**: 2.0.1 | **Ratified**: 2026-04-27 | **Last Amended**: 2026-04-28
