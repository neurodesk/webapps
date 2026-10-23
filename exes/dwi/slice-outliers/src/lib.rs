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
//! observed - predicted over the slice's brain voxels. Within one shell, the statistics of
//! each slice position are standardised robustly, with their median and 1.4826 · median
//! absolute deviation over the shell's volumes. A shell with fewer than 10 volumes keeps the
//! median per position and pools the deviation over positions. A slice is an outlier when its standardised value is below -`n_std`
//! (eddy's defaults: `--ol_nstd=4`, `--ol_nvox=250`, negative deviations only). A mean and
//! standard deviation would not do: in a session with much motion, the outliers inflate the
//! standard deviation and hide themselves (Dice 0.40 against eddy on an ADNI3 session, 0.82
//! with this standardisation).
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
    /// Standardise each slice position on its own (within the shell), not the whole shell
    /// together.
    pub per_slice_position: bool,
    /// A slice position with fewer usable volumes in the shell uses the whole shell.
    pub min_volumes_per_slice: usize,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            n_std: 4.0,
            min_voxels: 250,
            positive: false,
            squared: false,
            per_slice_position: true,
            min_volumes_per_slice: 10,
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
// The slice position indexes the statistics and all three output maps.
#[allow(clippy::needless_range_loop)]
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
        // The statistics of the shell's volumes at the given slices.
        let values = |f: fn(&SliceStatistic) -> f64, positions: &[usize]| -> Vec<f64> {
            members
                .iter()
                .flat_map(|&v| {
                    positions
                        .iter()
                        .filter(move |&&s| used(v, s))
                        .map(move |&s| f(&statistics[v][s]))
                })
                .collect()
        };
        let all: Vec<usize> = (0..slices).collect();
        let shell_m = median_mad(&values(|x| x.mean, &all));
        let shell_q = median_mad(&values(|x| x.mean_square, &all));
        // A shell with too few volumes for a spread per slice position still gets a centre
        // per position (a median of a few values is sound; the prediction error of a slice
        // position near the skull base is systematic), with the spread pooled over positions.
        let centre_at = |f: fn(&SliceStatistic) -> f64, s: usize, fallback: f64| -> f64 {
            let at = values(f, &[s]);
            if params.per_slice_position && at.len() >= 3 {
                median_mad(&at).0
            } else {
                fallback
            }
        };
        let pooled = |f: fn(&SliceStatistic) -> f64, fallback: f64| -> f64 {
            let centred: Vec<f64> = (0..slices)
                .flat_map(|s| {
                    let c = centre_at(f, s, fallback);
                    values(f, &[s]).into_iter().map(move |x| x - c)
                })
                .collect();
            median_mad(&centred).1
        };
        let pooled_m = pooled(|x| x.mean, shell_m.0);
        let pooled_q = pooled(|x| x.mean_square, shell_q.0);
        for s in 0..slices {
            let at = values(|x| x.mean, &[s]);
            let (centre_m, spread_m, centre_q, spread_q) =
                if params.per_slice_position && at.len() >= params.min_volumes_per_slice {
                    let (cm, sm) = median_mad(&at);
                    let (cq, sq) = median_mad(&values(|x| x.mean_square, &[s]));
                    (cm, sm, cq, sq)
                } else {
                    (
                        centre_at(|x| x.mean, s, shell_m.0),
                        pooled_m,
                        centre_at(|x| x.mean_square, s, shell_q.0),
                        pooled_q,
                    )
                };
            for &v in &members {
                if !used(v, s) {
                    continue;
                }
                let z = (statistics[v][s].mean - centre_m) / spread_m;
                let zq = (statistics[v][s].mean_square - centre_q) / spread_q;
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

/// Median and 1.4826 · median absolute deviation, the standard deviation of a normal
/// distribution that the outliers do not inflate. A zero spread is reported as NaN so
/// nothing is flagged.
fn median_mad(values: &[f64]) -> (f64, f64) {
    if values.len() < 2 {
        return (f64::NAN, f64::NAN);
    }
    let median = |v: &mut Vec<f64>| -> f64 {
        v.sort_by(f64::total_cmp);
        let n = v.len();
        if n % 2 == 1 {
            v[n / 2]
        } else {
            0.5 * (v[n / 2 - 1] + v[n / 2])
        }
    };
    let centre = median(&mut values.to_vec());
    let spread = 1.4826 * median(&mut values.iter().map(|x| (x - centre).abs()).collect());
    (centre, if spread > 0.0 { spread } else { f64::NAN })
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
