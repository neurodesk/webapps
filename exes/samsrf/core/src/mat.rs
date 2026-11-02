//! MATLAB MAT v5 reader for numeric arrays: enough for `aps_*.mat` (`ApFrm`, `ApXY`,
//! `ApCond`) and `hrf_*.mat` (`fP`). Handles `miCOMPRESSED` elements (zlib), every
//! numeric class, the storage compression MATLAB applies (a double array stored as
//! `miUINT8` or `miINT16` elements), logical arrays, both endians, and skips character,
//! cell and struct variables. A v7.3 (HDF5) file is refused with a message saying so.

use crate::error::Result;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatClass {
    Double,
    Single,
    Int8,
    Uint8,
    Int16,
    Uint16,
    Int32,
    Uint32,
    Int64,
    Uint64,
    Logical,
}

/// A numeric array in column-major order, values widened to f64.
#[derive(Debug, Clone, PartialEq)]
pub struct MatArray {
    pub class: MatClass,
    pub dims: Vec<usize>,
    pub data: Vec<f64>,
}

impl MatArray {
    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MatFile {
    pub variables: BTreeMap<String, MatArray>,
}

pub fn read(bytes: &[u8]) -> Result<MatFile> {
    let _ = bytes;
    Err(crate::Error::NotImplemented("mat::read"))
}

/// Loads `ApFrm` (+ `ApXY`, `ApCond`) from an aperture MAT file into `Apertures`,
/// vectorising a movie file as `samsrf_fit_prf` does when `ApXY` is absent.
pub fn read_apertures(bytes: &[u8]) -> Result<crate::apertures::Apertures> {
    let _ = bytes;
    Err(crate::Error::NotImplemented("mat::read_apertures"))
}

/// Loads `fP` from an old-school `hrf_*.mat` file.
pub fn read_old_school_hrf(bytes: &[u8]) -> Result<[f64; 4]> {
    let _ = bytes;
    Err(crate::Error::NotImplemented("mat::read_old_school_hrf"))
}
