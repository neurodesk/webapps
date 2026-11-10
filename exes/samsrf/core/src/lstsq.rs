//! MATLAB's `A \ y` for tall designs, in the precision MATLAB computes it.
//!
//! A double design with single observations is solved in single arithmetic
//! (MATLAB converts the design to single first), so the factorisation runs in
//! `f32` or `f64` and its coefficients keep that class. The algorithm is
//! LAPACK's: column norms, column pivoting (`xGEQP3`/`xLAQP2`), Householder
//! reflectors (`xLARFG`) applied to the remaining columns and to `y`
//! (`xLARF`, `xORMQR`), MATLAB's rank decision and back substitution
//! (`xTRSV`). Scalar operations follow reference LAPACK 3.9, the version
//! MATLAB R2023b's MKL reports. The reflector inner products follow the
//! accumulation order measured from MATLAB on the recording host
//! (`reflect_dot`). MKL chooses its kernels by CPU, so other hosts can round
//! differently; the package README lists the measured agreement.

use crate::precision::Precision;
use num_complex::Complex64;
use std::ops::{Add, Div, Mul, Neg, Sub};

/// The coefficients of `A \ y`, in column order, and the numerical rank.
/// Columns beyond the rank get exact zero coefficients.
#[derive(Debug, Clone, PartialEq)]
pub struct Solution {
    pub coefficients: Vec<Complex64>,
    pub rank: usize,
    /// Column order after pivoting (zero-based), as MATLAB's `qr(A,0)` returns it.
    pub pivot: Vec<usize>,
    /// The leading `min(m, n)` rows of `R`, row-major, in pivoted column order.
    pub r: Vec<Vec<Complex64>>,
}

/// `A \ y` with `A` given by its columns. Inputs are converted to
/// `precision` first; the design is complex only when an imaginary part
/// survives that conversion (MATLAB's complex tolerance applies only then).
pub fn mldivide(columns: &[&[Complex64]], y: &[f64], precision: Precision) -> Solution {
    match precision {
        Precision::Double => solve::<f64>(columns, y),
        Precision::Single => solve::<f32>(columns, y),
    }
}

/// `[ones(n,1) x] \ y` as SamSrf writes it: returns `(Beta, Baseline)`, the
/// coefficients of `x` and of the constant column.
pub fn regress_on_ones(x: &[Complex64], y: &[f64], precision: Precision) -> (Complex64, Complex64) {
    let ones = vec![Complex64::new(1.0, 0.0); x.len()];
    let solution = mldivide(&[&ones, x], y, precision);
    (solution.coefficients[1], solution.coefficients[0])
}

/// The two IEEE binary formats MATLAB's `single` and `double` use.
trait Real:
    Copy
    + PartialOrd
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
    + Neg<Output = Self>
{
    const ZERO: Self;
    const ONE: Self;
    const EPSILON: Self;
    /// LAPACK's `xLAMCH('S') / xLAMCH('E')`, the threshold `xLARFG` rescales below.
    const RESCALE: Self;
    fn from_f64(value: f64) -> Self;
    fn to_f64(self) -> f64;
    fn from_usize(value: usize) -> Self;
    fn sqrt(self) -> Self;
    fn abs(self) -> Self;
    fn copysign(self, sign: Self) -> Self;
}

macro_rules! real {
    ($t:ty) => {
        impl Real for $t {
            const ZERO: Self = 0.0;
            const ONE: Self = 1.0;
            const EPSILON: Self = <$t>::EPSILON;
            const RESCALE: Self = <$t>::MIN_POSITIVE / (<$t>::EPSILON * 0.5);
            fn from_f64(value: f64) -> Self {
                value as $t
            }
            fn to_f64(self) -> f64 {
                self as f64
            }
            fn from_usize(value: usize) -> Self {
                value as $t
            }
            fn sqrt(self) -> Self {
                <$t>::sqrt(self)
            }
            fn abs(self) -> Self {
                <$t>::abs(self)
            }
            fn copysign(self, sign: Self) -> Self {
                <$t>::copysign(self, sign)
            }
        }
    };
}
real!(f32);
real!(f64);

