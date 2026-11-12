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
    /// The factorisation as `xGEQP3` leaves it, column by column in pivoted
    /// order (R on and above the diagonal, reflector vectors below), its
    /// reflector scalars and `Q^H y` (`xORMQR`), for step-by-step comparison.
    pub packed: Vec<Vec<Complex64>>,
    pub tau: Vec<Complex64>,
    pub qty: Vec<Complex64>,
}

/// `A \ y` with `A` given by its columns. Inputs are converted to
/// `precision` first; the design is complex only when an imaginary part
/// survives that conversion (MATLAB's complex tolerance applies only then).
pub fn mldivide(columns: &[&[Complex64]], y: &[f64], precision: Precision) -> Solution {
    let solved = match precision {
        Precision::Double => solve::<f64>(columns, &[y]),
        Precision::Single => solve::<f32>(columns, &[y]),
    };
    let Solved { mut coefficients, mut qty, rank, pivot, r, packed, tau } = solved;
    Solution { coefficients: coefficients.remove(0), rank, pivot, r, packed, tau, qty: qty.remove(0) }
}

/// The coefficients of `A \ Y` for several right-hand sides at once, in
/// column order per right-hand side. MATLAB applies `Q^H` to all of them in
/// one `?ormqr` call, whose summation order depends on each column's place
/// among them, so this differs in the last bits from solving each column
/// alone.
#[derive(Debug, Clone, PartialEq)]
pub struct Solutions {
    pub coefficients: Vec<Vec<Complex64>>,
    pub rank: usize,
    pub pivot: Vec<usize>,
}

pub fn mldivide_many(columns: &[&[Complex64]], ys: &[&[f64]], precision: Precision) -> Solutions {
    let solved = match precision {
        Precision::Double => solve::<f64>(columns, ys),
        Precision::Single => solve::<f32>(columns, ys),
    };
    Solutions { coefficients: solved.coefficients, rank: solved.rank, pivot: solved.pivot }
}

struct Solved {
    coefficients: Vec<Vec<Complex64>>,
    qty: Vec<Vec<Complex64>>,
    rank: usize,
    pivot: Vec<usize>,
    r: Vec<Vec<Complex64>>,
    packed: Vec<Vec<Complex64>>,
    tau: Vec<Complex64>,
}

/// `[ones(n,1) x] \ y` as SamSrf writes it: returns `(Beta, Baseline)`, the
/// coefficients of `x` and of the constant column.
pub fn regress_on_ones(x: &[Complex64], y: &[f64], precision: Precision) -> (Complex64, Complex64) {
    let ones = vec![Complex64::new(1.0, 0.0); x.len()];
    let solution = mldivide(&[&ones, x], y, precision);
    (solution.coefficients[1], solution.coefficients[0])
}

/// Which MKL summation a probe exercises (see `probe_sum`).
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbedKernel {
    /// `?gemv` as `?geqp3` uses it on the next column.
    Column,
    /// `?ormqr` / `?unmqr` on right-hand side `index` of `count`.
    RightHandSide { count: usize, index: usize },
}

/// `v^H c` with `v` all ones, in the given kernel's summation order and
/// class: the quantity `record_qr_kernels.m`'s FPRev probes record from MKL.
/// For the kernel test only.
#[doc(hidden)]
pub fn probe_sum(kernel: ProbedKernel, precision: Precision, complex: bool, values: &[Complex64]) -> Complex64 {
    fn run<T: Real>(kernel: ProbedKernel, complex: bool, values: &[Complex64]) -> Complex64 {
        let single = std::mem::size_of::<T>() == 4;
        let c: Vec<C<T>> = values.iter().map(|v| C { re: T::from_f64(v.re), im: T::from_f64(v.im) }).collect();
        let v = vec![C::real(T::ONE); c.len().saturating_sub(1)];
        let chosen = match kernel {
            ProbedKernel::Column => column_kernel(complex, single),
            ProbedKernel::RightHandSide { count, index } => rhs_kernel(complex, single, count, index),
        };
        let w = kernel_dot(chosen, &v, &c, complex);
        Complex64::new(w.re.to_f64(), w.im.to_f64())
    }
    match precision {
        Precision::Double => run::<f64>(kernel, complex, values),
        Precision::Single => run::<f32>(kernel, complex, values),
    }
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
    const MAX: Self;
    const MIN_POSITIVE: Self;
    fn from_f64(value: f64) -> Self;
    fn to_f64(self) -> f64;
    fn from_usize(value: usize) -> Self;
    fn sqrt(self) -> Self;
    fn abs(self) -> Self;
    fn copysign(self, sign: Self) -> Self;
    fn is_finite(self) -> bool;
}

