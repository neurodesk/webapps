// SPDX-License-Identifier: BSD-3-Clause
//! The displacement that a topup field causes, as QSIPrep 26.1.1's `TopupFieldToWarp`
//! (`qsiprep/interfaces/fmap.py`) computes it, plus FSL's x-axis convention so that images
//! with either affine handedness work.

use crate::Affine;

/// The phase encoding of the image topup's field belongs to: the direction of the first
/// `datain` row (in FSL's voxel axes) and its total readout time in seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PhaseEncoding {
    pub vector: [f64; 3],
    pub readout_time: f64,
}

impl PhaseEncoding {
    /// One `datain` (acquisition parameters) line, "x y z readout_time", for example
    /// "0 1 0 0.0632". topup's field belongs to the image of the first line.
    pub fn from_datain(line: &str) -> Result<Self, String> {
        let values: Vec<f64> = line
            .split_whitespace()
            .map(|v| {
                v.parse::<f64>()
                    .map_err(|_| format!("'{v}' in the datain line '{line}' is not a number."))
            })
            .collect::<Result<_, _>>()?;
        if values.len() != 4 {
            return Err(format!(
                "The datain line '{line}' does not have four values."
            ));
        }
        let vector = [values[0], values[1], values[2]];
        let nonzero = vector.iter().filter(|v| **v != 0.0).count();
        if nonzero != 1 || vector.iter().any(|v| v.abs() != 1.0 && *v != 0.0) {
            return Err(format!(
                "The datain line '{line}' is not along one voxel axis."
            ));
        }
        Self::checked(vector, values[3])
    }

    /// From BIDS `PhaseEncodingDirection` ("i", "j-", ...) and `TotalReadoutTime`. BIDS axes
    /// are the voxel axes of the file, so on an image that FSL flips (see `fsl_flips_x`)
    /// "i" is datain "-1 0 0".
    pub fn from_bids(
        direction: &str,
        total_readout_time: f64,
        affine: &Affine,
    ) -> Result<Self, String> {
        let axis = match direction.chars().next() {
            Some('i') => 0,
            Some('j') => 1,
            Some('k') => 2,
            _ => {
                return Err(format!(
                    "PhaseEncodingDirection '{direction}' is not i, j or k with an optional '-'."
                ));
            }
        };
        let sign = match &direction[1..] {
            "" => 1.0,
            "-" => -1.0,
            _ => {
                return Err(format!(
                    "PhaseEncodingDirection '{direction}' is not i, j or k with an optional '-'."
                ));
            }
        };
        let mut vector = [0.0; 3];
        vector[axis] = if axis == 0 && crate::fsl_flips_x(affine) {
            -sign
        } else {
            sign
        };
        Self::checked(vector, total_readout_time)
    }

    fn checked(vector: [f64; 3], readout_time: f64) -> Result<Self, String> {
        if !(readout_time.is_finite() && readout_time > 0.0) {
            return Err(format!(
                "The total readout time {readout_time} s is not positive."
            ));
        }
        Ok(Self {
            vector,
            readout_time,
        })
    }

    /// The world (RAS, mm) step of one voxel along the phase-encoding direction on the grid
    /// with `affine`: QSIPrep's `affine[:3, :3] @ row[:3]`, with the datain vector first moved
    /// from FSL's voxel axes to the file's.
    pub fn step_ras(&self, affine: &Affine) -> [f64; 3] {
        let mut v = self.vector;
        if crate::fsl_flips_x(affine) {
            v[0] = -v[0];
        }
        let mut step = [0.0; 3];
        for (r, s) in step.iter_mut().enumerate() {
            *s = affine[r][0] * v[0] + affine[r][1] * v[1] + affine[r][2] * v[2];
        }
        step
    }

    /// The voxel axis of the grid that the field displaces along (`pe_axis` of
    /// `TopupFieldToWarp`): the axis whose direction is closest to the step.
    pub fn voxel_axis(&self, affine: &Affine) -> usize {
        let step = self.step_ras(affine);
        let closeness = |a: usize| {
            let column = [affine[0][a], affine[1][a], affine[2][a]];
            let norm = column.iter().map(|c| c * c).sum::<f64>().sqrt();
            column
                .iter()
                .zip(&step)
                .map(|(c, s)| c / norm * s)
                .sum::<f64>()
                .abs()
        };
        // The first axis wins a tie, as numpy's argmax.
        (1..3).fold(0, |best, a| {
            if closeness(a) > closeness(best) {
                a
            } else {
                best
            }
        })
    }
}

/// The ITK displacement field (LPS, mm; output point to input point) that unwarps an image
/// with field `hz` (Hz, one value per voxel of the grid with `affine`):
/// `hz · readout_time · step`, the step taken to LPS. A voxel moves `hz · readout_time`
/// voxels along the phase-encoding direction.
pub fn displacement_lps(hz: &[f64], affine: &Affine, pe: &PhaseEncoding) -> Vec<[f64; 3]> {
    let s = pe.step_ras(affine);
    let step_lps = [-s[0], -s[1], s[2]];
    hz.iter()
        .map(|&f| {
            let d = f * pe.readout_time;
            [d * step_lps[0], d * step_lps[1], d * step_lps[2]]
        })
        .collect()
}
