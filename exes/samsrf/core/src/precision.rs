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

fn sum_single(values: &[f32]) -> f32 {
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

/// Correlate a double prediction and single observations. The coarse fit passes
/// observations first to MATLAB's corr, reversing the order of the two divisions.
pub fn correlation_single(prediction: &[f64], observed: &[f64], observations_first: bool) -> f32 {
    if prediction.len() != observed.len() || prediction.len() < 2 {
        return f32::NAN;
    }
    let observations: Vec<f32> = observed.iter().map(|&value| value as f32).collect();
    let mean_y = sum_single(&observations) / observations.len() as f32;
    let yc: Vec<f32> = observations.iter().map(|value| value - mean_y).collect();
    let mean_x = prediction.iter().sum::<f64>() / prediction.len() as f64;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_or_mismatched_observations_have_no_correlation() {
        assert!(correlation_single(&[1.0, 2.0], &[1.0], false).is_nan());
        assert!(correlation_single(&[1.0, 2.0], &[1.0, 1.0], false).is_nan());
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
