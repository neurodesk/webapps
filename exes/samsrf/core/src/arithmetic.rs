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

    pub fn validate(self, precision: Precision) -> Result<()> {
        if self == Self::MatlabIntel && precision == Precision::Single {
            return Err(Error::Model("matlab-intel arithmetic requires Data_Precision 'double'; Intel single-precision kernels are not implemented".into()));
        }
        Ok(())
    }

    pub fn ddot(self, x: &[f64], y: &[f64]) -> f64 {
        match self {
            Self::MatlabIntel => intel::blas::ddot(x, y),
            _ => crate::matlab_math::ddot(x, y),
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
}
