//! Models of the arithmetic MATLAB R2023b performs inside SamSrf's double CSS
//! objective, checked against pinned MATLAB recordings on the inputs listed in
//! `packages/samsrf/validation/matlab/README.md#double-css-arithmetic`. They are not
//! claims about MATLAB on other inputs, releases or CPUs.
//!
//! Two kinds of code live here:
//! - Ported source. `log`, `sin` and `cos` are translated from fdlibm 5.3 as published
//!   at https://netlib.org/fdlibm/ (`e_log.c` 1.3, `k_sin.c` 1.3, `k_cos.c` 1.3,
//!   `s_sin.c` 1.3, `s_cos.c` 1.3, `e_rem_pio2.c` 1.4, all SCCS 95/01/18; SHA-256
//!   a2b1bd1b, 75d391f3, 841086c7, 4d5edb75, bdcbea3c, 3a08dd4a). `exp` and `pow`
//!   use `libm` 0.2.16, which matched fdlibm's `e_exp.c` 1.6 and `e_pow.c` 1.5 on
//!   every input tested. Large `sin`/`cos` arguments (above 2^19 pi/2) use `libm`.
//! - Empirical models, inferred from recorded results: MATLAB's complex power,
//!   `conv` and Intel MKL 2021.3's dot products and norms. MKL's kernels are those
//!   the AMD reference hosts select; Intel hosts reduce in other orders.
//!
//! ====================================================
//! Copyright (C) 1993, 2004 by Sun Microsystems, Inc. All rights reserved.
//!
//! Developed at SunSoft, a Sun Microsystems, Inc. business.
//! Permission to use, copy, modify, and distribute this
//! software is freely granted, provided that this notice
//! is preserved.
//! ====================================================

// fdlibm's constants are kept digit for digit as published.
#![allow(clippy::excessive_precision)]

use num_complex::Complex64;

pub fn exp(x: f64) -> f64 {
    libm::exp(x)
}

pub fn pow(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}

fn high(x: f64) -> i32 {
    (x.to_bits() >> 32) as i32
}

fn low(x: f64) -> u32 {
    x.to_bits() as u32
}

fn with_high(x: f64, hi: i32) -> f64 {
    f64::from_bits((u64::from(hi as u32) << 32) | u64::from(low(x)))
}

