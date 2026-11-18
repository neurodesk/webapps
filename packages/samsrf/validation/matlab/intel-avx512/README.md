# MKL's AVX512_E1 branch (Intel hosts): fitting record

MATLAB R2023b on the recorded Intel Xeon hosts (8370C, 8573C, 6975P-C) runs MKL 2021.3's
`AVX512_E1` branch, and its double results differ from the AMD hosts' (`CNR auto`) that
the shipped port follows. This folder records how a reference for that branch's finite
real two-column least squares was fitted to existing recordings under pre-registered
predictions and stop rules, and what the evidence does and does not show. The reference
is the test-only crate `exes/samsrf/mkl-avx512` (`samsrf-mkl-avx512`), gated by
`exes/samsrf/mkl-avx512/tests/recordings.rs`. It changes no shipped output: the shipped
module still loses the Intel exact values listed in the README's "Double global
regression", and that regression still blocks #876. No new MATLAB recording was made.

## Where the Intel host first departs

On inputs that are identical between the hosts, or between a host and the port:

- MATLAB's `zscore` (its `mean`, `sum` and `std`): on the constants-gamma-gemv recording
  (AMD EPYC 9V74, Intel Xeon 6975P-C, byte-identical inputs) the port's `zscore` of each
  host's own `detrend` output equals that host's `zscore` in every value, 255,495 on both
  hosts; where the two hosts' `detrend` outputs agree, their `zscore` outputs agree.
- `nanmean(Srf.Data, 2)`: from each reverse-correlation host's own courses the port's
  global signal equals the recorded one on the Intel host too (2,000 of 2,000 double).
- MATLAB's own `x' * y` below 51 elements, its HRF sums and `conv`: identical on both
  hosts of the numerics recordings.
- The first host-dependent arithmetic is MKL's: `detrend`'s solve (50,761 of 247,500
  Intel values at 250 samples equal the AMD arithmetic), `norm` (`dnrm2`, 1-2 ULP from the
  AMD order at 10 of 24 lengths on both Intel models) and `x' * y` from 51 elements.

The double global regression's residuals (`samsrf_removenoise`) therefore depend on
MKL's least-squares chain, not on MATLAB's z-score or mean.

## Pre-registrations

Amendments, results and the correction after review were only appended, so every frozen
version is a byte prefix of its file:

| File | Version | Prefix bytes | sha256 of the prefix |
| --- | --- | --- | --- |
| `prereg-dnrm2.md` | original | 2,870 | `33951f693321505277413a3fdc455d74c3920e60332892a33b22e80161e970fd` |
| `prereg-dnrm2.md` | amendment 1 (correctly rounded family) | 4,199 | `1fde38f2c926df05f493082ba954aa147dfd42b492b00f6946f9109e0474e95d` |
| `prereg-chain.md` | original | 3,375 | `3ae1c9cf19492fedc7906949bd7e54f0174ac9c1154d4abbe1b23514a0b61667` |
| `prereg-chain.md` | amendment 1 (leading-entry update) | 4,258 | `faf936c6b0c2c9305fb417c0e0ac674630eac628f7c8d9eace0927b947e99093` |
| `prereg-chain.md` | freeze (amendment 2) | 6,610 | `a8e3bd0ce8a4993b0e7646e381cd76ad4acd75ac98b176cf4d4515e265185b66` |

`head -c 6610 prereg-chain.md | sha256sum` checks the chain freeze. The frozen model is
`chain.py` (sha256 `757823662d6ddc1d9d801c13a733c2cb709bb7833fc07883ccf10916a04d8809`,
also in `chain.frozen.sha256`), which `heldout_eval.py` verifies before it runs. A prefix
hash proves what was frozen, not when: the order of events rests on the local decision
log. The evaluator's own switches (the two `X * B` orders and the AMD control kernels)
were outside the model's hash.

## Results

