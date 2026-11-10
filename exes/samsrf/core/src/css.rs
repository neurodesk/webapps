//! The original SamSrf CSS convention. Fractional powers of negative responses
//! are complex; fitted maps exported by samsrf_expand_srf retain their real parts.

use crate::matlab_math;
use crate::precision::{self, Precision};
use num_complex::Complex64;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Convention {
    Nonnegative,
    Samsrf,
}

/// MATLAB's `Yp.^P`, real for nonnegative bases and integral exponents.
pub fn power(value: f64, exponent: f64) -> Complex64 {
    matlab_math::power(value, exponent)
}

/// `prf_convolve_hrf(Yp.^P, Hrf, Downsampling)`. MATLAB keeps the compressed
/// prediction real unless a negative response gives it imaginary parts, and its
/// convolution reduces real and complex vectors in different orders.
pub fn predict(raw: &[f64], exponent: f64, kernel: &[f64], downsampling: usize) -> Vec<Complex64> {
    let compressed: Vec<Complex64> = raw.iter().map(|&value| power(value, exponent)).collect();
    if is_complex(&compressed) {
        matlab_math::convolve_complex(&compressed, kernel, downsampling)
    } else {
        let real: Vec<f64> = compressed.iter().map(|value| value.re).collect();
        matlab_math::convolve_real(&real, kernel, downsampling)
            .into_iter()
            .map(|value| Complex64::new(value, 0.0))
            .collect()
    }
}

/// Whether MATLAB holds these values as a complex array. Its elementwise results
/// are real when every imaginary part is zero.
fn is_complex(values: &[Complex64]) -> bool {
    values.iter().any(|value| value.im != 0.0)
}

pub fn objective(predicted: &[Complex64], observed: &[f64], precision: Precision) -> Complex64 {
    if precision == Precision::Double {
        // 1 - R.^2: the complex product R*R for a complex correlation, which keeps
        // NaN in both parts, and a real square otherwise.
        let r = correlation(predicted, observed, precision);
        return if is_complex(predicted) {
            Complex64::new(1.0 - (r.re * r.re - r.im * r.im), 0.0 - (r.re * r.im + r.im * r.re))
        } else {
            Complex64::new(1.0 - r.re * r.re, 0.0)
        };
    }
    let r = correlation(predicted, observed, precision);
    if !r.re.is_finite() || !r.im.is_finite() {
        let imaginary = if is_complex(predicted) { f64::NAN } else { 0.0 };
        return Complex64::new(f64::NAN, imaginary);
    }
    let r = num_complex::Complex32::new(r.re as f32, r.im as f32);
    let e = num_complex::Complex32::new(1.0, 0.0) - r * r;
    Complex64::new(f64::from(e.re), f64::from(e.im))
}

/// Statistics Toolbox `corr`: centred columns, `x' * y` and the 2-norms through
/// MKL, `dot ./ norm(x) ./ norm(y)`, then values beyond 1 in magnitude divided by
/// their magnitude (an overflowing dot product becomes NaN).
fn correlation(x: &[Complex64], y: &[f64], precision: Precision) -> Complex64 {
    if x.len() != y.len() || x.len() < 2 {
        return Complex64::new(f64::NAN, f64::NAN);
    }
    if precision == Precision::Single {
        return precision::correlation_complex_single(x, y);
    }
    let my = precision::mean_double(y);
    let yc: Vec<f64> = y.iter().map(|value| value - my).collect();
    let (dot, norm_x) = if is_complex(x) {
        let mx = precision::mean_complex(x);
        let xc: Vec<Complex64> = x.iter().map(|&value| value - mx).collect();
        let norm = matlab_math::nrm2(xc.iter().flat_map(|value| [value.re, value.im]));
        (matlab_math::zdotc_real(&xc, &yc), norm)
    } else {
        let real: Vec<f64> = x.iter().map(|value| value.re).collect();
        let mx = precision::mean_double(&real);
        let xc: Vec<f64> = real.iter().map(|value| value - mx).collect();
        (Complex64::new(matlab_math::ddot(&xc, &yc), 0.0), matlab_math::nrm2(xc.iter().copied()))
    };
    let norm_y = matlab_math::nrm2(yc.iter().copied());
    let r = Complex64::new(dot.re / norm_x / norm_y, dot.im / norm_x / norm_y);
    let magnitude = if r.im == 0.0 { r.re.abs() } else { libm::hypot(r.re, r.im) };
    if magnitude > 1.0 {
        Complex64::new(r.re / magnitude, r.im / magnitude)
    } else {
        r
    }
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
