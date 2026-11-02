//! `samsrf_revcor_prf`: reverse-correlation pRF profiles. Each aperture pixel's time
//! course, convolved with the HRF, is a regressor; a vertex's profile is the slope of
//! each regressor on its time course (`[Y 1] \ X`). The peak gives `x0`, `y0`, `Beta`
//! and `R^2`, the area above half maximum the `Fwhm`. Then either the convex hull of
//! the suprathreshold pixels (`Prf_Function = 0`) replaces `x0`, `y0` and the width, or
//! a 2D pRF model is fitted to the profile (`samsrf_fit2dprf`).
//!
//! Not supported: `Micro_Probing`, `Save_Rmaps` (the downsampled profiles are not
//! kept, so `imresize` is never needed) and non-square apertures with a pRF function
//! (`samsrf_fit2dprf` resizes the apertures to the profile's side length).

use crate::apertures::Apertures;
use crate::error::{Error, Result};
use crate::expr::Value;
use crate::geometry::Hull;
use crate::hrf::{self, ResolvedHrf};
use crate::model::{FineFit, RevCorPrfModel};
use crate::optim::{self, FminsearchOptions};
use crate::prf;

pub const RAW_VALUES: [&str; 5] = ["R^2", "x0", "y0", "Fwhm", "Beta"];

#[derive(Debug, Clone)]
pub struct Prepared {
    pub model: RevCorPrfModel,
    pub rows: usize,
    pub cols: usize,
    pub pixels: usize,
    pub volumes: usize,
    /// Convolved regressors, pixel-major (`pixels x volumes`, each regressor contiguous).
    pub regressors: Vec<f64>,
    /// `xc(:)`, `yc(:)`: visual-space coordinates per pixel in SamSrf's pixel order.
    pub xc: Vec<f64>,
    pub yc: Vec<f64>,
    /// `Mask` of `samsrf_fit2dprf`: pixels any aperture frame covers (row-major grid order
    /// is the same column-major pixel order), when a pRF model is fitted.
    pub mask: Vec<f64>,
    pub values: Vec<String>,
    pub hooke_jeeves_steps: Option<Vec<f64>>,
}

impl Prepared {
    pub fn new(model: &RevCorPrfModel, apertures: &Apertures, hrf: &ResolvedHrf, volumes: usize) -> Result<Prepared> {
        let model = model.clone();
        if model.micro_probing != 0.0 {
            return Err(Error::NotImplemented("Micro_Probing"));
        }
        if model.save_rmaps {
            return Err(Error::NotImplemented("Save_Rmaps"));
        }
        if volumes != apertures.volumes() {
            return Err(Error::Shape("Mismatch between length of apertures and data!".into()));
        }
        let kernel = match hrf {
            ResolvedHrf::Kernel(kernel) => kernel.clone(),
            ResolvedHrf::None => vec![1.0],
            ResolvedHrf::Fit => return Err(Error::Model("Hrf = Inf is only available in samsrf_fit_prf".into())),
        };
        let (rows, cols) = (apertures.height, apertures.width);
        let pixels = rows * cols;
        let dense = apertures.to_dense();
        let mut regressors = vec![0.0; pixels * volumes];
        let mut mask = vec![0.0; pixels];
        for p in 0..pixels {
            let course: Vec<f64> = (0..volumes).map(|t| dense[t * pixels + p]).collect();
            if course.iter().any(|value| *value != 0.0) {
                mask[p] = 1.0;
            }
            let convolved = hrf::convolve(&course, &kernel, 1);
            regressors[p * volumes..(p + 1) * volumes].copy_from_slice(&convolved);
        }
        let xs = linspace(-model.scaling_factor, model.scaling_factor, cols);
        let ys = linspace(-model.scaling_factor, model.scaling_factor, rows);
        let mut xc = Vec::with_capacity(pixels);
        let mut yc = Vec::with_capacity(pixels);
        for p in 0..pixels {
            let (r, c) = (p % rows, p / rows);
            xc.push(xs[c]);
            yc.push(ys[rows - 1 - r]);
        }
        let mut values: Vec<String> = RAW_VALUES.iter().map(|value| value.to_string()).collect();
        let mut hooke_jeeves_steps = None;
        if model.prf_function.is_some() {
            if rows != cols {
                return Err(Error::NotImplemented("a pRF model fit on non-square apertures"));
            }
            values = vec!["R^2".into()];
            values.extend(model.param_names.iter().cloned());
            values.push("Beta".into());
            values.push("Baseline".into());
            if let FineFit::HookeJeeves { steps } = &model.fine_fit {
                hooke_jeeves_steps = Some(steps.clone());
            }
        }
        Ok(Prepared { model, rows, cols, pixels, volumes, regressors, xc, yc, mask, values, hooke_jeeves_steps })
    }

