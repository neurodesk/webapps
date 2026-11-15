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

## Amendment after the discovery file of run 43678512524 (held-out file not opened)

Run [43678512524](https://github.com/neurodesk/webapps/actions/runs/43678512524)
(recorder commit `37d70dbba37733bb893b0f64a8fd78b86521bc0d`) recorded on an AMD
EPYC 9V74 (`ubuntu-22.04`, CNR `auto`) and an Intel Xeon 6975P-C
(`ubuntu-24.04`, `AVX512_E1`); each host's repeat was identical. Only
`conv-boundary-discovery.json` and its `d_` arrays have been read, on the AMD
host.

What the discovery file decides:

- **Q1: L-full, in bytes.** Courses whose full output n + T - 1 has at most 1,022
  complex elements show no boundary; courses with 1,026 or more do (995
  samples with 33 taps does, 1,000 with 17 does not, so L-n is rejected). The
  real sparse control (2,048 samples, 33 taps, full output 2,080) shows
  boundaries, but at 1,024 and 2,048 only, while the numerics2 real course of
  2,000 samples (full output 2,032) shows none. One statement fits both kinds:
  boundaries exist when the full output takes at least 16 KiB (1,024 complex or
  2,048 real elements), and B is a multiple of 8 KiB of output (512 complex or
  1,024 real elements). The complex threshold is pinned only to 1,023-1,026
  elements; 1,024 is the choice, and no held-out course separates the others.
- **Q2: E-all.** The before-B part applies also when B is past the course end
  (1,010, 1,020 and 1,530 samples need it).
- **Short kernels (new).** For 9-15 taps every product after the first is
  unfused, at every output, not only near B: the port's model misses 5,883 to
  8,999 parts of those courses and this one misses none. Q3 and Q4 are therefore
  moot for them.
- **Q5** is untested by discovery beyond 2,048 samples.

The frozen rule (`conv_boundary_rule`): for a sparse course (fewer than a quarter
nonzero) and a kernel of T >= 9 taps, with s the element size (16 bytes complex,
8 real), P = 8,192 / s and active = (n + T - 1) s >= 16,384, the product of input
i to output k is rounded and then added (not fused) when:

- T <= 16, and active (variant S-active) or always (variant S-always); or
- active, k mod P >= P - 16 and i >= B - 16 with B = (floor(k / P) + 1) P; or
- active, k >= P and B - (T - 1) <= i < B - (T - 1) + 16 with B = floor(k / P) P.

It reproduces every part of all 31 sparse discovery courses and of every sparse
course of the numerics, numerics2 and arithmetic-order pins with at least 9
taps; the port misses 47, 111 and 4,993 parts of those pins.

The held-out file decides S-active against S-always: its 845- and 960-sample
courses with 13 taps are below the threshold, where only S-always unfuses them.
Every other held-out course is predicted the same by both variants. Adoption
then follows the criteria above, with these limits fixed now:

- the held-out set has no real course, so the real part of the rule rests on one
  discovery course and the numerics pins. Production adopts it for real courses
  only after a second, pre-registered recording with held-out real courses;
- kernels of fewer than 9 taps and dense courses are outside the rule and stay
  as they are.

## Held-out results of run 43678512524, and the second recording (pre-registered)

The held-out file was opened after the commit above. Both hosts give the same
counts. S-always is chosen: the 845- and 960-sample 13-tap courses, below the
threshold, are unfused at every product (6,207 and 7,216 parts S-active misses).
With S-always the frozen rule reproduces every kept part of 13 of the 14 held-out
courses (10-97 taps, 915-3,100 samples, boundaries up to 3,072, ends at 1,536 and
3,072), where the port misses up to 15,219 parts per course. It misses 398 parts
of the 4,096-sample, 129-tap course (the port misses 563): all at outputs just
before 512, 1,536, 2,560 and 3,584, and three after 1,536. **The frozen rule is
therefore rejected, and production is not changed on this recording.**

Seen after that rejection (so it is discovery now): with a period of 1,024
elements instead of 512 the 129-tap course has no missed part. The block length
seems to grow with the kernel. The second and last recording of this round
(`record_conv_blocks.m`) tests that, under these rules:

- **Block law.** P(T) for complex courses is 512 for T up to some T*, in
  98-129, and 1,024 above it, doubling again past some later length; the
  candidates are P = the smallest power of two >= 512 with P > 4(T - 1) (L4) and
  with P >= 4T (L4+), which differ only at T - 1 = 128, and "another law" (L-x).
  For real courses: P_real = 2 P (8 KiB per block in both), or not.
- **Threshold.** Boundaries exist when the full output has at least 2P elements
  (16 KiB at P = 512 complex or 1,024 real), or not.
- **Kernels of fewer than 9 taps** (3, 5 and 8 taps, long sparse courses):
  recorded and reported only, because the port uses another path for them; no
  rule for them is tested or adopted.

Discovery (`conv-blocks-discovery.json`, `d2_` arrays, 12 draws):

- complex, 4,096 samples: every tap count from 120 to 131, and 65, 97, 105, 113,
  145, 193, 255, 256, 257 and 258;
- complex near the 2P threshold for 129 taps: 1,900, 1,920 and 2,000 samples
  (full outputs 2,028, 2,048 and 2,128);
- real, 4,096 samples: 17, 33, 65, 129 and 257 taps; and real near the threshold
  with 33 taps: 2,010, 2,016 and 2,040 samples (full outputs 2,042, 2,047 and
  2,072);
- 3, 5 and 8 taps, 1,100 samples complex and 2,100 real.

Held out (`conv-blocks-heldout.json`, `h2_` arrays, other seeds), opened only after
the law is frozen in a commit from discovery alone:

- complex: 100 taps, 3,000 samples; 140 taps, 5,000; 200 taps, 4,500; 300 taps,
  6,000; 129 taps, 2,600; 25 taps, 6,000; 13 taps, 900;
- real: 21 taps, 3,000; 49 taps, 4,100; 97 taps, 5,000; 140 taps, 6,000; 13 taps,
  1,500.

Decision: production adopts the rule, for complex and, separately, for real
courses, only if the law frozen from discovery reproduces every kept part of every
held-out course of that kind on the reference host, and every pin and gate stays as
it is. A kind that fails stays unchanged. No third recording is made this round.
