# Sparse conv: remaining gaps (predictions)

Written and committed before `record_conv_gaps.m` is first run on MATLAB. The
recording can confirm or reject what follows; it cannot change it. Any amendment is
appended with the run it follows. Background: the rule of
[`conv-boundary-predictions.md`](conv-boundary-predictions.md) (since 0.6.20261115,
`matlab_math::sparse_product_unfused`) was found on discovery courses and confirmed
on held-out ones, the final ones on two Intel hosts. Three questions remain, kept
apart in three files.

## A. Frozen confirmation on an AMD host (`conv-gaps-replay.json`)

The 12 held-out courses of `conv-blocks-reference.json` are regenerated with the
same generator, statement for statement (`rng(7307, 'twister')`), and recorded again.
Nothing is decided from them; they only confirm.

- **Prediction.** On each host every input array (kernel, nonzero positions, values)
  equals the pinned held-out arrays byte for byte, and so does every output array;
  the port reproduces every kept part.
- **Host receipt.** The confirmation counts as AMD only for a host whose `lscpu`
  model name starts with `AMD` and whose MKL branch is `auto`. An Intel host's replay
  is reported as another Intel replay, never as AMD.
- **Stop rule.** If neither host of the first dispatch is AMD, one more dispatch of
  the same recorder is made. If that has no AMD host either, the missing AMD
  confirmation is reported, and no further dispatch is made this round.

## B. Undecided parameters (`conv-gaps-boundary.json`)

The frozen rule chose two things no earlier course separated:

- **Threshold.** Boundaries exist when the full output f = n + T - 1 takes more
  than 16 KiB: complex f >= 1,025, real f >= 2,049. Competitors: complex f >= 1,023,
  1,024 or 1,026 (earlier recordings pin it to 1,023-1,026), real f >= 2,048.
- **Block length at exactly 8 blocks.** L: the block P doubles while f > 8P, so f =
  8P keeps P. Competitor S/A: f = 8P already doubles it (equivalently, the largest
  power of two P with 4P <= f). They differ only at f = 8P.

Inputs come from a Park-Miller stream. [`conv_gaps_design.py`](conv_gaps_design.py)
reproduces the inputs and the candidate models and printed the counts below
(`python3 conv_gaps_design.py`); `conv_gaps.rs` regenerates and checks every input. Before
the run, every candidate was evaluated on these exact inputs; the parts in which a
competitor's prediction differs from the frozen choice (complex M >= 1,025 and L;
real M >= 2,049 and L), over 12 draws and both parts:

| Course (section, kind, n, taps, full output) | Competitors that differ from the frozen choice, and in how many parts |
| --- | --- |
| threshold-decide complex n=990 T=33 f=1022 | none (all candidates agree) |
| threshold-decide complex n=991 T=33 f=1023 | M>=1023: 119, M>=1023 strict: 119 |
| threshold-decide complex n=992 T=33 f=1024 | M>=1023: 129, M>=1023 strict: 129, M>=1024: 129, M>=1024 strict: 129 |
| threshold-decide complex n=993 T=33 f=1025 | M>=1026: 82, M>=1026 strict: 82 |
| threshold-decide complex n=994 T=33 f=1026 | none (all candidates agree) |
| threshold-confirm complex n=1006 T=17 f=1022 | none (all candidates agree) |
| threshold-confirm complex n=1007 T=17 f=1023 | M>=1023: 118, M>=1023 strict: 118 |
| threshold-confirm complex n=1008 T=17 f=1024 | M>=1023: 90, M>=1023 strict: 90, M>=1024: 90, M>=1024 strict: 90 |
| threshold-confirm complex n=1009 T=17 f=1025 | M>=1026: 164, M>=1026 strict: 164 |
| threshold-confirm complex n=1010 T=17 f=1026 | none (all candidates agree) |
| threshold-real real n=2016 T=33 f=2048 | M>=2048: 59, M>=2048 strict: 59 |
| threshold-real real n=2017 T=33 f=2049 | none (all candidates agree) |
| blocks-decide complex n=4063 T=33 f=4095 | none (all candidates agree) |
| blocks-decide complex n=4064 T=33 f=4096 | M>=1023 strict: 434, M>=1024 strict: 434, M>=1025 strict: 434, M>=1026 strict: 434 |
| blocks-decide complex n=4065 T=33 f=4097 | none (all candidates agree) |
| blocks-confirm complex n=4031 T=65 f=4095 | none (all candidates agree) |
| blocks-confirm complex n=4032 T=65 f=4096 | M>=1023 strict: 411, M>=1024 strict: 411, M>=1025 strict: 411, M>=1026 strict: 411 |
| blocks-confirm complex n=4033 T=65 f=4097 | none (all candidates agree) |
| blocks-confirm real n=8159 T=33 f=8191 | none (all candidates agree) |
| blocks-confirm real n=8160 T=33 f=8192 | M>=2048 strict: 251, M>=2049 strict: 251 |
| blocks-confirm real n=8161 T=33 f=8193 | none (all candidates agree) |
| control complex n=2048 T=33 f=2080 | none (all candidates agree) |
| control real n=4096 T=17 f=4112 | none (all candidates agree) |

