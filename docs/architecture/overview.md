# Architecture Overview

The library supports static browser-only neuroimaging apps. The core contract is:

```text
input files -> file controller -> viewer -> pipeline executor -> worker -> stage outputs -> viewer/results/downloads
```

## Segmentation Track

This track comes from the SCT, VesselBoost, MuscleMap, and LNM apps.

1. `FileIOController` accepts NIfTI directly or sends DICOM files to `DicomController`.
2. `ViewerController` loads the input volume into NiiVue.
3. `PipelineExecutor` starts an ONNX worker.
4. Worker events emit progress, logs, `stageData`, labels, metrics, and completion.
5. Stage outputs become `File` objects and can be viewed, overlaid, or downloaded.

## Algorithm Pipeline Track

This track comes from QSMbly.

1. `FileIOController` runs in bucketed mode with `magnitude`, `phase`, `totalField`, `localField`, `json`, `mask`, and `extra`.
2. A `PipelineDefinition` selects stages based on input mode.
3. Settings are collected by the app or plugin panels.
4. `PipelineExecutor` calls a Rust/WASM or ONNX worker.
5. `CommandPreview` can render equivalent CLI commands through a plugin hook.
6. Optional validation reports, such as DiCompare/QSM guideline output, render through `DicompareReportRenderer`.

## Runtime Constraints

- Static hosting is assumed.
- Use COOP/COEP headers when workers need `SharedArrayBuffer` or threaded WASM.
- Core modules do not own scientific defaults; plugins or apps do.
- Model and WASM files remain app assets, not package assets.
- NIfTI arrays use x-fastest flat indexing: `x + y * nx + z * nx * ny`.
