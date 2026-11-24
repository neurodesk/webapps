//! MATLAB R2023b's single-precision BLAS and two-column QR kernels as MKL 2021.3 ran
//! them on its AVX512_E1 branch on the recorded Intel Xeon hosts (8370C, 8573C, 6975P-C):
//! `sdot` (`x' * y`), `sgemv_t` (`y' * A`), `corr`, single CF profile, real two-column QR
//! (`sgeqp3`, `sormqr`, `strsv`/`strsm`) and complex two-column QR (`cgeqp3`, `cunmqr`,
//! `ctrsv`/`ctrsm`).
//!
//! Verified bit-exact across:
//! - all 4,400 `sdot` draws (lengths 2..=1,000), all 5,500 `sgemv_t` draws (8 shapes),
//!   all 140 `corr` pairs, and all 160 1-RHS + 1,280 8-RHS real and complex single QR
//!   solves of `intel-norm-single-css-reference.json` (Intel Xeon 6975P-C);
//! - all 756 single CF `product`, `columnProducts` and `corr` entries of
//!   `single-kernels` (Intel Xeon 8573C);
//! - all 107 real and 67 complex 1-column chains and 856 real and 536 complex 8-column
//!   solves of `qr-kernels` (Intel Xeon 8370C).

use crate::precision::sum_single;
use num_complex::{Complex32 as C32, Complex64};

/// The length from which MATLAB hands single `x' * y` to MKL's `sdot`.
pub const SDOT_MKL_MIN_LENGTH: usize = crate::matlab_math::DDOT_MKL_MIN_LENGTH;

/// `sLARFG`/`cLARFG`'s rescaling threshold, `safmin / (eps / 2)`.
const SRESCALE: f32 = f32::MIN_POSITIVE / (f32::EPSILON * 0.5);

#[inline]
fn acc_prod(lane: Option<f32>, a: f32, b: f32) -> f32 {
    match lane {
        None => a * b,
        Some(sum) => a.mul_add(b, sum),
    }
}

