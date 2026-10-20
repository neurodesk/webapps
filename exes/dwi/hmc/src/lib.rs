// SPDX-License-Identifier: Apache-2.0
//! Head-motion correction for diffusion series.
//!
//! [`clip`] is NiFreeze's intensity clip before registration, ported with its in-place quirk.
//!
//! [`gp_model`] is NiFreeze's GP DWI model: the leave-one-out fit and prediction of each
//! diffusion-weighted volume, with its data mask, on the `dwi-gp` crate.
//!
//! The first part is [`ItkAffine`]: the ITK MATLAB transform file that `antsRegistration` writes
//! (`*0GenericAffine.mat`). This is original code written from the file format, not a port. The
//! layout was read from ITK 5.4's `itkMatlabTransformIO.cxx` and VNL's `vnl_matlab_write.cxx`, and
//! checked against files that ANTs wrote (`tests/fixtures`).
//!
//! The file is two MATLAB v4 column vectors with no padding between them:
//!
//! | Variable | Rows | Contents |
//! | --- | --- | --- |
//! | `AffineTransform_double_3_3` or `AffineTransform_float_3_3` | 12 | the 3×3 matrix row by row, then the translation |
//! | `fixed` | 3 | the centre of rotation, in the precision of the parameters |
//!
//! Each variable is a 20-byte header of five `i32` (type, rows, cols, imag, name length with its
//! NUL), the NUL-terminated name and the values. The type is 0 (little-endian double) or 10
//! (little-endian single); ANTs writes in the machine's byte order, so big-endian files (1000,
//! 1010) are read as well. Every coordinate is LPS, as in ITK.

pub mod bvec;
pub mod clip;
pub mod gp_model;
pub mod motion;

pub use bvec::{BvecRule, HmcGradients, rotate_gradients};

use std::fmt;

/// Parameter precision of an ITK affine transform file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Precision {
    /// `AffineTransform_float_3_3`: `antsRegistration --float 1`, which the WebAssembly build runs.
    Float,
    /// `AffineTransform_double_3_3`: `antsRegistration --float 0`.
    Double,
}

impl Precision {
    fn transform_name(self) -> &'static str {
        match self {
            Precision::Float => "AffineTransform_float_3_3",
            Precision::Double => "AffineTransform_double_3_3",
        }
    }

    fn round(self, value: f64) -> f64 {
        match self {
            Precision::Float => value as f32 as f64,
            Precision::Double => value,
        }
    }
}

/// Why a `.mat` file could not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MatError {
    /// The file ends inside a header, name or value block.
    Truncated,
    /// The type code is not a real, column-wise IEEE double or single matrix.
    UnsupportedType(i32),
    /// A variable has the wrong shape, or is complex.
    Shape { name: String, rows: i32, cols: i32 },
    /// The name is not NUL-terminated ASCII.
    BadName,
    /// The first variable is not a 3-D affine transform.
    UnsupportedTransform(String),
    /// The second variable is not `fixed`.
    MissingFixed(String),
    /// The fixed parameters are stored in a different precision from the parameters.
    MixedPrecision,
    /// Bytes follow the fixed parameters: a second transform, which ANTs's affine files never hold.
    TrailingData(usize),
}

impl fmt::Display for MatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MatError::Truncated => write!(f, "the .mat file is truncated"),
            MatError::UnsupportedType(t) => write!(f, "unsupported MATLAB v4 type {t}"),
            MatError::Shape { name, rows, cols } => {
                write!(
                    f,
                    "variable {name} is {rows}x{cols}, not a real column vector"
                )
            }
            MatError::BadName => write!(f, "a variable name is not NUL-terminated ASCII"),
            MatError::UnsupportedTransform(n) => write!(f, "unsupported transform {n}"),
            MatError::MissingFixed(n) => write!(f, "expected the variable fixed, found {n}"),
            MatError::MixedPrecision => {
                write!(f, "parameters and fixed parameters differ in precision")
            }
            MatError::TrailingData(n) => write!(f, "{n} bytes follow the transform"),
        }
    }
}

impl std::error::Error for MatError {}

