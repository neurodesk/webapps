//! MATLAB R2023b's real double least squares as MKL 2021.3 ran it on its AVX512_E1 branch
//! on the recorded Intel Xeon hosts (8370C, 8573C, 6975P-C): `[a b] \ Y` (`?geqp3`,
//! `?ormqr`, `?trsv`/`?trsm`), `detrend`'s fit and `samsrf_removenoise`; and, in [`blas`]
//! (research, branch t3/samsrf-intel-cf), MATLAB's real double `x' * y`, `y' * A`, `corr`
//! and CF profile on that branch.
//!
//! The shipped port (`samsrf_core::lstsq`) follows MKL's CNR `auto` branch on AMD hosts.
//! MATLAB on those Intel hosts rounds the same solves differently, so one output cannot
//! equal both hosts' recordings. This crate is a separate, test-only reference for the
//! Intel recordings. Nothing ships it (no shipped crate depends on it and a WebAssembly
//! build refuses it), and it corrects nothing in the shipped module: that module still
//! loses the Intel exact values listed in packages/samsrf/validation/matlab/README.md
//! ("Double global regression"). Choosing an arithmetic for users is a separate decision.
//!
//! Fitted on the pinned Intel Xeon 8370C kernel recording (run 43127453138): every step of
//! its 95 real double two-column chains and Q'Y and coefficients of its 190 eight-column
//! solves. The frozen model then reproduced the constants-gamma-gemv direct `detrend` cases
//! and the double `samsrf_removenoise` revcor cases, but both had been read before the
//! freeze, so they corroborate it by replay, not as blind holdouts. See
//! packages/samsrf/validation/matlab/intel-avx512/README.md.
//!
//! Established only for what was recorded: finite real two-column designs with 2, 3, 16,
//! 37, 250 or 1,500 rows, solved for 1-3, 5-12, 21, 76 or 96 right-hand sides or for every
//! vertex of a whole-hemisphere run, including the recorded rank-1 designs and the
//! `xLARFG` rescale of subnormal reflectors. Not established by any recording: more than
//! two columns (norm downdating and later pivots), reflectors that end in zeros (`xLARF`'s
//! trim), the `xLARFG` halving path, exact and near rounding ties of the norm (see `nrm2`),
//! nonfinite inputs, single and complex designs, and every other MKL kernel. Changing those
//! paths leaves every gate passing (mutation review, 2026-11-18).

use samsrf_core::timeseries::TimeSeries;
use samsrf_core::{Error, Result};
use num_bigint::BigUint;

pub mod blas;

#[cfg(target_arch = "wasm32")]
compile_error!("samsrf-mkl-avx512 must never be built for WebAssembly");

/// `xLARFG`'s rescaling threshold, `safmin / (eps / 2)` as LAPACK computes it.
const RESCALE: f64 = f64::MIN_POSITIVE / (f64::EPSILON * 0.5);

