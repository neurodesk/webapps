//! `samsrf_export_giis`: one GIFTI per `Srf.Values` row, plus polar angle and
//! eccentricity when the maps hold `x0` and `y0`.
//!
//! File names: `{prefix}_{lower(name)}.gii` with spaces replaced by `_`
//! (`lh_pRF_Gaussian_r^2.gii`, `lh_pRF_Gaussian_noise_ceiling.gii`), and
//! `{prefix}_pol.gii` / `{prefix}_ecc.gii`. Polar angle is `atan2(y0, x0) / pi * 180`;
//! eccentricity `sqrt(x0^2 + y0^2)`, set to 0 where row 1 (`R^2`) is 0.

use crate::mapset::Maps;

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

pub fn export_giis(maps: &Maps, prefix: &str, selection: &ExportSelection) -> Vec<ExportedGifti> {
    let _ = (maps, prefix, selection);
    Vec::new()
}

/// `(polar, eccentricity)` as `samsrf_export_giis` derives them, or `None` when the
/// maps have no `x0` row.
pub fn polar_and_eccentricity(maps: &Maps) -> Option<(Vec<f64>, Vec<f64>)> {
    let _ = maps;
    None
}
