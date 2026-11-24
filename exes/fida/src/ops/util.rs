//! MATLAB semantics the ops rely on: FFT conventions, N-d indexing over a
//! column-major `sz`, `squeeze`, and the statistics (`mean`, `std`,
//! `median`, `polyfit`, FID-A's `phase`) with MATLAB's definitions.

use num_complex::Complex64 as C;
use rustfft::{Fft, FftPlanner};
use std::cell::RefCell;
use std::sync::Arc;

use crate::spectra::{fftshift, Dims, Spectra};

thread_local! {
    static PLANNER: RefCell<FftPlanner<f64>> = RefCell::new(FftPlanner::new());
}

fn plan(n: usize, inverse: bool) -> Arc<dyn Fft<f64>> {
    PLANNER.with(|p| {
        let mut p = p.borrow_mut();
        if inverse {
            p.plan_fft_inverse(n)
        } else {
            p.plan_fft_forward(n)
        }
    })
}

/// MATLAB `fft` (unnormalised) in place.
pub fn fft_in_place(x: &mut [C]) {
    if x.len() > 1 {
        plan(x.len(), false).process(x);
    }
}

/// MATLAB `ifft` (divides by N) in place.
pub fn ifft_in_place(x: &mut [C]) {
    let n = x.len();
    if n > 1 {
        plan(n, true).process(x);
    }
    let s = 1.0 / n as f64;
    for v in x.iter_mut() {
        *v *= s;
    }
}

/// FID-A `specs = fftshift(ifft(fids))` of one FID.
pub fn spec(fid: &[C]) -> Vec<C> {
    let mut b = fid.to_vec();
    ifft_in_place(&mut b);
    fftshift(&b)
}

/// FID-A's inverse of `spec`: `fft(fftshift(specs))` for an even length and
/// `fft(circshift(fftshift(specs),1))` for an odd one (op_freqrange,
/// op_addphase), which is the exact inverse in both cases.
pub fn fid_from_spec(spec: &[C]) -> Vec<C> {
    let n = spec.len();
    let mut b = fftshift(spec);
    if n % 2 == 1 {
        b.rotate_right(1);
    }
    fft_in_place(&mut b);
    b
}

/// All spectra of a structure, column-major like `fids`.
pub fn specs(s: &Spectra) -> Vec<C> {
    let n = s.n();
    let mut out = Vec::with_capacity(s.fids.len());
    for k in 0..s.n_fids() {
        out.extend(spec(&s.fids[k * n..(k + 1) * n]));
    }
    out
}

/// Set `fids` from spectra with `fid_from_spec`.
pub fn set_from_specs(s: &mut Spectra, specs: &[C]) {
    let n = s.n();
    for k in 0..s.n_fids() {
        let f = fid_from_spec(&specs[k * n..(k + 1) * n]);
        s.fids[k * n..(k + 1) * n].copy_from_slice(&f);
    }
}

/// MATLAB `squeeze`: drop every singleton dimension, keep at least two.
pub fn squeeze(sz: &[usize]) -> Vec<usize> {
    if sz.len() <= 2 {
        return sz.to_vec();
    }
    let mut out: Vec<usize> = sz.iter().copied().filter(|&d| d != 1).collect();
    while out.len() < 2 {
        out.push(1);
    }
    out
}

/// MATLAB `size`: trailing singleton dimensions beyond the second dropped.
pub fn trim(sz: &[usize]) -> Vec<usize> {
    let mut out = sz.to_vec();
    while out.len() > 2 && *out.last().unwrap() == 1 {
        out.pop();
    }
    while out.len() < 2 {
        out.push(1);
    }
    out
}

/// `(inner, len, outer)` strides of 0-based `axis` over column-major `sz`.
pub fn strides(sz: &[usize], axis: usize) -> (usize, usize, usize) {
    let inner: usize = sz[..axis.min(sz.len())].iter().product();
    let len = sz.get(axis).copied().unwrap_or(1);
    let outer: usize = if axis + 1 < sz.len() { sz[axis + 1..].iter().product() } else { 1 };
    (inner, len, outer)
}

