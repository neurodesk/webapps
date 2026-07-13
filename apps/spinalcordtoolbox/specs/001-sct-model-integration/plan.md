# Implementation Plan: SCT Model Integration

**Branch**: `001-sct-model-integration` | **Date**: 2026-04-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-sct-model-integration/spec.md`

## Summary

Replace the current renamed previous model browser segmentation workflow
with a Spinal Cord Toolbox stable segmentation workflow. The implementation will
build an SCT task inventory from the stable `sct_deepseg` task families, prepare
browser-runnable model assets where possible, mark non-convertible or multi-input
tasks as unsupported with reasons, update the UI/documentation/citations, and
validate representative browser outputs against SCT stable behavior.

## Technical Context

**Language/Version**: JavaScript ES modules for UI, `importScripts()` worker script, Python utility scripts for model preparation and validation  
**Primary Dependencies**: ONNX Runtime Web, NiiVue, dcm2niix WASM, nifti-reader-js, localforage, SCT stable model/task metadata, Python SCT tooling for asset discovery and reference validation  
**Storage**: Browser model cache/localforage for model assets only; `web/models/` for packaged browser-runnable assets; no patient-derived cache entries  
**Testing**: `npm run lint`, model manifest validation, setup/download dry run, browser workflow verification, SCT reference comparison for representative data, telemetry payload inspection if telemetry is emitted  
**Target Platform**: Modern desktop browser served from GitHub Pages, ONNX Runtime Web with WebGPU/WASM fallback  
**Project Type**: Browser-based medical imaging segmentation app  
**Performance Goals**: Main thread remains responsive during model loading and large-volume inference; memory growth is bounded by explicit model/task limits; unsupported large or incompatible tasks fail with recoverable messaging  
**Constraints**: Confidential browser-local patient data, telemetry limited to non-patient usage statistics, DICOM/NIfTI fidelity, SCT label semantics, reference pipeline parity, `importScripts()` worker compatibility, WebGPU/WASM fallback  
**Scale/Scope**: Inventory covers SCT stable `sct_deepseg` task families; implementation supports the default `spinalcord` task first and any additional tasks whose assets can be downloaded, converted, validated, and run in-browser within cache/performance limits

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Patient-data confidentiality and telemetry**: PASS. Patient image data,
  metadata, filenames, logs, derived volumes, masks, segmentations, and outputs
  remain in the browser session. Telemetry is not required; if later added, only
  task/model identifiers and non-patient status fields are permitted.
- **Imaging semantics and output fidelity**: PASS. The plan requires NIfTI
  orientation, spacing, affine, dimensions, datatype, scaling, and SCT label
  semantics to be documented and validated for each supported task.
- **Reference pipeline parity**: PASS. SCT stable behavior is the reference.
  Browser results must be compared against SCT stable output for representative
  data, or the task must be marked unsupported/unvalidated.
- **Progressive runtime capability**: PASS. WebGPU, model cache,
  conversion artifacts, and alternate assets all have
  recoverable fallback or unsupported states.
- **Browser performance and worker discipline**: PASS. Inference stays in the
  existing worker path, with explicit attention to memory, transferables, cache
  size, abort behavior, and browser compatibility.
- **Model, asset, and cache stewardship**: PASS. Every SCT model asset must have
  source, release/version, format, task, labels, validation status, and cache key
  captured in a manifest.
- **Release discipline**: PASS. The plan avoids manual config version bumps and
  preserves release/deploy lint and setup checks.
- **Testing**: PASS. The plan defines concrete validation for model prep, UI,
  output export, reference parity, docs, and privacy/telemetry.

## Project Structure

### Documentation (this feature)

```text
specs/001-sct-model-integration/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── model-manifest.schema.json
│   └── ui-task-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
web/
├── js/
│   ├── app/
│   │   ├── config.js
│   │   ├── labels.js
│   │   └── sct-tasks.js
│   ├── controllers/
│   ├── modules/
│   ├── spinalcordtoolbox-app.js
│   └── inference-worker.js
├── models/
│   ├── manifest.json
│   └── sct-*.onnx
├── dcm2niix/
├── nifti-js/
└── index.html

scripts/
├── download_sct_models.py
├── convert_sct_models.py
├── validate_sct_models.py
├── check-syntax.mjs
└── validate_sct_models.py

.github/workflows/
├── release.yml
├── staging-trigger.yml
└── deploy-pages.yml
```

**Structure Decision**: Keep the current browser app architecture. Add an SCT
task inventory module and model manifest rather than scattering task metadata
through UI and worker code. Keep all compute-heavy work in
`web/js/inference-worker.js`; UI code interacts via existing controller and
executor boundaries. Model preparation scripts live under `scripts/` and write
browser-ready artifacts plus `web/models/manifest.json`.

## Complexity Tracking

No constitution violations are required.