/// A complex value with explicit operation order. The real path keeps
/// `im == 0` and never multiplies by it, so it rounds as real arithmetic.
#[derive(Debug, Clone, Copy, PartialEq)]
struct C<T> {
    re: T,
    im: T,
}

impl<T: Real> C<T> {
    fn real(re: T) -> Self {
        C { re, im: T::ZERO }
    }
    fn conj(self) -> Self {
        C { re: self.re, im: -self.im }
    }
    fn add(self, other: Self, complex: bool) -> Self {
        if complex {
            C { re: self.re + other.re, im: self.im + other.im }
        } else {
            C::real(self.re + other.re)
        }
    }
    fn sub(self, other: Self, complex: bool) -> Self {
        if complex {
            C { re: self.re - other.re, im: self.im - other.im }
        } else {
            C::real(self.re - other.re)
        }
    }
    fn mul(self, other: Self, complex: bool) -> Self {
        if complex {
            C {
                re: self.re * other.re - self.im * other.im,
                im: self.re * other.im + self.im * other.re,
            }
        } else {
            C::real(self.re * other.re)
        }
    }
    /// LAPACK's `xLADIV` without its extra scaling: Smith's algorithm.
    fn div(self, other: Self, complex: bool) -> Self {
        if !complex {
            return C::real(self.re / other.re);
        }
        if other.im.abs() <= other.re.abs() {
            let e = other.im / other.re;
            let f = other.re + other.im * e;
            C { re: (self.re + self.im * e) / f, im: (self.im - self.re * e) / f }
        } else {
            let e = other.re / other.im;
            let f = other.im + other.re * e;
            C { re: (self.re * e + self.im) / f, im: (self.im * e - self.re) / f }
        }
    }
    fn abs(self) -> T {
        lapy2(self.re, self.im)
    }
}

/// `xLAPY2`: sqrt(x² + y²) without overflow.
fn lapy2<T: Real>(x: T, y: T) -> T {
    let (x, y) = (x.abs(), y.abs());
    let (w, z) = if x >= y { (x, y) } else { (y, x) };
    if z == T::ZERO {
        w
    } else {
        let q = z / w;
        w * (T::ONE + q * q).sqrt()
    }
}

/// `xLAPY3`: sqrt(x² + y² + z²) without overflow.
fn lapy3<T: Real>(x: T, y: T, z: T) -> T {
    let (x, y, z) = (x.abs(), y.abs(), z.abs());
    let mut w = x;
    if y > w {
        w = y;
    }
    if z > w {
        w = z;
    }
    if w == T::ZERO {
        return x + y + z;
    }
    let (a, b, c) = (x / w, y / w, z / w);
    w * (a * a + b * b + c * c).sqrt()
}

/// Reference `xNRM2` (LAPACK 3.9): the scaled sum of squares, sequential.
/// Complex entries contribute their real and then their imaginary part.
fn nrm2<T: Real>(values: &[C<T>]) -> T {
    let mut scale = T::ZERO;
    let mut ssq = T::ONE;
    for value in values {
        for part in [value.re, value.im] {
            if part != T::ZERO {
                let a = part.abs();
                if scale < a {
                    let r = scale / a;
                    ssq = T::ONE + ssq * r * r;
                    scale = a;
                } else {
                    let r = a / scale;
                    ssq = ssq + r * r;
                }
            }
        }
    }
    scale * ssq.sqrt()
}

/// `xSCAL`/`xCSCAL` of `values` by `factor`.
fn scale<T: Real>(values: &mut [C<T>], factor: C<T>, complex: bool) {
    for value in values {
        *value = factor.mul(*value, complex);
    }
}

