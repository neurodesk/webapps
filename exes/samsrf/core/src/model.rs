//! Model specifications: what `LoadModelJson.m` reads and `samsrf_model_defaults.m`
//! completes. One typed struct per analysis; every optional field carries SamSrf's
//! default after `parse_model_json`.
//!
//! JSON shapes (MATLAB `readstruct`): numbers, arrays of numbers (`Param1`,
//! `Scaled_Param`, `Hrf` vectors), strings (`Name`, `Aperture_File`, function
//! sources) and arrays of strings (`Param_Names`). `Scaled_Param` and `Only_Positive`
//! are written as 0.0/1.0; `Only_Positive` is passed through `sign`, so it may be -1.
//!
//! `readstruct` reads a one-element array as a scalar and a JSON boolean as a logical,
//! so a number is accepted wherever a vector is expected and vice versa, and `true`
//! and `false` count as 1 and 0. Unknown fields are ignored, as MATLAB ignores extra
//! struct fields. JSON has no `Inf`, so `Hrf = Inf` (fit the HRF) is the string
//! `"Inf"`.

use crate::error::{Error, Result};
use crate::expr::AnonymousFunction;
use serde::Serialize;
use serde_json::{Map, Value};

/// `Model.Hrf` as the analyses interpret it (`samsrf_fit_prf.m` "Load or generate HRF").
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FineFit {
    NelderMead { tolerance: Option<f64> },
    HookeJeeves { steps: Vec<f64> },
}

/// `samsrf_fit_prf` model with defaults applied.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CfParameterEstimate {
    /// `Fit_pRF = 1`
    Gaussian,
    /// `Fit_pRF = 0` (default)
    ConvexHull,
    /// `Fit_pRF = -1`
    SummaryStatistics,
}

/// `samsrf_revcor_cf` model with defaults applied.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum Model {
    #[serde(rename = "prf")]
    Prf(PrfModel),
    #[serde(rename = "rc")]
    RevCorPrf(RevCorPrfModel),
    #[serde(rename = "cf")]
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
    let value: Value = serde_json::from_str(json).map_err(|error| Error::Model(format!("invalid JSON: {error}")))?;
    let fields = match value {
        Value::Object(map) => Fields(map),
        _ => return Err(Error::Model("the model file must hold a JSON object".into())),
    };
    match kind {
        AnalysisKind::Prf => fields.prf().map(Model::Prf),
        AnalysisKind::RevCorPrf => fields.revcor_prf().map(Model::RevCorPrf),
        AnalysisKind::RevCorCf => fields.revcor_cf().map(Model::RevCorCf),
    }
}

/// The JSON object with `readstruct`'s loose typing.
struct Fields(Map<String, Value>);

impl Fields {
    fn has(&self, name: &str) -> bool {
        self.0.contains_key(name)
    }

