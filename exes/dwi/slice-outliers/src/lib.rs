// SPDX-License-Identifier: Apache-2.0
//! Slice outlier detection and replacement for SHORELine (prototype, #480).
//!
//! Head motion during the diffusion encoding can drop the signal of a whole slice. FSL eddy
//! finds such slices by comparing each slice with the model prediction and replaces them
//! with the prediction (`--repol`; Andersson et al. 2016). This crate is a clean-room
//! implementation of that method from the paper; no FSL code was read. SHORELine's 3dSHORE
//! leave-out prediction (`dwi-shore`) is the model: it does not use the volume it predicts,
//! so a dropout cannot hide in its own prediction.
//!
//! For each slice of each diffusion-weighted volume, the statistic is the mean of
//! observed - predicted over the slice's brain voxels. The statistics of one shell are
//! standardised with their mean and standard deviation over all its volumes and slices. A
//! slice is an outlier when its standardised value is below -`n_std` (eddy's defaults:
//! `--ol_nstd=4`, `--ol_nvox=250`, negative deviations only).
//!
//! The observed and predicted volumes must be on one grid with the acquisition's slices:
//! a dropout is a property of an acquired slice, so the caller warps each prediction back to
//! its volume's own space, as QSIPrep does for its noise-free images. Volumes are flat arrays
//! in NIfTI voxel order (x fastest).

/// Detection settings. `Default` gives eddy's defaults.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Params {
    /// A slice is an outlier this many standard deviations from its shell's mean (`--ol_nstd`).
    pub n_std: f64,
    /// Slices with fewer brain voxels are neither used for the statistics nor flagged
    /// (`--ol_nvox`).
    pub min_voxels: usize,
    /// Also flag slices with too much signal (`--ol_pos`).
    pub positive: bool,
    /// Also flag slices by the mean squared difference (`--ol_sqr`).
    pub squared: bool,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            n_std: 4.0,
            min_voxels: 250,
            positive: false,
            squared: false,
        }
    }
}

/// A volume grid and the voxel axis along which the slices were acquired.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SliceGrid {
    pub dims: [usize; 3],
    pub slice_axis: usize,
}

impl SliceGrid {
    pub fn new(dims: [usize; 3], slice_axis: usize) -> Result<Self, String> {
        if slice_axis > 2 {
            return Err(format!("The slice axis {slice_axis} is not 0, 1 or 2."));
        }
        Ok(Self { dims, slice_axis })
    }

    pub fn voxels(&self) -> usize {
        self.dims.iter().product()
    }

    pub fn slices(&self) -> usize {
        self.dims[self.slice_axis]
    }

    /// The slice of voxel `v` (NIfTI order).
    pub fn slice_of(&self, v: usize) -> usize {
        let [nx, ny, _] = self.dims;
        match self.slice_axis {
            0 => v % nx,
            1 => (v / nx) % ny,
            _ => v / (nx * ny),
        }
    }
}

/// The per-slice statistics of one volume.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SliceStatistic {
    /// Mean of observed - predicted over the slice's brain voxels.
    pub mean: f64,
    /// Mean of (observed - predicted)² over the same voxels.
    pub mean_square: f64,
    /// The number of brain voxels in the slice.
    pub voxels: usize,
}

/// The statistics of every slice of one volume.
pub fn slice_statistics(
    grid: &SliceGrid,
    observed: &[f32],
    predicted: &[f64],
    mask: &[bool],
) -> Vec<SliceStatistic> {
    let mut sum = vec![0.0; grid.slices()];
    let mut sum_square = vec![0.0; grid.slices()];
    let mut count = vec![0usize; grid.slices()];
    for v in 0..grid.voxels() {
        if mask[v] {
            let s = grid.slice_of(v);
            let d = observed[v] as f64 - predicted[v];
            sum[s] += d;
            sum_square[s] += d * d;
            count[s] += 1;
        }
    }
    (0..grid.slices())
        .map(|s| {
            let n = count[s].max(1) as f64;
            SliceStatistic {
                mean: sum[s] / n,
                mean_square: sum_square[s] / n,
                voxels: count[s],
            }
        })
        .collect()
}

/// The result of `detect`, one row per volume and one column per slice, as eddy's
/// `eddy_outlier_map`, `eddy_outlier_n_stdev_map` and `eddy_outlier_n_sqr_stdev_map`.
#[derive(Clone, Debug, PartialEq)]
pub struct OutlierMap {
    pub outlier: Vec<Vec<bool>>,
    /// Standardised mean difference; NaN for a slice with too few brain voxels.
    pub n_stdev: Vec<Vec<f64>>,
    /// Standardised mean squared difference; NaN for a slice with too few brain voxels.
    pub n_sqr_stdev: Vec<Vec<f64>>,
}

impl OutlierMap {
    /// The number of outlier slices.
    pub fn count(&self) -> usize {
        self.outlier.iter().flatten().filter(|&&o| o).count()
    }

