//! One analysis as a job: the inputs prepared once, vertex ranges run independently
//! (so a browser can fan them out to Web Workers) and their partial results merged
//! into `Srf.Data`.
//!
//! `JobInputs` is what `SamSrfAnalysis` gathers before calling the analysis: the
//! model, the apertures, the preprocessed time courses of the vertices that have one
//! (the ROI, plus the seed region for connective fields), the ROI, the noise ceiling,
//! and the connective-field extras (seed vertices, template, surface area, mesh).
//! `Job::run(start, end)` analyses positions `[start, end)` of the ROI in label order
//! and returns a `Partial`; `Job::merge` expects partials that cover the ROI exactly once.

use crate::apertures::Apertures;
use crate::error::{Error, Result};
use crate::hrf::{self, ResolvedHrf};
use crate::mapset::{MapSet, Maps};
use crate::model::Model;
use crate::surface::Surface;
use crate::timeseries::{TimeSeries, VertexSelection};
use crate::{fit_prf, preprocess, revcor_cf, revcor_prf};

/// The connective-field seed region and the template its coordinates come from.
#[derive(Debug, Clone, PartialEq)]
pub struct SeedInputs {
    /// 0-based, in label order.
    pub vertices: Vec<u32>,
    /// `Temp.Srf.Data` over every vertex of the hemisphere (rows `R^2`, `x0`, `y0`, ...).
    pub template: Maps,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JobInputs {
    pub model: Model,
    pub apertures: Option<Apertures>,
    /// Replaces the model's HRF when the caller resolved a file-backed one.
    pub hrf: Option<ResolvedHrf>,
    /// The time courses, one per entry of `kept` (0-based vertex indices, any order).
    pub data: TimeSeries,
    pub kept: Vec<u32>,
    /// The ROI (`mver`) in label order; `None` analyses every kept vertex in order.
    pub roi: Option<Vec<u32>>,
    /// `Srf.Noise_Ceiling` per kept vertex.
    pub noise_ceiling: Option<Vec<f64>>,
    /// `nanmean(Srf.Data, 2)` across the whole hemisphere, per volume (connective fields).
    pub global_signal: Option<Vec<f64>>,
    pub seed: Option<SeedInputs>,
    pub surface: Option<Surface>,
    /// `Srf.Area` over every vertex.
    pub area: Option<Vec<f64>>,
    /// `Model.Seed_Fine_Fit` as maps over every vertex: row 0 `R^2`, then the parameters.
    pub seed_fine_fit: Option<Maps>,
    pub total_vertices: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Prf = 0,
    RevCorPrf = 1,
    RevCorCf = 2,
}

enum Analysis {
    Prf(Box<fit_prf::Prepared>),
    RevCorPrf(Box<revcor_prf::Prepared>),
    RevCorCf(Box<revcor_cf::Prepared>),
}

pub struct Job {
    analysis: Analysis,
    data: TimeSeries,
    kept: Vec<u32>,
    /// Kept position per vertex of the hemisphere, or `u32::MAX`.
    kept_position: Vec<u32>,
    /// The analysed vertices in label order, after the noise-ceiling threshold.
    mver: Vec<u32>,
    noise_ceiling: Option<Vec<f64>>,
    seed_fine_fit: Option<Maps>,
    total_vertices: usize,
    model_name: String,
}

/// The result of `Job::run` on one vertex range: `rows x (end - start)` values, row-major,
/// plus the raw rows where the analysis keeps `Srf.Raw_Data`.
#[derive(Debug, Clone, PartialEq)]
pub struct Partial {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
    pub rows: usize,
    pub data: Vec<f64>,
    pub raw_rows: usize,
    pub raw: Vec<f64>,
}

const PARTIAL_MAGIC: &[u8; 8] = b"SAMSRFPT";
const PARTIAL_VERSION: u32 = 1;

impl Partial {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + 7 * 4 + 8 * (self.data.len() + self.raw.len()));
        out.extend_from_slice(PARTIAL_MAGIC);
        for value in [PARTIAL_VERSION, self.kind as u32, self.start as u32, self.end as u32, self.rows as u32, self.raw_rows as u32] {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out.extend(self.data.iter().flat_map(|value| value.to_le_bytes()));
        out.extend(self.raw.iter().flat_map(|value| value.to_le_bytes()));
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Partial> {
        let format = |message: &str| Error::format("partial", message);
        if bytes.len() < 8 + 6 * 4 || &bytes[..8] != PARTIAL_MAGIC {
            return Err(format("not a SamSrf partial result"));
        }
        let u32_at = |offset: usize| u32::from_le_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]]);
        if u32_at(8) != PARTIAL_VERSION {
            return Err(format("unsupported partial result version"));
        }
        let kind = match u32_at(12) {
            0 => Kind::Prf,
            1 => Kind::RevCorPrf,
            2 => Kind::RevCorCf,
            _ => return Err(format("unknown analysis kind")),
        };
        let start = u32_at(16) as usize;
        let end = u32_at(20) as usize;
        let rows = u32_at(24) as usize;
        let raw_rows = u32_at(28) as usize;
        if end < start {
            return Err(format("range end before start"));
        }
        let count = end - start;
        let expected = 32 + 8 * (rows + raw_rows) * count;
        if bytes.len() != expected {
            return Err(format("partial result length does not match its header"));
        }
        let values: Vec<f64> = bytes[32..].as_chunks::<8>().0.iter().map(|chunk| f64::from_le_bytes(*chunk)).collect();
        let (data, raw) = values.split_at(rows * count);
        Ok(Partial { kind, start, end, rows, data: data.to_vec(), raw_rows, raw: raw.to_vec() })
    }
}

