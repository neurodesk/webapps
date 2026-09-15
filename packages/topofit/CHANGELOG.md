# @neurodesk/topofit

## 0.7.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.1


### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.0

## 0.6.20260914

### Minor Changes

- Add a Run surface analysis action after cortex reconstruction. Retain the current scan's surface geometry and run normals or flat-patch analysis in a separate cancellable worker without repeating neural inference. Allow new patch settings and native-grid ROIs, replace prior analysis outputs and manifest metadata on success, and preserve reconstruction and existing outputs on cancellation or failure.

## 0.5.20260914

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.
- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/webapp-components@0.1.5

### Minor Changes

- Remove registration spheres from the browser output list and label cortical patches by side and number, such as "Left flat patch 1". Clip meshes to the current slice so scrolling away from a patch does not project it onto unrelated anatomy. Remove the motion-clearance and prescription wording from the application, processing manifest and QC image header.

## 0.4.20260914

### Minor Changes

- Add optional TopoFit mid-surface normals and flat cortical patches, matching OpenRecon's atlas eligibility, geodesic search, plane-fit criteria and local ribbon geometry. Export native-grid patch-and-normal QC, individual patch surfaces, paired geometry JSON, normals CSV and measurements; support hemisphere, radius, count, quality and native-grid ROI settings. Pin the fsaverage atlas on Hugging Face. Compare the geometry with OpenRecon on both full-resolution validation hemispheres.

  Keep anatomical surfaces in 3-Plane view and give registration sphere files the FreeSurfer parser extension for display. Remove the repeated sidebar warning and single-option contrast selector. Suppress consecutive duplicate technical-log messages across apps, including QSMbly and CALMaR, and report model-download progress when its percentage changes.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.1.4

## 0.3.20260912

### Minor Changes

- Reject unsafe conform allocations and pin prepared-input and asset hashes in both parity modes.

## 0.2.20260912

### Minor Changes

- Match OpenRecon cubic conforming, pin deterministic browser inference, and add reproducibility hashes and repeat-run validation.

## 0.1.20260912

### Patch Changes

- Harden public release verification, limit the UI to the validated model, and correct interface and conforming details.

## 0.1.20260911

### Minor Changes

- Add local browser-based TopoFit cortical surface reconstruction with immutable ONNX assets and OpenRecon parity validation.