/// The correctly rounded Euclidean norm (round to nearest, ties to even) of the exact sum
/// of squares; NaN if any value is NaN, infinity if any is infinite. This is a candidate for
/// MKL's `dnrm2` on the AVX512_E1 branch, not an identification of it: it equals the Intel
/// norms evaluated by the gates except two, where the exact norm lies 6.4e-5 and 2.6e-4 ULP
/// above a rounding midpoint and MATLAB's result is one ULP lower (both pinned in the gates:
/// `recordings.rs` and `blas_recordings.rs`). MKL's rounding that
/// close to a tie is not known.
pub fn nrm2(values: &[f64]) -> f64 {
    if values.iter().any(|v| v.is_nan()) {
        return f64::NAN;
    }
    if values.iter().any(|v| v.is_infinite()) {
        return f64::INFINITY;
    }
    // Every finite double is m * 2^k (integer m < 2^53, k >= -1074), so the sum of squares
    // is an integer n times 2^-2148 and the norm is sqrt(n) * 2^-1074.
    let mut n = BigUint::default();
    for &value in values.iter().filter(|v| **v != 0.0) {
        let bits = value.abs().to_bits();
        let (exponent, fraction) = ((bits >> 52) as i64, bits & ((1 << 52) - 1));
        let (m, k) = if exponent == 0 { (fraction, -1074) } else { (fraction | (1 << 52), exponent - 1075) };
        n += (BigUint::from(m) * BigUint::from(m)) << ((2 * k + 2148) as usize);
    }
    if n.bits() == 0 {
        return 0.0;
    }
    // r = floor(sqrt(n 4^t)) with at least 55 bits, so the kept bits, a guard bit and a
    // sticky bit are all in r.
    let t = (56 - (n.bits() as i64) / 2).max(0);
    let scaled = n << (2 * t as usize);
    let r = scaled.sqrt();
    let exact = &r * &r == scaled;
    let length = r.bits() as i64;
    // The norm is in [2^e, 2^(e+1)) with e = length - 1 - t - 1074; its last kept place is
    // 2^(e - 52), or 2^-1074 for subnormal results.
    let e = length - 1 - t - 1074;
    let unit = (e - 52).max(-1074);
    let dropped = (unit + t + 1074) as u64;
    let mut mantissa: u64 = (&r >> dropped).try_into().expect("at most 54 kept bits");
    let guard = r.bit(dropped - 1);
    let below = r.trailing_zeros().is_none_or(|zeros| zeros < dropped - 1);
    if guard && (below || !exact || mantissa & 1 == 1) {
        mantissa += 1;
    }
    libm::ldexp(mantissa as f64, unit as i32)
}

/// `xLAPY2`.
fn lapy2(x: f64, y: f64) -> f64 {
    let (x, y) = (x.abs(), y.abs());
    let (w, z) = if x >= y { (x, y) } else { (y, x) };
    if z == 0.0 {
        w
    } else {
        let q = z / w;
        w * (1.0 + q * q).sqrt()
    }
}

/// `xLARFG` with this branch's `dnrm2`: overwrites `x` with `v(2:end)` and returns
/// `(beta, tau)`.
fn larfg(alpha: f64, x: &mut [f64]) -> (f64, f64) {
    let xnorm = nrm2(x);
    if xnorm == 0.0 {
        return (alpha, 0.0);
    }
    let mut alpha = alpha;
    let mut beta = -lapy2(alpha, xnorm).copysign(alpha);
    let mut rescaled = 0;
    if beta.abs() < RESCALE {
        loop {
            rescaled += 1;
            for value in x.iter_mut() {
                *value *= 1.0 / RESCALE;
            }
            beta *= 1.0 / RESCALE;
            alpha *= 1.0 / RESCALE;
            if beta.abs() >= RESCALE || rescaled >= 20 {
                break;
            }
        }
        beta = -lapy2(alpha, nrm2(x)).copysign(alpha);
    }
    // Halving keeps beta - alpha finite near the largest double and changes no rounding.
    let half = if (beta - alpha).is_finite() { 1.0 } else { 0.5 };
    let (beta_h, alpha_h) = (beta * half, alpha * half);
    let tau = (beta_h - alpha_h) / beta_h;
    let factor = half / (alpha_h - beta_h);
    for value in x.iter_mut() {
        *value *= factor;
    }
    for _ in 0..rescaled {
        beta *= RESCALE;
    }
    (beta, tau)
}

/// One term of `w = v^T c`: `c(1)` itself, or a product `v(i) c(i)`.
#[derive(Clone, Copy)]
pub(crate) enum Term {
    Exact(f64),
    Product(f64, f64),
}

/// Adds a term to a lane: products are fused into the running sum.
pub(crate) fn accumulate(lane: Option<f64>, term: Term) -> f64 {
    match (lane, term) {
        (None, Term::Exact(value)) => value,
        (None, Term::Product(a, b)) => a * b,
        (Some(sum), Term::Exact(value)) => sum + value,
        (Some(sum), Term::Product(a, b)) => a.mul_add(b, sum),
    }
}

/// Folds `lanes` pairwise in `strides` order: lane k takes lane k + stride when k / stride
/// is even and neither lane was taken before.
pub(crate) fn fold(lanes: &mut [Option<f64>], strides: &[usize]) -> Option<f64> {
    let mut taken = vec![false; lanes.len()];
    for &stride in strides {
        for k in 0..lanes.len() {
            if (k / stride) % 2 == 0 && k + stride < lanes.len() && !taken[k] && !taken[k + stride] {
                lanes[k] = match (lanes[k], lanes[k + stride]) {
                    (Some(left), Some(right)) => Some(left + right),
                    (None, right) => right,
                    (left, None) => left,
                };
                taken[k + stride] = true;
            }
        }
    }
    lanes[0]
}