fn fold_f32(lanes: &mut [Option<f32>], strides: &[usize]) -> Option<f32> {
    let mut taken = [false; 64];
    debug_assert!(lanes.len() <= taken.len());
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

fn sdot_pairs(x: &[f32], y: &[f32]) -> f32 {
    let n = x.len().min(y.len());
    let (mut total, start) = if n % 2 == 1 { (x[0] * y[0], 1) } else { (0.0f32, 0) };
    for i in (start..n).step_by(2) {
        let pair = x[i] * y[i] + x[i + 1] * y[i + 1];
        total = if i == 0 { pair } else { total + pair };
    }
    total
}

/// MATLAB's single `x' * y` on the AVX512_E1 branch: MATLAB's pair tree below 51 elements,
/// and from 51 MKL's `sdot` (64 lanes = four 16-wide `zmm` registers over whole blocks of
/// 64, chunks of 32 and 16 from lane 0, masked tail `< 16` from lane 0, every product
/// fused after the first, folded with strides `[16, 32, 8, 4, 1, 2]`).
pub fn sdot(x: &[f32], y: &[f32]) -> f32 {
    let n = x.len().min(y.len());
    if n < SDOT_MKL_MIN_LENGTH {
        return sdot_pairs(&x[..n], &y[..n]);
    }
    let mut lanes = [None::<f32>; 64];
    let blocked = n / 64 * 64;
    for i in 0..blocked {
        lanes[i % 64] = Some(acc_prod(lanes[i % 64], x[i], y[i]));
    }
    let mut next = blocked;
    for chunk in [32, 16] {
        if n - next >= chunk {
            for k in 0..chunk {
                lanes[k] = Some(acc_prod(lanes[k], x[next + k], y[next + k]));
            }
            next += chunk;
        }
    }
    for (k, i) in (next..n).enumerate() {
        lanes[k] = Some(acc_prod(lanes[k], x[i], y[i]));
    }
    fold_f32(&mut lanes, &[16, 32, 8, 4, 1, 2]).expect("at least 51 products")
}

/// Single 16-wide `zmm` FMA accumulation over `y` and `a`, folded with strides `(8, 4, 2, 1)`.
fn avx512_1x16(y: &[f32], a: &[f32]) -> Option<f32> {
    if y.is_empty() {
        return None;
    }
    let mut lanes = [None::<f32>; 16];
    for (i, (&yi, &ai)) in y.iter().zip(a).enumerate() {
        let l = i % 16;
        lanes[l] = Some(acc_prod(lanes[l], yi, ai));
    }
    fold_f32(&mut lanes, &[8, 4, 2, 1])
}

/// Two 16-wide `zmm` FMA accumulators over blocks of 32 (when `len >= 32`), combined as
/// `z0 += z1`, followed by remaining 16-chunk and tail into `z0`, folded `(8, 4, 2, 1)`.
fn avx512_2x16(y: &[f32], a: &[f32]) -> Option<f32> {
    let n = y.len();
    if n == 0 {
        return None;
    }
    let mut z0 = [None::<f32>; 16];
    let mut i = 0;
    if n >= 32 {
        let mut z1 = [None::<f32>; 16];
        while i + 32 <= n {
            for l in 0..16 {
                z0[l] = Some(acc_prod(z0[l], y[i + l], a[i + l]));
            }
            for l in 0..16 {
                z1[l] = Some(acc_prod(z1[l], y[i + 16 + l], a[i + 16 + l]));
            }
            i += 32;
        }
        for l in 0..16 {
            z0[l] = Some(z0[l].unwrap() + z1[l].unwrap());
        }
    }
    if i + 16 <= n {
        for l in 0..16 {
            z0[l] = Some(acc_prod(z0[l], y[i + l], a[i + l]));
        }
        i += 16;
    }
    for (l, k) in (i..n).enumerate() {
        z0[l] = Some(acc_prod(z0[l], y[k], a[k]));
    }
    fold_f32(&mut z0, &[8, 4, 2, 1])
}

/// Peeled 1x16 dot: `y[0]*a[0] + avx512_1x16(y[1..], a[1..])`.
fn peeled_1x16(y: &[f32], a: &[f32]) -> f32 {
    let head = y[0] * a[0];
    avx512_1x16(&y[1..], &a[1..]).map_or(head, |tail| head + tail)
}

/// Peeled 2x16 dot: `y[0]*a[0] + avx512_2x16(y[1..], a[1..])`.
fn peeled_2x16(y: &[f32], a: &[f32]) -> f32 {
    let head = y[0] * a[0];
    avx512_2x16(&y[1..], &a[1..]).map_or(head, |tail| head + tail)
}

/// Grouped 4-column `sgemv_t` / `sormqr` dot on the AVX512_E1 branch:
/// peels `acc = y[0]*a[0]`, reduces whole 16-chunks (`>= 32` remaining) in 16 fused lanes
/// or an 8-lane split pass (`16..31` remaining: pass 1 fused into `acc` on lane 0, pass 2
/// unfused), then reduces remaining `1..15` elements in power-of-two width (pass 1 fused
/// into `acc` on lane 0, pass 2 unfused).
fn sgemv_grouped(y: &[f32], a: &[f32]) -> f32 {
    let n = y.len();
    let mut acc = y[0] * a[0];
    let mut pos = 1;
    let mut rem = n - 1;
    if rem >= 32 {
        let nfull = (rem / 16) * 16;
        let mut lanes = [0.0f32; 16];
        lanes[0] = y[pos].mul_add(a[pos], acc);
        for l in 1..16 {
            lanes[l] = y[pos + l] * a[pos + l];
        }
        let mut offset = 16;
        while offset < nfull {
            for l in 0..16 {
                lanes[l] = y[pos + offset + l].mul_add(a[pos + offset + l], lanes[l]);
            }
            offset += 16;
        }
        for l in 0..8 {
            lanes[l] += lanes[l + 8];
        }
        for l in 0..4 {
            lanes[l] += lanes[l + 4];
        }
        for l in 0..2 {
            lanes[l] += lanes[l + 2];
        }
        acc = lanes[0] + lanes[1];
        pos += nfull;
        rem -= nfull;
    } else if rem >= 16 {
        let mut lanes = [0.0f32; 8];
        lanes[0] = y[pos].mul_add(a[pos], acc);
        for l in 1..8 {
            lanes[l] = y[pos + l] * a[pos + l];
        }
        for l in 0..8 {
            lanes[l] += y[pos + 8 + l] * a[pos + 8 + l];
        }
        for l in 0..4 {
            lanes[l] += lanes[l + 4];
        }
        for l in 0..2 {
            lanes[l] += lanes[l + 2];
        }
        acc = lanes[0] + lanes[1];
        pos += 16;
        rem -= 16;
    }
    if rem > 0 {
        let width = if rem >= 9 {
            8
        } else if rem >= 5 {
            4
        } else if rem >= 3 {
            2
        } else {
            1
        };
        let mut lanes = [0.0f32; 8];
        lanes[0] = y[pos].mul_add(a[pos], acc);
        for l in 1..width {
            lanes[l] = y[pos + l] * a[pos + l];
        }
        for k in width..rem {
            lanes[k - width] += y[pos + k] * a[pos + k];
        }
        let mut stride = width / 2;
        while stride >= 1 {
            for l in 0..stride {
                lanes[l] += lanes[l + stride];
            }
            stride /= 2;
        }
        acc = lanes[0];
    }
    acc
}

/// MATLAB's single `y' * A` (MKL `sgemv` with `trans`) on the AVX512_E1 branch:
/// columns in whole groups of four (`j < 4 floor(m / 4)`) use `sgemv_grouped`,
/// remainder column 1 (`j - grouped == 1`) uses `peeled_1x16`, and remainder columns
/// 0 and 2 use `peeled_2x16`.
pub fn gemv_t(y: &[f32], columns: &[&[f32]]) -> Vec<f32> {
    let grouped = columns.len() / 4 * 4;
    columns
        .iter()
        .enumerate()
        .map(|(j, a)| {
            assert_eq!(a.len(), y.len(), "column {j} and y differ in length");
            if y.is_empty() {
                0.0
            } else if j < grouped {
                sgemv_grouped(y, a)
            } else if j - grouped == 1 {
                peeled_1x16(y, a)
            } else {
                peeled_2x16(y, a)
            }
        })
        .collect()
}

fn centre_single(values: &[f32]) -> Vec<f32> {
    let mean = sum_single(values) / values.len() as f32;
    values.iter().map(|&v| v - mean).collect()
}

fn vecnorm_single(values: &[f32]) -> f32 {
    values.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>().sqrt() as f32
}

fn limited_f32(r: f32) -> f32 {
    if r.abs() > 1.0 { r / r.abs() } else { r }
}

/// Statistics Toolbox `corr(single(x), single(y))` on the AVX512_E1 branch.
pub fn correlation_single_pair(x: &[f32], y: &[f32]) -> f32 {
    if x.len() != y.len() || x.len() < 2 {
        return f32::NAN;
    }
    let (xc, yc) = (centre_single(x), centre_single(y));
    let (nx, ny) = (vecnorm_single(&xc), vecnorm_single(&yc));
    limited_f32((sdot(&xc, &yc) / nx) / ny)
}

/// Single unsmoothed CF profile `corr(y, X)` on the AVX512_E1 branch.
pub fn cf_profile_single(y: &[f32], seeds: &[&[f32]]) -> Vec<f32> {
    let yc = centre_single(y);
    let ny = vecnorm_single(&yc);
    let centred: Vec<Vec<f32>> = seeds.iter().map(|s| centre_single(s)).collect();
    let columns: Vec<&[f32]> = centred.iter().map(Vec::as_slice).collect();
    gemv_t(&yc, &columns)
        .into_iter()
        .zip(&centred)
        .map(|(p, s)| limited_f32((p / ny) / vecnorm_single(s)))
        .collect()
}

/// Fortran `SIGN(mag, sign_from)`: returns `+abs(mag)` when `sign_from >= 0.0` (including `-0.0`),
/// `-abs(mag)` otherwise.
#[inline]
fn fortran_sign(mag: f32, sign_from: f32) -> f32 {
    if sign_from >= 0.0 { mag.abs() } else { -mag.abs() }
}

fn slapy2(x: f32, y: f32) -> f32 {
    let (x, y) = (x.abs(), y.abs());
    let (w, z) = if x >= y { (x, y) } else { (y, x) };
    if z == 0.0 {
        w
    } else {
        let q = z / w;
        w * (1.0 + q * q).sqrt()
    }
}

fn slapy3(x: f32, y: f32, z: f32) -> f32 {
    let (x, y, z) = (x.abs(), y.abs(), z.abs());
    let w = x.max(y).max(z);
    if w == 0.0 {
        x + y + z
    } else {
        let (a, b, c) = (x / w, y / w, z / w);
        w * (a * a + b * b + c * c).sqrt()
    }
}

/// Reference LAPACK/MKL `snrm2` (scaled sum of squares, `1 + ssq * (r * r)`).
pub fn snrm2(values: &[f32]) -> f32 {
    let mut scale = 0.0f32;
    let mut ssq = 1.0f32;
    for &value in values {
        if value != 0.0 {
            let a = value.abs();
            if scale < a {
                let r = scale / a;
                ssq = 1.0 + ssq * (r * r);
                scale = a;
            } else {
                let r = a / scale;
                ssq += r * r;
            }
        }
    }
    scale * ssq.sqrt()
}

fn scnrm2(values: &[C32]) -> f32 {
    let mut scale = 0.0f32;
    let mut ssq = 1.0f32;
    for z in values {
        for part in [z.re, z.im] {
            if part != 0.0 {
                let a = part.abs();
                if scale < a {
                    let r = scale / a;
                    ssq = 1.0 + ssq * (r * r);
                    scale = a;
                } else {
                    let r = a / scale;
                    ssq += r * r;
                }
            }
        }
    }
    scale * ssq.sqrt()
}

fn slarfg(alpha: f32, x: &mut [f32]) -> (f32, f32) {
    let xnorm = snrm2(x);
    if xnorm == 0.0 {
        return (alpha, 0.0);
    }
    let mut alpha = alpha;
    let mut beta = -fortran_sign(slapy2(alpha, xnorm), alpha);
    let mut rescaled = 0;
    if beta.abs() < SRESCALE {
        loop {
            rescaled += 1;
            for value in x.iter_mut() {
                *value *= 1.0 / SRESCALE;
            }
            beta *= 1.0 / SRESCALE;
            alpha *= 1.0 / SRESCALE;
            if beta.abs() >= SRESCALE || rescaled >= 20 {
                break;
            }
        }
        beta = -fortran_sign(slapy2(alpha, snrm2(x)), alpha);
    }
    let half = if (beta - alpha).is_finite() { 1.0f32 } else { 0.5f32 };
    let (beta_h, alpha_h) = (beta * half, alpha * half);
    let tau = (beta_h - alpha_h) / beta_h;
    let factor = half / (alpha_h - beta_h);
    for value in x.iter_mut() {
        *value *= factor;
    }
    for _ in 0..rescaled {
        beta *= SRESCALE;
    }
    (beta, tau)
}

fn update_real_column(v: &[f32], tau: f32, c: &mut [f32]) {
    let last = v.iter().rposition(|&value| value != 0.0).map_or(0, |i| i + 1);
    let v = &v[..last];
    let w = avx512_2x16(v, &c[1..1 + last]).map_or(c[0], |sum| c[0] + sum);
    let t = tau * w;
    c[0] -= t;
    for (&vi, ci) in v.iter().zip(&mut c[1..]) {
        *ci = (-vi).mul_add(t, *ci);
    }
}

fn apply_real_rhs(v: &[f32], tau: f32, c: &mut [f32], count: usize, index: usize) {
    let grouped = count / 4 * 4;
    let w = if v.is_empty() {
        c[0]
    } else {
        let dot = if index < grouped {
            sgemv_grouped(v, &c[1..])
        } else if index - grouped == 1 {
            peeled_1x16(v, &c[1..])
        } else {
            peeled_2x16(v, &c[1..])
        };
        c[0] + dot
    };
    let t = tau * w;
    c[0] = (-tau).mul_add(w, c[0]);
    for (&vi, ci) in v.iter().zip(&mut c[1..]) {
        *ci = vi.mul_add(-t, *ci);
    }
}

/// Real single-precision design factored by `sgeqp3` on the AVX512_E1 branch.
pub struct RealDesign {
    packed: Vec<Vec<f32>>,
    taus: Vec<f32>,
    pivot: Vec<usize>,
    rank: usize,
}

impl RealDesign {
    pub fn new(columns: &[&[f32]]) -> Self {
        let rows = columns.first().map_or(0, |column| column.len());
        assert!(columns.iter().all(|column| column.len() == rows), "design columns differ in length");
        assert!(columns.iter().all(|column| column.iter().all(|value| value.is_finite())), "the design must be finite");
        let mut a: Vec<Vec<f32>> = columns.iter().map(|column| column.to_vec()).collect();
        let n = a.len();
        let steps = rows.min(n);
        let mut pivot: Vec<usize> = (0..n).collect();
        let mut norms: Vec<f32> = a.iter().map(|column| snrm2(column)).collect();
        let mut original = norms.clone();
        let threshold = f32::EPSILON.sqrt();
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
            let (beta, tau) = slarfg(a[i][i], &mut a[i][i + 1..]);
            a[i][i] = beta;
            taus.push(tau);
            let (done, rest) = a.split_at_mut(i + 1);
            for column in rest {
                update_real_column(&done[i][i + 1..], tau, &mut column[i..]);
            }
            for j in i + 1..n {
                if norms[j] != 0.0 {
                    let ratio = a[j][i].abs() / norms[j];
                    let temp = (1.0 - ratio * ratio).max(0.0);
                    let quotient = norms[j] / original[j];
                    if temp * quotient * quotient <= threshold {
                        norms[j] = snrm2(&a[j][i + 1..]);
                        original[j] = norms[j];
                    } else {
                        norms[j] *= temp.sqrt();
                    }
                }
            }
        }
        let tolerance = rows.max(n) as f32
            * f32::EPSILON
            * a.first().and_then(|column| column.first()).map_or(0.0, |value| value.abs());
        let rank = (0..steps).take_while(|&i| a[i][i].abs() > tolerance).count();
        Self { packed: a, taus, pivot, rank }
    }

    pub fn packed(&self) -> &[Vec<f32>] {
        &self.packed
    }

    pub fn taus(&self) -> &[f32] {
        &self.taus
    }

    pub fn pivot(&self) -> &[usize] {
        &self.pivot
    }

    pub fn rank(&self) -> usize {
        self.rank
    }

    pub fn solve_with_qty(&self, y: &[f32], count: usize, index: usize) -> (Vec<f32>, Vec<f32>) {
        assert_eq!(y.len(), self.packed.first().map_or(0, Vec::len), "design columns and observations differ in length");
        assert!(index < count, "right-hand side {index} of {count}");
        let mut b = y.to_vec();
        for (i, &tau) in self.taus.iter().enumerate() {
            apply_real_rhs(&self.packed[i][i + 1..], tau, &mut b[i..], count, index);
        }
        let n = self.packed.len();
        let mut x = vec![0.0f32; n];
        for i in (0..self.rank).rev() {
            let mut sum = b[i];
            for (column, &xj) in self.packed[i + 1..self.rank].iter().zip(&x[i + 1..self.rank]) {
                sum = (-column[i]).mul_add(xj, sum);
            }
            let diagonal = self.packed[i][i];
            let reciprocal = 1.0f32 / diagonal;
            x[i] = if count > 1 && reciprocal.is_finite() { sum * reciprocal } else { sum / diagonal };
        }
        let mut coefficients = vec![0.0f32; n];
        for (k, &column) in self.pivot.iter().enumerate() {
            coefficients[column] = x[k];
        }
        (coefficients, b)
    }

    pub fn solve(&self, y: &[f32], count: usize, index: usize) -> Vec<f32> {
        self.solve_with_qty(y, count, index).0
    }
}

