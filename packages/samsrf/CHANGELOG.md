# @neurodesk/samsrf

## 0.1.20261106

### Patch Changes

- Preserve the stimulus radius when leaving circular tuning, cancel pending folder imports when clearing inputs, and honor explicit command-line output prefixes.

## 0.1.20261105

### Patch Changes

- Correct scalar HRF arrays and nearly constant prediction fits, validate hemisphere and anatomy inputs, preserve custom model grids, and align tuning presets and run ordering with SamSrf. Restore original whole-surface X001 example runs for connective-field global-signal correction and document remaining MATLAB differences with a single-precision reference mode.

## 0.1.20261104

## 0.1.20261103

### Minor Changes

- 5614d1f: Add a portable `samsrf` command line for Linux, Windows and macOS. `samsrf prf|rc|cf MODEL.json OUTPUT_DIR --runs RUN.gii ...` runs SamSrfAnalysis on GIfTI runs with `--roi`, `--apertures`, `--seed`, `--template` and `--surf` (or `--white` and `--area`), SamSrf's normalise and average switches (`--no-normalise`, `--concatenate`) and `--shards N` worker threads, and writes the web app's GIfTI map set with a provenance file. `@neurodesk/samsrf/node` gains `readAnalysisInputs`, `analysisSpec`, `runJob` and `shardRanges`, which the command line and the validation share. Its release check runs `rc` on the example's V1-V3 label and the `prf` fit and `cf` on 200 vertices, and holds every map byte for byte to the same job run in-process. The package now follows the app's date version.
- 10dcdf7: Phase 1 of the SamSrf port: a Rust core compiled to one WebAssembly binary for browsers and Node, with GIFTI, FreeSurfer, MAT v5, NIfTI and GIF readers, the SPM-style GIFTI map writer, aperture vectorisation, model JSON parsing with `samsrf_model_defaults`, the model expression language and pRF profile functions, every HRF variant, `samsrf_gii2srf` preprocessing with the noise ceiling and global signal, and `samsrf_removenoise`. The three analyses run behind one `createJob`: `samsrf_fit_prf` (search space, coarse fit, Nelder-Mead or Hooke-Jeeves fine fit, concurrent HRF fit, compressive nonlinearity, bad-fit filter, betas, `samsrf_normr2`), `samsrf_revcor_prf` (convex hull or 2D model fit) and `samsrf_revcor_cf` (convex hull, summary statistics or Gaussian fit, geodesic smoothing), each on vertex ranges a browser can spread over Web Workers. An Octave harness runs SamSrf's own sources for the reference; the readers, preprocessing and HRFs pass 106 parity checks at 1e-9 and the analyses are compared map by map (`validation/README.md`).
