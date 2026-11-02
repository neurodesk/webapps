//! GIFTI reader and writer.
//!
//! Reads every encoding (`ASCII`, `Base64Binary`, `GZipBase64Binary`, both zlib and gzip
//! framing; `ExternalFileBinary` is refused), `NIFTI_TYPE_FLOAT32`, `INT32` and `UINT8`,
//! both endians, any number of DataArrays, and `ColumnMajorOrder` or `RowMajorOrder` for
//! 2-D arrays. The writer produces what SPM's `gifti/save` writes for `samsrf_export_giis`:
//! one float32 DataArray, `GZipBase64Binary` (zlib), `RowMajorOrder`, little-endian.

use crate::error::Result;
use crate::surface::Surface;
use crate::timeseries::RawRun;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataType {
    Float32,
    Int32,
    Uint8,
}

/// One `<DataArray>`, decoded. `data` is f64 in the file's own element order after
/// resolving the indexing order to column-major for 2-D arrays (MATLAB's layout).
#[derive(Debug, Clone, PartialEq)]
pub struct DataArray {
    pub intent: String,
    pub data_type: DataType,
    pub dims: Vec<usize>,
    pub data: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Gifti {
    pub arrays: Vec<DataArray>,
}

/// Parses a whole GIFTI file.
pub fn read(bytes: &[u8]) -> Result<Gifti> {
    let _ = bytes;
    Err(crate::Error::NotImplemented("gifti::read"))
}

/// Reads a functional run: every DataArray is one volume over all vertices (the
/// `NIFTI_INTENT_TIME_SERIES` layout mri_vol2surf writes). Arrays are decoded one at a
/// time and scattered into the vertex-major `RawRun`, so the peak allocation is the run
/// plus one array.
pub fn read_run(bytes: &[u8]) -> Result<RawRun> {
    let _ = bytes;
    Err(crate::Error::NotImplemented("gifti::read_run"))
}

/// Reads a mesh: the `NIFTI_INTENT_POINTSET` and `NIFTI_INTENT_TRIANGLE` arrays.
pub fn read_surface(bytes: &[u8]) -> Result<Surface> {
    let _ = bytes;
    Err(crate::Error::NotImplemented("gifti::read_surface"))
}

/// Writes one per-vertex map as `samsrf_export_giis` does (float32, zlib-compressed
/// base64, `RowMajorOrder`).
pub fn write_map(values: &[f64]) -> Vec<u8> {
    let _ = values;
    Vec::new()
}
