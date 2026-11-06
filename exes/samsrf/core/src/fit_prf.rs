//! `samsrf_fit_prf`: the forward-model pRF fit. The search space is generated and
//! convolved once (`Prepared`), then each vertex runs the coarse fit (the best
//! correlating grid prediction, or the mean of the top percentile), the fine fit
//! (`fminsearch` or `samsrf_hookejeeves` on `prf_errfun`), SamSrf's bad-fit filter and
//! the GLM betas. `merge` appends the noise ceiling and `samsrf_normr2`.
//!
//! Not supported (the job refuses them): `Smoothed_Coarse_Fit`, vertex-wise HRF files
//! and the pRF-from-CF analysis (`SeedRoi` in a pRF model).

use crate::apertures::Apertures;
use crate::error::{Error, Result};
use crate::expr::Value;
use crate::hrf::{self, ErrfunHrf, ResolvedHrf};
use crate::model::{FineFit, PrfModel};
use crate::optim::{self, FminsearchOptions};
use crate::prf::{self, predict_timecourse};
use crate::searchspace::{self, SearchSpace};

/// The HRF seeds `samsrf_fit_prf` appends when the HRF is fitted (SPM's canonical).
const HRF_SEEDS: [f64; 5] = [6.0, 16.0, 1.0, 1.0, 6.0];
const HRF_PARAMS: [&str; 5] = ["RLat", "ULat", "RDisp", "UDisp", "AmpRat"];

/// Everything the per-vertex fit needs, computed once per job.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub model: PrfModel,
    pub apertures: Apertures,
    /// Scaled `ApXY` as the pRF functions take it, with the NaN row of `Aperture_Mean_Response`.
    pub xy_value: Value,
    pub xy_points: Vec<[f64; 2]>,
    /// The kernel the coarse fit convolves with (`[1]` for `Hrf = 1`).
    pub coarse_hrf: Vec<f64>,
    pub fitting_hrf: bool,
    /// The search space, or `None` when the fine fit is seeded.
    pub search: Option<SearchSpace>,
    /// Convolved predictions, centred and scaled to unit norm, one per grid point
    /// (`None` for a constant prediction, whose correlation is NaN).
    pub normalised: Vec<Option<Vec<f64>>>,
    pub volumes: usize,
    /// Fine-fit parameter names, scaled flags, only-positive flags and Hooke-Jeeves steps,
    /// extended for the CSS exponent and the HRF parameters.
    pub fine_names: Vec<String>,
    pub fine_scaled: Vec<bool>,
    pub fine_only_positive: Vec<i8>,
    pub hooke_jeeves_steps: Option<Vec<f64>>,
    /// `Srf.Values` of the output rows this fit writes per vertex.
    pub values: Vec<String>,
    pub out_suffix: String,
}