    /// A mandatory field, missing with SamSrf's message.
    fn require<'a>(&'a self, name: &str, message: &str) -> Result<&'a Value> {
        self.0.get(name).ok_or_else(|| Error::Model(message.to_string()))
    }

    fn string(&self, name: &str, message: &str) -> Result<String> {
        as_string(name, self.require(name, message)?)
    }

    fn strings(&self, name: &str, message: &str) -> Result<Vec<String>> {
        match self.require(name, message)? {
            Value::Array(items) => items.iter().map(|item| as_string(name, item)).collect(),
            other => Ok(vec![as_string(name, other)?]),
        }
    }

    fn number(&self, name: &str, message: &str) -> Result<f64> {
        as_number(name, self.require(name, message)?)
    }

    fn vector(&self, name: &str, message: &str) -> Result<Vec<f64>> {
        as_vector(name, self.require(name, message)?)
    }

    fn number_or(&self, name: &str, default: f64) -> Result<f64> {
        match self.0.get(name) {
            Some(value) => as_number(name, value),
            None => Ok(default),
        }
    }

    fn flag_or(&self, name: &str, default: bool) -> Result<bool> {
        Ok(self.number_or(name, f64::from(default))? != 0.0)
    }

    fn string_or(&self, name: &str, default: &str) -> Result<String> {
        match self.0.get(name) {
            Some(value) => as_string(name, value),
            None => Ok(default.to_string()),
        }
    }

    /// A count such as a block size or a side length: a non-negative whole number.
    fn count_or(&self, name: &str, default: usize) -> Result<usize> {
        let value = self.number_or(name, default as f64)?;
        if value < 0.0 || value.fract() != 0.0 {
            return Err(Error::Model(format!("`{name}` must be a whole number, got {value}")));
        }
        Ok(value as usize)
    }

    fn function(&self, name: &str, message: &str) -> Result<AnonymousFunction> {
        AnonymousFunction::parse(&self.string(name, message)?)
    }

    fn hrf(&self) -> Result<HrfSpec> {
        match self.require("Hrf", "HRF is undefined!")? {
            Value::Array(items) if items.is_empty() => Ok(HrfSpec::DeHaas),
            Value::Array(_) => Ok(HrfSpec::Vector(self.vector("Hrf", "HRF is undefined!")?)),
            Value::String(text) => Ok(match text.as_str() {
                "Inf" | "inf" | "Infinity" => HrfSpec::Fit,
                _ if text.len() >= 4 && text[..4].eq_ignore_ascii_case("hrf_") => HrfSpec::OldSchoolFile(text.clone()),
                _ => HrfSpec::VertexWiseFile(text.clone()),
            }),
            other => {
                let value = as_number("Hrf", other)?;
                if value == 0.0 {
                    Ok(HrfSpec::SpmCanonical)
                } else if value == 1.0 {
                    Ok(HrfSpec::None)
                } else {
                    Err(Error::Model(format!("`Hrf` must be 0, 1, [], \"Inf\", a kernel or a file name, got {value}")))
                }
            }
        }
    }

    fn fine_fit(&self) -> Result<FineFit> {
        if self.has("Hooke_Jeeves_Steps") {
            let steps = self.vector("Hooke_Jeeves_Steps", "")?;
            return Ok(FineFit::HookeJeeves { steps });
        }
        let tolerance = match self.0.get("Nelder_Mead_Tolerance") {
            Some(value) => Some(as_number("Nelder_Mead_Tolerance", value)?),
            None => None,
        };
        Ok(FineFit::NelderMead { tolerance })
    }

    fn prf(&self) -> Result<PrfModel> {
        if self.has("SeedRoi") {
            return Err(Error::NotImplemented("pRF-from-CF (SeedRoi in a pRF model)"));
        }
        let name = self.string("Name", "Analysis name is undefined!")?;
        let prf_function = self.function("Prf_Function", "pRF function is undefined!")?;
        let param_names = self.strings("Param_Names", "Parameter names are undefined!")?;
        let scaled_param = self.vector("Scaled_Param", "Scaled parameter flags are undefined!")?;
        let only_positive = self.vector("Only_Positive", "Only positive flags are undefined!")?;
        let scaling_factor = self.number("Scaling_Factor", "Scaling factor (eccentricity?) is undefined!")?;
        let tr = self.number("TR", "TR is undefined!")?;
        let downsample_predictions = self.count_or("Downsample_Predictions", 1)?;
        let hrf = self.hrf()?;
        let aperture_file = self.string("Aperture_File", "Aperture file is undefined!")?;
        let noise_ceiling_threshold = self.number_or("Noise_Ceiling_Threshold", 0.0)?;
        let seed_fine_fit = self.string_or("Seed_Fine_Fit", "")?;
        let polar_search_space = self.flag_or("Polar_Search_Space", false)?;
        let mut params = Vec::with_capacity(10);
        for p in 1..=10 {
            let field = format!("Param{p}");
            if self.has(&field) {
                params.push(self.vector(&field, "")?);
            } else if p <= param_names.len() {
                return Err(Error::Model(format!("Search space parameter #{p} is undefined!")));
            } else {
                params.push(vec![0.0]);
            }
        }
        let coarse_fit_only = self.flag_or("Coarse_Fit_Only", false)?;
        let smoothed_coarse_fit = self.number_or("Smoothed_Coarse_Fit", 0.0)?;
        let fine_fit_threshold = self.number_or("Fine_Fit_Threshold", 0.01)?;
        let coarse_fit_block_size = self.count_or("Coarse_Fit_Block_Size", 10000)?;
        let only_positive_coarse_fits = self.flag_or("Only_Positive_Coarse_Fits", false)?;
        let replace_bad_fits = self.flag_or("Replace_Bad_Fits", false)?;
        let coarse_fit_percentile = self.number_or("Coarse_Fit_Percentile", 100.0)?;
        let aperture_mean_response = self.flag_or("Aperture_Mean_Response", false)?;
        let compressive_nonlinearity = self.flag_or("Compressive_Nonlinearity", false)?;
        if !(0.0..=100.0).contains(&coarse_fit_percentile) {
            return Err(Error::Model("Coarse fit percentile invalid! It should probably be between 99.9-100...".into()));
        }
        if coarse_fit_only && !seed_fine_fit.is_empty() {
            return Err(Error::Model("No point running only coarse fit when seeding the fine fit!".into()));
        }
        let only_positive: Vec<i8> = only_positive.iter().map(|value| sign(*value)).collect();
        if param_names.len() != scaled_param.len() {
            return Err(Error::Model("Mismatch between number of parameter names & scaled-parameter flags!".into()));
        }
        if param_names.len() != only_positive.len() {
            return Err(Error::Model("Mismatch between number of parameter names & only-positive flags!".into()));
        }
        let fine_fit = self.fine_fit()?;
        if let FineFit::HookeJeeves { steps } = &fine_fit {
            if param_names.len() != steps.len() {
                return Err(Error::Model("Mismatch between number of parameter names & Hooke-Jeeves step sizes!".into()));
            }
        }
        Ok(PrfModel {
            name,
            prf_function,
            param_names,
            scaled_param: scaled_param.iter().map(|value| *value != 0.0).collect(),
            only_positive,
            scaling_factor,
            tr,
            hrf,
            aperture_file,
            downsample_predictions,
            noise_ceiling_threshold,
            seed_fine_fit,
            polar_search_space,
            params,
            coarse_fit_only,
            smoothed_coarse_fit,
            fine_fit_threshold,
            coarse_fit_block_size,
            only_positive_coarse_fits,
            replace_bad_fits,
            coarse_fit_percentile,
            aperture_mean_response,
            compressive_nonlinearity,
            fine_fit,
        })
    }

    fn revcor_prf(&self) -> Result<RevCorPrfModel> {
        let name = self.string("Name", "Analysis name is undefined!")?;
        let scaling_factor = self.number("Scaling_Factor", "Scaling factor (eccentricity?) is undefined!")?;
        let tr = self.number("TR", "TR is undefined!")?;
        let hrf = self.hrf()?;
        let aperture_file = self.string("Aperture_File", "Aperture file is undefined!")?;
        let noise_ceiling_threshold = self.number_or("Noise_Ceiling_Threshold", 0.0)?;
        let allow_negative_peaks = self.flag_or("Allow_Negative_Peaks", false)?;
        let prf_function = match self.0.get("Prf_Function") {
            None => None,
            Some(Value::String(source)) => Some(AnonymousFunction::parse(source)?),
            Some(other) if as_number("Prf_Function", other)? == 0.0 => None,
            Some(_) => return Err(Error::Model("`Prf_Function` must be a function string or 0".into())),
        };
        let mut param_names = Vec::new();
        let mut scaled_param = Vec::new();
        let mut seedpar_function = None;
        let mut r2_threshold = 0.0;
        let mut convex_hull_threshold = 0.0;
        if prf_function.is_some() {
            param_names = self.strings("Param_Names", "Parameter names are undefined!")?;
            let scaled = self.vector("Scaled_Param", "Scaled parameter flags are undefined!")?;
            seedpar_function = Some(self.function("SeedPar_Function", "Seed parameter function is undefined!")?);
            if param_names.len() != scaled.len() {
                return Err(Error::Model("Mismatch between number of parameter names & scaled-parameter flags!".into()));
            }
            scaled_param = scaled.iter().map(|value| *value != 0.0).collect();
            r2_threshold = self.number_or("R2_Threshold", 0.0)?;
        } else {
            convex_hull_threshold = self.number_or("Convex_Hull_Threshold", 0.5)?;
        }
        let rdim = self.count_or("Rdim", 100)?;
        let save_rmaps = self.flag_or("Save_Rmaps", false)?;
        let micro_probing = self.number_or("Micro_Probing", 0.0)?;
        let fine_fit = self.fine_fit()?;
        if let FineFit::HookeJeeves { steps } = &fine_fit {
            if prf_function.is_some() && param_names.len() != steps.len() {
                return Err(Error::Model("Mismatch between number of parameter names & Hooke-Jeeves step sizes!".into()));
            }
        }
        Ok(RevCorPrfModel {
            name,
            scaling_factor,
            tr,
            hrf,
            aperture_file,
            noise_ceiling_threshold,
            allow_negative_peaks,
            prf_function,
            param_names,
            scaled_param,
            seedpar_function,
            r2_threshold,
            convex_hull_threshold,
            rdim,
            save_rmaps,
            micro_probing,
            fine_fit,
        })
    }

    fn revcor_cf(&self) -> Result<CfModel> {
        let name = self.string("Name", "Analysis name is undefined!")?;
        let seed_roi = self.string("SeedRoi", "Seed region is undefined!")?;
        let template = self.string("Template", "Template map is undefined!")?;
        let smoothing = self.number_or("Smoothing", 0.0)?;
        let noise_ceiling_threshold = self.number_or("Noise_Ceiling_Threshold", 0.0)?;
        let global_signal_correction = self.flag_or("Global_Signal_Correction", true)?;
        let save_rmaps = self.flag_or("Save_Rmaps", false)?;
        let fit_prf_flag = self.number_or("Fit_pRF", 0.0)?;
        let fit_prf = if fit_prf_flag == 1.0 {
            CfParameterEstimate::Gaussian
        } else if fit_prf_flag == 0.0 {
            CfParameterEstimate::ConvexHull
        } else if fit_prf_flag == -1.0 {
            CfParameterEstimate::SummaryStatistics
        } else {
            return Err(Error::Model(format!("`Fit_pRF` must be 1, 0 or -1, got {fit_prf_flag}")));
        };
        let fine_fit = self.fine_fit()?;
        Ok(CfModel {
            name,
            seed_roi,
            template,
            smoothing,
            noise_ceiling_threshold,
            global_signal_correction,
            save_rmaps,
            fit_prf,
            fine_fit,
        })
    }
}