/// `xLARFG`: the reflector `H = I - tau v v^H` with `H^H [alpha; x] = [beta; 0]`.
/// Overwrites `x` with `v(2:end)` and returns `(beta, tau)`.
fn larfg<T: Real>(alpha: C<T>, x: &mut [C<T>], complex: bool) -> (C<T>, C<T>) {
    let mut xnorm = nrm2(x);
    if xnorm == T::ZERO && alpha.im == T::ZERO {
        return (alpha, C::real(T::ZERO));
    }
    let mut alpha = alpha;
    let norm = |alpha: C<T>, xnorm: T| if complex { lapy3(alpha.re, alpha.im, xnorm) } else { lapy2(alpha.re, xnorm) };
    let mut beta = -norm(alpha, xnorm).copysign(alpha.re);
    let inverse = T::ONE / T::RESCALE;
    let mut rescaled = 0;
    if beta.abs() < T::RESCALE {
        // Values this small lose accuracy; LAPACK scales them up first.
        loop {
            rescaled += 1;
            scale(x, C::real(inverse), complex);
            beta = beta * inverse;
            alpha = C { re: alpha.re * inverse, im: alpha.im * inverse };
            if beta.abs() >= T::RESCALE || rescaled >= 20 {
                break;
            }
        }
        xnorm = nrm2(x);
        beta = -norm(alpha, xnorm).copysign(alpha.re);
    }
    let tau = if complex {
        C { re: (beta - alpha.re) / beta, im: -alpha.im / beta }
    } else {
        C::real((beta - alpha.re) / beta)
    };
    let shift = alpha.sub(C::real(beta), complex);
    if complex {
        scale(x, C::real(T::ONE).div(shift, true), true);
    } else {
        scale(x, C::real(T::ONE / shift.re), false);
    }
    for _ in 0..rescaled {
        beta = beta * T::RESCALE;
    }
    (C::real(beta), tau)
}

/// `v^H c` with `v(1) = 1`, as MKL accumulated it for MATLAB on the recording
/// host. The pinned least-squares recording selects this order among the
/// sequential, lane, peeled, fused and split complex variants tried
/// (validation README). Real designs take the first product `v(2) c(2)` on its
/// own, accumulate the rest in eight lanes over whole blocks of eight, reduce
/// the lanes pairwise (lane i with i + 4, then i + 2, then i + 1) and add the
/// remaining terms in sequence; complex single designs use two lanes over every
/// term and complex double designs add in sequence. `c(1)` is added last.
fn reflect_dot<T: Real>(v: &[C<T>], c: &[C<T>], complex: bool) -> C<T> {
    let single = std::mem::size_of::<T>() == 4;
    let (peeled, lanes, sequential_tail) = match (complex, single) {
        (false, _) => (1, 8, true),
        (true, true) => (0, 2, false),
        (true, false) => (0, 1, false),
    };
    let products: Vec<C<T>> = v.iter().zip(&c[1..]).map(|(v, c)| v.conj().mul(*c, complex)).collect();
    let peeled = peeled.min(products.len());
    let body = &products[peeled..];
    let blocked = if sequential_tail { body.len() / lanes * lanes } else { body.len() };
    let mut sums = vec![C::real(T::ZERO); lanes];
    for (i, product) in body[..blocked].iter().enumerate() {
        sums[i % lanes] = sums[i % lanes].add(*product, complex);
    }
    while sums.len() > 1 {
        let half = sums.len() / 2;
        sums = (0..half).map(|i| sums[i].add(sums[i + half], complex)).collect();
    }
    let mut w = sums[0];
    for product in &body[blocked..] {
        w = w.add(*product, complex);
    }
    for product in products[..peeled].iter().rev() {
        w = product.add(w, complex);
    }
    c[0].add(w, complex)
}

/// `xLARF` from the left with `H^H`: `c -= v (tau^H (v^H c))`, `v(1) = 1`.
fn apply<T: Real>(v: &[C<T>], tau: C<T>, c: &mut [C<T>], complex: bool) {
    let w = reflect_dot(v, c, complex);
    let t = tau.conj().mul(w, complex);
    c[0] = c[0].sub(t, complex);
    for (vi, ci) in v.iter().zip(&mut c[1..]) {
        *ci = ci.sub(vi.mul(t, complex), complex);
    }
}

