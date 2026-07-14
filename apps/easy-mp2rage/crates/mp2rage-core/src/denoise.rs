//! O'Brien et al. 2014 robust combination — removes the strong background noise
//! from an MP2RAGE UNI, producing a "UNI-DEN". Port of Marques' RobustCombination.m.
//!
//! Needs INV1, INV2 and the UNI. `mf` is the noise regularization multiplier
//! (β = (mf · mean background INV2)²). Larger `mf` → cleaner background.

use ndarray::Array3;

use crate::interp::round_half_even;

#[inline]
fn np_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// Denoise a UNI via robust combination. Returns the denoised UNI (0..4095 when
/// the input looked like an integer UNI, else the raw [-0.5, 0.5] combination).
pub fn robust_combination(uni: &Array3<f64>, inv1: &Array3<f64>, inv2: &Array3<f64>, mf: f64) -> Array3<f64> {
    let (nx, ny, nz) = uni.dim();
    let maxv = uni.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let minv = uni.iter().cloned().fold(f64::INFINITY, f64::min);
    let integer = minv >= 0.0 && maxv >= 0.51;

    // background noise = mean INV2 over the [:, ny-11.., nz-11..] corner slab
    let (j0, k0) = (ny.saturating_sub(11), nz.saturating_sub(11));
    let mut csum = 0.0;
    let mut ccnt = 0usize;
    for i in 0..nx {
        for j in j0..ny {
            for k in k0..nz {
                csum += inv2[[i, j, k]];
                ccnt += 1;
            }
        }
    }
    let corner = if ccnt > 0 { csum / ccnt as f64 } else { 0.0 };
    let noise = if corner != 0.0 { mf * corner } else { mf };
    let beta = noise * noise;

    let mut out = Array3::<f64>::zeros((nx, ny, nz));
    for (idx, &uraw) in uni.indexed_iter() {
        let u = if integer { (uraw - maxv / 2.0) / maxv } else { uraw };
        let (i1, i2) = (inv1[idx], inv2[idx]);
        let inv1s = np_sign(u) * i1;
        let sq = (i2 * i2 - 4.0 * u * u * i2 * i2).sqrt();
        let inv1pos = (-i2 + sq) / (-2.0 * u);
        let inv1neg = (-i2 - sq) / (-2.0 * u);
        let dpos = (inv1s - inv1pos).abs();
        let dneg = (inv1s - inv1neg).abs();
        // MATLAB selection: NaN comparisons are false, so the value stays inv1s
        let mut inv1final = inv1s;
        if dpos > dneg {
            inv1final = inv1neg;
        }
        if dpos <= dneg {
            inv1final = inv1pos;
        }
        let robust = (inv1final * i2 - beta) / (inv1final * inv1final + i2 * i2 + 2.0 * beta);
        out[idx] = if integer { round_half_even(4095.0 * (robust + 0.5)) } else { robust };
    }
    out
}
