//! `samsrf_revcor_cf` and `samsrf_cfparam_loop`: reverse-correlation connective fields.
//! A vertex's profile is its correlation with every seed-region time course, optionally
//! smoothed across the seed region with geodesic weights; the peak seed vertex, its
//! template `x0`/`y0` and the area above half maximum give the CF parameters, refined
//! by the convex hull of the suprathreshold cluster (`Fit_pRF = 0`), summary statistics
//! (`-1`) or a 2D Gaussian fit to the template coordinates (`1`).
//!
//! Two SamSrf quirks are kept because the numbers are SamSrf's: `Fwhm` sums
//! `Area(R > mR/2)`, which indexes the first `nsvx` vertices of the hemisphere rather
//! than the seed vertices; and the Gaussian fit's residual subtracts a column from a
//! row, so it sums over every pair of seed vertices. `Vx` is SamSrf's 1-based vertex index.

use crate::error::{Error, Result};
use crate::expr::Value;
use crate::fit_prf::{dot, nan_max, normalise, xy_value};
use crate::geometry::{cluster_roi, unique_rows, Hull, Triangulation};
use crate::mapset::Maps;
use crate::mesh::Adjacency;
use crate::model::{CfModel, CfParameterEstimate, FineFit};
use crate::optim::{self, FminsearchOptions};
use crate::prf;
use crate::surface::Surface;

/// One row of the smoothing weights: `(column, weight)` for the non-zero weights, and
/// the row's total weight (`sum(Weights, 2)`).
pub type WeightRow = (Vec<(usize, f64)>, f64);

const SIGMA_PER_FWHM: f64 = 2.0 * 1.177_410_022_515_474_6; // 2 * sqrt(2 ln 2)

#[derive(Debug, Clone)]
pub struct Prepared {
    pub model: CfModel,
    /// Seed vertices in label order (0-based).
    pub seed_vertices: Vec<u32>,
    /// Each seed course, centred and scaled to unit norm (`None` when constant or NaN).
    pub seed_normalised: Vec<Option<Vec<f64>>>,
    /// Template `x0`, `y0` per seed vertex.
    pub seed_xy: Vec<[f64; 2]>,
    /// `Srf.Area` of the first `nsvx` vertices (SamSrf's indexing).
    pub area_prefix: Vec<f64>,
    /// Smoothing weights per seed row, when the model smooths.
    pub weights: Option<Vec<WeightRow>>,
    pub values: Vec<String>,
    pub hooke_jeeves_steps: Option<Vec<f64>>,
    // Convex-hull geometry over the unique template coordinates.
    unique_xy: Vec<[f64; 2]>,
    unique_first: Vec<usize>,
    triangulation: Option<Triangulation>,
}