("strict" is S/A; without it, L.) So the f = 1,023, 1,024 and 1,025 courses each
separate the frozen threshold from the competitors below or above it, the f = 4,096
complex and 8,192 real courses separate L from S/A, and the courses either side of
them, the bracketing f = 1,022 and 1,026 and the two controls are predicted the same
by every candidate.

- **Prediction.** The frozen choices hold: every kept part of every course equals the
  port.
- **Decision.** The threshold-decide (33 taps) and blocks-decide (complex 33 taps)
  courses decide the two parameters; threshold-confirm (17 taps), threshold-real and
  blocks-confirm (complex 65 taps, real 33 taps) must then agree with the decision.
  If the decided values are the frozen ones and every course matches, nothing
  changes. If the decide courses choose another value and every confirm course
  agrees with it, production adopts that value. If the decide and confirm courses
  disagree, no value is adopted, production is unchanged and the disagreement is
  reported.

## C. Kernels of fewer than 9 taps: held-out (`conv-gaps-short.json`)

Recorded as discovery in `conv-blocks-reference.json` (3, 5 and 8 taps; complex 1,100
and real 2,100 samples): on long sparse courses every product after the first was
rounded and then added, in input order. Frozen as **R-short**: for a course with fewer
than a quarter of its samples nonzero and a kernel of 2-8 taps shorter than the
course, the output is the sum over the window's nonzero samples in input order, each
product rounded and then added.

Competitors: **R-tap**, the same unfused products in kernel order (the order the
port's short-kernel path uses); and **R-port**, the port's path as it is (kernel order,
fused when the course has more than 16 samples).

Held-out courses, all new tap counts, lengths and seeds: complex 1,300 samples with 2,
4, 6 and 7 taps; real 2,500 samples with 2, 4, 6 and 7 taps; and courses of the size
SamSrf predictions have: complex 300 samples with 6 taps, real 250 with 7, real 400
with 5, real 40 with 4. Dense controls (60% nonzero): complex 1,100 samples with 4 taps
and real 900 with 7, predicted to follow R-port. Evaluated before the run on these
inputs, R-short differs from R-port in 16-3,766 parts per sparse course and from R-tap
in 74-1,393 (none for 2 taps, where the two orders are one addition; for the 40-sample
course they agree too).

- **Decision.** Production follows R-short for sparse courses of 2-8 taps only if it
  reproduces every kept part of every sparse held-out course, and the dense controls
  follow R-port. Otherwise the short-kernel path is unchanged and the result is
  reported.

## Common rules

- Each host records twice in fresh MATLAB processes; the repeats must be identical.
  CPU model names and MKL branches are recorded as GitHub assigns them; cross-host
  agreement is reported per file, not assumed.
- Expected inventories: 12 replay courses, 23 boundary courses, 14 short courses, 12
  draws each, every output of `conv` (n + T - 1 per draw, real and imaginary).
- At most two dispatches this round. Every production change, if any, needs all
  existing numerical, CSS, QR, forward/fitted-HRF, reverse-correlation and browser
  gates to stay as they are.
