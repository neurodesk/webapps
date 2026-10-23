# @neurodesk/synthseg

## 0.11.20261023

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1

## 0.11.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0

## 0.11.20261020

### Patch Changes

- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [ea2a6d2]

- Updated dependencies [3f1d770]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [d9718cd]

  - @neurodesk/webapp-components@0.16.3

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0

  - @neurodesk/webapp-components@0.16.3

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies [14db080]

- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies [14db080]

## 0.11.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]
  - @neurodesk/webapp-components@0.16.3

## 0.11.20261018

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]

  - @neurodesk/webapp-components@0.15.1

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0

- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]
  - @neurodesk/webapp-components@0.15.1

## 0.11.20261017

### Minor Changes

- ad1a2ac: The Volumes view compares a default-mode run with IXI and AHEAD norms fitted on default-mode SynthSeg volumes, and a fast-mode run with the fast-mode norms. The report footnote names the mode. Before, default-mode runs were compared with fast-mode norms, which put healthy cortical grey matter about 2 standard deviations low.

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.10.20261016

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2

- 6ec972a: Pin the IXI and AHEAD volume norms to neurocontainers commit 347cf6fb, the merge of the 7 T reference into main. The files are byte-identical to the previous pin, so every report is unchanged; only the population data version shown in the report and About changes.

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.10.20261015

### Minor Changes

- 03beb9e: The brain volume report can compare against a 7 T reference. A new Reference field next to Age and Sex offers Auto (the default), IXI (1.5 T / 3 T) and AHEAD (7 T). Auto reads the scanner field strength from the DICOM header and uses AHEAD from 5 T upward, matching the neurocontainers SynthSeg container. Below 5 T, and for NIfTI input, which records no field strength, it uses IXI. Healthy 7 T scans score about +3.5 SD for cortical grey matter against IXI, so the reference matters.

  The report names the reference with its field strength, says why it was chosen, and the saved run report records the reference id, choice and reason. Automation accepts a `reference` parameter (`auto`, `ixi` or `ahead`). Both norms files are pinned to neurocontainers commit c3e75dbe830b and checked against their SHA-256; the IXI models are unchanged.

  Automated DICOM runs preserve the selected image's sidecar so Auto uses the same scanner field strength as a manual import. Explicit age, sex and reference choices override the header independently; a later NIfTI input returns to the unknown-field-strength IXI default. The command line's segmentation outputs are unchanged; population reference selection belongs to the browser's volume report.

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

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

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
  - @neurodesk/webapp-components@0.13.0

## 0.7.20261014

### Minor Changes

- Automatically crop excess neck with niimath robust FOV when a scan exceeds the browser's GPU buffer limit. If the cropped scan still does not fit, offer the smallest fitting processing voxel size before retrying. Preserve the original upload, record the crop and resolution in the run report, and warn that coarser outputs are not validated against the 1 mm volume norms. Keep the normal 1 mm pipeline unchanged for scans that fit.

### Patch Changes

- Give the IXI population norms an explicit data version tied to their immutable
  source commit. Show the version above the volume charts and in About, and include
  it with the source URL and checksum in saved reports.

## 0.6.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.6.20261010

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

  - @neurodesk/webapp-components@0.12.1

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

- Updated dependencies
  - @neurodesk/webapp-components@0.12.1

## 0.6.20261009

### Minor Changes

- c86d242: Add a portable `synthseg` command line for Linux x64 and Windows x64. It runs the web app's pipeline with ONNX Runtime on the CPU, takes the app's `segment` options (`--mode default|fast`, `--ct`/`--no-ct`), and writes the app's two downloads: the label map and its run report. The model is bundled and SHA-256 checked on every load, so a release runs offline. A 1 mm head peaks at about 6 GB of memory. The release check holds every output to the FreeSurfer 8.1.0 goldens with the native parity gates. macOS keeps the native Metal installer, and the Standalone dialog lists all three platforms.

### Patch Changes

- Updated dependencies [66bf9e9]

- Updated dependencies [501ea0c]
  - @neurodesk/webapp-components@0.12.0

## 0.5.20261007

### Patch Changes

- 16041b5: Pin the SHA-256 of every validation input and FreeSurfer golden in `model.manifest.json` (`validation.sha256`). `make -C exes/synthseg fetch-validation` now verifies cached and freshly downloaded copies against them, so the native and browser parity checks never compare against an unchecked file.

- Updated dependencies [22aa4bf]

  - @neurodesk/runtime-support@0.2.1

- Updated dependencies

  - @neurodesk/runtime-support@0.2.0

- Updated dependencies [22aa4bf]

  - @neurodesk/runtime-support@0.2.1

- Updated dependencies
  - @neurodesk/runtime-support@0.2.0

## 0.5.20261005

### Patch Changes

- Share native result publication between SynthSR and SynthSeg. Clean up newly created temporary files after failed writes while preserving each caller’s publication order and overwrite policy. Keep native path bytes when naming sibling temporaries.

## 0.5.20261004

### Patch Changes

- Share native affine inversion and RAS axis selection between SynthSR and SynthSeg,
  including SynthSeg WASM, while preserving each method's preprocessing and outputs.

- Share raw NIfTI-1 header and scalar decoding between native SynthSR, native
  SynthSeg and SynthSeg WASM while preserving each reader's validation, precision,
  scaling and geometry rules.

- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3

## 0.5.20261003

## 0.5.20260930

## 0.5.20260928

## 0.4.20260928

## 0.3.20260924

## 0.3.20260923

## 0.3.20260920

## 0.3.20260918

## 0.3.20260916

## 0.3.20260915

## 0.2.20260914

### Patch Changes

- Updated dependencies [3cd773f]
  - @neurodesk/runtime-support@0.1.2

## 0.2.20260910

### Patch Changes

- Updated dependencies [3fe15c3]
  - @neurodesk/runtime-support@0.1.1
