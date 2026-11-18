# Intel complex dot candidate

This offline experiment tests one candidate for the complex dot product used by CSS
correlation. It does not change the shipped engine or resolve the Intel production
regression of #876. The fixed baseline is #882 `62eeb1a9568d2338cdb5ef205cce2d884d5fe67b`,
module `cc528cf6`. No new MATLAB process is authorized or run.

## Existing evidence and exposure

All recordings are previously seen. Reusing another host's identical inputs is
corroboration, not a blind holdout. The source recordings do not attest their input bundles.

- `record_numerics_probes.m` records one complex/real dot, two norms and a complex
  correlation at each of 24 lengths: 1–20, 33, 64, 250 and 1000. Numerics and numerics2
  contain the same inputs on Intel 8370C/8573C and AMD controls. The uncentred raw dot
  supplies 48 scalar outputs; it has no cancellation fingerprints, centred products,
  centred norms, or alignment sweep.
- `record_gemv_order.m` records single `y' * A` fingerprints and random products for
  four matrix shapes, but both retained hosts report CNR `auto` (AMD). It does not
  identify the Intel single matrix path.
- `record_qr_kernels.m` and `qr_kernels.c` include Intel 8370C single/complex GEMV
  fingerprints with lengths and alignments, plus full factor/solve intermediates.
  Their MEX directly calls GEMV with transpose/conjugate-transpose. It does not call
  ZDOTC; transfer of its reduction pattern to complex correlation is a hypothesis.
- `record_arithmetic_order.m` isolates real-double dot/correlation. It cannot identify
  complex-dot cross-product order or the single path.

## Fixed candidate and finite search

`dot_candidates.py` evaluates 272 general models: 1, 2, 4, 8 or 16 lanes, every ordering
of binary fold strides, round-robin/sequential/power-of-two/masked tails, and fused or
unfused accumulation. No final fitted map enters this search. Its pre-evaluation SHA-256
is `52397b2d06ed4e0a7806e0eec9fa1019f9e9373dc6d00e1d4f558142fff155fe`.

Exactly one model reproduces all 24 raw complex values on both Intel recordings: four
FMA lanes, adjacent folds `(0+1)+(2+3)`, a tail pair into lanes 0/1 and a final element
into lane 0. The nearest alternative matches 21/24. The candidate matches 5/24 AMD
values; the shipped two-lane arithmetic matches 24/24 AMD and 5/24 Intel. This identifies
a candidate within this family, not MKL's implementation in general. The raw recordings
contain no complex-complex multiplication, nonfinite/subnormal or alignment controls.

Before pipeline evaluation, freeze this candidate as `complex::zdotc_real`. The new
scratch-only `avx512-complex-corr` variant combines it with the existing correctly rounded
norm candidate for both parts of a centred complex vector. It keeps the existing real
Intel kernels and the shipped single/complex least-squares routines. The norm remains
a candidate with two known real-correlation near-tie misses; no threshold is added.

The reconstruction matches all 23 finite recorded complex correlations on both Intel
hosts and both AMD controls. Independent review found that the original diagnostic
incorrectly forced four accumulation lanes for complex means below 44 elements; the
engine uses one lane there, for both real and complex means. Correcting the diagnostic
removes its two Intel and five AMD misses without changing any kernel or pipeline.
The recorded final correlations corroborate the candidate on these seen inputs; they
do not identify unrecorded intermediate stages or establish general MATLAB parity.

## Evaluation and stop rule

Run native bit gates on the raw vectors with both host controls. Then run the frozen
candidate through the existing whole 24-run research matrix and native CSS pipelines on
both bundles, with the committed baseline and hooks null control. Count raw real,
imaginary and GIfTI gains/losses individually; preserve previous reports. Do not retune
from fitted-map outputs. Report every remaining loss and the unchanged shipping bytes.
Any missing evidence becomes a specific recording proposal; do not execute it.

## Frozen candidate results

The build at `040fbe29e` uses complex-dot source SHA-256
`048df60acffac0b6de9dde6eb7f9c834989dabb8e579e3176445a96570778f5f` and
`complex-corr.patch` SHA-256
`21c580d18da75ff180d0a564d2ba51b470c0d8ef8f1eb7f1cbf037556b99ba58`.
Its unoptimized research module is
`f8620bbca9d384cd3726bb1db8e8f629fdcc665a5a09032439a519fb57a03a14`.
The algorithm was not changed after pipeline evaluation. The shipping module remains
`cc528cf6ec172367ee845296f197a686e671629386a595eaba5432ccfe0436b6`.

[The matrix](../harness/cc528cf6-2/matrix.json) and
[pipeline accounting](../harness/cc528cf6-2/pipelines.json) use the same committed
baseline as `cc528cf6-1`. Every value is compared bitwise in MATLAB's class; neither a
net total nor a map count can waive a lost value. Null controls retain all 236 identical
files on each bundle, and the new research build writes identical bytes from both bundles.

| Intel 8573C | Committed | Original research | Complex candidate |
| --- | --- | --- | --- |
| Exact maps / runs | 57 / 0 | 111 / 7 | 113 / 7 |
| Real-double raw gains / losses | baseline | +606 / −0 | +606 / −0 |
| Complex raw real gains / losses | baseline | +19 / −2 | +41 / −2 |
| Complex raw imaginary gains / losses | baseline | +4 / −2 | +30 / −1 |
| GIfTI gains / losses | baseline | +69 / −0 | +69 / −0 |
| CSS pipeline real gains / losses | baseline | +260 / −2 | +345 / −0 |
| CSS pipeline imaginary gains / losses | baseline | +3 / −4 | +97 / −0 |