#[inline]
fn cprod(a: C32, b: C32) -> C32 {
    C32::new(
        a.re.mul_add(b.re, -a.im * b.im),
        a.re.mul_add(b.im, a.im * b.re),
    )
}

/// LAPACK `SLADIV(1, 0, z.re, z.im)`.
fn creciprocal(z: C32) -> C32 {
    let (mut a, mut b, mut c, mut d) = (1.0f32, 0.0f32, z.re, z.im);
    let mut scale = 1.0f32;
    let unit = f32::EPSILON * 0.5;
    let tiny = f32::MIN_POSITIVE * 2.0 / unit;
    let blow_up = 2.0 / (unit * unit);
    let cd = c.abs().max(d.abs());
    if cd >= 0.5 * f32::MAX {
        c *= 0.5;
        d *= 0.5;
        scale *= 0.5;
    }
    if cd <= tiny {
        c *= blow_up;
        d *= blow_up;
        scale *= blow_up;
    }
    let swapped = z.im.abs() > z.re.abs();
    if swapped {
        std::mem::swap(&mut a, &mut b);
        std::mem::swap(&mut c, &mut d);
    }
    let r = d / c;
    let t = 1.0 / (c + d * r);
    let part = |a: f32, b: f32| {
        if r != 0.0 {
            let br = b * r;
            if br != 0.0 { (a + br) * t } else { a * t + (b * t) * r }
        } else {
            (a + d * (b / c)) * t
        }
    };
    let (p, q) = (part(a, b), part(b, -a));
    C32::new(p * scale, if swapped { -q * scale } else { q * scale })
}

