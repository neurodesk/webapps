# Constants, small-shape gampdf and double `y' * A` (predictions)

Written and committed before `record_constants_gamma_gemv.m` is first run on MATLAB.
The recording can confirm or reject what follows; it cannot change it. Any amendment
is appended with the run it follows. Every model's predicted values are hashed in
[`constants-gamma-gemv-predictions.json`](constants-gamma-gemv-predictions.json),
written by `exes/samsrf/core/tests/constants_gemv.rs` and `src/held_out_gamma.rs`
(`SAMSRF_CGG_PREDICT`, with `SAMSRF_CGG_RUNS_DIR` holding the pinned
`lh_uBars1.gii` and `lh_uBars2.gii` of `apps/samsrf/examples.json`) at the port of
#868's head `e1d0b5bbe`. At its earlier head `6cd748048` only the 15 one-sample
courses were predicted differently (left unchanged instead of 0). The recording's inputs are regenerated there and must equal
MATLAB's: the recorder hashes every edited single matrix, and writes the gampdf
inputs and the gemv probes.

## A. Constant and near-constant courses (`constants-direct.json`, `constants-pipeline.json`)

#868 replaced the normal-equation `detrend` with MATLAB's `x - a*(a\x)` over every
vertex of a run. For a constant non-zero raw course the port now keeps the QR
rounding residual, which `zscore` scales to unit variance, so the course is noise and
its noise ceiling a finite number. `main` returned zeros. No pinned recording holds
such a course: the X001 hemisphere has 134,260 vertices (`count mod 4 = 0`), 21,329
all-zero courses and no constant non-zero one, and the RC/CF edge cases edit courses
after preprocessing.

Inputs, all exact in single precision (`edited` in the recorder and the test): zero;
constants 3, 0.25, -7.5, 100, 852, 1234.5, 10000 and 4382 (a typical X001 raw
level); ramps `2(i-1) - 100` and `0.5(i-1) + 3`; near-constants with one sample
off by 1 (852/853) or by one single ULP (1000, 852); and a realistic near-constant,
`4382 + (x - 4382)/65536` in single arithmetic for the real course `x` of vertex
6,378 (0-based), which leaves a few distinct values.

- **Direct.** `detrend` and `zscore` of a run matrix (real courses of twelve
  low-variance vertices of run 1) with one edited column, at every position of
  matrices of 1, 2, 3, 5, 6, 7, 9, 10, 11 and 12 columns of 250 volumes, of 5 and 8
  columns of 3 and 37 volumes, of 1 and 5 columns of 2 volumes, and of the 1-volume
  scalar: 1,485 courses. The widths put the edited column at every grouped and
  leftover position of the right-hand-side kernels (`count mod 4` = 0-3).
- **Pipeline.** `samsrf_gii2srf(files, '', 1, true, true, '')` on runs 1 and 2,
  truncated to their first 134,260, 134,257, 134,258 and 134,259 vertices (the
  hemisphere and each leftover count), with every kind at four consecutive grouped
  positions (vertices 1,999-2,058, 0-based) and kinds in the last 4, 1, 2 and 3
  columns, in both precisions (`def_64bit`). Recorded: `Srf.Data` and
  `Srf.Noise_Ceiling` at the edited vertices and eight controls (two real courses,
  vertices 0-3 and two unedited neighbours), and `nanmean(Srf.Data, 2)` over all
  vertices.

Models: **M1**, the port at #868's head (production `RunAccumulator`, `Detrender`,
`zscore`); **M0**, `main`'s centred normal equations, naive mean, `std` and
`corr`; **M2**, M1 except that an exactly constant raw course becomes all zeros (and
its noise ceiling NaN). The models disagree in 1,321 (M0) and 733 (M2) of the 1,485
direct courses, and in each pipeline case M2 differs from M1 in 7,000-7,500 of
the course values and 28-30 noise ceilings; M0 differs more.

- **Prediction.** M1 reproduces every recorded direct and pipeline value on an AMD
  host (MKL CNR `auto`), in both precisions, including the global signal.