/// Sixteen lanes: whole blocks of 16 terms round-robin, the rest in chunks of 8, 4, 2 and 1
/// from lane 0, then folds with strides 8, 4, 1, 2 (`?gemv` and single-column `?ormqr`).
pub(crate) fn sixteen_lanes(terms: &[Term]) -> Option<f64> {
    let mut lanes = [None; 16];
    let blocked = terms.len() / 16 * 16;
    for (i, &term) in terms[..blocked].iter().enumerate() {
        lanes[i % 16] = Some(accumulate(lanes[i % 16], term));
    }
    let mut rest = &terms[blocked..];
    let mut chunk = 8;
    while !rest.is_empty() && chunk >= 1 {
        if rest.len() >= chunk {
            for (k, &term) in rest[..chunk].iter().enumerate() {
                lanes[k] = Some(accumulate(lanes[k], term));
            }
            rest = &rest[chunk..];
        }
        chunk /= 2;
    }
    fold(&mut lanes, &[8, 4, 1, 2])
}

fn products<'a>(v: &'a [f64], c: &'a [f64]) -> impl Iterator<Item = Term> + 'a {
    v.iter().zip(&c[1..]).map(|(&v, &c)| Term::Product(v, c))
}

/// `?gemv` inside `?geqp3`: `c(1)` is the first of the terms.
fn column_dot(v: &[f64], c: &[f64]) -> f64 {
    let terms: Vec<Term> = std::iter::once(Term::Exact(c[0])).chain(products(v, c)).collect();
    sixteen_lanes(&terms).expect("c(1) is always a term")
}

/// `?ormqr` for a column outside the groups of four: the products, then `c(1)`.
fn single_dot(v: &[f64], c: &[f64]) -> f64 {
    let terms: Vec<Term> = products(v, c).collect();
    sixteen_lanes(&terms).map_or(c[0], |sum| c[0] + sum)
}

/// `?ormqr` for a column inside a group of four: chunks of 16 products, lane k pairing
/// product k with product k + 8 as `fma(v_k, c_k, v_{k+8} c_{k+8})` and adding the pair to
/// its running sum; the rest fused in chunks of 8, 4, 2 and 1 from lane 0; 8 lanes folded
/// with strides 4, 1, 2; `c(1)` last.
fn grouped_dot(v: &[f64], c: &[f64]) -> f64 {
    let terms: Vec<(f64, f64)> = v.iter().zip(&c[1..]).map(|(&v, &c)| (v, c)).collect();
    grouped_sum(&terms).map_or(c[0], |sum| c[0] + sum)
}

/// The lanes of the grouped tree over `terms` (products `a b`), without `c(1)`; `None` when
/// there are no terms. Shared by `?ormqr` and MATLAB's `y' * A` (`blas::gemv_t`).
pub(crate) fn grouped_sum(terms: &[(f64, f64)]) -> Option<f64> {
    let mut lanes = [None; 8];
    let (chunks, rest) = terms.as_chunks::<16>();
    for chunk in chunks {
        for lane in 0..8 {
            let ((va, ca), (vb, cb)) = (chunk[lane], chunk[lane + 8]);
            let pair = va.mul_add(ca, vb * cb);
            lanes[lane] = Some(lanes[lane].map_or(pair, |sum: f64| sum + pair));
        }
    }
    let mut rest = rest;
    let mut chunk = 8;
    while !rest.is_empty() && chunk >= 1 {
        if rest.len() >= chunk {
            for (k, &(a, b)) in rest[..chunk].iter().enumerate() {
                lanes[k] = Some(accumulate(lanes[k], Term::Product(a, b)));
            }
            rest = &rest[chunk..];
        }
        chunk /= 2;
    }
    fold(&mut lanes, &[4, 1, 2])
}