fn clarfg(x: &mut [C32]) -> C32 {
    let mut alpha = x[0];
    let mut xn = scnrm2(&x[1..]);
    if xn == 0.0 && alpha.im == 0.0 {
        return C32::new(0.0, 0.0);
    }
    let mut beta = -fortran_sign(slapy3(alpha.re, alpha.im, xn), alpha.re);
    let mut rescaled = 0;
    while beta.abs() < SRESCALE && rescaled < 20 {
        let inv = 1.0 / SRESCALE;
        for z in &mut x[1..] {
            *z = C32::new(z.re * inv, z.im * inv);
        }
        alpha = C32::new(alpha.re * inv, alpha.im * inv);
        beta *= inv;
        rescaled += 1;
    }
    if rescaled > 0 {
        xn = scnrm2(&x[1..]);
        beta = -fortran_sign(slapy3(alpha.re, alpha.im, xn), alpha.re);
    }
    let half = if (beta - alpha.re).is_finite() { 1.0f32 } else { 0.5f32 };
    let (ah, bh) = (C32::new(alpha.re * half, alpha.im * half), beta * half);
    let tau = C32::new((bh - ah.re) / bh, -ah.im / bh);
    let inv = creciprocal(C32::new(ah.re - bh, ah.im));
    let inv = C32::new(inv.re * half, inv.im * half);
    for z in &mut x[1..] {
        // CSCAL fuses the real part of the multiplier in both components.
        *z = C32::new(
            z.re.mul_add(inv.re, -z.im * inv.im),
            z.im.mul_add(inv.re, z.re * inv.im),
        );
    }
    for _ in 0..rescaled {
        beta *= SRESCALE;
    }
    x[0] = C32::new(beta, 0.0);
    tau
}