impl Prepared {
    pub fn new(model: &PrfModel, apertures: Apertures, hrf: &ResolvedHrf, volumes: usize, seeded: bool, progress: &mut dyn FnMut(usize, usize)) -> Result<Prepared> {
        let model = model.clone();
        if model.smoothed_coarse_fit > 0.0 {
            return Err(Error::NotImplemented("Smoothed_Coarse_Fit"));
        }
        if volumes * model.downsample_predictions != apertures.volumes() {
            return Err(Error::Shape("Mismatch between length of apertures and data!".into()));
        }
        let fitting_hrf = matches!(hrf, ResolvedHrf::Fit);
        let coarse_hrf = match hrf {
            ResolvedHrf::Kernel(kernel) => kernel.clone(),
            ResolvedHrf::None => vec![1.0],
            ResolvedHrf::Fit => hrf::spm_canonical(model.tr),
        };
        let mut xy_points = apertures.scaled_xy(model.scaling_factor);
        if model.aperture_mean_response {
            xy_points.push([f64::NAN, f64::NAN]);
        }
        let xy_value = xy_value(&xy_points);
        let parameters = model.param_names.len();
        let (search, normalised) = if seeded {
            (None, Vec::new())
        } else {
            let mut space = searchspace::generate(&model.prf_function, &apertures, &xy_value, &model.params, model.polar_search_space, parameters, |done, total| {
                progress(done, total)
            })?;
            let mut convolved = Vec::with_capacity(space.grid_points * volumes);
            for p in 0..space.grid_points {
                let prediction = hrf::convolve(space.prediction(p), &coarse_hrf, model.downsample_predictions);
                convolved.extend(prediction);
            }
            space.predictions = convolved;
            space.volumes = volumes;
            let normalised = (0..space.grid_points).map(|p| normalise(space.prediction(p))).collect();
            (Some(space), normalised)
        };
        let mut fine_names = model.param_names.clone();
        let mut fine_scaled = model.scaled_param.clone();
        let mut fine_only_positive = model.only_positive.clone();
        let mut out_suffix = String::new();
        if !model.coarse_fit_only {
            if model.compressive_nonlinearity {
                fine_names.push("Exponent".into());
                fine_scaled.push(false);
                fine_only_positive.push(1);
                out_suffix.push_str("_Css");
            }
            if fitting_hrf {
                for name in HRF_PARAMS {
                    fine_names.push(name.into());
                    fine_scaled.push(false);
                    fine_only_positive.push(1);
                }
            }
        } else {
            out_suffix.push_str("_CrsFit");
        }
        let hooke_jeeves_steps = match &model.fine_fit {
            FineFit::HookeJeeves { steps } if !model.coarse_fit_only => {
                let scaled: Vec<f64> = steps.iter().zip(&model.scaled_param).map(|(step, scaled)| if *scaled { step * model.scaling_factor } else { *step }).collect();
                if scaled.len() != fine_names.len() {
                    return Err(Error::Model("Mismatch between number of seed parameters & step sizes!".into()));
                }
                Some(scaled)
            }
            _ => None,
        };
        let mut values = vec!["R^2".to_string()];
        values.extend(fine_names.iter().cloned());
        values.push("Beta".into());
        values.push("Baseline".into());
        Ok(Prepared {
            model,
            apertures,
            xy_value,
            xy_points,
            coarse_hrf,
            fitting_hrf,
            search,
            normalised,
            volumes,
            fine_names,
            fine_scaled,
            fine_only_positive,
            hooke_jeeves_steps,
            values,
            out_suffix,
        })
    }

    /// The number of output rows per vertex.
    pub fn rows(&self) -> usize {
        self.values.len()
    }

    /// The coarse fit of one time course: `(Pimg, Rimg, best convolved prediction)`.
    /// `Pimg` is NaN and the prediction `None` when no grid point correlates (a NaN course).
    pub fn coarse_fit(&self, y: &[f64]) -> Result<(Vec<f64>, f64, Option<Vec<f64>>)> {
        let model = &self.model;
        let search = self.search.as_ref().expect("the coarse fit needs a search space");
        let parameters = model.param_names.len();
        let yn = normalise(y);
        let mut r: Vec<f64> = self
            .normalised
            .iter()
            .map(|xn| match (&yn, xn) {
                (Some(yn), Some(xn)) => dot(yn, xn),
                _ => f64::NAN,
            })
            .collect();
        let max_r2;
        if model.only_positive_coarse_fits {
            let best = nan_max(&r);
            max_r2 = best * best;
            for value in &mut r {
                *value *= *value;
            }
        } else {
            for value in &mut r {
                *value *= *value;
            }
            max_r2 = nan_max(&r);
        }
        let threshold = prctile(&r, model.coarse_fit_percentile);
        let selected: Vec<usize> = r.iter().enumerate().filter(|(_, value)| **value >= threshold).map(|(p, _)| p).collect();
        if selected.is_empty() {
            return Ok((vec![f64::NAN; parameters], 0.0, None));
        }
        let mut params = vec![0.0; parameters];
        for &p in &selected {
            for (sum, value) in params.iter_mut().zip(search.point(p)) {
                *sum += value;
            }
        }
        for value in &mut params {
            *value /= selected.len() as f64;
        }
        if model.coarse_fit_percentile == 100.0 {
            return Ok((params, max_r2, Some(search.prediction(selected[0]).to_vec())));
        }
        let prediction = self.predict(&params)?;
        let prediction = hrf::convolve(&prediction, &self.coarse_hrf, model.downsample_predictions);
        let correlation = prf::pearson(y, &prediction);
        Ok((params, correlation * correlation, Some(prediction)))
    }

    /// The unconvolved predicted time course of a parameter set.
    fn predict(&self, params: &[f64]) -> Result<Vec<f64>> {
        let profile = self.model.prf_function.evaluate(&[Value::column(params.to_vec()), self.xy_value.clone()])?;
        if profile.cols != 1 {
            return Err(Error::NotImplemented("multi-condition predictions"));
        }
        Ok(predict_timecourse(&profile.data, &self.apertures))
    }

