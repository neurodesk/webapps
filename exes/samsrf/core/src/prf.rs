//! pRF profile functions (`SamSrf/pRF/prf_*_rf.m`), the function registry the
//! expression language calls into, the predicted time course and the fitting
//! error function.
//!
//! Each profile function has two branches, as in SamSrf: `screen_width` a scalar
//! (a `screen_width x screen_width` pixel grid, origin at the centre, eccentricity
//! `screen_width / 4` per unit; `samsrf_fit2dprf` and plotting use it) or an
//! `n x 2` matrix of pixel coordinates in stimulus space (`Apertures::scaled_xy`),
//! which the analyses use. Both are reached through `Value`.

use crate::apertures::Apertures;
use crate::error::{Error, Result};
use crate::expr::Value;

/// The points a profile is evaluated at, with the parameter transform the grid branch applies.
struct Domain {
    rows: usize,
    cols: usize,
    x: Vec<f64>,
    y: Vec<f64>,
    /// `(eccentricity, centre)` on the grid branch: positions scale by eccentricity and shift
    /// by the centre, sizes scale by eccentricity.
    grid: Option<(f64, f64)>,
}

impl Domain {
    /// The last argument of a profile function: a scalar screen width or an `n x 2` matrix.
    fn parse(value: &Value) -> Result<Self> {
        if value.is_scalar() {
            let width = value.data[0];
            let side = if width >= 1.0 { width.floor() as usize } else { 0 };
            let mut x = Vec::with_capacity(side * side);
            let mut y = Vec::with_capacity(side * side);
            // meshgrid(1:w, fliplr(1:w)): X is the column number, Y counts down from w.
            for column in 0..side {
                for row in 0..side {
                    x.push((column + 1) as f64);
                    y.push((side - row) as f64);
                }
            }
            return Ok(Domain { rows: side, cols: side, x, y, grid: Some((width / 4.0, width / 2.0)) });
        }
        if value.cols != 2 {
            return Err(Error::Expression(format!(
                "a pRF function takes a screen width or an n x 2 coordinate matrix, got {} x {}",
                value.rows, value.cols
            )));
        }
        let n = value.rows;
        Ok(Domain { rows: n, cols: 1, x: value.data[..n].to_vec(), y: value.data[n..].to_vec(), grid: None })
    }

    fn position(&self, value: f64) -> f64 {
        match self.grid {
            Some((eccentricity, centre)) => value * eccentricity + centre,
            None => value,
        }
    }

    fn size(&self, value: f64) -> f64 {
        match self.grid {
            Some((eccentricity, _)) => value * eccentricity,
            None => value,
        }
    }

    fn evaluate(&self, f: impl Fn(f64, f64) -> f64) -> Value {
        let data = self.x.iter().zip(&self.y).map(|(x, y)| f(*x, *y)).collect();
        Value { rows: self.rows, cols: self.cols, data }
    }
}

fn scalars<const N: usize>(function: &str, args: &[Value]) -> Result<[f64; N]> {
    if args.len() != N {
        return Err(Error::Expression(format!("`{function}` takes {N} argument(s), {} given", args.len())));
    }
    let mut out = [0.0; N];
    for (slot, arg) in out.iter_mut().zip(args) {
        *slot = arg.as_scalar()?;
    }
    Ok(out)
}

/// Splits a profile call into its scalar parameters and the domain argument. SamSrf
/// defaults a missing domain to a 200 pixel grid.
fn profile_args<const N: usize>(function: &str, args: &[Value]) -> Result<([f64; N], Domain)> {
    let default = Value::scalar(200.0);
    let (parameters, domain) = match args.len() {
        n if n == N => (args, &default),
        n if n == N + 1 => (&args[..N], &args[N]),
        n => return Err(Error::Expression(format!("`{function}` takes {N} or {} arguments, {n} given", N + 1))),
    };
    Ok((scalars::<N>(function, parameters)?, Domain::parse(domain)?))
}

fn gaussian_rf(args: &[Value]) -> Result<Value> {
    let ([x0, y0, sigma], domain) = profile_args::<3>("prf_gaussian_rf", args)?;
    let x0 = domain.position(x0);
    let y0 = domain.position(y0);
    let sigma = domain.size(sigma);
    Ok(domain.evaluate(|x, y| gaussian(x - x0, y - y0, sigma)))
}

