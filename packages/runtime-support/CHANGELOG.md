# @neurodesk/runtime-support

## 0.9.9

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1

## 0.9.8

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0

## 0.9.7

### Patch Changes

- The FreeBrowse viewer's eye button now hides a volume through NiiVue's own `visible` flag, which NiiVue draws from 1.0.0-rc.24, instead of a shim that set the volume's opacity to 0. A hidden volume keeps its opacity, so the Opacity slider shows the real value while it is hidden. Spinal Cord Toolbox's Results eye buttons hide a stage the same way, keeping its opacity, so either eye can show what the other hid, in the main viewer and in Compare. TopoFit's 3D anatomy clip and its patch QC result follow the flag: hiding the QC volume with FreeBrowse's eye clears its measurements as before.

## 0.9.6

### Patch Changes

- NiiVue moves to 1.0.0-rc.26 in Brain Extraction, Carotid Flow, SYNcro, SynthSeg, White Matter Lesions, and, through the shared FreeBrowse viewer, Spinal Cord Toolbox, DICOM View and TopoFit. From rc.25, NiiVue places a loaded drawing on the right voxels of a sagittal or otherwise permuted image (niivue/mono#251), so the mask editor no longer probes and reverses NiiVue's load on opening a mask. Opening a mask for editing now takes one load instead of up to five on such images. MuscleMap, SeedSeg and VesselBoost run NiiVue 0.68, which already loaded drawings correctly; they pick up the simpler editor.

  From rc.22 NiiVue renders with WebGL2 by default, so the five apps that pinned rc.11 or rc.14 draw their viewer with WebGL2 even where WebGPU is available; segmentation and other processing keep their own WebGPU backends.

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2

## 0.9.5

### Patch Changes

- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0

- Add helpers for the dcm2niix app. `runDcm2niix` takes a `timeoutMs` conversion deadline and terminates a stalled worker. `clearNiftiText` removes NIfTI header text and extensions and keeps geometry and voxels. Editable report fields share the workflow field styling, and clearing a workspace releases its automation output.
- Updated dependencies
  - @neurodesk/webapp-components@0.17.1

## 0.9.4

### Patch Changes

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [c865c0c]

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0

## 0.9.3

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3

- 14b8248: MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.

- d1fa022: SynthSR no longer runs on a software WebGPU adapter. fastprep chooses WebAssembly when the adapter is a fallback (SwiftShader on a VM or a hosted runner) or cannot bind the volume's largest buffer, and the SynthSR app starts on CPU there. The GPU buffer-limit message gives both sizes in MiB, so a need just above the limit no longer reads as "1.0 GiB but this device allows 1.0 GiB".

- Updated dependencies [3f1d770]

- Updated dependencies [d9718cd]
  - @neurodesk/webapp-components@0.16.3

## 0.9.2

### Patch Changes

- da2584b: SynthSR no longer runs on a software WebGPU adapter. fastprep chooses WebAssembly when the adapter is a fallback (SwiftShader on a VM or a hosted runner) or cannot bind the volume's largest buffer, and the SynthSR app starts on CPU there. The GPU buffer-limit message gives both sizes in MiB, so a need just above the limit no longer reads as "1.0 GiB but this device allows 1.0 GiB".

## 0.9.1

### Patch Changes

- Updated dependencies [7c0d201]
  - @neurodesk/webapp-components@0.16.2

## 0.9.0

### Minor Changes

- NODDI now extracts a MindGrab brain mask from the mean b0 before fitting when no mask is supplied. The shared MindGrab runtime exposes brain-mask extraction with its existing backend selection and cancellation support. The app stages the pinned model runtimes locally for offline use; a supplied mask still bypasses extraction.

### Patch Changes

- Updated dependencies [46935f7]
  - @neurodesk/webapp-components@0.16.1

## 0.8.2

### Patch Changes

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.1

- Updated dependencies

- Updated dependencies
  - @neurodesk/webapp-components@0.18.0

## 0.8.1

### Patch Changes

- Updated dependencies [a36fde4]
- Updated dependencies
- Updated dependencies
- Updated dependencies

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies
  - @neurodesk/webapp-components@0.17.0

## 0.8.0

### Minor Changes

- c1a4dda: NODDI is a new app that fits diffusion tensor and NODDI maps to a DWI in the browser. Load a DWI NIfTI with its bval and bvec, or a DICOM diffusion series, and choose Fit models. The tensor fit (weighted or ordinary least squares, on the b0 volumes and the shells up to b = 1200 s/mm², or the lowest shell when none is that low) gives FA, MD, AD, RD, S0 and the principal direction. With two or more shells, NODDI by AMICO gives ICVF, ISOVF, ODI and the fibre direction; with one shell the app says so and fits the tensor only. The fit uses a MindGrab brain mask of the mean b0, or a mask you supply on the DWI grid, and runs in Web Workers with a cancel. Every map downloads with its BIDS diffusion derivative name, for example `sub-01_model-noddi_param-icvf_dwimap.nii.gz`.

  `@neurodesk/noddi` holds the WebAssembly fit, built from the Rust crates in `exes/dwi`. Its NODDI fit is a port of AMICO 1.5.4, the last BSD-licensed release, and agrees with AMICO 1.5.4 to a median of 1e-4 in white matter. It rotates each atom exactly instead of through AMICO's 1° lookup table.

  `readDiffusionSeries` in `@neurodesk/runtime-support/dcm2niix-client` returns each image with its bval, bvec and sidecar, from NIfTI files or a converted DICOM series. FSL's `bvals` and `bvecs` files count as gradients, with or without a stem: the image readers no longer pass them to dcm2niix as DICOM, and a page drop sends them to an app's gradients input.

  `createNiftiFromData` writes a 4D map when `dims` has a fourth entry greater than 1, so a direction map can be saved as three frames.

- 0511cd7: NODDI is a new app that fits diffusion tensor and NODDI maps to a DWI in the browser. Load a DWI NIfTI with its bval and bvec, or a DICOM diffusion series, and choose Fit models. The tensor fit (weighted or ordinary least squares, on the b0 volumes and the shells up to b = 1200 s/mm², or the lowest shell when none is that low) gives FA, MD, AD, RD, S0 and the principal direction. With two or more shells, NODDI by AMICO gives ICVF, ISOVF, ODI and the fibre direction; with one shell the app says so and fits the tensor only. The fit uses an Otsu threshold of the mean b0 as the brain mask, or a mask you supply on the DWI grid, and runs in Web Workers with a cancel. Every map downloads with its BIDS diffusion derivative name, for example `sub-01_model-noddi_param-icvf_dwimap.nii.gz`.

### Patch Changes

- 14b8248: MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.
- 1f4aecd: Cancelling NODDI input preparation, mask reading or map compression now prevents late results and permits retry. Mask reading blocks fitting and requires a single 3D mask. Model choices survive replacement imports and examples, including when single-shell data temporarily prevents NODDI. Its AMICO fit uses the shared strict b0 cutoff, so a volume with b = 50 s/mm² remains diffusion weighted rather than entering the mean b0. The committed WebAssembly module includes this correction.

  The shared diffusion reader pairs a single optional bval or bvec with a sole image independently. Supplying FSL `bvals` without `bvecs` now preserves the b-values for workflows that do not need gradient directions.

- d1fa022: SynthSR no longer runs on a software WebGPU adapter. fastprep chooses WebAssembly when the adapter is a fallback (SwiftShader on a VM or a hosted runner) or cannot bind the volume's largest buffer, and the SynthSR app starts on CPU there. The GPU buffer-limit message gives both sizes in MiB, so a need just above the limit no longer reads as "1.0 GiB but this device allows 1.0 GiB".
- Updated dependencies [ea2a6d2]
- Updated dependencies [3f1d770]
- Updated dependencies [d9718cd]
- Updated dependencies [c1a4dda]
- Updated dependencies [3329c39]
- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0

- a07f659: Cancelling NODDI input preparation, mask reading or map compression now prevents late results and permits retry. Mask reading blocks fitting and requires a single 3D mask. Model choices survive replacement imports and examples, including when single-shell data temporarily prevents NODDI. Its AMICO fit uses the shared strict b0 cutoff, so a volume with b = 50 s/mm² remains diffusion weighted rather than entering the mean b0. The committed WebAssembly module includes this correction.

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- 14b8248: MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.

- 1f4aecd: Cancelling NODDI input preparation, mask reading or map compression now prevents late results and permits retry. Mask reading blocks fitting and requires a single 3D mask. Model choices survive replacement imports and examples, including when single-shell data temporarily prevents NODDI. Its AMICO fit uses the shared strict b0 cutoff, so a volume with b = 50 s/mm² remains diffusion weighted rather than entering the mean b0. The committed WebAssembly module includes this correction.

- d1fa022: SynthSR no longer runs on a software WebGPU adapter. fastprep chooses WebAssembly when the adapter is a fallback (SwiftShader on a VM or a hosted runner) or cannot bind the volume's largest buffer, and the SynthSR app starts on CPU there. The GPU buffer-limit message gives both sizes in MiB, so a need just above the limit no longer reads as "1.0 GiB but this device allows 1.0 GiB".

- Updated dependencies [3f1d770]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [46935f7]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [46935f7]
  - @neurodesk/webapp-components@0.16.0

## 0.7.2

### Patch Changes

- b67e4e9: Add dcm2niix (`dcm2niix`), a browser-only catalog app that runs dcm2niix on one MRI examination at a time. Accept files, folders and ZIP archives; review anatomical, diffusion and reverse phase encoding acquisitions; enter missing metadata; and download an organized BIDS dataset with an explicit identifying-metadata policy. Preserve separate acquisitions and image/gradient ordering, and link reverse EPI fieldmaps to their DWI targets.

  Share bounded conversion deadlines, NIfTI text removal, report-form styling and in-memory automation reset. Include a pinned DICOM example, Philips native-reference checks and offline/interface workflow coverage.

- Updated dependencies [b67e4e9]
  - @neurodesk/webapp-components@0.15.1

## 0.7.1

### Patch Changes

- b68209b: DICOM View can open the selected image in White matter lesions. Open in White matter lesions, under the series, sends the converted 3D image, named as its download is, and the same tab opens White matter lesions with the image loaded and ready to segment. A time series or a single slice keeps the button disabled and says why. Choosing another series while a send is in progress cancels it. DICOM View's automation contract now gives its image artifact the `application/x-nifti` media type.

  White matter lesions loads an image sent from DICOM View on opening and reports "Loaded <name> from DICOM View" in the status bar. It never starts segmentation itself.

  `@neurodesk/webapp-components/handoff` passes files between apps on one site: `sendHandoff` stores them in IndexedDB and opens the target app; `takeHandoff` claims them once and returns copies. An entry can be opened for 2 minutes, only by the tab that sent it, and is deleted when it is opened. The app shell deletes expired entries whenever an app opens.

  The cross-origin isolation service worker bootstrap publishes `coiWillReload`, which resolves once a page knows whether it is about to reload, and `coiHoldReloads`, which stops later automatic reloads. Pages that use neither behave as before.

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0

## 0.7.0

### Minor Changes

- b8b37d6: DICOM View shows the selected series in FreeBrowse instead of a bare NiiVue canvas. Its Volumes panel sets the contrast range (window and level), opacity and colormap, and its header switches between axial, coronal, sagittal, 3D and multiplanar layouts and between contrast and pan for right-drag. The panel starts open where it leaves the image uncovered and closed on narrow screens. The Image, Header and Protocol tabs above the viewer replace the 3-Plane, Axial, Coronal and Sagittal tabs. The image is listed under its download name, which carries no study date.

  The shared FreeBrowse viewer now runs FreeBrowse's development build (commit eae80a127f, vendored because it is not on npm) on NiiVue 1.0.0-rc.17. Wand fills in the Drawing panel can be undone. A volume's name in the Volumes and Surfaces panels is a button that Enter or Space selects, and the contrast, opacity and frame sliders are named for assistive technology. The eye button still hides a volume through its opacity, and now restores the opacity it had, until NiiVue releases volume visibility (niivue/mono#224).

### Patch Changes

- 67a5a8f: `readImageSeries` takes `anonymizeSidecar: true` to keep dcm2niix's default BIDS anonymisation, for sidecars a user can save.
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4

- 67a5a8f: `readImageSeries` takes `anonymizeSidecar: true` to keep dcm2niix's default BIDS anonymisation, for sidecars a user can save.

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

- Updated dependencies [67a5a8f]
  - @neurodesk/webapp-components@0.14.4

## 0.6.4

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.6.3

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.
- Updated dependencies

  - @neurodesk/webapp-components@0.14.2

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2

## 0.6.2

### Patch Changes

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.6.1

### Patch Changes

- c74b26f: Allow callers of `runDcm2niix` to opt into non-anonymized BIDS sidecars with `anonymizeSidecar: false`, matching `readImageSeries`. The default retains dcm2niix's anonymization. Identifying sidecar fields stay in memory; SynthSeg automation uses them to select its population reference and fill omitted age and sex without saving the sidecar.

## 0.6.0

### Minor Changes

- 0569da8: Add the `deface` command line. The defacing pipeline moves out of the web app into `@neurodesk/deface`, which the app and the command line share: niimath's affine `-deface` (fast or Hellinger, with or without robustfov) and MindGrab brain extraction (tight or with an 8 mm border). The command line runs the app's frozen BSD-2 niimath WebAssembly through `@neurodesk/node-drivers/niimath` and MindGrab's threaded CPU module through `@neurodesk/node-drivers/mindgrab`, writes the app's `defaced.nii` (and `brain-mask.nii` for MindGrab), and installs the MNI template and face mask with SHA-256 checks. It ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer. Each release must reproduce the app's pipeline as recorded in Chromium on the app's example: niimath output identical byte for byte and a MindGrab mask Dice of 0.99 or better.

  The web app now runs MindGrab from `@brainchop/mindgrab` 0.1.20260925 instead of its own WebGPU copy of the model. The weights are byte-identical; the package adds its own conform, normalisation and largest-component cleanup, and runs on a hardware GPU or, without one, the threaded CPU module, so MindGrab no longer needs `shader-f16`. The app stops downloading `net_mindgrab.safetensors`. `@neurodesk/runtime-support` gains `niimath/command`, which runs a niimath argv in the vendored worker, and `mindgrab`, the browser MindGrab runtime that Brain2Print used, which now lives there for both apps.

  Report niimath startup and worker failures through the operation's error state and start a fresh worker on retry. Keep Brain2Print's browser runtime out of its portable Node dependency tree and pin Deface's threaded CPU runtime inside its app service-worker scope.

  Store the browser's packed validation masks in the commit-pinned dataset instead of Git. Both validators download and reverify cached masks outside the source repository, and the recorder writes new masks outside it. Numerical output fingerprints and Dice requirements stay unchanged.

### Patch Changes

- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]

  - @neurodesk/webapp-components@0.14.0

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.5.0

### Minor Changes

- 27c9549: SynthSeg reports brain volumes against age. Segmentation now also returns the
  soft-posterior volumes of FreeSurfer's `mri_synthseg --vol`, within 0.03 % of
  FreeSurfer 8.2.0 on the T1 example in fast mode. A new Volumes view charts each
  structure's head-size-adjusted volume against the IXI reference cohort's 5th–95th
  and 25th–75th percentiles and median, with a table of volume, adjusted volume,
  z, percentile and a flag below the 5th or above the 95th percentile. Age and sex
  come from new Input fields, filled from the DICOM header when there is one. The
  reference norms are fetched from the neurocontainers SynthSeg recipe at a pinned
  commit and checked against their checksum. Research use only. Not for diagnostic
  use.

  - Fast mode is now the default processing mode in the app and the command line,
    because the norms were fitted on fast-mode volumes.
  - The Output section adds Download volumes (.csv). The run report and automation
    measurements carry the volumes and the volume report, and `segment` accepts
    optional `age` and `sex` parameters.
  - The `synthseg` command line writes `INPUT_synthseg_vol.csv` beside its other
    outputs. The native executable gains `--vol FILE.csv`.
  - `@neurodesk/runtime-support` adds `readImageSeries`, which pairs each converted
    or supplied NIfTI with its BIDS sidecar.
  - `@neurodesk/webapp-components` adds the `.nd-viewer-report` panel and the
    `.nd-chart` vocabulary for small-multiple SVG charts.

### Patch Changes

- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]

  - @neurodesk/webapp-components@0.13.0

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.4.3

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.4.2

### Patch Changes

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.
- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2

## 0.4.1

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.1

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
