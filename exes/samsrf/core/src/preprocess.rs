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
//!
//! Memory while averaging: 10 bytes per kept vertex and volume (an f64 sum and a u16
//! count), twice that with the noise ceiling (odd and even runs are summed separately and
//! the overall mean is their combined sum), plus 10 bytes per vertex and volume of the
//! whole hemisphere for the global signal unless every vertex is kept already. For
//! 134 260 vertices x 250 volumes that is 336 MB, 671 MB with the noise ceiling.
//! Concatenating keeps 8 bytes per kept vertex and volume of every run.

use crate::error::{Error, Result};
use crate::precision::Precision;
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
    /// The precision `samsrf_gii2srf` stores (`def_64bit`). Only the global signal
    /// depends on it: single data are averaged across vertices in single.
    pub precision: Precision,
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

/// A running `nanmean(., 3)`: per element, the sum of the non-NaN values and their count.
/// Counts are per element because without normalisation a NaN need not fill a whole course.
#[derive(Debug)]
struct NanSum {
    sum: Vec<f64>,
    count: Vec<u16>,
}

impl NanSum {
    fn new(len: usize) -> Self {
        Self {
            sum: vec![0.0; len],
            count: vec![0; len],
        }
    }

    fn add(&mut self, offset: usize, course: &[f64]) {
        let sums = &mut self.sum[offset..offset + course.len()];
        let counts = &mut self.count[offset..offset + course.len()];
        for ((sum, count), &value) in sums.iter_mut().zip(counts).zip(course) {
            if !value.is_nan() {
                *sum += value;
                *count += 1;
            }
        }
    }

    /// The mean over every part: `sum / count`, NaN where no part had a value.
    fn mean(parts: &[NanSum]) -> Vec<f64> {
        (0..parts[0].sum.len())
            .map(|i| {
                let sum: f64 = parts.iter().map(|part| part.sum[i]).sum();
                let count: u32 = parts.iter().map(|part| u32::from(part.count[i])).sum();
                sum / f64::from(count)
            })
            .collect()
    }
}

/// `nanmean(Data, 2)` built one vertex at a time. Its counts are u32 because a hemisphere
/// has more vertices than `NanSum`'s u16 run counts hold.
#[derive(Debug)]
struct VolumeMean {
    sum: Vec<f64>,
    count: Vec<u32>,
    precision: Precision,
}

impl VolumeMean {
    fn new(volumes: usize, precision: Precision) -> Self {
        Self {
            sum: vec![0.0; volumes],
            count: vec![0; volumes],
            precision,
        }
    }

    /// Adds one vertex's course. Single data sum in single, vertex by vertex, as
    /// MATLAB's `nanmean(Srf.Data, 2)` does.
    fn add(&mut self, course: &[f64]) {
        for ((sum, count), &value) in self.sum.iter_mut().zip(&mut self.count).zip(course) {
            if !value.is_nan() {
                *sum = self.precision.round(*sum + self.precision.round(value));
                *count += 1;
            }
        }
    }

    fn mean(self) -> Vec<f64> {
        let precision = self.precision;
        self.sum
            .iter()
            .zip(&self.count)
            .map(|(sum, count)| precision.round(sum / f64::from(*count)))
            .collect()
    }
}

#[derive(Debug)]
enum Combined {
    /// One part, or the odd and even runs when the noise ceiling is wanted.
    Average(Vec<NanSum>),
    /// The kept courses of each run, vertex-major.
    Concatenate(Vec<Vec<f64>>),
}

#[derive(Debug)]
enum GlobalSignal {
    Off,
    /// Averaging with unselected vertices: every vertex's run mean is needed.
    AllVertices(NanSum),
    /// Averaging with every vertex kept: derived from the combined data at `finish`.
    FromCombined,
    /// Concatenating: each run's `nanmean` across vertices, appended as it arrives.
    PerRun(Vec<f64>),
}

/// Accumulates runs pushed one at a time.
#[derive(Debug)]
pub struct RunAccumulator {
    options: PreprocessOptions,
    kept: VertexSelection,
    total_vertices: usize,
    runs: usize,
    volumes: usize,
    combined: Option<Combined>,
    global: GlobalSignal,
}

impl RunAccumulator {
    pub fn new(total_vertices: usize, kept: VertexSelection, options: PreprocessOptions) -> Self {
        Self {
            options,
            kept,
            total_vertices,
            runs: 0,
            volumes: 0,
            combined: None,
            global: GlobalSignal::Off,
        }
    }

    /// Normalises `run` (every vertex) and folds it in. Every run must have the same
    /// vertex and volume counts (`Error::Shape` otherwise).
    pub fn push_run(&mut self, run: &RawRun) -> Result<()> {
        self.check_shape(run)?;
        if self.runs == 0 {
            self.start(run.volumes)?;
        }
        if self.runs == usize::from(u16::MAX) {
            return Err(Error::Shape(format!(
                "at most {} runs can be combined",
                u16::MAX
            )));
        }
        let volumes = run.volumes;
        let normalise = if volumes > 1 {
            self.options.normalise
        } else {
            Normalise::None
        };
        let course_of = |vertex: usize| {
            let mut course: Vec<f64> = run
                .course(vertex)
                .iter()
                .map(|&value| f64::from(value))
                .collect();
            normalise_course(&mut course, normalise);
            course
        };
        let kept_count = self.kept.len(self.total_vertices);
        let needs_every_vertex = matches!(
            self.global,
            GlobalSignal::AllVertices(_) | GlobalSignal::PerRun(_)
        );
        let half = self.runs % 2;
        let mut concatenated = Vec::new();
        let mut across = VolumeMean::new(volumes, self.options.precision);
        let mut position = 0;
        for vertex in 0..self.total_vertices {
            let is_kept = position < kept_count && self.kept.vertex(position) == vertex;
            if !is_kept && !needs_every_vertex {
                continue;
            }
            let course = course_of(vertex);
            if is_kept {
                match self.combined.as_mut() {
                    Some(Combined::Average(parts)) => {
                        let part = half.min(parts.len() - 1);
                        parts[part].add(position * volumes, &course);
                    }
                    Some(Combined::Concatenate(_)) => concatenated.extend_from_slice(&course),
                    None => unreachable!("start() sets the combination"),
                }
                position += 1;
            }
            match &mut self.global {
                GlobalSignal::AllVertices(sums) => sums.add(vertex * volumes, &course),
                GlobalSignal::PerRun(_) => across.add(&course),
                GlobalSignal::Off | GlobalSignal::FromCombined => {}
            }
        }
        if let Some(Combined::Concatenate(runs)) = self.combined.as_mut() {
            runs.push(concatenated);
        }
        if let GlobalSignal::PerRun(signal) = &mut self.global {
            signal.extend(across.mean());
        }
        self.runs += 1;
        Ok(())
    }