/// `xLARF` from the left, `c -= v (tau (v^T c))` with `v(1) = 1`, as `?geqp3` updates the
/// next column: `v` ends at its last nonzero entry, updates fused, `c(1) - fl(tau w)`.
fn update_column(v: &[f64], tau: f64, c: &mut [f64]) {
    let last = v.iter().rposition(|&value| value != 0.0).map_or(0, |i| i + 1);
    let v = &v[..last];
    let t = tau * column_dot(v, c);
    c[0] -= t;
    for (vi, ci) in v.iter().zip(&mut c[1..]) {
        *ci = (-vi).mul_add(t, *ci);
    }
}

/// `?ormqr` applying one reflector to right-hand side `index` of `count`: groups of four
/// columns use the grouped tree, the others the single-column tree; updates fused,
/// `c(1)` as `fma(-tau, w, c(1))`.
fn apply_to_rhs(v: &[f64], tau: f64, c: &mut [f64], count: usize, index: usize) {
    let w = if index < count / 4 * 4 { grouped_dot(v, c) } else { single_dot(v, c) };
    let t = tau * w;
    c[0] = (-tau).mul_add(w, c[0]);
    for (vi, ci) in v.iter().zip(&mut c[1..]) {
        *ci = (-vi).mul_add(t, *ci);
    }
}

/// A real double design factored by `?geqp3` on this branch.
pub struct Design {
    /// Packed columns in pivoted order: R on and above the diagonal, reflectors below.
    packed: Vec<Vec<f64>>,
    taus: Vec<f64>,
    pivot: Vec<usize>,
    rank: usize,
}

impl Design {
    /// The columns must be finite and of equal length.
    pub fn new(columns: &[&[f64]]) -> Self {
        let rows = columns.first().map_or(0, |column| column.len());
        assert!(columns.iter().all(|column| column.len() == rows), "design columns differ in length");
        assert!(columns.iter().all(|column| column.iter().all(|value| value.is_finite())), "the design must be finite");
        let mut a: Vec<Vec<f64>> = columns.iter().map(|column| column.to_vec()).collect();
        let n = a.len();
        let steps = rows.min(n);
        let mut pivot: Vec<usize> = (0..n).collect();
        let mut norms: Vec<f64> = a.iter().map(|column| nrm2(column)).collect();
        let mut original = norms.clone();
        let threshold = f64::EPSILON.sqrt();
        let mut taus = Vec::with_capacity(steps);
        for i in 0..steps {
            let mut best = i;
            for j in i + 1..n {
                if norms[j] > norms[best] {
                    best = j;
                }
            }
            a.swap(i, best);
            pivot.swap(i, best);
            norms.swap(i, best);
            original.swap(i, best);
            let (beta, tau) = larfg(a[i][i], &mut a[i][i + 1..]);
            a[i][i] = beta;
            taus.push(tau);
            let (done, rest) = a.split_at_mut(i + 1);
            for column in rest {
                update_column(&done[i][i + 1..], tau, &mut column[i..]);
            }
            for j in i + 1..n {
                if norms[j] != 0.0 {
                    let ratio = a[j][i].abs() / norms[j];
                    let temp = (1.0 - ratio * ratio).max(0.0);
                    let quotient = norms[j] / original[j];
                    if temp * quotient * quotient <= threshold {
                        norms[j] = nrm2(&a[j][i + 1..]);
                        original[j] = norms[j];
                    } else {
                        norms[j] *= temp.sqrt();
                    }
                }
            }
        }
        let tolerance = rows.max(n) as f64 * f64::EPSILON * a.first().map_or(0.0, |column| column[0].abs());
        let rank = (0..steps).take_while(|&i| a[i][i].abs() > tolerance).count();
        Design { packed: a, taus, pivot, rank }
    }

    /// The packed factorisation, one column per pivoted design column.
    pub fn packed(&self) -> &[Vec<f64>] {
        &self.packed
    }

    pub fn taus(&self) -> &[f64] {
        &self.taus
    }

    /// The design column in each pivoted position.
    pub fn pivot(&self) -> &[usize] {
        &self.pivot
    }

    pub fn rank(&self) -> usize {
        self.rank
    }