    fn regressor(&self, pixel: usize) -> &[f64] {
        &self.regressors[pixel * self.volumes..(pixel + 1) * self.volumes]
    }

    /// `cM = [Y ones] \ X` without the intercept row: the slope of each regressor on `y`.
    /// All NaN when `y` is constant (a rank-deficient system).
    pub fn profile(&self, y: &[f64]) -> Vec<f64> {
        let n = y.len() as f64;
        let mean = y.iter().sum::<f64>() / n;
        let centred: Vec<f64> = y.iter().map(|value| value - mean).collect();
        let variance: f64 = centred.iter().map(|value| value * value).sum();
        if variance == 0.0 || !variance.is_finite() {
            return vec![f64::NAN; self.pixels];
        }
        (0..self.pixels).map(|p| crate::fit_prf::dot(&centred, self.regressor(p)) / variance).collect()
    }

    /// The reverse-correlation rows `[R^2, x0, y0, Fwhm, Beta]` of one time course, and
    /// the profile they came from.
    pub fn reverse_correlate(&self, y: &[f64]) -> ([f64; 5], Vec<f64>) {
        let model = &self.model;
        let mut cm = self.profile(y);
        let mut peak_sign = 1.0;
        if model.allow_negative_peaks && crate::fit_prf::nan_max(&cm).abs() < nan_min(&cm).abs() {
            for value in &mut cm {
                *value = -*value;
            }
            peak_sign = -1.0;
        }
        let max = crate::fit_prf::nan_max(&cm);
        let Some(m) = cm.iter().position(|value| *value == max) else {
            return ([0.0; 5], cm);
        };
        let above = cm.iter().filter(|value| **value > max / 2.0).count() as f64 / self.pixels as f64;
        let r = prf::pearson(y, self.regressor(m));
        if r.is_nan() {
            return ([0.0; 5], cm);
        }
        let fwhm = (above * (model.scaling_factor * 2.0).powi(2)).sqrt();
        ([r * r, self.xc[m], self.yc[m], fwhm, max * peak_sign], cm)
    }

    /// The convex hull estimate: `x0`, `y0` and `sqrt(area) / (2 sqrt(2 ln 2))` replace
    /// rows 2-4 of `raw`; a profile whose suprathreshold pixels span no area zeroes the
    /// whole column, as SamSrf's `catch` does.
    pub fn convex_hull(&self, raw: &[f64; 5], profile: &[f64]) -> Vec<f64> {
        let model = &self.model;
        let mut rmap = profile.to_vec();
        if model.allow_negative_peaks && crate::fit_prf::nan_max(&rmap).abs() < nan_min(&rmap).abs() {
            for value in &mut rmap {
                *value = -*value;
            }
        }
        let max = crate::fit_prf::nan_max(&rmap);
        let threshold = max * model.convex_hull_threshold;
        let points: Vec<[f64; 2]> = (0..self.pixels).filter(|&p| rmap[p] > threshold).map(|p| [self.xc[p], self.yc[p]]).collect();
        match Hull::of(&points) {
            Some(hull) => {
                let [cx, cy] = hull.centroid();
                vec![raw[0], cx, cy, hull.area().sqrt() / (2.0 * (2.0 * 2f64.ln()).sqrt()), raw[4]]
            }
            None => vec![0.0; 5],
        }
    }

