# samsrf

## 0.5.20261111

### Minor Changes

- 06f57ad: SamSrf: `Data_Precision: "single"` now runs reverse-correlation pRF analyses with the convex hull and connective fields with summary statistics or convex hulls, reproducing MATLAB's single correlations, regressions, smoothing, thresholds, medians and global signal. A constant course now follows MATLAB's rank rule in double too, so its hull matches. Gates hold both MATLAB R2023b hosts of the raw-input recording and of new constant, low-variance and threshold-boundary cases. Single 2D fits are still refused.

### Patch Changes

- Updated dependencies [06f57ad]
  - @neurodesk/samsrf@0.5.20261111

## 0.4.20261111

### Patch Changes

- Updated dependencies
  - @neurodesk/samsrf@0.4.20261111

## 0.4.20261110

### Minor Changes

- 082a3c7: Solve Beta and Baseline as MATLAB's `[ones x] \ y` does: column-pivoted Householder QR in the design's class (single arithmetic for single observations), with MATLAB's rank rule. Single and double forward and CSS fits change in the last few bits of Beta and Baseline. Coefficients are not bit-identical to MATLAB in general: on 348 recorded MATLAB R2023b solves, 123 match bit for bit the rest lie within an empirical acceptance scale and are frozen per case, and every rank decision matches. Nonfinite converted inputs now give NaN coefficients.

### Patch Changes

- Updated dependencies [082a3c7]
  - @neurodesk/samsrf@0.4.20261110

## 0.3.20261110

### Patch Changes

- Updated dependencies
  - @neurodesk/samsrf@0.3.20261110

## 0.3.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0
  - @neurodesk/samsrf@0.3.20261109

## 0.3.20261108

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
  - @neurodesk/samsrf@0.3.20261108
- Preserve double CSS correlations at underflow and overflow scales and match the measured complex regression rank threshold. Add pinned MATLAB diagnostics, focused WebAssembly regression gates and native evaluation traces; remaining double CSS differences stay explicit.
- Updated dependencies
  - @neurodesk/samsrf@0.3.20261108

## 0.3.20261107

### Patch Changes

- Updated dependencies
  - @neurodesk/samsrf@0.3.20261107

## 0.3.20261106

### Minor Changes

- f1726f2: Match MATLAB's removal of retraced zero-area polygon edges before estimating connective-field hulls, preserve small polygon areas away from zero, and correct mixed-precision Benson coordinate conversion. Add optional single-precision observations for forward fits. Expand actual MATLAB reference recording to raw input conversion, both hemispheres, independent pRF data, CSS arithmetic and mesh smoothing. Add saved forward-fit precision and CSS convention controls, the opt-in complex SamSrf CSS path, and the original CF Gaussian residual summation order. Match MATLAB's pixel-reduction order and complex regression rank decisions, reject nonfinite CSS objectives, and reproduce complex simplex ties.

### Patch Changes

- Updated dependencies [f1726f2]
  - @neurodesk/samsrf@0.3.20261106

## 0.2.20261106

### Minor Changes

- Add a legacy SamSrfX 10.003 map-export convention in advanced settings and model JSON, shared by the browser and CLI. Record actual MATLAB Runtime references and verify matched-precision fits and legacy exports in CI. Document the remaining default-single versus float64 fitting differences.

### Patch Changes

- Updated dependencies
  - @neurodesk/samsrf@0.2.20261106

## 0.1.20261106

### Patch Changes

- Preserve the stimulus radius when leaving circular tuning, cancel pending folder imports when clearing inputs, and honor explicit command-line output prefixes.
- Updated dependencies
  - @neurodesk/samsrf@0.1.20261106

## 0.1.20261105

### Patch Changes

- Correct scalar HRF arrays and nearly constant prediction fits, validate hemisphere and anatomy inputs, preserve custom model grids, and align tuning presets and run ordering with SamSrf. Restore original whole-surface X001 example runs for connective-field global-signal correction and document remaining MATLAB differences with a single-precision reference mode.
- Updated dependencies
  - @neurodesk/samsrf@0.1.20261105

## 0.1.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0
  - @neurodesk/samsrf@0.1.20261104

## 0.1.20261103

### Minor Changes

- 239dedd: Add SamSrf, which maps population receptive fields and connective fields on the cortical surface from GIfTI time series: a forward-model pRF fit, reverse-correlation pRF and reverse-correlation connective fields, with SamSrf's model presets, its GIfTI map set and the maps drawn on the inflated surface with an R² threshold. Shared components gain `writeMz3Scalars`, a scalar-only mz3 that NiiVue loads as a mesh layer, and `readFreeSurferCurv`.
- 5614d1f: Add a portable `samsrf` command line for Linux, Windows and macOS. `samsrf prf|rc|cf MODEL.json OUTPUT_DIR --runs RUN.gii ...` runs SamSrfAnalysis on GIfTI runs with `--roi`, `--apertures`, `--seed`, `--template` and `--surf` (or `--white` and `--area`), SamSrf's normalise and average switches (`--no-normalise`, `--concatenate`) and `--shards N` worker threads, and writes the web app's GIfTI map set with a provenance file. `@neurodesk/samsrf/node` gains `readAnalysisInputs`, `analysisSpec`, `runJob` and `shardRanges`, which the command line and the validation share. Its release check runs `rc` on the example's V1-V3 label and the `prf` fit and `cf` on 200 vertices, and holds every map byte for byte to the same job run in-process. The package now follows the app's date version.

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
  - @neurodesk/samsrf@0.1.20261103
- Updated dependencies [8e9346d]
- Updated dependencies [239dedd]
- Updated dependencies [5614d1f]
- Updated dependencies [10dcdf7]
  - @neurodesk/webapp-components@0.22.4
  - @neurodesk/samsrf@0.1.20261103