    /// Fits one vertex from its coarse fit (or seed) `pimg` and `rimg`; returns the output
    /// rows `[R^2, parameters..., Beta, Baseline]`.
    pub fn fit_vertex(&self, y: &[f64], pimg: &[f64], rimg: f64, coarse_prediction: Option<&[f64]>) -> Result<Vec<f64>> {
        let model = &self.model;
        if model.coarse_fit_only {
            let (beta, baseline) = match coarse_prediction {
                Some(prediction) => fit_betas(prediction, y),
                None => (0.0, 0.0),
            };
            let mut row = vec![rimg];
            row.extend_from_slice(pimg);
            row.push(beta);
            row.push(baseline);
            return Ok(row);
        }
        let mut seeds = pimg.to_vec();
        if model.compressive_nonlinearity && seeds.len() < self.fine_names.len() {
            seeds.push(1.0);
        }
        if self.fitting_hrf && seeds.len() < self.fine_names.len() {
            seeds.extend_from_slice(&HRF_SEEDS);
        }
        if seeds.len() != self.fine_names.len() {
            return Err(Error::Shape(format!("{} seed parameters for {} fitted parameters", seeds.len(), self.fine_names.len())));
        }
        let errfun_hrf = if self.fitting_hrf { ErrfunHrf::Fit { tr: model.tr } } else { ErrfunHrf::Kernel(self.coarse_hrf.clone()) };
        let (mut fp, mut fr) = if rimg >= model.fine_fit_threshold {
            let mut failure: Option<Error> = None;
            let mut errfun = |p: &[f64]| match prf::errfun(&model.prf_function, &self.apertures, &self.xy_points, &errfun_hrf, p, y, model.downsample_predictions, model.compressive_nonlinearity) {
                Ok(value) => value,
                Err(error) => {
                    failure.get_or_insert(error);
                    f64::NAN
                }
            };
            let (fp, err) = match &self.hooke_jeeves_steps {
                Some(steps) => {
                    let only_positive: Vec<bool> = self.fine_only_positive.iter().map(|flag| *flag != 0).collect();
                    optim::hooke_jeeves(&mut errfun, &seeds, steps, &only_positive, 15, 3)
                }
                None => {
                    let tolerance = match &model.fine_fit {
                        FineFit::NelderMead { tolerance: Some(tolerance) } => *tolerance,
                        _ => 1e-4,
                    };
                    let options = FminsearchOptions { tol_x: tolerance, stop_when_not_finite: true, ..Default::default() };
                    let result = optim::fminsearch(&mut errfun, &seeds, &options);
                    (result.x, result.fval)
                }
            };
            if let Some(error) = failure {
                return Err(error);
            }
            (fp, 1.0 - err)
        } else {
            (vec![0.0; self.fine_names.len()], 0.0)
        };
        // samsrf_fit_prf's filter, parameter by parameter in order (a -1 flag sets the
        // flag back to true, as the MATLAB loop does).
        let mut good = fr > 0.0;
        if good {
            for ((value, scaled), only_positive) in fp.iter_mut().zip(&self.fine_scaled).zip(&self.fine_only_positive) {
                if *scaled && value.abs() > 2.0 * model.scaling_factor {
                    good = false;
                }
                if *only_positive != 0 && *value <= 0.0 {
                    if *only_positive == 1 {
                        good = false;
                    } else {
                        *value = value.abs();
                        good = true;
                    }
                }
            }
        }
        let mut prediction = None;
        if good {
            let mut fx = self.predict(&fp)?;
            if model.compressive_nonlinearity {
                let exponent = fp[model.param_names.len()];
                prf::compress(&mut fx, exponent);
            }
            prediction = Some(fx);
        } else if model.replace_bad_fits {
            prediction = Some(self.predict(&seeds)?);
            fp = seeds.clone();
            fr = rimg;
        } else {
            fr = 0.0;
            fp = vec![0.0; fp.len()];
        }
        let (beta, baseline) = match prediction {
            Some(fx) => {
                let kernel = if self.fitting_hrf { hrf::doublegamma(model.tr, &fp[fp.len() - 5..]) } else { self.coarse_hrf.clone() };
                let fx = hrf::convolve(&fx, &kernel, model.downsample_predictions);
                fit_betas(&fx, y)
            }
            None => (0.0, 0.0),
        };
        let mut row = vec![fr];
        row.extend(fp);
        row.push(beta);
        row.push(baseline);
        Ok(row)
    }
}