    /// `samsrf_revcorprf_loop` for one vertex: NaN rows below `R2_Threshold`, otherwise
    /// `samsrf_fit2dprf` on the profile, kept when no scaled parameter exceeds
    /// `1.5 * Scaling_Factor`.
    pub fn fit_model(&self, raw: &[f64; 5], profile: &[f64]) -> Result<Vec<f64>> {
        let model = &self.model;
        let rows = self.values.len();
        if raw[0].is_nan() || raw[0] <= model.r2_threshold {
            return Ok(vec![f64::NAN; rows]);
        }
        let prf_function = model.prf_function.as_ref().expect("a pRF function");
        let seed_function = model.seedpar_function.as_ref().expect("a seed function");
        let mut rmap = profile.to_vec();
        let mut peak_sign = 1.0;
        if model.allow_negative_peaks && crate::fit_prf::nan_max(&rmap).abs() < nan_min(&rmap).abs() {
            for value in &mut rmap {
                *value = -*value;
            }
            peak_sign = -1.0;
        }
        let seeds = seed_function.evaluate(&[Value::column(raw.to_vec())])?;
        if seeds.data.len() != model.param_names.len() {
            return Err(Error::Shape("Length of seed parameter vector mismatches scaling vector!".into()));
        }
        let mut seeds = seeds.data;
        // samsrf_fit2dprf scales `1:length(SeedParams)-2` before the betas are appended,
        // so only the first `n - 2` seeds are divided by the scaling factor.
        for p in 0..seeds.len().saturating_sub(2) {
            if model.scaled_param[p] {
                seeds[p] /= model.scaling_factor;
            }
        }
        seeds.push(1.0);
        seeds.push(0.0);
        let dims = self.rows;
        let mut failure: Option<Error> = None;
        let mut errfun = |p: &[f64]| {
            let n = p.len();
            match prf_function.evaluate(&[Value::column(p[..n - 2].to_vec()), Value::scalar(dims as f64)]) {
                Ok(profile) => {
                    let mut total = 0.0;
                    for (pixel, observed) in rmap.iter().enumerate() {
                        let modelled = (profile.data[pixel] * p[n - 2] + p[n - 1]) * self.mask[pixel];
                        let difference = observed - modelled;
                        total += difference * difference;
                    }
                    total
                }
                Err(error) => {
                    failure.get_or_insert(error);
                    f64::NAN
                }
            }
        };
        let (mut params, residual) = match &self.hooke_jeeves_steps {
            Some(steps) => {
                let mut steps = steps.clone();
                steps.push(0.1);
                steps.push(0.01);
                let only_positive = vec![false; seeds.len()];
                optim::hooke_jeeves(&mut errfun, &seeds, &steps, &only_positive, 1000, 10)
            }
            None => {
                let tolerance = match &model.fine_fit {
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
        let mean = rmap.iter().sum::<f64>() / rmap.len() as f64;
        let total: f64 = rmap.iter().map(|value| (value - mean) * (value - mean)).sum();
        let r2 = 1.0 - residual / total;
        let n = params.len();
        for (p, scaled) in model.scaled_param.iter().enumerate() {
            if *scaled {
                params[p] = params[p] * model.scaling_factor / 2.0;
            }
        }
        params[n - 2] *= peak_sign;
        params[n - 1] *= peak_sign;
        let keep = model.scaled_param.iter().enumerate().all(|(p, scaled)| !scaled || params[p].abs() <= model.scaling_factor * 1.5);
        if !keep {
            return Ok(vec![f64::NAN; rows]);
        }
        let mut row = vec![r2];
        row.extend(params);
        Ok(row)
    }
}

fn nan_min(values: &[f64]) -> f64 {
    values.iter().copied().filter(|value| !value.is_nan()).fold(f64::NAN, |best, value| if best.is_nan() || value < best { value } else { best })
}

/// MATLAB `linspace`.
fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![b];
    }
    let steps = (n - 1) as f64;
    let mut values: Vec<f64> = (0..n).map(|i| a + (i as f64 * (b - a)) / steps).collect();
    values[n - 1] = b;
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apertures::Frame;
    use crate::model::{parse_model_json, AnalysisKind, Model};

    /// A 2 x 2 aperture lit one pixel per volume, then dark.
    fn apertures() -> Apertures {
        let frames = (0..4).map(|p| Frame { indices: vec![p], values: vec![1.0] }).chain(std::iter::repeat_n(Frame { indices: vec![], values: vec![] }, 4)).collect();
        Apertures { width: 2, height: 2, frames, xy: vec![[-0.5, 0.5], [-0.5, -0.5], [0.5, 0.5], [0.5, -0.5]], conditions: None }
    }

    fn model() -> RevCorPrfModel {
        let json = r#"{"Name":"pRF","Scaling_Factor":2,"TR":1,"Hrf":1,"Aperture_File":"aps"}"#;
        match parse_model_json(AnalysisKind::RevCorPrf, json).unwrap() {
            Model::RevCorPrf(model) => model,
            _ => unreachable!(),
        }
    }

    #[test]
    fn the_peak_pixel_gives_the_coordinates() {
        let prepared = Prepared::new(&model(), &apertures(), &ResolvedHrf::None, 8).unwrap();
        assert_eq!(prepared.xc, vec![-2.0, -2.0, 2.0, 2.0]);
        assert_eq!(prepared.yc, vec![2.0, -2.0, 2.0, -2.0]);
        // A course that follows pixel 2 (top right).
        let y = [0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let (row, profile) = prepared.reverse_correlate(&y);
        assert_eq!(row[0], 1.0);
        assert_eq!((row[1], row[2]), (2.0, 2.0));
        assert_eq!(row[4], 1.0);
        assert_eq!(profile[2], 1.0);
        // One of four pixels above half maximum: Fwhm = sqrt(0.25 * 16) = 2.
        assert_eq!(row[3], 2.0);
        let hull = prepared.convex_hull(&row, &profile);
        assert_eq!(hull, vec![0.0; 5], "one pixel spans no area, so SamSrf zeroes the column");
    }
}
