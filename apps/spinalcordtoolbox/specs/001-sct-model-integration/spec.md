# Feature Specification: SCT Model Integration

**Feature Branch**: `001-sct-model-integration`
**Created**: 2026-04-27
**Status**: Draft
**Input**: User description: "update all code in this repository to run the https://spinalcordtoolbox.com/stable/ instead of the previous models here. Make sure to download and convert all models needed. Make sure to update everything in the interface and the documentation."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run SCT Spinal Cord Segmentation (Priority: P1)

A clinician or researcher opens the browser app, loads a spinal cord MRI volume,
selects the default Spinal Cord Toolbox spinal cord segmentation task, runs the
workflow, reviews the segmentation overlay, and downloads a NIfTI mask whose
orientation, spacing, dimensions, affine, and labels match the input workflow.

**Why this priority**: Replacing the current model workflow is only valuable if
the primary SCT spinal cord segmentation task works end to end for users.

**Independent Test**: Can be tested with a representative spinal cord MRI by
loading the image, running the default task, verifying the overlay is displayed,
and confirming the downloaded output is a valid spinal cord segmentation in the
original image space.

**Acceptance Scenarios**:

1. **Given** a supported spinal cord MRI volume, **When** the user runs the
   default SCT spinal cord task, **Then** the app produces a segmentation mask,
   displays it as an overlay, and offers it for download.
2. **Given** the produced segmentation output, **When** the user inspects its
   metadata, **Then** the output preserves the expected orientation, spacing,
   dimensions, affine relationship, and binary spinal cord label semantics.
3. **Given** a browser without the fastest execution capability, **When** the
   user runs the default SCT task, **Then** the app either completes with a
   documented fallback or shows a recoverable explanation without corrupting the
   loaded image state.

---

### User Story 2 - Choose Supported SCT Tasks (Priority: P2)

A user selects from the SCT segmentation tasks supported by the browser app,
sees each task's intended anatomy and input contrast, downloads any required
model assets, and runs the task without seeing obsolete obsolete model terminology.

**Why this priority**: SCT exposes multiple segmentation tasks, and users need
clear task selection to avoid applying a model to the wrong anatomy or contrast.

**Independent Test**: Can be tested by opening the model/task selector,
confirming every listed task has SCT naming, intended anatomy, contrast guidance,
asset status, and no obsolete obsolete model references, then running one secondary
task with representative input.

**Acceptance Scenarios**:

1. **Given** the app is loaded, **When** the user opens the task selector,
   **Then** the selector lists supported SCT tasks such as spinal cord, gray
   matter, lesion, tumor, rootlets, spine, canal, lumbar, EPI, and mouse tasks
   when those tasks are available in the packaged model inventory.
2. **Given** a task requires assets that are not yet cached, **When** the user
   selects that task, **Then** the app shows the required download state, source
   provenance, and a recoverable path if the download or conversion asset is
   unavailable.
3. **Given** a task has contrast or anatomy limitations, **When** the user views
   the task details, **Then** the app explains the intended input without
   requiring the user to read external documentation.

---

### User Story 3 - Maintain SCT Documentation and Provenance (Priority: P3)

A developer or reviewer can read the repository documentation and understand
which SCT stable tasks are supported, where the model assets came from, how they
were downloaded or converted, how outputs are labeled, and how to validate the
browser results against SCT behavior.

**Why this priority**: Scientific model replacement needs traceable provenance,
documentation, and validation so future changes do not silently diverge from SCT.

**Independent Test**: Can be tested by reviewing the updated documentation,
running the documented asset preparation workflow, and following the validation
instructions on representative data.

**Acceptance Scenarios**:

1. **Given** a fresh checkout, **When** a developer follows the documented setup
   steps, **Then** all required SCT model assets are present or the missing
   assets are reported with actionable remediation.
2. **Given** a reviewer inspects the documentation, **When** they search for
   model provenance and validation requirements, **Then** they can identify the
   SCT stable source, supported task list, model version or release, conversion
   status, output labels, and representative validation method.
3. **Given** a user reads the interface or README, **When** they look for
   obsolete model names, **Then** no obsolete model terminology remains.

### Edge Cases

- SCT stable adds, renames, retires, or supersedes a segmentation task.
- A model listed by SCT stable is not available in a browser-runnable format.
- A model requires multiple input contrasts or additional preprocessing that the
  current single-volume browser workflow cannot provide.
- A model download succeeds but conversion or browser validation fails.
- A model asset is missing, stale in cache, too large for cache, or mismatched
  with the configured task inventory.
- Fast browser acceleration is unavailable and model inference must fall back to
  a supported execution path.
- Optional preprocessing assets are unavailable or fail to load.
- Large spinal cord volumes exceed memory limits or cause worker failure.
- Unsupported, malformed, or unexpectedly oriented DICOM/NIfTI inputs are
  loaded.
