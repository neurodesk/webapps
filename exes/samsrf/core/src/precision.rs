//! The mixed arithmetic used when SamSrf stores observations as single precision.
//! Predictions and parameters stay double. Scalar division rounds its double result
//! to single; converting the divisor before dividing gives a different objective.
//! The vector reduction follows the R2023b reference. Matrix BLAS and other MATLAB
//! builds can differ by a few single-precision ULPs; this is not a bit-parity promise.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Precision {
    Double,
    Single,
}

impl Precision {
    pub fn round(self, value: f64) -> f64 {
        match self {
            Self::Double => value,
            Self::Single => f64::from(value as f32),
        }
    }

    pub fn round_slice(self, values: &mut [f64]) {
        if self == Self::Single {
            for value in values {
                *value = f64::from(*value as f32);
            }
        }
    }
}

/// R2023b's mean reduction, measured across vector lengths 3 through 2048.
pub(crate) fn mean_double(values: &[f64]) -> f64 {
    let mut sums = [0.0; 4];
    for (index, &value) in values.iter().enumerate() {
        sums[if values.len() >= 44 { index % 4 } else { 0 }] += value;
    }
    sums.iter().sum::<f64>() / values.len() as f64
}

pub(crate) fn mean_complex(values: &[num_complex::Complex64]) -> num_complex::Complex64 {
    let mut sums = [num_complex::Complex64::new(0.0, 0.0); 4];
    for (index, &value) in values.iter().enumerate() {
        sums[if values.len() >= 44 { index % 4 } else { 0 }] += value;
    }
    sums.iter().copied().sum::<num_complex::Complex64>() / values.len() as f64
}

/// MATLAB R2023b's single `exp` as recorded on both CI hosts (`record_single_kernels.m`):
/// the algorithm of fdlibm's float `e_expf.c` (FreeBSD `3a8617a8`, Cygnus/Sun; degree-5
/// rational, `k = trunc(x / ln2 +- 1/2)`, single arithmetic, no FMA) with ln2 split as
/// `0x3f317000` + single(ln2 - hi) and 0 below ln(2^-149). It reproduces 711,289 of
/// 711,307 recorded inputs and every recorded CF Gaussian fit; it is fitted to MATLAB's
/// outputs, not taken from MATLAB's source.
pub fn exp_single(x: f32) -> f32 {
    const LN2_HI: f32 = f32::from_bits(0x3f31_7000);
    const INV_LN2: f32 = f32::from_bits(0x3fb8_aa3b);
    const P: [f32; 5] = [
        f32::from_bits(0x3e2a_aaab),
        f32::from_bits(0xbb36_0b61),
        f32::from_bits(0x388a_b355),
        f32::from_bits(0xb5dd_ea0e),
        f32::from_bits(0x3331_bb4c),
    ];
    let ln2_lo = (std::f64::consts::LN_2 - f64::from(LN2_HI)) as f32;
    if x.is_nan() {
        return x;
    }
    if x > f32::from_bits(0x42b1_7217) {
        return f32::INFINITY;
    }
    if x < (-149.0 * std::f64::consts::LN_2) as f32 {
        return 0.0;
    }
    let magnitude = x.to_bits() & 0x7fff_ffff;
    let negative = x < 0.0;
    let (mut k, mut hi, mut lo, mut r) = (0i32, x, 0.0f32, x);
    if magnitude > 0x3eb1_7218 {
        k = if magnitude < 0x3f85_1592 {
            if negative { -1 } else { 1 }
        } else {
            (INV_LN2 * x + if negative { -0.5 } else { 0.5 }) as i32
        };
        hi = x - k as f32 * LN2_HI;
        lo = k as f32 * ln2_lo;
        r = hi - lo;
    } else if magnitude < 0x3180_0000 {
        return 1.0 + x;
    }
    let t = r * r;
    let mut p = P[4];
    for &q in P[..4].iter().rev() {
        p = q + t * p;
    }
    let c = r - t * p;
    let rc = r * c;
    if k == 0 {
        return 1.0 - (rc / (c - 2.0) - r);
    }
    let y = 1.0 - ((lo - rc / (2.0 - c)) - hi);
    if k >= -125 {
        (f64::from(y) * 2f64.powi(k)) as f32
    } else {
        (f64::from(y) * 2f64.powi(k + 100) * 2f64.powi(-100)) as f32
    }
}

