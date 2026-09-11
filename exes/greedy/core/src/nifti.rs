#[cfg(feature = "gzip")]
use std::io::{Read, Write};

#[cfg(feature = "gzip")]
use flate2::{Compression, read::GzDecoder, write::GzEncoder};

use crate::{Error, Grid, Mat4, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScalarType {
    U8,
    I8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    F32,
    F64,
}

impl ScalarType {
    fn from_nifti(code: i16) -> Result<Self> {
        match code {
            2 => Ok(Self::U8),
            256 => Ok(Self::I8),
            4 => Ok(Self::I16),
            512 => Ok(Self::U16),
            8 => Ok(Self::I32),
            768 => Ok(Self::U32),
            1024 => Ok(Self::I64),
            1280 => Ok(Self::U64),
            16 => Ok(Self::F32),
            64 => Ok(Self::F64),
            _ => Err(Error(format!("unsupported NIfTI scalar datatype {code}"))),
        }
    }

    fn nifti(self) -> i16 {
        match self {
            Self::U8 => 2,
            Self::I8 => 256,
            Self::I16 => 4,
            Self::U16 => 512,
            Self::I32 => 8,
            Self::U32 => 768,
            Self::I64 => 1024,
            Self::U64 => 1280,
            Self::F32 => 16,
            Self::F64 => 64,
        }
    }

    fn bytes(self) -> usize {
        match self {
            Self::U8 | Self::I8 => 1,
            Self::I16 | Self::U16 => 2,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::I64 | Self::U64 | Self::F64 => 8,
        }
    }
}

#[derive(Clone, Debug)]
pub struct NiftiImage {
    pub grid: Grid,
    pub data: Vec<f32>,
    pub scalar_type: ScalarType,
}

#[derive(Clone, Debug)]
pub struct VectorField {
    pub grid: Grid,
    /// Interleaved x, y, z vectors in LPS millimetres for encoded warps; the
    /// SV registration keeps its internal velocity in fixed voxel units.
    pub data: Vec<[f32; 3]>,
}

#[derive(Clone)]
struct Header {
    little: bool,
    dims: [usize; 8],
    datatype: ScalarType,
    offset: usize,
    slope: f32,
    intercept: f32,
    grid: Grid,
}

fn voxel_count(dims: [usize; 3]) -> Result<usize> {
    dims.iter().try_fold(1_usize, |count, &dim| {
        count
            .checked_mul(dim)
            .ok_or_else(|| Error("NIfTI voxel count overflow".into()))
    })
}

fn unpack(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        #[cfg(feature = "gzip")]
        {
            let mut raw = Vec::new();
            GzDecoder::new(bytes)
                .read_to_end(&mut raw)
                .map_err(|e| Error(format!("gzip read: {e}")))?;
            Ok(raw)
        }
        #[cfg(not(feature = "gzip"))]
        {
            Err(Error("gzip NIfTI requires host-side decompression".into()))
        }
    } else {
        Ok(bytes.to_vec())
    }
}

fn i16_at(b: &[u8], offset: usize, le: bool) -> i16 {
    let raw = [b[offset], b[offset + 1]];
    if le {
        i16::from_le_bytes(raw)
    } else {
        i16::from_be_bytes(raw)
    }
}
fn i32_at(b: &[u8], offset: usize, le: bool) -> i32 {
    let raw = [b[offset], b[offset + 1], b[offset + 2], b[offset + 3]];
    if le {
        i32::from_le_bytes(raw)
    } else {
        i32::from_be_bytes(raw)
    }
}
fn f32_at(b: &[u8], offset: usize, le: bool) -> f32 {
    f32::from_bits(i32_at(b, offset, le) as u32)
}

