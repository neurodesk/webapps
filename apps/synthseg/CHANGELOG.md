# synthseg

## 0.11.20261020

### Patch Changes

- Updated dependencies [ea2a6d2]
- Updated dependencies [3f1d770]
- Updated dependencies [14b8248]
- Updated dependencies [d9718cd]
- Updated dependencies [c1a4dda]
- Updated dependencies [1f4aecd]
- Updated dependencies [3329c39]
- Updated dependencies [46935f7]
- Updated dependencies [d1fa022]
  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/synthseg@0.11.20261020

## 0.11.20261018

### Patch Changes

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/synthseg@0.11.20261018
- Updated dependencies [67a5a8f]
- Updated dependencies [b8b37d6]
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]
  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/synthseg@0.11.20261018

## 0.11.20261017

### Minor Changes

- ad1a2ac: The Volumes view compares a default-mode run with IXI and AHEAD norms fitted on default-mode SynthSeg volumes, and a fast-mode run with the fast-mode norms. The report footnote names the mode. Before, default-mode runs were compared with fast-mode norms, which put healthy cortical grey matter about 2 standard deviations low.

### Patch Changes

- 38b2b4b: Keep the raw volume table visible and explain why when the population volume report cannot be computed or its reference cannot be loaded.
- Updated dependencies [b547d52]
- Updated dependencies [ad1a2ac]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/synthseg@0.11.20261017
  - @neurodesk/runtime-support@0.6.4

## 0.10.20261016

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.
- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/synthseg@0.10.20261016
- 6ec972a: Pin the IXI and AHEAD volume norms to neurocontainers commit 347cf6fb, the merge of the 7 T reference into main. The files are byte-identical to the previous pin, so every report is unchanged; only the population data version shown in the report and About changes.
- Updated dependencies [7443048]
- Updated dependencies [6ec972a]
  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/synthseg@0.10.20261016
  - @neurodesk/runtime-support@0.6.2

## 0.10.20261015

### Minor Changes

- 03beb9e: The brain volume report can compare against a 7 T reference. A new Reference field next to Age and Sex offers Auto (the default), IXI (1.5 T / 3 T) and AHEAD (7 T). Auto reads the scanner field strength from the DICOM header and uses AHEAD from 5 T upward, matching the neurocontainers SynthSeg container. Below 5 T, and for NIfTI input, which records no field strength, it uses IXI. Healthy 7 T scans score about +3.5 SD for cortical grey matter against IXI, so the reference matters.

  The report names the reference with its field strength, says why it was chosen, and the saved run report records the reference id, choice and reason. Automation accepts a `reference` parameter (`auto`, `ixi` or `ahead`). Both norms files are pinned to neurocontainers commit c3e75dbe830b and checked against their SHA-256; the IXI models are unchanged.

  Automated DICOM runs preserve the selected image's sidecar so Auto uses the same scanner field strength as a manual import. Explicit age, sex and reference choices override the header independently; a later NIfTI input returns to the unknown-field-strength IXI default. The command line's segmentation outputs are unchanged; population reference selection belongs to the browser's volume report.

### Patch Changes

- Clarify that the volume report records the DICOM-derived scanner field strength and reference choice alongside age and sex. The Privacy dialog and README now describe these fields accurately; the original sidecar is not included in the downloaded report.
  - @neurodesk/synthseg@0.10.20261015
- Updated dependencies [c74b26f]
- Updated dependencies [03beb9e]
  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/synthseg@0.10.20261015

## 0.9.20261015

### Minor Changes

- db746d4: SynthSeg exports GM, WM and CSF probability maps. Each map is the sum of the
  normalized SynthSeg posteriors of a group of structures, on the label grid, as
  float32 NIfTI. GM is cerebral and cerebellar cortex and the structures that
  FreeSurfer's subcortical grey volume counts, ventral DC included. WM is cerebral
  and cerebellar white matter and the brainstem. CSF is the ventricles and the CSF
  label. The labels and the soft volumes do not change.

  - The app's Output section adds GM, WM and CSF probability rows with View and
    Download. The run report and the automation `segment` operation list them as
    `gm`, `wm` and `csf` artifacts.
  - The `synthseg` command line writes `INPUT_synthseg_gm.nii.gz`,
    `INPUT_synthseg_wm.nii.gz` and `INPUT_synthseg_csf.nii.gz` beside its other
    outputs, and its release check holds each map to its label map and volume
    table.
  - The native executable gains `--tissues`, which writes `OUTPUT_gm`, `OUTPUT_wm`
    and `OUTPUT_csf` beside the label map.
  - `runSynthseg` returns `tissues: { gm, wm, csf }`, and `@neurodesk/synthseg/results`
    adds `TISSUE_GROUPS` and `tissueVolumes`.