/// `n x 2` points as the column-major `Value` the pRF functions take.
pub fn xy_value(points: &[[f64; 2]]) -> Value {
    let mut data = Vec::with_capacity(points.len() * 2);
    data.extend(points.iter().map(|p| p[0]));
    data.extend(points.iter().map(|p| p[1]));
    Value { rows: points.len(), cols: 2, data }
}

/// Centres a course and scales it to unit norm, so a dot product is `corr`; `None` for a
/// constant course or one with a NaN (MATLAB `corr` gives NaN there).
pub fn normalise(x: &[f64]) -> Option<Vec<f64>> {
    if x.len() < 2 || x.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let mean = x.iter().sum::<f64>() / x.len() as f64;
    let centred: Vec<f64> = x.iter().map(|value| value - mean).collect();
    let norm = centred.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm == 0.0 {
        return None;
    }
    Some(centred.into_iter().map(|value| value / norm).collect())
}

pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    let (chunks_a, rest_a) = a.as_chunks::<4>();
    let (chunks_b, rest_b) = b.as_chunks::<4>();
    let mut sums = [0.0; 4];
    for (x, y) in chunks_a.iter().zip(chunks_b) {
        for i in 0..4 {
            sums[i] += x[i] * y[i];
        }
    }
    let mut total = (sums[0] + sums[1]) + (sums[2] + sums[3]);
    for (x, y) in rest_a.iter().zip(rest_b) {
        total += x * y;
    }
    total
}

/// MATLAB `max` of a vector: ignores NaN; NaN only when every value is NaN.
pub fn nan_max(values: &[f64]) -> f64 {
    values.iter().copied().filter(|value| !value.is_nan()).fold(f64::NAN, |best, value| if best.is_nan() || value > best { value } else { best })
}

/// MATLAB `prctile(x, p)` on a vector: NaNs dropped, the sorted values placed at
/// `100 * (0.5:n - 0.5) / n` and linearly interpolated, clamped at both ends.
pub fn prctile(values: &[f64], p: f64) -> f64 {
    let mut sorted: Vec<f64> = values.iter().copied().filter(|value| !value.is_nan()).collect();
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = sorted.len();
    let positions = |i: usize| 100.0 * (i as f64 + 0.5) / n as f64;
    if p <= positions(0) {
        return sorted[0];
    }
    if p >= positions(n - 1) {
        return sorted[n - 1];
    }
    let mut i = 0;
    while positions(i + 1) < p {
        i += 1;
    }
    let (lo, hi) = (positions(i), positions(i + 1));
    sorted[i] + (p - lo) / (hi - lo) * (sorted[i + 1] - sorted[i])
}

/// `[ones(n,1) x] \ y` as `(amplitude, intercept)`: the least-squares amplitude and
/// intercept. MATLAB solves it by QR with column pivoting: the column with the larger
/// norm comes first, and when the second diagonal of R is within `max(n, 2) * eps` of the
/// first the system is rank deficient, so only the first column gets a coefficient. A
/// prediction that is constant, or constant to rounding, takes that path.
pub fn fit_betas(x: &[f64], y: &[f64]) -> (f64, f64) {
    let n = x.len() as f64;
    if x.is_empty() || x.len() != y.len() {
        return (f64::NAN, f64::NAN);
    }
    let sx: f64 = x.iter().sum();
    let sy: f64 = y.iter().sum();
    let sxx_raw: f64 = x.iter().map(|value| value * value).sum();
    let sxy_raw: f64 = x.iter().zip(y).map(|(a, b)| a * b).sum();
    let mean_x = sx / n;
    let mean_y = sy / n;
    let mut sxx = 0.0;
    let mut sxy = 0.0;
    for (a, b) in x.iter().zip(y) {
        sxx += (a - mean_x) * (a - mean_x);
        sxy += (a - mean_x) * (b - mean_y);
    }
    let tolerance = n.max(2.0) * f64::EPSILON;
    let ones_first = n >= sxx_raw;
    let (r11, r22) = if ones_first {
        (n.sqrt(), sxx.max(0.0).sqrt())
    } else {
        (sxx_raw.sqrt(), (n * (sxx / sxx_raw)).sqrt())
    };
    if r22 <= tolerance * r11 {
        return if ones_first { (0.0, mean_y) } else { (sxy_raw / sxx_raw, 0.0) };
    }
    let amplitude = sxy / sxx;
    (amplitude, mean_y - amplitude * mean_x)
}

