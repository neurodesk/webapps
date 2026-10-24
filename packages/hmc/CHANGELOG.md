# @neurodesk/hmc

## 0.4.20261024

### Minor Changes

- 328cb77: Add a browser workspace and Node command line for GP and trivial diffusion head-motion correction, with pinned CPU brain masking, explicit worker controls, BIDS derivatives and effective-mask provenance. Verify the hosts against actual production-browser reference outputs.

### Patch Changes

- ecaf40a: Release copied text and transform result buffers with the NiFreeze model so repeated full-volume GP runs can reuse the bounded WebAssembly heap without fragmentation. Preserve all scientific output values and the production heap limit.
  - @neurodesk/dwi2trx@0.8.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/dwi2trx@0.8.20261024
- 14d97d8: Reject registration tasks cancelled while their inputs are prepared, without posting to terminated workers or leaving the caller waiting. Preserve benchmark trial receipts and support validated resume with matching runtime sources, inputs, settings and machine identity.
- Updated dependencies [328cb77]
- Updated dependencies [25f296e]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/dwi2trx@0.8.20261024

## 0.3.3

### Patch Changes

- Add isolated Node and Chromium estimator measurement tools with pinned inputs, completed-work checks, scientific output hashes and process memory sampling. Document correctness preflights and the pending performance matrix without changing worker defaults or scientific acceptance gates.

## 0.3.2

### Patch Changes

- a028e96: Add `@neurodesk/webapp-components/file-io/bids-derivatives`: one module for the BIDS-derivative names (`splitName`, `sourceStem`, `outputNames(fileName, desc)`, `maskName`), the derivative sidecar (`derivativeSidecar(sidecar, description)`, `sidecarText`) and `gzipFile` of the DWI apps. degibbs, dwidenoise, n4, noddi and hmc use it in place of their own copies. Every output name and every file byte stays the same.
- Updated dependencies [14a8b29]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [e2476e7]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/hmc-registration@0.2.1

## 0.3.1

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.19.3

## 0.3.0

### Minor Changes

- Add the NiFreeze trivial and GP estimator loops using the existing Rust model, mask, median and registration-argument ports. Preserve in-place clipping and explicit visit order, prepare targets lazily, and add a pinned full-reference Node validation harness that retains the required Q53 gate.

## 0.2.3

### Patch Changes

- a028e96: Add `@neurodesk/webapp-components/file-io/bids-derivatives`: one module for the BIDS-derivative names (`splitName`, `sourceStem`, `outputNames(fileName, desc)`, `maskName`), the derivative sidecar (`derivativeSidecar(sidecar, description)`, `sidecarText`) and `gzipFile` of the DWI apps. degibbs, dwidenoise, n4, noddi and hmc use it in place of their own copies. Every output name and every file byte stays the same.
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [e2476e7]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/hmc-registration@0.2.1

## 0.2.2

### Patch Changes

- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2

## 0.2.1

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1

## 0.2.0

### Minor Changes

- f74f2ae: Add the `@neurodesk/hmc` package for DWI head-motion correction. It runs a pool of `@neurodesk/hmc-registration` kernels (Web Workers in a browser, worker threads in Node; the caller sets the count), cancels through an `AbortSignal` (the workers are terminated), reports progress per volume and stage, resamples the series once with the per-volume transforms (`--apply` with `BSpline`, order 3, the closest interpolator to NiFreeze's SciPy cubic spline), and writes the BIDS-derivative outputs: `*_desc-hmc_dwi.nii.gz` with the b0 volumes kept, `.bval`, `.bvec`, `*_desc-hmc_motion.tsv`, a JSON sidecar and one ITK `.mat` per volume. The committed `src/hmc.wasm` is the WebAssembly build of the `hmc` crate (`exes/dwi/hmc-wasm`): `.mat` files, motion parameters and the TSV, b-vector rotation by the NiFreeze and SHORELine rules, and NiFreeze's `advanced_clip` with its in-place state.
