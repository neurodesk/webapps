// SPDX-License-Identifier: Apache-2.0
//! Susceptibility fields along the phase-encoding axis, for SHORELine head motion correction
//! with a topup field (#479):
//!
//! - `topup`: the field (Hz) of a topup coefficient file, on the image grid topup ran on.
//! - `displacement`: the displacement that field causes, as an ITK (LPS, mm) field
//!   (QSIPrep 26.1.1 `TopupFieldToWarp`).
//! - `jacobian`: the phase-encoding Jacobian and the intensity weights
//!   (QSIPrep 26.1.1 `jacobian_determinant`).
//!
//! Volumes are flat arrays in NIfTI voxel order (x fastest), as `readNiftiFrames` returns them.
//! The crate reads no files.

pub mod displacement;
pub mod jacobian;
pub mod topup;

pub use displacement::{PhaseEncoding, displacement_lps};
pub use jacobian::{jacobian_pe, modulation_weights};
pub use topup::{INTENT_TOPUP_CUBIC_SPLINE, TopupCoefficients};

/// A NIfTI voxel-to-world (RAS, mm) affine, row major.
pub type Affine = [[f64; 4]; 4];

/// Whether FSL counts the x voxel axis of an image with this affine from the other end. FSL
/// works in radiological voxel order: it reverses x for an affine with a positive
/// determinant. topup's coefficient grid and datain vectors use FSL's axes.
pub fn fsl_flips_x(affine: &Affine) -> bool {
    let a = affine;
    let det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
        + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    det > 0.0
}

/// The field of a topup run, its displacement and its Jacobian, on the grid topup ran on.
#[derive(Clone, Debug)]
pub struct TopupField {
    /// Hz, per voxel.
    pub hz: Vec<f64>,
    /// ITK displacement (LPS, mm; output point to input point), per voxel.
    pub displacement: Vec<[f64; 3]>,
    /// The voxel axis the field displaces along.
    pub pe_axis: usize,
    /// The signed phase-encoding Jacobian, per voxel.
    pub jacobian: Vec<f64>,
}

impl TopupField {
    /// `dims` and `affine` describe the image grid topup ran on (its first input volume),
    /// `datain` the first line of topup's acquisition parameters.
    pub fn new(
        coefficients: &TopupCoefficients,
        dims: [usize; 3],
        affine: &Affine,
        datain: &PhaseEncoding,
    ) -> Result<Self, String> {
        let hz = coefficients.evaluate(dims, fsl_flips_x(affine))?;
        let displacement = displacement_lps(&hz, affine, datain);
        let pe_axis = datain.voxel_axis(affine);
        let jacobian = jacobian_pe(&displacement, dims, affine, pe_axis);
        Ok(Self {
            hz,
            displacement,
            pe_axis,
            jacobian,
        })
    }
}
