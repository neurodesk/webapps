//! Brain mask + percentile, matching the Python `brain_mask` and `np.percentile`.

use ndarray::Array3;

use crate::filt::{binary_closing, binary_fill_holes};

/// `np.percentile(values, q)` with the default 'linear' method.
pub fn percentile(values: &[f64], q: f64) -> f64 {
    let mut v: Vec<f64> = values.to_vec();
    // total_cmp never panics (partial_cmp().unwrap() panics on a NaN voxel); for
    // NaN-free inputs it orders identically, so golden parity is preserved.
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    if n == 0 {
        return f64::NAN;
    }
    if n == 1 {
        return v[0];
    }
    let rank = q / 100.0 * ((n - 1) as f64);
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    let frac = rank - lo as f64;
    v[lo] + frac * (v[hi] - v[lo])
}

/// Crude head/brain mask from a magnitude image (port of `brain_mask`):
/// threshold at `frac * p99.5`, close (2 iters), fill holes.
pub fn brain_mask(vol: &Array3<f64>, frac: f64) -> Array3<bool> {
    let flat: Vec<f64> = vol.iter().copied().collect();
    let thr = frac * percentile(&flat, 99.5);
    let m = vol.mapv(|x| x > thr);
    let m = binary_closing(&m, 2);
    binary_fill_holes(&m)
}
