# @neurodesk/desktop

## 0.10.20260918

### Patch Changes

- Include MuscleMap's clearer input image type, preview, and segmentation controls in the offline suite.

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
