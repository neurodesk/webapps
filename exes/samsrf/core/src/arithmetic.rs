//! Explicit arithmetic references. The choice belongs to an analysis, never its CPU.

use crate::{Error, Result};
use crate::precision::Precision;
use num_complex::Complex64;
use serde::Serialize;

pub mod intel;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArithmeticReference {
    /// The production arithmetic before the optional MATLAB references were added.
    #[default]
    Current,
    MatlabAmd,
    MatlabIntel,
}

impl ArithmeticReference {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "current" => Ok(Self::Current),
            "matlab-amd" => Ok(Self::MatlabAmd),
            "matlab-intel" => Ok(Self::MatlabIntel),
            _ => Err(Error::Model("Arithmetic_Reference must be 'current', 'matlab-amd' or 'matlab-intel'".into())),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::MatlabAmd => "matlab-amd",
            Self::MatlabIntel => "matlab-intel",
        }
    }

    pub fn validate(self, _precision: Precision) -> Result<()> {
        Ok(())
    }

    pub fn ddot(self, x: &[f64], y: &[f64]) -> f64 {
        match self {
            Self::MatlabIntel => intel::blas::ddot(x, y),
            _ => crate::matlab_math::ddot(x, y),
        }
    }

    pub fn sdot(self, x: &[f32], y: &[f32]) -> f32 {
        match self {
            Self::MatlabIntel => intel::single::sdot(x, y),
            _ => crate::precision::dot_single(x, y),
        }
    }

    pub fn norm(self, x: &[f64]) -> f64 {
        match self {
            Self::MatlabIntel => intel::nrm2(x),
            _ => crate::matlab_math::nrm2(x.iter().copied()),
        }
    }

    pub fn zdotc_real(self, x: &[Complex64], y: &[f64]) -> Complex64 {
        match self {
            Self::MatlabIntel => intel::complex::zdotc_real(x, y),
            _ => crate::matlab_math::zdotc_real(x, y),
        }
    }

    pub fn gemv(self, y: &[f64], columns: &[&[f64]]) -> Vec<f64> {
        match self {
            Self::MatlabIntel => intel::blas::gemv_t(y, columns),
            _ => crate::lstsq::gemv_t_double(y, columns),
        }
    }

    pub fn gemv_single(self, y: &[f32], columns: &[&[f32]]) -> Vec<f32> {
        match self {
            Self::MatlabIntel => intel::single::gemv_t(y, columns),
            _ => crate::precision::gemv_t_single(y, columns),
        }
    }
}
