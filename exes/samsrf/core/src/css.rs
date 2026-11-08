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
    let mx = precision::mean_complex(x);
    let my = precision::mean_double(y);
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
    let norm_x = norm_extreme(
        nx,
        x.iter().flat_map(|value| [value.re - mx.re, value.im - mx.im]),
    );
    let norm_y = norm_extreme(ny, y.iter().map(|value| value - my));
    Complex64::new(dot.re / norm_x / norm_y, dot.im / norm_x / norm_y)
}

fn norm_extreme(sum_squares: f64, values: impl Iterator<Item = f64> + Clone) -> f64 {
    // Retain the ordinary reduction, but avoid losing the exponent range when
    // CSS produces predictions whose squares underflow or overflow.
    if sum_squares.is_normal() || sum_squares.is_nan() {
        return sum_squares.sqrt();
    }
    let scale = values.clone().map(f64::abs).fold(0.0, f64::max);
    if scale == 0.0 || !scale.is_finite() {
        return scale;
    }
    let squares = values.map(|value| (value / scale).powi(2)).sum::<f64>();
    scale * squares.sqrt()
}

/// Complex least squares with MATLAB's measured QR rank threshold.
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
    if precision == Precision::Double
        && raw_xx.is_infinite()
        && x.iter().all(|value| value.re.is_finite() && value.im.is_finite())
    {
        // At this scale MATLAB's rank tolerance exceeds the residual norm of
        // the ones column. Solve its retained prediction column without x²
        // overflowing, rather than letting inf/inf select a full-rank solve.
        let scale = x.iter()
            .map(|value| value.re.abs().max(value.im.abs()))
            .fold(0.0, f64::max);
        let mut denominator = 0.0;
        let mut numerator = Complex64::new(0.0, 0.0);
        for (&value, &observation) in x.iter().zip(&y) {
            let scaled = value / scale;
            denominator += scaled.norm_sqr();
            numerator += scaled.conj() * observation;
        }
        return (((numerator / denominator) / scale).re, 0.0);
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
    // MATLAB's rank warnings report ten times the real-path tolerance for
    // complex designs. The original scale cases also fit eps(norm(A,1)), but
    // the recorded double CSS vertex 81 distinguishes the two rules: MATLAB
    // reports 24.78495, while the spacing-based estimate gives 15.625 and
    // incorrectly retains the baseline column (R22 = 15.81078).
    let complex_factor = if x.iter().any(|value| value.im != 0.0) {
        10.0
    } else {
        1.0
    };
    let tolerance = complex_factor * n.max(2.0) * epsilon * r11;
    let (beta, baseline) = if r22 <= tolerance {
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

    #[test]
    fn overflowing_css_correlation_is_invalid_instead_of_an_improving_objective() {
        let predicted = [Complex64::new(-1e39, 0.0), Complex64::new(1e39, 0.0)];
        assert!(objective(&predicted, &[-1.0, 1.0], Precision::Single).re.is_nan());
    }

    #[test]
    fn double_correlation_preserves_scale_when_squaring_underflows_or_overflows() {
        let observed = [-2.0, -1.0, 1.0, 2.0];
        for scale in [1e-162, 1e154] {
            let predicted: Vec<_> = observed.iter()
                .map(|value| Complex64::new(value * scale, 0.0))
                .collect();
            let error = objective(&predicted, &observed, Precision::Double);
            assert!(error.re.abs() < 1e-14, "scale {scale}: {error}");
            assert_eq!(error.im, 0.0);
        }
    }

    #[test]
    fn double_regression_retains_the_prediction_column_when_its_squared_norm_overflows() {
        let x: Vec<_> = [1.0, 2.0, 3.0, 4.0].iter()
            .map(|value| Complex64::new(value * 1e155, 0.0))
            .collect();
        let (beta, baseline) = fit_betas(&x, &[3.0, 5.0, 7.0, 9.0], Precision::Double);
        assert!((beta / (70.0 / 30.0 / 1e155) - 1.0).abs() < 1e-14);
        assert_eq!(baseline, 0.0);
    }

    #[test]
    fn complex_single_regression_uses_the_recorded_qr_rank_threshold() {
        for volumes in [16, 250] {
            let x: Vec<_> = (1..=volumes).map(|t| Complex64::new((t as f64).sin(), 0.3 * (t as f64).cos()) * 1e-4).collect();
            let y: Vec<_> = (1..=volumes).map(|t| 2.0 * (t as f64).sin() + 3.0).collect();
            let (beta, _) = fit_betas(&x, &y, Precision::Single);
            if volumes == 250 {
                assert_eq!(beta, 0.0);
            } else {
                assert!(beta > 1e4);
            }
        }
    }
}
