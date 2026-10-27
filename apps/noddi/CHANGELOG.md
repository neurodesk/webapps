# noddi

## 0.6.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
  - @neurodesk/dwi2trx@0.8.20261027
  - @neurodesk/noddi@0.6.20261027
  - @neurodesk/runtime-support@0.9.18
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1
  - @neurodesk/noddi@0.6.20261027
  - @neurodesk/dwi2trx@0.8.20261027
  - @neurodesk/runtime-support@0.9.17

## 0.6.20261025

### Patch Changes

- Updated dependencies [74b9c63]
  - @neurodesk/runtime-support@0.9.16
  - @neurodesk/dwi2trx@0.8.20261025
  - @neurodesk/noddi@0.6.20261025
- @neurodesk/dwi2trx@0.8.20261025
- @neurodesk/noddi@0.6.20261025
- aab06fb: Set WLS and OLS fractional anisotropy to zero for tensors with a negative eigenvalue, preserving the remaining fitted maps and shell selection. Apply the same rule in the browser and command line.
- Updated dependencies [99037b6]
- Updated dependencies [aab06fb]
  - @neurodesk/runtime-support@0.9.15
  - @neurodesk/noddi@0.6.20261025
  - @neurodesk/dwi2trx@0.8.20261025
- eaf21e9: Fail automation promptly when its browser renderer exits, retaining the exit reason. Preserve independent NeuroFlow comparison snapshots and desktop stderr/shutdown diagnostics, and report NODDI loading, fitting and output stages through automation without changing numerical outputs or timeouts.

  Add an explicitly diagnostic DWI models-only workflow replay with original preprocessing/model settings and exact independent model comparisons. Default full T1/DWI validation remains unchanged.

  - @neurodesk/noddi@0.6.20261025

## 0.6.20261024

### Minor Changes

- Offer the optional nonlinear dmipy NODDI fit alongside default AMICO, with method selection in automation, voxel diagnostics in provenance and the technical log, and canonical About/Cite content describing the white-matter validation scope.

### Patch Changes

- @neurodesk/dwi2trx@0.8.20261024
- @neurodesk/noddi@0.6.20261024
- 3e7ff03: Keep HMC's loaded files synchronized with page-drop routing and Undo. Serialize paired imports, preserve the last valid input after failures, and cancel pending imports together while retaining the prior mask. Cite MindGrab's method paper. Run the full pinned dmipy white-matter slab through production browser downloads in CI, with all 19 reference files verified by size and checksum.
  - @neurodesk/noddi@0.6.20261024
- @neurodesk/dwi2trx@0.8.20261024
- @neurodesk/noddi@0.6.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/dwi2trx@0.8.20261024
  - @neurodesk/noddi@0.6.20261024
  - @neurodesk/runtime-support@0.9.14
- 25f296e: NODDI names the niimath build in its provenance when it fits the tensor with niimath dtifit, in the app and in the `noddi` command line. `@neurodesk/dwi2trx/niimath-version` gives the version of the pinned niimath build; DWI2TRX and the `dwi2trx` command line now read it from there.
- Updated dependencies [328cb77]
- Updated dependencies [25f296e]
- Updated dependencies [fa60404]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/dwi2trx@0.8.20261024
  - @neurodesk/noddi@0.6.20261024
  - @neurodesk/runtime-support@0.9.13
- Updated dependencies
  - @neurodesk/noddi@0.6.20261024

## 0.5.20261024

### Minor Changes

- 0beef8f: Accept a BIDS folder. A dropped folder gives each DWI run with its bval and bvec. When the folder has more than one run, choose the run in the input section.

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
  - @neurodesk/dwi2trx@0.7.20261024
  - @neurodesk/noddi@0.5.20261024
  - @neurodesk/runtime-support@0.9.12
