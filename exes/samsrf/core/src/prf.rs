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
use crate::error::Result;
use crate::expr::Value;

/// Dispatches a function call from a model expression. Profile functions:
/// `prf_gaussian_rf`, `prf_dog_rf`, `prf_multivariate_rf`, `prf_sumnorm_rf`,
/// `prf_skewgauss_rf`, `prf_gaussian_rf_2sigma`. Builtins: `sqrt`, `log`, `exp`,
/// `abs`, `atan2`, `cosd`, `sind`, `cos`, `sin`, `tan`, `mod`, `normcdf`.
/// An unknown name returns `Error::Expression` naming it.
pub fn call(function: &str, args: &[Value]) -> Result<Value> {
    let _ = (function, args);
    Err(crate::Error::NotImplemented("prf::call"))
}

/// `prf_predict_timecourse`: for each volume the mean of `rfp .* ApFrm(:, i)` over all
/// pixels, then `/ mean(abs(rfp)) * 100` (percent pRF overlap). A trailing NaN in `rfp`
/// marks the Dumoulin & Wandell model (`Aperture_Mean_Response`): that pixel is dropped
/// and the percent-overlap scaling skipped.
pub fn predict_timecourse(rfp: &[f64], apertures: &Apertures) -> Vec<f64> {
    let _ = (rfp, apertures);
    Vec::new()
}

/// `corr(x, y)`: Pearson correlation; NaN when either input is constant or contains NaN.
pub fn pearson(x: &[f64], y: &[f64]) -> f64 {
    let _ = (x, y);
    f64::NAN
}

/// `prf_errfun`: `1 - corr(prediction, observed)^2` for parameters `p` (the pRF
/// parameters, then the five HRF parameters when `hrf` is `Fit`), with the HRF
/// bounds check, compressive nonlinearity and downsampling SamSrf applies.
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
    let _ = (prf_function, apertures, xy, hrf, p, observed, downsampling, css_nonlinearity);
    Err(crate::Error::NotImplemented("prf::errfun"))
}
