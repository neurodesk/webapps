//! `samsrf_benson2srf`: a Benson atlas GIFTI (polar angle, eccentricity, ROI label; one
//! float32 DataArray each) as the template map `samsrf_revcor_cf` reads `x0` and `y0`
//! from. The arithmetic is done in single precision, as MATLAB does on the GIFTI's
//! single `cdata`, with MATLAB's single `sin` and `cos`, so the coordinates are the
//! ones SamSrf's own template holds.

use crate::error::{Error, Result};
use crate::gifti;
use crate::mapset::Maps;
use crate::precision::{cos_single, sin_single};

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
        // A mixed scalar operation evaluates in double, then rounds to single.
        // Rounding pi before the multiplication changes the atlas coordinates.
        let turns = (f64::from(angle) / 180.0) as f32;
        let radians = (f64::from(turns) * std::f64::consts::PI) as f32;
        let mut x0 = eccentricity[v] * cos_single(radians);
        let y0 = eccentricity[v] * sin_single(radians);
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
        assert!(x.abs() < 1e-6 && x == f64::from(cos_single(90.0f32 / 180.0f32 * std::f32::consts::PI)));
        assert_eq!(maps.row(4), &[1.0, -2.0, 0.0]);
        assert!(maps.row(3).iter().all(|value| value.is_nan()));
        let flipped = benson_template(&[90.0], &[2.0], &[1.0], true).unwrap();
        assert_eq!(flipped.row(1)[0], -2.0);
    }

    #[test]
    fn benson_uses_matlabs_single_sin_and_cos_where_rounding_differs() {
        // MATLAB's recorded X001 templates (revcor-reference.json) at vertices where
        // the correctly rounded sine or cosine gives another single: LH 7 (cosine,
        // x/4 branch), LH 10 (sine through the reduction), RH 69 and RH 2.
        let cases: [(f32, f32, bool, f64, f64); 4] = [
            (167.331_604, 2.149_862_8, false, 0.471_482_157_707_214_36, -2.097_525_835_037_231_4),
            (156.560_837, 2.349_005_5, false, 0.934_376_001_358_032_2, -2.155_172_586_441_04),
            (139.772_430, 19.362_009, true, -12.504_472_732_543_945, -14.782_610_893_249_512),
            (55.738_869, 0.867_165_03, true, -0.716_694_891_452_789_3, 0.488_184_005_022_048_95),
        ];
        for (polar, eccentricity, right, x0, y0) in cases {
            let maps = benson_template(&[polar], &[eccentricity], &[1.0], right).unwrap();
            assert_eq!((maps.row(1)[0], maps.row(2)[0]), (x0, y0), "polar {polar}");
        }
        let (polar, eccentricity) = (167.331_604f32, 2.149_862_8f32);
        let radians = ((f64::from(-polar + 90.0) / 180.0) as f32 as f64 * std::f64::consts::PI) as f32;
        assert_ne!(f64::from(eccentricity * (f64::from(radians).cos() as f32)), cases[0].3, "the case must separate the two cosines");
    }

    #[test]
    fn benson_keeps_double_pi_until_the_product_is_rounded() {
        // X001 LH vertex 64 in the independent MATLAB importer fixture.
        let maps = benson_template(&[43.106476], &[58.12849], &[1.0], false).unwrap();
        assert_eq!(maps.row(1)[0], 39.72247314453125);
        assert_eq!(maps.row(2)[0], 42.43873977661133);
    }
}
