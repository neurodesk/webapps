# sdc

## 0.2.20261024

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/runtime-support@0.9.14
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/runtime-support@0.9.11
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/runtime-support@0.9.9
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/runtime-support@0.9.13
  - @neurodesk/sdc@0.2.20261024
- Document the decision not to offer ANTs reverse-PE correction after its six-subject image-gate failure, without implying single-PE ANTs is available. Keep About content in the canonical registry. Correct fastprep's browser PEPOLAR description and bundled GPL solver license metadata.
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/runtime-support@0.9.12
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
  - @neurodesk/runtime-support@0.9.11
  - @neurodesk/sdc@0.2.20261024
- Pair acquisition JSON and gradient inputs by automation role so metadata survives diffusion pipelines. Split DWI Correct and SDC inputs into single-image roles, require explicit acquisition values for automated correction, and expose correction settings. Export a corrected mean-b0 image for downstream brain masks. Use a generic single-volume error for shared image readers.
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/sdc@0.2.20261024

## 0.2.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/runtime-support@0.9.8
  - @neurodesk/sdc@0.2.20261022

## 0.2.20261020

### Minor Changes

- b7612b4: SDC is a new app that estimates the susceptibility field of an EPI acquisition from two b = 0 images with opposite phase-encoding directions, such as AP and PA, in the browser. Drop the pair with its JSON sidecars (and a DWI series' bval), as NIfTI or DICOM; the app pairs them by `PhaseEncodingDirection`, averages each input's volumes with b ≤ 50 and runs PyHySCO with its command-line defaults in a Web Worker with a cancel. It writes the field in Hz with FSL topup's sign as `<stem>_fieldmap.nii.gz` with a sidecar (`Units: Hz`), and the two corrected b = 0 means for quality control. The method was chosen in the reverse-PE options document: it was the closest fast method to topup on six subjects.

  `@neurodesk/sdc` holds the WebAssembly build of `exes/sdc`, a GPL-3.0-or-later Rust port of PyHySCO 0.0.4 that also builds the `sdc` command line. On ds005134 sub-01 the port equals a float64 PyHySCO run to 1e-14 from the same start, and the browser's field equals the command line's.

### Patch Changes

- 311cd3f: Reject nonfinite and constant-range images before field estimation. Restore the last committed image when a preview is cancelled, keep inactive output controls inert during work, and pin the published, checksummed example and native reference data.
- Updated dependencies
- Updated dependencies [311cd3f]
  - @neurodesk/runtime-support@0.9.7
  - @neurodesk/sdc@0.2.20261020
- 14b5939: Exclude ME-ICA and SDC from the single-series application handoff menu. Their workflows require an echo bundle or an opposite-phase pair, so a lone converted image cannot supply their inputs.
- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/runtime-support@0.8.2
  - @neurodesk/sdc@0.2.20261020
- 8681691: SDC validates phase encoding and a finite positive TotalReadoutTime for both images, refusing unequal readouts because the current PyHySCO model assumes equal and opposite displacements. The command line keeps its explicit phase-direction flags and common --trt override. BIDS input uses the shared reader's IntendedFor associations to select one AP/PA fieldmap pair or a DWI with its reverse fieldmap, and refuses ambiguous pairs and unrelated subjects. Remove the unused app-config version placeholder so release metadata has one source. Keep the app and pipeline package on the same UTC release version.
- Updated dependencies [b7612b4]
- Updated dependencies [8681691]
  - @neurodesk/sdc@0.2.20261020
