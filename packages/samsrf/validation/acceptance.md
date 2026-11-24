# SamSrf MATLAB-parity acceptance matrix (#729-#733)

This file maps each acceptance criterion of issues #729 to #733 to the available
test or evidence, its measured scope and what remains. It was
audited on 2026-11-13 against `main` at `ef089b0a`, brought up to date on
2026-11-16 against `main` at `6df4fb3e` (after #855 and #857), reconciled
on 2026-11-19 against `main` at `3cf5c9cf` (after #895, `62a5f0c3`) for #897,
and updated on 2026-11-23 after #900, #902, #904, #915, #916, #917, and the
Build 5 local licensed build, restored 24-run Runtime-only audit, and lossless
production UI matrix.
The issues' original descriptions predate most of this work. This audit does
not change their acceptance requirements or approve closing an issue.

[Current state after #895](#current-state-after-895) and
[Open numerical limits](#open-numerical-limits) are the current summary. A row
below that describes an earlier head says so and points there. #729 is closed
on GitHub while its public single RC 2D and CF Gaussian fits stay refused; they
are tracked in the open limits and in #897. This file does not reopen or close
an issue.

"Reference" means MATLAB R2023b Update 11 source code (SamSrf `41ed1e96`, SPM
`03ac9473`) run on the pinned recordings' hosts. "AMD" means AMD EPYC runners
where MATLAB reports CNR `auto`;
"Intel" means Intel Xeon runners where MATLAB reports `AVX512_E1`. These
reported labels do not verify effective CNR or dynamic-thread controls. Every
gate listed fails CI when its pinned reference is missing.
Agreement is with these recordings, not a proof for other inputs, MATLAB or MKL
releases.

The numerical sections of [matlab/README.md](matlab/README.md) own the details
for #729 and #730 ("Reverse-correlation port gates", "Single sin and cos",
"Double CSS arithmetic"), and its geometry and Runtime-container sections own
#732 and #733. This file only points to them.

Status: **Met** (the criterion holds as written), **Met on AMD** (holds against
the recorded AMD subset; this does not exclude Intel from the issue),
**Partial** (holds for a stated subset) or **Open**.

## Current state after #895

`Arithmetic_Reference` is a per-analysis product option in the app, the command
line and the API (#895): `current` (the default), `matlab-amd` and
`matlab-intel`. Nothing selects one from the CPU. `current` keeps the output of
module `abbd6625`, including the double global regression by normal equations.
`matlab-amd` adds MATLAB's `[X ones] \ Y` for that regression (module
`cc528cf6`). `matlab-intel` runs the reviewed Intel `AVX512_E1` double real and
complex kernels (module `dcaa83df`) from the shipped core
(`exes/samsrf/core/src/arithmetic/intel`). The validation crate
`samsrf-mkl-avx512` re-exports that implementation for the native gates and
refuses a WebAssembly build. Rows below that call the Intel arithmetic
test-only describe heads before #895.

`matlab/check_arithmetic_references.mjs` holds the product's output files for
each reference to the literal hashes in
[`matlab/arithmetic-reference-outputs.json`](matlab/arithmetic-reference-outputs.json):
24 runs each for `current` and `matlab-amd`, and the 12 double runs for
`matlab-intel`.

The 24-run SamSrfAnalysis matrix against source MATLAB (`matlab/cli-reference.json`,
run 42928350417; the source receipts do not attest the inputs), checked again on
2026-11-23 with the committed module:

| Reference | AMD EPYC 9V74 (CNR `auto`) | Intel Xeon Platinum 8573C (`AVX512_E1`) |
| --- | --- | --- |
| `current` (default) | 20 runs exact, 2 differ, 2 refused; 163 of 168 maps | No run exact, 22 differ, 2 refused; 63 of 168 maps |
| `matlab-amd` | 20 runs exact, 2 differ, 2 refused; 166 of 168 maps | No run exact, 22 differ, 2 refused; 63 of 168 maps |
| `matlab-intel` | No run exact, 22 differ, 2 refused; 63 of 168 maps | 19 runs exact, 3 differ, 2 refused; 158 of 168 maps |

A map is exact when every raw `Srf.Data` value, imaginary part and GIfTI value
equals MATLAB's, bit for bit. Under `current` on the AMD host every float32
GIfTI of the 22 computed runs equals MATLAB's. With production reverse-correlation
hulls adopting MATLAB's symmetric pixel grid, stored Delaunay boundary centroid
and `convexHull` area (`delaunay_convex_hull_area`), both `rc_hull_lh_double`
and `rc_custom_hrf_lh_double` are now exact on AMD (`current` and `matlab-amd`)
and on Intel (`matlab-intel`), leaving only 5 differing maps under `current` on
AMD (41 raw double values: 12 CF hull `y0` values across `cf_hull_lh_double` (7)
and `cf_hull_smooth_global_lh_double` (5), plus 29 values of R², Beta and
Suppression in `cf_hull_smooth_global_lh_double`). `matlab-amd` makes those 29
exact, leaving only the 12 CF hull `y0` values (2 differing maps).

How these were checked: `run_web_matrix.mjs`, `compare_web_cli.py` and
`web_cli_outcome.py check` for the default (as CI runs them);
`check_arithmetic_references.mjs` for all three references; and, for the
`matlab-amd` and `matlab-intel` rows, `run_web_matrix.mjs --reference <ref>`
(and `run_browser_matrix.mjs --reference <ref>`) passed with the same `--reference`
to `compare_web_cli.py` against each host's source execution (the Intel host on
its own bundle), without mutating the bundle's plan models. `compare_web_cli.py`
checks that `environment.json` records the matching `arithmeticReference` and
classifies only the two universal single Gaussian runs (`rc_gaussian_lh_single`,
`cf_gaussian_lh_single`) as `refused` across all three references. On Intel
Xeon Platinum 8573C, `matlab-intel` reproduces 10 of 12 double runs (90 of 92
double maps, leaving only the same 12 CF hull `y0` values as AMD) and 9 of 10
runnable single-precision runs bit for bit (all 68 maps of those 9 runs, plus
`Noise Ceiling` of `prf_css_lh_single`), leaving only the 12 complex vertices
of `prf_css_lh_single` (mixed complex-double × real-single dot order not
pre-registered). The `matlab-amd` and `matlab-intel` double counts agree with
the reviewed accounting in
[`matlab/intel-avx512/harness/cc528cf6-main4cdc/avx512-complex-qr/matrix.json`](matlab/intel-avx512/harness/cc528cf6-main4cdc/avx512-complex-qr/matrix.json)
(aside from the 16 CF hull `y0` values resolved by #902).
These are results on a finite set of recorded inputs, not general MATLAB
equivalence.

Since #897 the app and the `samsrf` command line also write a lossless file,
`<prefix>_lossless.bin`: every map's raw doubles and, for a complex result, the
imaginary parts ([package README, "Lossless export"](../README.md#lossless-export)).
The provenance JSON names it with its SHA-256. `compare_ui_cli.py` reads it from
each download, requires it to equal the engine harness's raw maps and counts a
map exact only when its doubles and imaginary parts also equal MATLAB's. On
2026-11-23 (`main` at `2d4581c3f`, committed WASM `d1745bec…`, Chromium
`156.0.8078.4`), the production interface was measured across the full 24-run
matrix with lossless downloads against the locally built, unpublished Build 5
compiled image (`sha256:c132e952…`) and source execution on one AMD host
(`current` default reference, with Build 5's `web-1` as the engine root): both
`ui-1-vs-compiled.json` and `ui-1-vs-source.json` exit 0 (`failures: []`), with
**20 of 24 runs exact, 2 differing, 2 refused, 0 `unsupported`, 0 `ui-error`,
0 `failed`, and 0 `inventory-error`**; **163 of 168 maps exact** across all 22
lossless downloads (`losslessDownloadRuns: 22`, `losslessComparedMaps: 168`),
and **212 of 212 downloaded GIfTIs equal to the engine harness's**
(`engineFilesDiffer: 0`, `engineMismatchRuns: 0`, with the 22 lossless downloads
verified by array contents and provenance separately). Both CSS runs are exact
including imaginary parts, both double RC hull runs are exact in raw double, and
only the same 5 maps of `cf_hull_lh_double` (`y0`, 7 vertices) and
`cf_hull_smooth_global_lh_double` (`R^2`, `y0`, `Beta`, `Suppression`, 5–13
vertices, up to 147 ULP) differ in raw double while their float32 GIfTIs are
exact. This is local single-host evidence against an unpublished image, not
cross-host or general UI parity.

The command line takes a subject HRF fit with `--hrf hrf_*.mat`, built into the
kernel by the code the app uses, and `apps/samsrf/automation.json` has the
matching `subjectHrf` input for `prf` and `rc`.

## Open numerical limits

What remains of #897 items 1 to 3, per arithmetic reference. Each entry gives
the recorded evidence, what the product does, the issue that tracks it and
what would move it. "Refused" means the core returns the quoted message;
`test/arithmetic.test.js` ("unsupported paths are refused with their exact
messages") pins each quoted message, and the matrix comparators count a refusal
only with that text. Moving an entry that needs a MATLAB recording needs a
separately reviewed and authorized proposal: the cleanup-order-1 (1 of 1) and
hull-area-1 (2 of 2) budgets are spent.

| Limit | `current` (default) | `matlab-amd` | `matlab-intel` |
| --- | --- | --- | --- |
| Two double CF hull runs | Differ on AMD: 12 CF hull `y0` values and 29 global-regression values (at most 147 ULP); both RC hull runs are exact | Differ on AMD: the 12 CF hull `y0` values | Differ on Intel: the same 12 CF hull `y0` values; both RC hull runs are exact |
| Whole-cortex global-signal sum | 2,000 of 2,000 values exact (AMD, double and single) | 2,000 of 2,000 values exact (AMD, double and single) | 1,000 of 1,000 double values exact (Intel, 0.0 rel err); single uses the same 1,024-column chunking |
| Single RC 2D and single CF Gaussian fits | Refused | Refused | Refused |
| Other single analyses | Run | Run | Run: 9 of 10 CLI runs bit-exact on Intel Xeon 8573C (`prf_css_lh_single` differs on its 12 complex vertices) |
| CSS with `Css_Convention: "nonnegative"` | Runs | Runs | Runs: 48/48 evals and 12/12 Nelder-Mead fits bit-exact on Intel Xeon 6975P-C and AMD EPYC 7763 |
| Fewer than two volumes | Runs | Runs | Refused |
| Norms at rounding ties | AMD norm order, which matches the recorded AMD norms | AMD norm order, as `current` | Resolved: portable software x87 80-bit `dnrm2`/`dznrm2` (168/168 real, 48/48 complex, 8/8 extreme, 1,200/1,200 `corr`) |
| Small-shape `gampdf`, zero signs, single `sin`, `cos`, `exp` | Small-shape `gampdf` (29,376/29,376) and negative-base power zero signs (0/27,552 diffs) match MATLAB; single `sin`, `cos`, `exp` remain open | Same as `current` | Same as `current` |

### 1. Hull geometry and full-pipeline last bits (#732; historical #729)

**The two remaining double CF hull runs.** `cf_hull_lh_double` and
`cf_hull_smooth_global_lh_double` (`rc_hull_lh_double` and
`rc_custom_hrf_lh_double` are now bit-exact on AMD under `current`/`matlab-amd`
and on Intel under `matlab-intel`).

- Evidence: the matrix above. With `delaunay_convex_hull_area` (matching all
  424 point sets and 424 corner hulls in round `hull-area-1` on both AMD and
  Intel, gated by `cli_rc_hulls.rs`) and MATLAB's symmetric pixel grid and
  stored Delaunay boundary centroid enabled in production RC hulls, all 82 raw
  double differences in `rc_hull_lh_double` and `rc_custom_hrf_lh_double` are
  resolved (0/42 `Fwhm` diffs in `cli_rc_hulls.rs`, production RC hulls bit-exact
  in `revcor_reference.rs`). Only 12 CF hull `y0` values remain across
  `cf_hull_lh_double` (7) and `cf_hull_smooth_global_lh_double` (5) under
  `current`, `matlab-amd`, and `matlab-intel`. Under `current` the AMD
  comparison also differs in `cf_hull_smooth_global_lh_double`'s R² (8 values,
  up to 147 ULP, 2.2e-14 relative), Beta (8, up to 61 ULP) and Suppression (13,
  up to 28 ULP). That is the default's double global regression, not geometry;
  `matlab-amd` removes it. The 147 ULP named in #897 is this R² value.
- Product: these runs complete and differ by those amounts. Their float32
  GIfTIs equal MATLAB's. Production uses `HullOrder::Anchored` for CF hulls
  and MATLAB's symmetric pixel grid, stored Delaunay boundary centroid and
  `convexHull` area for RC hulls.
- Accounting: the 12 values under `matlab-intel` and the 12 under the AMD
  references are the same positions measured against two recordings. Count
  them per reference and host, never as 24 cases, and never as additions to
  the default map counts.
- To move it: identify MATLAB's ring decomposition of self-intersecting and
  near-coincident clouds
  ([hull area, centroid and vertex order](matlab/README.md#hull-area-centroid-and-vertex-order-732)).
  The stored-order diagnostic for CF hulls and the experimental Clipper model
  each lose values the shipped evaluation matches, so neither is an approved
  replacement. [cleanup-order-1](matlab/cleanup-order-1/result.md) ended
  undecided (STOP on `MATLAB:polyshape:repairedBySimplify`); no prediction was
  adopted.

**The whole-cortex global signal.**

- Evidence: `constants_gemv.rs` (run 43882331042) pins the port's `nanmean`
  over every vertex (1,024-column sequential chunking in `VolumeMean`, with
  float32 division for single precision) across explicit arithmetic references:
  on the AMD EPYC 9V74 host, both `current` and `matlab-amd` match 2,000 of
  2,000 MATLAB values bit for bit (1,000 double and 1,000 single, up from 15 of
  2,000). On the Intel Xeon 6975P-C (`AVX512_E1`) host, `matlab-intel` double
  matches all 70,500 recorded double `courses`, all 282 `noiseCeiling` values,
  and all 1,000 of 1,000 aggregate global-signal values bit for bit (0.0 max
  relative error, up from 8 of 1,000; single is refused).
- Product: runs. Connective fields with global-signal correction regress on
  this signal under every reference. The sum itself uses MATLAB's 1,024-column
  chunked reduction; the courses it sums depend on the reference (`matlab-intel`
  detrends with the Intel kernels).

### 2. Single-precision and Intel paths (#731; historical #729)

**Single RC 2D (Gaussian) and single CF Gaussian fits.**

- Evidence: internal gates equal MATLAB's AMD maps for three RC 2D and twelve
  CF Gaussian cases (`revcor_reference.rs`), and Hooke-Jeeves replays on one
  subject (#729 rows below). Not covered: 18 recorded single `exp` inputs,
  19 whole-atlas template coordinates (10 LH, 9 RH vertices, one ULP), and the
  Intel host's maps.
- Product: refused under every reference, before the reference is checked:
  "Data_Precision=single with a Prf_Function fit is not supported by this port"
  (`rc`) and "Data_Precision=single with Fit_pRF=1 is not supported by this
  port" (`cf`). The matrix lists `rc_gaussian_lh_single` and
  `cf_gaussian_lh_single` as refused.
- To move it: an end-to-end acceptance bound, or MATLAB's single `exp`, `sin`
  and `cos` at these inputs, shown on recordings not read before the rule is
  frozen.

**`matlab-intel` single-precision analyses (resolved for BLAS and two-column QR; mixed complex-single dot open).**

- Evidence: the pre-registered recording (`intel-norm-single-css-reference.json`,
  workflow run 45286336873 on commit `6ab8c5bca`, Hugging Face commit
  `54645a921b7c442085b2db974ad78ed8b89d00d9`) and held-out recordings on Xeon
  8573C (`single-kernels`) and Xeon 8370C (`qr-kernels`) establish MKL
  AVX512_E1's single `sdot` (4,400/4,400 exact, lengths 2..=1,000), `sgemv_t`
  (5,500/5,500 exact + 378/378 held-out Xeon 8573C), `scorr` (140/140 exact),
  real two-column QR (`107/107` 1-col chains + `1,712/1,712` 8-col solves on
  Xeon 8370C; `160/160` 1-RHS + `1,280/1,280` 8-RHS on Xeon 6975P-C), and
  complex two-column QR (`67/67` 1-col chains + `1,072/1,072` 8-col solves on
  Xeon 8370C, matching every stored component bit for bit, with zero imaginary
  parts verified where MATLAB omitted the imaginary array on all-zero-imaginary
  multi-RHS results such as `glm_single_1e-10_0.3_multi_ones-first`; `160/160`
  1-RHS + `1,280/1,280` 8-RHS on Xeon 6975P-C), gated by
  `mkl-avx512/tests/intel_norm_single_css.rs`. On the unseen 24-run Intel Xeon
  8573C CLI matrix, 9 of 10 runnable single-precision runs match bit for bit;
  only `prf_css_lh_single` differs on its 12 complex vertices (the mixed
  complex-double × real-single `cdotc_real` dot order was not pre-registered).
- Product: runs for all single-precision analyses except the two universal
  single Gaussian refusals above (`rc_gaussian_lh_single`,
  `cf_gaussian_lh_single`).

**Intel CSS with the nonnegative convention (resolved).**

- Evidence: `intel-norm-single-css-reference.json` (run 45286336873,
  `nonnegative-css.json`) records 48 signed-aperture evaluations and 12 full
  Nelder-Mead `fminsearch` fine fits on `x001_lh` across both Intel Xeon 6975P-C
  and AMD EPYC 7763 (every seed verified to exercise both negative clipping and
  positive compression). `mkl-avx512/tests/intel_norm_single_css.rs` matches all
  48/48 evaluations (`objective`, `beta`) and all 12/12 fits (`fitted`, `fval`,
  `1 - fval`, `exitflag`, `funcCount`, `iterations`, `beta`) bit for bit on both
  hosts.
- Product: runs under `current`, `matlab-amd`, and `matlab-intel`; `current`
  retains its pre-existing default arithmetic unchanged.

**Fewer than two volumes** under `matlab-intel` are refused: "model:
matlab-intel arithmetic requires at least two volumes".

### 3. Numerical edge cases and coverage (#730, #731)

**Intel `dnrm2` / `dznrm2` near rounding midpoints (resolved).**

- Evidence: the pre-registered blind probe suite (`intel-dnrm2-probes.json` /
  `intel-norm-single-css-reference.json`, run 45286336873) uniquely identified
  MKL AVX512_E1's `dnrm2`/`dznrm2` as four-lane x87 80-bit extended-precision
  accumulation (`a0 += a2; a1 += a3;`, optional 2-element tail into `(a0, a1)`,
  `tot = a0 + a1`, optional final element into `tot`, 64-bit RNE `sqrt`, then
  53-bit RNE to `f64`). The portable zero-allocation software `F80`
  implementation in `exes/samsrf/core/src/arithmetic/intel/mod.rs` reproduces
  all 168/168 blind real near-midpoint norms, all 48/48 blind complex norms
  (exact pre-registered SHA-256 `5db3763f…`), all 8/8 extreme-scale norms
  (`2^±600`, `2^±1000`, exact pre-registered SHA-256 `20add51c…`), and all
  1,200/1,200 `arithmetic-order` `corr` values including both previously pinned
  near-tie misses (`n = 36` pair 6 and `n = 75` pair 16), with zero regressions
  on any existing gate (`mkl-avx512/tests/recordings.rs`, `blas_recordings.rs`,
  `intel_norm_single_css.rs`).
- Product: `matlab-intel` uses this portable software `F80` `nrm2` across native
  and WebAssembly builds (also removing `num-bigint` from production WASM).

**Small-shape `gampdf` and zero signs (resolved on the pinned recordings).**

- Evidence: every recorded density with shape of at least 1 equals MATLAB's
  (9,760 in `matlab_numerics2.rs`). Below 1 (`0 < a < 1`), production evaluates
  the shifted Loader recurrence `(poisson_raw(a_rt, z) * exp(log(a_rt) - log(z))) / b`
  with `a_rt = (a - 1) + 1` and MATLAB's `z < k * f64::MIN_POSITIVE` direct
  log-space branch inside `poisson_raw`, matching all 29,376 positive and 108
  edge held-out densities bit for bit on both AMD and Intel hosts
  (`held_out_gamma.rs`, run 43882331042; up from 2,054 of 29,376). In
  negative-base powers (`matlab_numerics.rs`), evaluating the whole-exponent
  factor in real arithmetic before complex multiplication reproduces every
  recorded value and zero sign (0 of 27,552 differing zero signs, down from
  2,440).
- Product: runs identically across references; extreme tiny shapes where
  `(a - 1) + 1 <= 0` fall back to the closed form.

**Single elementary functions and template coordinates.** The single `sin`
and `cos` candidates differ from MATLAB on 36,350 and 32,406 of 2,257,723,138
inputs ([single sin and cos](matlab/README.md#single-sin-and-cos)); on the
whole X001 Benson atlases that is one ULP of x0 or y0 on 10 LH and 9 RH
vertices. 18 recorded single `exp` inputs differ. Every recorded template
equals the reader's, and the single CF hull and summary runs of the matrix are
exact; the fits these differences can move are the refused ones above.

**Unrecorded shapes and inputs.** The QR evidence covers two-column designs
with 16 and 250 rows and 1 and 8 right-hand sides, plus the 400-pixel and ROI
solves inside the pipelines; Intel's covers the recorded finite real and
complex two-column designs. Not recorded: more columns, other lengths, ranks
and right-hand-side counts, zero `tau` and reflectors that end in zeros, the
`xLARFG` halving path, overflow, subnormal and nonfinite inputs on Intel, and
other MATLAB or MKL releases. The product runs these paths with the same
kernels and claims nothing about them; a mutation review on 2026-11-18 left
every gate passing when they were changed. Recordings that research has read
remain replay evidence, not blind holdouts.

## #731 Single-precision pivoted QR (Beta, Baseline)

| Criterion | Evidence (test) | Status | Remaining |
| --- | --- | --- | --- |
| The recorded cases keep exact rank and zero-column decisions; coefficient gates reflect demonstrated fidelity | `qr_reference.rs`: rank of all 348 designs, MATLAB's printed tolerance for all 89 warnings; 346 coefficients bit-identical, 2 at 0 ULPs with an imaginary zero MATLAB stores as real; frozen outcomes at 0 ULPs. `matlab_reference.rs` keeps the original 146 forward cases | Met on AMD | None on AMD |
| Constant, nearly constant, rank-deficient, full-rank, extreme-scale, mixed real/complex and imaginary-underflow cases; imaginary coefficients asserted | The 348 designs of `qr-reference.json` cover each family; `qr_reference.rs` compares real and imaginary parts and requires a real result where MATLAB's is real | Met | None |
| Complete single Gaussian and CSS outputs; parameter and score parity does not regress | `compare.mjs` (114 required source gates, single CSS included), `css_pipeline.rs` and `compare-css.mjs` (double CSS original 138/0, nonnegative 126/0 coefficients identical/differing), `css_diagnostics.rs` (108 traces bit for bit) | Met on AMD | Single Gaussian RC/CF fits are #729's and stay refused ([open limits](#open-numerical-limits)). History: before #873 and the single forward Beta/Baseline fix, the CLI matrix's single CSS run differed at 12-13 of 21 vertices and one single forward vertex in Beta (1 ULP) and Baseline (5 ULP); both runs are exact in the current frozen outcome |
| Missing references fail CI; MATLAB, BLAS and thread settings recorded; backend residuals separated from port errors | Recordings' `environment.json` and `hosts.json` are asserted (interpreter, BLAS line, CPU); `qr_kernels.rs` requires six hosts, five AMD with identical bits; every chain step equals MKL's (`every_recorded_chain_step_matches_mkl_on_amd`, 345 chains); `intel_norm_single_css.rs` verifies all 107 real + 67 complex single chains and 1,712 real + 1,072 complex 8-col solves on Intel Xeon 8370C plus 320 1-RHS and 2,560 8-RHS blind single solves on Intel Xeon 6975P-C | Met on AMD and Intel (single & double two-column QR) | Host metadata and finite repeats are recorded. #730's controls receipt shows MKL runs each CPU's own branch whatever is requested; MKL's thread functions are unobservable in MATLAB. Single RC/CF Gaussian fits stay refused; `prf_css_lh_single` on Intel still differs on its 12 complex vertices pending a mixed complex-single dot probe ([open limits](#open-numerical-limits)) |
| Before/after maximum ULP and absolute differences, and the covered domain, published without arbitrary-input claims | [Least-squares solves](matlab/README.md#least-squares-solves): acceptance checklist, finite-domain scope, history table (#773 → #795 → now) | Met | None |
| Changeset and README say what is exact or tolerance-based | Changesets of #795, #812, #818, #822; README "Correlations and regressions" and the QR checklist | Met | None |

Beyond the original criteria, all 696 recorded 8-column solves equal MATLAB's
(404 real bit for bit; 292 complex bit for bit except 26 imaginary zeros of
results MATLAB stores as real). Recorded single-precision reverse-correlation
profiles and global-regression residuals also equal MATLAB's on the AMD hosts.

**Intel AVX-512 branch:** since #895 an explicit option, not a host policy.
`matlab-intel` reproduces Intel's recorded finite double designs; its single
precision is refused. No reference host was chosen and `current` stays the
default. See [Intel AVX-512 and the reference host](matlab/README.md#intel-avx-512-and-the-reference-host)
and [Open numerical limits](#open-numerical-limits).

## #729 Single precision for reverse-correlation pRF and connective fields

| Criterion | Evidence (test) | Status | Remaining |
| --- | --- | --- | --- |
| Supported single RC/CF jobs compare every output vertex and map, with nonfinite, selection and profile masks | `revcor_reference.rs` (13 gates) and `compare-revcor.mjs` (1,298 public gates on both hosts): RC hull and CF hull/summary maps equal MATLAB's on AMD; profiles 8,400/8,400 and 7,200/7,200 identical | Met on AMD | Intel host keeps documented per-map limits |
| Constant, low-variance and threshold-boundary cases; per-map limits with evidence; no quotas | `revcor-edges-reference.json` cases; `threshold_boundary_is_exercised_exactly`; per-map table in "Reverse-correlation port gates" | Met | None |
| Full raw-data pipelines; double and forward single gates preserved | Raw-input matrix gates; `cf_from_raw_files_equals_the_run_on_matlabs_courses`; source gates unchanged | Met on AMD | On the SamSrfAnalysis CLI matrix (below), every computed single RC and CF run is exact on AMD since #875 fixed the NaN sign bits in CF hull x0 and y0 |
| Missing references fail CI; immutable pins | `Expected` case counts in `revcor_reference.rs`; HF commit pins with SHA-256 | Met | None |
| Upstream execution limits documented (mismatched `Rdim`) | matlab/README "Raw-input reverse-correlation matrix" | Met | None |
| Changeset, API/CLI tests, browser checks, coverage docs | `cli.test.js` (single rc writes the in-process job, refuses single 2D fits), `api.test.js`, SamSrf e2e | Met for the supported subset | — |
| Single RC 2D and single CF Gaussian fits | Internal gates only: three RC 2D cases and twelve CF Gaussian cases equal MATLAB's on AMD. [Focused probes](matlab/README.md#focused-probes-729-730) also record Hooke–Jeeves for the three single RC 2D cases: per profile host, all 43 retained fits of 78 match parameter/R² bits and all 35 rejection masks agree, on both recording hosts | **Partial: publicly refused** | Hooke–Jeeves evidence covers one subject; rejected pre-mask parameters are not compared. No general acceptance bound: 18 single `exp` inputs and 19 atlas vertices differ, Intel maps differ. Refused under every reference with the messages in [Open numerical limits](#open-numerical-limits); #729 is closed and #897 tracks them |

## #730 Double-precision CSS fits

| Criterion | Evidence (test) | Status | Remaining |
| --- | --- | --- | --- |
| Regression reproduces the discrepancies before the fix and passes after; references and precision mandatory | `css_diagnostics.rs` (108 traces, every evaluation bit for bit) | Met on AMD | — |
| Full double CSS pipelines: every parameter, R², nR², coefficients and masks, original and nonnegative apertures | `compare-css.mjs`, `css_pipeline.rs`: three 96-vertex pipelines; parameters, scores and masks bit-identical; coefficients 138/0 and 126/0 identical/differing | Met on AMD for these pipelines | History: the SamSrfAnalysis CLI CSS runs differed at 12-15 of 21 vertices because MATLAB saves a complex `Srf.Data`. Since #873, with `Css_Convention: "samsrf"`, both precisions are exact on AMD, imaginary parts included (CLI matrix below). Intel nonnegative CSS is refused ([open limits](#open-numerical-limits)) |
| Single CSS gates intact | `compare.mjs` single CSS gates | Met | — |
| Plateau ambiguity documented with objectives, predictions and repeatability | Since 0.6.20261114 the double non-CSS objective uses MATLAB's `conv`/`corr` operation orders, as the CSS objective does. `double_forward_diagnostics.rs` gates the nine double forward pipelines: x0, y0, Sigma and noise ceiling bit for bit at every vertex, R² and nR² too with fine fits, every zero/NaN mask, and Beta, Baseline and coarse R² within `1e-12 * max(1, abs(MATLAB value))`. The 14 case/vertex entries that differed before (8 plateau, 5 acceptance, 1 different optimum) now match; the README keeps their diagnosis. MATLAB's recorded `fminsearch` runs (32 fits, 12,604 evaluations, including 6 that fit the HRF) are replayed bit for bit, every evaluation. The fitted-HRF divergence was traced, by a pre-registered recording on an AMD and an Intel host, to `gampdf`'s normaliser (`log(2π)` and `log(k)` taken separately); `fitted_hrf_probes` gates every recorded kernel and density on both hosts | Partial | Beta, Baseline and coarse R² keep last-bit differences. One AMD recording: no MATLAB repeat on other hosts, Intel not reproduced, no Hooke-Jeeves or non-Gaussian double non-CSS recording. History: from raw GIfTI, double detrend and z-score once differed from both MATLAB hosts by up to 1.2e-14; since 0.6.20261116 they equal the AMD host's, and 8 double SamSrfAnalysis runs are exact there by default ([current state](#current-state-after-895)) |
| No widened tolerance or quota | Coefficient policy is exact equality or a stated scale, with no differing coefficient left | Met | — |
| Sparse `conv` arithmetic (which products MATLAB rounds before adding) | Three pre-registered recordings, each rule frozen from discovery courses before its held-out ones were opened (`conv-boundary-predictions.md`, `conv-gaps-predictions.md`). `conv_boundary.rs`: every kept part of 31 + 14 + 33 + 12 sparse courses with 9-300 taps; `conv_gaps.rs`: 12 held-out courses with 2-8 taps, the complex and real thresholds and the exact 8-block length, and the second recording's held-out courses replayed byte for byte on two AMD hosts (they were recorded on two Intel hosts). Rejected rules (the first block rule; keeping the block at exactly 8 blocks) stay as frozen negative controls | Met for the recorded courses | Not recorded: kernels as long as the course, single-tap kernels, sparse courses of at most 16 samples, dense courses beyond two controls. No claim about MATLAB's internal algorithm or arbitrary inputs |
| Pins, provenance; exact/tolerance/unsupported published | matlab/README "Double CSS arithmetic" and "Requested and effective MKL controls" record pinned files, host metadata, repeat comparisons, effective branches and current limits | Partial | AMD and Intel MATLAB run different MKL branches by design (row below). Since #895 a user picks the branch to compare with (`matlab-amd` or `matlab-intel`); one output still cannot equal both hosts |
| Reference reproducibility controls explicitly owned by #730 | `controls-reference.json` and `analyse-controls.py`: MKL's own `MKL_CBWR_Get` reports `AUTO` on AMD and `AVX512_E1` on Intel under the `COMPATIBLE`, unset and `AVX2` requests, with summation trees equal to the pinned trees of each vendor; `MKL_NUM_THREADS` never reaches MATLAB's environment; OpenMP reports one thread under every request; repeats are identical (pre-registered, 5 CPU models) | **Partial** | The branch request is ineffective, so reference arithmetic is set by the CPU, not the request. MKL's thread count and dynamic setting are unobservable through its functions in MATLAB. AMD under the `contrast` request was not drawn. #895 made the reference an explicit per-analysis choice with `current` as the default; no reference host was adopted |

## #732 Polygon exclusions and CF triangulation

| Criterion | Evidence | Status | Remaining |
| --- | --- | --- | --- |
| Remove both original polygon exclusions and pass all 253 cases | `matlab_reference.rs` asserts all 253 polygons with no named skips; polygon_191 and polygon_193 pass | Met | Broader boundary/cloud coverage is separate below |
| Independently recorded boundary sweeps and broader geometry coverage | Shipped model retains 93 exceptions among the 26,073 original-family polygons and further supplementary mismatches. The experimental, unshipped Clipper model retains 44 original, 178 held-out and 246 causal exceptions, including four regressions | **Open** | Establish a general correction without losing accepted cases. `KeepCollinearPoints` is a separate MATLAB configuration, not an observed internal stage of default `polyshape`. Round 7 (#855) rejected merging at single-vertex contacts around a void (H_M, H_M1) on 592 pre-registered cases on two AMD hosts; the 932 and 1607 holes remain unexplained |
| Exact connectivity and selected regions; justified per-value tolerances | `matlab_geometry.rs`, `geometry_reference.rs`. Production (`HullOrder::Anchored`) takes MATLAB's stored order for CF hulls whose first point starts the hull, in general position with a hull of input points, and the previous evaluation (`HullOrder::Listed`) elsewhere for CF hulls; for reverse-correlation hulls, production adopts MATLAB's symmetric pixel grid, stored Delaunay boundary centroid (`Hull::of_delaunay_boundary`) and `convexHull` area (`delaunay_convex_hull_area`). The anchored default loses no previously exact CF value and gains, per host, 16 matrix `y0` values, 26 template values per precision, 141 revcor CF values and 77,481 polygon values; `polyshape_arithmetic.rs`, `matlab_geometry.rs` and `revcor_reference.rs` hold it to every value the previous evaluation gives exactly (README, "Anchored connective-field hulls"). The full stored order for CF hulls is gated as diagnostic evidence. `polyshape_arithmetic.rs` gives every recorded hull of the four polygon recordings MATLAB's bits from MATLAB's stored vertices (87,298 per host). `matlab_geometry.rs` requires MATLAB's bits for the 15,840 original hulls it lists in MATLAB's order, with 948 in another order bounded and 79 other-vertex and 4 empty hulls among the 93 snapping clouds. RC hulls are bit for bit from MATLAB's profiles (`revcor_reference.rs`) and courses (`cli_rc_hulls.rs`, 0 of 42 `Fwhm` differences). Round hull-area-1 matches MATLAB's grid, `K` (`hull_area_report.py check`), and all 424 `AV` and 424 `cornersArea` values on both AMD and Intel (`cli_rc_hulls.rs`) | Partial | As above; the stored order for CF hulls where the first point does not start the hull awaits MATLAB's ring decomposition of self-intersecting clouds |
| Cocircular and degenerate cases with MATLAB behaviour | Probe and causal recordings | Partial | As above |
| Full CF hull, summary and Gaussian checks on real templates | `production_template_reader_equals_matlabs_template`; CF hull/summary exact on AMD. Double CF hull values from MATLAB's profiles stay within 1e-12 in production (the previous hull). The stored-order diagnostic gives them bit for bit on both hosts (revcor matrix, 504 per row) and on the real templates but for 15 listed values per host (`TEMPLATE_HULL_START`); 3 of those per host are exact under the previous hull | Partial | Single CF Gaussian is publicly refused (#729); double CF Gaussian runs and is exact on the CLI matrix. MATLAB's ring decomposition of self-intersecting clusters; the stored order's adoption in production |
| Provenance and hashes; missing cases fail CI | Pinned probe/causal recordings with repeats | Met | — |
| Changeset and docs replace the original exclusions with measured coverage and remaining limits | #799 removes the original named skips; #813 and #820 distinguish shipped coverage from experimental snapshots and document supplementary mismatches | Met for the documented scope | Broader geometry parity remains open; experimental agreement does not establish production acceptance |

## #733 Version-matched MATLAB Runtime reference container

| Criterion | Evidence | Status | Remaining |
| --- | --- | --- | --- |
| Recipe executed on a licensed builder | History: early attempts stopped at the licence check (2026-11-16: from this repository's cloud build host the licence server's private address was unreachable, License Manager Error -15,570; matlab/README "Compiler access"); on the licensed host, `licensed-host/build_and_validate.sh` then built build 2 (local ID `sha256:be7ae7aa…`, 2026-11-16; an independent audit verified its receipts on 2026-11-17, and it is in no reachable Docker store) and build 3 (2026-11-18, pre-clean-staging, local unpublished: OCI manifest `sha256:99f912af…`, config `sha256:746944cc…`, audited on 2026-11-18). On 2026-11-23 (`main` at `2d4581c3f`, after #915–#917), the licensed host built **build 5** (local, unpublished) under clean tracked-only `/build` staging: OCI target/manifest digest `sha256:c132e952…`, config digest `sha256:711e465c…`, archive `samsrf-reference.oci.tar` (1,381,349,376 bytes, SHA-256 `28ccdcda…`, 7 layers, 0 attestations, 0 unreferenced blobs), and `base-images.json` (`lineageVerified: true`) verifying the 4-image layer prefix chain (`ubuntu:22.04` `f64b2ffc…` → `matlabruntimebase/r2023b/release/update11` `ce5f495c…` → `samsrf-reference-runtime:r2023b` `1dbdc61c…` → `samsrf-reference:41ed1e96-r2023b` `c132e952…`, plus `matlab-runtime-installer:r2023b-update-11` `1f07cb49…` in `copyFromStages`) ([Runtime container status](matlab/README.md#building-a-matching-runtime-container)) | Met on retained local evidence | Publication: [steps that need the maintainer](matlab/README.md#publication-steps-that-need-the-maintainer) |
| Compiled-vs-source maps pass per-map gates | `compare_cli.py` on the retained executions, on one host: compiled and source MATLAB agree bitwise in all 24 runs (1,036 numerical and structural array checks, the 184 contract maps among them). History: build 2 and build 3 source receipts did not record the bundle, so their source inputs were unattested; for build 3 the 2026-11-18 audit reported six retained comparisons (source repeat, compiled against source, compiled repeat, and across builds 2 and 3) equal in all 24 runs. Since #915, `run_source_cli.m` hashes the effective `/input` tree and each run's staged `SamSrf_defaults.json` and `hrf_custom.mat` before and after execution, writing `receipts/inputs.json` (with `staged`) and per-run `stagedInputs`, verified by `cli_plan.py verify-inputs` in both `licensed-host/build_and_validate.sh` and `samsrf-native.yml` and checked by `compare_web_cli.py --expect source` without `--allow-unattested-source-inputs`. In **build 5** (2026-11-23), all four runs (`source-1`, `source-2`, `compiled-1`, `compiled-2`) wrote identical `receipts/inputs.json` (`sha256:49c84772…`, `unchanged: true`, 60 bundle entries, 24 staged run entries), and `source-repeat.json`, `compiled-vs-source.json` and `compiled-repeat.json` all passed `exact: true` across all 24 runs (1,036 arrays, 0 failed), plus SIGINT interrupt (exit 130) and missing-model failure (exit 249) | Met on retained local evidence | Publication and cross-host `runtime_image` validation ([steps that need the maintainer](matlab/README.md#publication-steps-that-need-the-maintainer)) |
| Runtime-only execution without a licence | `runtime_image` dispatch: no MATLAB on the host, no network in the container, read-only inputs. History: the 2026-11-18 audit restored build 3 into an empty Docker store and ran three cases (`prf_custom_hrf_lh_double`, `rc_custom_hrf_lh_double`, `cf_hull_lh_single`), reporting 127 arrays equal and missing-model failing; `matlab/oci_identity.mjs` now accepts either target or config digest (`test/oci-identity.test.js`). In **build 5** (2026-11-23), both `samsrf-reference:41ed1e96-r2023b` and `samsrf-reference-runtime:r2023b` were removed from the local Docker store, and `docker load` restored `samsrf-reference:41ed1e96-r2023b` from `samsrf-reference.oci.tar` (`restored-oci-identity.json` byte-identical to `oci-identity.json`, `sha256:2bd41c18…`); all 24 runs (`compiled-restored`) then ran with `MLM_LICENSE_FILE` and `SAMSRF_LICENSE` unset, `--network none`, read-only root and inputs, verified `receipts/inputs.json` (`unchanged: true`), and matched both `compiled-1` and `source-1` bitwise (`restored-vs-compiled.json` and `restored-vs-source.json` both 24/24 `exact: true`, 1,036 arrays, 0 failed) | Partial | Fresh restored interrupt check and `runtime_image` on a published digest on another host |
| Repeated runs reproduce outputs | Source recordings repeat exactly on each host (1,036 array checks per host). The web engine repeats byte for byte (Node 24, Node 22 in a pinned image, Chromium). In **build 5**, `source-repeat.json`, `compiled-repeat.json`, `restored-vs-compiled.json` and `restored-vs-source.json` all repeat bitwise across all 24 runs (1,036 arrays). History: builds 2 and 3 repeated their 24-run source and compiled executions bitwise (`source-repeat.json`, `compiled-repeat.json`; the 2026-11-18 build 3 restore covered three cases) | Met on retained local evidence | A published image repeats its own on another host |
| Immutable digest and receipts; stock and repaired baselines separate | The stock Neurodesk 2024 image (SamSrf 10.003), the repaired source recording and the web runs are kept apart; each web report names the MATLAB execution it used. The licensed-host receipts name the compiled image by its local ID; it has no registry digest. Since #897/#915/#917 the driver saves the image as an OCI archive and binds the ID it ran to the archive's digests (`oci_identity.mjs`, `container-build/oci-identity.json`), and `build_container.py` stages only Git-tracked present files (excluding `.git` and ignored files) under a canonical `/build` mount (`SAMSRF_CANONICAL_BUILD_DIR`) and fail-closed verifies generated Dockerfile `FROM` bases, `COPY --from` stages and `RootFS.Layers` prefix lineage in `base-images.json`. Build 5 verified `lineageVerified: true`, 0 attestations, 0 unreferenced blobs, and zero `.git` strings or `/storage/tmp/samsrf-licensed` host paths in `docker image inspect` and `docker history --no-trunc` (the compiled CTF archive internals were not unpacked) | Partial | Redistribution authorization (MathWorks Runtime SLA) and publication with an immutable registry digest ([steps that need the maintainer](matlab/README.md#publication-steps-that-need-the-maintainer)) |
| Web comparison lists exact, tolerance, failing and unsupported cases | `run_web_matrix.mjs` (engine in Node), `run_browser_matrix.mjs` (the app's `engine.js` in Chromium, an engine-module harness from source, not the production bundle or interface; raw maps merged from the exported shard, replay equal to export) and `compare_web_cli.py`. The comparator derives the MATLAB execution from its receipts and refuses mismatched plan, bundle, argv, execution kind or image identity. It classes every contract map of all 24 runs exact or differing, bitwise, after checking the ROI, vertex counts and byte lengths. A refusal counts only with the core's exact text, in both runners and again in the comparator; a crash is `failed`, and a MATLAB failure does not hide it. Refused, unsupported and failed runs are listed with both sides' statuses; web-only polar and eccentricity maps are listed as not compared. 44 tests with negative controls. Wired into the `build` and `runtime_image` jobs (Node and Chromium) and the licensed-host driver (Node). Against source MATLAB (`cli-reference.json`, inputs unattested by the historical source receipts), CI holds the Node runner to the frozen outcome on the AMD host: 20 of 24 runs and 163 of 168 maps exact (history: 18/24 and 157/168 after #874; #866's first report was 77/168 in Node and 63/140 in browser). On **build 5** (2026-11-23, committed WASM `d1745bec…`, `@neurodesk/samsrf` `0.7.20261120`, prospective source attestation), Node compiled acceptance ran under all three explicit references on the AMD host with 0 failed/unsupported/inventory-error runs: `current` **20/24 exact, 2 differ, 2 refused (163/168 maps)** against both `compiled-1` and `source-1`; `matlab-amd` **20/24 exact, 2 differ, 2 refused (166/168 maps)** against both `compiled-1` and `source-1`; `matlab-intel` (same-host comparison of Intel-mode WASM against AMD MATLAB Runtime output `compiled-1`) **0/12 double exact, 12 differ, 12 single refused (32/92 double maps)**. `run_browser_matrix.mjs` was not re-run separately on build 5 (the production UI matrix in the next row ran in Chromium against the same `d1745bec…` WASM and `web-1` engine root; history: on #874 `abbd6625…`, Node and Chromium both matched 18/22 computed runs and 157/168 maps byte for byte) | Partial | The differences listed under "SamSrfAnalysis CLI matrix" below, and cross-host validation against a published image |
| The production interface runs the matrix, held to MATLAB and to the engine harness | `run_ui_matrix.mjs` drives a built `apps/samsrf` bundle through its interface. `compare_ui_cli.py` compares only the whole matrix; it binds the served module to the engine harness's, each saved model to the plan model and each download to its hash. A run whose result was offered before an error is `ui-error`, a refusal without its expected text is `failed`, and a download that is not the engine harness's export fails a gate of its own (matlab/README "Production interface against the CLI matrix"). 44 tests; each of 17 mutations reverting a check fails them. On **2026-11-23** (`main` at `2d4581c3f`, committed WASM `d1745bec…`, Chromium `156.0.8078.4`), against the locally built, unpublished **build 5** compiled image (`sha256:c132e952…`) and source execution (with `web-1` as engine root), all 22 computed runs complete with lossless downloads (`losslessDownloadRuns: 22`, `losslessComparedMaps: 168`): both `ui-1-vs-compiled.json` and `ui-1-vs-source.json` exit 0 (`failures: []`) with **20 exact, 2 differing, 2 refused, 0 `ui-error`, 0 `unsupported`, 0 `failed`, 0 `inventory-error`**, **163 of 168 exact maps** (raw doubles and CSS imaginary parts verified; both CSS runs and both double RC hull runs are exact; only the 5 raw-double maps in `cf_hull_lh_double` and `cf_hull_smooth_global_lh_double` differ while their float32 GIfTIs are exact), and **212 of 212 downloaded GIfTIs equal to the engine harness's** (`engineFilesDiffer: 0`, `engineMismatchRuns: 0`, with the 22 lossless downloads verified by array contents and provenance separately). History: on 2026-11-18 (#874, module `abbd6625…`, float32 downloads only) 20/24 runs and 160/168 maps were exact in float32 with both CSS runs differing for unobserved imaginary parts and 4 double hull runs differing in double; on 2026-11-17 none of 18 completed (tagless surface) and 4 subject-HRF runs had no route | Partial | The 5 differing raw-double maps in the 2 double CF hull runs (#732, #897), the 2 single Gaussian refusals (#729), and cross-host testing against a published image |

Compiled-versus-source agreement and the lossless UI matrix rest on retained
executions of locally built images. Build 2 is gone; Build 3 (pre-clean-staging)
and Build 5 (2026-11-23, `2d4581c3f`, clean-staged, layer-lineage-verified,
prospectively source-input-attested, 24-run restored-audited, explicit-reference
compiled-accepted, and 24-run lossless UI-verified) exist locally and are **not
published**; this file claims no published image. Redistribution authorization,
pushing an approved image to GHCR with an immutable registry digest, a fresh
restored interrupt run, and cross-host `runtime_image` validation remain open.
The UI and engine replays above and the local Runtime audit have different
scopes and do not establish cross-host or general compiled or UI parity.

### SamSrfAnalysis CLI matrix: web engine against source MATLAB

[Web engine against the CLI matrix](matlab/README.md#web-engine-against-the-cli-matrix)
holds the web engine against the pinned source recording (run 42928350417), map
by map, in both precisions. This is interim evidence against **source** MATLAB
and does not establish compiled-image parity. The comparison applies no
tolerance. CI holds the committed module's default (`current`) to the outcome
frozen in `matlab/web-cli-outcome.json` against the recording's AMD host: 20 of
24 runs and 163 of 168 maps are exact (up from 18 and 157 after #874). The
other references are in [Current state after #895](#current-state-after-895).
What still differs under the default (matlab/README "Double detrend and z-score"
lists the causes found so far):

| Finding | Scope | Issue |
| --- | --- | --- |
| Double CF hull: y0 differs in `Srf.Data` at 7 and 5 vertices (centroids, down from 16 and 12 after #902); the float32 GIfTIs are exact | `cf_hull_lh_double`, `cf_hull_smooth_global_lh_double` | #732 |
| Double global regression by normal equations (the default only): R² (up to 147 ULP), Beta and Suppression of the smoothed, globally corrected CF run at 8 to 13 vertices; `matlab-amd` makes them exact | `cf_hull_smooth_global_lh_double` | #897 |
| Public refusals: single RC Gaussian, single CF Gaussian | 2 runs | #729 |

On the Intel host no run is exact and 63 of 168 maps are by default (matlab/README
"Double detrend and z-score"); under `matlab-intel` 10 of its 12 double runs
(90 of 92 double maps) are exact. Of the findings in #866's first report, double
detrend and z-score now equal MATLAB's on the AMD host in every preprocessed
course (0.6.20261116), and these are exact in the frozen outcome: SamSrfAnalysis
CSS with its complex `Srf.Data` (#873), the single forward pRF's Beta and
Baseline (`prf_gaussian_lh_average_single`, #731), the 11 diverged double CF
Gaussian fits (`cf_gaussian_lh_double`), the NaN sign bits of the CF hull and
double RC Gaussian runs (#875), and the double RC Gaussian fits on MATLAB's pixel
grid (`rc_gaussian_lh_double`, #874).
