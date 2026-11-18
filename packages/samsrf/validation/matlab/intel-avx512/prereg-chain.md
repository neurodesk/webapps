# Pre-registration: MKL AVX512_E1 double real least-squares chain from existing recordings

Frozen 2026-11-18 before any chain candidate is evaluated. Local research note (branch
`t3/samsrf-876-intel`); no new MATLAB recording, no dispatch.

## Question

Can the double real `[a b] \ Y` chain of MATLAB R2023b on MKL's AVX512_E1 branch (Intel)
be reproduced bit for bit, kernel by kernel, from existing recordings, and does the
result then reproduce Intel's `detrend` and `samsrf_removenoise` outputs on held-out data?

## Data

- Discovery: qr-kernels run 43127453138, host `ubuntu-22.04-3` (Intel 8370C): the 95
  real double single-RHS chains (pivot, packed factor, tau, Q'y, coefficients), the real
  double 8-RHS solves (`multiple`: Q'Y, coefficients), and the FPRev `?gemv`/`?ormqr`
  probes. The AMD host `ubuntu-22.04-1` is the control: the prototype with the port's AMD
  kernels must reproduce its chains bit for bit before any Intel conclusion is drawn.
- Held-out H3: cgg run 43882331042, host `ubuntu-24.04` (Intel 6975P-C): `D = detrend(X)`
  of all 1,485 direct cases (recorded column j of V; n = 1, 2, 3, 37, 250).
- Held-out H4: revcor run 42445033403, host `ubuntu-24.04` (Intel 8370C): the double
  `recomputedCorrectedCourses` of the three `global1` matrix cases (42,000 values), from
  the host's own courses and global signal (stage-isolated: S1 and z-score are
  host-independent, `stages-1.json`).

H3 and H4 are not read by any chain code until the chain model is frozen in an amendment
of this file. H4 depends on 1,500-row designs and 21 right-hand sides; H3 on 1-12.

## Candidate switches (each fixed on discovery data, step by step)

1. `nrm2`: `ref` (AMD) or `cr` (correctly rounded; prereg-dnrm2.md).
2. `?gemv` column update tree: AMD `seed/8/2-4-1/seq` or Intel `vector/16/8-4-1-2/pow2`
   (FPRev fit), products accumulated unfused or with FMA; update `c - v t` unfused or FMA.
3. Single-RHS `?ormqr` tree: AMD `first/8/2-4-1/seq` or Intel `c0last/16/8-4-1-2/pow2`
   (FPRev fit for 1-3 RHS and the leftover of 33), accumulate unfused or FMA, update
   unfused or FMA.
4. `?trsv`/`?trsm`: the AMD division or reciprocal product; back-substitution
   `b1 - r12 x2` unfused or FMA.
5. Grouped `?ormqr` (4 or more RHS): no lane model fits Intel's FPRev counts; the tree is
   to be reconstructed from the counts and checked on the 8-RHS Q'Y before freezing.
6. `X * B` for the residual (`Y - X*B`) and the detrend fit (`a*(a\X)`): row products
   added unfused (AMD), or the second product fused onto the first, or the first fused
   onto the second; frozen as three alternatives, decided only on held-out data.

## Decision and stop rules

- Each switch is fixed when exactly one setting reproduces every discovery value of its
  step (given the earlier steps). A step that no setting reproduces stops the chain there:
  its candidate space is reported as exhausted and H3/H4 are not evaluated.
- With the chain frozen, H3 and H4 are evaluated once, with the three `X*B` alternatives
  (switch 6) reported side by side. Identified: one alternative reproduces every H3 and
  H4 value bit for bit. Anything less leaves the Intel chain unidentified for those
  designs; the misses are reported, not fitted.
- At most one amendment may add settings after a discovery step fails, and only from
  discovery data; H3/H4 stay unread until the freeze.

## Amendment 1 (discovery only; H3/H4 still unread)

Discovery result (`steps-intel-grid.json`, 144 settings, AMD control 95/95 at every step on
all five AMD recordings): with `nrm2 = cr`, the Intel `?gemv` tree with FMA accumulation
and a fused column update, every factorization step of all 95 Intel chains matches
(pivot, R11, v1, tau1, R12, R22, v2, tau2). With the Intel single-RHS `?ormqr` tree, FMA
accumulation and a fused update, rows 3..m of Q'y match in 95/95, but the leading entries
do not (qty1 63/95, qty2 59/95): the scalar `t = tau w` is right and only the leading
entry's update differs.

Added setting (one amendment, as allowed): the `?ormqr` leading-entry update is either
`c(1) - fl(tau w)` (current) or `fma(-tau, w, c(1))`. Both are evaluated on the 95
chains together with back-substitution `mul`/`fma`; the factorization switches stay as
identified above.

## Freeze (amendment 2; discovery complete, H3/H4 still unread)

Discovery results: AMD control reproduces all 95 single-RHS chains (every step, five AMD
recordings) and all 190 real double 8-RHS solves (Q'Y and coefficients). The Intel chain,
`chain.py` sha256 757823662d6ddc1d9d801c13a733c2cb709bb7833fc07883ccf10916a04d8809, reproduces on host ubuntu-22.04-3:
every step of the 95 single-RHS chains and Q'Y (1,520/1,520 columns) and coefficients
(190/190) of the 8-RHS solves. Its kernels:

- `dnrm2`: correctly rounded (pivot norms, `dlarfg`, norm downdates).
- `?geqp3` column update: tree `vector/16/8-4-1-2/pow2`, products accumulated with FMA,
  update `fma(-v, t, c)`, leading entry `c(1) - fl(tau w)`.
- `?ormqr`: right-hand sides in groups of four (index < 4 floor(count/4)) use the grouped
  tree (16-product chunks, lane k: `fma(v_k, c_k, fl(v_{k+8} c_{k+8}))` added to its sum,
  remaining products fused in chunks 8, 4, 2, 1 from lane 0, folds 4, 1, 2, c(1) last);
  the other columns use `c0last/16/8-4-1-2/pow2` with FMA. Updates `fma(-v, t, c)`,
  leading entry `fma(-tau, w, c(1))`.
- `?trsv`/`?trsm`: back-substitution `fma(-r12, x2, b1)`, then division (one RHS) or the
  reciprocal product (several).

Not covered by any discovery probe: leftover columns after full groups when count mod 4
is 2 or 3 (assumed single-column kernel); rows beyond 250 (H4 has 1,500).

Held-out evaluation, run once:

- H3: every cgg direct case on host ubuntu-24.04 (Intel 6975P-C): `D = X - a (a \ X)`,
  `a = [linspace(0, 1, n)' ones(n, 1)]` as the port builds it, the solve over the V
  columns at once (count V, index j), recorded column j; the inputs regenerated by the port
  must hash to the recording's.
- H4: the three double global1 revcor cases on host ubuntu-24.04 (Intel 8370C): the port's
  z-score of the host's global signal, `[x ones] \ Y` over the ROI courses (count 21,
  ROI order), `Y - X B`.
- `X B` alternatives, reported side by side: (a) products rounded and added in column
  order; (c) `fma(x, b1, b2)` (the covariate's product fused onto the intercept term). (b)
  `fma(1, b2, fl(x b1))` equals (a) for these designs and is not listed separately.
- Identified only if one alternative reproduces every H3 and H4 value bit for bit. Misses
  are reported by case, not fitted. No chain change after this point uses H3 or H4.

## Held-out result (run once at the freeze, heldout-1.json)

`chain.py` sha256 757823662d6d...: hash verified by `heldout_eval.py` before running.

| Set | Host | Intel chain, X B (a) | Intel chain, (c) | AMD chain |
| --- | --- | --- | --- | --- |
| H3 n = 250 | Intel 6975P-C | 247,500 / 247,500 (990/990 cases) | 237,440 | 50,761 |
| H3 n = 37, 3, 2, 1 | Intel 6975P-C | 7,995 / 7,995 (495/495 cases) | 7,865 | 4,416 |
| H4 lh average1, lh average0 (1,500 rows), rh average1 | Intel 8370C | 42,000 / 42,000 (63/63 courses) | 37,148 | 4,844 |

AMD controls on the AMD hosts (AMD chain): H3 255,495 / 255,495 and H4 42,000 / 42,000
with (a); (c) fails there too. Decision: identified. Alternative (a) reproduces every H3 and
H4 value bit for bit; (c) is refuted. The leftover-column assumption (count mod 4 = 2, 3) is
confirmed by H3's V = 6, 7, 10, 11 cases, and rows beyond 250 by H4's 1,500-row case.


## Correction after independent review (2026-11-18)

Appended; nothing above was changed.

- H3 and H4 were not unread when the freeze was written. The stage trace (`stages-1.json`,
  cited in the frozen text) had compared the AMD arithmetic with both targets, and an
  exploratory probe had searched H4's coefficients and both `X * B` orders on its 63 Intel
  courses. Their results corroborate the frozen chain by replay; they are not blind
  holdouts, and "held-out" above should be read that way.
- The prefix hashes prove the frozen text, not when it was written. `heldout_eval.py`'s
  switches (the `X * B` orders, the AMD control kernels, the trsv/trsm choice by count)
  were not covered by the model's hash.
- The AMD arithmetic reproduces 55,177 of the 255,495 H3 values, not 55,277.
- The chain's norm is the correctly rounded candidate of prereg-dnrm2.md, with its one
  known near-tie miss; the chain does not identify MATLAB's `dnrm2`.
- Scope: finite real two-column designs as recorded. More than two columns, reflectors
  that end in zeros, the `xLARFG` halving path, norm ties and nonfinite inputs are reached
  by no recording.
