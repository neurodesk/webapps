# topofit

## 0.8.20260920

### Minor Changes

- Add bilateral mid-surface viewing and FreeSurfer downloads, available without optional analysis. Show detected flat patches' mid-surface points and outward fitted-plane normals in scanner RAS, with full-precision copying and a CSV export. Include the center vertex index and coordinate definitions in the analysis metadata, preserve mid-surface hashes during reanalysis, and clear stale patch readouts when the scan or view changes.

### Patch Changes

- Updated dependencies
  - @neurodesk/topofit@0.8.20260920

## 0.7.20260920

### Patch Changes

- Keep Advanced settings and Surface analysis visible as fixed groups instead of collapsible sections.
  - @neurodesk/topofit@0.7.20260920

## 0.7.20260919

### Patch Changes

- Restore full cortical surface overlays in the 3-Plane view. The September 14 flat-patch fix applied 1 mm slice clipping to every mesh; limit that clipping to flat patches and restore full overlays when switching back to cortical surfaces. Add browser pixel checks for all three slices and the patch-to-surface transition.
  - @neurodesk/topofit@0.7.20260919

## 0.7.20260918

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/webapp-components@0.4.1
  - @neurodesk/topofit@0.7.20260918

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.0
  - @neurodesk/topofit@0.7.20260918

## 0.7.20260917

### Patch Changes

- Place Reconstruct cortex above the surface analysis settings. Allow flat-patch radii from 2 mm and up to 50 patches per hemisphere. Document that patches are ranked by flatness, not area.
- Updated dependencies
  - @neurodesk/topofit@0.7.20260917

## 0.7.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0
  - @neurodesk/topofit@0.7.20260916

## 0.7.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.2
  - @neurodesk/topofit@0.7.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.1
  - @neurodesk/topofit@0.7.20260915

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.0
  - @neurodesk/topofit@0.7.20260915

## 0.6.20260914

### Minor Changes

- Add a Run surface analysis action after cortex reconstruction. Retain the current scan's surface geometry and run normals or flat-patch analysis in a separate cancellable worker without repeating neural inference. Allow new patch settings and native-grid ROIs, replace prior analysis outputs and manifest metadata on success, and preserve reconstruction and existing outputs on cancellation or failure.

### Patch Changes

- Show selected flat patches as yellow, two-sided intersections in the three slice views. Preserve slice clipping so patches disappear when scrolling away from their location.
- Updated dependencies
  - @neurodesk/topofit@0.6.20260914

## 0.5.20260914

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.
- 4add8da: Let TopoFit users show multiple cortical meshes together and reveal them inside the 3D volume with an adjustable X-ray control.
- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/topofit@0.5.20260914
  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2

### Minor Changes

- Remove registration spheres from the browser output list and label cortical patches by side and number, such as "Left flat patch 1". Clip meshes to the current slice so scrolling away from a patch does not project it onto unrelated anatomy. Remove the motion-clearance and prescription wording from the application, processing manifest and QC image header.

### Patch Changes

- Updated dependencies
  - @neurodesk/topofit@0.5.20260914

## 0.4.20260914

### Minor Changes

- Add optional TopoFit mid-surface normals and flat cortical patches, matching OpenRecon's atlas eligibility, geodesic search, plane-fit criteria and local ribbon geometry. Export native-grid patch-and-normal QC, individual patch surfaces, paired geometry JSON, normals CSV and measurements; support hemisphere, radius, count, quality and native-grid ROI settings. Pin the fsaverage atlas on Hugging Face. Compare the geometry with OpenRecon on both full-resolution validation hemispheres.

  Keep anatomical surfaces in 3-Plane view and give registration sphere files the FreeSurfer parser extension for display. Remove the repeated sidebar warning and single-option contrast selector. Suppress consecutive duplicate technical-log messages across apps, including QSMbly and CALMaR, and report model-download progress when its percentage changes.

### Patch Changes

- Updated dependencies
  - @neurodesk/topofit@0.4.20260914
  - @neurodesk/webapp-components@0.1.4

## 0.3.20260912

### Minor Changes

- Reject unsafe conform allocations and pin prepared-input and asset hashes in both parity modes.

### Patch Changes

- Updated dependencies
  - @neurodesk/topofit@0.3.20260912

## 0.2.20260912

### Minor Changes

- Match OpenRecon cubic conforming, pin deterministic browser inference, and add reproducibility hashes and repeat-run validation.

### Patch Changes

- Updated dependencies
  - @neurodesk/topofit@0.2.20260912

## 0.1.20260912

### Patch Changes

- Correct the TopoFit release-matrix toolchain declaration.
- Harden public release verification, limit the UI to the validated model, and correct interface and conforming details.
- Updated dependencies
  - @neurodesk/topofit@0.1.20260912

## 0.1.20260911

### Minor Changes

- Add local browser-based TopoFit cortical surface reconstruction with immutable ONNX assets and OpenRecon parity validation.

### Patch Changes

- Updated dependencies
  - @neurodesk/topofit@0.1.20260911
