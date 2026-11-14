# Arithmetic-order probes: predictions

Written and committed before `record_arithmetic_order.m` was first run on
MATLAB. The recording can confirm or reject what follows; it cannot change it.
Any later amendment is appended below with the run it follows, and is committed
before the next recording.

## What is already known

- **Real `x'*y` (#839).** For 2-24 elements MATLAB adds adjacent products in
  pairs from the end, then the pair sums in index order after the first product
  when the length is odd. Products and sums are rounded separately. This is
  recorded on two Intel and two AMD hosts. The earlier BLAS recording gives one
  product per length; it fits that tree at 1-20 and 33 elements. On the AMD host
  it fits the port's `ddot` (MKL's four two-lane registers over blocks of eight)
  at 64, 250 and 1,000 elements, and on the Intel host neither tree at 64 and
  250. The port uses `ddot` at every length.
- **Sparse complex `conv` (#730, #839).** In the 10 pinned sparse complex courses
  longer than 800 samples, 111 real or imaginary parts of 95 outputs differ from
  the port's sparse path by one ULP. All lie from 15 below to 14 above a
  multiple of 512. The port's sparse path adds `y(i) * kernel(k - i)` over the
  window's nonzero samples in index order, with each product fused into the sum.
  The ones-kernel fingerprints of #839 give index order for those patterns; they
  cannot see fusion or anything that depends on the weighted values.

## dot-order

Question: at which length does MATLAB's real `x'*y` leave the pair tree, and
what does it use after that?

Design: FPRev pair fingerprints (`x` ones, ±2^60 at two positions of `y`) for
every pair at every length 2-80, and 300 sampled pairs at the held-out lengths
96, 100, 127, 128, 129, 200, 250, 256 and 1,000. For every length, 50 random
products: draws 1-25 identify, draws 26-50 are held out. The held-out lengths
and draws are evaluated only with the rule fixed from the identification data
(fingerprints at 2-80 and draws 1-25).

- **H-switch.** There is one length T, 25 <= T <= 64, below which every length
  follows the pair tree and from which every length follows the port's `ddot`.
  Predicted on the AMD host. Below T both hosts agree.
- **H-pair.** The pair tree holds at every length up to 80. Predicted false,
  because the earlier AMD product at 64 elements fits `ddot` and not the tree.
- **H-other.** Some lengths in 25-80 follow a third tree, read from their
  fingerprints.
- **Fusion.** In both regimes, products and sums are rounded separately. A model
  with a fused product must fail some identification draws.
- **Intel.** Where MATLAB uses MKL, the Intel host's products may differ from the
  port's `ddot` (MKL's AVX-512 branch). That would be reported as a host
  difference. It does not change the AMD rule, and it is not declared out of
  scope.

Decision rule: a production change to `ddot` is made only if one rule
reproduces every fingerprint and identification draw on the AMD host, and then
every held-out draw and held-out length there. The change must also leave every
existing recorded gate unchanged (CSS pipelines and traces, QR, revcor, the BLAS
cases). Otherwise the lengths are documented and `ddot` is unchanged.

## corr

Question: does the port's double CSS objective, `1 - corr(x, y)^2` for a real
prediction, equal MATLAB's at 25-80, 96, 100, 128 and 250 elements?

- **H-corr.** With the rule adopted above (if any), every recorded `corr` value
  and objective equals the port's on the AMD host. With today's `ddot`, some
  lengths below T differ.

These cases are not used to identify the dot rule; they are a downstream check.

## conv-weighted

Question: which arithmetic does MATLAB use for the outputs near multiples of
512 in sparse complex courses?

Design: each of the 10 pinned courses is recorded as it is (draw 0), and with
24 sets of random complex values on exactly its nonzero positions and with its
own kernel (draws 1-16 identify, 17-24 are held out). Six generated courses are
held out entirely: 1,100, 1,536, 2,048 and 2,600 samples with 33 taps, and
1,600 samples with 17 and 65 taps. Every conv output is recorded, real and
imaginary parts separately.

- **C-control.** Outside 15 below to 14 above each multiple of 512, every output
  of every draw equals the port's sparse path.
- **C-consistent.** For each differing output, one model of its window reproduces
  every identification draw. A model is an order (index order, or the port's
  dense two-lane order) and a fusion mask (each product fused into the running
  sum, or rounded and then added). If no model fits, the arithmetic depends on
  the values or on something outside the window, and no rule is adopted.
- **Candidate rules,** each a statement about which products are unfused:
  - R-input: products whose input index lies in a given range relative to the
    nearest multiple B of 512;
  - R-output: all products of outputs in a given range relative to B;
  - R-tap: products with a given range of kernel positions;
  - R-part: the real and imaginary parts follow different rules;
  - R-dense: those outputs follow the dense path.
  The offline evaluations in #821 and #839 rejected R-input with "i >= B" and
  "i < B", R-output for every output in the window, and B-16..B input windows,
  on the original values alone. They are tested again here on all draws.
- **Adoption.** A rule is adopted only if it reproduces every identification
  draw of every course, then every held-out draw and every output of the six
  held-out courses, including the 17- and 65-tap ones. It must also leave every
  conv output of the numerics and numerics2 pins as it is. Otherwise the
  per-output models found are documented, and the port is unchanged.

## Hosts and repeats

Each host records twice in fresh MATLAB processes; the workflow requires the
repeat to be identical. Cross-host differences are reported for every section.
The runner's CPU is whatever GitHub assigns; the AMD host is the reference for
MKL-backed results, as for every other MKL gate.
