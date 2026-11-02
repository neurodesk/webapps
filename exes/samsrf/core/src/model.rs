//! Model specifications: what `LoadModelJson.m` reads and `samsrf_model_defaults.m`
//! completes. One typed struct per analysis; every optional field carries SamSrf's
//! default after `parse_model_json`.
//!
//! JSON shapes (MATLAB `readstruct`): numbers, arrays of numbers (`Param1`,
//! `Scaled_Param`, `Hrf` vectors), strings (`Name`, `Aperture_File`, function
//! sources) and arrays of strings (`Param_Names`). `Scaled_Param` and `Only_Positive`
//! are written as 0.0/1.0; `Only_Positive` is passed through `sign`, so it may be -1.

use crate::error::Result;
use crate::expr::AnonymousFunction;

/// `Model.Hrf` as the analyses interpret it (`samsrf_fit_prf.m` "Load or generate HRF").
#[derive(Debug, Clone, PartialEq)]
pub enum HrfSpec {
    /// `Hrf = 0`: SPM's canonical double gamma at the model TR.
    SpmCanonical,
    /// `Hrf = 1`: no convolution.
    None,
    /// `Hrf = []`: the de Haas et al. (2014) HRF (`samsrf_hrf`).
    DeHaas,
    /// `Hrf = Inf`: fit the five double-gamma parameters per vertex (fit_prf only).
    Fit,
    /// A user-supplied kernel already sampled at the model TR.
    Vector(Vec<f64>),
    /// `'hrf_*'`: an old-school subject HRF fit file holding `fP` (`samsrf_doublegamma(TR, [fP(1:2) 1 1 fP(3) 0 32])' * fP(4)`).
    OldSchoolFile(String),
    /// Any other string: a SamSrf map file with vertex-wise HRF fits (`samsrf_extract_hrf_fits`).
    VertexWiseFile(String),
}

/// Fine-fit algorithm choice. SamSrf uses Nelder-Mead unless `Hooke_Jeeves_Steps` is set.
#[derive(Debug, Clone, PartialEq)]
pub enum FineFit {
    NelderMead { tolerance: Option<f64> },
    HookeJeeves { steps: Vec<f64> },
}

/// `samsrf_fit_prf` model with defaults applied.
#[derive(Debug, Clone, PartialEq)]
pub struct PrfModel {
    pub name: String,
    pub prf_function: AnonymousFunction,
    pub param_names: Vec<String>,
    pub scaled_param: Vec<bool>,
    /// `sign(Only_Positive)`: -1, 0 or 1 per parameter.
    pub only_positive: Vec<i8>,
    pub scaling_factor: f64,
    pub tr: f64,
    pub hrf: HrfSpec,
    pub aperture_file: String,
    pub downsample_predictions: usize,
    pub noise_ceiling_threshold: f64,
    /// Empty: run the coarse fit; otherwise a map file that seeds the fine fit.
    pub seed_fine_fit: String,
    pub polar_search_space: bool,
    /// `Param1..Param10`: search-space grid per parameter; unused parameters are `[0.0]`.
    pub params: Vec<Vec<f64>>,
    pub coarse_fit_only: bool,
    pub smoothed_coarse_fit: f64,
    pub fine_fit_threshold: f64,
    pub coarse_fit_block_size: usize,
    pub only_positive_coarse_fits: bool,
    pub replace_bad_fits: bool,
    pub coarse_fit_percentile: f64,
    pub aperture_mean_response: bool,
    pub compressive_nonlinearity: bool,
    pub fine_fit: FineFit,
}

/// `samsrf_revcor_prf` model with defaults applied.
#[derive(Debug, Clone, PartialEq)]
pub struct RevCorPrfModel {
    pub name: String,
    pub scaling_factor: f64,
    pub tr: f64,
    pub hrf: HrfSpec,
    pub aperture_file: String,
    pub noise_ceiling_threshold: f64,
    pub allow_negative_peaks: bool,
    /// `Prf_Function = 0` (no 2D fit, convex hull) is `None`.
    pub prf_function: Option<AnonymousFunction>,
    pub param_names: Vec<String>,
    pub scaled_param: Vec<bool>,
    pub seedpar_function: Option<AnonymousFunction>,
    pub r2_threshold: f64,
    pub convex_hull_threshold: f64,
    pub rdim: usize,
    pub save_rmaps: bool,
    pub micro_probing: f64,
    pub fine_fit: FineFit,
}

/// How `samsrf_revcor_cf` turns a correlation profile into CF parameters (`Fit_pRF`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CfParameterEstimate {
    /// `Fit_pRF = 1`
    Gaussian,
    /// `Fit_pRF = 0` (default)
    ConvexHull,
    /// `Fit_pRF = -1`
    SummaryStatistics,
}

/// `samsrf_revcor_cf` model with defaults applied.
#[derive(Debug, Clone, PartialEq)]
pub struct CfModel {
    pub name: String,
    pub seed_roi: String,
    pub template: String,
    pub smoothing: f64,
    pub noise_ceiling_threshold: f64,
    pub global_signal_correction: bool,
    pub save_rmaps: bool,
    pub fit_prf: CfParameterEstimate,
    pub fine_fit: FineFit,
}

/// The analysis a model JSON describes. `SamSrfAnalysis` picks the analysis from its
/// first argument (`prf`, `rc`, `cf`); the same JSON fields mean different things per
/// analysis, so parsing takes the analysis kind.
#[derive(Debug, Clone, PartialEq)]
pub enum Model {
    Prf(PrfModel),
    RevCorPrf(RevCorPrfModel),
    RevCorCf(CfModel),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisKind {
    /// `samsrf_fit_prf`
    Prf,
    /// `samsrf_revcor_prf`
    RevCorPrf,
    /// `samsrf_revcor_cf`
    RevCorCf,
}

impl AnalysisKind {
    /// The SamSrfAnalysis command-line token: `prf`, `rc` or `cf`.
    pub fn parse(token: &str) -> Option<Self> {
        match token.to_ascii_lowercase().as_str() {
            "prf" => Some(AnalysisKind::Prf),
            "rc" => Some(AnalysisKind::RevCorPrf),
            "cf" => Some(AnalysisKind::RevCorCf),
            _ => None,
        }
    }
}

/// Parses a model JSON file for `kind` and applies `samsrf_model_defaults`, including
/// its soundness checks (parameter-name and flag lengths, mandatory fields, the
/// coarse-fit percentile range, `Coarse_Fit_Only` with a seed map).
pub fn parse_model_json(kind: AnalysisKind, json: &str) -> Result<Model> {
    let _ = (kind, json);
    Err(crate::Error::NotImplemented("parse_model_json"))
}
