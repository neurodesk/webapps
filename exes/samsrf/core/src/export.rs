//! `samsrf_export_giis`: one GIFTI per `Srf.Values` row, plus polar angle and
//! eccentricity when the maps hold `x0` and `y0`.
//!
//! File names: `{prefix}_{lower(name)}.gii` with spaces replaced by `_`
//! (`lh_pRF_Gaussian_r^2.gii`, `lh_pRF_Gaussian_noise_ceiling.gii`), and
//! `{prefix}_pol.gii` / `{prefix}_ecc.gii`. Polar angle is `atan2(y0, x0) / pi * 180`;
//! eccentricity `sqrt(x0^2 + y0^2)`, set to 0 where row 1 (`R^2`) is 0.

use crate::gifti::write_map;
use crate::mapset::Maps;

/// The Neurodesk v10.004 image contains SamSrf 10.003, whose exporter subtracts
/// 0.5 from eccentricity after expanding Srf into single precision. SamSrf 10.4
/// removed that offset. Keep the older convention explicit, never inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExportConvention {
    #[default]
    Geometric,
    SamSrfX10003,
}

/// A file to write: its name and GIFTI bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportedGifti {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// Which maps to export: every row (and polar/eccentricity), or named ones as
/// `samsrf_export_giis(Srf, OutFile, Raw, Maps)` selects them (`'Polar'` and
/// `'Eccentricity'` select the derived maps).
#[derive(Debug, Clone, PartialEq)]
pub enum ExportSelection {
    All,
    Named(Vec<String>),
}

impl ExportSelection {
    /// `strcmpi(Maps, name)`.
    fn selects(&self, name: &str) -> bool {
        match self {
            ExportSelection::All => true,
            ExportSelection::Named(names) => names.iter().any(|selected| selected.to_lowercase() == name.to_lowercase()),
        }
    }
}

pub fn export_giis(maps: &Maps, prefix: &str, selection: &ExportSelection) -> Vec<ExportedGifti> {
    export_giis_with_convention(maps, prefix, selection, ExportConvention::Geometric)
}

pub fn export_giis_with_convention(maps: &Maps, prefix: &str, selection: &ExportSelection, convention: ExportConvention) -> Vec<ExportedGifti> {
    let mut files = Vec::new();
    if let Some((polar, eccentricity)) = polar_and_eccentricity_with_convention(maps, convention) {
        if selection.selects("Polar") {
            files.push(ExportedGifti { name: format!("{prefix}_pol.gii"), bytes: write_map(&polar) });
        }
        if selection.selects("Eccentricity") {
            files.push(ExportedGifti { name: format!("{prefix}_ecc.gii"), bytes: write_map(&eccentricity) });
        }
    }
    for (index, value) in maps.values.iter().enumerate() {
        if selection.selects(value) {
            let name = format!("{prefix}_{}.gii", value.to_lowercase()).replace(' ', "_");
            files.push(ExportedGifti { name, bytes: write_map(maps.row(index)) });
        }
    }
    files
}

/// `(polar, eccentricity)` as `samsrf_export_giis` derives them, or `None` when the
/// maps have no `x0` row.
///
/// Like SamSrf, any name containing `x0` switches this on, and x0, y0 and R^2 are then
/// rows 2, 3 and 1 by position, not by name.
pub fn polar_and_eccentricity(maps: &Maps) -> Option<(Vec<f64>, Vec<f64>)> {
    polar_and_eccentricity_with_convention(maps, ExportConvention::Geometric)
}