impl Job {
    pub fn prepare(inputs: JobInputs, progress: &mut dyn FnMut(usize, usize)) -> Result<Job> {
        let JobInputs { model, apertures, hrf, mut data, kept, roi, noise_ceiling, global_signal, seed, surface, area, seed_fine_fit, total_vertices } = inputs;
        if data.vertices != kept.len() {
            return Err(Error::Shape(format!("{} time courses for {} kept vertices", data.vertices, kept.len())));
        }
        if let Some(ceiling) = &noise_ceiling {
            if ceiling.len() != kept.len() {
                return Err(Error::Shape(format!("{} noise ceiling values for {} kept vertices", ceiling.len(), kept.len())));
            }
        }
        let mut kept_position = vec![u32::MAX; total_vertices];
        for (position, &vertex) in kept.iter().enumerate() {
            let v = vertex as usize;
            if v >= total_vertices {
                return Err(Error::Shape(format!("vertex {v} is outside the hemisphere ({total_vertices} vertices)")));
            }
            kept_position[v] = position as u32;
        }
        let mut mver: Vec<u32> = roi.unwrap_or_else(|| kept.clone());
        for &vertex in &mver {
            if (vertex as usize) >= total_vertices || kept_position[vertex as usize] == u32::MAX {
                return Err(Error::Shape(format!("ROI vertex {vertex} has no time course")));
            }
        }
        let (model_name, threshold) = match &model {
            Model::Prf(model) => (model.name.clone(), model.noise_ceiling_threshold),
            Model::RevCorPrf(model) => (model.name.clone(), model.noise_ceiling_threshold),
            Model::RevCorCf(model) => (model.name.clone(), model.noise_ceiling_threshold),
        };
        // Connective fields: the global signal is regressed out of the ROI courses before
        // the noise-ceiling threshold is applied (samsrf_revcor_cf's order).
        if let Model::RevCorCf(cf) = &model {
            if cf.global_signal_correction {
                let signal = global_signal.as_ref().ok_or_else(|| Error::Shape("Global_Signal_Correction needs the global signal of the preprocessed data".into()))?;
                let mut roi_series = TimeSeries::zeros(data.volumes, mver.len());
                for (i, &vertex) in mver.iter().enumerate() {
                    roi_series.course_mut(i).copy_from_slice(data.course(kept_position[vertex as usize] as usize));
                }
                preprocess::remove_noise(&mut roi_series, signal, 1)?;
                for (i, &vertex) in mver.iter().enumerate() {
                    data.course_mut(kept_position[vertex as usize] as usize).copy_from_slice(roi_series.course(i));
                }
            }
        }
        if threshold > 0.0 {
            if let Some(ceiling) = &noise_ceiling {
                mver.retain(|&vertex| ceiling[kept_position[vertex as usize] as usize] > threshold);
            }
        }
        let analysis = match &model {
            Model::Prf(prf) => {
                let apertures = apertures.ok_or_else(|| Error::Shape("samsrf_fit_prf needs apertures".into()))?;
                let resolved = match hrf {
                    Some(resolved) => resolved,
                    None => hrf::resolve(&prf.hrf, prf.tr)?,
                };
                if !prf.seed_fine_fit.is_empty() && seed_fine_fit.is_none() {
                    return Err(Error::Model(format!("Seed_Fine_Fit names {} but no seed maps were given", prf.seed_fine_fit)));
                }
                if let Some(seed) = &seed_fine_fit {
                    if seed.rows() != prf.param_names.len() + 1 || seed.vertices != total_vertices {
                        return Err(Error::Shape("Seed_Fine_Fit maps must hold R^2 and one row per parameter for every vertex".into()));
                    }
                }
                Analysis::Prf(Box::new(fit_prf::Prepared::new(prf, apertures, &resolved, data.volumes, seed_fine_fit.is_some(), progress)?))
            }
            Model::RevCorPrf(rc) => {
                let apertures = apertures.ok_or_else(|| Error::Shape("samsrf_revcor_prf needs apertures".into()))?;
                let resolved = match hrf {
                    Some(resolved) => resolved,
                    None => hrf::resolve(&rc.hrf, rc.tr)?,
                };
                Analysis::RevCorPrf(Box::new(revcor_prf::Prepared::new(rc, &apertures, &resolved, data.volumes)?))
            }
            Model::RevCorCf(cf) => {
                let seed = seed.ok_or_else(|| Error::Shape("samsrf_revcor_cf needs the seed region and template".into()))?;
                let area = area.ok_or_else(|| Error::Shape("samsrf_revcor_cf needs Srf.Area".into()))?;
                let mut seed_courses = Vec::with_capacity(seed.vertices.len());
                for &vertex in &seed.vertices {
                    if (vertex as usize) >= total_vertices || kept_position[vertex as usize] == u32::MAX {
                        return Err(Error::Shape(format!("seed vertex {vertex} has no time course")));
                    }
                    seed_courses.push(data.course(kept_position[vertex as usize] as usize));
                }
                Analysis::RevCorCf(Box::new(revcor_cf::Prepared::new(cf, &seed.vertices, &seed_courses, &seed.template, &area, surface.as_ref())?))
            }
        };
        Ok(Job { analysis, data, kept, kept_position, mver, noise_ceiling, seed_fine_fit, total_vertices, model_name })
    }

