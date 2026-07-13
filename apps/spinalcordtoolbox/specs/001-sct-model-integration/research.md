# Research: SCT Model Integration

## Decision: Use SCT stable `sct_deepseg` as the source of task truth

Rationale: The stable SCT documentation presents `sct_deepseg` as the gallery
and user entry point for segmentation tasks. It lists current task families for
spinal cord, gray matter, pathologies, and other structures, and documents
retired tasks with recommended replacements.

Alternatives considered:
- Keep the current renamed model list: rejected because it preserves the old
  previous model scientific workflow under new names.
- Hard-code only one model: rejected because the user requested all models
  needed and the SCT stable surface includes multiple task families.

References:
- https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html
- https://spinalcordtoolbox.com/stable/user_section/tutorials/segmentation/sct_deepseg-other-models.html

## Decision: Support browser-compatible SCT tasks and explicitly list unsupported tasks

Rationale: SCT stable includes tasks with different input requirements and model
formats. Some tasks may need multiple contrasts, Python-side preprocessing, or
model architectures that cannot be converted to the current browser inference
path. The browser app must not imply support for tasks that cannot run locally
with validated parity.

Alternatives considered:
- Attempt to package every SCT task as runnable regardless of compatibility:
  rejected because it risks invalid outputs and violates model stewardship.
- Hide unsupported tasks entirely: rejected because users and reviewers need to
  understand why SCT stable tasks are not available in the browser app.

## Decision: Default to `spinalcord`

Rationale: SCT stable documents spinal cord segmentation via `sct_deepseg
spinalcord -i input.nii.gz`; this is the most direct replacement for the app's
primary load-segment-download workflow and is contrast-agnostic compared with
older retired models.

Alternatives considered:
- Use a contrast-specific task as the default: rejected because users may load a
  range of spinal cord MRI contrasts and SCT stable points retired contrast-
  specific tasks toward the current `spinalcord` task.
- Prompt users to pick a task before any default exists: rejected because it
  adds friction to the primary workflow.

## Decision: Add a first-class model manifest

Rationale: SCT model stewardship requires task, source URL, release/version,
format, label semantics, browser support, validation status, and cache keys.
Keeping this in `web/models/manifest.json` makes setup, UI, worker, validation,
and documentation consume the same source of truth.

Alternatives considered:
- Store task metadata only in `web/js/app/config.js`: rejected because asset
  provenance and validation state should be generated and checked by scripts.
- Infer task metadata from filenames: rejected because filenames do not capture
  anatomy, contrast, labels, validation, or unsupported reasons.

## Decision: Keep patient data browser-local and use public or de-identified validation data

Rationale: The constitution requires patient image data and derived outputs to
remain confidential and browser-local. Validation must therefore use public,
synthetic, or de-identified inputs and must not write patient-derived data into
model caches or telemetry.

Alternatives considered:
- Use user-provided clinical data for validation artifacts: rejected because it
  conflicts with the privacy boundary unless the data is explicitly
  de-identified and approved.

## Decision: Validate against SCT stable behavior before marking a task supported

Rationale: The browser implementation is a scientific workflow translation.
Task support must mean the browser output has documented agreement with SCT
stable output for representative data, including shape, affine/spacing,
orientation, label semantics, and mask agreement.

Alternatives considered:
- Validate only that the model runs: rejected because a runnable model can still
  produce spatially wrong or semantically wrong output.
- Validate only the default task: rejected for any non-default tasks that are
  displayed as supported.
