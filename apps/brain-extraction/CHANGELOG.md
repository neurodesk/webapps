# brain-extraction

## 0.1.20260918

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/synthsr@0.4.20260918
  - @neurodesk/brain-extraction@0.1.2

## 0.1.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0
  - @neurodesk/synthsr@0.4.20260916
  - @neurodesk/brain-extraction@0.1.1

## 0.1.20260915

### Patch Changes

- Add T1 and T2 head MRI examples with cancellable downloads and retry. Remove the BET method description and clarify that the current browser SynthStrip adapter uses the CPU. Require declared, pinned examples and browser coverage for newly generated apps.

### Patch Changes

- Publish Brain extraction in a separately versioned offline suite.

### Patch Changes

- Include Brain extraction in the offline desktop suite with its SynthStrip model and a real BET extraction and download check. Reuse the shared MindGrab adapter in SYNcro.

### Minor Changes

- Add Brain extraction with QSMbly's Rust BET, MindGrab and SynthStrip. Load NIfTI or DICOM, view and download brain images and binary masks, and cancel processing. Offer BET's fractional intensity setting and optional MindGrab CPU processing. Share SYNcro's MindGrab adapter with the new app.
