# Data Model: SCT Model Integration

## SCT Segmentation Task

Represents one user-selectable SCT stable task.

Fields:
- `id`: Stable internal task identifier, matching SCT task name when possible.
- `displayName`: User-facing task name.
- `category`: One of spinal cord, gray matter, pathology, other structure, or
  unsupported/retired.
- `description`: Plain-language summary of what the task segments.
- `inputContrasts`: Supported contrast or modality labels.
- `requiredInputs`: Number and type of image inputs required.
- `outputType`: Binary mask, multi-label mask, or soft/probability output.
- `labels`: References label definitions for display/export.
- `modelAssets`: Required SCT model assets.
- `supportStatus`: `supported`, `unsupported`, `unvalidated`, or `retired`.
- `unsupportedReason`: Required when `supportStatus` is not `supported`.
- `validationStatus`: `not-run`, `passed`, `failed`, or `manual-only`.

Validation rules:
- `id`, `displayName`, `category`, `supportStatus`, and `validationStatus` are
  required.
- Supported tasks must have at least one model asset and label definition.
- Unsupported or retired tasks must have a non-empty reason.
- Tasks requiring multiple inputs cannot be marked supported until the UI and
  worker contracts handle all required inputs.

State transitions:
- `unvalidated` -> `supported` after successful asset preparation and reference
  comparison.
- `unvalidated` -> `unsupported` when conversion, runtime, or workflow
  requirements cannot be met.
- `supported` -> `unvalidated` when SCT stable source or model version changes.

## SCT Model Asset

Represents one model package or browser-runnable converted model.

Fields:
- `id`: Stable asset identifier.
- `taskId`: Owning SCT segmentation task.
- `sourceUrl`: Upstream SCT or model release URL.
- `sourceVersion`: Release, tag, checksum, or documented stable identifier.
- `sourceFormat`: Upstream model format.
- `browserFormat`: Browser-runnable format or `none`.
- `filename`: Packaged model filename under `web/models/`, when available.
- `sizeBytes`: Packaged asset size.
- `checksum`: Integrity value for the packaged asset.
- `conversionStatus`: `native`, `converted`, `failed`, or `not-needed`.
- `cacheKey`: Cache key including app version, filename, and source version.
- `validationReport`: Link or path to validation evidence.

Validation rules:
- Supported assets must have source provenance, format, filename, and checksum.
- Converted assets must record the converter version or method in validation
  evidence.
- Failed assets must record a human-readable failure reason.
- Patient-derived data must never be included in asset metadata.

## Label Definition

Represents the display/export semantics for a task output.

Fields:
- `taskId`: Task that owns the labels.
- `labels`: Ordered list of index, name, RGBA color, and export meaning.
- `backgroundIndex`: Usually `0`.
- `colormapId`: NiiVue colormap identifier.

Validation rules:
- Every supported task must define background and foreground labels.
- Multi-label tasks must define all output classes.
- Exported NIfTI values must match the documented label indices.

## Segmentation Output

Represents a downloadable result produced by the browser workflow.

Fields:
- `taskId`: Task used to produce the output.
- `sourceImageName`: Browser-local display name only; must not be sent remotely.
- `filename`: Download filename.
- `labelDefinition`: Labels used for output interpretation.
- `headerMetadata`: Orientation, spacing, affine, dimensions, datatype, and
  scaling evidence.
- `provenance`: App version, task id, model asset id, and source version.

Validation rules:
- Output metadata must preserve or deliberately reconstruct the input image
  space.
- Output labels must match the task label definition.
- Provenance must not include patient-derived values.

## Validation Dataset

Represents input data used for reference comparison.

Fields:
- `id`: Dataset identifier.
- `source`: Public, synthetic, or de-identified source.
- `taskIds`: Tasks validated with this dataset.
- `inputCharacteristics`: Contrast, anatomy, dimensions, and orientation.
- `referenceOutput`: SCT stable output path or checksum.
- `browserOutput`: Browser output path or checksum.
- `metrics`: Dice/overlap, shape, orientation, spacing, affine, and label checks.

Validation rules:
- Dataset must be non-patient, public, synthetic, or de-identified.
- Supported tasks must have validation evidence or documented manual-only
  justification.
