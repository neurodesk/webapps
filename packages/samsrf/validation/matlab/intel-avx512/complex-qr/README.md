# Complex two-column QR candidate

This is offline research against fixed #884 `86937c35241eb8fad277406f2754b48dab1cb0ba`.
It addresses the remaining complex least-squares stages, not the single path or the
production regression in #876. The three shipping module files remain unchanged.
No MATLAB dispatch, new recording, reference policy, or CPU selection is part of it.

## Inputs and exposure

The pinned `qr-kernels` data has one Intel 8370C AVX512_E1 host and five AMD CNR auto
controls. `qr-reference/ubuntu-24.04/compatible` supplies the original design and RHS
arrays. All these recordings were already exposed; every result is a discovery or
corroboration replay, never a blind holdout. Existing source-input receipts remain
unattested. The candidate is not a claim about an actual container or browser UI run.

The 79 complex-double chains record pivot, packed factors, both tau values, Qᴴy and
coefficients. The 158 eight-column designs supply 1,264 Qᴴy columns and coefficient
pairs, including both design column orders. The complex GEMV cancellation probes give
1,568 nontrivial matrices across both component probes, 49 lengths from 3 to 250, and
all 16 alignment combinations. They identify addition trees, not fused multiplication.
UNMQR probes cover one, two, three, four, eight, 16, 33 and 300 RHS columns; only selected
columns and lengths are recorded for counts other than one and eight.

## Sequential localization

The finite families below operate on original inputs or recorded intermediate values,
not fitted-map outputs. Scores are in `discovery-scores.json`; the Python programs retain
all miss identifiers in their output. The scripts were normalized for readability after
the original scratch experiment, then replayed. Their committed versions are reproducible
replays, not retroactively preregistered models.

1. First reflector: reference scaled norm or correctly-rounded norm, crossed with three
   ways to round each complex product component (18 candidates). Correctly-rounded norm
   plus FMA on the real multiplier component matches all 79 Intel pivots, R11, tau1 and
   reflector tails. Reference norm and unfused scaling match all 79 AMD cases.
2. GEMV: four lanes, whole blocks of eight, fold `(0+2)+(1+3)`, then sequential tail
   matches every complex fingerprint, including alignments. The tested family separates
   lane count from block size, which the older fingerprint search did not.
3. R12: 13 dot-product models (nine rounded-product variants, two sequential FMA orders,
   and two split-product variants) crossed with nine tau-product variants. Ten dot models
   tie because the other column is real. Fusing the first multiplicand's real component
   in the tau product is required. This stage alone cannot identify complex cross-products.
4. Column update: nine product/subtract variants plus four nested-FMA orders. Exactly one
   gives all 79 R22, tau2 and second-reflector tails, using the first-reflector rule.
5. Qᴴy: the first component has the same real-input ambiguity. The second reflector sees
   complex intermediate inputs and separates it: one of 13 × 13 × 9 update/dot/tau models
   reproduces every second component. Applying its update to the remaining rows gives
   all 79 complete Qᴴy vectors. The same rounded complex product reproduces all 1,264
   multi-column Qᴴy vectors, distinguishing it from fused accumulation and split sums.
6. Backsolve: three division forms crossed with 13 product/update forms. For one RHS,
   the initial simplified diagnostic gets 76/79: two misses are signed-zero cross-products
   it omitted, and one is an overflowing squared denominator. The Rust candidate retains
   those cross-products and uses reciprocal scaling when the squared denominator is
   unsafe; all 79 coefficients then match bitwise. This fallback is a candidate, not an
   identification of unrecorded overflow paths. Multi-RHS uses reciprocal scaling and a
   distinct nested-FMA update, reproducing all 1,264 coefficient pairs.

UNMQR uses the same four-lane fold: paired RHS columns distribute the whole tail over
lanes; an odd final column uses whole blocks of eight then a sequential tail. Both add
the implicit leading element last. GEMV includes that element in its block. The two
routines therefore must not share an unconditional tail rule.

## Candidate and limits

`exes/samsrf/mkl-avx512/src/complex_qr.rs` implements this finite, tall, two-column,
complex-double candidate in the isolated test crate. It rejects wider, shorter, nonfinite
and wholly real designs. Its scratch-only harness patch routes just this supported
class; all single and other unsupported designs retain their preceding research route.
The norm remains the earlier correctly-rounded candidate with two known real near-tie
misses. No band adjustment or special case for an observed value is added.