/// MATLAB R2023b's single `sin`, the function `samsrf_benson2srf` applies to the
/// GIfTI's single polar angles. It is fdlibm's float translation (`sf_sin.c`,
/// `kf_sin.c`, `kf_cos.c`, `ef_rem_pio2.c` as in FreeBSD 5.0), every operation in
/// single and no FMA, except for the x/4 term in `__kernel_cosf` (`kernel_cos_single`).
/// Above 2^7 pi/2 (where fdlibm needs `__kernel_rem_pio2f`) the double result is rounded.
/// It is inferred from MATLAB's outputs, not taken from MATLAB's source;
/// `validation/matlab/README.md#single-sin-and-cos` gives the evidence and its range.
pub fn sin_single(x: f32) -> f32 {
    let ix = x.to_bits() & 0x7fff_ffff;
    if ix <= 0x3f49_0fd8 {
        return kernel_sin_single(x, 0.0, false);
    }
    if ix >= 0x7f80_0000 {
        return x - x;
    }
    if ix > MEDIUM_LIMIT {
        return crate::matlab_math::sin(f64::from(x)) as f32;
    }
    let (n, y0, y1) = rem_pio2_single(x);
    match n & 3 {
        0 => kernel_sin_single(y0, y1, true),
        1 => kernel_cos_single(y0, y1),
        2 => -kernel_sin_single(y0, y1, true),
        _ => -kernel_cos_single(y0, y1),
    }
}

/// MATLAB R2023b's single `cos`; see [`sin_single`].
pub fn cos_single(x: f32) -> f32 {
    let ix = x.to_bits() & 0x7fff_ffff;
    if ix <= 0x3f49_0fd8 {
        return kernel_cos_single(x, 0.0);
    }
    if ix >= 0x7f80_0000 {
        return x - x;
    }
    if ix > MEDIUM_LIMIT {
        return crate::matlab_math::cos(f64::from(x)) as f32;
    }
    let (n, y0, y1) = rem_pio2_single(x);
    match n & 3 {
        0 => kernel_cos_single(y0, y1),
        1 => -kernel_sin_single(y0, y1, true),
        2 => -kernel_cos_single(y0, y1),
        _ => kernel_sin_single(y0, y1, true),
    }
}

/// |x| ~<= 2^7 pi/2: the largest argument `ef_rem_pio2.c` reduces without `__kernel_rem_pio2f`.
const MEDIUM_LIMIT: u32 = 0x4349_0f80;

/// `__kernel_sinf(x, y, iy)` on x + y, |x| ~<= pi/4.
fn kernel_sin_single(x: f32, y: f32, tail: bool) -> f32 {
    const S: [u32; 6] = [0xbe2a_aaab, 0x3c08_8889, 0xb950_0d01, 0x3638_ef1b, 0xb2d7_2f34, 0x2f2e_c9d3];
    let s = S.map(f32::from_bits);
    if x.to_bits() & 0x7fff_ffff < 0x3200_0000 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = s[1] + z * (s[2] + z * (s[3] + z * (s[4] + z * s[5])));
    if tail {
        x - ((z * (0.5 * y - v * r) - y) - v * s[0])
    } else {
        x + v * (s[0] + z * r)
    }
}

/// `__kernel_cosf(x, y)` on x + y, |x| ~<= pi/4. Between 0.3 and 0.78125 fdlibm
/// subtracts x/4 exactly from 1 and from z/2; MATLAB's x/4 keeps 11 of its 23
/// fraction bits, as its single `exp` keeps 11 in the high part of ln 2.
fn kernel_cos_single(x: f32, y: f32) -> f32 {
    const C: [u32; 6] = [0x3d2a_aaab, 0xbab6_0b61, 0x37d0_0d01, 0xb493_f27c, 0x310f_74f6, 0xad47_d74e];
    let c = C.map(f32::from_bits);
    let ix = x.to_bits() & 0x7fff_ffff;
    if ix < 0x3200_0000 {
        return 1.0;
    }
    let z = x * x;
    let r = z * (c[0] + z * (c[1] + z * (c[2] + z * (c[3] + z * (c[4] + z * c[5])))));
    if ix < 0x3e99_999a {
        return 1.0 - (0.5 * z - (z * r - x * y));
    }
    let quarter = if ix > 0x3f48_0000 { 0.28125 } else { f32::from_bits((ix - 0x0100_0000) & 0xffff_f000) };
    let hz = 0.5 * z - quarter;
    let a = 1.0 - quarter;
    a - (hz - (z * r - x * y))
}