/// fdlibm `__ieee754_log`.
pub fn log(mut x: f64) -> f64 {
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const TWO54: f64 = 1.80143985094819840000e+16;
    const LG1: f64 = 6.666666666666735130e-01;
    const LG2: f64 = 3.999999999940941908e-01;
    const LG3: f64 = 2.857142874366239149e-01;
    const LG4: f64 = 2.222219843214978396e-01;
    const LG5: f64 = 1.818357216161805012e-01;
    const LG6: f64 = 1.531383769920937332e-01;
    const LG7: f64 = 1.479819860511658591e-01;
    let mut hx = high(x);
    let lx = low(x);
    let mut k = 0i32;
    if hx < 0x0010_0000 {
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return -TWO54 / 0.0;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x0010_0000;
    x = with_high(x, hx | (i ^ 0x3ff0_0000));
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = f64::from(k);
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - 0.33333333333333333 * f);
        if k == 0 {
            return f - r;
        }
        let dk = f64::from(k);
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

fn kernel_sin(x: f64, y: f64, iy: bool) -> f64 {
    const S1: f64 = -1.66666666666666324348e-01;
    const S2: f64 = 8.33333333332248946124e-03;
    const S3: f64 = -1.98412698298579493134e-04;
    const S4: f64 = 2.75573137070700676789e-06;
    const S5: f64 = -2.50507602534068634195e-08;
    const S6: f64 = 1.58969099521155010221e-10;
    let ix = high(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && x as i32 == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if iy {
        x - ((z * (0.5 * y - v * r) - y) - v * S1)
    } else {
        x + v * (S1 + z * r)
    }
}

fn kernel_cos(x: f64, y: f64) -> f64 {
    const C1: f64 = 4.16666666666666019037e-02;
    const C2: f64 = -1.38888888888741095749e-03;
    const C3: f64 = 2.48015872894767294178e-05;
    const C4: f64 = -2.75573143513906633035e-07;
    const C5: f64 = 2.08757232129817482790e-09;
    const C6: f64 = -1.13596475577881948265e-11;
    let ix = high(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && x as i32 == 0 {
        return 1.0;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3fd3_3333 {
        return 1.0 - (0.5 * z - (z * r - x * y));
    }
    let qx = if ix > 0x3fe9_0000 {
        0.28125
    } else {
        f64::from_bits(u64::from((ix - 0x0020_0000) as u32) << 32)
    };
    let hz = 0.5 * z - qx;
    let a = 1.0 - qx;
    a - (hz - (z * r - x * y))
}

/// fdlibm `__ieee754_rem_pio2` for |x| up to 2^19 pi/2. Larger arguments, which
/// SamSrf never passes, fall back to `libm` and return `None`.
fn rem_pio2(x: f64) -> Option<(i32, f64, f64)> {
    const PIO2_1: f64 = 1.57079632673412561417e+00;
    const PIO2_1T: f64 = 6.07710050650619224932e-11;
    const PIO2_2: f64 = 6.07710050630396597660e-11;
    const PIO2_2T: f64 = 2.02226624879595063154e-21;
    const PIO2_3: f64 = 2.02226624871116645580e-21;
    const PIO2_3T: f64 = 8.47842766036889956997e-32;
    const NPIO2_HW: [i32; 32] = [
        0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB,
        0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB,
        0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C,
        0x4041475C, 0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB,
        0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
    ];
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return Some((0, x, 0.0));
    }
    if ix < 0x4002_d97c {
        return Some(if hx > 0 {
            let mut z = x - PIO2_1;
            if ix != 0x3ff9_21fb {
                let y0 = z - PIO2_1T;
                (1, y0, (z - y0) - PIO2_1T)
            } else {
                z -= PIO2_2;
                let y0 = z - PIO2_2T;
                (1, y0, (z - y0) - PIO2_2T)
            }
        } else {
            let mut z = x + PIO2_1;
            if ix != 0x3ff9_21fb {
                let y0 = z + PIO2_1T;
                (-1, y0, (z - y0) + PIO2_1T)
            } else {
                z += PIO2_2;
                let y0 = z + PIO2_2T;
                (-1, y0, (z - y0) + PIO2_2T)
            }
        });
    }
    if ix > 0x4139_21fb {
        return None;
    }
    let t = x.abs();
    let n = (t * std::f64::consts::FRAC_2_PI + 0.5) as i32;
    let f_n = f64::from(n);
    let mut r = t - f_n * PIO2_1;
    let mut w = f_n * PIO2_1T;
    let mut y0;
    if n < 32 && ix != NPIO2_HW[(n - 1) as usize] {
        y0 = r - w;
    } else {
        let j = ix >> 20;
        y0 = r - w;
        let i = j - ((high(y0) >> 20) & 0x7ff);
        if i > 16 {
            let t = r;
            w = f_n * PIO2_2;
            r = t - w;
            w = f_n * PIO2_2T - ((t - r) - w);
            y0 = r - w;
            let i = j - ((high(y0) >> 20) & 0x7ff);
            if i > 49 {
                let t = r;
                w = f_n * PIO2_3;
                r = t - w;
                w = f_n * PIO2_3T - ((t - r) - w);
                y0 = r - w;
            }
        }
    }
    let y1 = (r - y0) - w;
    Some(if hx < 0 { (-n, -y0, -y1) } else { (n, y0, y1) })
}

/// fdlibm `sin`.
pub fn sin(x: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_sin(x, 0.0, false);
    }
    if ix >= 0x7ff0_0000 {
        return f64::NAN;
    }
    let Some((n, y0, y1)) = rem_pio2(x) else {
        return libm::sin(x);
    };
    match n & 3 {
        0 => kernel_sin(y0, y1, true),
        1 => kernel_cos(y0, y1),
        2 => -kernel_sin(y0, y1, true),
        _ => -kernel_cos(y0, y1),
    }
}

/// fdlibm `cos`.
pub fn cos(x: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_cos(x, 0.0);
    }
    if ix >= 0x7ff0_0000 {
        return f64::NAN;
    }
    let Some((n, y0, y1)) = rem_pio2(x) else {
        return libm::cos(x);
    };
    match n & 3 {
        0 => kernel_cos(y0, y1),
        1 => -kernel_sin(y0, y1, true),
        2 => -kernel_cos(y0, y1),
        _ => kernel_sin(y0, y1, true),
    }
}

/// `1 ./ w` for complex `w`, by Smith's algorithm as MATLAB divides.
fn reciprocal(w: Complex64) -> Complex64 {
    let (a, b, c, d) = (1.0, 0.0, w.re, w.im);
    if c.abs() >= d.abs() {
        let r = d / c;
        let den = c + d * r;
        Complex64::new((a + b * r) / den, (b - a * r) / den)
    } else {
        let r = c / d;
        let den = c * r + d;
        Complex64::new((a * r + b) / den, (b * r - a) / den)
    }
}

/// MATLAB's complex product: `(ac - bd) + (ad + bc)i`, recovering infinities
/// when both parts are NaN as C99 Annex G (G.5.1) specifies, like libgcc's
/// `__muldc3`. The recovery is what the recorded overflowing powers show.
fn multiply(x: Complex64, y: Complex64) -> Complex64 {
    let (mut a, mut b, mut c, mut d) = (x.re, x.im, y.re, y.im);
    let (ac, bd, ad, bc) = (a * c, b * d, a * d, b * c);
    let (re, im) = (ac - bd, ad + bc);
    if !(re.is_nan() && im.is_nan()) {
        return Complex64::new(re, im);
    }
    let box_infinity = |v: f64| (if v.is_infinite() { 1.0f64 } else { 0.0 }).copysign(v);
    let zero_nan = |v: f64| if v.is_nan() { 0.0f64.copysign(v) } else { v };
    let mut recalculate = false;
    if a.is_infinite() || b.is_infinite() {
        (a, b, c, d) = (box_infinity(a), box_infinity(b), zero_nan(c), zero_nan(d));
        recalculate = true;
    }
    if c.is_infinite() || d.is_infinite() {
        (c, d, a, b) = (box_infinity(c), box_infinity(d), zero_nan(a), zero_nan(b));
        recalculate = true;
    }
    if !recalculate && (ac.is_infinite() || bd.is_infinite() || ad.is_infinite() || bc.is_infinite()) {
        (a, b, c, d) = (zero_nan(a), zero_nan(b), zero_nan(c), zero_nan(d));
        recalculate = true;
    }
    if recalculate {
        Complex64::new(f64::INFINITY * (a * c - b * d), f64::INFINITY * (a * d + b * c))
    } else {
        Complex64::new(re, im)
    }
}

/// `z^n` for a whole `n >= 0` by right-to-left binary exponentiation in complex
/// arithmetic, whose signed zeros MATLAB's results keep.
fn integer_power(z: Complex64, mut n: f64) -> Complex64 {
    let mut result = Complex64::new(1.0, 0.0);
    let mut base = z;
    while n > 0.0 {
        if n % 2.0 == 1.0 {
            result = multiply(result, base);
        }
        n = (n / 2.0).floor();
        if n > 0.0 {
            base = multiply(base, base);
        }
    }
    result
}

/// MATLAB's `value.^exponent` for a real base and a real exponent. Nonnegative
/// bases and whole exponents use fdlibm `pow`. A negative base with a fractional
/// exponent splits off the whole part: (-x)^e = (-x)^trunc(e) * exp(f*log(x)) *
/// (cos(f*pi) + i sin(f*pi)), with i*sqrt(x) for f = 1/2, in complex products
/// that recover infinities. A negative exponent is the reciprocal: a real division
/// when the power is real, and an infinity with the true sign of the real part when
/// the power underflowed to zero. These reproduce every recorded value, NaN and
/// infinity (`numerics-reference.json`); the sign of a zero part can differ.
pub fn power(value: f64, exponent: f64) -> Complex64 {
    if value >= 0.0 || value.is_nan() || exponent.fract() == 0.0 || !exponent.is_finite() {
        return Complex64::new(pow(value, exponent), 0.0);
    }
    if exponent < 0.0 {
        let w = power(value, -exponent);
        if w.re == 0.0 && w.im == 0.0 {
            // Zero signs are not reliable here, so take the true real part's sign.
            let fraction = -exponent - (-exponent).trunc();
            let cosine = if fraction == 0.5 { 1.0 } else { cos(fraction * std::f64::consts::PI) };
            let odd = (-exponent).trunc() % 2.0 != 0.0;
            return Complex64::new(f64::INFINITY.copysign(if odd { -cosine } else { cosine }), 0.0);
        }
        if w.im == 0.0 {
            return Complex64::new(1.0 / w.re, 0.0);
        }
        return reciprocal(w);
    }
    let whole = exponent.trunc();
    let fraction = exponent - whole;
    let unit = if fraction == 0.5 {
        Complex64::new(0.0, (-value).sqrt())
    } else {
        let magnitude = exp(fraction * log(-value));
        let angle = fraction * std::f64::consts::PI;
        Complex64::new(magnitude * cos(angle), magnitude * sin(angle))
    };
    multiply(integer_power(Complex64::new(value, 0.0), whole), unit)
}

/// The first `y.len()` outputs of MATLAB's `conv(y, kernel)`, accumulated with
/// fused multiply-adds. MATLAB picks one of two kernels from the input's nonzero
/// count. A sparse input is scattered, its nonzero samples in order. Otherwise each
/// output runs over input blocks of `block` samples, the earliest first, and within
/// a block over kernel taps grouped by `tap % lanes`: real vectors use 4 lanes and
/// 24-sample blocks, complex vectors 2 lanes and 8-sample blocks. A final, partial
/// block is grouped the same way in whole vectors of `2 * lanes` samples; its last
/// samples, fewer than one such vector, follow in input order. The recordings
/// (250 volumes, a 33-tap kernel) scatter with at most 62 nonzero samples and block
/// with at least 64; this uses a quarter of the samples as the boundary.
/// Measured for kernels of 9 to 129 taps on longer inputs (validation/matlab/README.md).
fn convolve_prefix(parts: &[&[f64]], kernel: &[f64], lanes: usize, block: usize) -> Vec<Vec<f64>> {
    let n = parts[0].len();
    let nonzero = (0..n).filter(|&i| parts.iter().any(|part| part[i] != 0.0)).count();
    let sparse = 4 * nonzero < n;
    let vector = 2 * lanes;
    let vectored = if n.is_multiple_of(block) { n } else { n / block * block + n % block / vector * vector };
    parts
        .iter()
        .map(|y| {
            (0..n)
                .map(|k| {
                    let taps = kernel.len().min(k + 1);
                    let first = k + 1 - taps;
                    let mut sum = 0.0f64;
                    if sparse {
                        for i in first..=k {
                            if parts.iter().any(|part| part[i] != 0.0) {
                                sum = y[i].mul_add(kernel[k - i], sum);
                            }
                        }
                        return sum;
                    }
                    for start in (first / block * block..=k).step_by(block) {
                        let low = start.max(first);
                        let high = (start + block - 1).min(k);
                        if low < vectored {
                            let grouped = high.min(vectored - 1);
                            for lane in 0..lanes {
                                for j in k - grouped..=k - low {
                                    if j % lanes == lane {
                                        sum = y[k - j].mul_add(kernel[j], sum);
                                    }
                                }
                            }
                        }
                        for i in low.max(vectored)..=high {
                            sum = y[i].mul_add(kernel[k - i], sum);
                        }
                    }
                    sum
                })
                .collect()
        })
        .collect()
}

pub fn convolve_real(y: &[f64], kernel: &[f64], downsampling: usize) -> Vec<f64> {
    convolve_prefix(&[y], kernel, 4, 24)
        .remove(0)
        .into_iter()
        .step_by(downsampling.max(1))
        .collect()
}

pub fn convolve_complex(y: &[Complex64], kernel: &[f64], downsampling: usize) -> Vec<Complex64> {
    let re: Vec<_> = y.iter().map(|v| v.re).collect();
    let im: Vec<_> = y.iter().map(|v| v.im).collect();
    let mut parts = convolve_prefix(&[&re, &im], kernel, 2, 8);
    let im = parts.pop().unwrap();
    let re = parts.pop().unwrap();
    re.into_iter()
        .zip(im)
        .step_by(downsampling.max(1))
        .map(|(re, im)| Complex64::new(re, im))
        .collect()
}

/// MKL `ddot`: four two-lane registers over blocks of eight, then pairs and a last
/// element into the first register.
pub fn ddot(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len().min(y.len());
    let mut r = [[0.0f64; 2]; 4];
    let mut i = 0;
    while i + 8 <= n {
        for (u, register) in r.iter_mut().enumerate() {
            for (w, lane) in register.iter_mut().enumerate() {
                *lane += x[i + 2 * u + w] * y[i + 2 * u + w];
            }
        }
        i += 8;
    }
    while i + 2 <= n {
        r[0][0] += x[i] * y[i];
        r[0][1] += x[i + 1] * y[i + 1];
        i += 2;
    }
    if i < n {
        r[0][0] += x[i] * y[i];
    }
    let lo = ((r[0][0] + r[1][0]) + r[2][0]) + r[3][0];
    let hi = ((r[0][1] + r[1][1]) + r[2][1]) + r[3][1];
    lo + hi
}

/// MKL `zdotc` of a complex `x` and a real `y` that MATLAB passes as complex:
/// even and odd elements in two accumulators.
pub fn zdotc_real(x: &[Complex64], y: &[f64]) -> Complex64 {
    let mut re = [0.0f64; 2];
    let mut im = [0.0f64; 2];
    for (k, (x, &y)) in x.iter().zip(y).enumerate() {
        let lane = k % 2;
        re[lane] += x.re * y + x.im * 0.0;
        im[lane] += x.re * 0.0 - x.im * y;
    }
    Complex64::new(re[0] + re[1], im[0] + im[1])
}

/// MKL `dnrm2` and `dznrm2` (real and imaginary parts interleaved): the scaled
/// sum of squares of the reference BLAS.
pub fn nrm2(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut scale = 0.0f64;
    let mut ssq = 1.0f64;
    for value in values {
        if value != 0.0 {
            let a = value.abs();
            if scale < a {
                let r = scale / a;
                ssq = 1.0 + ssq * r * r;
                scale = a;
            } else {
                let r = a / scale;
                ssq += r * r;
            }
        }
    }
    scale * ssq.sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_power_multiplies_squares_from_the_lowest_bit() {
        let x = 1.1f64;
        let z = Complex64::new(x, 0.0);
        assert_eq!(integer_power(z, 3.0).re, x * (x * x));
        assert_eq!(integer_power(z, 5.0).re, x * ((x * x) * (x * x)));
        assert_eq!(integer_power(z, 0.0), Complex64::new(1.0, 0.0));
    }

    #[test]
    fn negative_bases_with_fractional_exponents_are_complex() {
        assert_eq!(power(-4.0, 0.5), Complex64::new(0.0, 2.0));
        let inverse = power(-4.0, -0.5);
        assert!(inverse.re.abs() < 1e-16 && (inverse.im + 0.5).abs() < 1e-16);
        assert_eq!(power(-4.0, 2.0), Complex64::new(16.0, 0.0));
        assert_eq!(power(0.0, 0.0), Complex64::new(1.0, 0.0));
    }

    #[test]
    fn convolution_follows_input_blocks_then_tap_lanes() {
        let y: Vec<f64> = (0..60).map(|i| f64::from(i).sin()).collect();
        let kernel: Vec<f64> = (0..33).map(|j| (-f64::from(j) / 7.0).exp()).collect();
        let out = convolve_prefix(&[&y], &kernel, 4, 24).remove(0);
        let k = 40;
        let mut order: Vec<usize> = (0..33).collect();
        order.sort_by_key(|&j| ((k - j) / 24, j % 4, j));
        let expected = order.iter().fold(0.0f64, |s, &j| y[k - j].mul_add(kernel[j], s));
        assert_eq!(out[k].to_bits(), expected.to_bits());
    }

    #[test]
    fn mkl_kernels_match_their_reduction_trees() {
        let x: Vec<f64> = (0..11).map(|i| 1.0 + f64::from(i) * 1e-9).collect();
        let y = vec![1.0; 11];
        let r0 = ((x[0] + x[8]) + x[10], (x[1] + x[9]));
        let expected = (((r0.0 + x[2]) + x[4]) + x[6]) + (((r0.1 + x[3]) + x[5]) + x[7]);
        assert_eq!(ddot(&x, &y).to_bits(), expected.to_bits());
        assert_eq!(nrm2([3.0, 4.0]), 5.0);
        assert_eq!(nrm2([0.0, 0.0]), 0.0);
    }
}
