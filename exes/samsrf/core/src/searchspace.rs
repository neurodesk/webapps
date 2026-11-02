//! `prf_generate_searchspace`: every combination of the model's `Param1..Param10` grids,
//! its pRF profile on the aperture pixels and the predicted time course of each.
//!
//! Grid order is MATLAB's `ndgrid(Param2, Param1, Param3, ..., Param10)` linearised
//! column-major: `Param2` varies fastest, then `Param1`, then `Param3` and so on. The
//! coarse fit takes the first of tied maxima in this order, so the order is part of the
//! numerics. With `Polar_Search_Space`, `Param1` is the polar angle in degrees and
//! `Param2` the eccentricity, converted with `pol2cart` before the profile is evaluated.

use crate::apertures::Apertures;
use crate::error::{Error, Result};
use crate::expr::{AnonymousFunction, Value};
use crate::prf::predict_timecourse;

/// The search space: `grid_points` parameter rows (`parameters` values each, the first
/// `parameters` of SamSrf's ten) and one predicted time course per grid point.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchSpace {
    pub parameters: usize,
    pub grid_points: usize,
    /// `S`: row-major, `grid_points x parameters`.
    pub params: Vec<f64>,
    /// `X`: row-major, `grid_points x volumes` (each prediction contiguous).
    pub predictions: Vec<f64>,
    pub volumes: usize,
}

impl SearchSpace {
    pub fn point(&self, index: usize) -> &[f64] {
        &self.params[index * self.parameters..(index + 1) * self.parameters]
    }

    pub fn prediction(&self, index: usize) -> &[f64] {
        &self.predictions[index * self.volumes..(index + 1) * self.volumes]
    }
}

/// The parameter rows of the grid in SamSrf's order, before any profile is evaluated.
/// `grids` holds `Param1..Param10` (an unused parameter is `[0]`); every row has ten values.
pub fn grid_rows(grids: &[Vec<f64>], polar: bool) -> Vec<[f64; 10]> {
    let mut lengths: Vec<usize> = grids.iter().map(|grid| grid.len().max(1)).collect();
    lengths.resize(10, 1);
    let total: usize = lengths.iter().product();
    let value = |p: usize, i: usize| grids.get(p).and_then(|grid| grid.get(i)).copied().unwrap_or(0.0);
    let mut rows = Vec::with_capacity(total);
    for n in 0..total {
        let mut index = n;
        let i2 = index % lengths[1];
        index /= lengths[1];
        let i1 = index % lengths[0];
        index /= lengths[0];
        let mut row = [0.0; 10];
        row[0] = value(0, i1);
        row[1] = value(1, i2);
        for (p, &length) in lengths.iter().enumerate().skip(2) {
            row[p] = value(p, index % length);
            index /= length;
        }
        if polar {
            let (theta, rho) = (row[0] / 180.0 * std::f64::consts::PI, row[1]);
            row[0] = rho * theta.cos();
            row[1] = rho * theta.sin();
        }
        rows.push(row);
    }
    rows
}

/// Evaluates the pRF function on the aperture coordinates and predicts the time course of
/// every grid point. `xy` is the scaled `ApXY` as a `pixels x 2` value (with the NaN row
/// of `Aperture_Mean_Response` when that is on). `keep` says how many of the ten
/// parameters the model names; only those are stored in `params`.
pub fn generate(
    prf_function: &AnonymousFunction,
    apertures: &Apertures,
    xy: &Value,
    grids: &[Vec<f64>],
    polar: bool,
    keep: usize,
    mut progress: impl FnMut(usize, usize),
) -> Result<SearchSpace> {
    let rows = grid_rows(grids, polar);
    let volumes = apertures.volumes();
    let mut params = Vec::with_capacity(rows.len() * keep);
    let mut predictions = Vec::with_capacity(rows.len() * volumes);
    for (n, row) in rows.iter().enumerate() {
        let profile = prf_function.evaluate(&[Value { rows: 1, cols: 10, data: row.to_vec() }, xy.clone()])?;
        if profile.cols != 1 {
            return Err(Error::NotImplemented("multi-condition predictions"));
        }
        predictions.extend(predict_timecourse(&profile.data, apertures));
        params.extend_from_slice(&row[..keep]);
        if n % 256 == 255 {
            progress(n + 1, rows.len());
        }
    }
    Ok(SearchSpace { parameters: keep, grid_points: rows.len(), params, predictions, volumes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_order_is_param2_fastest_then_param1_then_the_rest() {
        let grids = vec![vec![10.0, 20.0], vec![1.0, 2.0, 3.0], vec![0.5, 0.7]];
        let rows = grid_rows(&grids, false);
        assert_eq!(rows.len(), 12);
        assert_eq!(&rows[0][..3], &[10.0, 1.0, 0.5]);
        assert_eq!(&rows[1][..3], &[10.0, 2.0, 0.5]);
        assert_eq!(&rows[3][..3], &[20.0, 1.0, 0.5]);
        assert_eq!(&rows[6][..3], &[10.0, 1.0, 0.7]);
        assert_eq!(&rows[11][..3], &[20.0, 3.0, 0.7]);
        assert_eq!(rows[11][3..], [0.0; 7]);
    }

    #[test]
    fn polar_grids_become_cartesian() {
        let rows = grid_rows(&[vec![0.0, 90.0], vec![2.0]], true);
        assert_eq!(rows[0][0], 2.0);
        assert_eq!(rows[0][1], 0.0);
        assert!(rows[1][0].abs() < 1e-15);
        assert_eq!(rows[1][1], 2.0);
    }
}