/// Reduce 0-based `axis` with `f` over each line (the line is passed in
/// order). The result has that axis of length 1, same layout otherwise.
pub fn reduce_axis(x: &[C], sz: &[usize], axis: usize, mut f: impl FnMut(&[C]) -> C) -> Vec<C> {
    let (inner, len, outer) = strides(sz, axis);
    let mut out = vec![C::new(0.0, 0.0); inner * outer];
    let mut line = vec![C::new(0.0, 0.0); len];
    for o in 0..outer {
        for i in 0..inner {
            for (k, v) in line.iter_mut().enumerate() {
                *v = x[i + inner * (k + len * o)];
            }
            out[i + inner * o] = f(&line);
        }
    }
    out
}

/// MATLAB `sum(x, axis)` accumulated in index order.
pub fn sum_axis(x: &[C], sz: &[usize], axis: usize) -> Vec<C> {
    let (inner, len, outer) = strides(sz, axis);
    let mut out = vec![C::new(0.0, 0.0); inner * outer];
    for o in 0..outer {
        for k in 0..len {
            let src = &x[inner * (k + len * o)..inner * (k + 1 + len * o)];
            let dst = &mut out[inner * o..inner * (o + 1)];
            for (d, s) in dst.iter_mut().zip(src) {
                *d += s;
            }
        }
    }
    out
}

/// `x(:,...,idx,...,:)` along 0-based `axis` (indices 0-based).
pub fn select_axis(x: &[C], sz: &[usize], axis: usize, idx: &[usize]) -> Vec<C> {
    let (inner, len, outer) = strides(sz, axis);
    let mut out = Vec::with_capacity(inner * idx.len() * outer);
    for o in 0..outer {
        for &k in idx {
            out.extend_from_slice(&x[inner * (k + len * o)..inner * (k + 1 + len * o)]);
        }
    }
    out
}

/// Size of `sz` with 0-based `axis` set to `n`, as MATLAB `size` reports it.
pub fn with_axis(sz: &[usize], axis: usize, n: usize) -> Vec<usize> {
    let mut s = sz.to_vec();
    while s.len() <= axis {
        s.push(1);
    }
    s[axis] = n;
    trim(&s)
}

/// FID-A's dims bookkeeping after removing the 1-based dimension `removed`:
/// every dimension above it moves down by one, the removed one becomes 0.
pub fn dims_without(d: Dims, removed: usize) -> Dims {
    let f = |x: usize| if x == removed { 0 } else if x > removed { x - 1 } else { x };
    Dims { t: f(d.t), coils: f(d.coils), averages: f(d.averages), sub_specs: f(d.sub_specs), extras: f(d.extras) }
}

/// Set the 1-based `axis` of `sz` to `new_len`, apply MATLAB `squeeze`
/// (`squeeze(&with_axis(sz, axis - 1, new_len))`), and remap `dims` so every
/// singleton dimension dropped by `trim`/`squeeze` (and `axis` itself when
/// `drop_axis` is true) becomes 0 while surviving axes point to their new
/// 1-based positions.
pub fn squeeze_axis_len(sz: &[usize], dims: Dims, axis: usize, new_len: usize, drop_axis: bool) -> (Vec<usize>, Dims) {
    let trimmed = with_axis(sz, axis - 1, new_len);
    if trimmed.len() <= 2 {
        let map = |d: usize| if d == 0 || (drop_axis && d == axis) || d > 2 { 0 } else { d };
        return (
            trimmed,
            Dims { t: map(dims.t), coils: map(dims.coils), averages: map(dims.averages), sub_specs: map(dims.sub_specs), extras: map(dims.extras) },
        );
    }
    let mut new_pos = vec![0usize; trimmed.len() + 1];
    let mut out_sz = Vec::new();
    for (idx0, &len) in trimmed.iter().enumerate() {
        let axis1 = idx0 + 1;
        if !(drop_axis && axis1 == axis) && len != 1 {
            out_sz.push(len);
            new_pos[axis1] = out_sz.len();
        }
    }
    while out_sz.len() < 2 {
        out_sz.push(1);
    }
    let map = |d: usize| if d == 0 || d >= new_pos.len() { 0 } else { new_pos[d] };
    (
        out_sz,
        Dims { t: map(dims.t), coils: map(dims.coils), averages: map(dims.averages), sub_specs: map(dims.sub_specs), extras: map(dims.extras) },
    )
}