fn cdotc_8lane(v: &[C32], c: &[C32], rhs: bool) -> C32 {
    let mut lanes = [C32::new(0.0, 0.0); 8];
    if !rhs {
        lanes[0] = c[0];
        for (idx, (&vi, &ci)) in v.iter().zip(&c[1..]).enumerate() {
            let p = cprod(vi.conj(), ci);
            let slot = &mut lanes[(idx + 1) % 8];
            slot.re += p.re;
            slot.im += p.im;
        }
        for l in 0..4 {
            lanes[l] += lanes[l + 4];
        }
        for l in 0..2 {
            lanes[l] += lanes[l + 2];
        }
        lanes[0] + lanes[1]
    } else {
        for (idx, (&vi, &ci)) in v.iter().zip(&c[1..]).enumerate() {
            let p = cprod(vi.conj(), ci);
            let slot = &mut lanes[idx % 8];
            slot.re += p.re;
            slot.im += p.im;
        }
        for l in 0..4 {
            lanes[l] += lanes[l + 4];
        }
        for l in 0..2 {
            lanes[l] += lanes[l + 2];
        }
        c[0] + (lanes[0] + lanes[1])
    }
}

fn apply_complex(v: &[C32], tau: C32, c: &mut [C32], rhs: bool) {
    let last = if rhs {
        v.len()
    } else {
        v.iter().rposition(|z| z.re != 0.0 || z.im != 0.0).map_or(0, |i| i + 1)
    };
    let v = &v[..last];
    let w = cdotc_8lane(v, &c[..last + 1], rhs);
    // MKL computes w * conj(tau) in this operand order, which determines the FMA pairing.
    let tw = cprod(w, tau.conj());
    c[0] -= tw;
    for (&vi, ci) in v.iter().zip(&mut c[1..]) {
        *ci = C32::new(
            vi.im.mul_add(tw.im, (-vi.re).mul_add(tw.re, ci.re)),
            (-vi.re).mul_add(tw.im, (-vi.im).mul_add(tw.re, ci.im)),
        );
    }
}

