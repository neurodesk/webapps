//! Interpolation + numeric primitives ported to match NumPy/SciPy exactly.
//!
//! The parity of the whole pipeline hinges on these matching the Python
//! reference bit-for-bit-ish (within f64 rounding): `np.arange` lengths,
//! `np.interp`, `np.argmax/argmin` first-tie, banker's rounding, and
//! SciPy's Fritsch–Carlson `PchipInterpolator`.

/// NumPy-exact `np.arange(start, stop, step)`. Reproduces both the length
/// (`ceil((stop-start)/step)`) and the exact bit pattern of every element.
///
/// NumPy's float fill is NOT `start + i*step`: it sets `buffer[1] = start+step`,
/// takes `delta = (start+step) - start`, and computes `buffer[i]` with a fused
/// multiply-add `fma(i, delta, start)`. Getting this bit-exact matters — a 1-ULP
/// drift can flip a value across a lookup-table edge and turn a real number into
/// a NaN sentinel. Rust's `mul_add` is the same IEEE-754 fused operation.
pub fn arange(start: f64, stop: f64, step: f64) -> Vec<f64> {
    let n = ((stop - start) / step).ceil().max(0.0) as usize;
    let mut out = vec![0.0f64; n];
    if n >= 1 {
        out[0] = start;
    }
    if n >= 2 {
        out[1] = start + step;
        let delta = (start + step) - start;
        for i in 2..n {
            out[i] = (i as f64).mul_add(delta, start);
        }
    }
    out
}

/// NumPy `sign`: 0.0 maps to 0.0 (unlike Rust's `f64::signum`).
#[inline]
pub fn np_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// First-occurrence argmax (ties -> lowest index), matching `np.argmax`.
pub fn argmax(v: &[f64]) -> usize {
    let mut best = 0usize;
    for i in 1..v.len() {
        if v[i] > v[best] {
            best = i;
        }
    }
    best
}

/// First-occurrence argmin, matching `np.argmin`.
pub fn argmin(v: &[f64]) -> usize {
    let mut best = 0usize;
    for i in 1..v.len() {
        if v[i] < v[best] {
            best = i;
        }
    }
    best
}

/// Round half to even (banker's rounding) — matches `np.round`.
/// Rust's `f64::round` is half-away-from-zero, which differs.
#[inline]
pub fn round_half_even(x: f64) -> f64 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 {
        // exactly halfway: pick the even neighbour
        let f = x.floor();
        if (f as i64) % 2 == 0 {
            f
        } else {
            f + 1.0
        }
    } else {
        r
    }
}

