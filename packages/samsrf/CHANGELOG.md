# @neurodesk/samsrf

## 0.3.20261111

### Patch Changes

- Model MATLAB R2023b's double CSS objective stage by stage: ported fdlibm elementary functions, plus empirical models of MATLAB's complex power of negative responses, its `conv` and MKL's dot products and norms. All 108 recorded CSS optimizer traces now follow MATLAB bit for bit, and the recorded double pipeline matches every non-coefficient map exactly with MATLAB's HRF kernel. The remaining HRF (`gampdf`) and coefficient differences, and MATLAB's Intel/AMD reference difference, are documented and gated.

## 0.3.20261110

### Patch Changes

- Recover finite double CSS dot products after intermediate overflow, restoring the recorded optimizer paths at two more vertices. Pin expanded MATLAB diagnostics and require their objective decisions and focused WebAssembly map comparisons; remaining CSS differences stay explicit.

## 0.3.20261109

## 0.3.20261108

### Patch Changes

- Preserve double CSS correlations at underflow and overflow scales and match the measured complex regression rank threshold. Add pinned MATLAB diagnostics, focused WebAssembly regression gates and native evaluation traces; remaining double CSS differences stay explicit.

## 0.3.20261107

### Patch Changes

- Record double CSS optimizer and QR diagnostics alongside single precision, retain execution requests and observations separately, and select reference precision explicitly in the MATLAB comparator.

## 0.3.20261106

### Minor Changes

- f1726f2: Match MATLAB's removal of retraced zero-area polygon edges before estimating connective-field hulls, preserve small polygon areas away from zero, and correct mixed-precision Benson coordinate conversion. Add optional single-precision observations for forward fits. Expand actual MATLAB reference recording to raw input conversion, both hemispheres, independent pRF data, CSS arithmetic and mesh smoothing. Add saved forward-fit precision and CSS convention controls, the opt-in complex SamSrf CSS path, and the original CF Gaussian residual summation order. Match MATLAB's pixel-reduction order and complex regression rank decisions, reject nonfinite CSS objectives, and reproduce complex simplex ties.

## 0.2.20261106

### Minor Changes

- Add a legacy SamSrfX 10.003 map-export convention in advanced settings and model JSON, shared by the browser and CLI. Record actual MATLAB Runtime references and verify matched-precision fits and legacy exports in CI. Document the remaining default-single versus float64 fitting differences.

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