/// MATLAB `sign`.
fn sign(value: f64) -> i8 {
    if value > 0.0 {
        1
    } else if value < 0.0 {
        -1
    } else {
        0
    }
}

fn as_string(name: &str, value: &Value) -> Result<String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        other => Err(Error::Model(format!("`{name}` must be a string, got {other}"))),
    }
}

fn as_number(name: &str, value: &Value) -> Result<f64> {
    match value {
        Value::Number(number) => number.as_f64().ok_or_else(|| Error::Model(format!("`{name}` is out of range: {number}"))),
        Value::Bool(flag) => Ok(f64::from(*flag)),
        Value::Array(items) if items.len() == 1 => as_number(name, &items[0]),
        other => Err(Error::Model(format!("`{name}` must be a number, got {other}"))),
    }
}

fn as_vector(name: &str, value: &Value) -> Result<Vec<f64>> {
    match value {
        Value::Array(items) => items.iter().map(|item| as_number(name, item)).collect(),
        other => Ok(vec![as_number(name, other)?]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GAUSSIAN: &str = include_str!("../tests/data/Example_2D_Gaussian_pRF.json");
    const REVCOR_PRF: &str = include_str!("../tests/data/Example_Reverse_Correlation_pRF.json");
    const REVCOR_CF: &str = include_str!("../tests/data/Example_Reverse_Correlation_CF.json");

    fn prf(json: &str) -> Result<PrfModel> {
        match parse_model_json(AnalysisKind::Prf, json)? {
            Model::Prf(model) => Ok(model),
            other => panic!("unexpected {other:?}"),
        }
    }

    fn revcor_prf(json: &str) -> Result<RevCorPrfModel> {
        match parse_model_json(AnalysisKind::RevCorPrf, json)? {
            Model::RevCorPrf(model) => Ok(model),
            other => panic!("unexpected {other:?}"),
        }
    }

    fn revcor_cf(json: &str) -> Result<CfModel> {
        match parse_model_json(AnalysisKind::RevCorCf, json)? {
            Model::RevCorCf(model) => Ok(model),
            other => panic!("unexpected {other:?}"),
        }
    }

    fn grid(from: f64, to: f64, step: f64) -> Vec<f64> {
        let count = ((to - from) / step).round() as usize + 1;
        (0..count).map(|i| from + i as f64 * step).collect()
    }

    /// The minimal prf model, so a test can add or remove one field.
    fn minimal_prf() -> serde_json::Map<String, Value> {
        let text = r#"{
            "Name": "min", "Prf_Function": "@(P,ApWidth) prf_gaussian_rf(P(1), 0, P(2), ApWidth)",
            "Param_Names": ["x0", "Sigma"], "Scaled_Param": [1, 1], "Only_Positive": [0, 1],
            "Scaling_Factor": 10, "TR": 2, "Hrf": 0, "Aperture_File": "aps_Bars",
            "Param1": [-1, 0, 1], "Param2": [0.5, 1]
        }"#;
        match serde_json::from_str(text).unwrap() {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    fn with(mut map: serde_json::Map<String, Value>, field: &str, value: Value) -> String {
        map.insert(field.to_string(), value);
        Value::Object(map).to_string()
    }

    fn without(mut map: serde_json::Map<String, Value>, field: &str) -> String {
        map.remove(field);
        Value::Object(map).to_string()
    }

    fn model_error(json: &str, kind: AnalysisKind) -> String {
        match parse_model_json(kind, json).unwrap_err() {
            Error::Model(message) => message,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn example_gaussian_prf_parses_with_defaults() {
        let model = prf(GAUSSIAN).unwrap();
        let mut params = vec![grid(0.0, 350.0, 10.0), grid(0.5, 15.0, 0.5), grid(0.5, 12.0, 0.5)];
        params.extend(std::iter::repeat_n(vec![0.0], 7));
        let expected = PrfModel {
            name: "pRF_Gaussian".into(),
            prf_function: AnonymousFunction::parse("@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)").unwrap(),
            param_names: vec!["x0".into(), "y0".into(), "Sigma".into()],
            scaled_param: vec![true, true, true],
            only_positive: vec![0, 0, 1],
            scaling_factor: 9.5,
            tr: 1.0,
            hrf: HrfSpec::SpmCanonical,
            aperture_file: "aps_Bars".into(),
            downsample_predictions: 1,
            noise_ceiling_threshold: 0.0,
            seed_fine_fit: String::new(),
            polar_search_space: true,
            params,
            coarse_fit_only: false,
            smoothed_coarse_fit: 0.0,
            fine_fit_threshold: 0.01,
            coarse_fit_block_size: 10000,
            only_positive_coarse_fits: false,
            replace_bad_fits: false,
            coarse_fit_percentile: 100.0,
            aperture_mean_response: false,
            compressive_nonlinearity: false,
            fine_fit: FineFit::NelderMead { tolerance: None },
        };
        assert_eq!(model, expected);
    }

    #[test]
    fn example_reverse_correlation_prf_parses_with_defaults() {
        let model = revcor_prf(REVCOR_PRF).unwrap();
        let expected = RevCorPrfModel {
            name: "pRF".into(),
            scaling_factor: 9.5,
            tr: 1.0,
            hrf: HrfSpec::SpmCanonical,
            aperture_file: "aps_Bars".into(),
            noise_ceiling_threshold: 0.0,
            allow_negative_peaks: false,
            prf_function: None,
            param_names: Vec::new(),
            scaled_param: Vec::new(),
            seedpar_function: None,
            r2_threshold: 0.0,
            convex_hull_threshold: 0.5,
            rdim: 100,
            save_rmaps: false,
            micro_probing: 0.0,
            fine_fit: FineFit::NelderMead { tolerance: None },
        };
        assert_eq!(model, expected);
    }

    #[test]
    fn example_reverse_correlation_cf_parses_with_defaults() {
        let model = revcor_cf(REVCOR_CF).unwrap();
        let expected = CfModel {
            name: "CF_Rcp".into(),
            seed_roi: "../benson/ROIs_Benson/V1".into(),
            template: "../benson/bi_benson".into(),
            smoothing: 0.0,
            noise_ceiling_threshold: 0.0,
            global_signal_correction: true,
            save_rmaps: false,
            fit_prf: CfParameterEstimate::ConvexHull,
            fine_fit: FineFit::NelderMead { tolerance: None },
        };
        assert_eq!(model, expected);
    }

    #[test]
    fn prf_mandatory_fields_use_samsrf_messages() {
        let cases = [
            ("Name", "Analysis name is undefined!"),
            ("Prf_Function", "pRF function is undefined!"),
            ("Param_Names", "Parameter names are undefined!"),
            ("Scaled_Param", "Scaled parameter flags are undefined!"),
            ("Only_Positive", "Only positive flags are undefined!"),
            ("Scaling_Factor", "Scaling factor (eccentricity?) is undefined!"),
            ("TR", "TR is undefined!"),
            ("Hrf", "HRF is undefined!"),
            ("Aperture_File", "Aperture file is undefined!"),
            ("Param2", "Search space parameter #2 is undefined!"),
        ];
        for (field, message) in cases {
            assert_eq!(model_error(&without(minimal_prf(), field), AnalysisKind::Prf), message, "{field}");
        }
    }

    #[test]
    fn prf_soundness_checks_use_samsrf_messages() {
        let json = with(minimal_prf(), "Scaled_Param", serde_json::json!([1]));
        assert_eq!(model_error(&json, AnalysisKind::Prf), "Mismatch between number of parameter names & scaled-parameter flags!");
        let json = with(minimal_prf(), "Only_Positive", serde_json::json!([0, 1, 1]));
        assert_eq!(model_error(&json, AnalysisKind::Prf), "Mismatch between number of parameter names & only-positive flags!");
        let json = with(minimal_prf(), "Hooke_Jeeves_Steps", serde_json::json!([0.1]));
        assert_eq!(model_error(&json, AnalysisKind::Prf), "Mismatch between number of parameter names & Hooke-Jeeves step sizes!");
        let json = with(minimal_prf(), "Coarse_Fit_Percentile", serde_json::json!(100.5));
        assert_eq!(model_error(&json, AnalysisKind::Prf), "Coarse fit percentile invalid! It should probably be between 99.9-100...");
        let json = with(minimal_prf(), "Coarse_Fit_Percentile", serde_json::json!(-1));
        assert_eq!(model_error(&json, AnalysisKind::Prf), "Coarse fit percentile invalid! It should probably be between 99.9-100...");
        let seeded = with(minimal_prf(), "Seed_Fine_Fit", serde_json::json!("pRF_seed"));
        let json = with(serde_json::from_str(&seeded).unwrap(), "Coarse_Fit_Only", serde_json::json!(1));
        assert_eq!(model_error(&json, AnalysisKind::Prf), "No point running only coarse fit when seeding the fine fit!");
    }

    #[test]
    fn prf_optional_fields_are_read() {
        let mut map = minimal_prf();
        for (field, value) in [
            ("Downsample_Predictions", serde_json::json!(2)),
            ("Noise_Ceiling_Threshold", serde_json::json!(0.2)),
            ("Seed_Fine_Fit", serde_json::json!("pRF_seed")),
            ("Coarse_Fit_Only", serde_json::json!(false)),
            ("Smoothed_Coarse_Fit", serde_json::json!(3)),
            ("Fine_Fit_Threshold", serde_json::json!(0.05)),
            ("Coarse_Fit_Block_Size", serde_json::json!(500)),
            ("Only_Positive_Coarse_Fits", serde_json::json!(true)),
            ("Replace_Bad_Fits", serde_json::json!(1)),
            ("Coarse_Fit_Percentile", serde_json::json!(99.9)),
            ("Aperture_Mean_Response", serde_json::json!(1.0)),
            ("Compressive_Nonlinearity", serde_json::json!(1)),
            ("Hooke_Jeeves_Steps", serde_json::json!([0.01, 0.02])),
            ("Only_Positive", serde_json::json!([-3, 7])),
            ("Param_Names", serde_json::json!(["x0", "Sigma"])),
        ] {
            map.insert(field.into(), value);
        }
        let model = prf(&Value::Object(map).to_string()).unwrap();
        assert_eq!(model.downsample_predictions, 2);
        assert_eq!(model.noise_ceiling_threshold, 0.2);
        assert_eq!(model.seed_fine_fit, "pRF_seed");
        assert!(!model.coarse_fit_only);
        assert_eq!(model.smoothed_coarse_fit, 3.0);
        assert_eq!(model.fine_fit_threshold, 0.05);
        assert_eq!(model.coarse_fit_block_size, 500);
        assert!(model.only_positive_coarse_fits);
        assert!(model.replace_bad_fits);
        assert_eq!(model.coarse_fit_percentile, 99.9);
        assert!(model.aperture_mean_response);
        assert!(model.compressive_nonlinearity);
        assert_eq!(model.fine_fit, FineFit::HookeJeeves { steps: vec![0.01, 0.02] });
        assert_eq!(model.only_positive, vec![-1, 1]);
    }

    #[test]
    fn nelder_mead_tolerance_is_kept() {
        let json = with(minimal_prf(), "Nelder_Mead_Tolerance", serde_json::json!(0.01));
        assert_eq!(prf(&json).unwrap().fine_fit, FineFit::NelderMead { tolerance: Some(0.01) });
    }

    #[test]
    fn scalars_and_one_element_arrays_are_interchangeable() {
        let mut map = minimal_prf();
        map.insert("Param_Names".into(), serde_json::json!("x0"));
        map.insert("Scaled_Param".into(), serde_json::json!(1));
        map.insert("Only_Positive".into(), serde_json::json!([0]));
        map.insert("TR".into(), serde_json::json!([1.5]));
        map.insert("Param1".into(), serde_json::json!(0));
        map.remove("Param2");
        let model = prf(&Value::Object(map).to_string()).unwrap();
        assert_eq!(model.param_names, vec!["x0"]);
        assert_eq!(model.scaled_param, vec![true]);
        assert_eq!(model.only_positive, vec![0]);
        assert_eq!(model.tr, 1.5);
        assert_eq!(model.params[0], vec![0.0]);
        assert_eq!(model.params[1], vec![0.0]);
    }

    #[test]
    fn wrong_types_are_named() {
        let json = with(minimal_prf(), "TR", serde_json::json!("two"));
        assert_eq!(model_error(&json, AnalysisKind::Prf), "`TR` must be a number, got \"two\"");
        let json = with(minimal_prf(), "Name", serde_json::json!(3));
        assert_eq!(model_error(&json, AnalysisKind::Prf), "`Name` must be a string, got 3");
        let json = with(minimal_prf(), "Coarse_Fit_Block_Size", serde_json::json!(2.5));
        assert_eq!(model_error(&json, AnalysisKind::Prf), "`Coarse_Fit_Block_Size` must be a whole number, got 2.5");
        assert_eq!(model_error("[1]", AnalysisKind::Prf), "the model file must hold a JSON object");
        assert!(model_error("{", AnalysisKind::Prf).starts_with("invalid JSON"));
        let json = with(minimal_prf(), "Prf_Function", serde_json::json!("@(P) P(1"));
        assert!(matches!(parse_model_json(AnalysisKind::Prf, &json), Err(Error::Expression(_))));
    }

    #[test]
    fn hrf_forms() {
        let cases = [
            (serde_json::json!(0), HrfSpec::SpmCanonical),
            (serde_json::json!(0.0), HrfSpec::SpmCanonical),
            (serde_json::json!(1), HrfSpec::None),
            (serde_json::json!([]), HrfSpec::DeHaas),
            (serde_json::json!([0.0, 0.5, 1.0, 0.2]), HrfSpec::Vector(vec![0.0, 0.5, 1.0, 0.2])),
            (serde_json::json!("Inf"), HrfSpec::Fit),
            (serde_json::json!("inf"), HrfSpec::Fit),
            (serde_json::json!("Infinity"), HrfSpec::Fit),
            (serde_json::json!("hrf_sub01"), HrfSpec::OldSchoolFile("hrf_sub01".into())),
            (serde_json::json!("HRF_sub01"), HrfSpec::OldSchoolFile("HRF_sub01".into())),
            (serde_json::json!("lh_hrf_fits"), HrfSpec::VertexWiseFile("lh_hrf_fits".into())),
            (serde_json::json!("hrf"), HrfSpec::VertexWiseFile("hrf".into())),
        ];
        for (value, expected) in cases {
            let json = with(minimal_prf(), "Hrf", value.clone());
            assert_eq!(prf(&json).unwrap().hrf, expected, "{value}");
        }
        let json = with(minimal_prf(), "Hrf", serde_json::json!(2));
        assert_eq!(model_error(&json, AnalysisKind::Prf), "`Hrf` must be 0, 1, [], \"Inf\", a kernel or a file name, got 2");
    }

    #[test]
    fn revcor_prf_mandatory_fields_and_fitted_model() {
        let base: serde_json::Map<String, Value> = match serde_json::from_str(REVCOR_PRF).unwrap() {
            Value::Object(map) => map,
            _ => unreachable!(),
        };
        for (field, message) in [
            ("Name", "Analysis name is undefined!"),
            ("Scaling_Factor", "Scaling factor (eccentricity?) is undefined!"),
            ("TR", "TR is undefined!"),
            ("Hrf", "HRF is undefined!"),
            ("Aperture_File", "Aperture file is undefined!"),
        ] {
            assert_eq!(model_error(&without(base.clone(), field), AnalysisKind::RevCorPrf), message, "{field}");
        }
        assert_eq!(revcor_prf(&with(base.clone(), "Prf_Function", serde_json::json!(0))).unwrap().prf_function, None);
        assert_eq!(
            model_error(&with(base.clone(), "Prf_Function", serde_json::json!(2)), AnalysisKind::RevCorPrf),
            "`Prf_Function` must be a function string or 0"
        );
        let mut fitted = base.clone();
        fitted.insert("Prf_Function".into(), serde_json::json!("@(P,ApWidth) prf_gaussian_rf(P(1), P(2), P(3), ApWidth)"));
        assert_eq!(model_error(&Value::Object(fitted.clone()).to_string(), AnalysisKind::RevCorPrf), "Parameter names are undefined!");
        fitted.insert("Param_Names".into(), serde_json::json!(["x0", "y0", "Sigma"]));
        assert_eq!(model_error(&Value::Object(fitted.clone()).to_string(), AnalysisKind::RevCorPrf), "Scaled parameter flags are undefined!");
        fitted.insert("Scaled_Param".into(), serde_json::json!([1, 1, 1]));
        assert_eq!(model_error(&Value::Object(fitted.clone()).to_string(), AnalysisKind::RevCorPrf), "Seed parameter function is undefined!");
        fitted.insert("SeedPar_Function".into(), serde_json::json!("@(V) [V(2:3); V(4)/(2*sqrt(2*log(2)))]"));
        fitted.insert("Scaled_Param".into(), serde_json::json!([1, 1]));
        assert_eq!(
            model_error(&Value::Object(fitted.clone()).to_string(), AnalysisKind::RevCorPrf),
            "Mismatch between number of parameter names & scaled-parameter flags!"
        );
        fitted.insert("Scaled_Param".into(), serde_json::json!([1, 1, 1]));
        fitted.insert("Hooke_Jeeves_Steps".into(), serde_json::json!([0.01, 0.01]));
        assert_eq!(
            model_error(&Value::Object(fitted.clone()).to_string(), AnalysisKind::RevCorPrf),
            "Mismatch between number of parameter names & Hooke-Jeeves step sizes!"
        );
        fitted.insert("Hooke_Jeeves_Steps".into(), serde_json::json!([0.01, 0.01, 0.01]));
        fitted.insert("Convex_Hull_Threshold".into(), serde_json::json!(0.3));
        fitted.insert("R2_Threshold".into(), serde_json::json!(0.1));
        fitted.insert("Allow_Negative_Peaks".into(), serde_json::json!(1));
        fitted.insert("Noise_Ceiling_Threshold".into(), serde_json::json!(0.4));
        fitted.insert("Rdim".into(), serde_json::json!(50));
        fitted.insert("Save_Rmaps".into(), serde_json::json!(true));
        fitted.insert("Micro_Probing".into(), serde_json::json!(0.2));
        let model = revcor_prf(&Value::Object(fitted).to_string()).unwrap();
        assert_eq!(model.param_names, vec!["x0", "y0", "Sigma"]);
        assert_eq!(model.scaled_param, vec![true, true, true]);
        assert_eq!(model.seedpar_function.as_ref().unwrap().params, vec!["V"]);
        assert_eq!(model.r2_threshold, 0.1);
        assert_eq!(model.convex_hull_threshold, 0.0, "the convex-hull default applies only without a pRF function");
        assert!(model.allow_negative_peaks);
        assert_eq!(model.noise_ceiling_threshold, 0.4);
        assert_eq!(model.rdim, 50);
        assert!(model.save_rmaps);
        assert_eq!(model.micro_probing, 0.2);
        assert_eq!(model.fine_fit, FineFit::HookeJeeves { steps: vec![0.01, 0.01, 0.01] });
    }

    #[test]
    fn revcor_cf_mandatory_fields_and_options() {
        let base: serde_json::Map<String, Value> = match serde_json::from_str(REVCOR_CF).unwrap() {
            Value::Object(map) => map,
            _ => unreachable!(),
        };
        for (field, message) in [
            ("Name", "Analysis name is undefined!"),
            ("SeedRoi", "Seed region is undefined!"),
            ("Template", "Template map is undefined!"),
        ] {
            assert_eq!(model_error(&without(base.clone(), field), AnalysisKind::RevCorCf), message, "{field}");
        }
        for (value, expected) in [
            (1, CfParameterEstimate::Gaussian),
            (0, CfParameterEstimate::ConvexHull),
            (-1, CfParameterEstimate::SummaryStatistics),
        ] {
            let json = with(base.clone(), "Fit_pRF", serde_json::json!(value));
            assert_eq!(revcor_cf(&json).unwrap().fit_prf, expected);
        }
        assert_eq!(model_error(&with(base.clone(), "Fit_pRF", serde_json::json!(2)), AnalysisKind::RevCorCf), "`Fit_pRF` must be 1, 0 or -1, got 2");
        let mut options = base;
        options.insert("Smoothing".into(), serde_json::json!(5));
        options.insert("Noise_Ceiling_Threshold".into(), serde_json::json!(0.3));
        options.insert("Global_Signal_Correction".into(), serde_json::json!(0));
        options.insert("Save_Rmaps".into(), serde_json::json!(1));
        options.insert("Nelder_Mead_Tolerance".into(), serde_json::json!(0.001));
        let model = revcor_cf(&Value::Object(options).to_string()).unwrap();
        assert_eq!(model.smoothing, 5.0);
        assert_eq!(model.noise_ceiling_threshold, 0.3);
        assert!(!model.global_signal_correction);
        assert!(model.save_rmaps);
        assert_eq!(model.fine_fit, FineFit::NelderMead { tolerance: Some(0.001) });
    }

    #[test]
    fn analysis_kind_tokens() {
        assert_eq!(AnalysisKind::parse("PRF"), Some(AnalysisKind::Prf));
        assert_eq!(AnalysisKind::parse("rc"), Some(AnalysisKind::RevCorPrf));
        assert_eq!(AnalysisKind::parse("cf"), Some(AnalysisKind::RevCorCf));
        assert_eq!(AnalysisKind::parse("fit"), None);
    }

    #[test]
    fn a_forward_model_with_a_seed_region_is_refused() {
        let json = r#"{"Name":"pRF","SeedRoi":"V1","Template":"benson"}"#;
        assert_eq!(parse_model_json(AnalysisKind::Prf, json).unwrap_err(), Error::NotImplemented("pRF-from-CF (SeedRoi in a pRF model)"));
    }
}