- Patient image data, DICOM metadata, filenames, intermediate volumes, masks,
  console messages, and outputs must remain confidential and browser-local.
- Telemetry, if used for model/task usage, must be limited to non-patient usage
  fields and disclosed to users.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST replace the current previous model segmentation
  workflow with a Spinal Cord Toolbox stable segmentation workflow.
- **FR-002**: System MUST support the SCT stable default spinal cord
  segmentation task as the primary workflow.
- **FR-003**: System MUST maintain a supported SCT task inventory that records
  each task's display name, intended anatomy, supported contrast or modality,
  output label semantics, model provenance, model version or release identifier,
  asset status, and validation status.
- **FR-004**: System MUST download or otherwise prepare every model asset needed
  for the supported SCT task inventory.
- **FR-005**: System MUST convert model assets when conversion is required for
  browser execution and MUST record whether each model is native, converted, or
  unsupported for browser execution.
- **FR-006**: System MUST exclude obsolete obsolete model files,
  configuration entries, user-facing labels, documentation references, and
  validation scripts from the active SCT workflow.
- **FR-007**: Users MUST be able to select a supported SCT segmentation task
  from the interface and understand the intended input anatomy and contrast
  before running it.
- **FR-008**: System MUST produce NIfTI outputs with documented SCT label
  semantics and preserve or deliberately reconstruct orientation, spacing,
  affine, dimensions, datatype, and scaling behavior.
- **FR-009**: System MUST display SCT segmentation results as overlays with
  task-appropriate labels and colormaps.
- **FR-010**: System MUST validate representative browser outputs against the
  corresponding SCT stable behavior or document why a task cannot be validated
  automatically.
- **FR-011**: System MUST provide recoverable user feedback when a model,
  conversion artifact, cache entry, browser execution capability, or
  preprocessing dependency is unavailable.
- **FR-012**: System MUST preserve confidential browser-local handling of
  patient image data, DICOM metadata, filenames, intermediate volumes, masks,
  logs containing patient-derived values, and derived outputs.
- **FR-013**: System MUST define fallback behavior for unavailable optional
  preprocessing, browser acceleration, cache, conversion, or model assets when
  the feature depends on them.
- **FR-014**: System MUST restrict telemetry to documented non-patient usage
  statistics and MUST exclude patient-derived data, metadata, filenames, images,
  masks, segmentations, and outputs.
- **FR-015**: System MUST update the interface, README, setup instructions,
  model preparation scripts, validation instructions, citations, and runtime
  guidance to describe the SCT stable workflow.

### Key Entities

- **SCT Segmentation Task**: A user-selectable segmentation workflow from SCT
  stable, including task name, category, intended anatomy, supported contrast,
  required inputs, output labels, and validation expectations.
- **SCT Model Asset**: A model file or package required by a supported task,
  including source URL, release identifier, native or converted format,
  checksum or integrity evidence, browser compatibility status, and cache key.
- **Segmentation Output**: A generated NIfTI mask or multi-label output,
  including label semantics, image-space metadata, provenance, and download
  filename.
- **Validation Dataset**: Representative non-patient or de-identified input data
  used to compare browser output against SCT stable behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can complete the default SCT spinal cord segmentation
  workflow from file load to output download in one browser session.
- **SC-002**: 100% of active model/task labels, tooltips, modals, citations, and
  documentation references use SCT terminology and contain no obsolete
  obsolete model terminology.
- **SC-003**: 100% of supported SCT tasks have documented anatomy, contrast,
  model provenance, asset status, output labels, and validation status.
- **SC-004**: All required model assets for supported SCT tasks are present after
  following the documented setup workflow, or are explicitly marked unsupported
  with a reason.
- **SC-005**: Representative default spinal cord output matches SCT stable
  behavior within a documented tolerance for shape, orientation, spacing, label
  semantics, and mask agreement.
- **SC-006**: Required tests or documented validation steps pass for every
  touched surface, including model preparation, task selection, output export,
  UI copy, privacy copy, and documentation.
- **SC-007**: The app shows recoverable user feedback for missing model assets,
  stale cache entries, unsupported tasks, unavailable browser acceleration, and
  failed conversions.
- **SC-008**: Captured telemetry payloads, if telemetry is emitted for this
  feature, contain only documented non-patient fields.

## Assumptions

- The default SCT task for the browser app is the stable `sct_deepseg
  spinalcord` workflow documented by SCT.
- The app will support only SCT tasks whose model assets can be run or converted
  for browser-local execution with acceptable fidelity and performance.
- Tasks requiring multiple input contrasts may be listed as unsupported until
  the interface supports collecting and validating all required inputs.
- Representative validation data will be non-patient, public, synthetic, or
  de-identified so it can be used without violating the patient-data boundary.
- SCT documentation is the source of truth for task names, retired model
  guidance, and high-level user-facing task descriptions.
