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

A preliminary reconstruction of the 23 finite recorded complex correlations matches
21 on both Intel hosts, with imaginary-part misses at n=8 and n=17. The same reconstruction
with shipped AMD arithmetic matches 18/23 AMD, so this is not a validated centring/stage
oracle. Record these misses; do not select another dot or norm from them. Additional
centred-stage recordings would distinguish a centring error from a dot or norm error.

## Evaluation and stop rule

Run native bit gates on the raw vectors with both host controls. Then run the frozen
candidate through the existing whole 24-run research matrix and native CSS pipelines on
both bundles, with the committed baseline and hooks null control. Count raw real,
imaginary and GIfTI gains/losses individually; preserve previous reports. Do not retune
from fitted-map outputs. Report every remaining loss and the unchanged shipping bytes.
Any missing evidence becomes a specific recording proposal; do not execute it.
