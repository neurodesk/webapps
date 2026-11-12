//! A Rust port of SamSrf (Samuel Schwarzkopf, BSD-3-Clause, commit 41ed1e96):
//! population receptive field (pRF) and connective field (CF) mapping.
//!
//! File readers and writers, apertures, model specifications, the pRF profile
//! functions and the MATLAB expression language that model JSON files use to call
//! them, HRFs, time-series preprocessing, and the three analyses (`samsrf_fit_prf`
//! in `fit_prf`, `samsrf_revcor_prf` in `revcor_prf`, `samsrf_revcor_cf` in
//! `revcor_cf`) behind one `job::Job` that runs vertex ranges independently.
//!
//! Double arithmetic is the default. Forward fits also support SamSrf's mixed
//! arithmetic with single observations; see `precision` and the package README.

pub mod apertures;
pub mod css;
pub mod error;
pub mod export;
pub mod expr;
pub mod fit_prf;
pub mod freesurfer;
pub mod geometry;
mod polyshape;
pub mod gif_aps;
pub mod gifti;
pub mod hrf;
pub mod job;
pub mod lstsq;
pub mod mapset;
pub mod mat;
pub mod matlab_math;
pub mod mesh;
pub mod model;
pub mod nifti_aps;
pub mod optim;
pub mod precision;
pub mod preprocess;
pub mod prf;
pub mod revcor_cf;
pub mod revcor_prf;
pub mod searchspace;
pub mod surface;
pub mod template;
pub mod timeseries;

pub use error::{Error, Result};