fn gaussian(dx: f64, dy: f64, sigma: f64) -> f64 {
    (-(dx * dx + dy * dy) / (2.0 * sigma * sigma)).exp()
}

fn dog_rf(args: &[Value]) -> Result<Value> {
    let ([x0, y0, sigma1, sigma2, delta], domain) = profile_args::<5>("prf_dog_rf", args)?;
    let x0 = domain.position(x0);
    let y0 = domain.position(y0);
    let sigma1 = domain.size(sigma1);
    let sigma2 = domain.size(sigma2);
    Ok(domain.evaluate(|x, y| gaussian(x - x0, y - y0, sigma1) - delta * gaussian(x - x0, y - y0, sigma2)))
}

fn multivariate_rf(args: &[Value]) -> Result<Value> {
    let ([x0, y0, s1, s2, phi], domain) = profile_args::<5>("prf_multivariate_rf", args)?;
    let x0 = domain.position(x0);
    let y0 = domain.position(y0);
    let s1 = domain.size(s1);
    let s2 = domain.size(s2);
    let phi = matlab_mod(phi, 360.0) / 180.0 * std::f64::consts::PI;
    let phi = 2.0 * std::f64::consts::PI - phi;
    let (sin_phi, cos_phi) = phi.sin_cos();
    let sin_2phi = (2.0 * phi).sin();
    let a = cos_phi.powi(2) / (2.0 * s1 * s1) + sin_phi.powi(2) / (2.0 * s2 * s2);
    let b = -(sin_2phi / (2.0 * s1 * s1)) + sin_2phi / (2.0 * s2 * s2);
    let c = sin_phi.powi(2) / (2.0 * s1 * s1) + cos_phi.powi(2) / (2.0 * s2 * s2);
    Ok(domain.evaluate(|x, y| {
        let dx = x - x0;
        let dy = y - y0;
        (-a * dx * dx - b * dx * dy - c * dy * dy).exp()
    }))
}

fn sumnorm_rf(args: &[Value]) -> Result<Value> {
    let ([x0, y0, sigma, kappa], domain) = profile_args::<4>("prf_sumnorm_rf", args)?;
    let x0 = domain.position(x0);
    let y0 = domain.position(y0);
    let sigma = domain.size(sigma);
    Ok(domain.evaluate(|x, y| {
        let rfp = gaussian(x - x0, y - y0, sigma);
        let rfp = rfp + kappa * rfp.ln() * rfp;
        if rfp.is_nan() {
            0.0
        } else {
            rfp.min(1.0)
        }
    }))
}

fn skewgauss_rf(args: &[Value]) -> Result<Value> {
    let ([x0, y0, sigma, alpha_x, alpha_y], domain) = profile_args::<5>("prf_skewgauss_rf", args)?;
    let x0 = domain.position(x0);
    let y0 = domain.position(y0);
    let sigma = domain.size(sigma);
    Ok(domain.evaluate(|x, y| {
        2.0 * gaussian(x - x0, y - y0, sigma) * normcdf((x - x0) * alpha_x) * normcdf((y - y0) * alpha_y)
    }))
}

fn gaussian_rf_2sigma(args: &[Value]) -> Result<Value> {
    let ([x0, y0, sigma1, sigma2], domain) = profile_args::<4>("prf_gaussian_rf_2sigma", args)?;
    if domain.grid.is_some() {
        return Err(Error::Expression("This function only works with coordinate input!".into()));
    }
    let mut data = Vec::with_capacity(2 * domain.rows);
    for sigma in [sigma1, sigma2] {
        data.extend(domain.x.iter().zip(&domain.y).map(|(x, y)| gaussian(x - x0, y - y0, sigma)));
    }
    Ok(Value { rows: domain.rows, cols: 2, data })
}

/// MATLAB `mod(x, y)`: `x - floor(x / y) * y`, the result taking the divisor's sign; `mod(x, 0)` is `x`.
fn matlab_mod(x: f64, y: f64) -> f64 {
    if y == 0.0 {
        x
    } else {
        x - (x / y).floor() * y
    }
}

/// `normcdf(x)`: the standard normal CDF, `0.5 * erfc(-x / sqrt(2))`.
fn normcdf(x: f64) -> f64 {
    0.5 * libm::erfc(-x / std::f64::consts::SQRT_2)
}

