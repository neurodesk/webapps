# SamSrf MATLAB-parity acceptance matrix (#729-#733)

This file maps each acceptance criterion of issues #729 to #733 to the available
test or evidence, its measured scope and what remains. It was
audited on 2026-11-13 against `main` at `ef089b0a`, and brought up to date on
2026-11-16 against `main` at `6df4fb3e` (after #855 and #857). The issues' original
descriptions predate most of this work. This audit does not change their
acceptance requirements or approve closing an issue.

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

## #731 Single-precision pivoted QR (Beta, Baseline)

| Criterion | Evidence (test) | Status | Remaining |
| --- | --- | --- | --- |
| The recorded cases keep exact rank and zero-column decisions; coefficient gates reflect demonstrated fidelity | `qr_reference.rs`: rank of all 348 designs, MATLAB's printed tolerance for all 89 warnings; 346 coefficients bit-identical, 2 at 0 ULPs with an imaginary zero MATLAB stores as real; frozen outcomes at 0 ULPs. `matlab_reference.rs` keeps the original 146 forward cases | Met on AMD | None on AMD |
| Constant, nearly constant, rank-deficient, full-rank, extreme-scale, mixed real/complex and imaginary-underflow cases; imaginary coefficients asserted | The 348 designs of `qr-reference.json` cover each family; `qr_reference.rs` compares real and imaginary parts and requires a real result where MATLAB's is real | Met | None |
| Complete single Gaussian and CSS outputs; parameter and score parity does not regress | `compare.mjs` (114 required source gates, single CSS included), `css_pipeline.rs` and `compare-css.mjs` (double CSS original 138/0, nonnegative 126/0 coefficients identical/differing), `css_diagnostics.rs` (108 traces bit for bit) | Met on AMD | Single Gaussian RC/CF fits are #729's. On the SamSrfAnalysis CLI matrix (below), single CSS from raw GIfTI differs at 12-13 of 21 vertices, and one single forward vertex differs in Beta (1 ULP) and Baseline (5 ULP) |
| Missing references fail CI; MATLAB, BLAS and thread settings recorded; backend residuals separated from port errors | Recordings' `environment.json` and `hosts.json` are asserted (interpreter, BLAS line, CPU); `qr_kernels.rs` requires six hosts, five AMD with identical bits; every chain step equals MKL's (`every_recorded_chain_step_matches_mkl_on_amd`, 345 chains) | Partial | Host metadata and finite repeats are recorded. #730's controls receipt shows MKL runs each CPU's own branch whatever is requested; MKL's thread functions are unobservable in MATLAB. Intel differences are characterised, not reproduced |
| Before/after maximum ULP and absolute differences, and the covered domain, published without arbitrary-input claims | [Least-squares solves](matlab/README.md#least-squares-solves): acceptance checklist, finite-domain scope, history table (#773 → #795 → now) | Met | None |
| Changeset and README say what is exact or tolerance-based | Changesets of #795, #812, #818, #822; README "Correlations and regressions" and the QR checklist | Met | None |

Beyond the original criteria, all 696 recorded 8-column solves equal MATLAB's
(404 real bit for bit; 292 complex bit for bit except 26 imaginary zeros of
results MATLAB stores as real). Recorded single-precision reverse-correlation
profiles and global-regression residuals also equal MATLAB's on the AMD hosts.

**Still unresolved:** MKL's Intel AVX-512 branch. Excluding it from #731
requires acceptance of the proposed reference-host policy; this matrix does
not make that decision. See [Intel AVX-512 and the reference host](matlab/README.md#intel-avx-512-and-the-reference-host).

## #729 Single precision for reverse-correlation pRF and connective fields

| Criterion | Evidence (test) | Status | Remaining |
| --- | --- | --- | --- |
| Supported single RC/CF jobs compare every output vertex and map, with nonfinite, selection and profile masks | `revcor_reference.rs` (13 gates) and `compare-revcor.mjs` (1,298 public gates on both hosts): RC hull and CF hull/summary maps equal MATLAB's on AMD; profiles 8,400/8,400 and 7,200/7,200 identical | Met on AMD | Intel host keeps documented per-map limits |
| Constant, low-variance and threshold-boundary cases; per-map limits with evidence; no quotas | `revcor-edges-reference.json` cases; `threshold_boundary_is_exercised_exactly`; per-map table in "Reverse-correlation port gates" | Met | None |
| Full raw-data pipelines; double and forward single gates preserved | Raw-input matrix gates; `cf_from_raw_files_equals_the_run_on_matlabs_courses`; source gates unchanged | Met on AMD | On the SamSrfAnalysis CLI matrix (below), single RC and CF from raw GIfTI are exact on AMD except NaN sign bits in CF hull x0 and y0 |
| Missing references fail CI; immutable pins | `Expected` case counts in `revcor_reference.rs`; HF commit pins with SHA-256 | Met | None |
| Upstream execution limits documented (mismatched `Rdim`) | matlab/README "Raw-input reverse-correlation matrix" | Met | None |
| Changeset, API/CLI tests, browser checks, coverage docs | `cli.test.js` (single rc writes the in-process job, refuses single 2D fits), `api.test.js`, SamSrf e2e | Met for the supported subset | — |
| Single RC 2D and single CF Gaussian fits | Internal gates only: three RC 2D cases and twelve CF Gaussian cases equal MATLAB's on AMD. [Focused probes](matlab/README.md#focused-probes-729-730) also record Hooke–Jeeves for the three single RC 2D cases: per profile host, all 43 retained fits of 78 match parameter/R² bits and all 35 rejection masks agree, on both recording hosts | **Partial: publicly refused** | Hooke–Jeeves evidence covers one subject; rejected pre-mask parameters are not compared. No general acceptance bound: 18 single `exp` inputs and 19 atlas vertices differ, Intel maps differ. Owned by the numerical track |

## #730 Double-precision CSS fits

| Criterion | Evidence (test) | Status | Remaining |
| --- | --- | --- | --- |
| Regression reproduces the discrepancies before the fix and passes after; references and precision mandatory | `css_diagnostics.rs` (108 traces, every evaluation bit for bit) | Met on AMD | — |
| Full double CSS pipelines: every parameter, R², nR², coefficients and masks, original and nonnegative apertures | `compare-css.mjs`, `css_pipeline.rs`: three 96-vertex pipelines; parameters, scores and masks bit-identical; coefficients 138/0 and 126/0 identical/differing | Met on AMD for these pipelines | The SamSrfAnalysis CLI CSS run from raw GIfTI differs in both precisions: MATLAB saves a complex `Srf.Data` and 12-15 of 21 vertices differ (CLI matrix below). Owned by the numerical track |
| Single CSS gates intact | `compare.mjs` single CSS gates | Met | — |
| Plateau ambiguity documented with objectives, predictions and repeatability | Since 0.6.20261114 the double non-CSS objective uses MATLAB's `conv`/`corr` operation orders, as the CSS objective does. `double_forward_diagnostics.rs` gates the nine double forward pipelines: x0, y0, Sigma and noise ceiling bit for bit at every vertex, R² and nR² too with fine fits, every zero/NaN mask, and Beta, Baseline and coarse R² within `1e-12 * max(1, abs(MATLAB value))`. The 14 case/vertex entries that differed before (8 plateau, 5 acceptance, 1 different optimum) now match; the README keeps their diagnosis. MATLAB's recorded `fminsearch` runs (32 fits, 12,604 evaluations, including 6 that fit the HRF) are replayed bit for bit, every evaluation. The fitted-HRF divergence was traced, by a pre-registered recording on an AMD and an Intel host, to `gampdf`'s normaliser (`log(2π)` and `log(k)` taken separately); `fitted_hrf_probes` gates every recorded kernel and density on both hosts | Partial | Beta, Baseline and coarse R² keep last-bit differences. One AMD recording: no MATLAB repeat on other hosts, Intel not reproduced, no Hooke-Jeeves or non-Gaussian double non-CSS recording. From raw GIfTI (CLI matrix below), double detrend and z-score already differ from both MATLAB hosts in the last bits (up to 1.2e-14), so no double SamSrfAnalysis run is exact |
| No widened tolerance or quota | Coefficient policy is exact equality or a stated scale, with no differing coefficient left | Met | — |
| Sparse `conv` arithmetic (which products MATLAB rounds before adding) | Three pre-registered recordings, each rule frozen from discovery courses before its held-out ones were opened (`conv-boundary-predictions.md`, `conv-gaps-predictions.md`). `conv_boundary.rs`: every kept part of 31 + 14 + 33 + 12 sparse courses with 9-300 taps; `conv_gaps.rs`: 12 held-out courses with 2-8 taps, the complex and real thresholds and the exact 8-block length, and the second recording's held-out courses replayed byte for byte on two AMD hosts (they were recorded on two Intel hosts). Rejected rules (the first block rule; keeping the block at exactly 8 blocks) stay as frozen negative controls | Met for the recorded courses | Not recorded: kernels as long as the course, single-tap kernels, sparse courses of at most 16 samples, dense courses beyond two controls. No claim about MATLAB's internal algorithm or arbitrary inputs |
| Pins, provenance; exact/tolerance/unsupported published | matlab/README "Double CSS arithmetic" and "Requested and effective MKL controls" record pinned files, host metadata, repeat comparisons, effective branches and current limits | Partial | Cross-host reproducibility remains open: AMD and Intel MATLAB run different MKL branches by design (row below) |
| Reference reproducibility controls explicitly owned by #730 | `controls-reference.json` and `analyse-controls.py`: MKL's own `MKL_CBWR_Get` reports `AUTO` on AMD and `AVX512_E1` on Intel under the `COMPATIBLE`, unset and `AVX2` requests, with summation trees equal to the pinned trees of each vendor; `MKL_NUM_THREADS` never reaches MATLAB's environment; OpenMP reports one thread under every request; repeats are identical (pre-registered, 5 CPU models) | **Partial** | The branch request is ineffective, so reference arithmetic is set by the CPU, not the request. MKL's thread count and dynamic setting are unobservable through its functions in MATLAB. AMD under the `contrast` request was not drawn. Choosing a reference host remains a maintainer decision |

## #732 Polygon exclusions and CF triangulation

| Criterion | Evidence | Status | Remaining |
| --- | --- | --- | --- |
| Remove both original polygon exclusions and pass all 253 cases | `matlab_reference.rs` asserts all 253 polygons with no named skips; polygon_191 and polygon_193 pass | Met | Broader boundary/cloud coverage is separate below |
| Independently recorded boundary sweeps and broader geometry coverage | Shipped model retains 93 exceptions among the 26,073 original-family polygons and further supplementary mismatches. The experimental, unshipped Clipper model retains 44 original, 178 held-out and 246 causal exceptions, including four regressions | **Open** | Establish a general correction without losing accepted cases. `KeepCollinearPoints` is a separate MATLAB configuration, not an observed internal stage of default `polyshape`. Round 7 (#855) rejected merging at single-vertex contacts around a void (H_M, H_M1) on 592 pre-registered cases on two AMD hosts; the 932 and 1607 holes remain unexplained |
| Exact connectivity and selected regions; justified per-value tolerances | `matlab_geometry.rs`, `geometry_reference.rs` | Partial | As above |
| Cocircular and degenerate cases with MATLAB behaviour | Probe and causal recordings | Partial | As above |
| Full CF hull, summary and Gaussian checks on real templates | `production_template_reader_equals_matlabs_template`; CF hull/summary exact on AMD | Partial | CF Gaussian is publicly refused (#729) |
| Provenance and hashes; missing cases fail CI | Pinned probe/causal recordings with repeats | Met | — |
| Changeset and docs replace the original exclusions with measured coverage and remaining limits | #799 removes the original named skips; #813 and #820 distinguish shipped coverage from experimental snapshots and document supplementary mismatches | Met for the documented scope | Broader geometry parity remains open; experimental agreement does not establish production acceptance |

## #733 Version-matched MATLAB Runtime reference container

| Criterion | Evidence | Status | Remaining |
| --- | --- | --- | --- |
| Recipe executed on a licensed builder | The first attempts stopped at the licence check (2026-11-16: from this repository's cloud build host the licence server's private address was unreachable, and MATLAB stopped at License Manager Error -15,570; matlab/README "Compiler access"). On the licensed host, `licensed-host/build_and_validate.sh` then built a compiled image (local ID `sha256:be7ae7aa…`, created 2026-11-16, not published) and ran the matrix in it. Its receipts and outputs are retained there, and an independent audit verified them on 2026-11-17. The Docker daemon that audit could reach no longer has the image (`No such image` for both the ID and the tag), so it cannot be inspected or run again | Met on retained receipts | The image itself is unavailable. A rebuilt image gets a new ID and needs its own Runtime-only, repeat and source gates before publication |
| Compiled-vs-source maps pass per-map gates | `compare_cli.py` on the retained executions, on one host: compiled and source MATLAB agree bitwise in all 24 runs (1,036 numerical arrays, the 184 contract maps among them). The compiled receipts attest the inputs (`receipts/inputs.json` equals the bundle manifest); the source receipts do not record the bundle, so the source side's inputs are unattested | Met on retained evidence | Source input attestation is limited as stated; the image is unavailable for a re-run |
| Runtime-only execution without a licence | `runtime_image` dispatch: no MATLAB on the host, no network in the container, read-only inputs. No Runtime-only execution of the built image has been audited independently, and the image is unavailable | Open | A live image (rebuilt, with a new ID) and its Runtime-only gate |
| Repeated runs reproduce outputs | Source recordings repeat exactly on each host (1,036 array checks per host). The web engine repeats byte for byte (Node 24, Node 22 in a pinned image, Chromium). The retained compiled executions repeat bitwise (24 runs, 1,036 arrays), as do the retained source executions on the same host | Met on retained evidence | A rebuilt image repeats its own |
| Immutable digest and receipts; stock and repaired baselines separate | The stock Neurodesk 2024 image (SamSrf 10.003), the repaired source recording and the web runs are kept apart; each web report names the MATLAB execution it used. The licensed-host receipts name the compiled image by its local ID; it has no registry digest | Partial | Publication with an immutable digest |
| Web comparison lists exact, tolerance, failing and unsupported cases | `run_web_matrix.mjs` (engine in Node), `run_browser_matrix.mjs` (the app's `engine.js` in Chromium, an engine-module harness from source, not the production bundle or interface; raw maps merged from the exported shard, replay equal to export) and `compare_web_cli.py`. The comparator derives the MATLAB execution from its receipts and refuses mismatched plan, bundle, argv, execution kind or image identity. It classes every contract map of all 24 runs exact or differing, bitwise, after checking the ROI, vertex counts and byte lengths. A refusal counts only with the core's exact text, in both runners and again in the comparator; a crash is `failed`, and a MATLAB failure does not hide it. Refused, unsupported and failed runs are listed with both sides' statuses; web-only polar and eccentricity maps are listed as not compared. 31 tests with negative controls. Wired into the `build` and `runtime_image` jobs (Node and Chromium) and the licensed-host driver (Node; its Chromium run is a documented step on the returned evidence, and has been run on it). Against source MATLAB, with inputs unattested by the source receipts: on AMD, 77 of 168 maps are exact (Node) and 63 of 140 (browser, 4 runs unsupported); on Intel, 45 and 37. Against the retained compiled executions, with the module now on main (`d5ae6ba2…`): Node 13 of 22 computed runs exact (129 of 168 maps); since Chromium takes the subject-HRF file (2026-11-18), Chromium the same 13 of 22 (129 of 168 maps), equal to Node byte for byte; 2 refused | Partial | The differences listed under "SamSrfAnalysis CLI matrix" below, and completed interface parity (next row) |
| The production interface runs the matrix, held to MATLAB and to the engine harness | `run_ui_matrix.mjs` drives a built `apps/samsrf` bundle through its interface. `compare_ui_cli.py` compares only the whole matrix; it binds the served module to the engine harness's, each saved model to the plan model and each download to its hash. A run whose result was offered before an error is `ui-error`, a refusal without its expected text is `failed`, and a download that is not the engine harness's export fails a gate of its own (matlab/README "Production interface against the CLI matrix"). 39 tests; each of 17 mutations reverting a check fails them. On 2026-11-18, against the same locally built, unpublished compiled image, all 22 computed runs complete (15 exact, 7 differing in float32 downloads; 138 of 168 maps), 2 are refused and none is `ui-error`, `unsupported` or failed; all 212 downloaded files equal the engine harness's. On 2026-11-17 none of 18 completed (the viewer could not read the matrix's tagless surface) and the 4 subject-HRF runs had no route | Partial | Double values are not observable through float32 downloads; the CSS runs use the default `nonnegative` convention (#717), not SamSrfAnalysis's complex powers, so they are not CSS parity evidence; the numerical differences listed below |

Compiled-versus-source agreement rests on retained executions of a locally built
image. That image was not published, and the Docker daemon available to the
independent audit no longer has it, so it cannot be run again; this file claims
no available or published image. Runtime-only execution, publication and
completed interface parity remain open.

### SamSrfAnalysis CLI matrix: web engine against source MATLAB

[Web engine against the CLI matrix](matlab/README.md#web-engine-against-the-cli-matrix)
holds the web engine against the pinned source recording (run 42928350417), map
by map, in both precisions. This is interim evidence against **source** MATLAB
and does not establish compiled-image parity. The comparison applies no
tolerance. The findings below belong to the issues named:

| Finding | Scope | Issue |
| --- | --- | --- |
| Double detrend and z-score from raw GIfTI differ in the last bits (up to 1.2e-14) from both MATLAB hosts, which also differ from each other; single preprocessing is identical | Every double run | #730 (and #729's double RC) |
| SamSrfAnalysis CSS: MATLAB saves a complex `Srf.Data`; 12-15 of 21 vertices differ in both precisions | `prf_css_lh_*` | #730 |
| NaN sign bits (not signed zeros): CF hull x0 and y0, and rejected vertices of the double RC Gaussian | `cf_hull*`, `rc_gaussian_lh_double` | #729 |
| Single forward pRF: one vertex differs in Beta (1 ULP) and Baseline (5 ULP) | `prf_gaussian_lh_average_single` | #731 |
| Diverged double Gaussian CF fits (11 vertices) | `cf_gaussian_lh_double` | #729 |
| Public refusals: single RC Gaussian, single CF Gaussian | 2 runs | #729 |