The bit gate in `tests/divergence.rs` checks every Intel stage and multi-RHS output and
requires all six recorded hosts. All five AMD shipped controls pass; running the Intel
candidate against AMD yields zero fully equal chains, zero full QᴴY columns and four
coefficient pairs out of 1,264. The gate records each stage's count rather than claiming
an arithmetic can simultaneously match both host branches. When MATLAB stores an
all-real coefficient array it does not preserve imaginary zero signs; only those
explicitly real descriptors use the existing recording convention in the multi-RHS gate.

Not identified: single arithmetic, more than two columns, general complex RHS inputs,
unrecorded norm ties, full RHS group coverage outside the recorded shapes, and extreme
paths not exercised here. The whole pipeline is a downstream corroboration replay.
Any new downstream miss stays disclosed rather than becoming a tuning target.

## Reproduction

Set `SAMSRF_QR_PROBE_PINS` to the provisioned pin root containing `qr-kernels` and
`qr-reference`. Python 3.13+ is required for `math.fma`. Run each `*_probe.py REPORT.json`;
`tree_probe.py` checks both fingerprint components and all alignments. The family scripts
have dependencies within this directory and the existing `chain.py`/`qr-lane-models.py`.
Run the Rust divergence test with `SAMSRF_QR_KERNELS_DIR` and `SAMSRF_QR_REFERENCE_DIR`.
The full research evaluation uses `harness/build.sh avx512-complex-qr OUT`, the existing
24-run matrix and native CSS pipeline drivers. Preserve baseline and earlier reports;
account for every real, imaginary and GIfTI value against both hosts.

## Frozen downstream replay

The candidate was committed as `129f6768b` before any downstream evaluation. The research
module is `05ae8063ba8ef52c2b1f5168c69019971de9905b724174fed04ae4d89952f021`.
Its source and patch hashes, actual executions, and reused baseline artifacts are listed
in [validation.json](../harness/cc528cf6-3/validation.json). No arithmetic was retuned after
this freeze. Adding the new variant to the accounting tools' allowlists changes no bit
comparison, host validation or null-control requirement.

[The matrix](../harness/cc528cf6-3/matrix.json) compares the fresh research runs with the
committed `cc528cf6` module; [the pipeline report](../harness/cc528cf6-3/pipelines.json)
uses the corresponding native hooks baseline. Each bundle's 236-file null control was
rechecked against the retained outputs, and all 236 research output files are identical
between bundles. Source MATLAB receipt limitations still apply.

| Intel result | Committed | Prior complex-corr research | Complex-QR candidate |
| --- | --- | --- | --- |
| Exact CLI maps / runs | 57 / 0 | 113 / 7 | 115 / 8 |
| Complex CLI raw real equal | 68 / 135 | 107 / 135 | 135 / 135 |
| Complex CLI raw imaginary equal | 79 / 135 | 108 / 135 | 135 / 135 |
| Complex CLI GIfTI equal | 135 / 135 | 135 / 135 | 135 / 135 |
| Native CSS scalar values equal | 2,798 / 3,456 | 3,240 / 3,456 | 3,456 / 3,456 |

Against the preceding research build, Intel gains 28 real and 27 imaginary CLI values,
plus 108 real and 108 imaginary pipeline values, with zero losses in either. All three
previous CLI coefficient losses disappear. Both recorded double CSS conventions now
match every scalar, including Beta and Baseline, on the Intel recording.

Against the committed module, Intel gains 673 raw real, 56 raw imaginary and 69 GIfTI
values, with zero losses. Native pipelines gain 453 real and 205 imaginary values with
zero losses. Single remains unchanged: 521 real, 49 imaginary and 521 GIfTI values still
differ on Intel. The 110 real-double CLI differences also remain. This is not whole
SamSrf parity and does not repair or waive #876's production regression.

The AMD controls remain distinct. Against committed arithmetic, the candidate loses
798 CLI values (673 real, 56 imaginary, 69 GIfTI) and 637 pipeline values, with no gains.
Against preceding research it gains three CLI values and loses 14, and loses 200 pipeline
values with no gains. The [transition report](../harness/cc528cf6-3/relative-to-prior-research.json)
retains every lost value and both host totals. No CPU/reference policy follows from these
results. Fresh independent review and full affected CI remain the parent's next steps.