Single outputs do not change: 1,075/1,596 raw real values, 1,547/1,596 imaginary values
and 1,075/1,596 GIfTI values match on Intel. The 110 real-double hull misses also remain.
Relative to the previous research build, the candidate gains 49 CLI values and 185
pipeline values on Intel without losing any; the separate
[transition report](../harness/cc528cf6-2/relative-to-prior-research.json) lists the controls.

All six earlier pipeline losses disappear. Both pipeline conventions now match every
spatial/CSS shape parameter and correlation value on Intel; the SamSrf complex convention still
misses 53/57 Beta values and 55/57 Baseline values in each part. Complex least squares
has not been replaced. The three remaining CLI losses against the committed baseline
are the previous losses, with unchanged bits:

| Map | Part | Zero-based vertex | Distance from MATLAB |
| --- | --- | --- | --- |
| Beta | real | 11 | 5 ULP |
| Baseline | real | 4 | 3 ULP |
| Baseline | imaginary | 5 | 4 ULP |

The candidate removes the previous imaginary nR² loss at vertex 5. This does not repair
or waive the separate #876 production regression. Running Intel arithmetic on AMD still
loses values: 787 CLI values and 437 pipeline values against the committed baseline,
with no gains. Relative to the older Intel research build on AMD it gains one CLI value
and loses three, and gains 14 pipeline values and loses 81. This is evidence for a
recorded arithmetic branch, not a CPU-selection or reference policy.

## What the current data can resolve next

The Intel single-kernels recording has two real CF matrices: each supplies 21 ROI courses,
nine seed courses and 250 samples, with means, norms, matrix products and separately copied
column products. Those are 378 products and useful replay checks for a model inferred
from fingerprints. The QR recording has 3,200 single and 1,600 complex-single GEMV probes,
plus 1,600 complex-double and 800 real-double probes; the scalar/transposed matrix call
layout must be distinguished before reusing their trees. Its 348 designs, 696 multiple-RHS
cases and 672 ORMQR probes provide staged evidence for the remaining least-squares work.
The previous departure table includes the 22 chains that first diverge after reflector 1;
this experiment does not replace that table or identify the whole single path.

The diagnostic correction removes the reason for the earlier proposed n=8/n=17
centred-stage recording. No new recording is needed to resolve those reported misses.
The two separate real-norm near-tie misses remain unresolved; no rounding band is adopted.

A separate cancellation/fusion probe would test the raw-dot candidate beyond the present
24 vectors: lengths around multiples of four, independent real and imaginary cancellation
pairs, varied products to distinguish FMA, zero-sign cases, and allocation offsets. The
QR probes do not substitute for direct `z' * y` calls. A future proposal must specify the
inputs and predicted alternatives before recording, retain observed CNR receipts for one
AMD and one AVX512_E1 host, and stop if the observed branches differ from those roles.
Proposed upper budget: one dispatch, two single-thread processes, 15 minutes each, no
automatic retries. This is a proposal only: no dispatch, license use or data publication
is authorized or performed in this unit.

## Reproduce and verify

Use Python 3.13 or later for `math.fma`:

```sh
python3 dot_candidates.py "$PINS" NEW_DOT_REPORT.json
python3 correlation_replay.py "$PINS" NEW_CORRELATION_REPORT.json
```

Projecting each recording's `intel` or `amd` result from the portable correlation
script onto `equal`, `of` and `misses` reproduces `correlation-1.json` and
`correlation-amd-control.json`; n=1 is excluded from its finite count. The Rust gate
`complex_dot_candidate_matches_seen_raw_vectors_on_both_intel_hosts` uses the
`SAMSRF_MATLAB_NUMERICS_DIR` and `SAMSRF_MATLAB_NUMERICS2_DIR` fixtures. It compares both
parts bit for bit on both Intel hosts and both AMD controls. Unfused and wrong-fold
mutants must fail that real fixture gate. The research harness's existing build, native
and account commands accept `avx512-complex-corr`; they do not modify the shipping tree.

Primary source procedures: [raw BLAS recorder](../../record_numerics_probes.m),
[QR recorder](../../record_qr_kernels.m), [QR MEX calls](../../qr_kernels.c),
[single GEMV fingerprint recorder](../../record_gemv_order.m),
[single CF stages](../../record_single_kernels.m), and
[real-double arithmetic recorder](../../record_arithmetic_order.m).

Local validation of this unit: the numerics workflow invocation passes 18 tests with both
pinned recordings configured; the new gate's unfused and wrong-fold mutations each fail,
and restoring the source passes. Clippy with Rust 1.98.1 and `-D warnings` passes, as do
58 workflow/version contracts on Node 24.19.0. The 24-run matrix runs on each bundle and
the two native pipelines complete; the accounting above states their differences.
The production WASM dependency tree excludes this crate, and the shipping source and
all three committed module files are unchanged from `62eeb1a9`. The build's
[provenance](../harness/cc528cf6-2/build.json) records its clean source at `040fbe29e`.
Independent review and any future full affected CI remain pending.
