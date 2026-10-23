# @neurodesk/hmc

## 0.2.1

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1

## 0.2.0

### Minor Changes

- f74f2ae: Add the `@neurodesk/hmc` package for DWI head-motion correction. It runs a pool of `@neurodesk/hmc-registration` kernels (Web Workers in a browser, worker threads in Node; the caller sets the count), cancels through an `AbortSignal` (the workers are terminated), reports progress per volume and stage, resamples the series once with the per-volume transforms (`--apply` with `BSpline`, order 3, the closest interpolator to NiFreeze's SciPy cubic spline), and writes the BIDS-derivative outputs: `*_desc-hmc_dwi.nii.gz` with the b0 volumes kept, `.bval`, `.bvec`, `*_desc-hmc_motion.tsv`, a JSON sidecar and one ITK `.mat` per volume. The committed `src/hmc.wasm` is the WebAssembly build of the `hmc` crate (`exes/dwi/hmc-wasm`): `.mat` files, motion parameters and the TSV, b-vector rotation by the NiFreeze and SHORELine rules, and NiFreeze's `advanced_clip` with its in-place state.
