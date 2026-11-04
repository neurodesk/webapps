//! `samsrf_benson2srf`: a Benson atlas GIFTI (polar angle, eccentricity, ROI label; one
//! float32 DataArray each) as the template map `samsrf_revcor_cf` reads `x0` and `y0`
//! from. The arithmetic is done in single precision, as MATLAB does on the GIFTI's
//! single `cdata`, so the coordinates are the ones SamSrf's own template holds.

use crate::error::{Error, Result};
use crate::gifti;
use crate::mapset::Maps;

/// `Srf.Values` of a Benson template.
pub const TEMPLATE_VALUES: [&str; 5] = ["R^2", "x0", "y0", "Sigma", "ROI"];

/// Converts the three per-vertex arrays. `right_hemisphere` flips `x0`, as the `rh` branch does.
pub fn benson_template(polar: &[f32], eccentricity: &[f32], rois: &[f32], right_hemisphere: bool) -> Result<Maps> {
    let n = polar.len();
    if eccentricity.len() != n || rois.len() != n {
        return Err(Error::Shape(format!(
            "Benson template arrays differ in length ({n}, {}, {})",
            eccentricity.len(),
            rois.len()
        )));
    }
    let mut maps = Maps { values: TEMPLATE_VALUES.iter().map(|value| value.to_string()).collect(), vertices: n, data: vec![f64::NAN; 5 * n] };
    for v in 0..n {
        let roi = rois[v];
        let angle = -polar[v] + 90.0f32;
        // single / double and single * double stay single in MATLAB.
        let radians = angle / 180.0f32 * std::f32::consts::PI;
        let mut x0 = eccentricity[v] * radians.cos();
        let y0 = eccentricity[v] * radians.sin();
        if right_hemisphere {
            x0 = -x0;
        }
        maps.data[v] = if roi != 0.0 { 1.0 } else { 0.0 };
        maps.data[n + v] = f64::from(x0);
        maps.data[2 * n + v] = f64::from(y0);
        maps.data[4 * n + v] = f64::from(roi);
    }
    Ok(maps)
}

/// Reads a Benson GIFTI (`lh_benson.gii`) and converts it.
pub fn read_benson_gifti(bytes: &[u8], right_hemisphere: bool) -> Result<Maps> {
    let file = gifti::read(bytes)?;
    if file.arrays.len() != 3 {
        return Err(Error::format("GIFTI", format!("a Benson template holds 3 DataArrays (polar angle, eccentricity, ROI), this file has {}", file.arrays.len())));
    }
    let as_f32 = |array: &gifti::DataArray| -> Vec<f32> { array.data.iter().map(|value| *value as f32).collect() };
    benson_template(&as_f32(&file.arrays[0]), &as_f32(&file.arrays[1]), &as_f32(&file.arrays[2]), right_hemisphere)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_polar_and_eccentricity_in_single_precision() {
        let maps = benson_template(&[90.0, 0.0, 45.0], &[2.0, 1.0, 0.0], &[1.0, -2.0, 0.0], false).unwrap();
        assert_eq!(maps.row(0), &[1.0, 1.0, 0.0]);
        // polar 90 -> angle 0: x0 = ecc, y0 = 0.
        assert_eq!(maps.row(1)[0], 2.0);
        assert_eq!(maps.row(2)[0], 0.0);
        // polar 0 -> angle 90 degrees in single precision: cos is not exactly 0.
        let x = maps.row(1)[1];
        assert!(x.abs() < 1e-6 && x == f64::from((90.0f32 / 180.0f32 * std::f32::consts::PI).cos()));
        assert_eq!(maps.row(4), &[1.0, -2.0, 0.0]);
        assert!(maps.row(3).iter().all(|value| value.is_nan()));
        let flipped = benson_template(&[90.0], &[2.0], &[1.0], true).unwrap();
        assert_eq!(flipped.row(1)[0], -2.0);
    }
}