fn solve<T: Real>(columns: &[&[Complex64]], y: &[f64]) -> Solution {
    let n = columns.len();
    let m = y.len();
    assert!(columns.iter().all(|column| column.len() == m), "design columns and observations differ in length");
    let convert = |value: Complex64| C { re: T::from_f64(value.re), im: T::from_f64(value.im) };
    let mut a: Vec<Vec<C<T>>> = columns.iter().map(|column| column.iter().map(|&v| convert(v)).collect()).collect();
    let mut b: Vec<C<T>> = y.iter().map(|&v| C::real(T::from_f64(v))).collect();
    let complex = a.iter().flatten().any(|value| value.im != T::ZERO);
    if !complex {
        for value in a.iter_mut().flatten() {
            value.im = T::ZERO;
        }
    }
    let steps = m.min(n);
    let mut pivot: Vec<usize> = (0..n).collect();
    let mut norms: Vec<T> = a.iter().map(|column| nrm2(column)).collect();
    let mut original = norms.clone();
    let threshold = T::EPSILON.sqrt();
    let mut diagonal = Vec::with_capacity(steps);
    for i in 0..steps {
        // xLAQP2: the remaining column with the largest updated norm (first on ties).
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
        let alpha = a[i][i];
        let (beta, tau) = larfg(alpha, &mut a[i][i + 1..], complex);
        a[i][i] = beta;
        diagonal.push(beta);
        let v: Vec<C<T>> = a[i][i + 1..].to_vec();
        for column in &mut a[i + 1..] {
            apply(&v, tau, &mut column[i..], complex);
        }
        apply(&v, tau, &mut b[i..], complex);
        // Downdate the remaining norms as xLAQP2 does.
        for j in i + 1..n {
            if norms[j] != T::ZERO {
                let ratio = a[j][i].abs() / norms[j];
                let mut temp = T::ONE - ratio * ratio;
                if temp < T::ZERO {
                    temp = T::ZERO;
                }
                let quotient = norms[j] / original[j];
                if temp * quotient * quotient <= threshold {
                    norms[j] = nrm2(&a[j][i + 1..]);
                    original[j] = norms[j];
                } else {
                    norms[j] = norms[j] * temp.sqrt();
                }
            }
        }
    }
    // MATLAB's rank: diagonals above max(m, n) * eps * |R11|. Its complex
    // warnings report ten times that tolerance (recorded double CSS vertex 81).
    let factor = if complex { T::from_usize(10) } else { T::ONE };
    let tolerance = factor * T::from_usize(m.max(n)) * T::EPSILON * diagonal.first().map_or(T::ZERO, |r| r.abs());
    let rank = diagonal.iter().take_while(|r| r.abs() > tolerance).count();
    let mut x = vec![C::real(T::ZERO); n];
    for i in (0..rank).rev() {
        let mut sum = b[i];
        for j in i + 1..rank {
            sum = sum.sub(a[j][i].mul(x[j], complex), complex);
        }
        x[i] = sum.div(a[i][i], complex);
    }
    let mut coefficients = vec![Complex64::new(0.0, 0.0); n];
    for (k, &column) in pivot.iter().enumerate() {
        coefficients[column] = Complex64::new(x[k].re.to_f64(), x[k].im.to_f64());
    }
    let r = (0..steps)
        .map(|i| (0..n).map(|j| if j < i { Complex64::new(0.0, 0.0) } else { Complex64::new(a[j][i].re.to_f64(), a[j][i].im.to_f64()) }).collect())
        .collect();
    Solution { coefficients, rank, pivot, r }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn real(values: &[f64]) -> Vec<Complex64> {
        values.iter().map(|&v| Complex64::new(v, 0.0)).collect()
    }

    #[test]
    fn exact_lines_are_recovered_in_both_classes() {
        let x = real(&[1.0, 2.0, 3.0, 4.0]);
        let y = [3.0, 5.0, 7.0, 9.0];
        for precision in [Precision::Double, Precision::Single] {
            let (beta, baseline) = regress_on_ones(&x, &y, precision);
            assert!((beta.re - 2.0).abs() < 1e-6 && (baseline.re - 1.0).abs() < 1e-5, "{precision:?}: {beta} {baseline}");
            assert_eq!((beta.im, baseline.im), (0.0, 0.0));
        }
    }

    #[test]
    fn single_coefficients_are_single_values() {
        let x = real(&[0.1, 0.7, 0.2, 0.9, 0.4]);
        let y = [0.3, 1.1, 0.2, 1.7, 0.5];
        let (beta, baseline) = regress_on_ones(&x, &y, Precision::Single);
        assert_eq!(beta.re, f64::from(beta.re as f32));
        assert_eq!(baseline.re, f64::from(baseline.re as f32));
    }

    #[test]
    fn constant_predictions_keep_only_the_first_pivoted_column() {
        let y = [3.0, 5.0, 7.0, 9.0];
        // The ones column has the larger norm, so it keeps the coefficient.
        let (beta, baseline) = regress_on_ones(&real(&[0.5; 4]), &y, Precision::Double);
        assert_eq!((beta.re, baseline.re), (0.0, 6.0));
        let (beta, baseline) = regress_on_ones(&real(&[0.0; 4]), &y, Precision::Double);
        assert_eq!((beta.re, baseline.re), (0.0, 6.0));
        // Here x does, and the baseline is dropped.
        let (beta, baseline) = regress_on_ones(&real(&[2.0; 4]), &y, Precision::Double);
        assert_eq!((beta.re, baseline.re), (3.0, 0.0));
        // Constant to rounding is rank deficient too.
        let (beta, baseline) = regress_on_ones(&real(&[1e-20, -2e-20, 3e-20, 0.0]), &y, Precision::Double);
        assert_eq!((beta.re, baseline.re), (0.0, 6.0));
    }

    #[test]
    fn squares_beyond_the_exponent_range_do_not_change_the_rank() {
        let y = [3.0, 5.0, 7.0, 9.0];
        let x = real(&[1e155, 2e155, 3e155, 4e155]);
        let (beta, baseline) = regress_on_ones(&x, &y, Precision::Double);
        assert_eq!(baseline.re, 0.0);
        assert!((beta.re / (70.0 / 30.0 / 1e155) - 1.0).abs() < 1e-14, "{beta}");
        let x = real(&[1e-170, -2e-170, 3e-170, 1e-170]);
        let (beta, baseline) = regress_on_ones(&x, &y, Precision::Double);
        assert_eq!(beta.re, 0.0);
        assert_eq!(baseline.re, 6.0);
    }

    #[test]
    fn imaginary_parts_that_vanish_in_single_leave_a_real_design() {
        let x: Vec<_> = (1..=16).map(|t| Complex64::new((t as f64).sin(), 1e-50 * (t as f64).cos())).collect();
        let r: Vec<_> = x.iter().map(|v| Complex64::new(v.re, 0.0)).collect();
        let y: Vec<_> = (1..=16).map(|t| 2.0 * (t as f64).sin() + 3.0).collect();
        assert_eq!(regress_on_ones(&x, &y, Precision::Single), regress_on_ones(&r, &y, Precision::Single));
        assert_ne!(regress_on_ones(&x, &y, Precision::Double).0.im, 0.0);
    }

    #[test]
    fn complex_designs_keep_imaginary_coefficients() {
        let x = [Complex64::new(1.0, 1.0), Complex64::new(2.0, -1.0), Complex64::new(3.0, 0.0)];
        let (beta, baseline) = regress_on_ones(&x, &[3.0, 5.0, 7.0], Precision::Double);
        // The exact least-squares solution is beta = 1 + 0.5i, baseline = 3 - i.
        assert!((beta - Complex64::new(1.0, 0.5)).norm() < 1e-14, "{beta}");
        assert!((baseline - Complex64::new(3.0, -1.0)).norm() < 1e-14, "{baseline}");
    }

    #[test]
    fn pivoting_and_rank_follow_column_norms_for_more_columns() {
        // y = 2 a - b exactly; the third column repeats the first.
        let a = real(&[1.0, 2.0, 0.0, 1.0, 3.0]);
        let b = real(&[0.0, 1.0, 1.0, 2.0, 1.0]);
        let y: Vec<f64> = a.iter().zip(&b).map(|(a, b)| 2.0 * a.re - b.re).collect();
        let solution = mldivide(&[&a, &b, &a], &y, Precision::Double);
        assert_eq!(solution.rank, 2);
        assert_eq!(solution.coefficients.iter().filter(|c| c.re == 0.0).count(), 1);
        let fitted: Vec<f64> = (0..5)
            .map(|i| solution.coefficients[0].re * a[i].re + solution.coefficients[1].re * b[i].re + solution.coefficients[2].re * a[i].re)
            .collect();
        for (f, y) in fitted.iter().zip(&y) {
            assert!((f - y).abs() < 1e-12);
        }
    }
}