- a028e96: Add `@neurodesk/webapp-components/file-io/bids-derivatives`: one module for the BIDS-derivative names (`splitName`, `sourceStem`, `outputNames(fileName, desc)`, `maskName`), the derivative sidecar (`derivativeSidecar(sidecar, description)`, `sidecarText`) and `gzipFile` of the DWI apps. degibbs, dwidenoise, n4, noddi and hmc use it in place of their own copies. Every output name and every file byte stays the same.
- 650ce5f: Share the DWI apps' input helpers. `@neurodesk/webapp-components/file-io/brain-mask` reads a user's brain mask (`readBrainMask`: decode, same grid as the image, one 3D volume, binarised) for noddi, n4 and the noddi command line, and `@neurodesk/webapp-components/volume/mean` holds `meanVolumes`. `@neurodesk/dwi2trx/gradients` adds `parseBval` (the bval half of `parseBvalBvec`, with an optional volume-count check), `B0_THRESHOLD`, `isB0` and `b0Volumes` (b < 50 s/mm², the rule of the `exes/dwi/gradients` crate, which a shared test case file now checks on both sides). dwidenoise and n4 parse their b-values with it, and dwidenoise's own `parseBvals` is removed. Outputs are unchanged; some bval error messages now use the shared wording.
- 25f296e: NODDI names the niimath build in its provenance when it fits the tensor with niimath dtifit, in the app and in the `noddi` command line. `@neurodesk/dwi2trx/niimath-version` gives the version of the pinned niimath build; DWI2TRX and the `dwi2trx` command line now read it from there.
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [25f296e]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/noddi@0.5.20261024
  - @neurodesk/dwi2trx@0.7.20261024
  - @neurodesk/runtime-support@0.9.11
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/noddi@0.5.20261024
  - @neurodesk/dwi2trx@0.7.20261024
  - @neurodesk/runtime-support@0.9.12

## 0.4.20261024

### Patch Changes

- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/dwi2trx@0.6.20261024
  - @neurodesk/noddi@0.4.20261024
  - @neurodesk/runtime-support@0.9.10
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/dwi2trx@0.6.20261024
  - @neurodesk/noddi@0.4.20261024
  - @neurodesk/runtime-support@0.9.9
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
  - @neurodesk/dwi2trx@0.6.20261024
  - @neurodesk/noddi@0.4.20261024
  - @neurodesk/runtime-support@0.9.11
- Generate artifact format qualifiers from MIME types and gradient roles, and preserve explicit artifact encodings. Keep gradient input formats in contract metadata until NeuroFlow gains inspectors. Type DWI brain masks as masks so pipeline bindings reject scalar images.
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/dwi2trx@0.6.20261024
  - @neurodesk/noddi@0.4.20261024
  - @neurodesk/runtime-support@0.9.10

## 0.4.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/dwi2trx@0.6.20261022
  - @neurodesk/noddi@0.4.20261022
  - @neurodesk/runtime-support@0.9.8
- Add the ds005134 sub-01 multi-shell slab (CC0; 13 b0, b = 500, 1000 and 2000) as the first example, so the example runs the tensor fit and NODDI and writes every map. The single-shell DWI stays as the second example and shows the NODDI refusal. The command line's release check now uses the slab: the browser reference is recorded again on it.
- Updated dependencies
  - @neurodesk/noddi@0.4.20261022

## 0.4.20261020

### Minor Changes

- 5312f0e: NODDI has a portable command line. `noddi DWI BVAL BVEC OUTPUT_DIR` runs the web app's fit in Node: a MindGrab brain mask of the mean b0 on the CPU (`--mask FILE` or `--no-mask` instead), the tensor fit and, with two or more shells, NODDI (AMICO), on worker threads (`--threads N`). The fit, its chunking and its output names move into `@neurodesk/noddi`, which the app imports, so both write the same files. Release archives for Linux x64, Windows x64 and macOS arm64 are checked against the web app's own downloads of the example and a two-shell phantom.

