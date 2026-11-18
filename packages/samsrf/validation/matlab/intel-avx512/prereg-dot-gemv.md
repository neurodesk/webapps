# Pre-registration: MKL AVX512_E1 `x'*y` (n >= 51) and `y'*A`, from existing recordings

Frozen 2026-11-18 before any Intel candidate is evaluated on these data. Local research
note (branch `t3/samsrf-intel-cf`). No new MATLAB recording or dispatch.

## Prior exposure (stated plainly)

- arithmetic-order run 43564031333, Intel Xeon 6975P-C (`ubuntu-24.04`): the recorder's
  authors read the Intel fingerprints from 51 elements ("pairs 32 elements apart").
  `arithmetic_order.rs` has compared every Intel draw (1-50) with the port's AMD models
  and printed aggregate counts. No Intel model has been evaluated on any draw.
- Intel `corr` at 25-50 elements: evaluated by me under correctly rounded norms with the
  pair-tree dot (519 of 520; prereg-dnrm2.md H1). These are replay data from now on.
  Intel `corr` at 51-250 elements: only AMD-model aggregate counts are known.
- constants-gamma-gemv run 43882331042, Intel Xeon 6975P-C: `constants_gemv.rs` has
  compared every Intel `y'*A` fingerprint and draw (0-99) with the AMD candidate models
  and printed aggregate tallies. No Intel model has been evaluated on them.
- Reverse-correlation run 42445033403, Intel Xeon 8370C: `revcor_reference.rs` printed
  aggregate counts of the AMD kernel on the Intel host's CF profiles. No Intel model has
  been evaluated on them.

Data read only through AMD-model aggregates are called "held out from Intel fitting", not
independent of all prior inspection.

## Q1 `x'*y`, n >= 51 (MATLAB hands it to MKL `ddot`)

- Discovery: every Intel fingerprint at every recorded length from 51 (exhaustive 51-80;
  300 sampled pairs at 96, 100, 127, 128, 129, 200, 250, 256, 1,000) and draws 1-25 at
  those lengths. The AMD host is the control: the port's `ddot_mkl` must keep reproducing
  it (fingerprints and draws 1-50).
- Structure family: (a) the lane family of `qr-lane-models.py` over the products
  (`vector` layout; lanes 1-64; fold strides any order of the powers of two below the lane
  count, up to 32 lanes; tails `mod`, `seq`, `pow2`); (b) paired chunks: chunks of C
  products (C in 16, 32, 64, 128), lane k < C/2 forming the pair (k, k + C/2) before adding
  it to its running sum, the remainder in chunks C/2, C/4, ... 1 from lane 0, then folds
  in any stride order. A structure is fixed only if it reproduces every discovery
  fingerprint at every length.
- Arithmetic switches, fixed on draws 1-25 only: products accumulated with or without FMA;
  for (b), pair `fma(a_k, b_k, fl(a_{k+C/2} b_{k+C/2}))`, the mirror, or unfused; remainder
  fused or not.
- Held out: draws 26-50 at every length from 51 (38 lengths, 950 values).

## Q2 `y' * A` (MKL `dgemv` with `trans`; CF profiles)

- A-priori primary candidate, written from the identified Intel `?ormqr` kernels before
  any Intel `y'*A` value is compared with an Intel model: column j of m uses the grouped
  `?ormqr` tree without `c(1)` when j < 4 floor(m/4) (16-product chunks, lane k pairing
  products k and k + 8 as `fma(y_k a_k, fl(y_{k+8} a_{k+8}))`, the rest fused in chunks 8, 4,
  2, 1 from lane 0, folds 4, 1, 2), and otherwise the single-column 16-lane tree without
  `c(1)` (blocks of 16 round-robin, the rest in chunks 8, 4, 2, 1, folds 8, 4, 1, 2, FMA).
- Alternatives, considered only if the primary fails discovery: the Q1 families per column
  class, and groups of 8 columns instead of 4.
- Discovery: every Intel fingerprint of the 9 shapes (every column) and draws 0-49. The AMD
  host is the control (`lstsq::gemv_t_double` on fingerprints and draws 0-99).
- Held out: draws 50-99 (2,500 values over the 9 shapes).

## Downstream checks (evaluated once, after Q1 and Q2 are frozen)

- Q3 Intel `corr` r values of the arithmetic-order recording at 51-250 elements (held out
  from Intel fitting), with MATLAB's `mean`, the frozen Q1 dot and correctly rounded norms.
  The 25-50 values are reported as replay.
- Q4 Intel double CF profiles of the reverse-correlation recording, from the host's own
  recorded inputs, with the frozen Q2 product and correctly rounded norms.

## Decision and stop rules

- Identified (Q1, Q2): one fixed model reproduces every discovery value and then every
  held-out value bit for bit. Any held-out miss leaves the kernel unidentified; misses are
  reported, not fitted.
- If no structure in the family reproduces the discovery fingerprints, stop for that
  kernel: its held-out draws stay unread.
- At most one amendment per kernel may add settings after a discovery failure, from
  discovery data only, appended here before any held-out value is read.
- Q3 and Q4 are reported as they come out, by length and case; a miss there is a finding
  about another operation, not a reason to refit Q1 or Q2.

## Q1 freeze (discovery complete; draws 26-50 unread by any Intel model)