    fn check_shape(&self, run: &RawRun) -> Result<()> {
        if run.vertices != self.total_vertices {
            return Err(Error::Shape(format!(
                "run {} has {} vertices, expected {}",
                self.runs + 1,
                run.vertices,
                self.total_vertices
            )));
        }
        if self.runs > 0 && run.volumes != self.volumes {
            return Err(Error::Shape(format!(
                "run {} has {} volumes, the first run has {}",
                self.runs + 1,
                run.volumes,
                self.volumes
            )));
        }
        if run.data.len() != run.volumes * run.vertices {
            return Err(Error::Shape(format!(
                "run {} holds {} values, not {} volumes x {} vertices",
                self.runs + 1,
                run.data.len(),
                run.volumes,
                run.vertices
            )));
        }
        Ok(())
    }

    fn start(&mut self, volumes: usize) -> Result<()> {
        if let VertexSelection::Indices(indices) = &self.kept {
            if let Some(&last) = indices.last() {
                if last as usize >= self.total_vertices {
                    return Err(Error::Shape(format!(
                        "vertex {last} is outside the {} vertices of the runs",
                        self.total_vertices
                    )));
                }
            }
        }
        self.volumes = volumes;
        let kept_values = self.kept.len(self.total_vertices) * volumes;
        self.combined = Some(match self.options.combine {
            Combine::Average {
                noise_ceiling: false,
            } => Combined::Average(vec![NanSum::new(kept_values)]),
            Combine::Average {
                noise_ceiling: true,
            } => Combined::Average(vec![NanSum::new(kept_values), NanSum::new(kept_values)]),
            Combine::Concatenate => Combined::Concatenate(Vec::new()),
        });
        let every_vertex_kept = self.kept.len(self.total_vertices) == self.total_vertices;
        self.global = match (self.options.global_signal, self.options.combine) {
            (false, _) => GlobalSignal::Off,
            (true, Combine::Concatenate) => GlobalSignal::PerRun(Vec::new()),
            (true, Combine::Average { .. }) if every_vertex_kept => GlobalSignal::FromCombined,
            (true, Combine::Average { .. }) => {
                GlobalSignal::AllVertices(NanSum::new(self.total_vertices * volumes))
            }
        };
        Ok(())
    }

    pub fn finish(self) -> Result<Preprocessed> {
        let Some(combined) = self.combined else {
            return Err(Error::Shape("no runs to combine".into()));
        };
        let volumes = self.volumes;
        let kept_count = self.kept.len(self.total_vertices);
        let (data, noise_ceiling) = match combined {
            Combined::Average(parts) => {
                let mean = NanSum::mean(&parts);
                let ceiling = (parts.len() == 2 && self.runs >= 2).then(|| {
                    let odd = NanSum::mean(&parts[..1]);
                    let even = NanSum::mean(&parts[1..]);
                    (0..kept_count)
                        .map(|position| {
                            let range = position * volumes..(position + 1) * volumes;
                            noise_ceiling(&odd[range.clone()], &even[range])
                        })
                        .collect()
                });
                let data = TimeSeries {
                    volumes,
                    vertices: kept_count,
                    data: mean,
                };
                (data, ceiling)
            }
            Combined::Concatenate(runs) => {
                let total = volumes * runs.len();
                let mut data = TimeSeries::zeros(total, kept_count);
                for (run, values) in runs.iter().enumerate() {
                    for position in 0..kept_count {
                        let target =
                            &mut data.course_mut(position)[run * volumes..(run + 1) * volumes];
                        target
                            .copy_from_slice(&values[position * volumes..(position + 1) * volumes]);
                    }
                }
                (data, None)
            }
        };
        let global_signal = match self.global {
            GlobalSignal::Off => None,
            GlobalSignal::PerRun(signal) => Some(signal),
            GlobalSignal::FromCombined => Some(mean_across_vertices(&data, self.options.precision)),
            GlobalSignal::AllVertices(sums) => {
                let means = NanSum::mean(&[sums]);
                let all = TimeSeries {
                    volumes,
                    vertices: self.total_vertices,
                    data: means,
                };
                Some(mean_across_vertices(&all, self.options.precision))
            }
        };
        Ok(Preprocessed {
            kept: self.kept,
            total_vertices: self.total_vertices,
            runs: self.runs,
            data,
            noise_ceiling,
            global_signal,
        })
    }
}

fn normalise_course(course: &mut [f64], normalise: Normalise) {
    match normalise {
        Normalise::None => {}
        Normalise::Detrend => detrend(course),
        Normalise::DetrendZscore => {
            detrend(course);
            zscore(course);
        }
    }
}

/// `nanmean(Data, 2)`: per volume, the mean of the non-NaN values across vertices.
fn mean_across_vertices(data: &TimeSeries, precision: Precision) -> Vec<f64> {
    let mut across = VolumeMean::new(data.volumes, precision);
    for vertex in 0..data.vertices {
        across.add(data.course(vertex));
    }
    across.mean()
}

fn mean(x: &[f64]) -> f64 {
    x.iter().sum::<f64>() / x.len() as f64
}

/// MATLAB `detrend(x)`: subtracts the least-squares straight line. In place.
///
/// MATLAB solves the fit by QR on `[1 t]`; here the normal equations on the centred time
/// `t - (n + 1) / 2`, which are diagonal: intercept = mean, slope = `sum(tc .* x) / sum(tc.^2)`.
/// Results agree with Octave's QR to rounding (about 1e-15 of the course's scale). A NaN
/// anywhere makes the whole course NaN, as `\` does.
pub fn detrend(x: &mut [f64]) {
    let n = x.len();
    if n == 0 {
        return;
    }
    let intercept = mean(x);
    let centre = (n as f64 + 1.0) / 2.0;
    let mut cross = 0.0;
    let mut squares = 0.0;
    for (i, &value) in x.iter().enumerate() {
        let tc = (i + 1) as f64 - centre;
        cross += tc * value;
        squares += tc * tc;
    }
    let slope = if n > 1 { cross / squares } else { 0.0 };
    for (i, value) in x.iter_mut().enumerate() {
        let tc = (i + 1) as f64 - centre;
        *value -= intercept + slope * tc;
    }
}

