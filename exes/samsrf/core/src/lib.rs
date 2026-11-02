//! A Rust port of SamSrf (Samuel Schwarzkopf, BSD-3-Clause, commit 41ed1e96):
//! population receptive field (pRF) and connective field (CF) mapping.
//!
//! Phase 1 (this crate's current state): file readers and writers, apertures,
//! model specifications, the pRF profile functions and the MATLAB expression
//! language that model JSON files use to call them, HRFs, and time-series
//! preprocessing. Phase 2 adds the three analyses (`samsrf_fit_prf`,
//! `samsrf_revcor_prf`, `samsrf_revcor_cf`).
//!
//! Every computation is in f64. SamSrf converts its data to single precision
//! (`samsrf_32bit_srf`); see packages/samsrf/README.md for the divergence list.

pub mod apertures;
pub mod error;
pub mod export;
pub mod expr;
pub mod freesurfer;
pub mod gif_aps;
pub mod gifti;
pub mod hrf;
pub mod mapset;
pub mod mat;
pub mod model;
pub mod nifti_aps;
pub mod preprocess;
pub mod prf;
pub mod surface;
pub mod timeseries;

pub use error::{Error, Result};
