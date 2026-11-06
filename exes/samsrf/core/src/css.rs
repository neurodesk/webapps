//! The original SamSrf CSS convention. Fractional powers of negative responses
//! are complex; fitted maps exported by samsrf_expand_srf retain their real parts.

use crate::hrf;
use crate::precision::{self, Precision};
use num_complex::Complex64;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Convention {
    Nonnegative,
    Samsrf,
}

/// MATLAB's real-base power stays real for integral exponents.
pub fn power(value: f64, exponent: f64) -> Complex64 {
    if value >= 0.0 || exponent.fract() == 0.0 {
        Complex64::new(value.powf(exponent), 0.0)
    } else {
        let magnitude = (-value).powf(exponent);
        let phase = std::f64::consts::PI * exponent;
        Complex64::new(magnitude * phase.cos(), magnitude * phase.sin())
    }
}

pub fn predict(raw: &[f64], exponent: f64, kernel: &[f64], downsampling: usize) -> Vec<Complex64> {
    let compressed: Vec<Complex64> = raw.iter().map(|&value| power(value, exponent)).collect();
    let real: Vec<f64> = compressed.iter().map(|value| value.re).collect();
    let imaginary: Vec<f64> = compressed.iter().map(|value| value.im).collect();
    hrf::convolve(&real, kernel, downsampling)
        .into_iter()
        .zip(hrf::convolve(&imaginary, kernel, downsampling))
        .map(|(re, im)| Complex64::new(re, im))
        .collect()
}

pub fn objective(predicted: &[Complex64], observed: &[f64], precision: Precision) -> Complex64 {
    let r = correlation(predicted, observed, precision);
    if !r.re.is_finite() || !r.im.is_finite() {
        return Complex64::new(f64::NAN, 0.0);
    }
    match precision {
        Precision::Double => Complex64::new(1.0 - (r.re * r.re - r.im * r.im), -2.0 * r.re * r.im),
        Precision::Single => {
            let r = num_complex::Complex32::new(r.re as f32, r.im as f32);
            let e = num_complex::Complex32::new(1.0, 0.0) - r * r;
            Complex64::new(f64::from(e.re), f64::from(e.im))
        }
    }
}

fn correlation(x: &[Complex64], y: &[f64], precision: Precision) -> Complex64 {
    if x.len() != y.len() || x.len() < 2 {
        return Complex64::new(f64::NAN, f64::NAN);
    }
    if precision == Precision::Single {
        return precision::correlation_complex_single(x, y);
    }
    let mx = x.iter().copied().sum::<Complex64>() / x.len() as f64;
    let my = y.iter().sum::<f64>() / y.len() as f64;
    let mut dot = Complex64::new(0.0, 0.0);
    let mut nx = 0.0;
    let mut ny = 0.0;
    for (&x, &y) in x.iter().zip(y) {
        let dx = x - mx;
        let dy = y - my;
        dot.re += dx.re * dy;
        dot.im -= dx.im * dy;
        nx += dx.re * dx.re + dx.im * dx.im;
        ny += dy * dy;
    }
    Complex64::new(
        dot.re / nx.sqrt() / ny.sqrt(),
        dot.im / nx.sqrt() / ny.sqrt(),
    )
}

/// Complex least squares with the same pivot/rank convention as the real fit.
/// The exported map drops imaginary coefficients, as samsrf_expand_srf does.
pub fn fit_betas(x: &[Complex64], y: &[f64], precision: Precision) -> (f64, f64) {
    let n = x.len() as f64;
    if x.is_empty() || x.len() != y.len() {
        return (f64::NAN, f64::NAN);
    }
    let x: Vec<Complex64> = x
        .iter()
        .map(|v| Complex64::new(precision.round(v.re), precision.round(v.im)))
        .collect();
    let y: Vec<f64> = y.iter().map(|&v| precision.round(v)).collect();
    let mx = x.iter().copied().sum::<Complex64>() / n;
    let my = y.iter().sum::<f64>() / n;
    let mut sxx = 0.0;
    let mut sxy = Complex64::new(0.0, 0.0);
    let mut raw_xx = 0.0;
    let mut raw_xy = Complex64::new(0.0, 0.0);
    for (&x, &y) in x.iter().zip(&y) {
        sxx += (x - mx).norm_sqr();
        sxy += (x - mx).conj() * (y - my);
        raw_xx += x.norm_sqr();
        raw_xy += x.conj() * y;
    }
    let epsilon = if precision == Precision::Single {
        f64::from(f32::EPSILON)
    } else {
        f64::EPSILON
    };
    let ones_first = n >= raw_xx;
    let (r11, r22) = if ones_first {
        (n.sqrt(), sxx.sqrt())
    } else {
        (raw_xx.sqrt(), (n * (sxx / raw_xx)).sqrt())
    };
    let (beta, baseline) = if r22 <= n.max(2.0) * epsilon * r11 {
        if ones_first {
            (0.0, my)
        } else {
            ((raw_xy / raw_xx).re, 0.0)
        }
    } else {
        let beta = sxy / sxx;
        (beta.re, (my - beta * mx).re)
    };
    (precision.round(beta), precision.round(baseline))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_fractional_powers_and_integral_powers_follow_matlab() {
        let half = power(-4.0, 0.5);
        assert!(half.re.abs() < 1e-15);
        assert_eq!(half.im, 2.0);
        assert_eq!(power(-4.0, 1.0), Complex64::new(-4.0, 0.0));
        assert_eq!(power(-4.0, 2.0), Complex64::new(16.0, 0.0));
        assert_eq!(power(0.0, 0.0), Complex64::new(1.0, 0.0));
    }

    #[test]
    fn complex_regression_recovers_real_exported_coefficients() {
        let x = [
            Complex64::new(1.0, 1.0),
            Complex64::new(2.0, -1.0),
            Complex64::new(3.0, 0.0),
        ];
        let (beta, baseline) = fit_betas(&x, &[3.0, 5.0, 7.0], Precision::Double);
        assert_eq!(beta, 1.0);
        assert_eq!(baseline, 3.0);
    }
}