/// `__ieee754_rem_pio2f` for pi/4 < |x| <= 2^7 pi/2: n and x - n pi/2 as y0 + y1.
fn rem_pio2_single(x: f32) -> (i32, f32, f32) {
    const PIO2_1: f32 = f32::from_bits(0x3fc9_0f80);
    const PIO2_1T: f32 = f32::from_bits(0x3735_4443);
    const PIO2_2: f32 = f32::from_bits(0x3735_4400);
    const PIO2_2T: f32 = f32::from_bits(0x2e85_a308);
    const PIO2_3: f32 = f32::from_bits(0x2e85_a300);
    const PIO2_3T: f32 = f32::from_bits(0x248d_3132);
    const INV_PIO2: f32 = f32::from_bits(0x3f22_f984);
    let hx = x.to_bits();
    let ix = hx & 0x7fff_ffff;
    let negative = hx >> 31 == 1;
    if ix < 0x4016_cbe4 {
        // |x| < 3 pi/4: n = +-1, with a third term of pi/2 near +-pi/2.
        let sign = if negative { -1.0f32 } else { 1.0 };
        let mut z = x - sign * PIO2_1;
        let tail = if ix & 0xffff_fff0 == 0x3fc9_0fd0 {
            z -= sign * PIO2_2;
            PIO2_2T
        } else {
            PIO2_1T
        };
        let y0 = z - sign * tail;
        let y1 = (z - y0) - sign * tail;
        return (if negative { -1 } else { 1 }, y0, y1);
    }
    let t = x.abs();
    let n = (t * INV_PIO2 + 0.5) as i32;
    let n_float = n as f32;
    let mut r = t - n_float * PIO2_1;
    let mut w = n_float * PIO2_1T;
    let mut y0 = r - w;
    // fdlibm's npio2_hw[n - 1]: the high bits of n pi/2 in single.
    let cancels = n >= 32 || ix & 0xffff_ff00 == ((n_float as f64 * std::f64::consts::FRAC_PI_2) as f32).to_bits() & 0xffff_ff00;
    if cancels {
        let exponent = (ix >> 23) as i32;
        let lost = |y: f32| exponent - ((y.to_bits() >> 23) & 0xff) as i32;
        if lost(y0) > 8 {
            let t = r;
            w = n_float * PIO2_2;
            r = t - w;
            w = n_float * PIO2_2T - ((t - r) - w);
            y0 = r - w;
            if lost(y0) > 25 {
                let t = r;
                w = n_float * PIO2_3;
                r = t - w;
                w = n_float * PIO2_3T - ((t - r) - w);
                y0 = r - w;
            }
        }
    }
    let y1 = (r - y0) - w;
    if negative { (-n, -y0, -y1) } else { (n, y0, y1) }
}

/// MATLAB's `sum` of a single vector, R2023b: four lanes from 44 elements.
pub fn sum_single(values: &[f32]) -> f32 {
    if values.len() < 44 {
        return values.iter().copied().fold(0.0, |sum, value| sum + value);
    }
    let mut sums = [0.0f32; 4];
    for (i, &value) in values.iter().enumerate() {
        sums[i % 4] += value;
    }
    sums.iter().copied().fold(0.0, |sum, value| sum + value)
}

fn dot_single(x: &[f32], y: &[f32]) -> f32 {
    let mut sums = [[0.0f32; 4]; 4];
    let mut offset = 0;
    while offset + 32 <= x.len() {
        for i in 0..32 {
            sums[i / 4 % 4][i % 4] += x[offset + i] * y[offset + i];
        }
        offset += 32;
    }
    for size in [16, 8, 4] {
        if offset + size <= x.len() {
            for i in 0..size {
                sums[i / 4][i % 4] += x[offset + i] * y[offset + i];
            }
            offset += size;
        }
    }
    for i in offset..x.len() {
        sums[0][0] += x[i] * y[i];
    }
    let lanes: [f32; 4] = std::array::from_fn(|i| ((sums[0][i] + sums[1][i]) + sums[2][i]) + sums[3][i]);
    (lanes[0] + lanes[2]) + (lanes[1] + lanes[3])
}

/// MATLAB R2023b's single `y' * A` (MKL's `sgemv` with `trans`, CNR `auto` on the AMD
/// CI host), as fingerprinted by `record_gemv_order.m`: columns in full blocks of four
/// use a four-lane kernel, each remaining column an eight-lane kernel. Both start lane
/// 0 with element 0, accumulate elements `1..=lanes * k` with element `i` in lane
/// `(i - 1) % lanes`, fold eight lanes to four as `L[l] + L[l + 4]`, reduce four as
/// `(L0 + L2) + (L1 + L3)` and add the remaining elements in order.
pub fn gemv_t_single(y: &[f32], columns: &[&[f32]]) -> Vec<f32> {
    let full = columns.len() / 4 * 4;
    columns.iter().enumerate().map(|(j, column)| gemv_column(y, column, if j < full { 4 } else { 8 })).collect()
}

fn gemv_column(y: &[f32], a: &[f32], lanes: usize) -> f32 {
    let n = y.len();
    if n == 0 {
        return 0.0;
    }
    let mut lane = [0.0f32; 8];
    lane[0] = y[0] * a[0];
    let body = (n - 1) / lanes * lanes;
    for i in 1..=body {
        lane[(i - 1) % lanes] += y[i] * a[i];
    }
    if lanes == 8 {
        for l in 0..4 {
            lane[l] += lane[l + 4];
        }
    }
    let mut sum = (lane[0] + lane[2]) + (lane[1] + lane[3]);
    for i in body + 1..n {
        sum += y[i] * a[i];
    }
    sum
}

