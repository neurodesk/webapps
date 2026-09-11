#![deny(unsafe_code)]

mod affine;
mod gaussian;
mod grid;
mod nifti;
mod nmi;
mod par;
mod pyramid;
mod reslice;
mod svf;

pub use affine::{
    AffineMetric, AffineOptions, image_centers, matrix as affine_matrix, nmi_score_gradient_affine,
    optimize as optimize_affine, parameters as affine_parameters, register as register_affine,
    score as score_affine, ssd_score_gradient,
};
pub use gaussian::smooth as gaussian_smooth;
pub use grid::{Grid, Mat4};
pub use nifti::{
    NiftiImage, ScalarType, VectorField, decode_image, decode_vector_field, encode_image,
    encode_vector_field,
};
pub use nmi::{BINS, bin_image};
pub use par::set_threads;
pub use pyramid::{FACTORS as PYRAMID_FACTORS, build as build_pyramid, downsample_grid, resample};
pub use reslice::{
    Interpolation, Transform, grids_match, read_matrix, reslice, reslice_with_interpolation,
};
pub use svf::register_nmi_svf;

use std::{error::Error as StdError, fmt};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl StdError for Error {}

pub type Result<T> = std::result::Result<T, Error>;
