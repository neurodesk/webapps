# @neurodesk/nesvor

## 0.3.20261010

### Patch Changes

- Declare workspace dependencies without expanding SYNcro portable runtime installations. Mark dicompare type imports explicitly and separate the unchanged NeSVoR reference validator from worker orchestration to remove dependency cycles.

## 0.3.20261009

## 0.3.20261007

## 0.3.20261004

## 0.3.20261003

## 0.3.20260930

## 0.3.20260924

### Patch Changes

- Run MONAIfbs brain masking through ONNX Runtime WebGPU while preserving the pinned model, eight augmentations and postprocessing. Report the masking backend and add GPU numerical and production worker verification.

### Patch Changes

- Default to WebGPU, report measured training batch and preprocessing progress in the live and downloaded logs, and move detailed sidebar explanations into accessible help tooltips.

## 0.3.20260921

### Patch Changes

- Implement browser MONAIfbs masking, ITK N4 bias correction and deformable reconstruction, including analytic Jacobian regularization and complete optimizer updates. Publish pinned model/runtime assets with attribution and integrity checks. Verify the combined objective against upstream PyTorch, fetal mask voxels against the original checkpoint, and N4 plus deformation through the production browser workflow. Add a hardware-only full-acquisition validation command. Full-budget performance and CUDA reconstruction parity remain unverified.

## 0.2.20260921

### Minor Changes

- 94f7cac: Add the NeSVoR fetal slice-to-volume reconstruction app and the decoupled compute feature it needs. The app prepares stacks, thicknesses and protocol presets in the browser and sends the job to a `neurodesk-compute` server in the user's own network (`exes/compute-server`, Rust), which runs the pinned Neurodesk `nesvor` 0.5.0 container and streams progress back. The components package gains the remote compute client (`@neurodesk/webapp-components/compute`) and the `nd-compute-connection` sidebar panel; the desktop suite admits the origins listed in `NEURODESK_COMPUTE_ORIGINS`. The shared About statement is split into `builder` and a per-app overridable `execution` sentence.

  Fix paired job ownership, durable recovery and retention, content-checked idempotency, and cancellation that waits for runner termination. Keep credentials out of local storage, recover jobs after tab reload, import DICOM locally, and preserve examination identity during uploads, viewing and processing. Package the Linux backend with the production frontend and add a real CUDA validation command.

  Add an explicitly experimental browser CPU reference for small prealigned masked stacks, with per-case differentiable NeSVoR fitting, NIfTI output, provenance and worker cancellation. This is not the complete browser port: full SVoRT, WebGPU training, upstream numerical parity, and clinical-sized validation remain pending. Simulator tests do not establish scientific correctness.
