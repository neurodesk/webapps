# Component Catalog

## Core

### `mountImagingWorkspace(config)`

Moves existing controls, viewer, and status regions into the shared imaging
workspace without cloning app-owned nodes or listeners. The hosted-site shell
uses the same `data-neurodesk-control` contract for About, Cite, Privacy, and an
optional Standalone package dialog.

## UI

### `ConsoleOutput`

Timestamped UI console with optional mirroring to browser console. Supports `log`, `clear`, `getText`, and `copyToClipboard`.

### `ProgressManager`

Controls progress bar width and status text. Supports fixed progress and indeterminate animation.

### `ModalManager`

Opens, closes, toggles, and detects modal state using the `active` class by default.

### `EchoNavigator`

Reusable multi-echo state and UI binding for magnitude/phase navigation.

### `createResultList`

Renders worker output stages with view and download actions. Results with a
boolean `visible` field use a visibility checkbox. The controlled callback is
`onVisibilityChange(stage, visible, result, input)`: the app owns the visibility
state and should pass its latest `visible` value whenever it calls `render`
again. `render` replaces the rows rather than retaining checkbox state.

### `LabelLegend` and `MetricsSummary`

Render label swatches, label volumes, detected label counts, voxel counts, and summary stats.

### `CommandPreview`

Connects a command generator to a modal or text element. QSMbly uses it for `qsmxt` command previews.

### `DicompareReportRenderer`

Renders dicompare compliance results (`{ acquisitions, complianceResults, schema }`) into a
container — schema header, pass/fail/warning badges, per-acquisition field and rule tables,
and a collapsible list of unchecked fields — and generates a standalone printable report via
`generatePrintHtml(data)`. This module is the source of the embed file dicompare serves at
`https://dicompare.neurodesk.org/embed/DicompareReportRenderer.js`; the two are kept
byte-identical by a package test.

### Workflow vocabulary builders

The markup and metrics are defined once in `styles/imaging-workspace.css`
(see `docs/architecture/design-system.md` in the monorepo). These builders emit
that markup so apps never hand-write it:

- `createFileField({ id, text, kind, multiple, accept, directory })` — the shared `.nd-file` scan picker; `bindFileDrop(target, handler)` adds drag-and-drop with folder expansion to any element.
- `createViewerToolbar({ views, window, overlay, colormap, download, screenshot, actions })` — layout tabs plus optional window/level, overlay opacity, colormap, download and screenshot controls; every control is optional.
- `createConsole({ id, title, collapsed })` — the collapsed technical log with Copy and Clear, bound to a `ConsoleOutput`; errors reopen it.
- `createInfoDialog({ id })` — one centered, viewport-bounded `dialog.nd-dialog` whose `open(title, content, { wide })` swaps About, Cite, Privacy or Standalone content; `renderCommand({ id, command })` renders a copyable terminal command.
- `bindInfoTooltips(root)` / `renderInfoIcon(text)` — the small "i" help icons with positioned tooltips.
- `bindSectionDisclosure(section)` — binds a single class-driven disclosure (used by `createConsole`).

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

Registers pipeline definitions by id.

## Volume And Mask

Pure utilities include orientation, inverse orientation, resampling, nearest-neighbor label resampling, crop/uncrop, connected components, largest component filtering, per-label largest component, label counting, z-score and P99 normalization, Otsu thresholding, 2D/3D sliding windows, Gaussian weights, erosion, dilation, hole filling, and robust mask operations.

Stateful mask workflows remain app-owned; the package exports the pure mask and
volume operations they compose.