    /// `Q' y` for right-hand side `index` of `count`, then the coefficients in column order:
    /// back-substitution `fma(-r, x, b)`, then division for one right-hand side (`?trsv`) or
    /// the reciprocal's product for several (`?trsm`).
    pub fn solve_with_qty(&self, y: &[f64], count: usize, index: usize) -> (Vec<f64>, Vec<f64>) {
        assert_eq!(y.len(), self.packed.first().map_or(0, Vec::len), "design columns and observations differ in length");
        assert!(index < count, "right-hand side {index} of {count}");
        let mut b = y.to_vec();
        for (i, &tau) in self.taus.iter().enumerate() {
            apply_to_rhs(&self.packed[i][i + 1..], tau, &mut b[i..], count, index);
        }
        let n = self.packed.len();
        let mut x = vec![0.0; n];
        for i in (0..self.rank).rev() {
            let mut sum = b[i];
            for (column, &xj) in self.packed[i + 1..self.rank].iter().zip(&x[i + 1..self.rank]) {
                sum = (-column[i]).mul_add(xj, sum);
            }
            let diagonal = self.packed[i][i];
            let reciprocal = 1.0 / diagonal;
            x[i] = if count > 1 && reciprocal.is_finite() { sum * reciprocal } else { sum / diagonal };
        }
        let mut coefficients = vec![0.0; n];
        for (k, &column) in self.pivot.iter().enumerate() {
            coefficients[column] = x[k];
        }
        (coefficients, b)
    }

    /// The coefficients of right-hand side `index` of `count`.
    pub fn solve(&self, y: &[f64], count: usize, index: usize) -> Vec<f64> {
        self.solve_with_qty(y, count, index).0
    }
}

/// MATLAB `detrend` of a run's courses on this branch: `x - a*(a\x)` with
/// `a = [linspace(0, 1, n)' ones(n, 1)]` solved for every course at once, the fit added
/// as two rounded products (as `samsrf_core::preprocess::Detrender`).
pub struct Detrender {
    design: Design,
    time: Vec<f64>,
    count: usize,
}

impl Detrender {
    /// The fit for runs of `volumes >= 2` samples with `count` courses.
    pub fn new(volumes: usize, count: usize) -> Self {
        let last = (volumes - 1) as f64;
        let time: Vec<f64> = (0..volumes).map(|i| i as f64 / last).collect();
        let ones = vec![1.0; volumes];
        Detrender { design: Design::new(&[&time, &ones]), time, count }
    }

    /// Detrends course `index` in place; a course with a nonfinite value becomes NaN.
    pub fn apply(&self, course: &mut [f64], index: usize) {
        if course.iter().any(|value| !value.is_finite()) {
            course.fill(f64::NAN);
            return;
        }
        let coefficients = self.design.solve(course, self.count, index);
        let (slope, intercept) = (coefficients[0], coefficients[1]);
        for (value, &t) in course.iter_mut().zip(&self.time) {
            *value -= t * slope + intercept;
        }
    }
}

