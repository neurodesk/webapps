# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., JavaScript ES modules for UI, `importScripts()` worker script, Rust 2021 WASM or NEEDS CLARIFICATION]  
**Primary Dependencies**: [e.g., ONNX Runtime Web, NiiVue, dcm2niix WASM, nifti-reader-js, wasm-bindgen, qsm-core or NEEDS CLARIFICATION]  
**Storage**: [if applicable, e.g., browser model cache/localforage for model assets only, downloaded files, or N/A]  
**Testing**: [e.g., npm run lint, unit/integration tests, scripts/validate_sct_models.py, SynthStrip validation scripts, WASM build check, telemetry payload inspection, manual imaging workflow verification or NEEDS CLARIFICATION]  
**Target Platform**: [e.g., modern desktop browser, GitHub Pages, ONNX Runtime Web with WebGPU/WASM fallback or NEEDS CLARIFICATION]
**Project Type**: Browser-based medical imaging segmentation app  
**Performance Goals**: [e.g., responsive UI during large 3D volume processing, bounded memory growth, worker-based long-running work, cache size impact or NEEDS CLARIFICATION]  
**Constraints**: Confidential browser-local patient data, telemetry limited to non-patient usage statistics, DICOM/NIfTI fidelity, task-specific segmentation labels, reference pipeline parity, `importScripts()` worker compatibility, optional WASM preprocessing, WebGPU/WASM fallback  
**Scale/Scope**: [e.g., expected image dimensions, model file size, cache footprint, browser support, workflow count or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Patient-data confidentiality and telemetry**: Does the feature keep patient
  image data, metadata, filenames, logs, derived volumes, masks, segmentations,
  and outputs confidential and inside the browser session? If telemetry is
  touched, are collected fields limited to documented non-patient usage
  statistics with disclosure, purpose, and retention captured?
- **Imaging semantics and output fidelity**: Are DICOM/NIfTI orientation,
  spacing, affine, dimensions, intensity scaling, masks, exports, and binary
  labels preserved or explicitly transformed with validation?
- **Reference pipeline parity**: Does the plan preserve SCT task reference
  behavior for parsing, orientation, target spacing, preprocessing, inference,
  thresholding, postprocessing, and inverse transforms, or document divergence
  and validation evidence?
- **Progressive runtime capability**: Does the baseline load-view-segment-download
  workflow still work when optional Rust WASM preprocessing, WebGPU, model cache,
  or alternative assets are unavailable?
- **Browser performance and worker discipline**: Are memory, responsiveness,
  transferable buffers, abort behavior, worker boundaries, WASM, ONNX Runtime Web,
  and model-loading risks identified and mitigated?
- **Model, asset, and cache stewardship**: Are model filenames, modality,
  patch size, class count, source, validation method, and cache invalidation
  documented for model or asset changes?
- **Release discipline**: Does the plan avoid manual config version bumps and
  preserve staging/main release, JavaScript lint, WASM build, setup, and deploy
  paths?
- **Testing**: Does the plan define concrete tests or validation for every
  touched current or replacement surface, delete obsolete tests for intentionally
  removed functionality, and avoid absence-only tests for removed controls or
  code paths? Does it include telemetry payload inspection when telemetry is
  added or changed?

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
web/
├── js/
│   ├── app/
│   ├── controllers/
│   ├── modules/
│   ├── spinalcordtoolbox-app.js
│   └── inference-worker.js
├── models/
├── dcm2niix/
├── nifti-js/
├── preprocessing-wasm/
└── index.html

rust-preprocessing/
└── src/

scripts/
└── [validation and model conversion scripts]

.github/workflows/
└── [release, staging, and GitHub Pages deploy workflows]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