- ccea86e: NODDI has a third tensor fit, niimath dtifit, in Advanced settings beside weighted least squares (the default) and ordinary least squares. It is FSL dtifit's default linear fit in the dtifit-enabled niimath build that DWI2TRX uses, and it runs in a Web Worker on the same volumes as the other fits: the b0 volumes and the shells up to b = 1200 s/mm². Its FA and MD are equal to DWI2TRX's fit of the same volumes, unit gradients and mask. niimath dtifit writes no AD or RD map, so AD is its first eigenvalue and RD is the mean of the second and third; where niimath sets MD to zero for a negative eigenvalue, AD and RD are zero too. The app gives niimath unit bvecs and runs it with `-xflip 0`, and the direction map gets the sign rule of the other fits, so FA, MD, AD, RD, S0 and the direction agree with the ordinary least squares fit on the same data. The maps keep their BIDS names, the provenance records `tensorFit: "niimath-dtifit"`, and the automation `tensorFit` parameter accepts `niimath-dtifit`. With NODDI selected, the NODDI fit runs after it.

  `@neurodesk/dwi2trx/runner` exports `runNiimath`, the browser's niimath runner on one cached module of the vendored dtifit build. The DWI2TRX tensor worker now imports it from the package instead of an app copy. `fitTensor` takes an optional `xflip` (`'0'`, `'1'` or `'auto'`), which goes to dtifit as `-xflip`; without it the argv does not change.

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
  - @neurodesk/dwi2trx@0.6.20261020
  - @neurodesk/noddi@0.4.20261020
- @neurodesk/dwi2trx@0.6.20261020

- @neurodesk/noddi@0.4.20261020

- d0df450: Rebuild the shared, file-pinned dtifit runtime from niimath cc26582a250c411b5c3c3c05c91dfd58f66be089 with Emscripten 6.0.13 so equal or nearly equal tensor eigenvalues retain unit, orthogonal directions. Record the source, toolchain, flags and licenses and cover the actual runtime with degenerate-tensor regressions. Re-record the production browser reference for V1–V3 because the repaired eigensolver changes the vectors and may reverse their arbitrary signs; scalar maps, tensor coefficients, the mask and every header remain byte identical.

- Keep tensor backend selection in NODDI's shared fitting pipeline. The command line accepts
  `--tensor-fit niimath-dtifit` and uses the same corrected vendored runtime, volume selection,
  map conversion and optional NODDI fit as the browser. Weighted least squares remains the default.

- Updated dependencies [a36fde4]

- Updated dependencies [5312f0e]

- Updated dependencies [ccea86e]

- Updated dependencies [d0df450]

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/noddi@0.4.20261020
  - @neurodesk/dwi2trx@0.6.20261020
  - @neurodesk/runtime-support@0.9.5

- The input size limit moves from dwi2trx to `@neurodesk/webapp-components/file-io/input-limits` (`MAX_INPUT_BYTES`, `InputTooLargeError`, `formatBytes`, `assertInputSize`). It adds `decodedFloat32Bytes`, the size of the Float32 array an image decodes to (voxels × frames × 4), and `assertNiftiDecodedSize`, which refuses a NIfTI above the 2 GB limit from its header alone; `readNiftiHeader` stops gzip streaming after the header when supported. dwi2trx imports the shared module. NODDI and Degibbs refuse a DWI whose decoded image is above the limit before reading it, and the status bar names the size and the limit.

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/dwi2trx@0.6.20261020
  - @neurodesk/noddi@0.4.20261020
  - @neurodesk/runtime-support@0.8.1

- Updated dependencies
  - @neurodesk/dwi2trx@0.6.20261020
  - @neurodesk/noddi@0.4.20261020

## 0.3.20261020

### Patch Changes

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/noddi@0.3.20261020

- 14b8248: MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.

- Updated dependencies [3f1d770]

- Updated dependencies [14b8248]

- Updated dependencies [d9718cd]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/noddi@0.3.20261020

- 4b40da1: The input size limit moves from dwi2trx to `@neurodesk/webapp-components/file-io/input-limits` (`MAX_INPUT_BYTES`, `InputTooLargeError`, `formatBytes`, `assertInputSize`). It adds `decodedFloat32Bytes`, the size of the Float32 array an image decodes to (voxels × frames × 4), and `assertNiftiDecodedSize`, which refuses a NIfTI above the 2 GB limit from its header alone; `readNiftiHeader` stops gzip streaming after the header when supported. dwi2trx imports the shared module. NODDI and Degibbs refuse a DWI whose decoded image is above the limit before reading it, and the status bar names the size and the limit.

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/noddi@0.3.20261020

- Run the NODDI browser reference and examples sequentially so concurrent CPU MindGrab instances do not compete for the same cores and exceed the workflow deadline. Keep every scientific assertion and timeout unchanged.