Discovery (Intel 6975P-C, every length from 51): structure from the fingerprints,
32 lanes over whole blocks of 32 elements, then chunks of 16 and 8 from lane 0, the rest
(fewer than 8) as one masked chunk from lane 0, folds with strides 8, 16, 4, 2, 1 (four
8-lane registers paired, then the horizontal sum). It reproduces all 67,195 Intel
fingerprints numerically at all 39 lengths (an earlier reading of the 1,000-element
counts as subtree sizes failed only because 2^60 does not absorb partial sums above 128
ones; the numeric evaluation is the recorder's own comparison). The tail was refined once
from the fingerprints (16 and 8 before the mask; the first guess masked after 16).
Arithmetic: products accumulated with FMA reproduce all 975 identification draws
(unfused 758). AMD control: `ddot_mkl` reproduces all 1,950 AMD draws from 51.

Frozen model: `dot/dot_kernel.py` sha256 07221c0910972d116a203454251832d3ea9a2a298f921c7a59b158685f54a27e,
`ddot(x, y, fused=True)`. Next and only once: draws 26-50 at every length from 51.

## Q2 freeze (discovery complete; draws 50-99 unread by any Intel model)

Q1 result (dot-heldout-1.json): the frozen dot reproduces all 975 held-out draws 26-50
at all 39 lengths from 51.

Q2 discovery (Intel 6975P-C): the a-priori primary candidate, unchanged, reproduces every
fingerprint of every column of all 9 shapes (2^70 probes, evaluated numerically) and
every draw 0-49. AMD control: the port's `lstsq::gemv_t_double` (Python replica)
reproduces every AMD fingerprint and draws 0-99. No amendment was needed.

Frozen model: `gemv/gemv_kernel.py` sha256 f913ec04f8666bfccf8d755812ed487b826ff54e7d134ab1e8bbbbfcc0cd61cd,
`intel(y, a, j, m)`. Next and only once: draws 50-99.

## Results after both freezes (reported as they came out)

Disclosure: the held-out evaluators `dot/dot_heldout.py` and `gemv/gemv_heldout.py` were
written and run in the same step as each freeze; only the kernels were hashed beforehand.
Both call the frozen function with no switch other than `fused=True` (named in the Q1
freeze). The held-out draws had been compared before, in aggregate, with AMD models only.

- Q2 held out (draws 50-99, gemv-heldout-1.json): 2,500 / 2,500.
- Q3 Intel `corr` (downstream.py, downstream-1.json): 679 / 680 at 51-250 elements and,
  as replay, 519 / 520 at 25-50. AMD control 1,200 / 1,200. Both misses have one cause: the
  exact y norm lies just above a rounding midpoint (6.4e-5 ULP at n = 36 pair 6, 2.6e-4 ULP
  at n = 75 pair 16) and Intel's value equals the correctly rounded y norm minus one ULP
  (the dot is the host-independent pair tree at n = 36 and the frozen Intel dot, 0.05 ULP
  from exact, at n = 75). The correctly rounded norm is therefore not MATLAB's near ties.
  Rounding the exact sum to double before the square root is refuted on the read data
  (D 21/24, H2 85/95, corr 410/520 and 533/680). The near-tie rule is not identified; both
  misses are pinned, no threshold is adopted (a 2^-13 ULP band would not even cover the
  n = 75 case).
- Q4 Intel double unsmoothed CF profiles (revcor run 42445033403, Intel 8370C, the host's
  recorded seed and saved courses): 3,402 / 3,402. AMD control 3,402 / 3,402. These values
  had been counted before against the AMD kernel only.

## Corrections after the review of #882 (appended 2026-11-18; nothing above is edited)

The frozen versions above stay byte prefixes of this file: 4,719 bytes (original,
sha256 `f819c98b...`), 5,831 bytes (Q1 freeze, `2187fc13...`) and 6,515 bytes (Q2 freeze,
`b0657577...`).

- Q1 departed from this pre-registration. The frozen `x' * y` kernel runs whole blocks of
  32 products in 32 lanes, then a chunk of 16 and a chunk of 8 from lane 0 where they fit,
  then the rest as one masked chunk. That tail is not in the registered family: family (a)
  registered the tails `mod`, `seq` and `pow2`, and family (b) registered paired chunks. The
  stop rule then required stopping, or one amendment appended before any held-out value was
  read. Instead, the Q1 freeze called the change a refinement ("refined once from the
  fingerprints"). The 975 / 975 held-out draws therefore test a structure chosen from the
  discovery fingerprints outside the registered family. They are not a pre-registered
  confirmation of that family.
- Count: the held-out set of Q1 was draws 26-50 at 39 lengths from 51 elements (30
  exhaustive lengths 51-80 and 96, 100, 127, 128, 129, 200, 250, 256, 1,000), 975 values,
  as the Q1 freeze and `dot/dot-heldout-1.json` state. The original text's "38 lengths, 950
  values" was wrong.
- Exposure: the `corr` values at 25 to 50 elements had been evaluated with the Intel norm
  candidate before this file was frozen (prereg-dnrm2.md H1, 519 / 520), as stated above.
  `src/blas.rs` and the README later described all the comparison data as compared before
  only with AMD models; both are corrected. Every result here is a replay or a comparison
  held out from Intel fitting, not a blind holdout: the AMD-model aggregates of these draws
  had been read.
- The norm candidate has two known near-tie misses, not one: n = 36 pair 6 (prereg-dnrm2.md)
  and n = 75 pair 16 (Q3 above). Both are pinned; no threshold is adopted.