### Patch Changes

- dd65e6a: Visual refresh: Inter, neutral greys with the Neurodesk logo green for action,
  focus and selection only, a compact 48px app bar, sentence-case section titles
  and a quieter status bar. The example menu is now the input control: examples,
  then Choose files… and Choose folder…. The whole window, the viewer included,
  accepts dropped files; a drop mid-session replaces the inputs with Undo in the
  status bar. Before any input the status reads "Drag and drop files". MuscleMap
  drops its separate drop box and Add File(s) button.

  Page drops fill empty image slots in order while keeping DICOM series together.
  New selections supersede unfinished drop traversal, and registration apps load
  each dropped image in order. The shared drop handler also respects the different
  native input and file-field event contracts.
  Failed imports leave only successfully loaded slots occupied, and Undo can
  restore loaded examples.

- e1643c5: The Windows command-line build keeps the population norms fixture byte for byte, so its checksum test passes and the Windows archive is published again.
- Updated dependencies [0569da8]
- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]
- Updated dependencies [db746d4]
  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/synthseg@0.9.20261015

## 0.8.20261014

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
  - @neurodesk/synthseg@0.8.20261014
  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0

## 0.7.20261014

### Minor Changes

- Automatically crop excess neck with niimath robust FOV when a scan exceeds the browser's GPU buffer limit. If the cropped scan still does not fit, offer the smallest fitting processing voxel size before retrying. Preserve the original upload, record the crop and resolution in the run report, and warn that coarser outputs are not validated against the 1 mm volume norms. Keep the normal 1 mm pipeline unchanged for scans that fit.

### Patch Changes

- Give the IXI population norms an explicit data version tied to their immutable
  source commit. Show the version above the volume charts and in About, and include
  it with the source URL and checksum in saved reports.
- Updated dependencies
  - @neurodesk/synthseg@0.7.20261014

## 0.6.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/runtime-support@0.4.3
  - @neurodesk/synthseg@0.6.20261012

## 0.6.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/synthseg@0.6.20261010
- Updated dependencies
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/synthseg@0.6.20261010

## 0.6.20261009

### Minor Changes

- c86d242: Add a portable `synthseg` command line for Linux x64 and Windows x64. It runs the web app's pipeline with ONNX Runtime on the CPU, takes the app's `segment` options (`--mode default|fast`, `--ct`/`--no-ct`), and writes the app's two downloads: the label map and its run report. The model is bundled and SHA-256 checked on every load, so a release runs offline. A 1 mm head peaks at about 6 GB of memory. The release check holds every output to the FreeSurfer 8.1.0 goldens with the native parity gates. macOS keeps the native Metal installer, and the Standalone dialog lists all three platforms.

### Patch Changes

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
- Updated dependencies [64ffefa]
- Updated dependencies [c86d242]
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
  - @neurodesk/synthseg@0.6.20261009

## 0.5.20261007

### Patch Changes

- Updated dependencies [16041b5]
- Updated dependencies [22aa4bf]
  - @neurodesk/synthseg@0.5.20261007
  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/synthseg@0.5.20261007
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2
  - @neurodesk/synthseg@0.5.20261007

## 0.5.20261005

### Patch Changes

- Share native result publication between SynthSR and SynthSeg. Clean up newly created temporary files after failed writes while preserving each caller’s publication order and overwrite policy. Keep native path bytes when naming sibling temporaries.
- Updated dependencies
  - @neurodesk/synthseg@0.5.20261005

## 0.5.20261004

### Patch Changes

- Share native affine inversion and RAS axis selection between SynthSR and SynthSeg,
  including SynthSeg WASM, while preserving each method's preprocessing and outputs.
- Updated dependencies
  - @neurodesk/synthseg@0.5.20261004
- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/synthseg@0.5.20261004
- c164941: Correct the FreeSurfer labels in the viewer before downloading them. Edit on the result row opens the shared mask editor with a Label select that names each FreeSurfer structure, such as `17 — Left-Hippocampus`. Apply marks the row as edited, and Download then saves the edited labels as a uint8 NIfTI on SynthSeg's grid. The JSON report keeps the pipeline's labels and volumes. When the input image is not on SynthSeg's 1 mm grid, the editor shows the input resampled to that grid and the status bar says so. The overlay opacity slider no longer throws. It called `setOpacity`, which NiiVue 1.0 does not have, and now uses `setVolume`.
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/synthseg@0.5.20261004
- Share raw NIfTI-1 header and scalar decoding between native SynthSR, native
  SynthSeg and SynthSeg WASM while preserving each reader's validation, precision,
  scaling and geometry rules.
- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3
  - @neurodesk/synthseg@0.5.20261004
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
