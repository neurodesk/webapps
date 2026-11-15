# Sparse complex conv boundaries: predictions

Written and committed before `record_conv_boundary.m` was first run on MATLAB.
The recording can confirm or reject what follows; it cannot change it. A later
amendment is appended with the run it follows, and is committed before the next
recording or before the held-out data is opened.

## What is already known (all of it is now discovery data)

From the arithmetic-order pin (run 43564031333, `arithmetic_order.rs`), MATLAB
R2023b's `conv(y, kernel)` of a sparse complex course `y` (fewer than a quarter
nonzero) with a real kernel of T taps adds `y(i) * kernel(k - i)` over the
window in index order. Each product is fused into the running sum, except for
some products near multiples B of 512, which are rounded and then added. On the
16 courses of that pin (17, 33 and 65 taps; 1,000-2,600 samples; 750,312 kept
output parts) one rule, here called R-G, reproduces every part. A product of input
i to output k is unfused when:

- **before B:** B - 16 <= k < B and i >= B - 16; or
- **after B:** k >= B, with B the largest multiple of 512 not above k, and
  B - (T - 1) <= i < B - (T - 1) + 16.

R-G was found after the 17- and 65-tap courses had been seen, so they are not
held out any more. It also fails the numerics2 pin, which the port matches
today: 1, 7 and 6 parts of the 33-tap sparse complex courses of 500, 600 and 800
samples. At 500 samples R-G applies the before-B part with B = 512 beyond the
course; at 600 and 800 samples MATLAB shows no boundary at 512 at all. No pinned
course lies between 801 and 999 samples. The real sparse courses of the
numerics pins (up to 2,000 samples) match the port; there is no boundary there.

## Competing rules

Each rule below is R-G with one choice per open question:

- **Q1, when boundaries exist.**
  - L-n: when the course has at least N samples, for one N in 801-1000;
  - L-full: when the full output, n + T - 1, has at least M samples, for one M
    in 801-1032 (the 1,000-sample, 33-tap courses have 1,032);
  - L-other: neither form fits the discovery courses; no rule is adopted.
- **Q2, the before-B part at a course end.** E-in: it applies only for B <= n
  (the 1,536- and 2,048-sample courses already show it at B = n); E-all: also
  for B > n.
- **Q3, the after-B window for kernels shorter than 17 taps.** W-free: inputs in
  [B - (T - 1), B - (T - 1) + 16), which reaches past B when T < 17; W-clip: the
  same window cut at B.
- **Q4, the before-B width for short kernels.** 16 for every T, or min(16, T - 1).
- **Q5, the period.** 512 at every boundary, through 4,096 samples; or
  otherwise.
- **Real courses** (control): no boundary, as in the numerics pins; or R-G
  applies to them too.
- **Dense complex courses** (control, 60% nonzero, where the port uses its dense
  path): recorded and reported only. No rule for them is tested or adopted here.

## Design

`record_conv_boundary.m` generates sparse courses (24% nonzero positions, fixed
per course) with positive decaying kernels, and records 12 draws of random
values per course on those positions, with every output of `conv`. Every
discriminating question is answered by the fusion of individual products, and
12 draws make each output's fusion mask unique in practice: the arithmetic-order
pin's 25-draw courses gave unique masks, and its 9-draw courses mostly did.

- **Discovery** (`conv-boundary-discovery.json`, `d_` arrays, 32 courses):
  - Q1: lengths 820, 850, 880, 900, 925, 950, 970, 980, 990, 995, 1,000 and
    1,010, each with 17 and 33 taps. L-n and L-full give different predictions
    for some of these courses: at 995 samples, 33 taps give a full output of
    1,027 and 17 taps 1,011;
  - Q3, Q4: 1,100 samples with 9, 11, 12 and 15 taps;
  - Q2: 1,020 and 1,530 samples with 33 taps, ending just below 1,024 and 1,536;
  - controls: a real sparse course (2,048 samples, 33 taps) and a dense complex
    course (1,100 samples, 33 taps).
- **Held out** (`conv-boundary-heldout.json`, `h_` arrays, 14 courses, other
  seeds): 13, 25, 21, 49, 41, 97, 129, 33, 10 and 16 taps; lengths 845, 915, 960,
  1,005, 1,015, 1,300, 1,536, 2,100, 2,600, 3,100, 4,096, 3,072, 2,560 and
  1,700. Boundaries up to 3,584, end effects at 1,536, 3,072 and 4,096, and
  lengths near the Q1 threshold with tap counts not in discovery.

## Decision criteria

1. From the discovery file alone, choose one answer to each of Q1-Q5. Q1's
   threshold is the one value that separates every discovery course with a
   boundary effect from every course without one; if the two forms of Q1 both fit,
   the held-out courses decide between them, and the choice is written down
   before they are opened. Commit the frozen rule and its evaluator.
2. Only then open the held-out file. The rule is adopted only if, on the
   reference host, it reproduces every kept output part of every held-out draw
   and course, the control courses behave as chosen, and it leaves every existing
   conv gate (numerics, numerics2, arithmetic-order, focused probes) and every CSS,
   QR and reverse-correlation gate unchanged.
3. Otherwise production is unchanged: the evaluator, the pin, and which
   held-out parts the frozen rule misses are published.

No per-course parameter is fitted. If the discovery file needs a second
dispatch to decide between rules (the budget allows one more this round), its
design is appended here and committed first.

## Hosts and repeats

Each host records twice in fresh MATLAB processes, and the workflow requires the
repeat to be identical. The CPUs and MKL branches that GitHub assigns are
recorded as they are. The conv arrays of the arithmetic-order pin were identical
on an AMD and an Intel host; cross-host agreement here is reported, not assumed.