    pub fn kind(&self) -> Kind {
        match self.analysis {
            Analysis::Prf(_) => Kind::Prf,
            Analysis::RevCorPrf(_) => Kind::RevCorPrf,
            Analysis::RevCorCf(_) => Kind::RevCorCf,
        }
    }

    /// The number of analysed vertices (`length(mver)`).
    pub fn vertex_count(&self) -> usize {
        self.mver.len()
    }

    /// The analysed vertices in label order.
    pub fn analysed(&self) -> &[u32] {
        &self.mver
    }

    /// `Srf.Values` of the per-vertex rows (before the noise ceiling and `nR^2`).
    pub fn values(&self) -> Vec<String> {
        match &self.analysis {
            Analysis::Prf(prepared) => prepared.values.clone(),
            Analysis::RevCorPrf(prepared) => prepared.values.clone(),
            Analysis::RevCorCf(prepared) => prepared.values.clone(),
        }
    }

    /// What follows `<hemisphere>_<Model.Name>` in SamSrf's output file name.
    pub fn out_suffix(&self) -> String {
        match &self.analysis {
            Analysis::Prf(prepared) => prepared.out_suffix.clone(),
            Analysis::RevCorPrf(_) => "_Rcp".into(),
            Analysis::RevCorCf(_) => String::new(),
        }
    }

    pub fn model_name(&self) -> &str {
        &self.model_name
    }

    fn course(&self, position: usize) -> &[f64] {
        self.data.course(self.kept_position[self.mver[position] as usize] as usize)
    }

    /// Analyses positions `[start, end)` of the ROI; `progress` receives the count done.
    pub fn run(&self, start: usize, end: usize, progress: &mut dyn FnMut(usize)) -> Result<Partial> {
        if start > end || end > self.mver.len() {
            return Err(Error::Shape(format!("range {start}..{end} is outside the {} analysed vertices", self.mver.len())));
        }
        let count = end - start;
        let rows = self.values().len();
        let mut data = vec![0.0; rows * count];
        let (raw_rows, mut raw) = match &self.analysis {
            Analysis::RevCorPrf(_) => (revcor_prf::RAW_VALUES.len(), vec![0.0; revcor_prf::RAW_VALUES.len() * count]),
            _ => (0, Vec::new()),
        };
        for (i, position) in (start..end).enumerate() {
            let y = self.course(position);
            let row = match &self.analysis {
                Analysis::Prf(prepared) => {
                    let (pimg, rimg, prediction) = match &self.seed_fine_fit {
                        Some(seed) => {
                            let vertex = self.mver[position] as usize;
                            let params: Vec<f64> = (1..seed.rows()).map(|r| seed.row(r)[vertex]).collect();
                            (params, seed.row(0)[vertex], None)
                        }
                        None => prepared.coarse_fit(y)?,
                    };
                    prepared.fit_vertex(y, &pimg, rimg, prediction.as_deref())?
                }
                Analysis::RevCorPrf(prepared) => {
                    let (raw_row, profile) = prepared.reverse_correlate(y);
                    for (r, value) in raw_row.iter().enumerate() {
                        raw[r * count + i] = *value;
                    }
                    if prepared.model.prf_function.is_some() {
                        prepared.fit_model(&raw_row, &profile)?
                    } else {
                        prepared.convex_hull(&raw_row, &profile)
                    }
                }
                Analysis::RevCorCf(prepared) => prepared.estimate(y)?,
            };
            debug_assert_eq!(row.len(), rows);
            for (r, value) in row.iter().enumerate() {
                data[r * count + i] = *value;
            }
            if i % 8 == 7 || i + 1 == count {
                progress(i + 1);
            }
        }
        Ok(Partial { kind: self.kind(), start, end, rows, data, raw_rows, raw })
    }

