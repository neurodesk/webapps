# Fitted-HRF probes: predictions and design (#730)

Committed before the first recording. The recorder (`record_fitted_hrf.m`)
only records; this file fixes what it records, what each outcome would mean,
and which data may be used to choose a correction.

## Question

The pin's six double non-CSS optimizer fits that fit the HRF with the pRF
(`fit_double_fitted_hrf`, 9,418 recorded `fminsearch` evaluations) are the only
recorded double non-CSS fits the port does not follow evaluation by evaluation.
At MATLAB's own recorded parameters the port's objective equals MATLAB's at
8,058 evaluations and differs at 1,360. The six traces first diverge at
evaluations 16, 15, 15, 35, 16 and 16 (zero-based); the largest difference is
136 ULP. The 26 fixed-kernel fits of the same pin match at all 3,186
evaluations, so `prf_predict_timecourse`, `conv` (on 33-tap kernels), `corr`
and `1 - R^2` are already established for this objective. Which operation is
the first to differ?

## Pinned source

`prf_errfun` (SamSrf `41ed1e96`): for a negative scalar `Hrf`, out-of-bounds
HRF parameters return 1; otherwise
`Hrf = samsrf_doublegamma(-Hrf, P(end-4:end))`, then
`prf_convolve_hrf` (`conv`, truncate), `corr`, `1 - R.^2`.

`samsrf_doublegamma(TR, P)`: `p = [6 16 1 1 6 0 32]`, `p(1:5) = P`;
`L = length((p(6):p(7)/TR) * 16 + 1)`, `T = linspace(p(6), p(7), L)`;
`g1 = gampdf(T, p(1)/p(3), p(3))`; `g2 = gampdf(T, p(2)/p(4), p(4)) / p(5)`;
`Hrf = (g1 - g2)'`. With TR 1, `T = 0:32` (33 samples). There is no
normalisation.

The port (`hrf::doublegamma`, `matlab_math::gampdf`) evaluates `gampdf` for
shape `a >= 1` as `exp((-log(2 pi k)/2 - stirlerr(k)) - bd0(k, x/b)) / b`
with `k = a - 1`. `stirlerr` uses a table at half-integers up to 15,
`gammaln(k + 1) - (k + 0.5) log k + k - ln sqrt(2 pi)` elsewhere up to 15 and
a truncated Stirling series above. The 9,760 recorded `gampdf` probe densities
(`numerics2-reference.json`) cover only one non-half-integer `k` below 15
(`k = 4.5278`); fitted HRFs move `k` continuously (about 4.5 to 16 in these
traces). A local test made before this file, replacing the port's
`ln sqrt(2 pi)` literal (`0x3fed67f1c864beb5`) by `log(sqrt(2*pi))`
(`...beb4`), made agreement worse (3,141 differing, first at evaluation 9). That
candidate is excluded and is not retested.

## Recording

`record_fitted_hrf(sourceDir, referenceDir, output)` reads the pinned
741-case reference (`reference.json`: the six traces, their observations,
`fit-apertures.mat`) and runs SamSrf's own functions at **the recorded
parameters** of every evaluation. Nothing is optimised; no parameter is
chosen by MATLAB.

For every one of the 9,418 evaluations (kernel stage, all evaluations):

- `A1 = p1/p3`, `B1 = p3`, `A2 = p2/p4`, `B2 = p4`, and `p5`;
- `g1 = gampdf(T, A1, B1)`, `g2raw = gampdf(T, A2, B2)`, `g2 = g2raw / p5`
  and `Hrf = samsrf_doublegamma(1, P(end-4:end))` (33 samples each), plus
  `gampdf` called once per sample (scalar) for both gammas;
- the port's `gampdf` algorithm evaluated by MATLAB for both gammas, with
  MATLAB's own `log`, `exp` and `gammaln` and otherwise only `+ - * /`, which
  are exactly rounded in both: `gammaln(k + 1)`, `log(k)`, `log(2*pi*k)`,
  `stirlerr(k)`, and per sample `z = T/B`, `bd0(k, z)`, the exponent argument,
  `exp` of it as a scalar call and as one call on the 33-sample vector, and the
  assembled density;
