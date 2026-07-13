# Implementation Plan: Batch Processing Parity

**Branch**: `002-batch-processing-parity` | **Date**: 2026-04-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-batch-processing-parity/spec.md`

## Summary

Extend the existing SCT browser processing validation so every active command in
`test_data/batch_processing.sh` is checked against a browser-app equivalent, and
every artifact-producing step is validated against expected fixtures in
`test_data`. The implementation will keep the current Node-based test entry
points, add an explicit batch-step and fixture parity contract, compare NIfTI
outputs with fixture-specific tolerance policies, and fail the suite for missing
fixtures, unevaluable parity, unsupported/native-only active steps, stale script
mappings, or output mismatches.

## Technical Context

**Language/Version**: JavaScript for validation scripts and browser processing modules; CommonJS-compatible tests; existing browser app JavaScript module patterns  
**Primary Dependencies**: Node.js built-in test/assert/filesystem utilities, `nifti-reader-js` for NIfTI fixture parsing, existing `web/js/modules/sct-processing.js`, `web/models/manifest.json`, and `test_data` reference fixtures  
**Storage**: Repository-local fixtures under `test_data`; no browser cache or patient-derived persistence changes  
**Testing**: `npm run lint`, `npm run test:processing`, `npm run test:batch:webapp`, and full `npm test` before completion  
**Target Platform**: Local and CI Node.js validation for a browser-based SCT MRI app; GitHub Pages runtime behavior unchanged  
**Project Type**: Browser-based medical imaging segmentation app with repository-local validation scripts  
**Performance Goals**: Batch parity tests should complete within normal local/CI test expectations, avoid retaining duplicate large volume buffers after each case, and report all actionable mismatches in one run where practical  
**Constraints**: Confidential browser-local patient data, fixture-only logs, DICOM/NIfTI fidelity, reference output parity, no unsupported/native-only passing states, no manual version bump, no telemetry changes, existing `importScripts()` worker compatibility remains untouched  
**Scale/Scope**: 62 active commands currently mapped from `test_data/batch_processing.sh`; 8 existing NIfTI input/output fixture directories; future artifact-producing batch steps require fixtures and tolerance policies

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Patient-data confidentiality and telemetry**: PASS. The feature uses only
  repository-local test fixtures and emits local fixture identifiers, aggregate
  counts, and mismatch categories. No telemetry fields or remote upload paths are
  added.
- **Imaging semantics and output fidelity**: PASS. The plan requires parity
  checks for voxel data plus dimensions, affine/orientation behavior, spacing,
  datatype or label semantics, and expected output naming according to each
  fixture policy.
- **Reference pipeline parity**: PASS. `test_data/batch_processing.sh` and
  `test_data` expected outputs are the reference. Missing fixtures,
  unevaluable parity, stale mappings, unsupported/native-only steps, and output
  mismatches all fail validation.
- **Progressive runtime capability**: PASS. Runtime browser fallbacks are not
  changed. Setup, install, QC, and report-only steps are validated through
  coverage/status checks without turning optional runtime assets into required
  app assets.
- **Browser performance and worker discipline**: PASS. The implementation is a
  validation-script feature and does not move browser compute work onto the main
  thread or change worker contracts. Test memory use must avoid unnecessary
  duplicate volume retention.
- **Model, asset, and cache stewardship**: PASS. Model task support remains
  manifest-driven. A task cannot satisfy a batch segmentation step as supported
  without validated browser-runnable assets.
- **Release discipline**: PASS. No config version bump, release workflow, setup
  script, WASM build, or deploy path changes are planned.
- **Testing**: PASS. The plan is itself a quality-gate enhancement and requires
  concrete automated coverage for command mapping, fixture parity, stale mapping
  detection, failure diagnostics, and existing processing helper behavior.

## Project Structure

### Documentation (this feature)

```text
specs/002-batch-processing-parity/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── batch-parity-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
scripts/
├── test_batch_processing_cases.cjs
├── test_sct_processing.cjs
└── check-syntax.mjs

test_data/
├── batch_processing.sh
├── batch_*_*/
│   ├── input.nii.gz
│   └── batch_output.nii.gz
└── qc/

web/
├── js/
│   ├── modules/
│   │   └── sct-processing.js
│   ├── app/
│   ├── controllers/
│   ├── spinalcordtoolbox-app.js
│   └── inference-worker.js
├── models/
│   └── manifest.json
└── index.html

package.json
```

**Structure Decision**: Keep the feature in the existing validation surface.
`scripts/test_batch_processing_cases.cjs` remains the batch workflow contract
test and should own active-command extraction/mapping, fixture policy loading,
NIfTI comparison, and diagnostics. Reusable browser-equivalent processing stays
in `web/js/modules/sct-processing.js`, with focused unit coverage in
`scripts/test_sct_processing.cjs`. Fixture inputs and expected outputs remain
under `test_data` so validation stays local and reproducible.

## Complexity Tracking

No constitution violations are required.

## Post-Design Constitution Check

- **Patient-data confidentiality and telemetry**: PASS. The data model and
  contract restrict logs to fixture identifiers, aggregate counts, and mismatch
  summaries; no telemetry or remote processing is introduced.
- **Imaging semantics and output fidelity**: PASS. The fixture contract requires
  explicit comparison policy for dimensions, spacing, orientation/affine
  behavior, datatype, label semantics, data values, and output naming.
- **Reference pipeline parity**: PASS. The design makes the batch script and
  expected fixtures authoritative and requires strict failure for unsupported,
  stale, missing, or unevaluable cases.
- **Progressive runtime capability**: PASS. Browser runtime behavior and
  optional asset fallbacks are unchanged.
- **Browser performance and worker discipline**: PASS. No worker contract is
  changed; test implementation must release per-case buffers and avoid duplicate
  large-volume retention.
- **Model, asset, and cache stewardship**: PASS. Segmentation task readiness is
  still derived from `web/models/manifest.json` and validated assets.
- **Release discipline**: PASS. Release automation and app version ownership
  remain untouched.
- **Testing**: PASS. Quickstart and contracts define required `npm test` checks
  and negative validation scenarios for stale mappings, missing fixtures, and
  mismatched outputs.