/// Set the 1-based `removed` axis of `sz` to length 1, apply MATLAB `squeeze`
/// (`squeeze(&with_axis(sz, removed - 1, 1))`), and remap `dims` so `removed`
/// and every other singleton dimension dropped by `trim`/`squeeze` become 0
/// while surviving axes point to their new 1-based positions.
pub fn squeeze_axis(sz: &[usize], dims: Dims, removed: usize) -> (Vec<usize>, Dims) {
    squeeze_axis_len(sz, dims, removed, 1, true)
}

/// FID-A frequency axis for `n` points: `ppm = -f/(Bo*42.577)+4.65` with
/// `f = -sw/2+sw/(2n) : sw/n : sw/2-sw/(2n)`.
pub fn ppm_axis(n: usize, sw: f64, bo: f64) -> Vec<f64> {
    colon(-sw / 2.0 + sw / (2.0 * n as f64), sw / n as f64, sw / 2.0 - sw / (2.0 * n as f64))
        .into_iter()
        .map(|f| -f / (bo * 42.577) + 4.65)
        .collect()
}

/// FID-A time axis `0:dwelltime:(n-1)*dwelltime`.
pub fn t_axis(n: usize, dt: f64) -> Vec<f64> {
    colon(0.0, dt, (n as f64 - 1.0) * dt)
}

/// MATLAB's colon `a:d:b` (element count and the symmetric evaluation
/// MATLAB uses: the first half from `a`, the second half from `b`).
pub fn colon(a: f64, d: f64, b: f64) -> Vec<f64> {
    if d == 0.0 || (d > 0.0 && a > b) || (d < 0.0 && a < b) {
        return Vec::new();
    }
    let tol = 2.0 * f64::EPSILON * a.abs().max(b.abs());
    let n = ((b - a) / d + tol / d.abs()).floor() as i64 + 1;
    if n <= 0 {
        return Vec::new();
    }
    let n = n as usize;
    let last = a + (n - 1) as f64 * d;
    let end = if (last - b).abs() <= tol { b } else { last };
    let half = n / 2;
    (0..n)
        .map(|k| if k < half { a + k as f64 * d } else { end - (n - 1 - k) as f64 * d })
        .collect()
}

pub fn mean(x: &[f64]) -> f64 {
    x.iter().sum::<f64>() / x.len() as f64
}

/// MATLAB `std` (normalised by N-1; 0 for a single value).
pub fn std(x: &[f64]) -> f64 {
    let n = x.len();
    if n < 2 {
        return 0.0;
    }
    let m = mean(x);
    (x.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / (n - 1) as f64).sqrt()
}

/// MATLAB `std` of complex data: sqrt(sum |x-mean|^2/(N-1)).
pub fn std_c(x: &[C]) -> f64 {
    let n = x.len();
    if n < 2 {
        return 0.0;
    }
    let m = x.iter().sum::<C>() / n as f64;
    (x.iter().map(|v| (v - m).norm_sqr()).sum::<f64>() / (n - 1) as f64).sqrt()
}

