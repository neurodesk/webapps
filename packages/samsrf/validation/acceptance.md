# SamSrf MATLAB-parity acceptance matrix (#729-#733)

This file maps each acceptance criterion of issues #729 to #733 to the available
test or evidence, its measured scope and what remains. It was
audited on 2026-11-13 against `main` at `ef089b0a`, brought up to date on
2026-11-16 against `main` at `6df4fb3e` (after #855 and #857), and reconciled
on 2026-11-19 against `main` at `3cf5c9cf` (after #895, `62a5f0c3`) for #897.
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
2026-11-19 with the committed module:

| Reference | AMD EPYC 9V74 (CNR `auto`) | Intel Xeon Platinum 8573C (`AVX512_E1`) |
| --- | --- | --- |
| `current` (default) | 18 runs exact, 4 differ, 2 refused; 157 of 168 maps | No run exact, 22 differ, 2 refused; 57 of 168 maps |
| `matlab-amd` | 18 runs exact, 4 differ, 2 refused; 160 of 168 maps | No run exact, 22 differ, 2 refused; 57 of 168 maps |
| `matlab-intel` | Double runs: none of 12 exact; 26 of their 92 maps. The 12 single runs are refused | Double runs: 8 of 12 exact, 4 differ; 84 of their 92 maps. The 12 single runs are refused |

A map is exact when every raw `Srf.Data` value, imaginary part and GIfTI value
equals MATLAB's, bit for bit. Under `current` on the AMD host every float32
GIfTI of the 22 computed runs equals MATLAB's. The 11 differing maps differ only
in 139 raw double values: 110 hull coordinates and 29 values of R², Beta and
Suppression in `cf_hull_smooth_global_lh_double`. `matlab-amd` makes those 29
exact.

How these were checked: `run_web_matrix.mjs`, `compare_web_cli.py` and
`web_cli_outcome.py check` for the default (as CI runs them);
`check_arithmetic_references.mjs` for all three references; and, for the
`matlab-amd` and `matlab-intel` rows, the same runner with each run's model
given `Arithmetic_Reference` as `check_arithmetic_references.mjs` gives it,
compared by `compare_web_cli.py` with each host's source execution (the Intel
host on its own bundle). That last replay is not a committed procedure:
`compare_web_cli.py` accepts only the plan's own model bytes and rejects a
plan whose models name a reference, so it cannot be repeated with the
committed files as described here. The
reproducible evidence for these two rows is `check_arithmetic_references.mjs`
and the reviewed accounting below. `compare_web_cli.py` lists the refused
Intel single runs as `failed`, because it accepts only the two single Gaussian
refusals of the plan. The `matlab-amd` and `matlab-intel` counts agree with the
reviewed accounting in
[`matlab/intel-avx512/harness/cc528cf6-main4cdc/avx512-complex-qr/matrix.json`](matlab/intel-avx512/harness/cc528cf6-main4cdc/avx512-complex-qr/matrix.json).
These are results on a finite set of recorded inputs, not general MATLAB
equivalence.

Since #897 the app and the `samsrf` command line also write a lossless file,
`<prefix>_lossless.bin`: every map's raw doubles and, for a complex result, the
imaginary parts ([package README, "Lossless export"](../README.md#lossless-export)).
The provenance JSON names it with its SHA-256. `compare_ui_cli.py` reads it from
each download, requires it to equal the engine harness's raw maps and counts a
map exact only when its doubles and imaginary parts also equal MATLAB's. The
production-interface matrix has not been measured again with lossless downloads:
that needs the compiled executions of the unpublished image. Expect the four
double hull runs to become `differs` and the two CSS runs to be decided on their
imaginary parts. No gain or loss is claimed until that run.

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
| Four double hull runs | Differ on AMD: 110 hull values (at most 36 ULP) and 29 global-regression values (at most 147 ULP) | Differ on AMD: the 110 hull values | Differ on Intel: the same 110 hull values |
| Whole-cortex global-signal sum | 15 of 2,000 values exact (AMD) | Not measured | Not measured |
| Single RC 2D and single CF Gaussian fits | Refused | Refused | Refused |
| Other single analyses | Run | Run | Refused |
| CSS with `Css_Convention: "nonnegative"` | Runs | Runs | Refused |
| Fewer than two volumes | Runs | Runs | Refused |
| Norms at rounding ties | AMD norm order, which matches the recorded AMD norms | AMD norm order, as `current` | Correctly rounded norm: two recorded one-ULP misses |
| Small-shape `gampdf`, zero signs, single `sin`, `cos`, `exp` | Kernels independent of the reference | Same as `current` | Same as `current` |

### 1. Hull geometry and full-pipeline last bits (#732; historical #729)

**The four double hull runs.** `rc_hull_lh_double`,
`rc_custom_hrf_lh_double`, `cf_hull_lh_double` and
`cf_hull_smooth_global_lh_double`.

- Evidence: the matrix above. The same 110 raw values differ under `current`
  and `matlab-amd` on the AMD host and under `matlab-intel` on the Intel host:
  x0 18, y0 12 and Fwhm 12 values (`rc_hull`); x0 16, y0 9 and Fwhm 15
  (`rc_custom_hrf`); y0 16 (`cf_hull`); y0 12 (`cf_hull_smooth_global`). The
  largest is 36 ULP (4.6e-15 relative). Under `current` the AMD comparison also
  differs in `cf_hull_smooth_global_lh_double`'s R² (8 values, up to 147 ULP,
  2.2e-14 relative), Beta (8, up to 61 ULP) and Suppression (13, up to 28 ULP).
  That is the default's double global regression, not geometry; `matlab-amd`
  removes it. The 147 ULP named in #897 is this R² value.
- Product: these runs complete and differ by those amounts. Their float32
  GIfTIs equal MATLAB's. Production keeps `HullOrder::Listed` and the earlier
  RC hull pixel grid.
- Accounting: the 110 values under `matlab-intel` and the 110 under the AMD
  references are the same positions measured against two recordings. Count
  them per reference and host, never as 220 cases, and never as additions to
  the default map counts.
- To move it: identify MATLAB's hull start and cleanup order, `convexHull`'s
  area arithmetic and its ring decomposition of self-intersecting and
  near-coincident clouds
  ([hull area, centroid and vertex order](matlab/README.md#hull-area-centroid-and-vertex-order-732)).
  The stored-order diagnostic and the experimental Clipper model each lose
  values the shipped evaluation matches, so neither is an approved replacement.
  [cleanup-order-1](matlab/cleanup-order-1/result.md) ended undecided (STOP on
  `MATLAB:polyshape:repairedBySimplify`); no prediction was adopted.

**The whole-cortex global signal.**

- Evidence: `constants_gemv.rs` (run 43882331042, AMD EPYC 9V74) pins the
  port's `nanmean` over every vertex at 15 of 2,000 MATLAB values: the port
  does not add the 134k vertices in MATLAB's order. The package README gives
  the size on the pinned run: up to 2.7e-13 relative in double, 1e-4 in single.
  It is measured with `current` arithmetic on the AMD host only; that run's
  Intel host is reported, not gated.
- Product: runs. Connective fields with global-signal correction regress on
  this signal under every reference. The sum itself does not depend on the
  reference; the courses it sums do (`matlab-intel` detrends with the Intel
  kernels).
- To move it: measure it under `matlab-amd` and `matlab-intel` on the existing
  recording (no new recording); then identify MATLAB's across-vertex order,
  which may need one.

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

**Every `matlab-intel` single analysis.**

- Evidence: where single runs first depart on Intel is located, with the AMD
  hosts as control (`mkl-avx512/tests/divergence.rs`; [Intel AVX-512 and the
  reference host](matlab/README.md#intel-avx-512-and-the-reference-host)):
  `sgemv` in the single CF correlation, the `?gemv` update or the complex norm
  in every single QR chain, and `x' * y`. The role of `sdot` is inferred by
  elimination. No Intel single kernel is identified.
- Product: refused, never run with another reference's kernels:
  "model: matlab-intel arithmetic requires Data_Precision 'double'; Intel
  single-precision kernels are not implemented". This includes the single
  analyses that run under `current` and `matlab-amd`.
- To move it: identify `sgemv`, the single QR and Q application and `sdot` on
  Intel recordings not read before the model is frozen.

**Intel CSS with the nonnegative convention.**

- Evidence: the Intel CSS evidence covers SamSrf's complex power
  (`Css_Convention: "samsrf"`): the recorded finite two-column complex QR
  designs and the matrix's CSS runs. The `nonnegative` objective, which clips
  responses before the power, has no Intel validation.
- Product: refused: "model: MATLAB Intel CSS requires Css_Convention='samsrf';
  nonnegative CSS is not supported by this reference". `current` and
  `matlab-amd` keep both conventions; the default convention is unchanged.
- Decision: the restriction is kept and documented. Lifting it needs an Intel
  nonnegative CSS validation.

**Fewer than two volumes** under `matlab-intel` are refused: "model:
matlab-intel arithmetic requires at least two volumes".

### 3. Numerical edge cases and coverage (#730, #731)

**Two near-tie norm misses** (`matlab-intel` only).

- Evidence: the correctly rounded norm reproduces the recorded Intel norms
  except two, whose exact value lies 6.4e-5 and 2.6e-4 ULP above a rounding
  midpoint; MATLAB's result is one ULP lower. Both are pinned with the AMD order
  as negative control (`mkl-avx512/tests/recordings.rs`,
  `mkl-avx512/tests/blas_recordings.rs`).
- Product: `matlab-intel` runs with the correctly rounded norm, so at such a
  tie it can be one ULP above MATLAB's. No tolerance band is fitted to the two
  examples.
- To move it: MKL's `dnrm2` rule near midpoints, which needs a recording that
  probes ties.

**Small-shape `gampdf` and zero signs.**

- Evidence: every recorded density with shape of at least 1 equals MATLAB's
  (9,760 in `matlab_numerics2.rs`). Below 1 the port keeps the closed form with
  `lgamma`; the frozen Loader candidate reproduced 23,941 of 29,376 held-out
  densities and was rejected
  ([constants-gamma-gemv-predictions.md](matlab/constants-gamma-gemv-predictions.md)).
  In negative-base powers the sign of a zero part differs in 2,440 of 27,552
  recorded parts (`matlab_numerics.rs`); the matrix's CSS runs are exact,
  zero signs included.
- Product: runs, the same in every reference. No recorded HRF has a shape below
  1, so no user-facing failure is shown; a custom or fitted HRF with such a
  shape would use the closed form. Measured against MATLAB's recorded
  densities it differs by 59 ULP at shape 0.3, scale 1, x = 29.875 and by
  1,356 ULP at shape 0.95, scale 1, x = 584. These are examples, not a bound.
  The effect on a fitted HRF's results is not measured.
- To move it: identify MATLAB's small-shape `gampdf` and its zero-sign rule on
  held-out recordings.

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
| Missing references fail CI; MATLAB, BLAS and thread settings recorded; backend residuals separated from port errors | Recordings' `environment.json` and `hosts.json` are asserted (interpreter, BLAS line, CPU); `qr_kernels.rs` requires six hosts, five AMD with identical bits; every chain step equals MKL's (`every_recorded_chain_step_matches_mkl_on_amd`, 345 chains) | Partial | Host metadata and finite repeats are recorded. #730's controls receipt shows MKL runs each CPU's own branch whatever is requested; MKL's thread functions are unobservable in MATLAB. Since #895 the `matlab-intel` reference reproduces Intel's recorded finite real and complex two-column double solves; Intel single kernels are not identified and are refused ([open limits](#open-numerical-limits)) |
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
| Exact connectivity and selected regions; justified per-value tolerances | `matlab_geometry.rs`, `geometry_reference.rs`. Production keeps the previous hull evaluation (`HullOrder::Listed`), because MATLAB's stored order, exact on far more values, loses some the previous evaluation matched. Over both hosts it loses 2,578 polygon-recording values, 12 template CF values (3 per precision and host) and one RC `Fwhm` (README, "Hull area, centroid and vertex order"). The stored order is gated as diagnostic evidence. `polyshape_arithmetic.rs` gives every recorded hull of the four polygon recordings MATLAB's bits from MATLAB's stored vertices (87,298 per host). `matlab_geometry.rs` requires MATLAB's bits for the 15,840 original hulls it lists in MATLAB's order, with 948 in another order bounded and 79 other-vertex and 4 empty hulls among the 93 snapping clouds. RC hulls are bit for bit from MATLAB's profiles (revcor replay) and courses (`cli_rc_hulls.rs`) but for 15 `Fwhm` values. Round hull-area-1 supports MATLAB's grid and `K` (`hull_area_report.py check`) | Partial | As above; adopting the stored order in production awaits a decision or a lossless rule; MATLAB's ring decomposition of self-intersecting clouds; `convexHull`'s area, unidentified after round hull-area-1 |
| Cocircular and degenerate cases with MATLAB behaviour | Probe and causal recordings | Partial | As above |
| Full CF hull, summary and Gaussian checks on real templates | `production_template_reader_equals_matlabs_template`; CF hull/summary exact on AMD. Double CF hull values from MATLAB's profiles stay within 1e-12 in production (the previous hull). The stored-order diagnostic gives them bit for bit on both hosts (revcor matrix, 504 per row) and on the real templates but for 15 listed values per host (`TEMPLATE_HULL_START`); 3 of those per host are exact under the previous hull | Partial | Single CF Gaussian is publicly refused (#729); double CF Gaussian runs and is exact on the CLI matrix. MATLAB's ring decomposition of self-intersecting clusters; the stored order's adoption in production |
| Provenance and hashes; missing cases fail CI | Pinned probe/causal recordings with repeats | Met | — |
| Changeset and docs replace the original exclusions with measured coverage and remaining limits | #799 removes the original named skips; #813 and #820 distinguish shipped coverage from experimental snapshots and document supplementary mismatches | Met for the documented scope | Broader geometry parity remains open; experimental agreement does not establish production acceptance |

## #733 Version-matched MATLAB Runtime reference container

| Criterion | Evidence | Status | Remaining |
| --- | --- | --- | --- |
| Recipe executed on a licensed builder | The first attempts stopped at the licence check (2026-11-16: from this repository's cloud build host the licence server's private address was unreachable, and MATLAB stopped at License Manager Error -15,570; matlab/README "Compiler access"). On the licensed host, `licensed-host/build_and_validate.sh` then built a compiled image (build 2, local ID `sha256:be7ae7aa…`, created 2026-11-16, not published) and ran the matrix in it; an independent audit verified its receipts on 2026-11-17. History: build 2 is in no reachable Docker store. A rebuild (build 3, created 2026-11-18) exists locally and is not published: OCI manifest digest `sha256:99f912af…`, config digest `sha256:746944cc…` ([Runtime container status](matlab/README.md#building-a-matching-runtime-container)). #897 and an independent audit of 2026-11-18 report it; that evidence is local and was not rechecked for this file | Met on retained local evidence | Publication: [steps that need the maintainer](matlab/README.md#publication-steps-that-need-the-maintainer) |
| Compiled-vs-source maps pass per-map gates | `compare_cli.py` on the retained executions, on one host: compiled and source MATLAB agree bitwise in all 24 runs (1,036 numerical and structural array checks, the 184 contract maps among them). The compiled receipts attest the inputs (`receipts/inputs.json` equals the bundle manifest); the source receipts do not record the bundle, so the source side's inputs are unattested. For build 3 the 2026-11-18 audit reports six retained comparisons (source repeat, compiled against source, compiled repeat, and across builds 2 and 3) equal in all 24 runs | Met on retained local evidence | Source inputs stay unattested until they are attested prospectively ([steps that need the maintainer](matlab/README.md#publication-steps-that-need-the-maintainer)) |
| Runtime-only execution without a licence | `runtime_image` dispatch: no MATLAB on the host, no network in the container, read-only inputs. The 2026-11-18 audit restored build 3 from its OCI archive into an empty, isolated Docker store and ran three fresh cases (`prf_custom_hrf_lh_double`, `rc_custom_hrf_lh_double`, `cf_hull_lh_single`) without network or licence, with read-only root and inputs; it reports their 127 arrays equal to the retained compiled and source outputs, and the missing-model case failing as expected. Its first verifier assumed the image ID is the OCI manifest digest; `matlab/oci_identity.mjs` now accepts the config digest a classic store reports too (tested offline in `test/oci-identity.test.js`) | Partial | No fresh restored 24-run matrix and no fresh interrupt run; `runtime_image` on a published digest |
| Repeated runs reproduce outputs | Source recordings repeat exactly on each host (1,036 array checks per host). The web engine repeats byte for byte (Node 24, Node 22 in a pinned image, Chromium). The retained compiled executions repeat bitwise (24 runs, 1,036 arrays), as do the retained source executions on the same host; the 2026-11-18 audit reports the same for build 3 | Met on retained local evidence | A published image repeats its own on another host |
| Immutable digest and receipts; stock and repaired baselines separate | The stock Neurodesk 2024 image (SamSrf 10.003), the repaired source recording and the web runs are kept apart; each web report names the MATLAB execution it used. The licensed-host receipts name the compiled image by its local ID; it has no registry digest. Since #897 the driver also saves the image as an OCI archive and binds the ID it ran to the archive's digests (`oci_identity.mjs`, `container-build/oci-identity.json`) | Partial | Redistribution authorization, embedded Git and build metadata, the tag-based bases of MATLAB's generated Dockerfiles, and publication with an immutable registry digest ([steps that need the maintainer](matlab/README.md#publication-steps-that-need-the-maintainer)) |
| Web comparison lists exact, tolerance, failing and unsupported cases | `run_web_matrix.mjs` (engine in Node), `run_browser_matrix.mjs` (the app's `engine.js` in Chromium, an engine-module harness from source, not the production bundle or interface; raw maps merged from the exported shard, replay equal to export) and `compare_web_cli.py`. The comparator derives the MATLAB execution from its receipts and refuses mismatched plan, bundle, argv, execution kind or image identity. It classes every contract map of all 24 runs exact or differing, bitwise, after checking the ROI, vertex counts and byte lengths. A refusal counts only with the core's exact text, in both runners and again in the comparator; a crash is `failed`, and a MATLAB failure does not hide it. Refused, unsupported and failed runs are listed with both sides' statuses; web-only polar and eccentricity maps are listed as not compared. 44 tests with negative controls. Wired into the `build` and `runtime_image` jobs (Node and Chromium) and the licensed-host driver (Node; its Chromium run is a documented step on the returned evidence, and has been run on it). Against source MATLAB, with inputs unattested by the source receipts, CI holds the Node runner to the frozen outcome on the AMD host: 18 of 24 runs and 157 of 168 maps exact since #874; on Intel no run and 57 maps (#866's first report: 77 of 168 maps on AMD in Node and 63 of 140 in the browser, whose 4 subject-HRF runs were then unsupported; 45 and 37 on Intel). Against the retained compiled executions, with the module on main since #874 (`abbd6625…`; forward models with `Css_Convention: "samsrf"`, imaginary parts compared): Node and Chromium, which takes the subject-HRF file since 2026-11-18, each 18 of 22 computed runs exact (157 of 168 maps), equal byte for byte; 2 refused; against #875's module, 24 real values became exact and none was lost | Partial | The differences listed under "SamSrfAnalysis CLI matrix" below, and completed interface parity (next row) |
| The production interface runs the matrix, held to MATLAB and to the engine harness | `run_ui_matrix.mjs` drives a built `apps/samsrf` bundle through its interface. `compare_ui_cli.py` compares only the whole matrix; it binds the served module to the engine harness's, each saved model to the plan model and each download to its hash. A run whose result was offered before an error is `ui-error`, a refusal without its expected text is `failed`, and a download that is not the engine harness's export fails a gate of its own (matlab/README "Production interface against the CLI matrix"). 44 tests; each of 17 mutations reverting a check fails them. On 2026-11-18, with #874 merged (module `abbd6625…`), against the same locally built, unpublished compiled image, all 22 computed runs complete (20 exact and 2 differing in float32 downloads; 160 of 168 maps), 2 are refused and none is `ui-error`, `unsupported` or failed; all 212 downloaded files equal the engine harness's. The two that differ are the CSS runs, loaded with `Css_Convention: "samsrf"`: their four complex maps cannot be observed through real downloads. Four double runs are exact in float32 while their double values differ (matlab/README). On 2026-11-17 none of 18 completed (the viewer could not read the matrix's tagless surface) and the 4 subject-HRF runs had no route | Partial | The 2026-11-18 measurement used float32 downloads only. Double values and imaginary parts are downloadable since #897 ([current state](#current-state-after-895)); the matrix is not yet measured again with them. The numerical differences listed below |

Compiled-versus-source agreement rests on retained executions of locally built
images. Build 2 is gone. Build 3 exists locally and is not published; this file
claims no published image. A fresh restored 24-run Runtime-only matrix,
publication, prospective attestation of source inputs and fresh compiled
acceptance for the final production module under each explicit reference
remain open. The UI and engine replays above and the local Runtime audit have
different scopes and do not establish cross-host or general compiled or UI
parity.

### SamSrfAnalysis CLI matrix: web engine against source MATLAB

[Web engine against the CLI matrix](matlab/README.md#web-engine-against-the-cli-matrix)
holds the web engine against the pinned source recording (run 42928350417), map
by map, in both precisions. This is interim evidence against **source** MATLAB
and does not establish compiled-image parity. The comparison applies no
tolerance. CI holds the committed module's default (`current`) to the outcome
frozen in `matlab/web-cli-outcome.json` against the recording's AMD host: since
#874, 18 of 24 runs and 157 of 168 maps are exact. The other references are in
[Current state after #895](#current-state-after-895). What still differs under
the default (matlab/README "Double detrend and z-score" lists the causes found
so far):

| Finding | Scope | Issue |
| --- | --- | --- |
| Double convex-hull reverse correlation: x0, y0 and Fwhm differ in `Srf.Data` at 9 to 18 vertices per map, by at most 36 ULP (production keeps the previous pixel grid and hull); the float32 GIfTIs are exact | `rc_hull_lh_double`, `rc_custom_hrf_lh_double` | #732 |
| Double CF hull: y0 differs in `Srf.Data` at 16 and 12 vertices (centroids); the float32 GIfTIs are exact | `cf_hull_lh_double`, `cf_hull_smooth_global_lh_double` | #732 |
| Double global regression by normal equations (the default only): R² (up to 147 ULP), Beta and Suppression of the smoothed, globally corrected CF run at 8 to 13 vertices; `matlab-amd` makes them exact | `cf_hull_smooth_global_lh_double` | #897 |
| Public refusals: single RC Gaussian, single CF Gaussian | 2 runs | #729 |

On the Intel host no run is exact and 57 of 168 maps are by default (matlab/README
"Double detrend and z-score"); under `matlab-intel` 8 of its 12 double runs are. Of the findings in #866's first report, double
detrend and z-score now equal MATLAB's on the AMD host in every preprocessed
course (0.6.20261116), and these are exact in the frozen outcome: SamSrfAnalysis
CSS with its complex `Srf.Data` (#873), the single forward pRF's Beta and
Baseline (`prf_gaussian_lh_average_single`, #731), the 11 diverged double CF
Gaussian fits (`cf_gaussian_lh_double`), the NaN sign bits of the CF hull and
double RC Gaussian runs (#875), and the double RC Gaussian fits on MATLAB's pixel
grid (`rc_gaussian_lh_double`, #874).