/// MATLAB `zscore(x)`: `(x - mean) / std` with the `n - 1` standard deviation. A zero
/// standard deviation is replaced by 1, as MATLAB and Octave do, so a constant course
/// (the medial wall's zeros) becomes all zeros, not NaN. A NaN makes the course NaN. In place.
pub fn zscore(x: &mut [f64]) {
    let n = x.len();
    if n == 0 {
        return;
    }
    let mu = mean(x);
    let squares: f64 = x.iter().map(|value| (value - mu) * (value - mu)).sum();
    let sigma = if n > 1 {
        (squares / (n - 1) as f64).sqrt()
    } else {
        0.0
    };
    let sigma = if sigma == 0.0 { 1.0 } else { sigma };
    for value in x.iter_mut() {
        *value = (*value - mu) / sigma;
    }
}

/// MATLAB `zscore` of a single vector: single mean, `std` and quotient.
fn zscore_single(x: &[f32]) -> Vec<f32> {
    let n = x.len() as f32;
    let mu = crate::precision::sum_single(x) / n;
    let squares: Vec<f32> = x.iter().map(|value| (value - mu) * (value - mu)).collect();
    let sigma = if x.len() > 1 { (crate::precision::sum_single(&squares) / (n - 1.0)).sqrt() } else { 0.0 };
    let sigma = if sigma == 0.0 { 1.0 } else { sigma };
    x.iter().map(|value| (value - mu) / sigma).collect()
}

/// Pearson correlation as MATLAB `corr(x, y)`: NaN when either course is constant or has a NaN.
fn correlation(x: &[f64], y: &[f64]) -> f64 {
    let mx = mean(x);
    let my = mean(y);
    let mut sxy = 0.0;
    let mut sxx = 0.0;
    let mut syy = 0.0;
    for (&a, &b) in x.iter().zip(y) {
        sxy += (a - mx) * (b - my);
        sxx += (a - mx) * (a - mx);
        syy += (b - my) * (b - my);
    }
    sxy / (sxx * syy).sqrt()
}

/// `(2 * rho) / (1 + rho)` with `rho = corr(odd, even)`: the Spearman-Brown noise ceiling.
pub fn noise_ceiling(odd_mean: &[f64], even_mean: &[f64]) -> f64 {
    let rho = correlation(odd_mean, even_mean);
    (2.0 * rho) / (1.0 + rho)
}

/// `samsrf_removenoise(Srf, X, mver, true)`: z-scores each covariate column, appends an
/// intercept, regresses them out of every kept time course by least squares and keeps
/// the residual; a course containing NaN is set to zero. `covariates` is column-major
/// (`volumes x n`), as the global signal is one column. In place on `data`.
///
/// MATLAB's `X \ Y` is QR; here the normal equations `X'X b = X'y`, solved by Gaussian
/// elimination with partial pivoting. With one or two z-scored covariates and an intercept
/// `X'X` is close to diagonal, so the two agree to rounding. A constant covariate z-scores
/// to zeros; it is left out, which is the coefficient 0 MATLAB's basic solution gives it.
/// Collinear covariates (rank deficiency beyond that) are not reproduced.
pub fn remove_noise(data: &mut TimeSeries, covariates: &[f64], n_covariates: usize) -> Result<()> {
    remove_noise_in(data, covariates, n_covariates, Precision::Double)
}

