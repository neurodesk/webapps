# synthseg

## 0.5.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.9.1
  - @neurodesk/synthseg@0.5.20261004


### Patch Changes

- Share SynthSR and SynthSeg worker model acquisition through fetchModel. Verify cached and downloaded weights before use, reject oversized streams early, and replace corrupt cached weights within the same run. Preserve SynthSR local model files, pinned hashes, progress allocation and worker cancellation. Restore app-specific connection and recovery guidance when model requests fail.
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/synthseg@0.5.20261004

## 0.5.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0
  - @neurodesk/synthseg@0.5.20261003

## 0.5.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/synthseg@0.5.20260930

### Patch Changes

- 3fb0b87: One click on the labels Download button saved the file twice: the result list's download callback and a second `saveBtn.onclick` handler both fired. The button now downloads once, and batch jobs no longer fail with "Duplicate output".
- Updated dependencies
  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/synthseg@0.5.20260930

## 0.5.20260928

### Patch Changes

- Use portable underscore MCP tool names, explicit input cardinality, and declared SynthSeg browser geometry limits for preflight validation. Preserve duplicate DICOM filenames during conversion, release viewer sessions when their windows close, and prevent cancellation/retry races.

  Resolve QSM voxel-dependent defaults for supplied masks before reconstruction, so generated-mask and supplied-mask runs produce the same output. Add complete Mac scientific validation commands and evidence checks. The SynthSeg GPU buffer ceiling remains unchanged.

- 3fb0b87: One click on the labels Download button saved the file twice: the result list's download callback and a second `saveBtn.onclick` handler both fired. The button now downloads once, and batch jobs no longer fail with "Duplicate output".
- Updated dependencies
  - @neurodesk/webapp-components@0.6.1
  - @neurodesk/synthseg@0.5.20260928

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- Updated dependencies
- Updated dependencies [93381e8]
- Updated dependencies [93381e8]
  - @neurodesk/webapp-components@0.6.0
  - @neurodesk/synthseg@0.5.20260928

## 0.4.20260928

### Minor Changes

- Publish versioned app automation contracts and checksummed run reports for brain extraction and SynthSeg. Add shared run identities, explicit completion and cancellation, and SynthSeg label-volume summaries. Generate browser jobs from the contracts and expose discovery, validation, asynchronous execution, cancellation and artifact resources through the desktop's local MCP server, with an optional native SynthSeg engine.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0
  - @neurodesk/synthseg@0.4.20260928

## 0.3.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5
  - @neurodesk/synthseg@0.3.20260924

## 0.3.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.
  - @neurodesk/synthseg@0.3.20260923

## 0.3.20260920

### Patch Changes

- Updated dependencies [4959500]
  - @neurodesk/webapp-components@0.4.4
  - @neurodesk/synthseg@0.3.20260920

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.3
  - @neurodesk/synthseg@0.3.20260920

### Patch Changes

- efd8af3: Show the Example control before the file picker in every app, replace the registration apps' stale "Loading the default images" empty state, give FireANTs a CPU time budget and progress messages, ship BrowserQC's CPU MindGrab bundle with a longer segmentation budget, select CPU processing in SynthSR and brain extraction when no WebGPU adapter exists, start MuscleMap at 50 % overlap without WebGPU, and run VesselBoost's hosted example workflow in its browser tests.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.2
  - @neurodesk/synthseg@0.3.20260920

## 0.3.20260918

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/webapp-components@0.4.1
  - @neurodesk/synthseg@0.3.20260918

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.0
  - @neurodesk/synthseg@0.3.20260918

## 0.3.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0
  - @neurodesk/synthseg@0.3.20260916

## 0.3.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.2
  - @neurodesk/synthseg@0.3.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.1
  - @neurodesk/synthseg@0.3.20260915

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.0
  - @neurodesk/synthseg@0.3.20260915

## 0.2.20260914

### Patch Changes

- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2
  - @neurodesk/synthseg@0.2.20260914

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.1.4
  - @neurodesk/synthseg@0.2.20260914

## 0.2.20260910

### Minor Changes

- Release the complete application catalog after integrating BrowserQC, dwi2trx and SynthSeg. Preserve shared interface behavior and publish bundles with synchronized date versions.
- 3fe15c3: Add SynthSeg brain segmentation in the browser and native executable. Pin model assets, preserve oblique NIfTI geometry, and protect cancelled processing from stale results. Share GPU inference and the standard imaging workspace.

### Patch Changes

- Validate full volumes on CPU and retain small Metal fixture coverage on memory-limited hosted macOS runners. Record validation device scope and partial failures, and include GPU memory context in native errors. Full-volume Metal validation still requires a suitable separate host.

- Updated dependencies [3fe15c3]
  - @neurodesk/runtime-support@0.1.1
  - @neurodesk/synthseg@0.2.20260910