/// `samsrf_removenoise(Srf, X, mver, true)` with one double covariate on this branch, as
/// `samsrf_core::preprocess::remove_noise_in` does it on the AMD branch: z-score, `[X ones] \ Y` over
/// every course at once, `Y - X B` with each row's products rounded and added in column
/// order. Courses with a NaN keep their place as zeros and come back zero; courses with
/// another nonfinite value come back NaN.
pub fn remove_noise(data: &mut TimeSeries, covariate: &[f64]) -> Result<()> {
    let volumes = data.volumes;
    if covariate.len() != volumes {
        return Err(Error::Shape(format!("{} covariate values for {volumes} volumes", covariate.len())));
    }
    if data.vertices == 0 || volumes == 0 {
        return Ok(());
    }
    let mut x = covariate.to_vec();
    samsrf_core::preprocess::zscore(&mut x);
    let ones = vec![1.0; volumes];
    // As `lstsq` does, a nonfinite design gives NaN coefficients for every course.
    let design = x.iter().all(|value| value.is_finite()).then(|| Design::new(&[&x, &ones]));
    let count = data.vertices;
    for vertex in 0..count {
        let course = data.course(vertex);
        let replacement = if course.iter().any(|value| value.is_nan()) {
            Some(0.0)
        } else if course.iter().any(|value| !value.is_finite()) {
            Some(f64::NAN)
        } else {
            None
        };
        if let Some(value) = replacement {
            data.course_mut(vertex).fill(value);
            continue;
        }
        let coefficients = design.as_ref().map_or(vec![f64::NAN; 2], |design| design.solve(course, count, vertex));
        for (value, &xt) in data.course_mut(vertex).iter_mut().zip(&x) {
            *value -= xt * coefficients[0] + coefficients[1];
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact check that `r` is a nearest double to the norm: the sum of squares lies
    /// between the squares of the midpoints to `r`'s neighbours, in integers.
    fn correctly_rounded(values: &[f64], r: f64) -> bool {
        let scaled = |value: f64| -> (u64, i64) {
            let bits = value.abs().to_bits();
            let (exponent, fraction) = ((bits >> 52) as i64, bits & ((1 << 52) - 1));
            if exponent == 0 { (fraction, -1074) } else { (fraction | (1 << 52), exponent - 1075) }
        };
        // Sum of squares as n * 2^-2148.
        let mut n = BigUint::default();
        for &value in values.iter().filter(|v| **v != 0.0) {
            let (m, k) = scaled(value);
            n += (BigUint::from(m) * BigUint::from(m)) << ((2 * k + 2148) as usize);
        }
        // r = M 2^u; its midpoints are (2M -+ 1) 2^(u-1), squared (2M -+ 1)^2 2^(2u - 2).
        let (m, u) = scaled(r);
        let (mut low, mut high) = (BigUint::from(2 * m - 1).pow(2), BigUint::from(2 * m + 1).pow(2));
        let shift = 2 * u - 2 + 2148;
        if shift >= 0 {
            low <<= shift as usize;
            high <<= shift as usize;
        } else {
            n <<= (-shift) as usize;
        }
        low <= n && n <= high
    }

    #[test]
    fn the_norm_is_correctly_rounded() {
        assert_eq!(nrm2(&[3.0, 4.0]), 5.0);
        assert_eq!(nrm2(&[]), 0.0);
        assert_eq!(nrm2(&[0.0, -0.0]), 0.0);
        assert_eq!(nrm2(&[-2.0]), 2.0);
        assert_eq!(nrm2(&[1.0, 1.0]), 2f64.sqrt());
        assert!(nrm2(&[1.0, f64::NAN, f64::INFINITY]).is_nan());
        assert_eq!(nrm2(&[1.0, f64::NEG_INFINITY]), f64::INFINITY);
        // Squares beyond the exponent range stay exact, and subnormal norms are rounded
        // on the subnormal grid.
        assert_eq!(nrm2(&[libm::ldexp(3.0, 900), libm::ldexp(4.0, 900)]), libm::ldexp(5.0, 900));
        assert_eq!(nrm2(&[libm::ldexp(3.0, -1074), libm::ldexp(4.0, -1074)]), libm::ldexp(5.0, -1074));
        assert_eq!(nrm2(&[f64::MAX, f64::MAX]), f64::INFINITY);
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            state
        };
        for case in 0..400 {
            let length = 1 + (next() % 300) as usize;
            let spread = [2, 30, 300][case % 3];
            let values: Vec<f64> = (0..length)
                .map(|_| {
                    let mantissa = (next() >> 11) as f64 / (1u64 << 53) as f64 - 0.5;
                    let exponent = (next() % (2 * spread + 1)) as i32 - spread as i32;
                    libm::ldexp(mantissa, exponent)
                })
                .collect();
            let r = nrm2(&values);
            assert!(correctly_rounded(&values, r), "case {case}: {r}");
        }
    }

    #[test]
    fn a_design_recovers_an_exact_line() {
        let t: Vec<f64> = (0..37).map(|i| i as f64).collect();
        let ones = vec![1.0; 37];
        let y: Vec<f64> = t.iter().map(|t| 2.0 * t - 3.0).collect();
        let design = Design::new(&[&t, &ones]);
        for (count, index) in [(1, 0), (5, 2), (8, 7)] {
            let coefficients = design.solve(&y, count, index);
            assert!((coefficients[0] - 2.0).abs() < 1e-14 && (coefficients[1] + 3.0).abs() < 1e-13, "{coefficients:?}");
        }
    }
}