impl Prepared {
    pub fn new(
        model: &CfModel,
        seed_vertices: &[u32],
        seed_courses: &[&[f64]],
        template: &Maps,
        area: &[f64],
        surface: Option<&Surface>,
    ) -> Result<Prepared> {
        let model = model.clone();
        if model.save_rmaps {
            return Err(Error::NotImplemented("Save_Rmaps"));
        }
        let nsvx = seed_vertices.len();
        if nsvx == 0 {
            return Err(Error::Shape("the seed region has no vertices".into()));
        }
        if template.rows() < 3 {
            return Err(Error::Shape("the template map needs R^2, x0 and y0 rows".into()));
        }
        if area.len() < nsvx {
            return Err(Error::Shape(format!("Srf.Area has {} vertices but the seed region has {nsvx}", area.len())));
        }
        let seed_xy: Vec<[f64; 2]> = seed_vertices
            .iter()
            .map(|&v| {
                let v = v as usize;
                if v >= template.vertices {
                    return Err(Error::Shape(format!("seed vertex {v} is outside the template map ({} vertices)", template.vertices)));
                }
                Ok([template.row(1)[v], template.row(2)[v]])
            })
            .collect::<Result<_>>()?;
        let seed_normalised = seed_courses.iter().map(|course| normalise(course)).collect();
        let weights = if model.smoothing > 0.0 {
            let surface = surface.ok_or_else(|| Error::Shape("Smoothing needs the cortical surface (vertices and faces)".into()))?;
            let adjacency = Adjacency::new(surface.vertices.len(), &surface.faces);
            let distances = adjacency.geo_matrix(seed_vertices, 20);
            let rows = (0..nsvx)
                .map(|i| {
                    let mut entries = Vec::new();
                    let mut total = 0.0;
                    for j in 0..nsvx {
                        let d = distances[i * nsvx + j];
                        let w = (-(d * d) / (2.0 * model.smoothing * model.smoothing)).exp();
                        total += w;
                        if w != 0.0 {
                            entries.push((j, w));
                        }
                    }
                    (entries, total)
                })
                .collect();
            Some(rows)
        } else {
            None
        };
        let (unique_xy, unique_first) = unique_rows(&seed_xy);
        let triangulation = (model.fit_prf == CfParameterEstimate::ConvexHull).then(|| Triangulation::delaunay(&unique_xy));
        let values: Vec<String> = match model.fit_prf {
            CfParameterEstimate::Gaussian => vec!["R^2", "x0", "y0", "Sigma", "Beta", "Baseline", "Fwhm", "Vx"],
            CfParameterEstimate::ConvexHull => vec!["R^2", "x0", "y0", "Centre", "Surround", "Beta", "Suppression", "Fwhm", "Vx"],
            CfParameterEstimate::SummaryStatistics => vec!["R^2", "x0", "y0", "Sigma", "Fwhm", "Vx"],
        }
        .into_iter()
        .map(String::from)
        .collect();
        let hooke_jeeves_steps = match (&model.fit_prf, &model.fine_fit) {
            (CfParameterEstimate::Gaussian, FineFit::HookeJeeves { steps }) => Some(steps.clone()),
            _ => None,
        };
        Ok(Prepared {
            model,
            seed_vertices: seed_vertices.to_vec(),
            seed_normalised,
            seed_xy,
            area_prefix: area[..nsvx].to_vec(),
            weights,
            values,
            hooke_jeeves_steps,
            unique_xy,
            unique_first,
            triangulation,
        })
    }

    pub fn rows(&self) -> usize {
        self.values.len()
    }

    /// `corr(Y, X)` over the seed courses, smoothed when the model asks for it.
    pub fn profile(&self, y: &[f64]) -> Vec<f64> {
        let nsvx = self.seed_vertices.len();
        let yn = normalise(y);
        let r: Vec<f64> = self
            .seed_normalised
            .iter()
            .map(|xn| match (&yn, xn) {
                (Some(yn), Some(xn)) => dot(yn, xn),
                _ => f64::NAN,
            })
            .collect();
        match &self.weights {
            None => r,
            Some(rows) => (0..nsvx)
                .map(|i| {
                    let (entries, total) = &rows[i];
                    let sum: f64 = entries.iter().map(|(j, w)| if r[*j].is_nan() { 0.0 } else { r[*j] * w }).sum();
                    sum / total
                })
                .collect(),
        }
    }