/// MATLAB `cosd`/`sind`: reduce to a quadrant first so multiples of 90 are exact.
fn degrees(x: f64, cosine: bool) -> f64 {
    let n = (x / 90.0).round();
    let m = (x - n * 90.0).to_radians();
    let quadrant = matlab_mod(n, 4.0) as u8;
    match (cosine, quadrant) {
        (true, 0) | (false, 1) => m.cos(),
        (true, 1) | (false, 2) => -m.sin(),
        (true, 2) | (false, 3) => -m.cos(),
        _ => m.sin(),
    }
}

fn unary(function: &str, args: &[Value], f: fn(f64) -> f64) -> Result<Value> {
    match args {
        [value] => Ok(value.map(f)),
        _ => Err(Error::Expression(format!("`{function}` takes 1 argument, {} given", args.len()))),
    }
}

fn binary(function: &str, args: &[Value], f: fn(f64, f64) -> f64) -> Result<Value> {
    match args {
        [left, right] => left.zip_with(right, f),
        _ => Err(Error::Expression(format!("`{function}` takes 2 arguments, {} given", args.len()))),
    }
}

/// MATLAB `max`/`min` of two values ignore a NaN operand.
fn nan_max(a: f64, b: f64) -> f64 {
    if a.is_nan() {
        b
    } else if b.is_nan() {
        a
    } else {
        a.max(b)
    }
}

fn nan_min(a: f64, b: f64) -> f64 {
    if a.is_nan() {
        b
    } else if b.is_nan() {
        a
    } else {
        a.min(b)
    }
}

/// Dispatches a function call from a model expression. Profile functions:
/// `prf_gaussian_rf`, `prf_dog_rf`, `prf_multivariate_rf`, `prf_sumnorm_rf`,
/// `prf_skewgauss_rf`, `prf_gaussian_rf_2sigma`. Builtins: `sqrt`, `log`, `exp`,
/// `abs`, `atan2`, `cosd`, `sind`, `cos`, `sin`, `tan`, `mod`, `normcdf`.
/// An unknown name returns `Error::Expression` naming it.
pub fn call(function: &str, args: &[Value]) -> Result<Value> {
    match function {
        "prf_gaussian_rf" => gaussian_rf(args),
        "prf_dog_rf" => dog_rf(args),
        "prf_multivariate_rf" => multivariate_rf(args),
        "prf_sumnorm_rf" => sumnorm_rf(args),
        "prf_skewgauss_rf" => skewgauss_rf(args),
        "prf_gaussian_rf_2sigma" => gaussian_rf_2sigma(args),
        "sqrt" => unary(function, args, f64::sqrt),
        "log" => unary(function, args, f64::ln),
        "exp" => unary(function, args, f64::exp),
        "abs" => unary(function, args, f64::abs),
        "cos" => unary(function, args, f64::cos),
        "sin" => unary(function, args, f64::sin),
        "tan" => unary(function, args, f64::tan),
        "cosd" => unary(function, args, |x| degrees(x, true)),
        "sind" => unary(function, args, |x| degrees(x, false)),
        "normcdf" => unary(function, args, normcdf),
        "atan2" => binary(function, args, f64::atan2),
        "mod" => binary(function, args, matlab_mod),
        "max" => binary(function, args, nan_max),
        "min" => binary(function, args, nan_min),
        _ => Err(Error::Expression(format!("unknown function `{function}`"))),
    }
}

/// `prf_predict_timecourse`: for each volume the mean of `rfp .* ApFrm(:, i)` over all
/// pixels, then `/ mean(abs(rfp)) * 100` (percent pRF overlap). A trailing NaN in `rfp`
/// marks the Dumoulin & Wandell model (`Aperture_Mean_Response`): that pixel is dropped
/// and the percent-overlap scaling skipped.
///
/// A non-finite profile value makes every volume NaN, as `NaN * 0` does in MATLAB; a
/// profile that is not `pixels` (or `pixels + 1`) long reads missing pixels as NaN.
pub fn predict_timecourse(rfp: &[f64], apertures: &Apertures) -> Vec<f64> {
    let (rfp, percent_overlap) = match rfp.split_last() {
        Some((last, head)) if last.is_nan() => (head, false),
        _ => (rfp, true),
    };
    let pixels = apertures.pixels();
    let finite = rfp.len() == pixels && rfp.iter().all(|value| value.is_finite());
    if !finite || pixels == 0 {
        return vec![f64::NAN; apertures.volumes()];
    }
    let mut y: Vec<f64> = apertures
        .frames
        .iter()
        .map(|frame| {
            let sum: f64 = frame
                .indices
                .iter()
                .zip(&frame.values)
                .map(|(index, value)| rfp.get(*index as usize).copied().unwrap_or(f64::NAN) * value)
                .sum();
            sum / pixels as f64
        })
        .collect();
    if percent_overlap {
        let mean_abs = rfp.iter().map(|value| value.abs()).sum::<f64>() / pixels as f64;
        for value in &mut y {
            *value = *value / mean_abs * 100.0;
        }
    }
    y
}

