//! Haemodynamic response functions (`SamSrf/Hrf`) and convolution (`prf_convolve_hrf`).

use crate::error::Result;
use crate::model::HrfSpec;

/// SPM's canonical double-gamma parameters: response delay, undershoot delay, response
/// dispersion, undershoot dispersion, response/undershoot ratio, onset, kernel length.
pub const DOUBLE_GAMMA_DEFAULTS: [f64; 7] = [6.0, 16.0, 1.0, 1.0, 6.0, 0.0, 32.0];

/// `samsrf_doublegamma(TR, P)`: `p` replaces the leading defaults (up to seven values).
/// The kernel has `length(p(6):p(7)/TR)` samples spread by `linspace(p(6), p(7), L)`, so
/// its spacing is `32 / floor(32 / TR)` seconds, not exactly TR; reproduced on purpose.
pub fn doublegamma(tr: f64, p: &[f64]) -> Vec<f64> {
    let _ = (tr, p);
    Vec::new()
}

/// `samsrf_doublegamma(TR, [6 16 1 1 6 0 32])`: SPM's canonical HRF (`Hrf = 0`).
pub fn spm_canonical(tr: f64) -> Vec<f64> {
    doublegamma(tr, &DOUBLE_GAMMA_DEFAULTS)
}

/// `samsrf_hrf(TR)`: the de Haas et al. (2014) HRF, scaled to the canonical's peak (`Hrf = []`).
pub fn de_haas(tr: f64) -> Vec<f64> {
    let _ = tr;
    Vec::new()
}

/// The old-school `hrf_*.mat` form: `samsrf_doublegamma(TR, [fP(1:2) 1 1 fP(3) 0 32]) * fP(4)`.
pub fn old_school(tr: f64, fp: [f64; 4]) -> Vec<f64> {
    let _ = (tr, fp);
    Vec::new()
}

/// `gampdf(x, a, b)` as MATLAB defines it, including `x = 0` for every shape.
pub fn gampdf(x: f64, a: f64, b: f64) -> f64 {
    let _ = (x, a, b);
    f64::NAN
}

/// `prf_convolve_hrf(Y, Hrf, Downsampling)`: full convolution truncated to `y.len()`,
/// then every `downsampling`-th sample from the first when `downsampling > 1`.
pub fn convolve(y: &[f64], hrf: &[f64], downsampling: usize) -> Vec<f64> {
    let _ = (y, hrf, downsampling);
    Vec::new()
}

/// What `prf_errfun` receives as `Hrf`: a kernel, or the negative TR that tells it
/// to build the kernel from the last five parameters.
#[derive(Debug, Clone, PartialEq)]
pub enum ErrfunHrf {
    Kernel(Vec<f64>),
    Fit { tr: f64 },
}

/// An HRF ready for the analyses: resolved from the model spec and the TR. File-backed
/// specs are resolved by the caller (it owns file access) and passed in as `Vector`.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedHrf {
    Kernel(Vec<f64>),
    /// `Hrf = 1`
    None,
    /// `Hrf = Inf`
    Fit,
}

/// Resolves the specs that need no file: canonical, de Haas, none, fit and vectors.
/// `OldSchoolFile` and `VertexWiseFile` return `Error::Model` telling the caller to
/// load the file (`old_school` builds the kernel from its `fP`).
pub fn resolve(spec: &HrfSpec, tr: f64) -> Result<ResolvedHrf> {
    let _ = (spec, tr);
    Err(crate::Error::NotImplemented("hrf::resolve"))
}