- **Decision.** If M1 matches every value on an AMD host, #868's constant-course
  behaviour is MATLAB's there and the pin becomes a gate. If M2 or M0 matches the
  constant courses and M1 does not, #868 is wrong for those courses: this is reported
  at once with the reproduction, and any fix is made in a separate branch for the
  parent. If no model matches, nothing changes and the stage that first differs is
  reported. The one-sample cases record what MATLAB's `detrend` does with a single
  sample; every model predicts 0.
- Intel hosts are reported, not gated: their MKL already solved double `\` in
  another order (`cli_preprocess.rs`).

## B. gampdf at shapes below 1 (`gamma.json`)

The candidate **G1** `exp(log a - log z) * exp(c - bd0(a, z)) / b`, with
`c = -(log(2 pi) + log(a))/2 - stirlerr(a)`, matched all 1,216 positive inputs at the
only recorded small shape (0.7, four scales) on both hosts. That is discovery only.
Held out: shapes 0.05, 0.2, 0.3, 0.5 (the `stirlerr` table), 0.55, 0.85, 0.9, 0.95
and 0.999 with scales 1, 0.75, 1.5 and 3; inputs `k/16` (k = 1-640), `2^-k`
(k = 1-60), the subnormals `2^-1074`, `3 * 2^-1074`, `2^-1022`, multiples of 8 to
800 (underflow), thirteen points `(a b)(64 + j)/64` (j = -6..6, the series branch of
`bd0`), and 0, -1 and Inf. Competitors: **G0**, the port's closed form with `lgamma`;
**G2**, Loader's `(a/z) * P / b`; **G3**, `exp((a-1) log z - z - gammaln a) / b`.
On these inputs G0, G2 and G3 differ from G1 in 687-795, 370-641 and 597-756 values
per case.

- **Decision.** Production adopts G1 for `a < 1` only if it reproduces every
  positive finite input of every held-out case on every host, and the edges keep
  their recorded values. One miss: no adoption, the closed form stays, the misses are
  reported.

## C. Double `y' * A` (`gemv.json`)

The double CF profile's `corr(Y, X)` is `y' * A`. On the pinned double CF profiles
the columns in full blocks of four follow two lanes started at element 0 with the
remainder in order (1,728/1,728, 304/304 held out); the remaining columns did not
follow any candidate (best 153/216). FPRev pair probes (column j holds `2^70` at
row i, `-2^70` at row k, ones elsewhere; y is ones) give each column's reduction
tree at shapes (n, m) = (250, 3/5/6/7/8), (61, 7), (128, 6), (97, 5) and (17, 3), with
100 random products per shape.

Frozen alternatives for the remaining columns (full blocks keep the two-lane model):
in order; 2, 4, 8 (folded to four) and 8 (in order) lanes; MKL `ddot` as the port
has it; `ddot_pairs`; the port's `ddot`; and every column by `ddot`. Their FPRev
counts are hashed per shape; only definitional twins coincide (`ddot` and `ddot_mkl`
from 51 elements, every remaining-column model when m = 8).

- **Prediction.** The full-block columns follow the two-lane model at every shape.
  No remaining-column alternative is predicted.
- **Decision.** The remaining-column order is read from the n = 250 fingerprints
  (discovery). A model is adopted for production only if it reproduces those trees,
  the trees at the other n (held out), every random product of the second half of
  the draws (the first half decides fused or separate multiply-add), and the 216
  remaining-column values of the pinned double CF profiles on the AMD host. Otherwise
  the CF profile stays as it is and the result is reported.

## Common rules

- Each host records twice in fresh MATLAB processes; the repeats must be identical.
  CPU model names and MKL branches are recorded as GitHub assigns them; agreement is
  reported per host. No AMD-only policy is adopted from this run.
- At most two dispatches this round: the first records everything; the second only
  if the first fails mechanically or gives no AMD host.
- A production change needs every existing numerical, CSS, QR, HRF, reverse
  correlation, preprocessing and browser gate to stay as it is.
