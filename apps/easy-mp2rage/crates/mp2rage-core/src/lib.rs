//! mp2rage-core — pure-Rust port of the validated Python MP2RAGE/SA2RAGE
//! T1-mapping pipeline. Native-testable against golden files (see
//! `tests/parity.rs`) and reused verbatim by the WASM build.

pub mod b1fill;
pub mod correct;
pub mod denoise;
pub mod dicom;
pub mod filt;
pub mod interp;
pub mod mask;
pub mod model;
pub mod pipeline;
pub mod resample;

pub use model::{Mp2rageParams, Sa2rageParams};
pub use resample::Affine;
