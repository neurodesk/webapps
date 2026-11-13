# SamSrf MATLAB-parity acceptance matrix (#729-#733)

This file maps each acceptance criterion of issues #729 to #733 to the test or
evidence that holds it on current `main`, its status and what remains. It was
audited on 2026-11-13 against `main` at `ef089b0a`. The issues' original
descriptions predate most of this work; this matrix is the current reading.

"Reference" means MATLAB R2023b Update 11 source code (SamSrf `41ed1e96`, SPM
`03ac9473`) run on the pinned recordings' hosts. "AMD" means MKL's CNR `auto`
branch on AMD EPYC runners; "Intel" means MKL's `AVX512_E1` branch on Intel
Xeon runners. Every gate listed fails CI when its pinned reference is missing.
Agreement is with these recordings, not a proof for other inputs, MATLAB or MKL
releases.

The numerical sections of [matlab/README.md](matlab/README.md) own the details
for #729 and #730 ("Reverse-correlation port gates", "Single sin and cos",
"Double CSS arithmetic"), and its geometry and Runtime-container sections own
#732 and #733. This file only points to them.

Status: **Met** (the criterion holds as written), **Met on AMD** (holds against
the AMD reference; Intel is documented separately), **Partial** (holds for a
stated subset) or **Open**.

## #731 Single-precision pivoted QR (Beta, Baseline)

