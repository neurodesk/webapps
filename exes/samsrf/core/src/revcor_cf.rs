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
use crate::precision::{gemv_t_single, sum_single, Precision};
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
    /// Single seed courses centred in single, and their norms, for `corr(y, X)`.
    seed_centred: Vec<Vec<f32>>,
    seed_norms: Vec<f32>,
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
        let seed_centred: Vec<Vec<f32>> = seed_courses.iter().map(|course| centre_single(course)).collect();
        let seed_norms = seed_centred.iter().map(|course| norm_single(course)).collect();
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
            seed_centred,
            seed_norms,
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
        if self.model.data_precision == Precision::Single {
            return self.profile_single(y);
        }
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

    /// Single courses: `corr(y, X)` and the smoothing run in single; the double
    /// weights round each product and the quotient to single. `corr` centres both in
    /// single, forms `yc' * Xc` as one product (`gemv_t_single`), divides by `y`'s
    /// norm and then by each seed's, and limits the result to [-1, 1].
    fn profile_single(&self, y: &[f64]) -> Vec<f64> {
        let yc = centre_single(y);
        let ny = norm_single(&yc);
        let columns: Vec<&[f32]> = self.seed_centred.iter().map(Vec::as_slice).collect();
        let r: Vec<f32> = gemv_t_single(&yc, &columns).iter().zip(&self.seed_norms).map(|(product, nx)| {
            // corr.m limits each coefficient to [-1, 1]: r = r ./ abs(r) where |r| > 1.
            let r = (product / ny) / nx;
            if r.abs() > 1.0 { r / r.abs() } else { r }
        }).collect();
        match &self.weights {
            None => r.into_iter().map(f64::from).collect(),
            Some(rows) => rows
                .iter()
                .map(|(entries, total)| {
                    let mut sum = 0.0f32;
                    for (j, w) in entries {
                        let product = (f64::from(r[*j]) * w) as f32;
                        if !product.is_nan() {
                            sum += product;
                        }
                    }
                    f64::from((f64::from(sum) / total) as f32)
                })
                .collect(),
        }
    }

    /// The output rows of one vertex.
    pub fn estimate(&self, y: &[f64]) -> Result<Vec<f64>> {
        let r = self.profile(y);
        self.estimate_profile(&r)
    }

    /// Estimate parameters from an already correlated and smoothed seed profile.
    /// This also lets reference validation isolate geometry from correlation.
    pub fn estimate_profile(&self, r: &[f64]) -> Result<Vec<f64>> {
        if r.len() != self.seed_vertices.len() {
            return Err(Error::Shape("CF profile length differs from the seed region".into()));
        }
        let rows = self.rows();
        let max = nan_max(r);
        let above: Vec<f64> = r.iter().zip(&self.area_prefix).filter(|(value, _)| **value > max / 2.0).map(|(_, area)| *area).collect();
        let fwhm = match self.model.data_precision {
            Precision::Double => above.iter().sum::<f64>(),
            Precision::Single => f64::from(sum_single(&above.iter().map(|&area| area as f32).collect::<Vec<_>>())),
        };
        let fwhm = self.model.data_precision.round(fwhm.sqrt());
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
                        hull_estimate(&points)?
                    }
                    None => (f64::NAN, f64::NAN, 0.0),
                };
                let min_u = nan_min(&unique_r);
                let negative: Vec<[f64; 2]> = unique_r.iter().enumerate().filter(|(_, value)| **value < min_u / 2.0).map(|(i, _)| self.unique_xy[i]).collect();
                let (_, _, surround) = hull_estimate(&negative)?;
                Ok(vec![r2, x0, y0, centre, surround, max_u, min_u, fwhm, vx])
            }
            CfParameterEstimate::SummaryStatistics => {
                let above: Vec<[f64; 2]> = r.iter().enumerate().filter(|(_, value)| **value > max / 2.0).map(|(j, _)| self.seed_xy[j]).collect();
                let (unique, _) = unique_rows(&above);
                let xs: Vec<f64> = unique.iter().map(|p| p[0]).collect();
                let ys: Vec<f64> = unique.iter().map(|p| p[1]).collect();
                // The template, and so txy, has the data's precision.
                let p = self.model.data_precision;
                let square = |value: f64| p.round(value * value);
                let sigma = p.round(p.round(square(mad_in(&xs, p)) + square(mad_in(&ys, p))).sqrt());
                Ok(vec![r2, nanmedian_in(&xs, p), nanmedian_in(&ys, p), sigma, fwhm, vx])
            }
            CfParameterEstimate::Gaussian if self.model.data_precision == Precision::Single => {
                // Reached only by validation: the model parser still refuses single
                // precision here until the raw-input gates pass (see `CfModel`).
                let profile: Vec<f32> = r.iter().map(|&value| value as f32).collect();
                let xy: Vec<[f32; 2]> = self.seed_xy.iter().map(|p| [p[0] as f32, p[1] as f32]).collect();
                let tolerance = match &self.model.fine_fit {
                    FineFit::NelderMead { tolerance: Some(tolerance) } => *tolerance,
                    _ => 1e-4,
                };
                let (fit, r2_fit) = fit_gaussian_single(&profile, &xy, self.weights.is_some(), tolerance);
                Ok(vec![f64::from(r2_fit), fit[0], fit[1], fit[2], fit[3], fit[4], fwhm, vx])
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
                    // Preserve the source's column-major broadcast residuals.
                    // Expanding this into moments changes rounding on flat fits.
                    let predicted: Vec<f64> = profile.data.iter().map(|value| value * p[3] + p[4]).collect();
                    let mut sums = [0.0; 4];
                    let mut index = 0;
                    for &observed in r {
                        for &predicted in &predicted {
                            let residual = observed - predicted;
                            sums[if r.len() * r.len() < 44 { 0 } else { index % 4 }] += residual * residual;
                            index += 1;
                        }
                    }
                    sums.iter().sum()
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

/// `samsrf_cfparam_loop`'s `Fit_pRF = 1` branch with single profiles and template
/// coordinates, as R2023b computes it: the profile is thresholded at half its peak
/// in single; each `fminsearch` starts from `[x y Sigma 1 0]` built as a single row
/// (so `Sigma = single(10^e)`); `errfun` mixes single data with double parameters,
/// and every single-double operation runs in double and rounds to single; the
/// residuals and their sum are single, and `R^2` is single. Unsmoothed profiles are
/// rows, so `Rmap - M` expands to N x N. Returns `[x0, y0, Sigma, Beta, Baseline]`
/// and `R^2` of the best of the five starts (`NaN`s when none fits).
pub fn fit_gaussian_single(profile: &[f32], xy: &[[f32; 2]], smoothed: bool, tolerance: f64) -> ([f64; 5], f32) {
    let none = ([f64::NAN; 5], f32::NAN);
    let peak = profile.iter().copied().fold(f32::NAN, f32::max);
    let Some(m) = profile.iter().position(|&value| value == peak) else {
        return none;
    };
    if peak.is_nan() || peak <= 0.0 {
        return none;
    }
    let half = (f64::from(peak) / 2.0) as f32;
    let observed: Vec<f32> = profile.iter().map(|&value| (value - half).max(0.0)).collect();
    let mean = sum_single(&observed) / observed.len() as f32;
    let spread = sum_single(&observed.iter().map(|value| (value - mean) * (value - mean)).collect::<Vec<_>>());
    let objective = |p: &[f64]| -> f64 {
        let denominator = 2.0 * p[2] * p[2];
        let model: Vec<f32> = xy
            .iter()
            .map(|&[x, y]| {
                let dx = (f64::from(x) - p[0]) as f32;
                let dy = (f64::from(y) - p[1]) as f32;
                let exponent = -((f64::from(dx * dx + dy * dy) / denominator) as f32);
                let field = crate::precision::exp_single(exponent);
                ((f64::from((f64::from(field) * p[3]) as f32)) + p[4]) as f32
            })
            .collect();
        let squares: Vec<f32> = if smoothed {
            observed.iter().zip(&model).map(|(o, m)| (o - m) * (o - m)).collect()
        } else {
            // Ds(i, j) = observed(j) - model(i), taken column-major.
            observed.iter().flat_map(|o| model.iter().map(move |m| (o - m) * (o - m))).collect()
        };
        f64::from(sum_single(&squares))
    };
    let mut best: Option<([f64; 5], f32)> = None;
    for exponent in -2..=2 {
        let seed = [f64::from(xy[m][0]), f64::from(xy[m][1]), f64::from(10f64.powi(exponent) as f32), 1.0, 0.0];
        let result = optim::fminsearch(objective, &seed, &FminsearchOptions { tol_x: tolerance, ..Default::default() });
        let r2 = 1.0 - (result.fval / f64::from(spread)) as f32;
        // nanmax: the first of the best; a NaN never wins.
        if best.as_ref().map_or(!r2.is_nan(), |(_, b)| r2 > *b) {
            best = Some((result.x.as_slice().try_into().expect("five parameters"), r2));
        }
    }
    best.unwrap_or(none)
}

/// A single course minus its single `mean`.
fn centre_single(values: &[f64]) -> Vec<f32> {
    let values: Vec<f32> = values.iter().map(|&value| value as f32).collect();
    let mean = sum_single(&values) / values.len() as f32;
    values.iter().map(|value| value - mean).collect()
}

/// `vecnorm` of a single vector: squares summed in double, rounded once.
fn norm_single(values: &[f32]) -> f32 {
    values.iter().map(|&value| f64::from(value).powi(2)).sum::<f64>().sqrt() as f32
}

/// `polyshape(points).convhull`: `(centroid x, centroid y, sqrt(area) / (2 sqrt(2 ln 2)))`,
/// `(NaN, NaN, 0)` for a degenerate point set.
fn hull_estimate(points: &[[f64; 2]]) -> Result<(f64, f64, f64)> {
    Ok(match Hull::of_polygon(points)? {
        Some(hull) => {
            let [cx, cy] = hull.centroid();
            (cx, cy, hull.area().sqrt() / SIGMA_PER_FWHM)
        }
        None => (f64::NAN, f64::NAN, 0.0),
    })
}

fn nan_min(values: &[f64]) -> f64 {
    values.iter().copied().filter(|value| !value.is_nan()).fold(f64::NAN, |best, value| if best.is_nan() || value < best { value } else { best })
}

/// `nanmedian`: the median of the non-NaN values, NaN when there are none.
pub fn nanmedian(values: &[f64]) -> f64 {
    nanmedian_in(values, Precision::Double)
}

/// `nanmedian` in the precision of `values`. An even count takes median.m's
/// `meanof`: `a + (b - a) / 2`, or `(a + b) / 2` when the signs differ.
fn nanmedian_in(values: &[f64], precision: Precision) -> f64 {
    let mut sorted: Vec<f64> = values.iter().copied().filter(|value| !value.is_nan()).collect();
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = sorted.len();
    if n % 2 == 1 {
        return sorted[n / 2];
    }
    let (a, b) = (sorted[n / 2 - 1], sorted[n / 2]);
    let round = |value| precision.round(value);
    if a.signum() != b.signum() || a.is_infinite() || b.is_infinite() {
        round(round(a + b) / 2.0)
    } else {
        round(a + round(round(b - a) / 2.0))
    }
}

/// `mad(x, 1)`: the median absolute deviation from the median.
pub fn mad(values: &[f64]) -> f64 {
    mad_in(values, Precision::Double)
}

fn mad_in(values: &[f64], precision: Precision) -> f64 {
    let median = nanmedian_in(values, precision);
    let deviations: Vec<f64> = values.iter().map(|value| precision.round((value - median).abs())).collect();
    nanmedian_in(&deviations, precision)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polygon_hull_discards_a_retraced_zero_area_spike() {
        // MATLAB R2023b, SamSrf 41ed1e96: cf_double_cocircular, target 29.
        // The closing edge retraces the first edge, so polyshape removes (-1,-1).
        let points = [[-1.0, -1.0], [0.0, 0.0], [0.0, 1.0], [1.0, -1.0], [1.0, 0.0], [1.0, 1.0]];
        let (x, y, sigma) = hull_estimate(&points).unwrap();
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
        // median.m's meanof: (a + b) / 2 across a sign change.
        assert_eq!(nanmedian(&[-1.0, 3.0]), 1.0);
    }

    #[test]
    fn single_medians_round_each_step() {
        let (a, b) = (f64::from(0.1f32), f64::from(0.3f32));
        let expected = f64::from(0.1f32 + (0.3f32 - 0.1f32) / 2.0);
        assert_eq!(nanmedian_in(&[b, a], Precision::Single), expected);
        assert_ne!(nanmedian_in(&[b, a], Precision::Double), expected);
    }
}