    /// The output rows of one vertex.
    pub fn estimate(&self, y: &[f64]) -> Result<Vec<f64>> {
        let rows = self.rows();
        let r = self.profile(y);
        let max = nan_max(&r);
        let mut fwhm = 0.0;
        for (j, value) in r.iter().enumerate() {
            if *value > max / 2.0 {
                fwhm += self.area_prefix[j];
            }
        }
        let fwhm = fwhm.sqrt();
        let Some(m) = r.iter().position(|value| *value == max) else {
            return Ok(vec![0.0; rows]);
        };
        if max.is_nan() || max <= 0.0 {
            return Ok(vec![0.0; rows]);
        }
        let vx = f64::from(self.seed_vertices[m]) + 1.0;
        let r2 = max * max;
        match self.model.fit_prf {
            CfParameterEstimate::ConvexHull => {
                let unique_r: Vec<f64> = self.unique_first.iter().map(|&j| r[j]).collect();
                let max_u = nan_max(&unique_r);
                let triangulation = self.triangulation.as_ref().expect("a triangulation");
                let (x0, y0, centre) = match unique_r.iter().position(|value| *value == max_u) {
                    Some(peak) => {
                        let cluster = cluster_roi(peak, &unique_r, max_u / 2.0, triangulation);
                        let points: Vec<[f64; 2]> = cluster.iter().map(|&i| self.unique_xy[i]).collect();
                        hull_estimate(&points)
                    }
                    None => (f64::NAN, f64::NAN, 0.0),
                };
                let min_u = nan_min(&unique_r);
                let negative: Vec<[f64; 2]> = unique_r.iter().enumerate().filter(|(_, value)| **value < min_u / 2.0).map(|(i, _)| self.unique_xy[i]).collect();
                let (_, _, surround) = hull_estimate(&negative);
                Ok(vec![r2, x0, y0, centre, surround, max_u, min_u, fwhm, vx])
            }
            CfParameterEstimate::SummaryStatistics => {
                let above: Vec<[f64; 2]> = r.iter().enumerate().filter(|(_, value)| **value > max / 2.0).map(|(j, _)| self.seed_xy[j]).collect();
                let (unique, _) = unique_rows(&above);
                let xs: Vec<f64> = unique.iter().map(|p| p[0]).collect();
                let ys: Vec<f64> = unique.iter().map(|p| p[1]).collect();
                let sigma = (mad(&xs).powi(2) + mad(&ys).powi(2)).sqrt();
                Ok(vec![r2, nanmedian(&xs), nanmedian(&ys), sigma, fwhm, vx])
            }
            CfParameterEstimate::Gaussian => {
                let thresholded: Vec<f64> = r.iter().map(|value| (value - max / 2.0).max(0.0)).collect();
                let (fit, r2_fit) = self.fit_gaussian(&thresholded, self.seed_xy[m])?;
                Ok(vec![r2_fit, fit[0], fit[1], fit[2], fit[3], fit[4], fwhm, vx])
            }
        }
    }

    /// `samsrf_fit2dprf` on the thresholded profile for `Sigma` seeds `10^(-2:2)`; the
    /// attempt with the highest `R^2` wins. Returns `[x0, y0, Sigma, Beta, Baseline]`.
    fn fit_gaussian(&self, r: &[f64], peak: [f64; 2]) -> Result<(Vec<f64>, f64)> {
        let n = r.len() as f64;
        let xy = xy_value(&self.seed_xy);
        let sum_r: f64 = r.iter().sum();
        let sum_r2: f64 = r.iter().map(|value| value * value).sum();
        let mean = sum_r / n;
        let total: f64 = r.iter().map(|value| (value - mean) * (value - mean)).sum();
        let smoothed = self.weights.is_some();
        let mut best: Option<(Vec<f64>, f64)> = None;
        for exponent in -2..=2 {
            let sigma = 10f64.powi(exponent);
            let seeds = vec![peak[0], peak[1], sigma, 1.0, 0.0];
            let mut failure: Option<Error> = None;
            let mut errfun = |p: &[f64]| match prf::call("prf_gaussian_rf", &[Value::scalar(p[0]), Value::scalar(p[1]), Value::scalar(p[2]), xy.clone()]) {
                // Smoothing turns `corr`'s row into a column, so `Rmap - M` is elementwise;
                // the unsmoothed row minus the column broadcasts to N x N.
                Ok(profile) if smoothed => profile.data.iter().zip(r).map(|(value, observed)| {
                    let residual = observed - (value * p[3] + p[4]);
                    residual * residual
                }).sum(),
                Ok(profile) => {
                    // sum over i, j of (R_j - M_i)^2 with M = profile * beta + baseline.
                    let mut sum_m = 0.0;
                    let mut sum_m2 = 0.0;
                    for value in &profile.data {
                        let m = value * p[3] + p[4];
                        sum_m += m;
                        sum_m2 += m * m;
                    }
                    n * sum_r2 - 2.0 * sum_r * sum_m + n * sum_m2
                }
                Err(error) => {
                    failure.get_or_insert(error);
                    f64::NAN
                }
            };
            let (params, residual) = match &self.hooke_jeeves_steps {
                Some(steps) => {
                    let mut steps = steps.clone();
                    steps.push(0.1);
                    steps.push(0.01);
                    optim::hooke_jeeves(&mut errfun, &seeds, &steps, &[false; 5], 1000, 10)
                }
                None => {
                    let tolerance = match &self.model.fine_fit {
                        FineFit::NelderMead { tolerance: Some(tolerance) } => *tolerance,
                        _ => 1e-4,
                    };
                    let result = optim::fminsearch(&mut errfun, &seeds, &FminsearchOptions { tol_x: tolerance, ..Default::default() });
                    (result.x, result.fval)
                }
            };
            if let Some(error) = failure {
                return Err(error);
            }
            let r2 = 1.0 - residual / total;
            // nanmax: the first of the best; a NaN never wins.
            let better = match &best {
                None => !r2.is_nan(),
                Some((_, best_r2)) => r2 > *best_r2,
            };
            if better {
                best = Some((params, r2));
            }
        }
        Ok(best.unwrap_or((vec![f64::NAN; 5], f64::NAN)))
    }
}