- Updated dependencies [5312f0e]

  - @neurodesk/noddi@0.3.20261020

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/noddi@0.3.20261020
- Run the NODDI browser reference and examples sequentially so concurrent CPU MindGrab instances do not compete for the same cores and exceed the workflow deadline. Keep every scientific assertion and timeout unchanged.
- Updated dependencies [5312f0e]
  - @neurodesk/noddi@0.3.20261020
- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/noddi@0.3.20261020
- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/noddi@0.3.20261020

### Minor Changes

- 5312f0e: NODDI has a portable command line. `noddi DWI BVAL BVEC OUTPUT_DIR` runs the web app's fit in Node: a MindGrab brain mask of the mean b0 on the CPU (`--mask FILE` or `--no-mask` instead), the tensor fit and, with two or more shells, NODDI (AMICO), on worker threads (`--threads N`). The fit, its chunking and its output names move into `@neurodesk/noddi`, which the app imports, so both write the same files. Release archives for Linux x64, Windows x64 and macOS arm64 are checked against the web app's own downloads of the example and a two-shell phantom.

## 0.3.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/dwi2trx@0.5.20261019
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/noddi@0.3.20261019

- Updated dependencies [da2584b]
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/dwi2trx@0.5.20261019
  - @neurodesk/noddi@0.3.20261019

## 0.3.20261018

### Minor Changes

- NODDI now extracts a MindGrab brain mask from the mean b0 before fitting when no mask is supplied. The shared MindGrab runtime exposes brain-mask extraction with its existing backend selection and cancellation support. The app stages the pinned model runtimes locally for offline use; a supplied mask still bypasses extraction.

### Patch Changes

- 7c0d201: Restore the last committed image after cancelled or failed viewer loads. Share queued volume previews across NODDI, Degibbs, N4 and Dwidenoise, retaining source files and calibrated map ranges while rollback finishes before controls unlock.

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/dwi2trx@0.5.20261018
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/noddi@0.3.20261018

- 870c729: NODDI's About and Cite dialogs now credit MindGrab and Brainchop for the default brain mask. Browser checks verify worker cleanup when MindGrab extraction is cancelled and a complete retry with the real example.

- Updated dependencies

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/dwi2trx@0.5.20261018
  - @neurodesk/noddi@0.3.20261018

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/dwi2trx@0.5.20261018
  - @neurodesk/noddi@0.3.20261018

## 0.2.20261018

### Minor Changes

- 0511cd7: NODDI is a new app that fits diffusion tensor and NODDI maps to a DWI in the browser. Load a DWI NIfTI with its bval and bvec, or a DICOM diffusion series, and choose Fit models. The tensor fit (weighted or ordinary least squares, on the b0 volumes and the shells up to b = 1200 s/mm², or the lowest shell when none is that low) gives FA, MD, AD, RD, S0 and the principal direction. With two or more shells, NODDI by AMICO gives ICVF, ISOVF, ODI and the fibre direction; with one shell the app says so and fits the tensor only. The fit uses an Otsu threshold of the mean b0 as the brain mask, or a mask you supply on the DWI grid, and runs in Web Workers with a cancel. Every map downloads with its BIDS diffusion derivative name, for example `sub-01_model-noddi_param-icvf_dwimap.nii.gz`.

  `@neurodesk/noddi` holds the WebAssembly fit, built from the Rust crates in `exes/dwi`. Its NODDI fit is a port of AMICO 1.5.4, the last BSD-licensed release, and agrees with AMICO 1.5.4 to a median of 1e-4 in white matter. It rotates each atom exactly instead of through AMICO's 1° lookup table.

  `readDiffusionSeries` in `@neurodesk/runtime-support/dcm2niix-client` returns each image with its bval, bvec and sidecar, from NIfTI files or a converted DICOM series. FSL's `bvals` and `bvecs` files count as gradients, with or without a stem: the image readers no longer pass them to dcm2niix as DICOM, and a page drop sends them to an app's gradients input.

  `createNiftiFromData` writes a 4D map when `dims` has a fourth entry greater than 1, so a direction map can be saved as three frames.

### Patch Changes