    /// One line per outlier slice, in the style of eddy's `eddy_outlier_report`.
    pub fn report(&self) -> Vec<String> {
        let mut lines = Vec::new();
        for (v, row) in self.outlier.iter().enumerate() {
            for (s, &o) in row.iter().enumerate() {
                if o {
                    lines.push(format!(
                        "Slice {s} in scan {v} is an outlier with mean {:.5} standard deviations off, and mean squared {:.5} standard deviations off.",
                        self.n_stdev[v][s], self.n_sqr_stdev[v][s]
                    ));
                }
            }
        }
        lines
    }
}

/// Finds outlier slices. `statistics[v]` holds volume v's `slice_statistics`; `shells[v]` is
/// its shell (b-value rounded to the shell). Each shell is standardised on its own.
pub fn detect(
    statistics: &[Vec<SliceStatistic>],
    shells: &[f64],
    params: &Params,
) -> Result<OutlierMap, String> {
    if statistics.len() != shells.len() {
        return Err("There must be one shell per volume.".into());
    }
    let slices = statistics.first().map_or(0, |s| s.len());
    let nan_rows = || vec![vec![f64::NAN; slices]; statistics.len()];
    let mut map = OutlierMap {
        outlier: vec![vec![false; slices]; statistics.len()],
        n_stdev: nan_rows(),
        n_sqr_stdev: nan_rows(),
    };
    let mut distinct: Vec<f64> = shells.to_vec();
    distinct.sort_by(f64::total_cmp);
    distinct.dedup();
    for shell in distinct {
        let members: Vec<usize> = (0..shells.len()).filter(|&v| shells[v] == shell).collect();
        let used = |v: usize, s: usize| statistics[v][s].voxels >= params.min_voxels;
        let values = |f: fn(&SliceStatistic) -> f64| -> Vec<f64> {
            members
                .iter()
                .flat_map(|&v| {
                    (0..slices)
                        .filter(move |&s| used(v, s))
                        .map(move |s| f(&statistics[v][s]))
                })
                .collect()
        };
        let (mean_m, sd_m) = mean_sd(&values(|x| x.mean));
        let (mean_q, sd_q) = mean_sd(&values(|x| x.mean_square));
        for &v in &members {
            for (s, stat) in statistics[v].iter().enumerate() {
                if stat.voxels < params.min_voxels {
                    continue;
                }
                let z = (stat.mean - mean_m) / sd_m;
                let zq = (stat.mean_square - mean_q) / sd_q;
                map.n_stdev[v][s] = z;
                map.n_sqr_stdev[v][s] = zq;
                map.outlier[v][s] = z < -params.n_std
                    || (params.positive && z > params.n_std)
                    || (params.squared && zq > params.n_std);
            }
        }
    }
    Ok(map)
}

/// Mean and sample standard deviation; a zero spread is reported as NaN so nothing is
/// flagged.
fn mean_sd(values: &[f64]) -> (f64, f64) {
    let n = values.len() as f64;
    if values.len() < 2 {
        return (f64::NAN, f64::NAN);
    }
    let mean = values.iter().sum::<f64>() / n;
    let var = values.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / (n - 1.0);
    let sd = var.sqrt();
    (mean, if sd > 0.0 { sd } else { f64::NAN })
}

/// Replaces the brain voxels of the flagged slices of one volume with the prediction.
/// Voxels outside the mask keep their values: SHORELine predicts 0 there.
pub fn replace(
    grid: &SliceGrid,
    observed: &mut [f32],
    predicted: &[f64],
    mask: &[bool],
    outlier_slices: &[bool],
) {
    for v in 0..grid.voxels() {
        if mask[v] && outlier_slices[grid.slice_of(v)] {
            observed[v] = predicted[v] as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slices_follow_the_chosen_axis() {
        let g = SliceGrid::new([3, 4, 5], 2).unwrap();
        assert_eq!(g.slice_of(3 * 4 * 2 + 5), 2);
        let g = SliceGrid::new([3, 4, 5], 1).unwrap();
        assert_eq!(g.slice_of(3 * 4 * 2 + 5), 1);
        let g = SliceGrid::new([3, 4, 5], 0).unwrap();
        assert_eq!(g.slice_of(7), 1);
        assert!(SliceGrid::new([3, 4, 5], 3).is_err());
    }

    #[test]
    fn statistics_use_only_brain_voxels() {
        let g = SliceGrid::new([2, 1, 2], 2).unwrap();
        let s = slice_statistics(
            &g,
            &[3.0, 9.0, 1.0, 1.0],
            &[1.0, 0.0, 2.0, 2.0],
            &[true, false, true, true],
        );
        assert_eq!(
            s[0],
            SliceStatistic {
                mean: 2.0,
                mean_square: 4.0,
                voxels: 1
            }
        );
        assert_eq!(
            s[1],
            SliceStatistic {
                mean: -1.0,
                mean_square: 1.0,
                voxels: 2
            }
        );
    }

    #[test]
    fn replace_keeps_voxels_outside_the_mask_and_clean_slices() {
        let g = SliceGrid::new([2, 1, 2], 2).unwrap();
        let mut observed = [1.0f32, 2.0, 3.0, 4.0];
        replace(
            &g,
            &mut observed,
            &[10.0, 20.0, 30.0, 40.0],
            &[true, false, true, true],
            &[true, false],
        );
        assert_eq!(observed, [10.0, 2.0, 3.0, 4.0]);
    }
}
