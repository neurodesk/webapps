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
use crate::geometry::{Hull, HullOrder, ListedHull};
use crate::hrf::{self, ResolvedHrf};
use crate::model::{FineFit, RevCorPrfModel};
use crate::optim::{self, FminsearchOptions};
use crate::precision::Precision;

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
    /// The convex-hull analysis's grid and hull (`Prf_Function = 0`): `Listed`
    /// unless a gate asks for MATLAB's (`with_hull_order`).
    pub hull_order: HullOrder,
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
        let (xc, yc) = pixel_grid(&model, rows, cols, HullOrder::default());
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
        Ok(Prepared { model, rows, cols, pixels, volumes, regressors, xc, yc, mask, values, hooke_jeeves_steps, hull_order: HullOrder::default() })
    }

    /// The same analysis with the convex-hull evaluation `order`, its pixel grid included.
    pub fn with_hull_order(mut self, order: HullOrder) -> Prepared {
        (self.xc, self.yc) = pixel_grid(&self.model, self.rows, self.cols, order);
        self.hull_order = order;
        self
    }

    fn regressor(&self, pixel: usize) -> &[f64] {
        &self.regressors[pixel * self.volumes..(pixel + 1) * self.volumes]
    }

    /// `cM = [Y ones] \ X` without the intercept row: the slope of each regressor on `y`,
    /// in MATLAB's QR over all pixels at once (`lstsq::mldivide_many`, each pixel rounded
    /// by its place among them) and in the data's precision. A constant course makes the
    /// design rank deficient: MATLAB keeps the column with the larger norm, so its
    /// coefficient is `y'x / y'y` when `|y| > 1`, else 0.
    pub fn profile(&self, y: &[f64]) -> Vec<f64> {
        let precision = self.model.data_precision;
        let course: Vec<num_complex::Complex64> = y.iter().map(|&value| num_complex::Complex64::new(value, 0.0)).collect();
        let ones = vec![num_complex::Complex64::new(1.0, 0.0); y.len()];
        // `[Y ones] \ X` with every pixel's regressor as one right-hand side, as
        // MATLAB solves it: each column's arithmetic depends on its place among them.
        let regressors: Vec<&[f64]> = (0..self.pixels).map(|p| self.regressor(p)).collect();
        crate::lstsq::mldivide_many(&[&course, &ones], &regressors, precision).coefficients.iter().map(|c| c[0].re).collect()
    }

    /// The reverse-correlation rows `[R^2, x0, y0, Fwhm, Beta]` of one time course, and
    /// the profile they came from, with its sign as computed: the convex hull and the
    /// model fit flip a negative peak themselves and restore the fitted signs.
    pub fn reverse_correlate(&self, y: &[f64]) -> ([f64; 5], Vec<f64>) {
        let profile = self.profile(y);
        (self.raw_row(y, &profile), profile)
    }

    /// The reverse-correlation rows of one time course from its profile.
    pub fn raw_row(&self, y: &[f64], profile: &[f64]) -> [f64; 5] {
        let model = &self.model;
        let mut cm = profile.to_vec();
        let mut peak_sign = 1.0;
        if model.allow_negative_peaks && crate::fit_prf::nan_max(&cm).abs() < nan_min(&cm).abs() {
            for value in &mut cm {
                *value = -*value;
            }
            peak_sign = -1.0;
        }
        let max = crate::fit_prf::nan_max(&cm);
        let Some(m) = cm.iter().position(|value| *value == max) else {
            return [0.0; 5];
        };
        let above = cm.iter().filter(|value| **value > max / 2.0).count() as f64 / self.pixels as f64;
        // corr(Y, X(:,m)): single when Y is, and so is its square.
        let r2 = match model.data_precision {
            Precision::Double => {
                let course: Vec<num_complex::Complex64> = y.iter().map(|&value| num_complex::Complex64::new(value, 0.0)).collect();
                let r = crate::css::correlation(&course, self.regressor(m), Precision::Double).re;
                r * r
            }
            Precision::Single => {
                let r = crate::precision::correlation_single(self.regressor(m), y, true);
                f64::from(r * r)
            }
        };
        if r2.is_nan() {
            return [0.0; 5];
        }
        let fwhm = (above * (model.scaling_factor * 2.0).powi(2)).sqrt();
        [r2, self.xc[m], self.yc[m], fwhm, max * peak_sign]
    }

    /// The convex hull estimate: `x0` and `y0` from `polyshape(DT.Points(chp, :)).centroid`
    /// and `sqrt(cha) / (2 sqrt(2 ln 2))` from `[chp, cha] = convexHull(DT)` replace rows
    /// 2-4 of `raw`, for `DT` the Delaunay triangulation of the suprathreshold pixels in
    /// pixel order. Pixels that span no area zero the whole column, as SamSrf's `catch`
    /// does; a hull that `polyshape` empties has a NaN centroid.
    pub fn convex_hull(&self, raw: &[f64; 5], profile: &[f64]) -> Vec<f64> {
        let model = &self.model;
        let mut rmap = profile.to_vec();
        if model.allow_negative_peaks && crate::fit_prf::nan_max(&rmap).abs() < nan_min(&rmap).abs() {
            for value in &mut rmap {
                *value = -*value;
            }
        }
        let max = crate::fit_prf::nan_max(&rmap);
        let threshold = model.data_precision.round(max * model.convex_hull_threshold);
        let points: Vec<[f64; 2]> = (0..self.pixels).filter(|&p| rmap[p] > threshold).map(|p| [self.xc[p], self.yc[p]]).collect();
        let Some(listed) = ListedHull::of(&points) else {
            return vec![0.0; 5];
        };
        let [cx, cy] = match self.hull_order {
            HullOrder::Listed => listed.centroid(),
            HullOrder::Stored => Hull::of_delaunay_boundary(&points).map_or([f64::NAN; 2], |hull| hull.centroid()),
        };
        vec![raw[0], cx, cy, listed.area().sqrt() / (2.0 * (2.0 * 2f64.ln()).sqrt()), raw[4]]
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
                    if model.data_precision == Precision::Single {
                        // samsrf_fit2dprf's errfun: ModelRfp is double, but ObsRfp is single,
                        // so Ds = ObsRfp - ModelRfp.*Mask is single and sum(Ds(:).^2) sums
                        // singles; fminsearch keeps that value in its double fv.
                        let squares: Vec<f32> = rmap.iter().enumerate().map(|(pixel, observed)| {
                            let modelled = (profile.data[pixel] * p[n - 2] + p[n - 1]) * self.mask[pixel];
                            let difference = (observed - modelled) as f32;
                            difference * difference
                        }).collect();
                        return f64::from(crate::precision::sum_single(&squares));
                    }
                    // sum(Ds(:).^2) in MATLAB's summation order.
                    let squares: Vec<f64> = rmap.iter().enumerate().map(|(pixel, observed)| {
                        let modelled = (profile.data[pixel] * p[n - 2] + p[n - 1]) * self.mask[pixel];
                        let difference = observed - modelled;
                        difference * difference
                    }).collect();
                    crate::matlab_math::sum(&squares)
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
        let r2 = if model.data_precision == Precision::Single {
            // Resid = (Rmap - mean(Rmap(:))).^2 and R2 = 1 - R/sum(Resid(:)), all single.
            let observed: Vec<f32> = rmap.iter().map(|&value| value as f32).collect();
            let mean = crate::precision::sum_single(&observed) / observed.len() as f32;
            let total = crate::precision::sum_single(&observed.iter().map(|value| (value - mean) * (value - mean)).collect::<Vec<_>>());
            f64::from(1.0 - residual as f32 / total)
        } else {
            // Resid = (Rmap - mean(Rmap(:))).^2 and R2 = 1 - R/sum(Resid(:)), in MATLAB's orders.
            let mean = crate::precision::mean_double(&rmap);
            let total = crate::matlab_math::sum(&rmap.iter().map(|value| (value - mean) * (value - mean)).collect::<Vec<_>>());
            1.0 - residual / total
        };
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

/// MATLAB R2023b `linspace(-half, half, n)`: `(2 i - (n - 1)) * (half / (n - 1))`,
/// which keeps the grid symmetric. The 100-point grid MATLAB saved for the
/// SamSrfAnalysis matrix (`reg_aps_bars.mat`) equals it at every point; the
/// general `a + i * (b - a) / (n - 1)` differs at 59. The ends are set to
/// `-half` and `half`; no recording yet covers an `n` and `half` for which
/// `(n - 1) * (half / (n - 1))` rounds away from `half`.
/// `xc(:)` and `yc(:)` of `meshgrid(linspace(-a, a, cols), linspace(-a, a, rows))`
/// with `yc` flipped, as `samsrf_revcor_prf` builds them. Every grid MATLAB saved
/// is `symmetric_linspace`. The convex-hull analysis keeps the previous
/// `listed_linspace` under `HullOrder::Listed`: with MATLAB's grid its `Fwhm`
/// loses a recorded value the previous grid matched, because `convexHull`'s area
/// is not identified (`packages/samsrf/validation/matlab/README.md`, "Hull area,
/// centroid and vertex order").
fn pixel_grid(model: &RevCorPrfModel, rows: usize, cols: usize, order: HullOrder) -> (Vec<f64>, Vec<f64>) {
    let a = model.scaling_factor;
    let line = |n: usize| if model.prf_function.is_none() && order == HullOrder::Listed { listed_linspace(-a, a, n) } else { symmetric_linspace(a, n) };
    let (xs, ys) = (line(cols), line(rows));
    (0..rows * cols).map(|p| (xs[p / rows], ys[rows - 1 - p % rows])).unzip()
}

/// The port's `linspace` before it followed MATLAB's symmetric one.
fn listed_linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
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

fn symmetric_linspace(half: f64, n: usize) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![half];
    }
    let steps = (n - 1) as f64;
    let mut values: Vec<f64> = (0..n).map(|i| (2.0 * i as f64 - steps) * (half / steps)).collect();
    values[0] = -half;
    values[n - 1] = half;
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `linspace(-a, a, n)` as MATLAB R2023b recorded it (round hull-area-1, AMD
    /// EPYC 7763), on grids where `(n - 1) * (a / (n - 1))` is not `a`: the ends
    /// are `-a` and `a` themselves.
    #[test]
    fn symmetric_grid_ends_are_matlabs() {
        let recorded: [(f64, &[f64]); 3] = [
            (0.1, &[-0.1, -0.08947368421052632, -0.07894736842105263, -0.06842105263157895, -0.05789473684210526, -0.04736842105263158, -0.03684210526315789, -0.02631578947368421, -0.015789473684210527, -0.005263157894736842, 0.005263157894736842, 0.015789473684210527, 0.02631578947368421, 0.03684210526315789, 0.04736842105263158, 0.05789473684210526, 0.06842105263157895, 0.07894736842105263, 0.08947368421052632, 0.1]),
            (12.7, &[-12.7, -11.595652173913042, -10.491304347826086, -9.38695652173913, -8.282608695652172, -7.178260869565216, -6.07391304347826, -4.969565217391303, -3.8652173913043475, -2.7608695652173907, -1.6565217391304345, -0.5521739130434782, 0.5521739130434782, 1.6565217391304345, 2.7608695652173907, 3.8652173913043475, 4.969565217391303, 6.07391304347826, 7.178260869565216, 8.282608695652172, 9.38695652173913, 10.491304347826086, 11.595652173913042, 12.7]),
            (6.7, &[-6.7, -5.6692307692307695, -4.638461538461539, -3.607692307692308, -2.576923076923077, -1.5461538461538464, -0.5153846153846154, 0.5153846153846154, 1.5461538461538464, 2.576923076923077, 3.607692307692308, 4.638461538461539, 5.6692307692307695, 6.7]),
        ];
        for (half, values) in recorded {
            let n = values.len();
            let steps = (n - 1) as f64;
            assert_ne!(steps * (half / steps), half, "{half}, {n}: the ends must matter");
            assert_eq!(symmetric_linspace(half, n).iter().map(|v| v.to_bits()).collect::<Vec<_>>(), values.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "{half}, {n}");
        }
    }
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
        // The QR solve rounds as MATLAB's does, so an exact fit lands within an ULP or two.
        let near = |value: f64, expected: f64| (value - expected).abs() <= 4.0 * f64::EPSILON;
        assert!(near(row[0], 1.0), "{}", row[0]);
        assert_eq!((row[1], row[2]), (2.0, 2.0));
        assert!(near(row[4], 1.0) && near(profile[2], 1.0), "{} {}", row[4], profile[2]);
        // One of four pixels above half maximum: Fwhm = sqrt(0.25 * 16) = 2.
        assert_eq!(row[3], 2.0);
        let hull = prepared.convex_hull(&row, &profile);
        assert_eq!(hull, vec![0.0; 5], "one pixel spans no area, so SamSrf zeroes the column");
    }

    #[test]
    fn a_constant_single_course_has_a_zero_profile_and_no_estimate() {
        // MATLAB's single QR keeps the ones column and zeroes the course's coefficient.
        let mut model = model();
        model.data_precision = Precision::Single;
        let prepared = Prepared::new(&model, &apertures(), &ResolvedHrf::None, 8).unwrap();
        let (row, profile) = prepared.reverse_correlate(&[0.0; 8]);
        assert_eq!(profile, vec![0.0; 4]);
        assert_eq!(row, [0.0; 5]);
        assert_eq!(prepared.convex_hull(&row, &profile), vec![0.0; 5]);
    }

    #[test]
    fn a_negative_peak_keeps_the_sign_of_its_profile() {
        let mut model = model();
        model.allow_negative_peaks = true;
        let prepared = Prepared::new(&model, &apertures(), &ResolvedHrf::None, 8).unwrap();
        let y = [0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let (row, profile) = prepared.reverse_correlate(&y);
        let near = |value: f64, expected: f64| (value - expected).abs() <= 4.0 * f64::EPSILON;
        assert!(near(row[4], -1.0), "{}", row[4]);
        assert_eq!((row[1], row[2]), (2.0, 2.0));
        assert!(near(profile[2], -1.0), "the model fit flips it again and restores the fitted signs: {}", profile[2]);
    }
}