- `err = prf_errfun(...)` at the recorded parameters, which must equal the
  pinned trace value bit for bit on the pinned host's CPU vendor (AMD).

For a bounded window per trace, the evaluations `first - 2 ... first + 2`
around the first divergence above, and evaluations 0 to 2 as passing controls
(48 evaluations): `prf_errfun`'s stages `Rfp`, `Yp`, the convolution before
and after truncation, `R` and `err`.

Generated held-out densities (fixed seed `rng(7302, 'twister')`): 200 pairs
with `A` uniform on [1.5, 20] (non-half-integer `A - 1`) and `B` uniform on
[0.5, 3], each on `T = 0:32` and on 40 random `x` in (0, 40), with the same
per-sample decomposition.

Workflow: `samsrf-native` dispatch with `record_matlab` and `fitted_hrf`, on
both runner labels (`ubuntu-22.04`, `ubuntu-24.04`), each recorded twice in
fresh MATLAB processes; the job fails unless the repeat is bit-identical.
The pack records each host's `lscpu`, MATLAB version and BLAS line, every file's
SHA-256, shape, class and byte count, and is pinned on Hugging Face by commit
and hash in `fitted-hrf-reference.json`.

## Competing predictions

- **H0 (irreproducible).** MATLAB's recomputed `err` differs from the pinned
  trace at some evaluation on an AMD host, or between fresh processes. Then
  the trace is not a stable target; stop and report.
- **H1 (kernel stage).** At the first divergent evaluation of each trace,
  MATLAB's `Hrf` differs from the port's kernel, and at every passing
  evaluation it is equal. Sub-hypotheses:
  - **H1a (`gammaln`).** MATLAB's `gammaln(k + 1)` differs from the port's
    Cody `gammaln` at the `k` values whose densities differ (non-table branch
    only, `k <= 15`).
  - **H1b (elementary functions).** `gammaln` agrees, but MATLAB's `log` or
    `exp` on these arguments differs from the port's fdlibm `log` or `libm`
    `exp`; or MATLAB's vector `exp` differs from its scalar `exp`.
  - **H1c (formula).** Every primitive agrees and MATLAB's evaluation of the
    port's algorithm equals the port bit for bit, but MATLAB's `gampdf` differs
    from it: MATLAB's formula or operation order is not the port's for these
    `(k, z)`.
- **H2 (downstream).** MATLAB's `Hrf` equals the port's at the first divergent
  evaluations, and the difference appears in `conv`, `corr` or `1 - R^2`.
- **H3 (host).** AMD and Intel MATLAB give different densities or kernels at
  these parameters (reported per vendor; it does not by itself decide H1).

## Discovery and holdout

- Discovery: traces 1-3 (zero-based fits 0, 1, 2). A correction may be chosen
  only from what these show.
- Holdout, used once after a correction is fixed: traces 4-6 (fits 3, 4, 5)
  and the 200 generated pairs. A correction is accepted only if, unchanged,
  it makes every held-out recorded value equal MATLAB's on the AMD host, and
  every existing gate (`matlab_numerics2.rs` 9,760 densities and HRF kernels,
  `double_forward_diagnostics.rs`, CSS traces and pipelines, QR, revcor,
  geometry) still passes.
- No constant, threshold or branch may be fitted to the recorded values. A
  correction must be an operation order or a formula that MATLAB is shown to
  use, or the evidence is published without a production change.

## Controls

- Positive: MATLAB's recomputed `err` equals the pin at the evaluations the
  port already matches.
- Negative: the analysis must fail when one recorded density, kernel sample or
  `err` is changed by one ULP, when an evaluation is missing, and when the
  per-file hashes do not match the pack inventory.
- Regression: the 26 fixed-kernel traces, the nine double forward pipelines and
  every existing numerical gate keep passing unchanged.
