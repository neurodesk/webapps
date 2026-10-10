# @neurodesk/runtime-support

## 0.4.0

### Minor Changes

- Move caller-pinned MindGrab and niimath Node drivers and their independent browser parity validation to dependency-free `@neurodesk/node-drivers`. Migrate every command line and remove the old runtime-support exports. Keep SynthSR and SynthStrip browser runtimes out of production Node deployments so portable brain-extraction and BrowserQC archives omit browser dependencies.

## 0.3.0

### Minor Changes

- 64ffefa: Add Node drivers for portable command lines. `@neurodesk/runtime-support/node/niimath` runs a niimath argv over in-memory files in a fresh WebAssembly instance. `@neurodesk/runtime-support/node/mindgrab` runs MindGrab, MindMap, MindSnap and the 18-class model on the CPU under Node, with the browser wrapper's options and result shape. Both reproduce the browser's outputs byte for byte; `validation/reference.json` pins them and `node-drivers.yml` checks them on Linux, Windows and macOS.

### Patch Changes

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
  - @neurodesk/webapp-components@0.12.0

## 0.2.1

### Patch Changes

- 22aa4bf: Merge upstream astewartau/qsmbly 6e01b15..2f91e83:

  - Load the uploaded mask instead of just listing it (#110)
  - Fix multi-echo DICOM imports, image classification, and gzip file filters (#111)
  - Fix the settings modal saving values no control ever supplied (#112)
  - Add explicit mask alignment repair and anatomical overlays (#114)
  - Classify BIDS part-mag/part-phase images (#113)
  - Automatically preview mismatched masks on the reference image (#115)
  - Bump qsmxt-config to v9.22.0 (#109)
  - Add mouse brain masking (RS2-Net, with voxel-scaled BET fallback) (#116)

  RS2-Net weights (63 MB, GPL-3.0) come through the shared downloader from the pinned
  qsmxt/qsm-onnx-weights revision and are listed in the offline inventory. The shared file-io
  module gains `classifyImageComponent` and `sameNiftiGrid`. The shared dcm2niix runtime moves to
  @niivue/dcm2niix 1.3.20260724, which converts enhanced multi-echo DICOM into one image per echo.

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1

## 0.2.0

### Minor Changes

- SpinalCordToolbox now uses the FreeBrowse viewer (NiiVue 1.0) that TopoFit uses, through one shared mount helper in `@neurodesk/runtime-support/freebrowse-viewer`. Zoom and pan work in 2D and 3D with the wheel, right-drag and two-finger pinch, and a reset restores the view. FreeBrowse supplies layout, intensity window, opacity, colormap and image download, so SCT's duplicate toolbar controls are gone; the viewer is served from the app, not a CDN.

  The log below the viewer can be enlarged by dragging its top edge or from the keyboard, and keeps an Analysis log (tasks, parameters, result summaries, warnings) apart from the Technical log. The shared `nd-console` gained `resizable` and `channels`.

  Compare shows up to four loaded images side by side with linked layout, zoom, pan and crosshair (matched in scanner millimetres), which can be unlinked for unregistered follow-up scans. Each image keeps its own results, edits and analysis inputs when you switch between them.

  The shared mask editor now edits results on the FreeBrowse viewer; edited files are named `_edited` and the approximate browser lesion metrics are withdrawn when a mask they used is edited. The vertebral-labeling port and its PAM50 templates are removed; TotalSpineSeg provides disc labels. The SCT app is prepared for the MS lesion model (`lesion_ms`), which stays unavailable until the converted model is hosted.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.11.0

## 0.1.3

### Patch Changes

- 257192b: Stream SynthSR and SynthStrip CPU inference by operator to avoid oversized browser allocations while preserving the pinned models. Reject normalization with less than one percent positive brain support in the MNI template before exposing downloads. Add numerical parity, allocation, failure recovery, and cropped-head regressions.

## 0.1.2

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.

## 0.1.1

### Patch Changes

- 3fe15c3: Add SynthSeg brain segmentation in the browser and native executable. Pin model assets, preserve oblique NIfTI geometry, and protect cancelled processing from stale results. Share GPU inference and the standard imaging workspace.