/// An ITK `AffineTransform<_, 3>` as ANTs writes it.
///
/// The transform maps a point x of the fixed image to the moving image:
/// `A·(x − c) + t + c`, with `A` the 3×3 matrix, `t` the translation and `c` the fixed centre.
#[derive(Clone, Debug, PartialEq)]
pub struct ItkAffine {
    pub precision: Precision,
    /// The 3×3 matrix row by row, then the translation. Float values are held exactly as f64.
    pub parameters: [f64; 12],
    /// The centre of rotation (ITK's fixed parameters), LPS millimetres.
    pub fixed: [f64; 3],
}

/// A 4×4 homogeneous matrix, row-major.
pub type Matrix4 = [[f64; 4]; 4];

struct Variable {
    name: String,
    single: bool,
    values: Vec<f64>,
}

/// The next `len` bytes, or `Truncated`; `len` comes from the file, so no arithmetic may wrap.
fn take<'a>(bytes: &'a [u8], at: &mut usize, len: usize) -> Result<&'a [u8], MatError> {
    let end = at.checked_add(len).ok_or(MatError::Truncated)?;
    let out = bytes.get(*at..end).ok_or(MatError::Truncated)?;
    *at = end;
    Ok(out)
}

fn read_variable(bytes: &[u8], at: &mut usize) -> Result<Variable, MatError> {
    let header = take(bytes, at, 20)?;
    let field = |i: usize, big: bool| {
        let b: [u8; 4] = header[4 * i..4 * i + 4].try_into().unwrap();
        if big {
            i32::from_be_bytes(b)
        } else {
            i32::from_le_bytes(b)
        }
    };
    // The type is small, so its byte order shows in which end holds it.
    let big = u32::from_le_bytes(header[0..4].try_into().unwrap()) > 0xffff;
    let kind = field(0, big);
    let (big_code, single) = match kind {
        0 => (false, false),
        10 => (false, true),
        1000 => (true, false),
        1010 => (true, true),
        other => return Err(MatError::UnsupportedType(other)),
    };
    if big_code != big {
        return Err(MatError::UnsupportedType(kind));
    }
    let (rows, cols, imag, namlen) = (field(1, big), field(2, big), field(3, big), field(4, big));
    if namlen < 1 {
        return Err(MatError::BadName);
    }
    let raw = take(bytes, at, namlen as usize)?;
    let (nul, text) = raw.split_last().unwrap();
    if *nul != 0 || !text.iter().all(|c| c.is_ascii_graphic()) {
        return Err(MatError::BadName);
    }
    let name = String::from_utf8(text.to_vec()).unwrap();
    if cols != 1 || imag != 0 || rows < 1 {
        return Err(MatError::Shape { name, rows, cols });
    }
    let size = if single { 4 } else { 8 };
    let len = (rows as usize)
        .checked_mul(size)
        .ok_or(MatError::Truncated)?;
    let data = take(bytes, at, len)?;
    let values = data
        .chunks_exact(size)
        .map(|c| match (single, big) {
            (true, false) => f32::from_le_bytes(c.try_into().unwrap()) as f64,
            (true, true) => f32::from_be_bytes(c.try_into().unwrap()) as f64,
            (false, false) => f64::from_le_bytes(c.try_into().unwrap()),
            (false, true) => f64::from_be_bytes(c.try_into().unwrap()),
        })
        .collect();
    Ok(Variable {
        name,
        single,
        values,
    })
}

fn write_variable(out: &mut Vec<u8>, name: &str, values: &[f64], precision: Precision) {
    let kind = match precision {
        Precision::Double => 0i32,
        Precision::Float => 10,
    };
    for field in [kind, values.len() as i32, 1, 0, name.len() as i32 + 1] {
        out.extend_from_slice(&field.to_le_bytes());
    }
    out.extend_from_slice(name.as_bytes());
    out.push(0);
    for &v in values {
        match precision {
            Precision::Double => out.extend_from_slice(&v.to_le_bytes()),
            Precision::Float => out.extend_from_slice(&(v as f32).to_le_bytes()),
        }
    }
}

const FLIP: [f64; 4] = [-1.0, -1.0, 1.0, 1.0];

/// Conjugates by diag(−1, −1, 1, 1): LPS to RAS and back.
fn flip_xy(m: &Matrix4) -> Matrix4 {
    let mut out = [[0.0, 0.0, 0.0, 0.0], [0.0; 4], [0.0; 4], m[3]];
    for i in 0..3 {
        for j in 0..4 {
            out[i][j] = FLIP[i] * m[i][j] * FLIP[j];
        }
    }
    out
}