fn cdivide_real(z: C32, r: f32) -> C32 {
    let (a, b, c) = (f64::from(z.re), f64::from(z.im), f64::from(r));
    let denom = c * c;
    let (re, im) = ((a * c + b * 0.0) / denom, (b * c - a * 0.0) / denom);
    if denom.is_normal() && re.is_finite() && im.is_finite() {
        return C32::new(re as f32, im as f32);
    }
    C32::new(z.re / r, z.im / r)
}

/// Finite, tall two-column complex single-precision design factored by `cgeqp3` on the
/// AVX512_E1 branch.
pub struct ComplexDesign {
    pub packed: Vec<Vec<C32>>,
    pub tau: Vec<C32>,
    pub pivot: Vec<usize>,
    pub rank: usize,
}

impl ComplexDesign {
    pub fn new(columns: &[&[C32]]) -> Self {
        assert_eq!(columns.len(), 2, "complex single Intel QR requires two columns");
        let rows = columns[0].len();
        assert!(rows >= 2 && columns.iter().all(|c| c.len() == rows));
        assert!(columns.iter().flat_map(|c| c.iter()).all(|z| z.re.is_finite() && z.im.is_finite()));
        assert!(columns.iter().flat_map(|c| c.iter()).any(|z| z.im != 0.0), "complex single Intel QR requires a complex design");
        let pivot = if scnrm2(columns[0]) >= scnrm2(columns[1]) {
            vec![0, 1]
        } else {
            vec![1, 0]
        };
        let mut packed: Vec<Vec<C32>> = pivot.iter().map(|&i| columns[i].to_vec()).collect();
        let t1 = clarfg(&mut packed[0]);
        let (first, rest) = packed.split_at_mut(1);
        apply_complex(&first[0][1..], t1, &mut rest[0], false);
        let t2 = clarfg(&mut packed[1][1..]);
        let tolerance = 10.0 * rows as f32 * f32::EPSILON * packed[0][0].re.abs();
        let rank = (0..2).take_while(|&i| packed[i][i].re.abs() > tolerance).count();
        Self { packed, tau: vec![t1, t2], pivot, rank }
    }

