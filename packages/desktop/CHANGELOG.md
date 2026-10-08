# @neurodesk/desktop

## 0.26.20261007

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1

## 0.25.20261007

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.11.0

## 0.24.20261007

### Patch Changes

- c040105: Build the bundle's dicompare worker from this repository instead of downloading it from dicompare.neurodesk.org, whose redeploys failed the nightly build, and fix SeedSeg's offline asset list, which still named NiiVue 0.44.0. Offline asset verification now fails when an app's locked asset list differs from its sources.
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2

## 0.24.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1

## 0.23.20261004

### Patch Changes

- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0

## 0.22.20261004

### Patch Changes

- Verify SYNcro with its packaged pinned T1 and explicit WASM SynthSR, SynthStrip, and Greedy backends.

## 0.21.20261004

### Minor Changes

- Generate NeuroFlow 0.1.1 qualifiers and scalar single-file bindings against the merged upstream schema. Resolve verified app coordinate references, reject invalid qualifier inheritance, and validate NIfTI encoding before legacy and schema-version-2 runs.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.9.0

## 0.20.20261003

### Patch Changes

- Share operation parameter schemas across browser and desktop automation. Both callers now use the same defaults, enum values, bounds, recursive arrays, decimal multiples and safe integer rules. Preserve MCP parameter metadata and bundle the validator for native ESM development, standalone releases and the composite catalog.
- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 0.19.20261003

### Patch Changes

- Share browser download tracking, validation ordering and completion-report publication across selector jobs and typed operations. Publish completion only after offline and retained-viewer checks pass, hide pending viewers, and preserve CLI artifact retention and MCP failure cleanup.

## 0.19.20260930

### Minor Changes

- Add a repository CLI that generates schema-validated NeuroFlow tool bundles from automation contracts, with a shared desktop MCP launcher, portable tool names, verified artifact delivery and cancellation. Document the mapping and draft a portable data-constraint RFC.

## 0.18.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0

## 0.17.20260930

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2

## 0.17.20260928

### Patch Changes

- Use portable underscore MCP tool names, explicit input cardinality, and declared SynthSeg browser geometry limits for preflight validation. Preserve duplicate DICOM filenames during conversion, release viewer sessions when their windows close, and prevent cancellation/retry races.

  Resolve QSM voxel-dependent defaults for supplied masks before reconstruction, so generated-mask and supplied-mask runs produce the same output. Add complete Mac scientific validation commands and evidence checks. The SynthSeg GPU buffer ceiling remains unchanged.

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1

## 0.16.20260928

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- Updated dependencies
- Updated dependencies [93381e8]
- Updated dependencies [93381e8]
  - @neurodesk/webapp-components@0.6.0

## 0.15.20260928

### Minor Changes

- Publish versioned app automation contracts and checksummed run reports for brain extraction and SynthSeg. Add shared run identities, explicit completion and cancellation, and SynthSeg label-volume summaries. Generate browser jobs from the contracts and expose discovery, validation, asynchronous execution, cancellation and artifact resources through the desktop's local MCP server, with an optional native SynthSeg engine.

## 0.14.20260928

### Patch Changes

- 83f8fce: Batch jobs now fail as soon as an application reports an error in its status line (`#statusText.error`), with the application's message, instead of waiting for the job timeout. The check also runs while outputs are still downloading and once more before the success report is written, and the job timeout now bounds the download wait. A job can set `failSelector` to another selector, or to `null` to keep waiting.

## 0.14.20260918

### Patch Changes

- Include MuscleMap's clearer input image type, preview, and segmentation controls alongside the current app releases.

## 0.13.20260918

### Patch Changes

- Include the original TOF-MRA example for VesselBoost alongside the corrected Calmar example.

## 0.12.20260918

### Patch Changes

- Use suite 0.12 for Calmar; concurrent SeedSeg, MuscleMap and VesselBoost publishers already selected 0.10 and 0.11.

## 0.11.20260918

### Patch Changes

- Reserve a distinct offline suite version for Calmar's corrected example while the SeedSeg suite release is in progress.

## 0.10.20260918

### Patch Changes

- Remove SeedSeg's unsuitable synthetic example from the offline suite.

## 0.9.20260918

### Minor Changes

- b5143b7: Replace the two suite editions with one platform archive plus one platform-independent model pack.

  The models-included edition embedded the same ~2.0 GB of model files in all four platform archives, which uploaded about 6 GB of identical bytes per release. The models now ship once as `webapps-VERSION-models.tar.gz`, whose entries are the sha256-named files the application already keeps in its model cache.

  `createModelResolver` takes an optional pack directory and checks it before the cache and before any network fetch. A matching file is served where it is, so the pack can be read-only and shared. Set `NEURODESK_MODELS_DIR` to the absolute path of the extracted pack for a fully offline install, or bind-mount one shared pack into every HPC job.

  The published catalog `suite` now carries four platform downloads plus a `models` record, and the per-download `modelsIncluded` edition flag is gone.

### Patch Changes

- 28baa44: Build the model pack from fixed archive headers so one model set always produces one archive, and reference an already published archive in a new suite instead of uploading its bytes again.

## 0.8.20260917

### Patch Changes

- Publish an offline suite containing TopoFit 0.7.20260917.

## 0.7.20260917

## 0.7.20260916

## 0.6.20260916

## 0.6.20260915

### Patch Changes

- Prevent Niimath input loading from overwriting processed results during offline batch jobs.

## 0.5.20260915

### Patch Changes

- Include T1 and T2 head MRI examples for Brain extraction.

## 0.4.20260915

### Minor Changes

- Add Brain extraction with BET, MindGrab and SynthStrip, including the pinned model and an offline extraction check.

## 0.3.20260915

### Patch Changes

- Add OpenRecon scanner-console package links for MuscleMap, QSMbly via QSMxT, Spinal Cord Toolbox, SynthSeg, TopoFit and VesselBoost.

## 0.2.20260915

### Minor Changes

- Offer desktop and HPC downloads both with and without models. Put official Neurodesk Docker and Apptainer downloads first, simplify installation details, and separate standalone choices into clear sections.