impl ItkAffine {
    /// Reads the bytes of a `.mat` file holding one affine transform.
    pub fn from_mat(bytes: &[u8]) -> Result<Self, MatError> {
        let mut at = 0;
        let params = read_variable(bytes, &mut at)?;
        let precision = match params.name.as_str() {
            "AffineTransform_double_3_3" => Precision::Double,
            "AffineTransform_float_3_3" => Precision::Float,
            _ => return Err(MatError::UnsupportedTransform(params.name)),
        };
        if params.values.len() != 12 {
            return Err(MatError::Shape {
                name: params.name,
                rows: params.values.len() as i32,
                cols: 1,
            });
        }
        let fixed = read_variable(bytes, &mut at)?;
        if fixed.name != "fixed" {
            return Err(MatError::MissingFixed(fixed.name));
        }
        if fixed.values.len() != 3 {
            return Err(MatError::Shape {
                name: fixed.name,
                rows: fixed.values.len() as i32,
                cols: 1,
            });
        }
        if fixed.single != params.single || params.single != (precision == Precision::Float) {
            return Err(MatError::MixedPrecision);
        }
        if at != bytes.len() {
            return Err(MatError::TrailingData(bytes.len() - at));
        }
        Ok(ItkAffine {
            precision,
            parameters: params.values.try_into().unwrap(),
            fixed: fixed.values.try_into().unwrap(),
        })
    }

    /// The bytes ANTs writes for this transform: little-endian, in its precision.
    pub fn to_mat(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(193);
        write_variable(
            &mut out,
            self.precision.transform_name(),
            &self.parameters,
            self.precision,
        );
        write_variable(&mut out, "fixed", &self.fixed, self.precision);
        out
    }

    /// Reads a `.mat` file.
    pub fn read(path: impl AsRef<std::path::Path>) -> std::io::Result<Self> {
        let bytes = std::fs::read(path)?;
        Self::from_mat(&bytes).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    /// Writes a `.mat` file.
    pub fn write(&self, path: impl AsRef<std::path::Path>) -> std::io::Result<()> {
        std::fs::write(path, self.to_mat())
    }

    /// The 4×4 LPS matrix from a fixed point to its moving point, with ITK's offset
    /// `t + c − A·c`.
    pub fn lps(&self) -> Matrix4 {
        let p = &self.parameters;
        let c = &self.fixed;
        let mut m = [
            [0.0, 0.0, 0.0, 0.0],
            [0.0; 4],
            [0.0; 4],
            [0.0, 0.0, 0.0, 1.0],
        ];
        for i in 0..3 {
            let mut offset = p[9 + i] + c[i];
            for j in 0..3 {
                m[i][j] = p[3 * i + j];
                offset -= p[3 * i + j] * c[j];
            }
            m[i][3] = offset;
        }
        m
    }

    /// The same transform in RAS: diag(−1, −1, 1, 1) · LPS · diag(−1, −1, 1, 1).
    pub fn ras(&self) -> Matrix4 {
        flip_xy(&self.lps())
    }

    /// The transform with LPS matrix `m` about the LPS centre `centre`, with ITK's translation
    /// `offset − c + A·c`. Float precision rounds the parameters and centre to f32 as ANTs stores them.
    /// The bottom row of `m` is taken to be (0, 0, 0, 1).
    pub fn from_lps(m: &Matrix4, centre: [f64; 3], precision: Precision) -> Self {
        let c = centre.map(|v| precision.round(v));
        let mut parameters = [0.0; 12];
        for i in 0..3 {
            let mut translation = m[i][3] - c[i];
            for j in 0..3 {
                parameters[3 * i + j] = m[i][j];
                translation += m[i][j] * c[j];
            }
            parameters[9 + i] = translation;
        }
        ItkAffine {
            precision,
            parameters: parameters.map(|v| precision.round(v)),
            fixed: c,
        }
    }

    /// [`ItkAffine::from_lps`] for a RAS matrix and a RAS centre.
    pub fn from_ras(m: &Matrix4, centre: [f64; 3], precision: Precision) -> Self {
        let lps_centre = [-centre[0], -centre[1], centre[2]];
        Self::from_lps(&flip_xy(m), lps_centre, precision)
    }
}
