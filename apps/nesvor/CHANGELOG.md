# nesvor

## 0.3.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/nesvor@0.3.20261004

## 0.3.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0
  - @neurodesk/nesvor@0.3.20261003

## 0.3.20260930

### Patch Changes

- Enable the shared cross-origin isolation fallback on static hosts such as GitHub Pages so N4 can use SharedArrayBuffer. Include NeSVoR in deployed isolation checks and verify its compute-server-first standalone download layout.
  - @neurodesk/nesvor@0.3.20260930

### Patch Changes

- Register stack loading and viewer inspection with the shared automation contract. Opening stacks replaces prior inputs and waits for the viewer; reconstruction remains an interactive operation.
  - @neurodesk/nesvor@0.3.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/nesvor@0.3.20260930

### Patch Changes

- Discover a same-host compute server only after remote processing is selected. Browser mode no longer requests a nonexistent API from the static website.
  - @neurodesk/nesvor@0.3.20260930

### Patch Changes

- Use a portable runtime cache when building NeSVoR outside the development workspace. Preserve ZARRo export progress and cancellation when volume loading completes after the export starts.
  - @neurodesk/nesvor@0.3.20260930

### Patch Changes

- Release the experimental NeSVoR browser and remote compute workflows. Package the required ONNX runtime with gzip compression and omit unused runtime variants. Include shared compute connection recovery, cancellation and Linux server setup instructions.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.5.2
  - @neurodesk/nesvor@0.3.20260930

### Patch Changes

- Publish the experimental NeSVoR browser reconstruction with WebGPU brain masking, motion correction, N4 preprocessing, deformation and reconstruction, plus optional Linux NVIDIA remote compute. WebGPU is the default, progress is logged throughout processing, and acquisition thickness remains editable without a confirmation checkbox. Hardware GPU performance and full-acquisition CUDA parity remain unverified.
  - @neurodesk/nesvor@0.3.20260930

## 0.3.20260924

### Patch Changes

- Run MONAIfbs brain masking through ONNX Runtime WebGPU while preserving the pinned model, eight augmentations and postprocessing. Report the masking backend and add GPU numerical and production worker verification.
- Updated dependencies
  - @neurodesk/nesvor@0.3.20260924

### Patch Changes

- Remove the mandatory slice-thickness confirmation. Allow reconstruction with inferred thicknesses, show a non-blocking spacing note, and retain editable values and numeric validation.
  - @neurodesk/nesvor@0.3.20260924

### Patch Changes

- Default to WebGPU, report measured training batch and preprocessing progress in the live and downloaded logs, and move detailed sidebar explanations into accessible help tooltips.
- Updated dependencies
  - @neurodesk/nesvor@0.3.20260924

## 0.3.20260921

### Patch Changes

- Put compute-server installation first in the shared Standalone dialog for NeSVoR. Show Linux/NVIDIA prerequisites, archive extraction, doctor and container download commands, startup with the current webapp origin, and address/pairing instructions. Support verified preview downloads without presenting them as published releases.
- Updated dependencies
  - @neurodesk/webapp-components@0.5.1
  - @neurodesk/nesvor@0.3.20260921

### Patch Changes

- Implement browser MONAIfbs masking, ITK N4 bias correction and deformable reconstruction, including analytic Jacobian regularization and complete optimizer updates. Publish pinned model/runtime assets with attribution and integrity checks. Verify the combined objective against upstream PyTorch, fetal mask voxels against the original checkpoint, and N4 plus deformation through the production browser workflow. Add a hardware-only full-acquisition validation command. Full-budget performance and CUDA reconstruction parity remain unverified.
- Updated dependencies
  - @neurodesk/nesvor@0.3.20260921

### Minor Changes

- Add experimental WebGPU reconstruction with upstream numerical fixtures, fitted-pose output masking, worker cancellation, and frozen SVoRT export and staging. Full acquisition validation remains outstanding.

### Patch Changes

- @neurodesk/nesvor@0.3.20260921

## 0.2.20260921

### Minor Changes

- 94f7cac: Add the NeSVoR fetal slice-to-volume reconstruction app and the decoupled compute feature it needs. The app prepares stacks, thicknesses and protocol presets in the browser and sends the job to a `neurodesk-compute` server in the user's own network (`exes/compute-server`, Rust), which runs the pinned Neurodesk `nesvor` 0.5.0 container and streams progress back. The components package gains the remote compute client (`@neurodesk/webapp-components/compute`) and the `nd-compute-connection` sidebar panel; the desktop suite admits the origins listed in `NEURODESK_COMPUTE_ORIGINS`. The shared About statement is split into `builder` and a per-app overridable `execution` sentence.

  Fix paired job ownership, durable recovery and retention, content-checked idempotency, and cancellation that waits for runner termination. Keep credentials out of local storage, recover jobs after tab reload, import DICOM locally, and preserve examination identity during uploads, viewing and processing. Package the Linux backend with the production frontend and add a real CUDA validation command.

  Add an explicitly experimental browser CPU reference for small prealigned masked stacks, with per-case differentiable NeSVoR fitting, NIfTI output, provenance and worker cancellation. This is not the complete browser port: full SVoRT, WebGPU training, upstream numerical parity, and clinical-sized validation remain pending. Simulator tests do not establish scientific correctness.

### Patch Changes

- Updated dependencies [94f7cac]
  - @neurodesk/nesvor@0.2.20260921
  - @neurodesk/webapp-components@0.5.0