/// `remove_noise` in the data's precision. Single data make `zscore`, `[X ones] \ Y`,
/// `X * B` and the residuals single; one covariate (the global signal) is supported.
pub fn remove_noise_in(data: &mut TimeSeries, covariates: &[f64], n_covariates: usize, precision: Precision) -> Result<()> {
    if precision == Precision::Single {
        if n_covariates != 1 || covariates.len() != data.volumes {
            return Err(Error::Shape("single-precision noise removal takes one covariate per volume".into()));
        }
        if data.vertices == 0 {
            return Ok(());
        }
        let x: Vec<f32> = zscore_single(&covariates.iter().map(|&value| value as f32).collect::<Vec<_>>());
        let design: Vec<num_complex::Complex64> = x.iter().map(|&value| num_complex::Complex64::new(f64::from(value), 0.0)).collect();
        let ones = vec![num_complex::Complex64::new(1.0, 0.0); design.len()];
        // `B = [X ones] \ Y` over every course at once, as MATLAB solves it: each
        // column's arithmetic depends on its place among the right-hand sides. A
        // nonfinite course keeps its place as zeros so it cannot poison other RHS.
        // Preserve the port's outputs: NaN-containing courses become zero; otherwise
        // nonfinite single-converted courses become NaN. MATLAB's handling of these
        // inputs was not recorded, so these replacements are not parity claims.
        let replacements: Vec<Option<f64>> = (0..data.vertices).map(|v| {
            let course = data.course(v);
            if course.iter().any(|value| value.is_nan()) {
                Some(0.0)
            } else if course.iter().any(|&value| !(value as f32).is_finite()) {
                Some(f64::NAN)
            } else {
                None
            }
        }).collect();
        let zeros = vec![0.0; data.volumes];
        let ys: Vec<&[f64]> = (0..data.vertices).map(|v| if replacements[v].is_some() { zeros.as_slice() } else { data.course(v) }).collect();
        let solution = crate::lstsq::mldivide_many(&[&design, &ones], &ys, Precision::Single);
        for (vertex, (&replacement, coefficients)) in replacements.iter().zip(&solution.coefficients).enumerate() {
            let course = data.course_mut(vertex);
            if let Some(value) = replacement {
                course.fill(value);
                continue;
            }
            let (beta, baseline) = (coefficients[0].re as f32, coefficients[1].re as f32);
            for (value, &x) in course.iter_mut().zip(&x) {
                let modelled = x * beta + baseline;
                *value = f64::from(*value as f32 - modelled);
            }
        }
        return Ok(());
    }
    let volumes = data.volumes;
    if covariates.len() != volumes * n_covariates {
        return Err(Error::Shape(format!(
            "{} covariate values are not {n_covariates} columns of {volumes} volumes",
            covariates.len()
        )));
    }
    let mut columns: Vec<Vec<f64>> = covariates
        .chunks(volumes.max(1))
        .take(n_covariates)
        .map(|column| {
            let mut column = column.to_vec();
            zscore(&mut column);
            column
        })
        .filter(|column| column.iter().any(|&value| value != 0.0))
        .collect();
    columns.push(vec![1.0; volumes]);
    let gram: Vec<Vec<f64>> = columns
        .iter()
        .map(|a| columns.iter().map(|b| dot(a, b)).collect())
        .collect();
    for vertex in 0..data.vertices {
        let course = data.course_mut(vertex);
        if course.iter().any(|value| value.is_nan()) {
            course.fill(0.0);
            continue;
        }
        let projections: Vec<f64> = columns.iter().map(|column| dot(column, course)).collect();
        let betas = solve(&gram, projections);
        for (t, value) in course.iter_mut().enumerate() {
            let modelled: f64 = columns
                .iter()
                .zip(&betas)
                .map(|(column, beta)| column[t] * beta)
                .sum();
            *value -= modelled;
        }
    }
    Ok(())
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Solves the small square system `a x = b` by Gaussian elimination with partial pivoting.
fn solve(a: &[Vec<f64>], mut b: Vec<f64>) -> Vec<f64> {
    let n = b.len();
    let mut a: Vec<Vec<f64>> = a.to_vec();
    for column in 0..n {
        let pivot = (column..n)
            .max_by(|&i, &j| a[i][column].abs().total_cmp(&a[j][column].abs()))
            .unwrap_or(column);
        a.swap(column, pivot);
        b.swap(column, pivot);
        let (upper, lower) = a.split_at_mut(column + 1);
        let pivot_row = &upper[column];
        for (offset, row) in lower.iter_mut().enumerate() {
            let factor = row[column] / pivot_row[column];
            for (value, pivot_value) in row[column..].iter_mut().zip(&pivot_row[column..]) {
                *value -= factor * pivot_value;
            }
            b[column + 1 + offset] -= factor * b[column];
        }
    }
    let mut x = vec![0.0; n];
    for row in (0..n).rev() {
        let known: f64 = (row + 1..n).map(|k| a[row][k] * x[k]).sum();
        x[row] = (b[row] - known) / a[row][row];
    }
    x
}

#[cfg(test)]
#[allow(clippy::excessive_precision)]
mod tests {
    use super::*;

    /// Deterministic courses for the single regression tests.
    fn courses(volumes: usize, vertices: usize, seed: u64) -> TimeSeries {
        let mut state = seed;
        let mut next = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((state >> 33) as f64 / (1u64 << 31) as f64 - 0.5) as f32 as f64
        };
        let mut series = TimeSeries::zeros(volumes, vertices);
        for v in 0..vertices {
            for value in series.course_mut(v) {
                *value = next() * 3.0 + v as f64 * 0.25;
            }
        }
        series
    }

    #[test]
    fn single_regression_isolates_courses_nonfinite_after_conversion() {
        let signal = [1.0, 2.0, 3.0, 4.0];
        for invalid in [f64::INFINITY, f64::NEG_INFINITY, 1e39, -1e39] {
            for vertex in [0, 1, 4, 8] {
                let mut data = courses(4, 9, 11);
                data.course_mut(vertex)[1] = invalid;
                let mut control = data.clone();
                control.course_mut(vertex).fill(0.0);
                remove_noise_in(&mut control, &signal, 1, Precision::Single).unwrap();
                remove_noise_in(&mut data, &signal, 1, Precision::Single).unwrap();
                assert!(data.course(vertex).iter().all(|value| value.is_nan()));
                for v in (0..9).filter(|&v| v != vertex) {
                    assert!(control.course(v).iter().all(|value| value.is_finite()));
                    assert_eq!(data.course(v), control.course(v), "invalid {invalid} at {vertex}, course {v}");
                }
            }
        }
    }

    #[test]
    fn single_noise_removal_accepts_an_empty_roi() {
        let mut data = TimeSeries::zeros(4, 0);
        remove_noise_in(&mut data, &[1.0, 2.0, 3.0, 4.0], 1, Precision::Single).unwrap();
        assert_eq!(data.volumes, 4);
        assert_eq!(data.vertices, 0);
        assert!(matches!(remove_noise_in(&mut data, &[1.0], 1, Precision::Single), Err(Error::Shape(_))));
    }

    #[test]
    fn a_missing_course_keeps_its_place_in_the_single_regression() {
        // MATLAB's result for a course with a NaN was not recorded. The port zeroes
        // that course and solves it as a column of zeros in its place, so every other
        // course gets the residual it would have with that column present.
        let (volumes, vertices, missing) = (250, 97, 48);
        let signal: Vec<f64> = courses(volumes, 1, 7).course(0).to_vec();
        let mut with_nan = courses(volumes, vertices, 11);
        with_nan.course_mut(missing)[17] = f64::NAN;
        let mut with_zeros = courses(volumes, vertices, 11);
        with_zeros.course_mut(missing).fill(0.0);
        remove_noise_in(&mut with_nan, &signal, 1, Precision::Single).unwrap();
        remove_noise_in(&mut with_zeros, &signal, 1, Precision::Single).unwrap();
        assert!(with_nan.course(missing).iter().all(|&value| value == 0.0));
        for v in (0..vertices).filter(|&v| v != missing) {
            assert_eq!(with_nan.course(v), with_zeros.course(v), "course {v}");
        }
        // Dropping the course instead moves the later columns, and MATLAB's ?ormqr
        // order depends on each column's place.
        let full = courses(volumes, vertices, 11);
        let mut dropped = TimeSeries::zeros(volumes, vertices - 1);
        for (k, v) in (0..vertices).filter(|&v| v != missing).enumerate() {
            dropped.course_mut(k).copy_from_slice(full.course(v));
        }
        remove_noise_in(&mut dropped, &signal, 1, Precision::Single).unwrap();
        let moved = (0..vertices).filter(|&v| v != missing).enumerate().any(|(k, v)| dropped.course(k) != with_zeros.course(v));
        assert!(moved, "dropping a course changes a later column");
    }

    // Expected values: Octave 9.2, preprocess-agent/preprocess_expected.m. The runs are
    // `mod(37t + 11v^2 + 23rt, 17) / 4 + t / 2 + v` (t, r 1-based), vertex 2 zero in
    // every run (a medial-wall vertex), vertex 1 NaN at t = 4 of run 2.
    const COURSE_DETREND: &[f64] = &[
        0.77272727272727204,
        -1.287878787878789,
        0.90151515151515005,
        -1.1590909090909109,
        1.0303030303030276,
        -1.0303030303030329,
        1.1590909090909065,
        -0.90151515151515493,
        1.2878787878787845,
        -0.77272727272727693,
    ];
    const COURSE_DETREND_ZSCORE: &[f64] = &[
        0.70064904974537223,
        -1.1677484162422831,
        0.81742389136960003,
        -1.0509735746180555,
        0.93419873299382727,
        -0.93419873299382772,
        1.050973574618056,
        -0.81742389136960003,
        1.1677484162422835,
        -0.70064904974537223,
    ];
    const AVERAGE: &[f64] = &[
        0.15832295360802937,
        -0.29164029970078859,
        0.54291970485690655,
        0.092956451548088584,
        -0.22601948234187616,
        -0.67598273565069389,
        0.15857726890700127,
        -0.29138598440181668,
        0.49110768824198375,
        0.041144434933165941,
        0.16801244918301611,
        -0.068846425874921846,
        -0.64868276700688121,
        0.69826577866092832,
        0.11842943752896884,
        -0.11842943752896873,
        -0.69826577866092854,
        0.64868276700688132,
        0.06884642587492229,
        -0.1680124491830165,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -0.24708699696857095,
        0.49503304000038822,
        0.083617138521687964,
        0.82573717549064707,
        -0.70371271473794772,
        -1.115128616216648,
        -0.37300857924768865,
        0.35991978981626921,
        1.1020398267852289,
        -0.42741006344336646,
        0.24054382948775352,
        -0.099420620253984682,
        -0.49145140190961811,
        0.31292841889130218,
        -0.027036030850436526,
        0.73446912594158942,
        -0.75903126224780826,
        0.0024738945442177216,
        -0.33749055519752086,
        0.42401460159450566,
    ];
    const NOISE_CEILING: &[f64] = &[
        -1.3010526626389871,
        f64::NAN,
        f64::NAN,
        0.19103768947745722,
        -1.4602598908193927,
    ];
    const AVERAGE_GLOBAL: &[f64] = &[
        0.063958447062045606,
        0.0070251388341386221,
        -0.10271946510758097,
        0.38597756491819324,
        -0.1676677580802583,
        -0.23501433269094427,
        -0.33434567024988482,
        0.14393809339311031,
        0.2649006771409228,
        -0.026052695219742274,
    ];
    const CONCATENATED: &[f64] = &[
        0.70064904974537223,
        -1.1677484162422831,
        0.81742389136960003,
        -1.0509735746180555,
        0.93419873299382727,
        -0.93419873299382772,
        1.050973574618056,
        -0.81742389136960003,
        1.1677484162422829,
        -0.70064904974537223,
        0.78104208463303471,
        0.46061456273230272,
        0.14018704083157102,
        -0.18024048106916135,
        -0.500668002969893,
        -0.82109552487062532,
        -1.1415230467713571,
        -1.4619505686720886,
        1.5220307290284745,
        1.2016032071277427,
        -1.0067222735543189,
        -0.1677870455923853,
        0.67114818236954854,
        1.5100834103314826,
        -1.1115891770495627,
        -0.27265394908762863,
        0.56628127887430491,
        1.4052165068362386,
        -1.2164560805448061,
        -0.37752085258287266,
        -0.70064904974536801,
        1.1677484162422866,
        -0.81742389136959737,
        1.0509735746180568,
        -0.9341987329938275,
        0.9341987329938275,
        -1.0509735746180568,
        0.81742389136959737,
        -1.1677484162422862,
        0.70064904974536724,
        f64::NAN,
        f64::NAN,
        f64::NAN,
        f64::NAN,
        f64::NAN,
        f64::NAN,
        f64::NAN,
        f64::NAN,
        f64::NAN,
        f64::NAN,
        1.0366739481114002,
        -1.3054412679921303,
        -0.479941642644165,
        0.34555798270379978,
        1.1710576080517652,
        -1.171057608051765,
        -0.34555798270380028,
        0.47994164264416517,
        1.3054412679921308,
        -1.0366739481114002,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -1.0067222735543186,
        0.98574889285527445,
        -0.48238775607811074,
        1.5100834103314824,
        0.041946761398097103,
        -1.4261898875352881,
        0.56628127887430491,
        -0.90185537005908112,
        1.0906157963505128,
        -0.37752085258287321,
        0.93628167589854072,
        0.49935022714588873,
        0.062418778393236597,
        -0.37451267035941477,
        -0.81144411911206626,
        -1.248375567864719,
        -1.6853070166173705,
        1.3107943462579528,
        0.87386289750530133,
        0.43693144875265005,
        -0.67082039324993492,
        1.6121868854029344e-15,
        0.67082039324993803,
        1.3416407864998738,
        -1.3416407864998736,
        -0.67082039324993703,
        -4.9066557381828454e-16,
        0.67082039324993592,
        1.3416407864998725,
        -1.3416407864998763,
        0.78104208463303615,
        -0.64085504380146063,
        1.2416566473653368,
        -0.18024048106916002,
        -1.6021376095036575,
        0.28037408166313987,
        -1.1415230467713577,
        0.74098864439543966,
        -0.68090848403905779,
        1.2016032071277409,
        -0.43693144875264939,
        -0.873862897505301,
        -1.3107943462579532,
        1.6853070166173711,
        1.2483755678647181,
        0.8114441191120666,
        0.37451267035941499,
        -0.062418778393236549,
        -0.49935022714588956,
        -0.93628167589854105,
        0.37752085258287377,
        1.2164560805448075,
        -1.4052165068362379,
        -0.56628127887430457,
        0.27265394908762974,
        1.1115891770495618,
        -1.510083410331482,
        -0.67114818236954998,
        0.16778704559238497,
        1.0067222735543171,
    ];
    const CONCATENATED_GLOBAL: &[f64] = &[
        -0.045136037784255657,
        0.068978769810763479,
        0.15185377825744575,
        0.26596858585246475,
        -0.31203816962111214,
        -0.22916316117442967,
        -0.11504835357941075,
        -0.032173345132728827,
        0.081941462462290324,
        0.16481647090897256,
        0.3200980779447315,
        0.021525473093222613,
        -0.27704713175828638,
        0.28263846629719874,
        -0.015934138554310251,
        -0.31450674340581941,
        -0.61307934825732813,
        -0.053393750201843101,
        0.4741358498469716,
        0.17556324499546294,
        -0.052669573221995961,
        -0.051354446607941327,
        -0.10863791477218325,
        0.52620018013217029,
        -0.20190368128200831,
        -0.20058855466795378,
        -0.25787202283219557,
        0.37696607207215788,
        0.31968260390791642,
        -0.34982266272796642,
    ];
    const AVERAGE_DETREND_ONLY: &[f64] = &[
        0.18030303030303005,
        -0.30050505050505133,
        0.63535353535353423,
        0.15454545454545285,
        -0.32626262626262853,
        -0.8070707070707096,
        0.12878787878787593,
        -0.35202020202020545,
        0.58383838383837983,
        0.10303030303029874,
        0.30909090909090975,
        -0.2318181818181817,
        -0.77272727272727293,
        0.81136363636363518,
        0.27045454545454373,
        -0.27045454545454728,
        -0.81136363636363917,
        0.77272727272726938,
        0.23181818181817837,
        -0.30909090909091397,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -0.30909090909090953,
        0.60959595959595847,
        0.11161616161615988,
        1.0303030303030278,
        -0.8843434343434371,
        -1.382323232323236,
        -0.46363636363636768,
        0.45505050505050032,
        1.373737373737369,
        -0.54090909090909689,
        0.30909090909090925,
        -0.13737373737373768,
        -0.58383838383838516,
        0.38636363636363463,
        -0.060101010101012875,
        0.91010101010100597,
        -0.95303030303030722,
        0.01717171717171162,
        -0.42929292929293555,
        0.5409090909090839,
    ];
    const CLEAN_ONE: &[f64] = &[
        0.76248185499152965,
        -1.2622438803814997,
        0.60939621420027013,
        -1.4153295211727592,
        1.3616663690272199,
        -0.62026330999054857,
        1.2085807282359613,
        -0.77334895078180743,
        1.0554950874447013,
        -0.92643459157306696,
        0.34253301106676953,
        0.431126365474791,
        0.51971971988281296,
        -0.56743284662773941,
        -0.47883949221971744,
        -0.39024613781169587,
        -0.30165278340367441,
        -1.3888053499142257,
        0.87250207957232928,
        0.96109543398035069,
        -0.9345691200364904,
        -0.09743551161833619,
        0.81997354135576006,
        0.78923074235638679,
        -0.83499708753417745,
        0.0021365208839774774,
        0.91954557385807323,
        0.88880277485869963,
        -1.6543959875101832,
        0.10170855338629076,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -0.89885296310358909,
        0.82089852714988853,
        -0.84529870604373802,
        0.87445278420973993,
        0.78767775250157857,
        -0.87851948069204844,
        0.84123200956142963,
        -0.82496522363219704,
        0.89478626662128136,
        -0.77141096657234587,
        0.17128854314849684,
        0.44790712195375337,
        0.72452570075901002,
        -1.0499821613249118,
        -0.77336358251965454,
        -0.49674500371439811,
        -0.22012642490914125,
        1.4383985246349116,
        -0.25926064841666197,
        0.017357930388594567,
        -0.54494690447922345,
        0.12273050573592484,
        0.93045100175160522,
        0.08409020438594661,
        -0.85911702175437499,
        -0.1914396115392264,
        0.61628088447645368,
        -0.23007991288920404,
        0.57764058312647537,
        -0.50560972881437782,
        0.77796970237591478,
        -0.63615970147882162,
        1.2519932404049181,
        -0.1621361634498184,
        -1.6233778552795715,
        0.26477508660416832,
        -1.1493543172505689,
        0.7387986246331707,
        -0.67533077922156637,
        1.2128221626621747,
        -0.41514256998759547,
        -0.87239767182634631,
        -1.3296527736650978,
        1.7045460427184704,
        1.2472909408797184,
        0.79003583904096752,
        0.33278073720221668,
        -0.066053258042190907,
        -0.46707609224069591,
        -0.92433119407944664,
        0.37393566721434635,
        1.212960415033876,
        -1.4126114226990818,
        -0.53046315711404524,
        0.25891049001434113,
        1.0979352378338691,
        -1.5276365998990871,
        -0.64548833431405184,
        0.18954764329597071,
        0.98291006063386321,
    ];
    const CLEAN_TWO: &[f64] = &[
        0.76297396891214675,
        -1.2617551279148331,
        0.60987810139585086,
        -1.4148572678350777,
        1.3621177077462623,
        -0.6198282451485152,
        1.2089967506141728,
        -0.77295547468455361,
        1.0558632486741846,
        -0.92609524902848994,
        0.3428412507710264,
        0.43139502539533309,
        0.51994566381766583,
        -0.56724265530448859,
        -0.47869828928610447,
        -0.39015705946969514,
        -0.30161896585526005,
        -1.3888198297853109,
        0.87243578768321506,
        0.96096447269172691,
        -0.93476705920130176,
        -0.097700863649808303,
        0.81963695069514175,
        0.78882792142341385,
        -0.83548531339693299,
        0.001568337346663784,
        0.91889360688371602,
        0.88807203280409064,
        -1.6552167854057844,
        0.10078735911154635,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -0.90021239050021851,
        0.81954838551495235,
        -0.84662988288778207,
        0.87314822016776195,
        0.7864309635079717,
        -0.87972131433420397,
        0.84008277928189901,
        -0.82605217151990351,
        0.89376924913657274,
        -0.77234837462485784,
        0.17043705433434164,
        0.44716496929141214,
        0.72390154776866911,
        -1.0505075504362456,
        -0.77375364491861531,
        -0.49699107588079949,
        -0.22021984332279687,
        1.4384385241810087,
        -0.2590775220988295,
        0.017719701019732081,
        -0.54440011254297227,
        0.12346352060549416,
        0.93138080793331257,
        0.085202966673859626,
        -0.85776833482281978,
        -0.18987004759360748,
        0.61808189381495615,
        -0.22806129336375036,
        0.57990797508518532,
        -0.50306499946972738,
        0.77984929270340164,
        -0.63429294995972219,
        1.2538337705622797,
        -0.16033242905328554,
        -1.6216540026202748,
        0.26643678247306474,
        -1.1477653525711633,
        0.74030147556973491,
        -0.67392461642693435,
        1.2141182547615239,
        -0.41396527273507711,
        -0.87137154643773496,
        -1.3287897986166139,
        1.7052724634852428,
        1.2478302543539215,
        0.79037606674638083,
        0.33290990066261955,
        -0.066108562768382395,
        -0.46732928888551784,
        -0.92483139039794104,
        0.37317965417747967,
        1.2119469238668135,
        -1.4138970041945762,
        -0.53200169991400525,
        0.25704574981736922,
        1.0957651056018187,
        -1.5301267363644524,
        -0.64827934598876547,
        0.186412670435501,
        0.9793916317172936,
    ];
    const CLEAN_AVERAGE: &[f64] = &[
        0.12722049321410481,
        -0.2950565662361323,
        0.59287132566618561,
        -0.094741225260195003,
        -0.14448404731215375,
        -0.56169722200409478,
        0.3211667851399273,
        -0.36138188102815738,
        0.36228869407368103,
        0.053813643746834491,
        0.068059164671704059,
        -0.079825205580735206,
        -0.48815435532127932,
        0.095065933551717219,
        0.38045804980143655,
        0.24884737325579265,
        -0.17575547019154691,
        0.423738512388245,
        -0.34513630769301545,
        -0.12729769488231829,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -0.41145969718000064,
        0.47697848907598361,
        0.34760534679740673,
        -0.16622209620788442,
        -0.2728079101339041,
        -0.51114365055099986,
        0.48625713384350316,
        -0.0099999652922092563,
        0.42124719360497898,
        -0.36045484395687438,
        0.21618003929419183,
        -0.10209671725911609,
        -0.45232231714231297,
        0.16589738791636205,
        0.036833907644621397,
        0.8239934992993021,
        -0.63166844879188355,
        -0.052356666067878324,
        -0.43839957998564472,
        0.43393889509235822,
    ];

    const VERTICES: usize = 5;
    const VOLUMES: usize = 10;

    fn run(r: usize) -> RawRun {
        let mut data = Vec::with_capacity(VERTICES * VOLUMES);
        for v in 0..VERTICES {
            for t in 1..=VOLUMES {
                let value = ((37 * t + 11 * v * v + 23 * r * t) % 17) as f64 / 4.0
                    + 0.5 * t as f64
                    + v as f64;
                data.push(value as f32);
            }
        }
        data[2 * VOLUMES..3 * VOLUMES].fill(0.0);
        if r == 2 {
            data[VOLUMES + 3] = f32::NAN;
        }
        RawRun {
            volumes: VOLUMES,
            vertices: VERTICES,
            data,
        }
    }

    fn accumulate(kept: VertexSelection, options: PreprocessOptions) -> Preprocessed {
        let mut accumulator = RunAccumulator::new(VERTICES, kept, options);
        for r in 1..=3 {
            accumulator.push_run(&run(r)).unwrap();
        }
        accumulator.finish().unwrap()
    }

    fn options(normalise: Normalise, combine: Combine, global_signal: bool) -> PreprocessOptions {
        PreprocessOptions {
            normalise,
            combine,
            global_signal,
            precision: Precision::Double,
        }
    }

    /// Every element within `tolerance` of the expected course's largest magnitude, so a
    /// residual near zero is not judged relative to itself; NaN must match NaN.
    fn assert_close(actual: &[f64], expected: &[f64], course: usize, tolerance: f64) {
        assert_eq!(actual.len(), expected.len(), "length");
        for (a, e) in actual.chunks(course).zip(expected.chunks(course)) {
            let scale = e.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
            for (x, y) in a.iter().zip(e) {
                assert!(x.is_nan() == y.is_nan(), "{x} vs {y}");
                assert!(
                    x.is_nan() || (x - y).abs() <= tolerance * scale,
                    "{x} vs {y}"
                );
            }
        }
    }

    #[test]
    fn detrend_and_zscore_match_octave() {
        let raw: Vec<f64> = run(1).course(0).iter().map(|&v| f64::from(v)).collect();
        let mut course = raw.clone();
        detrend(&mut course);
        assert_close(&course, COURSE_DETREND, VOLUMES, 1e-12);
        zscore(&mut course);
        assert_close(&course, COURSE_DETREND_ZSCORE, VOLUMES, 1e-12);
    }

    #[test]
    fn zscore_of_a_constant_course_is_zero() {
        let mut zeros = [0.0; 6];
        detrend(&mut zeros);
        zscore(&mut zeros);
        assert_eq!(zeros, [0.0; 6]);
        let mut ones = [1.0; 3];
        zscore(&mut ones);
        assert_eq!(ones, [0.0; 3]);
    }

    #[test]
    fn a_nan_makes_the_whole_course_nan() {
        let mut course = [1.0, 2.0, f64::NAN, 4.0, 5.0];
        detrend(&mut course);
        assert!(course.iter().all(|v| v.is_nan()));
    }

    #[test]
    fn noise_ceiling_is_nan_for_a_constant_course() {
        assert!(noise_ceiling(&[1.0, 1.0, 1.0], &[1.0, 2.0, 3.0]).is_nan());
        assert_eq!(noise_ceiling(&[1.0, 2.0, 3.0], &[2.0, 4.0, 6.0]), 1.0);
    }

    #[test]
    fn averaging_matches_octave() {
        let combine = Combine::Average {
            noise_ceiling: true,
        };
        let result = accumulate(
            VertexSelection::All,
            options(Normalise::DetrendZscore, combine, true),
        );
        assert_eq!(result.runs, 3);
        assert_eq!(
            (result.data.volumes, result.data.vertices),
            (VOLUMES, VERTICES)
        );
        assert_close(&result.data.data, AVERAGE, VOLUMES, 1e-12);
        assert_close(&result.noise_ceiling.unwrap(), NOISE_CEILING, 1, 1e-12);
        assert_close(
            &result.global_signal.unwrap(),
            AVERAGE_GLOBAL,
            VOLUMES,
            1e-12,
        );
    }

    #[test]
    fn averaging_detrended_runs_matches_octave() {
        let combine = Combine::Average {
            noise_ceiling: false,
        };
        let result = accumulate(
            VertexSelection::All,
            options(Normalise::Detrend, combine, false),
        );
        assert_close(&result.data.data, AVERAGE_DETREND_ONLY, VOLUMES, 1e-12);
        assert_eq!(result.noise_ceiling, None);
        assert_eq!(result.global_signal, None);
    }

    #[test]
    fn concatenation_matches_octave() {
        let result = accumulate(
            VertexSelection::All,
            options(Normalise::DetrendZscore, Combine::Concatenate, true),
        );
        assert_eq!(
            (result.data.volumes, result.data.vertices),
            (3 * VOLUMES, VERTICES)
        );
        assert_close(&result.data.data, CONCATENATED, 3 * VOLUMES, 1e-12);
        assert_close(
            &result.global_signal.unwrap(),
            CONCATENATED_GLOBAL,
            3 * VOLUMES,
            1e-12,
        );
    }

    #[test]
    fn a_selection_keeps_its_vertices_in_order_and_the_global_signal_keeps_every_vertex() {
        for combine in [
            Combine::Average {
                noise_ceiling: true,
            },
            Combine::Concatenate,
        ] {
            let all = accumulate(
                VertexSelection::All,
                options(Normalise::DetrendZscore, combine, true),
            );
            let selection = VertexSelection::from_indices(vec![3, 0]);
            let some = accumulate(
                selection.clone(),
                options(Normalise::DetrendZscore, combine, true),
            );
            assert_eq!(some.kept, selection);
            assert_eq!(some.total_vertices, VERTICES);
            assert_eq!(some.data.vertices, 2);
            assert_eq!(some.data.course(0), all.data.course(0));
            assert_eq!(some.data.course(1), all.data.course(3));
            assert_close(
                &some.global_signal.unwrap(),
                &all.global_signal.unwrap(),
                some.data.volumes,
                1e-15,
            );
            if let Some(ceiling) = all.noise_ceiling {
                assert_eq!(some.noise_ceiling.unwrap(), [ceiling[0], ceiling[3]]);
            }
        }
    }

    #[test]
    fn a_single_run_average_is_that_run() {
        let combine = Combine::Average {
            noise_ceiling: true,
        };
        let mut accumulator = RunAccumulator::new(
            VERTICES,
            VertexSelection::All,
            options(Normalise::None, combine, false),
        );
        accumulator.push_run(&run(2)).unwrap();
        let result = accumulator.finish().unwrap();
        let raw: Vec<f64> = run(2).data.iter().map(|&v| f64::from(v)).collect();
        assert_eq!(result.data.data[..VOLUMES], raw[..VOLUMES]);
        assert!(result.data.data[VOLUMES + 3].is_nan());
        assert_eq!(result.data.data[VOLUMES + 4..], raw[VOLUMES + 4..]);
        assert_eq!(result.noise_ceiling, None);
    }

    #[test]
    fn a_single_global_signal_sums_rounded_courses_in_single() {
        let data = TimeSeries { volumes: 1, vertices: 3, data: vec![1.0, 1e-8, 1e-8] };
        assert_eq!(mean_across_vertices(&data, Precision::Double), vec![(1.0 + 1e-8 + 1e-8) / 3.0]);
        assert_eq!(mean_across_vertices(&data, Precision::Single), vec![f64::from(1.0f32 / 3.0)]);
    }

    #[test]
    fn the_global_signal_counts_more_vertices_than_a_u16_holds() {
        let vertices = 70_000;
        let raw = RawRun {
            volumes: 2,
            vertices,
            data: [1.0, 3.0].repeat(vertices),
        };
        for combine in [
            Combine::Average {
                noise_ceiling: false,
            },
            Combine::Concatenate,
        ] {
            for kept in [VertexSelection::All, VertexSelection::Indices(vec![0])] {
                let mut accumulator =
                    RunAccumulator::new(vertices, kept, options(Normalise::None, combine, true));
                accumulator.push_run(&raw).unwrap();
                let signal = accumulator.finish().unwrap().global_signal.unwrap();
                assert_eq!(signal, [1.0, 3.0], "{combine:?}");
            }
        }
    }

    #[test]
    fn a_single_volume_is_not_normalised() {
        let combine = Combine::Average {
            noise_ceiling: false,
        };
        let mut accumulator = RunAccumulator::new(
            2,
            VertexSelection::All,
            options(Normalise::DetrendZscore, combine, false),
        );
        accumulator
            .push_run(&RawRun {
                volumes: 1,
                vertices: 2,
                data: vec![3.5, -2.0],
            })
            .unwrap();
        assert_eq!(accumulator.finish().unwrap().data.data, [3.5, -2.0]);
    }

    #[test]
    fn mismatched_runs_are_shape_errors() {
        let combine = Combine::Concatenate;
        let mut accumulator = RunAccumulator::new(
            VERTICES,
            VertexSelection::All,
            options(Normalise::None, combine, false),
        );
        let wrong_vertices = RawRun {
            volumes: 2,
            vertices: 4,
            data: vec![0.0; 8],
        };
        assert!(matches!(
            accumulator.push_run(&wrong_vertices),
            Err(Error::Shape(_))
        ));
        accumulator.push_run(&run(1)).unwrap();
        let wrong_volumes = RawRun {
            volumes: 2,
            vertices: VERTICES,
            data: vec![0.0; 2 * VERTICES],
        };
        assert!(matches!(
            accumulator.push_run(&wrong_volumes),
            Err(Error::Shape(_))
        ));
        let empty = RunAccumulator::new(
            VERTICES,
            VertexSelection::All,
            options(Normalise::None, combine, false),
        );
        assert!(matches!(empty.finish(), Err(Error::Shape(_))));
        let mut outside = RunAccumulator::new(
            VERTICES,
            VertexSelection::from_indices(vec![5]),
            options(Normalise::None, combine, false),
        );
        assert!(matches!(outside.push_run(&run(1)), Err(Error::Shape(_))));
    }

    fn concatenated() -> (TimeSeries, Vec<f64>) {
        let result = accumulate(
            VertexSelection::All,
            options(Normalise::DetrendZscore, Combine::Concatenate, true),
        );
        (result.data, result.global_signal.unwrap())
    }

    #[test]
    fn removing_the_global_signal_matches_octave() {
        let (mut data, global) = concatenated();
        remove_noise(&mut data, &global, 1).unwrap();
        assert_close(&data.data, CLEAN_ONE, 3 * VOLUMES, 1e-12);
        assert!(data.course(1).iter().all(|&v| v == 0.0));
    }

    #[test]
    fn removing_two_covariates_matches_octave() {
        let (mut data, mut covariates) = concatenated();
        covariates.extend((1..=3 * VOLUMES).map(|t| (t * t) as f64));
        remove_noise(&mut data, &covariates, 2).unwrap();
        assert_close(&data.data, CLEAN_TWO, 3 * VOLUMES, 1e-12);
    }

    #[test]
    fn removing_the_global_signal_from_an_average_matches_octave() {
        let combine = Combine::Average {
            noise_ceiling: false,
        };
        let result = accumulate(
            VertexSelection::All,
            options(Normalise::DetrendZscore, combine, true),
        );
        let mut data = result.data;
        remove_noise(&mut data, &result.global_signal.unwrap(), 1).unwrap();
        assert_close(&data.data, CLEAN_AVERAGE, VOLUMES, 1e-12);
    }

    #[test]
    fn a_constant_covariate_leaves_only_the_intercept() {
        let mut data = TimeSeries {
            volumes: 4,
            vertices: 1,
            data: vec![1.0, 2.0, 4.0, 9.0],
        };
        remove_noise(&mut data, &[7.0; 4], 1).unwrap();
        assert_eq!(data.data, [-3.0, -2.0, 0.0, 5.0]);
        assert!(matches!(
            remove_noise(&mut data, &[7.0; 3], 1),
            Err(Error::Shape(_))
        ));
    }
}