/// Correlate a double prediction and single observations. The coarse fit passes
/// observations first to MATLAB's corr, reversing the order of the two divisions.
pub fn correlation_single(prediction: &[f64], observed: &[f64], observations_first: bool) -> f32 {
    if prediction.len() != observed.len() || prediction.len() < 2 {
        return f32::NAN;
    }
    let observations: Vec<f32> = observed.iter().map(|&value| value as f32).collect();
    let mean_y = sum_single(&observations) / observations.len() as f32;
    let yc: Vec<f32> = observations.iter().map(|value| value - mean_y).collect();
    let mean_x = mean_double(prediction);
    let xc: Vec<f64> = prediction.iter().map(|value| value - mean_x).collect();
    let nx = xc.iter().map(|value| value * value).sum::<f64>().sqrt();
    let ny = yc.iter().map(|&value| f64::from(value).powi(2)).sum::<f64>().sqrt() as f32;
    let xs: Vec<f32> = xc.iter().map(|&value| value as f32).collect();
    let dot = dot_single(&xs, &yc);
    if observations_first {
        let first = dot / ny;
        (f64::from(first) / nx) as f32
    } else {
        let first = (f64::from(dot) / nx) as f32;
        (f64::from(first) / f64::from(ny)) as f32
    }
}

/// Mixed complex prediction and real single observations. MATLAB accumulates
/// these two components in sequence, unlike its real vector dot product.
pub fn correlation_complex_single(x: &[num_complex::Complex64], y: &[f64]) -> num_complex::Complex64 {
    use num_complex::Complex64;
    if x.iter().all(|v| v.im as f32 == 0.0) {
        return Complex64::new(f64::from(correlation_single(&x.iter().map(|v| v.re).collect::<Vec<_>>(), y, false)), 0.0);
    }
    let ys: Vec<f32> = y.iter().map(|&v| v as f32).collect();
    let my = sum_single(&ys) / ys.len() as f32;
    let yc: Vec<f32> = ys.iter().map(|&v| v - my).collect();
    let mx = mean_complex(x);
    let xc: Vec<Complex64> = x.iter().map(|&v| v - mx).collect();
    let nx = xc.iter().map(|v| v.norm_sqr()).sum::<f64>().sqrt();
    let ny = yc.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>().sqrt() as f32;
    let mut real = 0.0f32;
    let mut imaginary = 0.0f32;
    for (x, y) in xc.iter().zip(&yc) {
        real += x.re as f32 * y;
        imaginary -= x.im as f32 * y;
    }
    let divide = |dot: f32| f64::from((f64::from(dot) / nx) as f32 / ny);
    Complex64::new(divide(real), divide(imaginary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_or_mismatched_observations_have_no_correlation() {
        assert!(correlation_single(&[1.0, 2.0], &[1.0], false).is_nan());
        assert!(correlation_single(&[1.0, 2.0], &[1.0, 1.0], false).is_nan());
    }

    #[test]
    fn gemv_uses_four_lanes_for_full_column_blocks_and_eight_for_the_rest() {
        // 2^24 first, ones at elements 10 and 12. Four lanes put both ones in the
        // body (lanes 1 and 3), which meet each other before 2^24: 2^24 + 2. Eight
        // lanes stop the body at element 8 and add the ones one at a time after the
        // reduction, each a tie that rounds back to 2^24.
        let y = [1.0f32; 13];
        let mut a = [0.0f32; 13];
        a[0] = 2f32.powi(24);
        a[10] = 1.0;
        a[12] = 1.0;
        let products = gemv_t_single(&y, &[&a, &a, &a, &a, &a]);
        assert_eq!(products[..4], [2f32.powi(24) + 2.0; 4]);
        assert_eq!(products[4], 2f32.powi(24));
    }

    #[test]
    fn mixed_correlation_matches_the_recorded_matlab_objective() {
        let x: Vec<f64> = (1..=250).map(|t| (f64::from(t) * 2.0f64.sqrt()).sin() * f64::from(1 + t % 7) * 0.1).collect();
        let y: Vec<f64> = (1..=250).map(|t| f64::from((0.3 * (f64::from(t) * 3.0f64.sqrt()).cos() + 0.7 * (f64::from(t) * 2.0f64.sqrt()).sin()) as f32)).collect();
        let r = correlation_single(&x, &y, false);
        // Exact MATLAB scalar from corr_single_n250_offset0.
        assert_eq!(f64::from(r), 0.8235538005828857);
        assert_eq!(f64::from(1.0f32 - r * r), 0.3217591643333435);
    }
}