pub fn polar_and_eccentricity_with_convention(maps: &Maps, convention: ExportConvention) -> Option<(Vec<f64>, Vec<f64>)> {
    if maps.rows() < 3 || !maps.values.iter().any(|value| value.contains("x0")) {
        return None;
    }
    let r2 = maps.row(0);
    let x0 = maps.row(1);
    let y0 = maps.row(2);
    if convention == ExportConvention::SamSrfX10003 {
        let mut polar = Vec::with_capacity(maps.vertices);
        let mut eccentricity = Vec::with_capacity(maps.vertices);
        for ((&x, &y), &r) in x0.iter().zip(y0).zip(r2) {
            let (x, y) = (x as f32, y as f32);
            // MATLAB's single / double-scalar operation rounds the result, not
            // the scalar operand. In particular pi must stay double precision.
            let angle = y.atan2(x);
            let radians = (angle as f64 / std::f64::consts::PI) as f32;
            polar.push((radians as f64 * 180.0) as f32 as f64);
            eccentricity.push(if r as f32 == 0.0 { 0.0 } else { ((x * x + y * y).sqrt() - 0.5) as f64 });
        }
        return Some((polar, eccentricity));
    }
    let polar = x0
        .iter()
        .zip(y0)
        .map(|(x, y)| y.atan2(*x) / std::f64::consts::PI * 180.0)
        .collect();
    let eccentricity = x0
        .iter()
        .zip(y0)
        .zip(r2)
        .map(|((x, y), r2)| if *r2 == 0.0 { 0.0 } else { (x * x + y * y).sqrt() })
        .collect();
    Some((polar, eccentricity))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gifti;

    fn prf_maps() -> Maps {
        let values = ["R^2", "x0", "y0", "Sigma", "Noise Ceiling"].map(String::from).to_vec();
        let mut maps = Maps::zeros(values, 3);
        maps.row_mut(0).copy_from_slice(&[0.5, 0.0, 0.25]);
        maps.row_mut(1).copy_from_slice(&[1.0, 3.0, 0.0]);
        maps.row_mut(2).copy_from_slice(&[1.0, 4.0, -2.0]);
        maps.row_mut(3).copy_from_slice(&[0.1, 0.2, 0.3]);
        maps.row_mut(4).copy_from_slice(&[0.9, 0.8, 0.7]);
        maps
    }

    fn read_back(file: &ExportedGifti) -> Vec<f64> {
        gifti::read(&file.bytes).expect("exported GIFTI parses").arrays[0].data.clone()
    }

    #[test]
    fn polar_angle_in_degrees_and_eccentricity_masked_by_r2() {
        let (polar, eccentricity) = polar_and_eccentricity(&prf_maps()).expect("pRF maps");
        assert_eq!(polar, [45.0, 4f64.atan2(3.0) / std::f64::consts::PI * 180.0, -90.0]);
        assert_eq!(eccentricity, [2f64.sqrt(), 0.0, 2.0]);
        let plain = Maps::zeros(vec!["R^2".into(), "Beta".into(), "Sigma".into()], 3);
        assert_eq!(polar_and_eccentricity(&plain), None);
    }

    #[test]
    fn exports_polar_eccentricity_then_rows_with_lower_case_names() {
        let files = export_giis(&prf_maps(), "lh_pRF_Gaussian", &ExportSelection::All);
        let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "lh_pRF_Gaussian_pol.gii",
                "lh_pRF_Gaussian_ecc.gii",
                "lh_pRF_Gaussian_r^2.gii",
                "lh_pRF_Gaussian_x0.gii",
                "lh_pRF_Gaussian_y0.gii",
                "lh_pRF_Gaussian_sigma.gii",
                "lh_pRF_Gaussian_noise_ceiling.gii",
            ]
        );
        assert_eq!(read_back(&files[1]), [2f64.sqrt() as f32 as f64, 0.0, 2.0]);
        assert_eq!(read_back(&files[6]), [0.9f32 as f64, 0.8f32 as f64, 0.7f32 as f64]);
    }

    #[test]
    fn named_selection_is_case_insensitive() {
        let selection = ExportSelection::Named(vec!["eccentricity".into(), "SIGMA".into()]);
        let files = export_giis(&prf_maps(), "rh", &selection);
        let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(names, ["rh_ecc.gii", "rh_sigma.gii"]);
        assert_eq!(read_back(&files[1]), [0.1f32 as f64, 0.2f32 as f64, 0.3f32 as f64]);
    }
}

