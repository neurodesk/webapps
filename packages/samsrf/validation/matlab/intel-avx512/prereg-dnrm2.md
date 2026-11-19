# Pre-registration: Intel AVX512_E1 `dnrm2` from existing recordings

Frozen 2026-11-18 before any candidate is evaluated on a held-out set. Local research
note (branch `t3/samsrf-876-intel`), no new MATLAB recording, no dispatch.

## Question

The stage trace (`intel_stages.rs`, report `stages-1.json`) located the first
host-dependent arithmetic of the double global regression inside MKL: on identical
inputs, MATLAB's `sum`, `mean`, `zscore` and `nanmean(·, 2)` equal the port on the
Intel hosts, while `norm(x)` (MKL `dnrm2`) differs by 1-2 ULP at n = 6, 12-15, 17, 18,
64, 250 and 1,000 on both Intel models. Which algorithm is Intel's `dnrm2`?

## Data

- Discovery D: `norm(x)` of the 24 BLAS-section vectors (n = 1-20, 33, 64, 250, 1,000;
  `randn .* exp(3 randn)`, seed 733) from numerics run 42926430579 (Intel 8370C) and
  numerics2 run 43123132508 (Intel 8573C). Inputs are byte-identical across all hosts.
  A candidate passes D only if it equals both Intel recordings at all 24 lengths.
- Held-out H1: arithmetic-order run 43564031333 (Intel 6975P-C), `1 - corr(x, y)^2` at
  lengths 25-50 only (20 pairs per length, 520 objectives), where `x'*y` is MATLAB's pair
  tree on both hosts and the mean is host-independent; corr is evaluated as the port's
  `css::correlation` with only `nrm2` replaced by the candidate.
- Held-out H2: qr-kernels run 43127453138 host `ubuntu-22.04-3` (Intel 8370C), every
  real double design whose recorded pivot puts the x column first: R(1,1) = `dlarfg`'s
  beta = -sign(alpha) dlapy2(alpha, dnrm2(x(2:n))) with reference LAPACK `dlapy2`.

## Candidates (frozen)

1. `ref`: the port's reference-BLAS incremental scaled sum (the AMD order), sequential.
2. `blue`/`blue-fma`: LAPACK 3.10 (Anderson 2017, Blue's constants) sequential, the
   medium accumulator unfused or fused.
3. Lane family: layout `vector` of `qr-lane-models.py` (every element round-robin from
   lane 0), lanes L in {1, 2, 4, 8, 16, 32}, fold strides any permutation of the powers of
   two below L, tail in {`mod`, `seq`, `pow2`}; squares accumulated unfused
   (`acc + fl(x*x)`) or fused (`fma(x, x, acc)`); scaling none (`sqrt(sum)`), or two-pass
   by m = max|x| as `(x/m)^2` or `(x*(1/m))^2` with result `m*sqrt(sum)`.

## Decision and stop rules

- Identified: one candidate, or several that agree on every D, H1 and H2 value, passes D
  and equals every H1 objective and every H2 R(1,1) bit for bit.
- A candidate that passes D and misses any held-out value is refuted.
- If no candidate passes D, stop: H1 and H2 are not evaluated, so they stay held out for a
  later family.
- If every D-passing candidate fails H1 or H2: `dnrm2` stays unidentified in this unit;
  the next step is new evidence (a pre-registered recording), not a new family fitted to
  H1 or H2. Any family added after seeing H1/H2 is post hoc and needs a new held-out set.

## Amendment 1 (frozen after the discovery result, before H1/H2 were evaluated)

Result of the frozen family on D: no candidate passes (best 23/24; every candidate misses
n = 13). Diagnostic on D only: Intel's 24 norms are each the correctly rounded exact
Euclidean norm (|error| <= 0.472 ULP); the AMD order is correctly rounded at 14 of 24.
H1 and H2 remain unevaluated.

Family 2 (frozen now, derived from D alone):

- `cr`: the correctly rounded sqrt of the exact sum of squares.
- `dd-seq`: squares by FMA two-product, sequential two-sum accumulation (double-double),
  sqrt of the double-double sum with one Newton correction, rounded to double.

H2 is widened before any H2 value is read: every real double design of the Intel host
(either column pivoted first), R(1,1) predicted three ways for each family-2 candidate
`nrm2`: (a) reference `dlapy2(alpha, nrm2(c(2:n)))`, (b) the correctly rounded
sqrt(alpha^2 + nrm2(c(2:n))^2), (c) `nrm2(c(1:n))`, each with the sign opposite to alpha.

Decision rule unchanged: identified if a family-2 candidate (with one H2 variant) equals
every H1 corr value and every H2 R(1,1); any held-out miss refutes that combination. The
same rules apply to the AMD order (`ref`) as a control, which must keep matching the AMD
host. No further family is evaluated against H1/H2 in this unit.


## Correction after independent review (2026-11-18)

Appended; nothing above was changed.

- The H1 miss (n = 36, pair 6) is not undecided between the dot and the norm. Below 51
  elements MATLAB's `x' * y` is its own pair tree with identical arrays on both hosts
  (arithmetic-order, numerics), so MATLAB's Intel value needs the y norm one ULP below the
  correctly rounded one, at an exact norm 6.4e-5 ULP above a rounding midpoint. The
  correctly rounded norm is a candidate with that one known miss, not MATLAB's `dnrm2`;
  its rounding near ties is not identified. No threshold is adopted for it.
- The complex-norm agreement (24 of 24 per Intel host) is discovery data only.
- A prefix hash shows what was frozen, not when; the order of events rests on the local
  decision log.

## Further correction after independent re-review (2026-11-18)

Appended; the historical text and frozen prefixes above are unchanged.

H1 and H2 were also inspected before this record was frozen. H1's Intel `corr` values
had been compared with the AMD order. H2's Intel R(1,1) values had been searched with
plain and lane-wise norm candidates in commit `811e45c87` (2026-11-13). The earlier
"held-out", "unevaluated" and "before any H2 value is read" descriptions therefore do
not establish blind confirmation. The reported agreement is replay corroboration on
previously inspected recordings; the norm candidate remains refuted by the known miss.

The miss indices above are zero-based: pair 6 at n = 36, index 226 in H1. In one-based
MATLAB indexing those are pair 7 and objective 227.