macro_rules! real {
    ($t:ty) => {
        impl Real for $t {
            const ZERO: Self = 0.0;
            const ONE: Self = 1.0;
            const EPSILON: Self = <$t>::EPSILON;
            const RESCALE: Self = <$t>::MIN_POSITIVE / (<$t>::EPSILON * 0.5);
            const MAX: Self = <$t>::MAX;
            const MIN_POSITIVE: Self = <$t>::MIN_POSITIVE;
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
            fn is_finite(self) -> bool {
                <$t>::is_finite(self)
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
    /// Complex division as LAPACK's `xLADIV` guards it: operands near the
    /// overflow or underflow threshold are first scaled by powers of two
    /// (exact, so ordinary operands round as before), then Smith's algorithm.
    fn div(self, other: Self, complex: bool) -> Self {
        if !complex {
            return C::real(self.re / other.re);
        }
        let half = T::from_f64(0.5);
        let two = T::from_f64(2.0);
        // LAPACK's xLAMCH('E') is the unit roundoff, half of EPSILON.
        let unit = T::EPSILON * half;
        let tiny = T::MIN_POSITIVE * two / unit;
        let blow_up = two / (unit * unit);
        let (mut a, mut b) = (self, other);
        let mut scale = T::ONE;
        let largest = |z: Self| if z.re.abs() >= z.im.abs() { z.re.abs() } else { z.im.abs() };
        let (ab, cd) = (largest(a), largest(b));
        if ab >= half * T::MAX {
            a = C { re: a.re * half, im: a.im * half };
            scale = scale * two;
        }
        if cd >= half * T::MAX {
            b = C { re: b.re * half, im: b.im * half };
            scale = scale * half;
        }
        if ab <= tiny {
            a = C { re: a.re * blow_up, im: a.im * blow_up };
            scale = scale / blow_up;
        }
        if cd <= tiny {
            b = C { re: b.re * blow_up, im: b.im * blow_up };
            scale = scale * blow_up;
        }
        let q = a.smith(b);
        if scale == T::ONE {
            q
        } else {
            C { re: q.re * scale, im: q.im * scale }
        }
    }
    /// LAPACK 3.9's `xLADIV` (Baudin and Smith's robust division), which
    /// `xLARFG` uses for 1 / (alpha - beta): the same power-of-two
    /// prescaling as `div`, then a reciprocal of the denominator.
    fn ladiv(self, other: Self) -> Self {
        let half = T::from_f64(0.5);
        let two = T::from_f64(2.0);
        let unit = T::EPSILON * half;
        let tiny = T::MIN_POSITIVE * two / unit;
        let blow_up = two / (unit * unit);
        let (mut a, mut b, mut c, mut d) = (self.re, self.im, other.re, other.im);
        let ab = if a.abs() >= b.abs() { a.abs() } else { b.abs() };
        let cd = if c.abs() >= d.abs() { c.abs() } else { d.abs() };
        let mut s = T::ONE;
        if ab >= half * T::MAX {
            a = half * a;
            b = half * b;
            s = two * s;
        }
        if cd >= half * T::MAX {
            c = half * c;
            d = half * d;
            s = half * s;
        }
        if ab <= tiny {
            a = a * blow_up;
            b = b * blow_up;
            s = s / blow_up;
        }
        if cd <= tiny {
            c = c * blow_up;
            d = d * blow_up;
            s = s * blow_up;
        }
        let (p, q) = if other.im.abs() <= other.re.abs() {
            ladiv1(a, b, c, d)
        } else {
            let (p, q) = ladiv1(b, a, d, c);
            (p, -q)
        };
        C { re: p * s, im: q * s }
    }
    /// Smith's algorithm.
    fn smith(self, other: Self) -> Self {
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

/// The division `?trsv` makes by a diagonal of R, as measured from MKL's
/// `ctrsv` and `ztrsv` on AMD: complex single divides each part (Smith's
/// algorithm with a real divisor), complex double uses (a c + b d) / (c² + d²).
/// Where c² + d² is not a finite normal number MKL still returned the
/// quotient (recorded at 1e155 and 1e300); the guarded division used there
/// agrees with those two recordings but is not otherwise evidenced.
fn trsv_divide<T: Real>(numerator: C<T>, divisor: C<T>, complex: bool, single: bool) -> C<T> {
    if !complex || single {
        return numerator.div(divisor, complex);
    }
    let (c, d) = (divisor.re, divisor.im);
    let denominator = c * c + d * d;
    if denominator.is_finite() && denominator >= T::MIN_POSITIVE {
        let (a, b) = (numerator.re, numerator.im);
        C { re: (a * c + b * d) / denominator, im: (b * c - a * d) / denominator }
    } else {
        numerator.div(divisor, true)
    }
}

/// `?trsm`, which a solve with several right-hand sides uses, multiplies by
/// the reciprocal of each real diagonal (measured on AMD for every recorded
/// real design). Complex designs keep `?trsv`'s division (not established).
fn trsm_divide<T: Real>(numerator: C<T>, divisor: C<T>, complex: bool) -> C<T> {
    if complex {
        return numerator.div(divisor, true);
    }
    C::real(numerator.re * (T::ONE / divisor.re))
}

fn ladiv1<T: Real>(a: T, b: T, c: T, d: T) -> (T, T) {
    let r = d / c;
    let t = T::ONE / (c + d * r);
    let p = ladiv2(a, b, c, d, r, t);
    let q = ladiv2(b, -a, c, d, r, t);
    (p, q)
}

fn ladiv2<T: Real>(a: T, b: T, c: T, d: T, r: T, t: T) -> T {
    if r != T::ZERO {
        let br = b * r;
        if br != T::ZERO { (a + br) * t } else { a * t + (b * t) * r }
    } else {
        (a + d * (b / c)) * t
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
    // beta and alpha have opposite signs, so beta - alpha overflows when both
    // exceed half the range. Halving then is exact and changes no rounding:
    // tau and 1 / (alpha - beta) get the bits of the unbounded computation.
    let half = if (beta - alpha.re).is_finite() { T::ONE } else { T::from_f64(0.5) };
    let (beta_h, alpha_h) = (beta * half, C { re: alpha.re * half, im: alpha.im * half });
    let tau = if complex {
        C { re: (beta_h - alpha_h.re) / beta_h, im: -alpha_h.im / beta_h }
    } else {
        C::real((beta_h - alpha_h.re) / beta_h)
    };
    let shift = alpha_h.sub(C::real(beta_h), complex);
    if complex {
        scale(x, C::real(half).ladiv(shift), true);
    } else {
        scale(x, C::real(half / shift.re), false);
    }
    for _ in 0..rescaled {
        beta = beta * T::RESCALE;
    }
    (C::real(beta), tau)
}

/// One of MKL's summation orders for `w = v^H c` with `v(1) = 1`, as MATLAB
/// R2023b's MKL runs them on AMD hosts (CNR branch auto). Each was read from
/// MKL's own summation trees: `record_qr_kernels.m` probes `?gemv` and
/// `?ormqr` with +M and -M among ones (FPRev) at every recorded length,
/// alignment and number of right-hand sides. Products `p(i) = v(i+1)^H
/// c(i+1)` are summed into `lanes` accumulators over whole blocks of `block`
/// products (every product when `mod_tail`), the accumulators combine in
/// `strides` order (lane k with k + stride while k / stride is even), and
/// the remaining products follow in sequence. MKL's AVX-512 branch on Intel
/// sums in other trees, so its results differ in the last bits.
#[derive(Debug, Clone, Copy)]
struct Kernel {
    /// `?ormqr` takes `p(1)` as the first term of accumulator 0 and adds
    /// `c(1)` last; `?gemv` inside `?geqp3` starts accumulator 0 with `c(1)`.
    first_product_seeds: bool,
    /// `zunmqr` adds the two halves of each complex product to an
    /// accumulator separately (re += v.re c.re, then += v.im c.im) instead of
    /// rounding the product first.
    split_complex: bool,
    lanes: usize,
    block: usize,
    strides: &'static [usize],
    mod_tail: bool,
}

const fn kernel(first_product_seeds: bool, lanes: usize, block: usize, strides: &'static [usize], mod_tail: bool) -> Kernel {
    Kernel { first_product_seeds, split_complex: false, lanes, block, strides, mod_tail }
}

/// `?gemv`, which `?geqp3` uses to apply a reflector to the next column.
fn column_kernel(complex: bool, single: bool) -> Kernel {
    match (complex, single) {
        (false, true) => kernel(false, 8, 8, &[4, 2, 1], false),
        (false, false) => kernel(false, 8, 8, &[2, 4, 1], false),
        (true, true) => kernel(false, 2, 2, &[1], true),
        (true, false) => kernel(false, 1, 1, &[], false),
    }
}

/// `?ormqr` / `?unmqr` applying a reflector to right-hand side `index` of
/// `count`. Real right-hand sides are processed in groups of four columns;
/// the one to three columns left over use narrower kernels.
fn rhs_kernel(complex: bool, single: bool, count: usize, index: usize) -> Kernel {
    let one = match (complex, single) {
        (false, true) => kernel(true, 8, 8, &[4, 2, 1], false),
        (false, false) => kernel(true, 8, 8, &[2, 4, 1], false),
        (true, true) => return kernel(true, 2, 2, &[1], true),
        (true, false) => return Kernel { split_complex: true, ..kernel(true, 1, 1, &[], false) },
    };
    let grouped = count / 4 * 4;
    if index < grouped {
        return if single { kernel(true, 4, 4, &[2, 1], false) } else { kernel(true, 2, 2, &[1], false) };
    }
    let (left, position) = (count - grouped, index - grouped);
    match (left, position, single) {
        (1, _, _) | (3, 2, _) => one,
        (_, 0, true) => one,
        (_, 0, false) => kernel(true, 4, 8, &[2, 1], false),
        (_, _, true) => kernel(true, 4, 8, &[2, 1], false),
        (_, _, false) => kernel(true, 2, 8, &[1], false),
    }
}

/// `w = v^H c` in `kernel`'s summation order.
fn kernel_dot<T: Real>(kernel: Kernel, v: &[C<T>], c: &[C<T>], complex: bool) -> C<T> {
    if complex && kernel.split_complex {
        // Only the sequential zunmqr kernel splits products; see rhs_kernel.
        debug_assert!(kernel.lanes == 1 && kernel.first_product_seeds);
        let mut pairs = v.iter().zip(&c[1..]);
        let Some((v0, c0)) = pairs.next() else { return c[0] };
        let mut w = v0.conj().mul(*c0, true);
        for (v, c) in pairs {
            w = C { re: (w.re + v.re * c.re) + v.im * c.im, im: (w.im + v.re * c.im) - v.im * c.re };
        }
        return c[0].add(w, true);
    }
    let products: Vec<C<T>> = v.iter().zip(&c[1..]).map(|(v, c)| v.conj().mul(*c, complex)).collect();
    if products.is_empty() {
        return c[0];
    }
    let (seed, body) = if kernel.first_product_seeds { (products[0], &products[1..]) } else { (c[0], &products[..]) };
    let blocked = if kernel.mod_tail { body.len() } else { body.len() / kernel.block * kernel.block };
    let mut w = seed;
    if kernel.lanes > 1 && blocked > 0 {
        let mut sums: Vec<Option<C<T>>> = vec![None; kernel.lanes];
        sums[0] = Some(seed);
        for (i, product) in body[..blocked].iter().enumerate() {
            let lane = &mut sums[i % kernel.lanes];
            *lane = Some(lane.map_or(*product, |sum| sum.add(*product, complex)));
        }
        for &stride in kernel.strides {
            for k in 0..kernel.lanes {
                if (k / stride) % 2 == 0 && k + stride < kernel.lanes {
                    if let (Some(left), Some(right)) = (sums[k], sums[k + stride]) {
                        sums[k] = Some(left.add(right, complex));
                    }
                }
            }
        }
        w = sums[0].unwrap();
        for product in &body[blocked..] {
            w = w.add(*product, complex);
        }
    } else {
        for product in body {
            w = w.add(*product, complex);
        }
    }
    if kernel.first_product_seeds { c[0].add(w, complex) } else { w }
}

/// `xLARF` from the left with `H^H`: `c -= v (tau^H (v^H c))`, `v(1) = 1`.
fn apply<T: Real>(kernel: Kernel, v: &[C<T>], tau: C<T>, c: &mut [C<T>], complex: bool) {
    let w = kernel_dot(kernel, v, c, complex);
    let t = tau.conj().mul(w, complex);
    c[0] = c[0].sub(t, complex);
    for (vi, ci) in v.iter().zip(&mut c[1..]) {
        *ci = ci.sub(vi.mul(t, complex), complex);
    }
}

fn solve<T: Real>(columns: &[&[Complex64]], ys: &[&[f64]]) -> Solved {
    let n = columns.len();
    let m = ys.first().map_or(0, |y| y.len());
    assert!(columns.iter().all(|column| column.len() == m), "design columns and observations differ in length");
    assert!(ys.iter().all(|y| y.len() == m), "right-hand sides differ in length");
    let convert = |value: Complex64| C { re: T::from_f64(value.re), im: T::from_f64(value.im) };
    let mut a: Vec<Vec<C<T>>> = columns.iter().map(|column| column.iter().map(|&v| convert(v)).collect()).collect();
    let mut bs: Vec<Vec<C<T>>> = ys.iter().map(|y| y.iter().map(|&v| C::real(T::from_f64(v))).collect()).collect();
    // MATLAB's NaN and Inf handling inside mldivide is not recorded here.
    // Nonfinite converted inputs (including finite doubles that overflow
    // single) give NaN coefficients rather than a silently finite answer.
    // A nonfinite value makes every coefficient NaN, for all right-hand sides.
    if a.iter().flatten().chain(bs.iter().flatten()).any(|value| !value.re.is_finite() || !value.im.is_finite()) {
        return Solved {
            coefficients: vec![vec![Complex64::new(f64::NAN, f64::NAN); n]; ys.len()],
            qty: vec![Vec::new(); ys.len()],
            rank: 0,
            pivot: (0..n).collect(),
            r: Vec::new(),
            packed: Vec::new(),
            tau: Vec::new(),
        };
    }
    let complex = a.iter().flatten().any(|value| value.im != T::ZERO);
    if !complex {
        for value in a.iter_mut().flatten() {
            value.im = T::ZERO;
        }
    }
    let single = std::mem::size_of::<T>() == 4;
    let count = bs.len();
    let steps = m.min(n);
    let mut pivot: Vec<usize> = (0..n).collect();
    let mut norms: Vec<T> = a.iter().map(|column| nrm2(column)).collect();
    let mut original = norms.clone();
    let threshold = T::EPSILON.sqrt();
    let mut diagonal = Vec::with_capacity(steps);
    let mut taus = Vec::with_capacity(steps);
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
        taus.push(tau);
        let v: Vec<C<T>> = a[i][i + 1..].to_vec();
        for column in &mut a[i + 1..] {
            apply(column_kernel(complex, single), &v, tau, &mut column[i..], complex);
        }
        for (index, b) in bs.iter_mut().enumerate() {
            apply(rhs_kernel(complex, single, count, index), &v, tau, &mut b[i..], complex);
        }
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
    let wide = |value: &C<T>| Complex64::new(value.re.to_f64(), value.im.to_f64());
    let coefficients = bs.iter().map(|b| {
        let mut x = vec![C::real(T::ZERO); n];
        for i in (0..rank).rev() {
            let mut sum = b[i];
            for j in i + 1..rank {
                sum = sum.sub(a[j][i].mul(x[j], complex), complex);
            }
            x[i] = if count == 1 {
                trsv_divide(sum, a[i][i], complex, single)
            } else {
                trsm_divide(sum, a[i][i], complex)
            };
        }
        let mut coefficients = vec![Complex64::new(0.0, 0.0); n];
        for (k, &column) in pivot.iter().enumerate() {
            coefficients[column] = wide(&x[k]);
        }
        coefficients
    }).collect();
    let r = (0..steps)
        .map(|i| (0..n).map(|j| if j < i { Complex64::new(0.0, 0.0) } else { Complex64::new(a[j][i].re.to_f64(), a[j][i].im.to_f64()) }).collect())
        .collect();
    let packed = a.iter().map(|column| column.iter().map(wide).collect()).collect();
    let tau = taus.iter().map(wide).collect();
    // Q^H y is kept only for a single right-hand side.
    let qty = bs.iter().map(|b| if count == 1 { b.iter().map(wide).collect() } else { Vec::new() }).collect();
    Solved { coefficients, qty, rank, pivot, r, packed, tau }
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
    fn reflectors_near_the_largest_double_stay_finite() {
        // beta - alpha overflows here, though every result is representable.
        let x = real(&[8e307, 8e307]);
        let (beta, baseline) = regress_on_ones(&x, &[1.0, 1.0], Precision::Double);
        assert_eq!(baseline, Complex64::new(0.0, 0.0));
        assert!((beta.re / 1.25e-308 - 1.0).abs() < 1e-14 && beta.im == 0.0, "{beta}");
        let x = [Complex64::new(8e307, 1e300), Complex64::new(8e307, -1e300)];
        let (beta, baseline) = regress_on_ones(&x, &[1.0, 1.0], Precision::Double);
        assert_eq!(baseline, Complex64::new(0.0, 0.0));
        assert!((beta.re / 1.25e-308 - 1.0).abs() < 1e-14, "{beta}");
        // In single, |beta - alpha| = 4.8e38 overflows while the norm 2.8e38 does not.
        let x = real(&[2e38, 2e38]);
        let (beta, _) = regress_on_ones(&x, &[1.0, 1.0], Precision::Single);
        assert!((beta.re * 2e38 - 1.0).abs() < 1e-5, "{beta}");
    }

    /// The retained-column coefficient conj(x)'y / |x|^2, evaluated on x scaled
    /// by an exact power of two so that it neither overflows nor underflows.
    fn single_column(x: &[Complex64], y: &[f64], scale: f64) -> Complex64 {
        let x: Vec<Complex64> = x.iter().map(|v| v * scale).collect();
        let numerator: Complex64 = x.iter().zip(y).map(|(x, y)| x.conj() * y).sum();
        let denominator: f64 = x.iter().map(|x| x.norm_sqr()).sum();
        numerator / denominator * scale
    }

    fn close(actual: Complex64, expected: Complex64, relative: f64) -> bool {
        (actual - expected).norm() <= relative * expected.norm()
    }

    #[test]
    fn complex_reflectors_near_the_largest_value_keep_the_coefficient() {
        // alpha - beta is about (1.2, 1.2)e308: Smith's denominator overflows
        // unless the division is prescaled.
        let x = [Complex64::new(0.0, 1.2e308), Complex64::new(1e307, 0.0)];
        let (beta, baseline) = regress_on_ones(&x, &[1.0, 1.0], Precision::Double);
        assert_eq!(baseline, Complex64::new(0.0, 0.0));
        let expected = single_column(&x, &[1.0, 1.0], 2f64.powi(-1000));
        assert!(close(beta, expected, 1e-14), "{beta} != {expected}");
        assert!(expected.re > 6.8e-310 && expected.im < -8.2e-309);
        let x = [Complex64::new(0.0, 2e38), Complex64::new(1e37, 0.0)];
        let (beta, baseline) = regress_on_ones(&x, &[1.0, 1.0], Precision::Single);
        assert_eq!(baseline, Complex64::new(0.0, 0.0));
        let expected = single_column(&x, &[1.0, 1.0], 2f64.powi(-120));
        // The single result is subnormal; its real part keeps about 17 bits.
        assert!(close(beta, expected, 1e-4), "{beta} != {expected}");
        assert!(beta.re > 2.4e-40);
    }

    #[test]
    fn single_column_solves_scale_exactly_at_both_ends_of_the_range() {
        let y = [1.0, -2.0, 0.5, 3.0];
        for phase in [0.0, 0.3, std::f64::consts::FRAC_PI_4, 1.2, 2.5, -2.0, std::f64::consts::PI] {
            let base: Vec<Complex64> = (0..4)
                .map(|i| Complex64::from_polar(1.0 + 0.25 * i as f64, phase + 0.7 * i as f64))
                .collect();
            for (precision, exponents) in [(Precision::Double, [1020, -1000, 900, -900]), (Precision::Single, [125, -100, 100, -90])] {
                let reference = mldivide(&[&base], &y, precision).coefficients[0];
                for exponent in exponents {
                    let scale = 2f64.powi(exponent);
                    let x: Vec<Complex64> = base.iter().map(|v| v * scale).collect();
                    let solution = mldivide(&[&x], &y, precision);
                    assert_eq!(solution.rank, 1);
                    let actual = solution.coefficients[0] * scale;
                    let relative = if precision == Precision::Single { 1e-6 } else { 1e-15 };
                    assert!(close(actual, reference, relative), "{precision:?} phase {phase} 2^{exponent}: {actual} != {reference}");
                }
            }
        }
    }

    #[test]
    fn nonfinite_inputs_give_nan_coefficients() {
        let y = [1.0, 2.0];
        for x in [[f64::NAN, 1.0], [f64::INFINITY, 1.0]] {
            let (beta, baseline) = regress_on_ones(&real(&x), &y, Precision::Double);
            assert!(beta.re.is_nan() && baseline.re.is_nan(), "{x:?}");
        }
        let (beta, baseline) = regress_on_ones(&real(&[1.0, 2.0]), &[f64::NAN, 1.0], Precision::Double);
        assert!(beta.re.is_nan() && baseline.re.is_nan());
        // Finite in double, infinite once converted to single.
        let (beta, baseline) = regress_on_ones(&real(&[1e39, 2.0]), &y, Precision::Single);
        assert!(beta.re.is_nan() && baseline.re.is_nan());
        assert!(regress_on_ones(&real(&[1e39, 2.0]), &y, Precision::Double).0.re.is_finite());
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