/// `np.interp(x, xp, fp, left, right)` for **ascending** `xp`.
/// Values below `xp[0]` -> `left`, above `xp[last]` -> `right`
/// (x exactly at an endpoint interpolates to `fp` there).
pub fn np_interp(x: f64, xp: &[f64], fp: &[f64], left: f64, right: f64) -> f64 {
    let n = xp.len();
    if n == 0 {
        return f64::NAN;
    }
    if x < xp[0] {
        return left;
    }
    if x > xp[n - 1] {
        return right;
    }
    // binary search for the interval [xp[i], xp[i+1]] containing x
    let mut lo = 0usize;
    let mut hi = n - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if xp[mid] <= x {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    if x == xp[lo] {
        return fp[lo];
    }
    if x == xp[hi] {
        return fp[hi];
    }
    let t = (x - xp[lo]) / (xp[hi] - xp[lo]);
    fp[lo] + t * (fp[hi] - fp[lo])
}

/// Vectorised `np.interp` over many query points (ascending `xp`).
pub fn np_interp_vec(xs: &[f64], xp: &[f64], fp: &[f64], left: f64, right: f64) -> Vec<f64> {
    xs.iter().map(|&x| np_interp(x, xp, fp, left, right)).collect()
}

/// `np.interp` on a monotonically **decreasing** table (reverses then interps),
/// matching the Python `_interp_decreasing`.
pub fn interp_decreasing(x_dec: &[f64], y: &[f64], query: &[f64], left: f64, right: f64) -> Vec<f64> {
    let xi: Vec<f64> = x_dec.iter().rev().copied().collect();
    let yi: Vec<f64> = y.iter().rev().copied().collect();
    np_interp_vec(query, &xi, &yi, left, right)
}

// ---------------------------------------------------------------------------
// PCHIP  (SciPy PchipInterpolator, extrapolate=False -> NaN outside)
// ---------------------------------------------------------------------------

fn pchip_edge_case(h0: f64, h1: f64, m0: f64, m1: f64) -> f64 {
    let mut d = ((2.0 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
    if np_sign(d) != np_sign(m0) {
        d = 0.0;
    } else if np_sign(m0) != np_sign(m1) && d.abs() > 3.0 * m0.abs() {
        d = 3.0 * m0;
    }
    d
}

/// SciPy `_find_derivatives`: Fritsch–Carlson node derivatives for PCHIP.
fn pchip_derivatives(x: &[f64], y: &[f64]) -> Vec<f64> {
    let n = x.len();
    let mut d = vec![0.0f64; n];
    let hk: Vec<f64> = (0..n - 1).map(|i| x[i + 1] - x[i]).collect();
    let mk: Vec<f64> = (0..n - 1).map(|i| (y[i + 1] - y[i]) / hk[i]).collect();
    if n == 2 {
        d[0] = mk[0];
        d[1] = mk[0];
        return d;
    }
    for k in 1..n - 1 {
        let (m0, m1) = (mk[k - 1], mk[k]);
        if np_sign(m0) != np_sign(m1) || m0 == 0.0 || m1 == 0.0 {
            d[k] = 0.0;
        } else {
            let (h0, h1) = (hk[k - 1], hk[k]);
            let w1 = 2.0 * h1 + h0;
            let w2 = h1 + 2.0 * h0;
            let whmean = (w1 / m0 + w2 / m1) / (w1 + w2);
            d[k] = 1.0 / whmean;
        }
    }
    d[0] = pchip_edge_case(hk[0], hk[1], mk[0], mk[1]);
    d[n - 1] = pchip_edge_case(hk[n - 2], hk[n - 3], mk[n - 2], mk[n - 3]);
    d
}

/// Evaluate a PCHIP given sorted-unique nodes; NaN outside `[x[0], x[last]]`.
fn pchip_eval(x: &[f64], y: &[f64], d: &[f64], xq: f64) -> f64 {
    let n = x.len();
    if xq < x[0] || xq > x[n - 1] {
        return f64::NAN;
    }
    // interval [x[k], x[k+1]]
    let mut lo = 0usize;
    let mut hi = n - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if x[mid] <= xq {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let k = lo;
    let h = x[k + 1] - x[k];
    let t = (xq - x[k]) / h;
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    y[k] * h00 + h * d[k] * h10 + y[k + 1] * h01 + h * d[k + 1] * h11
}

/// Port of the Python `_pchip_safe`: drop non-finite pairs, sort by x, dedup
/// (keep first), require >=2 unique; NaN outside the data range.
pub fn pchip_safe(x: &[f64], y: &[f64], xq: &[f64]) -> Vec<f64> {
    let nanvec = || vec![f64::NAN; xq.len()];
    // keep finite pairs
    let mut pairs: Vec<(f64, f64)> = x
        .iter()
        .zip(y.iter())
        .filter(|(a, b)| a.is_finite() && b.is_finite())
        .map(|(a, b)| (*a, *b))
        .collect();
    if pairs.len() < 2 {
        return nanvec();
    }
    // stable sort by x (matches np.argsort default quicksort result for distinct
    // keys; stability only matters for equal x, which we then dedup keeping first)
    pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    // dedup consecutive equal x, keeping the first occurrence's y
    let mut ux: Vec<f64> = Vec::with_capacity(pairs.len());
    let mut uy: Vec<f64> = Vec::with_capacity(pairs.len());
    for (xi, yi) in pairs {
        if ux.last().map_or(true, |&last| last != xi) {
            ux.push(xi);
            uy.push(yi);
        }
    }
    if ux.len() < 2 {
        return nanvec();
    }
    let d = pchip_derivatives(&ux, &uy);
    xq.iter().map(|&q| pchip_eval(&ux, &uy, &d, q)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arange_lengths() {
        assert_eq!(arange(0.05, 5.0 + 1e-9, 0.05).len(), 100);
        assert_eq!(arange(0.005, 2.5 + 1e-9, 0.005).len(), 500);
        assert_eq!(arange(0.5, 5.2 + 1e-9, 0.05).len(), 95);
        assert_eq!(arange(0.005, 1.9 + 1e-9, 0.05).len(), 38);
    }

    #[test]
    fn banker_rounding() {
        assert_eq!(round_half_even(0.5), 0.0);
        assert_eq!(round_half_even(1.5), 2.0);
        assert_eq!(round_half_even(2.5), 2.0);
        assert_eq!(round_half_even(-0.5), 0.0);
        assert_eq!(round_half_even(2.4), 2.0);
        assert_eq!(round_half_even(2.6), 3.0);
    }
}
