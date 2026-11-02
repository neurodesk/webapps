//! Time-series preprocessing as `samsrf_gii2srf` does it, plus the global signal and
//! `samsrf_removenoise` that `samsrf_revcor_cf` applies.
//!
//! Per run: MATLAB `detrend` (remove the least-squares line) then `zscore` (n - 1 standard
//! deviation) on every vertex's time course. Runs are then averaged (`nanmean` over runs,
//! with the Spearman-Brown noise ceiling from the odd-run and even-run means) or
//! concatenated in time.
//!
//! `RunAccumulator` streams runs one at a time so a browser never holds more than one run:
//! it keeps only the selected vertices' combined data, plus, when asked for the global
//! signal, the running sum over every vertex (f64, volumes x all vertices) that the
//! `nanmean(Data, 2)` across all vertices needs.

use crate::error::Result;
use crate::timeseries::{RawRun, TimeSeries, VertexSelection};

/// `nrmls` of `samsrf_gii2srf`: positive = detrend and z-score, negative = detrend only,
/// zero = untouched. Skipped entirely when a run has one volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Normalise {
    None,
    Detrend,
    DetrendZscore,
}

/// `avrgd` and `nsceil` of `samsrf_gii2srf`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Combine {
    Average { noise_ceiling: bool },
    Concatenate,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreprocessOptions {
    pub normalise: Normalise,
    pub combine: Combine,
    /// Keep the per-time-point `nanmean` across every vertex of the combined data
    /// (`samsrf_revcor_cf` Global_Signal_Correction).
    pub global_signal: bool,
}

/// The combined, normalised data for the kept vertices.
#[derive(Debug, Clone, PartialEq)]
pub struct Preprocessed {
    pub kept: VertexSelection,
    /// Total vertex count of the hemisphere the runs came from.
    pub total_vertices: usize,
    pub runs: usize,
    pub data: TimeSeries,
    /// `Srf.Noise_Ceiling` for the kept vertices (averaging of two or more runs with `noise_ceiling`).
    pub noise_ceiling: Option<Vec<f64>>,
    /// `nanmean(Srf.Data, 2)`: one value per volume of the combined data.
    pub global_signal: Option<Vec<f64>>,
}

/// Accumulates runs pushed one at a time.
#[derive(Debug)]
pub struct RunAccumulator {
    options: PreprocessOptions,
    kept: VertexSelection,
    total_vertices: usize,
    runs: usize,
}

impl RunAccumulator {
    pub fn new(total_vertices: usize, kept: VertexSelection, options: PreprocessOptions) -> Self {
        Self { options, kept, total_vertices, runs: 0 }
    }

    /// Normalises `run` (every vertex) and folds it in. Every run must have the same
    /// vertex and volume counts (`Error::Shape` otherwise).
    pub fn push_run(&mut self, run: &RawRun) -> Result<()> {
        let _ = run;
        Err(crate::Error::NotImplemented("RunAccumulator::push_run"))
    }

    pub fn finish(self) -> Result<Preprocessed> {
        let _ = (&self.options, &self.kept, self.total_vertices, self.runs);
        Err(crate::Error::NotImplemented("RunAccumulator::finish"))
    }
}

/// MATLAB `detrend(x)`: subtracts the least-squares straight line. In place.
pub fn detrend(x: &mut [f64]) {
    let _ = x;
}

/// MATLAB `zscore(x)`: `(x - mean) / std` with the `n - 1` standard deviation; a constant
/// course becomes NaN (0 / 0), as in MATLAB. In place.
pub fn zscore(x: &mut [f64]) {
    let _ = x;
}

/// `(2 * rho) / (1 + rho)` with `rho = corr(odd, even)`: the Spearman-Brown noise ceiling.
pub fn noise_ceiling(odd_mean: &[f64], even_mean: &[f64]) -> f64 {
    let _ = (odd_mean, even_mean);
    f64::NAN
}

/// `samsrf_removenoise(Srf, X, mver, true)`: z-scores each covariate column, appends an
/// intercept, regresses them out of every kept time course by least squares and keeps
/// the residual; a course containing NaN is set to zero. `covariates` is column-major
/// (`volumes x n`), as the global signal is one column. In place on `data`.
pub fn remove_noise(data: &mut TimeSeries, covariates: &[f64], n_covariates: usize) -> Result<()> {
    let _ = (data, covariates, n_covariates);
    Err(crate::Error::NotImplemented("remove_noise"))
}
