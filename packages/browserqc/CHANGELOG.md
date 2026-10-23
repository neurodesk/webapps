# @neurodesk/browserqc

## 1.6.20261023

## 1.6.20261022

## 1.6.20261020

### Patch Changes

- ea2a6d2: Deface and BrowserQC take the avg152 T1 2 mm template from the shared template
  catalogue (`registry/templates.json`) and download it with `fetchTemplateFile`,
  which checks its size and SHA-256 and caches it. Before, Deface fetched the template
  and its face mask with no checksum; the face mask now goes through `fetchModel` with
  its manifest checksum too. BrowserQC's air template, its manifest and Deface's
  manifest name the catalogue URL, so the offline bundle carries one copy of the file
  instead of three. BrowserQC cites the ICBM152 template paper. `fetchTemplateFile`
  names the template when its bytes do not match the pin.

## 1.6.20261019

## 1.6.20261018

### Patch Changes

- ea2a6d2: Deface and BrowserQC take the avg152 T1 2 mm template from the shared template
  catalogue (`registry/templates.json`) and download it with `fetchTemplateFile`,
  which checks its size and SHA-256 and caches it. Before, Deface fetched the template
  and its face mask with no checksum; the face mask now goes through `fetchModel` with
  its manifest checksum too. BrowserQC's air template, its manifest and Deface's
  manifest name the catalogue URL, so the offline bundle carries one copy of the file
  instead of three. BrowserQC cites the ICBM152 template paper. `fetchTemplateFile`
  names the template when its bytes do not match the pin.

## 1.6.20261017

## 1.6.20261016

## 1.6.20261015

### Patch Changes

- 5e230a9: BrowserQC offers the brain mask and the GM, WM and CSF fraction maps (or the label map) as downloads under Image quality. The file names start with the input name. About states that the CSF map covers the ventricles only and that the three maps are separate fractions. The package README gives the correct data type of the fraction maps: uint8 with `scl_slope`, not float32.

## 1.5.20261014

## 1.5.20261012

## 1.5.20261010

### Patch Changes

- Move caller-pinned MindGrab and niimath Node drivers and their independent browser parity validation to dependency-free `@neurodesk/node-drivers`. Migrate every command line and remove the old runtime-support exports. Keep SynthSR and SynthStrip browser runtimes out of production Node deployments so portable brain-extraction and BrowserQC archives omit browser dependencies.

- Updated dependencies
  - @neurodesk/node-drivers@0.2.0

## 1.5.20261009

### Minor Changes

- 9dd8eb1: Add the `browserqc` command line: `browserqc T1w.nii.gz OUTPUT_DIR` runs the web app's quality control in Node, with the same MindGrab segmentation on the CPU and the same niimath `--qc` WebAssembly, and writes the web app's downloads (`qc.json`, the brain mask and the tissue fractions or labels) under the same names. `--model` chooses any of the app's four models and `--bids` embeds a sidecar. Portable archives for Linux x64 and Windows x64 and a signed macOS installer include the MindGrab models and the MNI air template, and run offline. Their release check runs the pinned example with all four models, and a plain `.nii` copy without a sidecar, and requires every download to match the web app's CPU downloads byte for byte.

  The app and the command line share the pipeline in `@neurodesk/browserqc`. The app now passes a NIfTI file's own bytes to MindGrab and niimath instead of NiiVue's re-serialised copy, and checks the air template's SHA-256 after download.

### Patch Changes

- Updated dependencies [64ffefa]
  - @neurodesk/runtime-support@0.3.0