The norm (`prereg-dnrm2.md`). No candidate of the frozen lane-tree family reproduced the
24 discovery norms (the best 23; every candidate missed n = 13). Intel's 24 norms are
each the correctly rounded norm (|error| at most 0.472 ULP; the AMD order is correctly
rounded at 14). The correctly rounded candidate documented in amendment 1 matches R(1,1)
of all 95 real double kernel chains (with LAPACK's `dlapy2`) and 519 of the 520 Intel `corr`
values from 25 to 50 elements. Both sets had been inspected before that amendment;
these are replay results, not blind confirmation. The miss (n = 36, zero-based pair 6,
zero-based index 226 of that set) is not the
dot product: below 51 elements MATLAB's `x' * y` is its own pair tree, with identical
arrays on both hosts of the arithmetic-order and numerics recordings. MATLAB's value needs
the y norm one ULP below the correctly rounded one, and the exact norm lies 6.4e-5 ULP
above a rounding midpoint. The correctly rounded norm is therefore a candidate, not
MATLAB's `dnrm2`: its rounding near ties is not identified. The gate
`correctly_rounded_norm_is_a_candidate_with_one_known_miss` pins the miss, with the AMD
order as negative control. A band that rounds down within 2^-13 ULP above a midpoint also
fits these data; it is a fit to one point, not adopted. The complex norms (`dznrm2`) agree
with the correctly rounded norm on 24 of 24 vectors on both Intel models (the AMD order
11): discovery data only.

The least-squares chain (`prereg-chain.md`). With the correctly rounded norm, a 16-lane
`?gemv` with fused accumulation and update, the 16-lane single-column and the paired
grouped `?ormqr` trees with fused updates and a fused leading entry, and a fused
back-substitution, every step of the 95 Intel chains and Q'Y and coefficients of the 190
eight-column solves matched (discovery). The frozen chain then reproduced:

| Replay set (read before the freeze) | Intel host | Frozen chain | AMD arithmetic |
| --- | --- | --- | --- |
| `detrend` of the 1,485 constants-gamma-gemv direct cases | Xeon 6975P-C | 255,495 / 255,495 | 55,177 |
| double `samsrf_removenoise`, three revcor cases (21 courses, up to 1,500 rows) | Xeon 8370C | 42,000 / 42,000 | 4,844 |

These are replay corroboration, not blind holdouts. Before the freeze, the stage trace
(`stages-1.json`, cited in the frozen prefixes) compared the AMD arithmetic with both
targets, and an exploratory probe searched the global regression's coefficients and both
`X * B` orders on its 63 Intel courses. `X * B` rounds both products, as on AMD; the fused
order failed on both sets. The AMD controls reproduced both sets on the AMD host.

After the freeze, with no change to the model, the Rust gates also reproduced every
recorded course of the 134,257-134,260-vertex pipeline runs (Xeon 6975P-C, 70,500 values),
the revcor raw-file preprocessing and its global signal (Xeon 8370C, 187,000 values), the
SamSrfAnalysis double `Srf.Y` of 11 runs (Xeon 8573C, 84,000 values) and the CSS pipeline
courses (Xeon 8573C, 48,000 values in each of 2 processes, where the shipped detrend
differs and reproduces the AMD host instead).

## Scope

Established only for finite real two-column designs with the recorded shapes (2, 3, 16,
37, 250 or 1,500 rows; 1-3, 5-12, 21, 76 or 96 right-hand sides, or every vertex of a
whole-hemisphere run), including rank-1 designs and the `xLARFG` rescale of subnormal
reflectors. No recording reaches more than two columns (norm downdating and later
pivots), reflectors that end in zeros, the `xLARFG` halving path, exact or near rounding
ties of the norm, or nonfinite inputs: mutating those paths leaves every gate passing.
Single and complex designs and every other MKL kernel are not part of the reference.

## Research: `x' * y`, `y' * A`, `corr` and CF profiles (branch `t3/samsrf-intel-cf`)

Not part of #880. `prereg-dot-gemv.md` was frozen (sha256 `f819c98b...`, 4,719 bytes)
before any Intel model touched these data. Prior exposure, stated there: the
arithmetic-order and constants-gamma-gemv draws had been compared, in aggregate, with AMD
models only; the `corr` values at 25-50 elements had been evaluated with the norm candidate
and are replay; the CF profiles had been counted against the AMD kernel. The held-out
evaluators were written in the step that ran them; only the kernels were hashed first.

| Kernel (Intel Xeon 6975P-C unless noted) | Discovery | Then |
| --- | --- | --- |
| `x' * y` from 51 elements (`dot/dot_kernel.py`) | 67,195 fingerprints, draws 1-25 (975) | draws 26-50: 975 / 975 |
| `y' * A` (`gemv/gemv_kernel.py`, written a priori from `?ormqr`) | every fingerprint of 9 shapes, draws 0-49 | draws 50-99: 2,500 / 2,500 |
| `corr` with both and the norm candidate (`downstream/downstream.py`) | | 51-250 elements: 679 / 680; 25-50 (replay): 519 / 520 |
| double CF profiles, revcor run 42445033403 (Xeon 8370C) | | 3,402 / 3,402 |

`x' * y` from 51 elements: 32 lanes over whole blocks of 32, a chunk of 16 and of 8 from
lane 0 where they fit, the rest masked from lane 0, products fused, folds 8, 16, 4, 2, 1.
`y' * A`: the Intel `?ormqr` trees without `c(1)` (grouped for columns in whole groups of
four). Both `corr` misses (n = 36 pair 6, n = 75 pair 16) have the same signature: the exact
y norm lies 6.4e-5 and 2.6e-4 ULP above a rounding midpoint and MATLAB's value needs that
norm one ULP below the correctly rounded one. Rounding the exact sum of squares to double
before the square root is refuted (it fails D, R(1,1) and `corr` widely), and a 2^-13 ULP
band would not cover the second case: near-tie rounding stays unidentified, and the gates
in `exes/samsrf/mkl-avx512/tests/blas_recordings.rs` pin both misses.

## Research: the engine with these kernels on the 24-run matrix (`harness/`)

Not part of #880 and not a product change. `harness/` builds the engine in a directory
outside the checkout, with every real double MKL kernel replaced by this crate's: `x' * y`
from 51 elements, `norm`, `y' * A` and the least-squares chain. Single and complex kernels
stay the shipped ones. The build, its controls and the commands are in
[harness/README.md](harness/README.md). The kernels are those frozen above, unchanged, with
the correctly rounded norm candidate.

Prior exposure and chronology:

- The CLI recording's Intel maps had been compared only with shipped modules (the cross-host
  comparison, and the one gain and seven losses in the README's "Double global regression").
  Its Intel `Srf.Y` is a post-freeze gate of #880.
- The CSS pipelines' Intel maps had not been compared with any model; only their courses
  had.
- The harness and the accounting were written in this unit. The comparator's summary counts
  were seen before `account.py` first counted values. No kernel or patch changed after a
  result, except one: the install was moved into an idempotent function so that native
  tests can call it. Every run's output hash is unchanged.

The null control (the hooks build with nothing installed) writes the committed module's
bytes in all 236 files of the 24 runs on both bundles. Each module writes the same bytes
from both hosts' bundles. Raw values are every Srf.Data value over the ROI (21 vertices).
GIfTI values cover every vertex. Counts are values equal to MATLAB, bitwise
(`harness/matrix-1.json`):

| Route | Values | AMD 9V74, committed module | AMD 9V74, research module | Intel 8573C, committed module | Intel 8573C, research module |
| --- | --- | --- | --- | --- | --- |
| real double, raw | 1,797 | 1,663 | 1,058 | 1,058 | 1,663 (+605, -0) |
| real double, GIfTI | 1,797 | 1,797 | 1,728 | 1,728 | 1,797 (+69, -0) |
| complex double (15 CSS vertices), raw real / imaginary | 135 / 135 | 135 / 135 | 77 / 83 | 68 / 79 | 85 / 81 (+23, -4) |
| complex double, GIfTI | 135 | 135 | 135 | 135 | 135 |
| single, raw real / imaginary | 1,596 / 1,596 | 1,596 / 1,596 | 1,596 / 1,596 | 1,075 / 1,547 | 1,075 / 1,547 |
| single, GIfTI | 1,596 | 1,596 | 1,596 | 1,075 | 1,075 |
| exact maps / exact runs (comparator) | 168 / 24 | 157 / 17 | 100 / 10 | 55 / 0 | 108 / 6 |

The imaginary parts of real double vertices (+0) and the 12,360 GIfTI values outside the ROI
are equal with every module on both hosts. Two runs are refused on both hosts and by both
modules (single RC with a fitted profile, single CF Gaussian).

On the Intel host, six double runs become exact with the research module:
`prf_gaussian_lh_average_double`, `prf_gaussian_lh_concatenate_double`,
`prf_gaussian_rh_double`, `prf_custom_hrf_lh_double`, `cf_summary_lh_double` and
`cf_gaussian_lh_double`. Every value of their maps is MATLAB's, including the fitted
parameters. On real double routes, the research module matches the Intel host exactly as
often as the committed module matches the AMD host. The 134 raw values it still misses are
at the positions the committed module misses on AMD. For 131 of them, both hosts' MATLAB
values are equal and both modules' values are equal. These are host-independent port gaps
that [the package README](../README.md) lists for the AMD host: the convex-hull geometry of
the RC and CF hull fits (#732) and the RC Gaussian fits, which need a MATLAB trace.

The research module loses 4 Intel values, all on complex vertices of `prf_css_lh_double`:
nR^2 imaginary at vertex 5, Beta real at vertex 11, Baseline real at vertex 4 and Baseline
imaginary at vertex 5. They differ from MATLAB by 3 to 5 ULP. The fitted parameters of
these vertices are exact with both modules, so their prediction `x` is identical. Beta and
Baseline, `[ones x] \ y`, can change only through `y`. The committed module uses the AMD
detrend, and the hosts' recorded `Srf.Y` differ at 219 to 250 of 250 samples of these
vertices. Its 4 matches combined the AMD host's `y` with the AMD complex kernels, so they
are coincidences. With Intel's own `y`, the research module exposes the unimplemented
complex kernels. Run on the AMD host, the research module loses 784 values: it is not the
AMD reference.

A second recording, the Intel CSS pipelines (`harness/css-pipelines-*-1.json`), was run
natively from MATLAB's own courses on the Xeon 8573C, with the AMD EPYC 9V74 as control:

- The nonnegative pipeline, all real, 96 vertices and 9 maps: with the research kernels,
  every value equals Intel MATLAB. With the shipped arithmetic, 8 of the 9 maps differ, with
  39 to 94 of 96 values equal; the noise ceiling, computed from the courses, is equal with
  both.
- The samsrf-convention pipeline: every value of its 39 real vertices is equal with the
  research kernels. Its 57 complex vertices still differ: x0 and y0 55/57, Sigma 57/57,
  Exponent 54/57, real R^2 17/57, Beta 4/57, Baseline 2/57. The fitted parameters of 2 to
  3 complex vertices differ with both builds.
- The AMD host reproduces every value with the shipped arithmetic.

The research module ran the matrix in 67 to 69 s against 56 to 57 s (the exact norm uses
big integers), and its unoptimized module is 90 KB larger than the hooks build.

## Research: where single and complex runs first depart (`tests/divergence.rs`)

These tests locate the first departure with the shipped kernels and fit no Intel model. On
every AMD host of each recording, the shipped kernels reproduce every compared value; that
is the control. The Intel counts are observations of data that earlier reports had counted
only in aggregate. They are pinned so that a change shows; they are not targets
(`harness/divergence-1/`).

- Preprocessing is not where single runs depart. The CLI recording's single `Srf.Y` equals
  the port's in all 84,000 values on both hosts: SamSrf detrends in double and rounds to
  single afterwards, and the Intel host's double rounding differences vanish there. The
  shipped double detrend matches 4,033 of 84,000 Intel values; this crate matches all.
- Single CF `corr(y, X)` (single-kernels recording, Xeon 8573C): MATLAB's own `sum`, `mean`
  and `vecnorm` are equal at every stage. The first departure is MKL `sgemv`: 110 of 378
  products equal, then 121 of 378 correlations. The x0 and y0 maps of the single CF runs are
  still exact, because the peak and the hull survive small changes in the profile; R^2,
  Beta and Suppression are not.
- Single and complex least squares (qr-kernels recording, Xeon 8370C): no single or complex
  chain equals the shipped model end to end. The first differing step is R(1,2), the `?gemv`
  update of the second column, in 87 of 107 single real chains, 41 of 64 single complex
  chains and 49 of 79 complex double chains. It is R(1,1), the complex norm, in 23 complex
  double chains, and reflector 1 in 7 complex double and 21 single complex chains. Of the
  8-column solves' coefficient columns, 334 of 1,712 single real, 56 of 1,072 single
  complex and 4 of 1,264 complex double are equal; no Q^H Y column is.
- Complex BLAS (numerics recordings, both Intel models, 24 vectors): the shipped `z' * y`
  equals MATLAB on 5 and the shipped `norm(z)` on 11. The correctly rounded norm over
  interleaved parts equals all 24 (discovery data only). This crate's `x' * y` equals all
  24, including the 3 lengths from 51 elements; these were compared after its freeze, not as
  pre-registered held-out data.
- Single pRF fits: no Intel recording isolates `sdot`. Besides the dot product, the single
  objective uses means and norms that are MATLAB's own sums, like the single CF stages that
  are equal on the Intel host. The betas use single least squares. By elimination, the
  departure is in `sdot` and the single least squares. This is inferred, not measured.

So on the Intel host, each remaining route first departs in an MKL kernel that has no Intel
reference:

| Route | First departure | Evidence that exists | What identification needs |
| --- | --- | --- | --- |
| single CF | `sgemv` (`y' * X`) | single-kernels products (378 per host) | fingerprints; none recorded for Intel `sgemv` with `trans` |
| single RC | single `[Y ones] \ X` | qr-kernels chains, 8-column solves, `?gemv` and `?ormqr` fingerprints (Xeon 8370C) | a pre-registered fit like `prereg-chain.md` |
| single pRF | `sdot` (inferred), single betas | none for `sdot`; chains as above | an `sdot` fingerprint recording |
| complex CSS R^2 | `z' * y`, `norm(z)` | 24 numerics vectors per Intel model | `zdotc` fingerprints; `norm(z)` has a candidate (24/24) |
| complex CSS Beta, Baseline | complex `?geqp3`, `?unmqr`, `?trsv` | qr-kernels complex chains and probes (Xeon 8370C) | a pre-registered fit like `prereg-chain.md` |

## Toward both recorded references

MATLAB's result depends on the MKL branch, so one arithmetic cannot equal both hosts'
recordings. The harness shows how a second reference could run in the engine. Here,
reference means which recorded host's MKL arithmetic the engine reproduces. These are the
measured options for that decision; it belongs to the maintainers, and nothing below is
implemented:

1. Keep the AMD arithmetic only (today): AMD 157 of 168 maps and 17 runs exact. Intel 55
   maps and no run exact.
2. An explicit reference in the model, recorded in every output, with the AMD arithmetic as
   the default and an Intel option for real double data only. When it is not selected, the
   AMD results do not change. When it is selected, the Intel host gets 108 maps and 6 runs
   exact. Raw values gain 605 + 23 and lose 4, and GIfTI values gain 69. The 4 losses are
   the coincidences above, in the unimplemented complex route. The Intel CSS pipelines' real
   fits become exact. Single runs and complex vertices stay as today, and the correctly
   rounded norm still has its two known near-tie misses. The cost is about 21% more time
   and a larger module.
3. As 2, but only once single and complex Intel kernels are identified. That needs new
   recordings (fingerprints of Intel `sgemv` with `trans`, `sdot` and `zdotc`) and
   pre-registered fits of the single and complex least squares from the existing Xeon 8370C
   fingerprints.

Choosing the reference by CPU is not one of these options, because it does not select a
recorded MATLAB reference. Option 2 would move the kernels from this crate into the core as
a runtime value threaded through the job, not a global and not a Cargo feature. It would
carry the AMD gates under the default, run this crate's gates and the harness's matrix
outcome under the Intel option, and need a changeset, a release and a canonical module.

## Reproducing

`PINS` holds the pinned recordings, each extracted by
`packages/samsrf/validation/container/download.py` into a folder named after its
reference (`numerics`, `numerics2`, `arithmetic-order`, `qr-reference`, `qr-kernels`,
`cgg`, `revcor-reference`).

```sh
python3 -I dnrm2_candidates.py "$PINS" discovery.json        # equals discovery-1.json
python3 -I dnrm2_family2.py "$PINS" family2.json             # equals family2-1.json
python3 -I chain_steps.py "$PINS" ubuntu-22.04-3 steps.json --grid
python3 -I fprev_tree.py "$PINS/qr-kernels/ubuntu-22.04-3" ormqr double 0 8 0 21,33,65
SAMSRF_HELDOUT_DUMP="$TMPDIR/heldout-inputs" SAMSRF_CGG_DIR="$PINS/cgg" SAMSRF_CGG_RUNS_DIR="$X001_RUNS" \
  SAMSRF_REVCOR_REFERENCE_DIR="$PINS/revcor-reference" \
  cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-mkl-avx512 --test recordings write_held_out_inputs
python3 -I heldout_eval.py "$PINS" "$TMPDIR/heldout-inputs" heldout.json   # equals heldout-1.json
```

`X001_RUNS` holds `lh_uBars1.gii` and `lh_uBars2.gii`
(`packages/samsrf/validation/matlab/fetch_x001_runs.py`). The native workflow runs the Rust
gates on every recording above.

The departure measurements write `harness/divergence-1/` with these fixtures (`cli-courses`
is `extract_cli_courses.py`'s output for the `cli` recording); the harness has its own
[commands](harness/README.md#reproducing):

```sh
SAMSRF_CLI_REFERENCE_DIR="$PINS/cli" SAMSRF_CLI_COURSES_DIR="$PINS/cli-courses" \
  SAMSRF_SINGLE_KERNELS_DIR="$PINS/single-kernels" SAMSRF_QR_KERNELS_DIR="$PINS/qr-kernels" \
  SAMSRF_QR_REFERENCE_DIR="$PINS/qr-reference" SAMSRF_MATLAB_NUMERICS_DIR="$PINS/numerics" \
  SAMSRF_MATLAB_NUMERICS2_DIR="$PINS/numerics2" SAMSRF_DIVERGENCE_REPORT_DIR="$TMPDIR/divergence" \
  cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-mkl-avx512 --test divergence
```