/// `polyshape(points).convhull`: `(centroid x, centroid y, sqrt(area) / (2 sqrt(2 ln 2)))`,
/// `(NaN, NaN, 0)` for a degenerate point set.
fn hull_estimate(points: &[[f64; 2]]) -> (f64, f64, f64) {
    match Hull::of_polygon(points) {
        Some(hull) => {
            let [cx, cy] = hull.centroid();
            (cx, cy, hull.area().sqrt() / SIGMA_PER_FWHM)
        }
        None => (f64::NAN, f64::NAN, 0.0),
    }
}

fn nan_min(values: &[f64]) -> f64 {
    values.iter().copied().filter(|value| !value.is_nan()).fold(f64::NAN, |best, value| if best.is_nan() || value < best { value } else { best })
}

/// `nanmedian`: the median of the non-NaN values, NaN when there are none.
pub fn nanmedian(values: &[f64]) -> f64 {
    let mut sorted: Vec<f64> = values.iter().copied().filter(|value| !value.is_nan()).collect();
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

/// `mad(x, 1)`: the median absolute deviation from the median.
pub fn mad(values: &[f64]) -> f64 {
    let median = nanmedian(values);
    let deviations: Vec<f64> = values.iter().map(|value| (value - median).abs()).collect();
    nanmedian(&deviations)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polygon_hull_discards_a_retraced_zero_area_spike() {
        // MATLAB R2023b, SamSrf 41ed1e96: cf_double_cocircular, target 29.
        // The closing edge retraces the first edge, so polyshape removes (-1,-1).
        let points = [[-1.0, -1.0], [0.0, 0.0], [0.0, 1.0], [1.0, -1.0], [1.0, 0.0], [1.0, 1.0]];
        let (x, y, sigma) = hull_estimate(&points);
        assert!((sigma - 1.5_f64.sqrt() / SIGMA_PER_FWHM).abs() < 1e-14);
        assert!(x.is_finite() && y.is_finite());
    }

    #[test]
    fn median_and_mad_follow_matlab() {
        assert_eq!(nanmedian(&[3.0, 1.0, 2.0]), 2.0);
        assert_eq!(nanmedian(&[4.0, 1.0, 3.0, 2.0]), 2.5);
        assert_eq!(nanmedian(&[f64::NAN, 1.0]), 1.0);
        assert!(nanmedian(&[]).is_nan());
        assert_eq!(mad(&[1.0, 2.0, 4.0, 8.0]), 1.5);
    }
}