/// `corr(x, y)`: Pearson correlation; NaN when either input is constant or contains NaN.
pub fn pearson(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len();
    if n != y.len() || n < 2 || x.iter().chain(y).any(|value| !value.is_finite()) {
        return f64::NAN;
    }
    let mean_x = x.iter().sum::<f64>() / n as f64;
    let mean_y = y.iter().sum::<f64>() / n as f64;
    let mut sxy = 0.0;
    let mut sxx = 0.0;
    let mut syy = 0.0;
    for (a, b) in x.iter().zip(y) {
        let dx = a - mean_x;
        let dy = b - mean_y;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    if sxx == 0.0 || syy == 0.0 {
        return f64::NAN;
    }
    sxy / (sxx.sqrt() * syy.sqrt())
}

/// `prf_errfun`'s bounds on the five fitted HRF parameters: response delay 3-9,
/// undershoot delay 10-18, both dispersions 0.5-3, ratio 0-10.
fn hrf_parameters_in_bounds(p: &[f64]) -> bool {
    let bounds = [(3.0, 9.0), (10.0, 18.0), (0.5, 3.0), (0.5, 3.0), (0.0, 10.0)];
    p.iter().zip(bounds).all(|(value, (low, high))| *value >= low && *value <= high)
}

/// `prf_errfun`: `1 - corr(prediction, observed)^2` for parameters `p` (the pRF
/// parameters, then the five HRF parameters when `hrf` is `Fit`), with the HRF
/// bounds check, compressive nonlinearity and downsampling SamSrf applies.
#[allow(clippy::too_many_arguments)]
pub fn errfun(
    prf_function: &crate::expr::AnonymousFunction,
    apertures: &Apertures,
    xy: &[[f64; 2]],
    hrf: &crate::hrf::ErrfunHrf,
    p: &[f64],
    observed: &[f64],
    downsampling: usize,
    css_nonlinearity: bool,
) -> Result<f64> {
    use crate::hrf::ErrfunHrf;
    let n = p.len();
    let hrf_parameters = match hrf {
        ErrfunHrf::Fit { .. } if n < 5 => {
            return Err(Error::Shape(format!("fitting the HRF needs five HRF parameters, got {n} parameters in total")));
        }
        ErrfunHrf::Fit { .. } => 5,
        ErrfunHrf::Kernel(_) => 0,
    };
    if hrf_parameters > 0 && !hrf_parameters_in_bounds(&p[n - 5..]) {
        return Ok(1.0);
    }
    let mut coordinates = Vec::with_capacity(2 * xy.len());
    coordinates.extend(xy.iter().map(|point| point[0]));
    coordinates.extend(xy.iter().map(|point| point[1]));
    let xy_value = Value { rows: xy.len(), cols: 2, data: coordinates };
    let rfp = prf_function.evaluate(&[Value::column(p.to_vec()), xy_value])?;
    if rfp.cols == 2 {
        return Err(Error::NotImplemented("multi-condition predictions"));
    }
    if rfp.cols != 1 {
        return Err(Error::Shape(format!("the pRF function returned a {} x {} profile", rfp.rows, rfp.cols)));
    }
    let mut yp = predict_timecourse(&rfp.data, apertures);
    let kernel = match hrf {
        ErrfunHrf::Fit { tr } => crate::hrf::doublegamma(*tr, &p[n - 5..]),
        ErrfunHrf::Kernel(kernel) => kernel.clone(),
    };
    if css_nonlinearity {
        let exponent = *p.get(n - hrf_parameters - 1).ok_or_else(|| {
            Error::Shape("the compressive nonlinearity needs an exponent parameter before the HRF parameters".into())
        })?;
        for value in &mut yp {
            *value = value.powf(exponent);
        }
    }
    let yp = crate::hrf::convolve(&yp, &kernel, downsampling);
    let r = pearson(&yp, observed);
    Ok(1.0 - r * r)
}

#[cfg(test)]
#[allow(clippy::excessive_precision, clippy::approx_constant)]
mod tests {
    use super::*;
    use crate::apertures::Frame;
    use crate::expr::AnonymousFunction;
    use crate::hrf::ErrfunHrf;

    fn assert_close(actual: &[f64], expected: &[f64]) {
        assert_eq!(actual.len(), expected.len(), "length");
        for (index, (a, e)) in actual.iter().zip(expected).enumerate() {
            if e.is_nan() {
                assert!(a.is_nan(), "[{index}] {a} is not NaN");
                continue;
            }
            let tolerance = 1e-12 * e.abs().max(1e-300);
            assert!((a - e).abs() <= tolerance, "[{index}] {a} != {e}");
        }
    }

    /// The `XY` matrix of the Octave reference script, column-major.
    fn xy() -> Value {
        Value { rows: 5, cols: 2, data: vec![-1.0, 0.0, 1.0, 0.3, 50.0, -1.0, 0.5, -0.25, -0.2, 50.0] }
    }

    fn s(value: f64) -> Value {
        Value::scalar(value)
    }

    fn profile(function: &str, parameters: &[f64], domain: Value) -> Value {
        let mut args: Vec<Value> = parameters.iter().map(|p| s(*p)).collect();
        args.push(domain);
        call(function, &args).unwrap()
    }

    #[test]
    fn gaussian_grid_matches_octave() {
        let expected = [
            3.0118065920308039e-07, 4.3716813666029457e-05, 0.0010724840513832705, 0.0044468666449100427,
            0.0031162930419902186, 0.00036909944763631149, 9.6467557689022072e-06, 0.0014002407244431718,
            0.034351447855624405, 0.14243224174431357, 0.09981423760726521, 0.011822180863822876,
            5.2222349675744776e-05, 0.0075801505183551391, 0.18596027149018149, 0.77105158580356625,
            0.54034062267315541, 0.063998931639866072, 4.778069411359333e-05, 0.0069354377101255452,
            0.1701438350538258, 0.7054715116388689, 0.49438315528506305, 0.058555645145578178,
            7.3887236166848645e-06, 0.0010724840513832714, 0.026310747376478288, 0.10909289024877412,
            0.076450553155666942, 0.0090549433448742101, 1.9311113205542083e-07, 2.8030363567304759e-05,
            0.00068765574065085783, 0.0028512436826796344, 0.0019981059831248563, 0.00023665932720473248,
        ];
        let result = profile("prf_gaussian_rf", &[0.3, -0.2, 0.5], s(6.0));
        assert_eq!((result.rows, result.cols), (6, 6));
        assert_close(&result.data, &expected);
    }

    #[test]
    fn gaussian_coordinates_match_octave() {
        let result = profile("prf_gaussian_rf", &[0.3, -0.2, 0.5], xy());
        assert_eq!((result.rows, result.cols), (5, 1));
        assert_close(&result.data, &[0.0094664624017103231, 0.31348618088260533, 0.37343922693666098, 1.0, 0.0]);
    }

    #[test]
    fn gaussian_defaults_to_a_200_pixel_grid() {
        let result = call("prf_gaussian_rf", &[s(0.0), s(0.0), s(1.0)]).unwrap();
        assert_eq!((result.rows, result.cols), (200, 200));
    }

    #[test]
    fn dog_matches_octave() {
        let grid = [
            -0.041431939095185034, -0.13300564856406452, -0.18794249766352022, -0.16864984857121001,
            -0.072163587257176656, -0.18826017402895009, 0.38870570035344826, -0.078204246468339345,
            -0.06282773968263658, -0.18358700531134703, 0.01369073240215829, -0.16583357674454469,
            -0.027314827852661105, -0.088769314156129153, -0.14176786303850353, -0.11656273100079188,
        ];
        assert_close(&profile("prf_dog_rf", &[0.3, -0.2, 0.5, 1.2, 0.4], s(4.0)).data, &grid);
        let coordinates = [-0.16864984857121004, -0.0135515856523723, 0.036312938710921339, 0.59999999999999998, 0.0];
        assert_close(&profile("prf_dog_rf", &[0.3, -0.2, 0.5, 1.2, 0.4], xy()).data, &coordinates);
    }

    #[test]
    fn multivariate_matches_octave_including_negative_and_wrapped_angles() {
        let grid = [
            1.8806660417632544e-05, 0.0023566409342726381, 0.043038403115556088, 0.11455126219169179,
            0.0036980190369716786, 0.1399256937014888, 0.77162589304959694, 0.62015052311673113,
            0.026588978312549499, 0.30379216424577921, 0.50586249736028932, 0.12276353836144023,
            0.0069905155253717662, 0.024117412668354342, 0.012126437210669838, 0.00088862131853780467,
        ];
        assert_close(&profile("prf_multivariate_rf", &[0.3, -0.2, 0.5, 0.9, -30.0], s(4.0)).data, &grid);
        let coordinates = [0.11455126219169169, 0.41802716606302487, 0.42531039126494669, 1.0, 0.0];
        assert_close(&profile("prf_multivariate_rf", &[0.3, -0.2, 0.5, 0.9, -30.0], xy()).data, &coordinates);
        let wrapped = [0.010138964749921365, 0.65374878033309369, 0.51924875800548609, 1.0, 0.0];
        assert_close(&profile("prf_multivariate_rf", &[0.3, -0.2, 0.5, 0.9, 400.0], xy()).data, &wrapped);
    }

    #[test]
    fn sumnorm_clips_above_one_and_zeroes_nan() {
        let grid = [
            1.6029096464933418e-05, 0.0078934451400927991, 0.085803250310143908, 0.031523319797695404,
            0.00030967853357716598, 0.11862586890657091, 0.87128829195803004, 0.40176875528248279,
            0.00014853354041499599, 0.06172923860251138, 0.53007738980498775, 0.22226653252764939,
            1.685860182843818e-06, 0.00092413835579568471, 0.011205387672930946, 0.0038902647657037413,
        ];
        assert_close(&profile("prf_sumnorm_rf", &[0.3, -0.2, 0.5, -0.5], s(4.0)).data, &grid);
        let coordinates = [-0.021413137952668752, 0.058935402005929838, 0.1159528799638333, 1.0, 0.0];
        assert_close(&profile("prf_sumnorm_rf", &[0.3, -0.2, 0.5, 0.7], xy()).data, &coordinates);
        let far = Value { rows: 1, cols: 2, data: vec![0.3, 0.3] };
        let clipped = profile("prf_sumnorm_rf", &[0.0, 0.0, 0.5, -5.0], far);
        assert_eq!(clipped.data, vec![1.0]);
    }

    #[test]
    fn skewgauss_matches_octave() {
        let grid = [
            5.8963444600550254e-13, 8.0180215619121004e-07, 0.0005542380170204369, 0.00045790891691758969,
            1.8449236602171141e-10, 0.0002508781124969176, 0.17341707865270767, 0.14327639790531677,
            2.1670704790703146e-10, 0.00029468457864157446, 0.20369787640463777, 0.1682942546314381,
            2.0791855209550355e-12, 2.8273372512699775e-06, 0.0019543696403058666, 0.0016146912657853266,
        ];
        assert_close(&profile("prf_skewgauss_rf", &[0.3, -0.2, 0.5, 1.5, -2.0], s(4.0)).data, &grid);
        let coordinates = [0.00045790891691758893, 0.016524080620295669, 0.34397429720023509, 0.5, 0.0];
        assert_close(&profile("prf_skewgauss_rf", &[0.3, -0.2, 0.5, 1.5, -2.0], xy()).data, &coordinates);
    }

    #[test]
    fn two_sigma_gives_two_columns_and_refuses_a_grid() {
        let result = profile("prf_gaussian_rf_2sigma", &[0.3, -0.2, 0.5, 1.2], xy());
        assert_eq!((result.rows, result.cols), (5, 2));
        let expected = [
            0.0094664624017103231, 0.31348618088260533, 0.37343922693666098, 1.0, 0.0,
            0.44529077743230083, 0.81759441633744401, 0.84281572056434906, 1.0, 0.0,
        ];
        assert_close(&result.data, &expected);
        let error = call("prf_gaussian_rf_2sigma", &[s(0.3), s(-0.2), s(0.5), s(1.2), s(4.0)]).unwrap_err();
        assert_eq!(error, Error::Expression("This function only works with coordinate input!".into()));
    }

    #[test]
    fn model_function_strings_match_octave() {
        let mv = AnonymousFunction::parse(
            "@(P,ApWidth) prf_multivariate_rf(P(1), P(2), P(3), P(4), atan2(P(2),P(1))/pi*180 + P(5), ApWidth)",
        )
        .unwrap();
        let result = mv.evaluate(&[Value::column(vec![0.3, -0.2, 0.5, 0.9, 15.0]), xy()]).unwrap();
        assert_close(&result.data, &[0.063739585181894917, 0.4889240518972664, 0.38996240546408278, 1.0, 0.0]);
        let polar = AnonymousFunction::parse("@(P,ApWidth) prf_gaussian_rf(cosd(P(1))/2, sind(P(1))/2, P(2), ApWidth)").unwrap();
        let result = polar.evaluate(&[Value::column(vec![37.0, 0.5]), xy()]).unwrap();
        assert_close(&result.data, &[0.00067493034406210066, 0.67153779722747542, 0.26483812426252556, 0.5936028990880553, 0.0]);
        let literal = AnonymousFunction::parse("@(P,ApWidth) prf_gaussian_rf(0, P(1), P(2), ApWidth)").unwrap();
        let result = literal.evaluate(&[Value::column(vec![-0.2, 0.5]), xy()]).unwrap();
        assert_close(&result.data[3..4], &[(-0.18f64).exp()]);
    }

    #[test]
    fn builtins_follow_matlab() {
        let mod_values = [(-30.0, 360.0, 330.0), (5.0, -3.0, -1.0), (5.0, 0.0, 5.0), (-7.5, 2.0, 0.5)];
        for (x, y, expected) in mod_values {
            assert_eq!(call("mod", &[s(x), s(y)]).unwrap(), s(expected), "mod({x}, {y})");
        }
        assert_eq!(call("cosd", &[s(90.0)]).unwrap(), s(0.0));
        assert_eq!(call("sind", &[s(180.0)]).unwrap(), s(0.0));
        assert_eq!(call("cosd", &[s(180.0)]).unwrap(), s(-1.0));
        assert_eq!(call("sind", &[s(-90.0)]).unwrap(), s(-1.0));
        assert_close(&[call("sind", &[s(30.0)]).unwrap().data[0]], &[0.5]);
        assert_eq!(call("max", &[s(f64::NAN), s(2.0)]).unwrap(), s(2.0));
        assert_eq!(call("min", &[s(1.0), s(f64::NAN)]).unwrap(), s(1.0));
        assert_eq!(call("max", &[s(1.0), s(2.0)]).unwrap(), s(2.0));
        assert_eq!(call("min", &[s(1.0), s(2.0)]).unwrap(), s(1.0));
        assert_close(&[call("normcdf", &[s(0.0)]).unwrap().data[0]], &[0.5]);
        assert_close(&call("atan2", &[Value::column(vec![1.0, -1.0]), s(1.0)]).unwrap().data, &[0.78539816339744828, -0.78539816339744828]);
        assert_eq!(call("sqrt", &[s(4.0), s(5.0)]).unwrap_err(), Error::Expression("`sqrt` takes 1 argument, 2 given".into()));
        assert_eq!(call("nope", &[]).unwrap_err(), Error::Expression("unknown function `nope`".into()));
        let error = call("prf_gaussian_rf", &[s(1.0), s(2.0)]).unwrap_err();
        assert_eq!(error, Error::Expression("`prf_gaussian_rf` takes 3 or 4 arguments, 2 given".into()));
    }

    /// The reference script's six-pixel aperture: a 2 x 3 image whose column-major pixel
    /// coordinates are the six points of `Rfp`.
    fn apertures() -> Apertures {
        let frames = vec![
            Frame { indices: vec![0, 3], values: vec![1.0, 1.0] },
            Frame { indices: vec![1, 3, 4], values: vec![1.0, 1.0, 0.5] },
            Frame { indices: vec![5], values: vec![1.0] },
        ];
        let xy = vec![[-1.0, -1.0], [0.0, 0.5], [1.0, -0.25], [0.3, -0.2], [0.5, 0.5], [-0.5, 0.5]];
        Apertures { width: 3, height: 2, frames, xy, conditions: None }
    }

    fn reference_profile() -> Vec<f64> {
        let apertures = apertures();
        let mut data = Vec::new();
        data.extend(apertures.xy.iter().map(|p| p[0]));
        data.extend(apertures.xy.iter().map(|p| p[1]));
        let xy = Value { rows: 6, cols: 2, data };
        profile("prf_gaussian_rf", &[0.3, -0.2, 0.5], xy).data
    }

    #[test]
    fn predicted_timecourse_matches_octave() {
        let apertures = apertures();
        let rfp = reference_profile();
        assert_close(&predict_timecourse(&rfp, &apertures), &[47.013195088956508, 69.239724123734973, 4.859844165333647]);
        let mut dumoulin_wandell = rfp.clone();
        dumoulin_wandell.push(f64::NAN);
        assert_close(
            &predict_timecourse(&dumoulin_wandell, &apertures),
            &[0.16824441040028504, 0.24778568100793899, 0.017391747459127499],
        );
        let mut with_nan = rfp;
        with_nan[2] = f64::NAN;
        assert_close(&predict_timecourse(&with_nan, &apertures), &[f64::NAN; 3]);
    }

    #[test]
    fn pearson_matches_corr() {
        assert_close(&[pearson(&[1.0, 2.0, 3.0, 4.0], &[2.0, 4.0, 5.0, 9.0])], &[0.96476382123773219]);
        assert!(pearson(&[1.0, 1.0, 1.0], &[1.0, 2.0, 3.0]).is_nan());
        assert!(pearson(&[1.0, f64::NAN, 3.0], &[1.0, 2.0, 3.0]).is_nan());
        assert!(pearson(&[1.0, 2.0], &[1.0, 2.0, 3.0]).is_nan());
        assert_close(&[pearson(&[1.0, 2.0, 3.0], &[3.0, 2.0, 1.0])], &[-1.0]);
    }

    #[test]
    fn errfun_returns_one_for_hrf_parameters_out_of_bounds() {
        let function = AnonymousFunction::parse("@(P,ApWidth) prf_gaussian_rf(P(1), P(2), P(3), ApWidth)").unwrap();
        let apertures = apertures();
        let observed = [1.0, 2.0, 3.0];
        let hrf = ErrfunHrf::Fit { tr: 1.0 };
        let bad = [
            [0.3, -0.2, 0.5, 2.9, 16.0, 1.0, 1.0, 6.0],
            [0.3, -0.2, 0.5, 6.0, 18.1, 1.0, 1.0, 6.0],
            [0.3, -0.2, 0.5, 6.0, 16.0, 0.4, 1.0, 6.0],
            [0.3, -0.2, 0.5, 6.0, 16.0, 1.0, 3.1, 6.0],
            [0.3, -0.2, 0.5, 6.0, 16.0, 1.0, 1.0, -0.1],
            [0.3, -0.2, 0.5, 6.0, 16.0, 1.0, 1.0, 10.1],
        ];
        for p in bad {
            let error = errfun(&function, &apertures, &apertures.xy, &hrf, &p, &observed, 1, false).unwrap();
            assert_eq!(error, 1.0, "{p:?}");
        }
        let error = errfun(&function, &apertures, &apertures.xy, &hrf, &[0.3, -0.2, 0.5], &observed, 1, false).unwrap_err();
        assert!(matches!(error, Error::Shape(_)), "{error}");
    }

    #[test]
    fn errfun_refuses_a_two_column_profile() {
        let function = AnonymousFunction::parse("@(P,ApWidth) prf_gaussian_rf_2sigma(P(1), P(2), P(3), P(4), ApWidth)").unwrap();
        let apertures = apertures();
        let hrf = ErrfunHrf::Kernel(vec![1.0]);
        let error = errfun(&function, &apertures, &apertures.xy, &hrf, &[0.3, -0.2, 0.5, 1.0], &[1.0, 2.0, 3.0], 1, false).unwrap_err();
        assert_eq!(error, Error::NotImplemented("multi-condition predictions"));
    }

    #[test]
    fn errfun_reports_expression_errors() {
        let function = AnonymousFunction::parse("@(P,ApWidth) prf_gaussian_rf(P(1), P(2), P(7), ApWidth)").unwrap();
        let apertures = apertures();
        let hrf = ErrfunHrf::Kernel(vec![1.0]);
        let error = errfun(&function, &apertures, &apertures.xy, &hrf, &[0.3, -0.2, 0.5], &[1.0, 2.0, 3.0], 1, false).unwrap_err();
        assert_eq!(error, Error::Expression("index 7 out of range for `P` with 3 elements".into()));
    }
}
