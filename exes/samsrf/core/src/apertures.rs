//! Stimulus apertures: the movie of what was on screen at each volume.
//!
//! SamSrf stores apertures as `ApFrm` (height x width x volumes, values usually 0 or 1)
//! and vectorises them (`VectoriseApertures.m`) into `ApFrm` (pixels x volumes) and `ApXY`
//! (pixels x 2) with pixels in MATLAB column-major order over (row, column): pixel `p`
//! is row `p % height`, column `p / height`. Rows run top to bottom, so the Y coordinate
//! of row `r` is positive at the top (`fliplr` in VectoriseApertures). Coordinates are
//! `[-1, 1]` on the longer side and shrunk on the shorter side of a rectangular aperture;
//! the analyses rescale them by `Scaling_Factor` (`scaled_xy`).

use crate::error::{Error, Result};

/// One volume's aperture, stored sparse: only the pixels that are not exactly zero.
/// `indices` ascend; `values` are the pixel values (1 for a binary aperture).
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub indices: Vec<u32>,
    pub values: Vec<f64>,
}

/// A vectorised aperture set in SamSrf's pixel order.
#[derive(Debug, Clone, PartialEq)]
pub struct Apertures {
    /// Columns of the aperture image (`ApDimX`). Must be even.
    pub width: usize,
    /// Rows of the aperture image (`ApDimY`). Must be even.
    pub height: usize,
    /// One frame per volume.
    pub frames: Vec<Frame>,
    /// `ApXY` before any `Scaling_Factor`: pixel coordinates in stimulus space, `width * height`
    /// entries in column-major pixel order.
    pub xy: Vec<[f64; 2]>,
    /// `ApCond`: one condition label per volume for a multi-condition design.
    pub conditions: Option<Vec<f64>>,
}

impl Apertures {
    /// Builds apertures from a dense column-major `height x width x volumes` array, as `load`
    /// of an `aps_*.mat` file gives `ApFrm`. Mirrors `VectoriseApertures.m`: rejects odd side
    /// lengths, computes `ApXY` with the rectangular scaling, keeps `ApCond` as conditions.
    pub fn from_dense(height: usize, width: usize, volumes: usize, data: &[f64], conditions: Option<Vec<f64>>) -> Result<Self> {
        let _ = (height, width, volumes, data, conditions);
        Err(Error::NotImplemented("Apertures::from_dense"))
    }

    /// Builds apertures that are already vectorised (`ApFrm` pixels x volumes, `ApXY` pixels x 2,
    /// both column-major as loaded from an `aps_*_vec.mat` file). The first row of `ApFrm`
    /// holds the condition labels when the file was a multi-condition design, which this
    /// detects by `ap_frm` having one more row than `ap_xy`.
    pub fn from_vectorised(ap_frm_rows: usize, volumes: usize, ap_frm: &[f64], ap_xy: &[f64]) -> Result<Self> {
        let _ = (ap_frm_rows, volumes, ap_frm, ap_xy);
        Err(Error::NotImplemented("Apertures::from_vectorised"))
    }

    pub fn volumes(&self) -> usize {
        self.frames.len()
    }

    pub fn pixels(&self) -> usize {
        self.width * self.height
    }

    /// `ApXY / max(abs(ApXY(:))) * scaling_factor`, as `samsrf_fit_prf` and `samsrf_revcor_prf` do.
    pub fn scaled_xy(&self, scaling_factor: f64) -> Vec<[f64; 2]> {
        let _ = scaling_factor;
        Vec::new()
    }

    /// The dense `ApFrm` (pixels x volumes, column-major) for parity checks and exports.
    pub fn to_dense(&self) -> Vec<f64> {
        Vec::new()
    }

    /// Whether any pixel value is negative (SamSrf prints a warning).
    pub fn has_negative_values(&self) -> bool {
        self.frames.iter().any(|frame| frame.values.iter().any(|value| *value < 0.0))
    }
}