/// MATLAB `median` (mean of the two middle values for an even count).
pub fn median(x: &[f64]) -> f64 {
    let mut v = x.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n == 0 {
        return f64::NAN;
    }
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// MATLAB `polyfit(x, y, deg)` for complex `y` (coefficients highest power
/// first), solved like MATLAB by a QR factorisation of the Vandermonde matrix.
pub fn polyfit_c(x: &[f64], y: &[C], deg: usize) -> Vec<C> {
    let m = x.len();
    let n = deg + 1;
    let mut a = crate::ops::linalg::CMat::zeros(m, n);
    for i in 0..m {
        for j in 0..n {
            a[(i, j)] = C::new(x[i].powi((deg - j) as i32), 0.0);
        }
    }
    let b = crate::ops::linalg::CMat::from_col(y);
    crate::ops::linalg::lstsq(&a, &b).col(0)
}

/// MATLAB `polyfit(x, y, deg)` for real data.
pub fn polyfit(x: &[f64], y: &[f64], deg: usize) -> Vec<f64> {
    let yc: Vec<C> = y.iter().map(|&v| C::new(v, 0.0)).collect();
    polyfit_c(x, &yc, deg).into_iter().map(|c| c.re).collect()
}

/// MATLAB `polyval`.
pub fn polyval(p: &[f64], x: f64) -> f64 {
    p.iter().fold(0.0, |acc, &c| acc * x + c)
}

pub fn polyval_c(p: &[C], x: f64) -> C {
    p.iter().fold(C::new(0.0, 0.0), |acc, &c| acc * x + c)
}

/// FID-A's `phase`: `atan2(imag, real)` of a vector, unwrapped wherever
/// consecutive values differ by more than 3.5 rad.
pub fn phase(g: &[C]) -> Vec<f64> {
    let mut phi: Vec<f64> = g.iter().map(|z| z.im.atan2(z.re)).collect();
    let n = phi.len();
    let df: Vec<f64> = (0..n.saturating_sub(1)).map(|i| phi[i] - phi[i + 1]).collect();
    let mut add = 0.0;
    let mut jumps = vec![0.0; n];
    for i in 0..df.len() {
        if df[i].abs() > 3.5 {
            jumps[i + 1] += 2.0 * std::f64::consts::PI * df[i].signum();
        }
    }
    for k in 0..n {
        add += jumps[k];
        phi[k] += add;
    }
    phi
}

/// `phase` of a scalar: `atan2(imag, real)`.
pub fn phase1(z: C) -> f64 {
    z.im.atan2(z.re)
}

/// Indices of `max` in the MATLAB sense of `find(x == max(x))`: all ties.
pub fn find_max(x: &[f64]) -> Vec<usize> {
    let m = x.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (0..x.len()).filter(|&i| x[i] == m).collect()
}

/// `exp(1i*ph*pi/180)`: FID-A's `addphase` factor.
pub fn phasor_deg(ph: f64) -> C {
    C::new(0.0, ph * std::f64::consts::PI / 180.0).exp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colon_counts() {
        assert_eq!(colon(0.0, 0.1, 0.3).len(), 4);
        assert_eq!(colon(0.0, 1.0, 4.0), vec![0.0, 1.0, 2.0, 3.0, 4.0]);
        assert!(colon(1.0, 1.0, 0.0).is_empty());
    }

    #[test]
    fn squeeze_and_trim() {
        assert_eq!(squeeze(&[4096, 1, 16]), vec![4096, 16]);
        assert_eq!(squeeze(&[4096, 1, 1]), vec![4096, 1]);
        assert_eq!(trim(&[4096, 16, 1]), vec![4096, 16]);
    }

    #[test]
    fn statistics() {
        assert_eq!(median(&[3.0, 1.0, 2.0, 10.0]), 2.5);
        assert!((std(&[1.0, 2.0, 3.0, 4.0]) - 1.2909944487358056).abs() < 1e-15);
        let p = polyfit(&[1.0, 2.0, 3.0, 4.0], &[3.0, 5.0, 7.0, 9.0], 1);
        assert!((p[0] - 2.0).abs() < 1e-12 && (p[1] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn odd_spec_round_trip() {
        let fid: Vec<C> = (0..7).map(|k| C::new(k as f64, 1.0 - k as f64)).collect();
        let back = fid_from_spec(&spec(&fid));
        for (a, b) in fid.iter().zip(&back) {
            assert!((a - b).norm() < 1e-12);
        }
    }

    #[test]
    fn phase_unwraps() {
        let z: Vec<C> = (0..20).map(|k| C::new(0.0, 0.5 * k as f64).exp()).collect();
        let p = phase(&z);
        for (k, v) in p.iter().enumerate() {
            assert!((v - 0.5 * k as f64).abs() < 1e-12);
        }
    }
}