    /// Merges partials covering the ROI exactly once into `Srf.Data` over every vertex,
    /// appends the noise ceiling and, for the pRF fit, `samsrf_normr2`.
    pub fn merge(&self, partials: &[Partial]) -> Result<MapSet> {
        let mut sorted: Vec<&Partial> = partials.iter().collect();
        sorted.sort_by_key(|partial| partial.start);
        let mut expected = 0;
        for partial in &sorted {
            if partial.kind != self.kind() {
                return Err(Error::Shape("a partial result belongs to another analysis".into()));
            }
            if partial.start != expected {
                return Err(Error::Shape(format!("partial results do not cover vertices {expected}..{}", partial.start)));
            }
            expected = partial.end;
        }
        if expected != self.mver.len() {
            return Err(Error::Shape(format!("partial results cover {expected} of {} vertices", self.mver.len())));
        }
        let values = self.values();
        let fill = match &self.analysis {
            Analysis::RevCorPrf(prepared) if prepared.model.prf_function.is_some() => f64::NAN,
            _ => 0.0,
        };
        let mut maps = Maps { values: values.clone(), vertices: self.total_vertices, data: vec![fill; values.len() * self.total_vertices] };
        let mut raw = match &self.analysis {
            Analysis::RevCorPrf(_) => Some(Maps::zeros(revcor_prf::RAW_VALUES.iter().map(|value| value.to_string()).collect(), self.total_vertices)),
            _ => None,
        };
        for partial in sorted {
            let count = partial.end - partial.start;
            if partial.rows != values.len() || partial.data.len() != partial.rows * count {
                return Err(Error::Shape("a partial result has the wrong number of rows".into()));
            }
            for i in 0..count {
                let vertex = self.mver[partial.start + i] as usize;
                for r in 0..partial.rows {
                    maps.row_mut(r)[vertex] = partial.data[r * count + i];
                }
                if let Some(raw) = &mut raw {
                    if partial.raw_rows != raw.rows() {
                        return Err(Error::Shape("a partial result has the wrong number of raw rows".into()));
                    }
                    for r in 0..partial.raw_rows {
                        raw.row_mut(r)[vertex] = partial.raw[r * count + i];
                    }
                }
            }
        }
        if let Some(ceiling) = &self.noise_ceiling {
            let mut row = vec![0.0; self.total_vertices];
            let mut known = vec![false; self.total_vertices];
            for (position, &vertex) in self.kept.iter().enumerate() {
                row[vertex as usize] = ceiling[position];
                known[vertex as usize] = true;
            }
            maps.values.push("Noise Ceiling".into());
            maps.data.extend(row);
            if matches!(self.analysis, Analysis::Prf(_)) {
                fit_prf::normr2(&mut maps, &known);
            }
        }
        let analysed = if self.mver.len() == self.total_vertices { VertexSelection::All } else { VertexSelection::from_indices(self.mver.clone()) };
        Ok(MapSet { maps, raw, analysed })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_round_trips_and_rejects_damage() {
        let partial = Partial { kind: Kind::RevCorPrf, start: 3, end: 5, rows: 2, data: vec![1.0, 2.0, 3.0, 4.0], raw_rows: 1, raw: vec![5.0, 6.0] };
        let bytes = partial.to_bytes();
        assert_eq!(Partial::from_bytes(&bytes).unwrap(), partial);
        assert!(Partial::from_bytes(&bytes[..bytes.len() - 1]).is_err());
        assert!(Partial::from_bytes(b"nope").is_err());
    }
}
