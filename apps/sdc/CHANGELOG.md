# sdc

## 0.5.20261108

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
  - @neurodesk/runtime-support@0.9.23
  - @neurodesk/sdc@0.5.20261108

## 0.5.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0
  - @neurodesk/runtime-support@0.9.22
  - @neurodesk/sdc@0.5.20261104

## 0.5.20261103

### Minor Changes

- 491c3ce: SDC adds SyN-SDC to its method selector: sdcflows 2.17.1's fieldmap-less correction from one DWI series and a T1w (`@neurodesk/sdc/syn`), run in a worker in the browser. MindGrab masks the mean b0 and the T1w on its CPU modules unless masks are uploaded. The sidebar asks for the phase-encoding direction and the total readout time only when no sidecar has them, and a run without them is refused. The app writes the corrected DWI series with its bval, bvec and sidecar, the field map in Hz, its B-spline coefficients, the displacement field and the brain mask, shows the field over the corrected mean b0, and logs per-stage times and field QC in the console. The new example is the ds005134 slab with the full T1w; its outputs equal the Node pipeline's byte for byte. `createNiivueVolumePreview` draws an optional signed overlay on its image and clears the viewer when given `null`. The SyN-SDC N4 worker (`@neurodesk/sdc/syn/n4-worker`) takes the kernel's `wasm` URL as optional: without it the module loads the `n4-bias.wasm` beside it, so the composite site serves one N4 binary to N4 and SDC (runtime family `n4-wasm`). SDC stages only MindGrab's CPU modules, the only ones it runs. A new file-input kind, `mask`, marks an optional mask beside a scan input: the shell's page drop never fills it and never makes it the primary input. SDC's two mask fields use it, carry visible labels and are disabled while PyHySCO is selected, so a dropped DWI series stays with its T1w and a dropped AP/PA pair stays together. A flat BIDS-named DWI with a T1w that has no BIDS name (or a DICOM T1w) is read as loose files.

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
  - @neurodesk/sdc@0.5.20261103
  - @neurodesk/runtime-support@0.9.21

## 0.4.20261103

### Minor Changes

- 9868d87: Add a portable `sdc` command line for Linux, Windows and macOS. It runs the SyN-SDC pipeline of `@neurodesk/sdc/syn` (the sdcflows 2.17.1 fieldmap-less port) on one DWI series with a T1w of the same session: MindGrab brain masks through `@neurodesk/node-drivers/mindgrab` (or `--epi-mask` and `--t1w-mask`), the registration, DenoiseImage and N4 WebAssembly kernels in worker threads, the field fit and the unwarp, and writes the BIDS derivatives. The gradients and sidecar beside the series are found by name; `--pe-dir` and `--readout` override the sidecar. `download-models` fetches the pinned distortion prior and its notices, which the archives bundle; `--no-prior` uses the T1w mask in its place. Its release check runs the pipeline's synthetic subject with both MindGrab masks and holds every output to the files the same pipeline wrote in Chromium on the web app's browser runtimes (`validation/browser-reference.json`): each image by its decompressed bytes, the other files byte for byte. The sdc app is now released, so its archives have a release to attach to.

### Patch Changes

- Updated dependencies [8e9346d]
- Updated dependencies [239dedd]
- Updated dependencies [9868d87]
- Updated dependencies [71881c8]
  - @neurodesk/webapp-components@0.22.4
  - @neurodesk/sdc@0.4.20261103
  - @neurodesk/runtime-support@0.9.20

## 0.3.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/webapp-components@0.22.3
  - @neurodesk/sdc@0.3.20261031

## 0.3.20261029

### Patch Changes

- 3eb6bf8: Build the automation report's provenance, including the PyHySCO backend, adapter and any WebGPU fallback error, in the tested pipeline module.
  - @neurodesk/sdc@0.3.20261029

## 0.3.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
  - @neurodesk/runtime-support@0.9.18
  - @neurodesk/sdc@0.3.20261027
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1
  - @neurodesk/runtime-support@0.9.17
  - @neurodesk/sdc@0.3.20261027

## 0.3.20261025

### Minor Changes

- 4bc35f7: Run the PyHySCO Gauss-Newton evaluations and the preconditioned CG solves on WebGPU when the browser has a hardware adapter and JSPI. The CPU path stays the fallback. On ds005134 sub-01 the WebGPU field agrees with the native PyHySCO field to a median of 1.9e-5 Hz in the brain (#506).

  Keep the hardware-adapter fallback check consistent with the WebGPU API, record the actual backend and any GPU failure in saved provenance, and run the native-field browser gate on hardware CI.

### Patch Changes

- Updated dependencies [74b9c63]
- Updated dependencies [4bc35f7]
  - @neurodesk/runtime-support@0.9.16
  - @neurodesk/sdc@0.3.20261025

## 0.2.20261025

### Patch Changes

- Updated dependencies [99037b6]
  - @neurodesk/runtime-support@0.9.15
  - @neurodesk/sdc@0.2.20261025

## 0.2.20261024

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
  - @neurodesk/runtime-support@0.9.12
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
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/runtime-support@0.9.14
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