- a07f659: Cancelling NODDI input preparation, mask reading or map compression now prevents late results and permits retry. Mask reading blocks fitting and requires a single 3D mask. Model choices survive replacement imports and examples, including when single-shell data temporarily prevents NODDI. Its AMICO fit uses the shared strict b0 cutoff, so a volume with b = 50 s/mm² remains diffusion weighted rather than entering the mean b0. The committed WebAssembly module includes this correction.

  The shared diffusion reader pairs a single optional bval or bvec with a sole image independently. Supplying FSL `bvals` without `bvecs` now preserves the b-values for workflows that do not need gradient directions.

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [a07f659]

- Updated dependencies [3329c39]
  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/noddi@0.2.20261018
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/dwi2trx@0.5.20261018

## 0.1.20261020

### Minor Changes

- c1a4dda: NODDI is a new app that fits diffusion tensor and NODDI maps to a DWI in the browser. Load a DWI NIfTI with its bval and bvec, or a DICOM diffusion series, and choose Fit models. The tensor fit (weighted or ordinary least squares, on the b0 volumes and the shells up to b = 1200 s/mm², or the lowest shell when none is that low) gives FA, MD, AD, RD, S0 and the principal direction. With two or more shells, NODDI by AMICO gives ICVF, ISOVF, ODI and the fibre direction; with one shell the app says so and fits the tensor only. The fit uses a MindGrab brain mask of the mean b0, or a mask you supply on the DWI grid, and runs in Web Workers with a cancel. Every map downloads with its BIDS diffusion derivative name, for example `sub-01_model-noddi_param-icvf_dwimap.nii.gz`.

  `@neurodesk/noddi` holds the WebAssembly fit, built from the Rust crates in `exes/dwi`. Its NODDI fit is a port of AMICO 1.5.4, the last BSD-licensed release, and agrees with AMICO 1.5.4 to a median of 1e-4 in white matter. It rotates each atom exactly instead of through AMICO's 1° lookup table.

  `readDiffusionSeries` in `@neurodesk/runtime-support/dcm2niix-client` returns each image with its bval, bvec and sidecar, from NIfTI files or a converted DICOM series. FSL's `bvals` and `bvecs` files count as gradients, with or without a stem: the image readers no longer pass them to dcm2niix as DICOM, and a page drop sends them to an app's gradients input.

  `createNiftiFromData` writes a 4D map when `dims` has a fourth entry greater than 1, so a direction map can be saved as three frames.

### Patch Changes

- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/runtime-support@0.8.2
- The input size limit moves from dwi2trx to `@neurodesk/webapp-components/file-io/input-limits` (`MAX_INPUT_BYTES`, `InputTooLargeError`, `formatBytes`, `assertInputSize`). It adds `decodedFloat32Bytes`, the size of the Float32 array an image decodes to (voxels × frames × 4), and `assertNiftiDecodedSize`, which refuses a NIfTI above the 2 GB limit from its header alone; `readNiftiHeader` stops gzip streaming after the header when supported. dwi2trx imports the shared module. NODDI and Degibbs refuse a DWI whose decoded image is above the limit before reading it, and the status bar names the size and the limit.

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/runtime-support@0.8.1

- 14b8248: MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.

- 870c729: NODDI's About and Cite dialogs now credit MindGrab and Brainchop for the default brain mask. Browser checks verify worker cleanup when MindGrab extraction is cancelled and a complete retry with the real example.

- 1f4aecd: Cancelling NODDI input preparation, mask reading or map compression now prevents late results and permits retry. Mask reading blocks fitting and requires a single 3D mask. Model choices survive replacement imports and examples, including when single-shell data temporarily prevents NODDI. Its AMICO fit uses the shared strict b0 cutoff, so a volume with b = 50 s/mm² remains diffusion weighted rather than entering the mean b0. The committed WebAssembly module includes this correction.

  The shared diffusion reader pairs a single optional bval or bvec with a sole image independently. Supplying FSL `bvals` without `bvecs` now preserves the b-values for workflows that do not need gradient directions.

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
  - @neurodesk/noddi@0.2.0
  - @neurodesk/dwi2trx@0.5.20261020

- Updated dependencies
  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/dwi2trx@0.5.20261020
  - @neurodesk/runtime-support@0.8.2