| Criterion | Evidence (test) | Status | Remaining |
| --- | --- | --- | --- |
| The recorded cases keep exact rank and zero-column decisions; coefficient gates reflect demonstrated fidelity | `qr_reference.rs`: rank of all 348 designs, MATLAB's printed tolerance for all 89 warnings; 346 coefficients bit-identical, 2 at 0 ULPs with an imaginary zero MATLAB stores as real; frozen outcomes at 0 ULPs. `matlab_reference.rs` keeps the original 146 forward cases | Met on AMD | None on AMD |
| Constant, nearly constant, rank-deficient, full-rank, extreme-scale, mixed real/complex and imaginary-underflow cases; imaginary coefficients asserted | The 348 designs of `qr-reference.json` cover each family; `qr_reference.rs` compares real and imaginary parts and requires a real result where MATLAB's is real | Met | None |
| Complete single Gaussian and CSS outputs; parameter and score parity does not regress | `compare.mjs` (114 required source gates, single CSS included), `css_pipeline.rs` and `compare-css.mjs` (double CSS original 138/0, nonnegative 126/0 coefficients identical/differing), `css_diagnostics.rs` (108 traces bit for bit) | Met on AMD | Single Gaussian RC/CF fits are #729's |
| Missing references fail CI; MATLAB, BLAS and thread settings recorded; backend residuals separated from port errors | Recordings' `environment.json` and `hosts.json` are asserted (interpreter, BLAS line, CPU); `qr_kernels.rs` requires six hosts, five AMD with identical bits; every chain step equals MKL's (`every_recorded_chain_step_matches_mkl_on_amd`, 345 chains) | Met | Intel differences are characterised, not reproduced (below) |
| Before/after maximum ULP and absolute differences, and the covered domain, published without arbitrary-input claims | [Least-squares solves](matlab/README.md#least-squares-solves): acceptance checklist, finite-domain scope, history table (#773 → #795 → now) | Met | None |
| Changeset and README say what is exact or tolerance-based | Changesets of #795, #812, #818, #822; README "Correlations and regressions" and the QR checklist | Met | None |

Beyond the original criteria, all 696 recorded 8-column solves equal MATLAB's
(404 real bit for bit; 292 complex bit for bit except 26 imaginary zeros of
results MATLAB stores as real), and every reverse-correlation profile and
global regression equals MATLAB's on the AMD hosts.

**Not covered by #731's criteria and still open:** MKL's Intel AVX-512 branch.
See [Intel AVX-512 and the reference host](matlab/README.md#intel-avx-512-and-the-reference-host).

## #729 Single precision for reverse-correlation pRF and connective fields

| Criterion | Evidence (test) | Status | Remaining |
| --- | --- | --- | --- |
| Supported single RC/CF jobs compare every output vertex and map, with nonfinite, selection and profile masks | `revcor_reference.rs` (13 gates) and `compare-revcor.mjs` (1,298 public gates on both hosts): RC hull and CF hull/summary maps equal MATLAB's on AMD; profiles 8,400/8,400 and 7,200/7,200 identical | Met on AMD | Intel host keeps documented per-map limits |
| Constant, low-variance and threshold-boundary cases; per-map limits with evidence; no quotas | `revcor-edges-reference.json` cases; `threshold_boundary_is_exercised_exactly`; per-map table in "Reverse-correlation port gates" | Met | None |
| Full raw-data pipelines; double and forward single gates preserved | Raw-input matrix gates; `cf_from_raw_files_equals_the_run_on_matlabs_courses`; source gates unchanged | Met on AMD | None |
| Missing references fail CI; immutable pins | `Expected` case counts in `revcor_reference.rs`; HF commit pins with SHA-256 | Met | None |
| Upstream execution limits documented (mismatched `Rdim`) | matlab/README "Raw-input reverse-correlation matrix" | Met | None |
| Changeset, API/CLI tests, browser checks, coverage docs | `cli.test.js` (single rc writes the in-process job, refuses single 2D fits), `api.test.js`, SamSrf e2e | Met for the supported subset | — |
| Single RC 2D and single CF Gaussian fits | Internal gates only: three RC 2D cases and twelve CF Gaussian cases equal MATLAB's on AMD | **Partial: publicly refused** | No general acceptance bound: Hooke-Jeeves unrecorded, 18 single `exp` inputs and 19 atlas vertices differ, Intel maps differ. Owned by the numerical track |

## #730 Double-precision CSS fits

| Criterion | Evidence (test) | Status | Remaining |
| --- | --- | --- | --- |
| Regression reproduces the discrepancies before the fix and passes after; references and precision mandatory | `css_diagnostics.rs` (108 traces, every evaluation bit for bit) | Met on AMD | — |
| Full double CSS pipelines: every parameter, R², nR², coefficients and masks, original and nonnegative apertures | `compare-css.mjs`, `css_pipeline.rs`: three 96-vertex pipelines; parameters, scores and masks bit-identical; coefficients 138/0 and 126/0 identical/differing | Met on AMD | — |
| Single CSS gates intact | `compare.mjs` single CSS gates | Met | — |
| Plateau ambiguity documented with objectives, predictions and repeatability | Columns 16, 17 and 82 now follow MATLAB's optimizer sequence bit for bit; repeat recordings identical | Met | — |
| No widened tolerance or quota | Coefficient policy is exact equality or a stated scale, with no differing coefficient left | Met | — |
| Pins, provenance; exact/tolerance/unsupported published | matlab/README "Double CSS arithmetic" | Met on AMD | Intel host not reproduced (stated there) |

## #732 Polygon exclusions and CF triangulation

| Criterion | Evidence | Status | Remaining |
| --- | --- | --- | --- |
| Remove both polygon exclusions and pass all 253 cases plus independent boundary sweeps | Shipped model differs from MATLAB on 93 original clouds; the opt-in Clipper model on 44 original, 178 held-out and 246 causal exceptions, with four regressions | **Open** | See matlab/README "Geometry: polyshape, delaunay and real templates" (geometry track) |
| Exact connectivity and selected regions; justified per-value tolerances | `matlab_geometry.rs`, `geometry_reference.rs` | Partial | As above |
| Cocircular and degenerate cases with MATLAB behaviour | Probe and causal recordings | Partial | As above |
| Full CF hull, summary and Gaussian checks on real templates | `production_template_reader_equals_matlabs_template`; CF hull/summary exact on AMD | Partial | CF Gaussian is publicly refused (#729) |
| Provenance and hashes; missing cases fail CI | Pinned probe/causal recordings with repeats | Met | — |
| Changeset and docs replace the exclusions with measured coverage | Exclusions remain documented as such | **Open** | — |

## #733 Version-matched MATLAB Runtime reference container

| Criterion | Evidence | Status | Remaining |
| --- | --- | --- | --- |
| Recipe executed on a licensed builder | Never executed: no MATLAB Compiler licence for R2023b Update 11 is available (matlab/README "Compiler access") | **Open, blocked** | A Compiler licence held by the user or their institution |
| Compiled-vs-source maps pass per-map gates | No compiled build exists | Open | Needs the build |
| Runtime-only execution without a licence | Recipe and `runtime_image` dispatch written; untested | Open | Needs the build |
| Repeated runs reproduce outputs | Source recordings repeat exactly; compiled none | Open | Needs the build |
| Immutable digest and receipts; stock and repaired baselines separate | Stock Neurodesk 2024 image and repaired source recording are kept apart | Partial | Digest after the build |
| Web comparison lists exact, tolerance, failing and unsupported cases | Source-level lists exist; compiled none | Open | Needs the build |

The source-level MATLAB recordings stand in for the compiled reference in
every gate above. They are evidence about MATLAB source execution, not about a
compiled SamSrfAnalysis.
