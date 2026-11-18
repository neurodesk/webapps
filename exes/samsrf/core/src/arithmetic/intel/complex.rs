//! Candidate for MKL AVX512_E1's mixed complex/real dot product. Selected from 272
//! lane/fusion/tail models on 24 previously seen raw vectors (not final maps), then
//! replayed on the identical inputs of another Intel host. This is not an identified
//! general complex BLAS implementation: no complex-complex products were recorded.

use num_complex::Complex64;

/// Candidate for `x' * y` with complex `x` and real `y`: four FMA lanes per component over
/// blocks of four, a pair into lanes 0/1, a last element into lane 0, then (0+1)+(2+3).
/// The function returns the usual conjugating `x' * y`; inputs here are not conjugated.
/// Recorded lengths are 1..20, 33, 64, 250 and 1000. Nonfinite/subnormal behavior and
/// alignment-dependent dispatch are unrecorded. Norms remain a separate candidate.
pub fn zdotc_real(x: &[Complex64], y: &[f64]) -> Complex64 {
    assert_eq!(x.len(), y.len(), "complex dot dimensions");
    let mut re = [0.0f64; 4];
    let mut im = [0.0f64; 4];
    let mut add = |lane: usize, i: usize| {
        re[lane] = x[i].re.mul_add(y[i], re[lane]);
        im[lane] = (-x[i].im).mul_add(y[i], im[lane]);
    };
    let blocked = x.len() / 4 * 4;
    for i in 0..blocked {
        add(i % 4, i);
    }
    let mut next = blocked;
    if x.len() - next >= 2 {
        add(0, next);
        add(1, next + 1);
        next += 2;
    }
    if next < x.len() {
        add(0, next);
    }
    Complex64::new((re[0] + re[1]) + (re[2] + re[3]), (im[0] + im[1]) + (im[2] + im[3]))
}
