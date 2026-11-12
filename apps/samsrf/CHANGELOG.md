# samsrf

## 0.6.20261112

### Minor Changes

- 4312c49: Solve Beta and Baseline with the summation orders of MKL's own `?gemv`, `?ormqr`, `?trsv` and `?trsm` as MATLAB R2023b runs them on AMD hosts, read from MKL's summation trees, and with LAPACK's `?ladiv` in the reflectors. On 348 recorded MATLAB solves, 300 coefficients are now bit-identical (previously 123), including every real double design; the rest stay within the empirical acceptance scale. A new multi-column solve reproduces MATLAB's `A \ B` for reverse correlation and the global regression to adopt. Results on Intel hosts, where MKL's AVX-512 branch sums differently, are not reproduced.

### Patch Changes

- Internal single-precision reverse-correlation 2D fits now evaluate `samsrf_fit2dprf`'s objective and R² in single arithmetic, as MATLAB R2023b does on a single profile. The three recorded single RC 2D cases replay exactly from each MATLAB host's profiles (every parameter, R², and fitted, below-threshold and rejected vertex). On the AMD (MKL CNR `auto`) reference host, every map value equals MATLAB's from the raw runs. Before, 3 to 8 vertices per case differed, some fitted where MATLAB rejected them. Single RC 2D and single CF Gaussian fits remain refused in the API, command line and app: no bound covers other inputs, the Hooke-Jeeves fine fit has no recording, and MATLAB's AVX-512 host differs from the port in the profile.
- Updated dependencies
  - @neurodesk/samsrf@0.6.20261112
- The single-precision least-squares solve now reproduces MATLAB R2023b's MKL in three more operations: `snrm2` squares the rescaling ratio first, as the reference Fortran reads; complex `?unmqr` sums the real and imaginary halves of `v^H c` in separate accumulators; and `ctrsv` divides in double. On MATLAB's AMD reference hosts every single reverse-correlation profile and map value now equals MATLAB's bit for bit (82-96% of profile entries before), and 346 of the 348 recorded `[ones x] \ y` designs are bit-identical (300 before); the other two differ only in the sign of an imaginary zero MATLAB does not store. In double, the recorded original CSS pipeline's Beta and Baseline now equal MATLAB's bit for bit (two coefficients differed); the nonnegative control keeps its one differing coefficient. Single Gaussian fits stay refused, and the Intel AVX-512 host is not reproduced.
- Improve the Benson reader with empirical single-precision sine and cosine kernels adapted from fdlibm. The reader now equals all recorded MATLAB templates, including held-out V1 seeds, and the raw-input hull/summary gates require exact template coordinates. Internal Gaussian CF gates also match the recorded AMD cases, but public single Gaussian CF and RC 2D fits remain refused: remaining whole-atlas coordinate and exponential discrepancies have no established end-to-end acceptance bound. Preserve the exhaustive trig recording, fixed-exception digest gates, and upstream notices.
- Updated dependencies
  - @neurodesk/samsrf@0.6.20261112
- a67952b: Single-precision reverse-correlation profiles and the connective-field global-signal regression now solve every right-hand side in one least-squares call, as MATLAB does: `[Y ones] \ X` over all aperture pixels and `[X ones] \ Y` over all ROI courses. On the AMD (MKL CNR `auto`) reference host, single CF results with global-signal correction now equal MATLAB R2023b's bit for bit, residuals and profiles alike. Single RC profiles rise from 31% to 82-96% identical. A course with a NaN keeps its column position as zeros and comes back zeroed; MATLAB's result for such a course was not recorded. Single Gaussian CF fits stay refused because the Benson reader's x0 and y0 are not yet bit-identical.
- Updated dependencies [a67952b]
  - @neurodesk/samsrf@0.6.20261112
- Updated dependencies [5bb36bb]
  - @neurodesk/samsrf@0.6.20261112
- Updated dependencies [4312c49]
  - @neurodesk/samsrf@0.6.20261112

## 0.5.20261112

### Patch Changes

- 36dee9d: Single-precision connective-field profiles now equal MATLAB R2023b's bit for bit on the AMD (MKL CNR `auto`) reference host. `corr(y, X)` forms its product in MKL's recorded `y' * A` order (four-lane blocks of four columns, eight lanes for the rest) and limits coefficients to [-1, 1] as `corr.m` does. Without global-signal correction, every single convex-hull and summary-statistics map and every recorded profile matches. Single Gaussian CF fits (`Fit_pRF = 1`) stay refused. Their arithmetic (MATLAB's single `exp` and the mixed single and double objective) reproduces MATLAB's maps from MATLAB's template, but the Benson reader's x0 and y0, and the single global regression, are not yet bit-identical.
- Updated dependencies [36dee9d]
  - @neurodesk/samsrf@0.5.20261112
- c95c6ab: Connective-field convex hulls now use an empirical compatibility model of MATLAB R2023b `polyshape`: vertices move to its fixed-point grid (centred, scaled by a power of ten and truncated), self-intersecting clusters are resolved with the even-odd rule, and the 1e-8 thinness cleaning works on that grid. All 253 polygons of the 741-case MATLAB reference now pass without exclusions, and 25,980 of 26,073 recorded polygons give MATLAB's hull vertices bit for bit; the remaining 93 are nearly collinear point clouds whose crossings MATLAB resolves by snapping. Maps from the real Benson templates are unchanged.

  The unresolved cases retain frozen port regression outcomes. Unrepresentable grid scales return an empty hull before integer conversion, preventing overflow or nontermination on extreme coordinates. The package includes Clipper and fdlibm notices.

- Updated dependencies [c95c6ab]
  - @neurodesk/samsrf@0.5.20261112

## 0.5.20261111

### Minor Changes

- 06f57ad: SamSrf: `Data_Precision: "single"` now runs reverse-correlation pRF analyses with the convex hull and connective fields with summary statistics or convex hulls, reproducing MATLAB's single correlations, regressions, smoothing, thresholds, medians and global signal. A constant course now follows MATLAB's rank rule in double too, so its hull matches. Gates hold both MATLAB R2023b hosts of the raw-input recording and of new constant, low-variance and threshold-boundary cases. Single 2D fits are still refused.

### Patch Changes

- Updated dependencies [06f57ad]
  - @neurodesk/samsrf@0.5.20261111

## 0.4.20261111

### Patch Changes

- a811ddf: Read the app version from package.json, so the config always reports the released version.
- ef9cded: Connective-field convex hulls now triangulate the template like MATLAB's `delaunay` when points are cocircular (exact predicates with CGAL's symbolic perturbation instead of Delaunator), and drop polygon spikes narrower than 1e-8 of the span as MATLAB's `polyshape` does. Maps from real Benson templates are unchanged. New MATLAB R2023b recordings cover polygon boundary sweeps, Delaunay ties, region growing and real templates of both hemispheres.
- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [ef9cded]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0
  - @neurodesk/samsrf@0.4.20261111
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