/// `samsrf_normr2` after the noise ceiling row has been appended: `R^2` becomes `nR^2`
/// (`R^2 / Noise Ceiling`, 0 where the ceiling is `<= 0`) and the raw `R^2` moves to a
/// new last row. `known` says which vertices have a computed ceiling; the others get 0.
pub fn normr2(maps: &mut crate::mapset::Maps, known: &[bool]) {
    let vertices = maps.vertices;
    let ceiling_row = maps.values.iter().position(|value| value.eq_ignore_ascii_case("Noise Ceiling")).expect("a noise ceiling row");
    let mut r2 = maps.row(0).to_vec();
    let ceiling = maps.row(ceiling_row).to_vec();
    for v in 0..vertices {
        if ceiling[v] <= 0.0 {
            r2[v] = 0.0;
        }
    }
    let normalised: Vec<f64> = (0..vertices).map(|v| if known[v] { r2[v] / ceiling[v] } else { 0.0 }).collect();
    maps.values[0] = "nR^2".into();
    maps.values.push("R^2".into());
    maps.data.extend(r2);
    maps.row_mut(0).copy_from_slice(&normalised);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parity_glm_preserves_small_full_rank_variation() {
        let x: Vec<f64> = (0..64).map(|i| 100.0 * (1.0 + 1e-9 * ((i % 4) as f64 - 1.5))).collect();
        let y: Vec<f64> = x.iter().map(|v| 2.0 * v - 197.0).collect();
        let (amplitude, baseline) = fit_betas(&x, &y);
        assert!((amplitude - 2.0).abs() < 1e-6, "amplitude {amplitude}");
        assert!((baseline + 197.0).abs() < 1e-4, "baseline {baseline}");
    }

    #[test]
    fn prctile_matches_matlab() {
        let x = [5.0, 1.0, 3.0, 2.0, 4.0];
        assert_eq!(prctile(&x, 100.0), 5.0);
        assert_eq!(prctile(&x, 0.0), 1.0);
        assert_eq!(prctile(&x, 50.0), 3.0);
        assert!((prctile(&x, 25.0) - 1.75).abs() < 1e-15);
        assert!((prctile(&x, 99.0) - 5.0).abs() < 1e-15);
        assert!((prctile(&x, 85.0) - 4.75).abs() < 1e-15);
        assert!(prctile(&[f64::NAN], 50.0).is_nan());
        assert_eq!(prctile(&[f64::NAN, 2.0], 100.0), 2.0);
    }

    #[test]
    fn betas_are_the_least_squares_amplitude_and_intercept() {
        let x = [1.0, 2.0, 3.0, 4.0];
        let y: Vec<f64> = x.iter().map(|v| 2.0 * v + 1.0).collect();
        let (amplitude, intercept) = fit_betas(&x, &y);
        assert!((amplitude - 2.0).abs() < 1e-14 && (intercept - 1.0).abs() < 1e-14);
        assert_eq!(fit_betas(&[0.0; 4], &y), (0.0, 6.0));
        assert_eq!(fit_betas(&[2.0; 4], &y), (3.0, 0.0));
        assert_eq!(fit_betas(&[0.5; 4], &y), (0.0, 6.0));
        // Constant to rounding is rank deficient too, not an amplitude of 1e20.
        assert_eq!(fit_betas(&[1e-20, -2e-20, 3e-20, 0.0], &y), (0.0, 6.0));
    }

    #[test]
    fn nan_max_ignores_nan() {
        assert_eq!(nan_max(&[f64::NAN, 1.0, 3.0, 2.0]), 3.0);
        assert!(nan_max(&[f64::NAN, f64::NAN]).is_nan());
        assert!(nan_max(&[]).is_nan());
    }

    #[test]
    fn normr2_divides_by_the_ceiling() {
        let mut maps = crate::mapset::Maps { values: vec!["R^2".into(), "x0".into(), "Noise Ceiling".into()], vertices: 3, data: vec![0.5, 0.2, 0.3, 1.0, 2.0, 3.0, 0.5, -0.1, 0.6] };
        normr2(&mut maps, &[true, true, false]);
        assert_eq!(maps.values, vec!["nR^2", "x0", "Noise Ceiling", "R^2"]);
        assert_eq!(maps.row(0), &[1.0, 0.0, 0.0]);
        assert_eq!(maps.row(3), &[0.5, 0.0, 0.3]);
    }
}