fn parse_header(b: &[u8]) -> Result<Header> {
    if b.len() < 352 {
        return Err(Error("NIfTI-1 file is smaller than its header".into()));
    }
    let le = match (i32_at(b, 0, true), i32_at(b, 0, false)) {
        (348, _) => true,
        (_, 348) => false,
        _ => return Err(Error("expected a NIfTI-1 header (sizeof_hdr = 348)".into())),
    };
    let mut dims = [1usize; 8];
    let ndim = i16_at(b, 40, le);
    if !(3..=5).contains(&ndim) {
        return Err(Error(format!(
            "only 3-D NIfTI-1 images and 5-D vector fields are supported (got {ndim}-D)"
        )));
    }
    for (i, dim) in dims.iter_mut().enumerate().take(ndim as usize + 1) {
        let value = i16_at(b, 40 + i * 2, le);
        if value <= 0 {
            return Err(Error("NIfTI header has a non-positive dimension".into()));
        }
        *dim = value as usize;
    }
    let datatype = ScalarType::from_nifti(i16_at(b, 70, le))?;
    if i16_at(b, 72, le) as usize != datatype.bytes() * 8 {
        return Err(Error("NIfTI datatype/bitpix mismatch".into()));
    }
    let offset = f32_at(b, 108, le).max(352.0) as usize;
    let mut pixdim = [0.0; 8];
    for (i, value) in pixdim.iter_mut().enumerate() {
        *value = f32_at(b, 76 + i * 4, le);
    }
    let slope = match f32_at(b, 112, le) {
        x if x == 0.0 || !x.is_finite() => 1.0,
        x => x,
    };
    let intercept = match f32_at(b, 116, le) {
        x if x.is_finite() => x,
        _ => 0.0,
    };
    let qform_code = i16_at(b, 252, le);
    let sform_code = i16_at(b, 254, le);
    let spacing = [
        pixdim[1].abs() as f64,
        pixdim[2].abs() as f64,
        pixdim[3].abs() as f64,
    ];
    if spacing
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(Error(
            "NIfTI voxel spacing must be positive and finite".into(),
        ));
    }
    let qform = if qform_code > 0 {
        qform_matrix(b, le, pixdim)
    } else {
        // nifti1_io's qto_xyz when no qform is present.
        Mat4([
            [spacing[0], 0.0, 0.0, 0.0],
            [0.0, spacing[1], 0.0, 0.0],
            [0.0, 0.0, spacing[2], 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
    };
    let mut sform = [[0.0; 4]; 4];
    for (r, row) in sform.iter_mut().enumerate().take(3) {
        for (c, value) in row.iter_mut().enumerate() {
            *value = f32_at(b, 280 + (r * 4 + c) * 4, le) as f64;
        }
    }
    sform[3][3] = 1.0;
    let sform = Mat4(sform);
    let ras = if sform_code > 0 && itk_prefers_sform(sform, qform, sform_code, qform_code) {
        sform
    } else {
        qform
    };
    if ras.0.iter().flatten().any(|value| !value.is_finite()) {
        return Err(Error(
            "NIfTI spatial transform contains non-finite values".into(),
        ));
    }
    // ITK keeps only the direction cosines of the chosen matrix; spacing
    // always comes from pixdim. Real sforms carry scale rounding, so this is
    // observable at the 1e-6 level.
    let mut lps = ras.0;
    for c in 0..3 {
        let norm = (0..3).map(|r| lps[r][c] * lps[r][c]).sum::<f64>().sqrt();
        if norm == 0.0 {
            return Err(Error("NIfTI header has a zero direction column".into()));
        }
        for row in lps.iter_mut().take(3) {
            row[c] *= spacing[c] / norm;
        }
    }
    for value in &mut lps[0] {
        *value = -*value;
    }
    for value in &mut lps[1] {
        *value = -*value;
    }
    Ok(Header {
        little: le,
        dims,
        datatype,
        offset,
        slope,
        intercept,
        grid: Grid {
            dims: [dims[1], dims[2], dims[3]],
            lps_from_voxel: Mat4(lps),
        },
    })
}

/// ITK 5.3+ (`itkNiftiImageIO::SetImageIOOrientationFromNIfTI`): the sform
/// wins when it equals the qform, or when it is orthonormal and either the
/// qform is absent, the sform is scanner-anatomical, or both forms agree
/// within 1e-4. Otherwise the qform wins.
fn itk_prefers_sform(sform: Mat4, qform: Mat4, sform_code: i16, qform_code: i16) -> bool {
    let close = |a: f64, b: f64, tol: f64| (a - b).abs() <= tol;
    let linear_equal =
        |tol: f64| (0..3).all(|r| (0..3).all(|c| close(sform.0[r][c], qform.0[r][c], tol)));
    let offset_equal = |tol: f64| (0..3).all(|r| close(sform.0[r][3], qform.0[r][3], tol));
    let offset_l1 = (0..3)
        .map(|r| (sform.0[r][3] - qform.0[r][3]).abs())
        .sum::<f64>();
    if linear_equal(1e-5) && offset_l1 <= 1e-7 {
        return true;
    }
    let column_norms = |m: Mat4| -> [f64; 3] {
        std::array::from_fn(|c| (0..3).map(|r| m.0[r][c] * m.0[r][c]).sum::<f64>().sqrt())
    };
    let normalized = |m: Mat4| -> [[f64; 3]; 3] {
        let norms = column_norms(m);
        std::array::from_fn(|r| std::array::from_fn(|c| m.0[r][c] / norms[c]))
    };
    let s = normalized(sform);
    let orthonormal = (0..3).all(|i| {
        (0..3).all(|j| {
            let dot = (0..3).map(|k| s[i][k] * s[j][k]).sum::<f64>();
            close(dot, if i == j { 1.0 } else { 0.0 }, 1e-4)
        })
    });
    if !orthonormal {
        return false;
    }
    if qform_code == 0 || sform_code == 1 {
        return true;
    }
    // ponytail: ITK compares SVD factors here; for orthonormal-times-scale
    // matrices that is the same as comparing rotations, scales, and offsets.
    let q = normalized(qform);
    let (sn, qn) = (column_norms(sform), column_norms(qform));
    (0..3).all(|r| (0..3).all(|c| close(s[r][c], q[r][c], 1e-4)))
        && (0..3).all(|c| close(sn[c], qn[c], 1e-4))
        && offset_equal(1e-4)
}

fn qform_matrix(b: &[u8], le: bool, pixdim: [f32; 8]) -> Mat4 {
    let (mut bq, mut cq, mut dq) = (
        f32_at(b, 256, le) as f64,
        f32_at(b, 260, le) as f64,
        f32_at(b, 264, le) as f64,
    );
    let mut aq = 1.0 - bq * bq - cq * cq - dq * dq;
    if aq < 1e-7 {
        let scale = (bq * bq + cq * cq + dq * dq).sqrt();
        bq /= scale;
        cq /= scale;
        dq /= scale;
        aq = 0.0;
    } else {
        aq = aq.sqrt();
    }
    let dx = pixdim[1].abs() as f64;
    let dy = pixdim[2].abs() as f64;
    let dz = pixdim[3].abs() as f64 * if pixdim[0] < 0.0 { -1.0 } else { 1.0 };
    Mat4([
        [
            (aq * aq + bq * bq - cq * cq - dq * dq) * dx,
            2.0 * (bq * cq - aq * dq) * dy,
            2.0 * (bq * dq + aq * cq) * dz,
            f32_at(b, 268, le) as f64,
        ],
        [
            2.0 * (bq * cq + aq * dq) * dx,
            (aq * aq + cq * cq - bq * bq - dq * dq) * dy,
            2.0 * (cq * dq - aq * bq) * dz,
            f32_at(b, 272, le) as f64,
        ],
        [
            2.0 * (bq * dq - aq * cq) * dx,
            2.0 * (cq * dq + aq * bq) * dy,
            (aq * aq + dq * dq - cq * cq - bq * bq) * dz,
            f32_at(b, 276, le) as f64,
        ],
        [0.0, 0.0, 0.0, 1.0],
    ])
}

fn sample(raw: &[u8], offset: usize, kind: ScalarType, le: bool) -> f32 {
    match kind {
        ScalarType::U8 => raw[offset] as f32,
        ScalarType::I8 => raw[offset] as i8 as f32,
        ScalarType::I16 => i16_at(raw, offset, le) as f32,
        ScalarType::U16 => u16_at(raw, offset, le) as f32,
        ScalarType::I32 => i32_at(raw, offset, le) as f32,
        ScalarType::U32 => u32_at(raw, offset, le) as f32,
        ScalarType::I64 => i64_at(raw, offset, le) as f32,
        ScalarType::U64 => u64_at(raw, offset, le) as f32,
        ScalarType::F32 => f32_at(raw, offset, le),
        ScalarType::F64 => f64_at(raw, offset, le) as f32,
    }
}
fn u16_at(b: &[u8], o: usize, le: bool) -> u16 {
    let x = [b[o], b[o + 1]];
    if le {
        u16::from_le_bytes(x)
    } else {
        u16::from_be_bytes(x)
    }
}
fn u32_at(b: &[u8], o: usize, le: bool) -> u32 {
    let x = [b[o], b[o + 1], b[o + 2], b[o + 3]];
    if le {
        u32::from_le_bytes(x)
    } else {
        u32::from_be_bytes(x)
    }
}
fn i64_at(b: &[u8], o: usize, le: bool) -> i64 {
    let x = b[o..o + 8].try_into().unwrap();
    if le {
        i64::from_le_bytes(x)
    } else {
        i64::from_be_bytes(x)
    }
}
fn u64_at(b: &[u8], o: usize, le: bool) -> u64 {
    let x = b[o..o + 8].try_into().unwrap();
    if le {
        u64::from_le_bytes(x)
    } else {
        u64::from_be_bytes(x)
    }
}
fn f64_at(b: &[u8], o: usize, le: bool) -> f64 {
    f64::from_bits(u64_at(b, o, le))
}

pub fn decode_image(bytes: &[u8]) -> Result<NiftiImage> {
    let raw = unpack(bytes)?;
    let h = parse_header(&raw)?;
    if h.dims[0] != 3 && h.dims[4..].iter().any(|&d| d != 1) {
        return Err(Error("expected a scalar 3-D NIfTI image".into()));
    }
    let count = voxel_count(h.grid.dims)?;
    let bytes = count
        .checked_mul(h.datatype.bytes())
        .ok_or_else(|| Error("NIfTI data size overflow".into()))?;
    let end = h
        .offset
        .checked_add(bytes)
        .ok_or_else(|| Error("NIfTI data size overflow".into()))?;
    if raw.len() < end {
        return Err(Error("NIfTI image data are truncated".into()));
    }
    let mut data = Vec::with_capacity(count);
    for i in 0..count {
        data.push(
            sample(
                &raw,
                h.offset + i * h.datatype.bytes(),
                h.datatype,
                h.little,
            ) * h.slope
                + h.intercept,
        );
    }
    // Greedy derives masks from NaN voxels; v1 has no masks, so fail early
    // instead of letting NaN spread through the pyramid and the metrics.
    if data.iter().any(|value| !value.is_finite()) {
        return Err(Error(
            "NIfTI image contains non-finite voxels; masks are not supported".into(),
        ));
    }
    Ok(NiftiImage {
        grid: h.grid,
        data,
        scalar_type: h.datatype,
    })
}

pub fn decode_vector_field(bytes: &[u8]) -> Result<VectorField> {
    let raw = unpack(bytes)?;
    let h = parse_header(&raw)?;
    if h.dims[0] != 5 || h.dims[4] != 1 || h.dims[5] != 3 {
        return Err(Error(
            "expected a NIfTI-1 5-D displacement field with dim[4]=1, dim[5]=3".into(),
        ));
    }
    let count = voxel_count(h.grid.dims)?;
    let bytes = count
        .checked_mul(3)
        .and_then(|count| count.checked_mul(h.datatype.bytes()))
        .ok_or_else(|| Error("NIfTI data size overflow".into()))?;
    let end = h
        .offset
        .checked_add(bytes)
        .ok_or_else(|| Error("NIfTI vector data size overflow".into()))?;
    if raw.len() < end {
        return Err(Error("NIfTI vector field data are truncated".into()));
    }
    let mut data = vec![[0.0; 3]; count];
    for c in 0..3 {
        for (i, value) in data.iter_mut().enumerate() {
            value[c] = sample(
                &raw,
                h.offset + (c * count + i) * h.datatype.bytes(),
                h.datatype,
                h.little,
            ) * h.slope
                + h.intercept;
        }
    }
    if data.iter().flatten().any(|value| !value.is_finite()) {
        return Err(Error(
            "NIfTI vector field contains non-finite values".into(),
        ));
    }
    Ok(VectorField { grid: h.grid, data })
}

fn push_i16(out: &mut [u8], at: usize, value: i16) {
    out[at..at + 2].copy_from_slice(&value.to_le_bytes());
}
fn push_f32(out: &mut [u8], at: usize, value: f32) {
    out[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn header(grid: &Grid, kind: ScalarType, components: usize) -> Result<Vec<u8>> {
    if grid.dims.iter().any(|&d| d == 0 || d > i16::MAX as usize) {
        return Err(Error("NIfTI dimensions must be in 1..=32767".into()));
    }
    let mut out = vec![0_u8; 352];
    out[..4].copy_from_slice(&348_i32.to_le_bytes());
    push_i16(&mut out, 40, if components == 1 { 3 } else { 5 });
    for (i, dim) in grid.dims.iter().enumerate() {
        push_i16(&mut out, 42 + i * 2, *dim as i16);
    }
    for i in 4..8 {
        push_i16(&mut out, 40 + i * 2, 1);
    }
    if components == 3 {
        push_i16(&mut out, 48, 1);
        push_i16(&mut out, 50, 3);
    }
    push_i16(&mut out, 70, kind.nifti());
    push_i16(&mut out, 72, (kind.bytes() * 8) as i16);
    push_f32(&mut out, 108, 352.0);
    push_f32(&mut out, 112, 1.0);
    out[123] = 10;
    push_i16(&mut out, 254, 1);
    push_f32(&mut out, 76, 1.0);
    for c in 0..3 {
        let norm = (0..3)
            .map(|r| grid.lps_from_voxel.0[r][c].powi(2))
            .sum::<f64>()
            .sqrt();
        push_f32(&mut out, 80 + c * 4, norm as f32);
    }
    let mut ras = grid.lps_from_voxel.0;
    for value in &mut ras[0] {
        *value = -*value;
    }
    for value in &mut ras[1] {
        *value = -*value;
    }
    for (r, row) in ras.iter().enumerate().take(3) {
        for (c, value) in row.iter().enumerate() {
            push_f32(&mut out, 280 + (r * 4 + c) * 4, *value as f32);
        }
    }
    if components == 3 {
        push_i16(&mut out, 68, 1007);
    }
    out[344..348].copy_from_slice(b"n+1\0");
    Ok(out)
}

fn encode_scalar(out: &mut Vec<u8>, value: f32, kind: ScalarType) {
    match kind {
        ScalarType::U8 => out.push(value as u8),
        ScalarType::I8 => out.push(value as i8 as u8),
        ScalarType::I16 => out.extend_from_slice(&(value as i16).to_le_bytes()),
        ScalarType::U16 => out.extend_from_slice(&(value as u16).to_le_bytes()),
        ScalarType::I32 => out.extend_from_slice(&(value as i32).to_le_bytes()),
        ScalarType::U32 => out.extend_from_slice(&(value as u32).to_le_bytes()),
        ScalarType::I64 => out.extend_from_slice(&(value as i64).to_le_bytes()),
        ScalarType::U64 => out.extend_from_slice(&(value as u64).to_le_bytes()),
        ScalarType::F32 => out.extend_from_slice(&value.to_le_bytes()),
        ScalarType::F64 => out.extend_from_slice(&(value as f64).to_le_bytes()),
    }
}

fn maybe_gzip(raw: Vec<u8>, gzip: bool) -> Result<Vec<u8>> {
    if !gzip {
        return Ok(raw);
    }
    #[cfg(feature = "gzip")]
    {
        let mut out = GzEncoder::new(Vec::new(), Compression::default());
        out.write_all(&raw)
            .map_err(|e| Error(format!("gzip write: {e}")))?;
        out.finish().map_err(|e| Error(format!("gzip finish: {e}")))
    }
    #[cfg(not(feature = "gzip"))]
    {
        let _ = raw;
        Err(Error("gzip NIfTI requires host-side compression".into()))
    }
}

pub fn encode_image(image: &NiftiImage, gzip: bool) -> Result<Vec<u8>> {
    if image.data.len() != voxel_count(image.grid.dims)? {
        return Err(Error("image data do not match grid dimensions".into()));
    }
    if image.data.iter().any(|value| !value.is_finite()) {
        return Err(Error("NIfTI image contains non-finite voxels".into()));
    }
    let mut raw = header(&image.grid, image.scalar_type, 1)?;
    for &value in &image.data {
        encode_scalar(&mut raw, value, image.scalar_type);
    }
    maybe_gzip(raw, gzip)
}

fn quantized_warp_vectors(field: &VectorField) -> Result<Vec<[f32; 3]>> {
    let inverse = field.grid.lps_from_voxel.inverse()?;
    let voxel_origin = inverse.apply([0.0; 3]);
    let lps_origin = field.grid.lps_from_voxel.apply([0.0; 3]);
    Ok(field
        .data
        .iter()
        .map(|value| {
            let voxel = inverse.apply(value.map(f64::from));
            let voxel = std::array::from_fn(|axis| {
                ((voxel[axis] - voxel_origin[axis]) / 0.1 + 0.5).floor() * 0.1
            });
            std::array::from_fn(|axis| {
                (field.grid.lps_from_voxel.apply(voxel)[axis] - lps_origin[axis]) as f32
            })
        })
        .collect())
}

pub fn encode_vector_field(field: &VectorField, gzip: bool) -> Result<Vec<u8>> {
    if field.data.len() != voxel_count(field.grid.dims)? {
        return Err(Error(
            "vector field data do not match grid dimensions".into(),
        ));
    }
    if field.data.iter().flatten().any(|value| !value.is_finite()) {
        return Err(Error(
            "NIfTI vector field contains non-finite values".into(),
        ));
    }
    let mut raw = header(&field.grid, ScalarType::F32, 3)?;
    let data = quantized_warp_vectors(field)?;
    for c in 0..3 {
        for value in &data {
            raw.extend_from_slice(&value[c].to_le_bytes());
        }
    }
    maybe_gzip(raw, gzip)
}
