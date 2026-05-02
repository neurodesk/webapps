# Component Catalog

## Core

### `createNeuroWebapp(config)`

Builds the shared app shell: header, sidebar, viewer area, status/progress footer, console, footer, and modal root.

Key options: `root`, `title`, `subtitle`, `version`, `logo`, `headerActions`, `sidebarSections`, `modals`, `plugins`.

Returns references, a `ConsoleOutput`, a `ProgressManager`, and helpers: `addSidebarSection`, `addModal`, `registerPlugin`, `setStatus`, `setProgress`, `destroy`.

## UI

### `ConsoleOutput`

Timestamped UI console with optional mirroring to browser console. Supports `log`, `clear`, `getText`, and `copyToClipboard`.

### `ProgressManager`

Controls progress bar width and status text. Supports fixed progress and indeterminate animation.

### `ModalManager`

Opens, closes, toggles, and detects modal state using the `active` class by default.

### `EchoNavigator`

Reusable multi-echo state and UI binding for magnitude/phase navigation.

### `StageResultList`

Renders worker output stages with view and download actions.

### `LabelLegend` and `MetricsSummary`

Render label swatches, label volumes, detected label counts, voxel counts, and summary stats.

### `CommandPreview`

Connects a command generator to a modal or text element. Used by the QSM plugin for `qsmxt` command previews.

### `DicompareReportRenderer`

Renders acquisition validation summaries and pass/fail report rows.

## File I/O

### `FileIOController`

Supports two modes:

- `simple`: one active NIfTI input, with DICOM conversion fallback.
- `bucketed`: QSMbly-style buckets: `magnitude`, `phase`, `totalField`, `localField`, `json`, `mask`, `extra`.

Bucketed mode enforces mutual exclusivity for `phase`, `totalField`, and `localField`, and single-file constraints for `totalField`, `localField`, and `mask`.

### `DicomController`

Thin wrapper around vendored dcm2niix WASM. Apps provide the module URL and callbacks.

### NIfTI Utilities

`parseNiftiHeader`, `extractAffine`, `readNiftiImageData`, `createUint8Nifti`, `createFloat32Nifti`, `createFloat64Nifti`, `createMaskNifti`, and `createNiftiFromVolume`.

## Viewer

### `ViewerController`

Manages NiiVue base volumes, overlays, stage volume mappings, label-volume colormaps, opacity, interpolation, colorbar, crosshair, window/level, screenshots, and downloads.

## Runtime

### `PipelineExecutor`

Generic worker lifecycle for ONNX and Rust/WASM pipelines.

Requests: `init`, `load`, `run`, `run-step`, `reset-state`, `restore-state`, `cancel`.

Events: `initialized`, `progress`, `log`, `error`, `stageData`, `metrics`, `detectedLabels`, `volume-info`, `state-artifact`, `state-restored`, `step-complete`, `complete`.

## Pipeline

### `PipelineDefinition`

Declarative stages with `id`, `label`, `requiredInputs`, `settingsSchema`, `workerCommand`, `outputStages`, assets, and optional `commandPreview`.

### `PipelineRegistry`

Registers pipelines directly or from plugins.

## Volume And Mask

Pure utilities include orientation, inverse orientation, resampling, nearest-neighbor label resampling, crop/uncrop, connected components, largest component filtering, per-label largest component, label counting, z-score and P99 normalization, Otsu thresholding, 2D/3D sliding windows, Gaussian weights, erosion, dilation, hole filling, and robust mask operations.

`MaskState` wraps threshold, robust, fill, erode, dilate, and reset behavior for app-level mask workflows.

## Plugins

Plugins describe domain-specific tasks, labels, colormaps, pipelines, worker steps, panels, and validation hooks.

Included plugins:

- `synthstrip`
- `sct`
- `vesselboost`
- `musclemap`
- `lesion-network-mapping`
- `qsm`