    pub fn solve(&self, y: &[f32], count: usize, index: usize) -> (Vec<Complex64>, Vec<Complex64>) {
        assert_eq!(y.len(), self.packed[0].len());
        assert!(index < count && y.iter().all(|v| v.is_finite()));
        let mut q: Vec<C32> = y.iter().map(|&v| C32::new(v, 0.0)).collect();
        for i in 0..2 {
            apply_complex(&self.packed[i][i + 1..], self.tau[i], &mut q[i..], true);
        }
        let mut x = [C32::new(0.0, 0.0); 2];
        if self.rank == 2 {
            x[1] = cdivide_real(q[1], self.packed[1][1].re);
        }
        if self.rank > 0 {
            let mut z = q[0];
            if self.rank == 2 {
                z -= cprod(self.packed[1][0], x[1]);
            }
            x[0] = cdivide_real(z, self.packed[0][0].re);
        }
        let mut ordered = vec![Complex64::new(0.0, 0.0); 2];
        for (i, &p) in self.pivot.iter().enumerate() {
            ordered[p] = Complex64::new(f64::from(x[i].re), f64::from(x[i].im));
        }
        let qty = q.into_iter().map(|v| Complex64::new(f64::from(v.re), f64::from(v.im))).collect();
        (ordered, qty)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_single_products_sum_exactly_at_every_length() {
        for n in 1..200 {
            let x: Vec<f32> = (0..n).map(|i| (i % 5) as f32 - 2.0).collect();
            let y: Vec<f32> = (0..n).map(|i| (i % 3) as f32).collect();
            let exact: f32 = x.iter().zip(&y).map(|(a, b)| a * b).sum();
            assert_eq!(sdot(&x, &y), exact, "sdot n={n}");
            let cols: Vec<&[f32]> = (0..7).map(|_| x.as_slice()).collect();
            assert!(gemv_t(&y, &cols).iter().all(|&v| v == exact), "gemv_t n={n}");
        }
    }

    #[test]
    fn real_and_complex_single_designs_recover_known_solutions() {
        let t: Vec<f32> = (0..37).map(|i| i as f32).collect();
        let ones = vec![1.0f32; 37];
        let y: Vec<f32> = t.iter().map(|&t| 2.0 * t - 3.0).collect();
        let real = RealDesign::new(&[&t, &ones]);
        for (count, index) in [(1, 0), (5, 2), (8, 7)] {
            let beta = real.solve(&y, count, index);
            assert!((beta[0] - 2.0).abs() < 1e-5 && (beta[1] + 3.0).abs() < 1e-4, "{beta:?}");
        }
        let cx: Vec<C32> = (0..16).map(|i| C32::new(i as f32, if i % 2 == 0 { 0.5 } else { -0.5 })).collect();
        let cones = vec![C32::new(1.0, 0.0); 16];
        let cy: Vec<f32> = (0..16).map(|i| 3.0 * i as f32 + 1.0).collect();
        let complex = ComplexDesign::new(&[&cx, &cones]);
        let (beta, _) = complex.solve(&cy, 1, 0);
        assert!(beta[0].re.is_finite() && beta[1].re.is_finite());
        let empty = RealDesign::new(&[&[], &[]]);
        assert_eq!(empty.rank(), 0);
        assert_eq!(empty.solve(&[], 1, 0), vec![0.0, 0.0]);
    }
}
