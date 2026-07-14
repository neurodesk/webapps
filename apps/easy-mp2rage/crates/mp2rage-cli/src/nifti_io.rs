//! Minimal NIfTI-1 reader/writer (little-endian), dependency-light, no
//! ndarray-version coupling. Handles .nii and .nii.gz, sform/qform affine,
//! scl_slope/inter, and the common datatypes for MP2RAGE/SA2RAGE data.

use std::fs::File;
use std::io::{Read, Write};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use ndarray::Array3;

use mp2rage_core::Affine;

pub struct NiftiVol {
    pub data: Vec<f64>,     // logical C-order over (dims), i fastest on disk mapped in
    pub dims: Vec<usize>,   // spatial (+temporal) sizes, length 3 or 4
    pub affine: Affine,
}

fn rd_i16(b: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([b[o], b[o + 1]])
}
fn rd_i32(b: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn rd_f32(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn read_all_bytes(path: &str) -> std::io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    let mut raw = Vec::new();
    f.read_to_end(&mut raw)?;
    if raw.len() >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
        let mut d = GzDecoder::new(&raw[..]);
        let mut out = Vec::new();
        d.read_to_end(&mut out)?;
        Ok(out)
    } else {
        Ok(raw)
    }
}

/// Quaternion -> 3x3 rotation for the qform affine (NIfTI-1 method 2).
fn qform_affine(h: &[u8]) -> Affine {
    let b = rd_f32(h, 256) as f64;
    let c = rd_f32(h, 260) as f64;
    let d = rd_f32(h, 264) as f64;
    let a = (1.0 - (b * b + c * c + d * d)).max(0.0).sqrt();
    let qfac = {
        let q = rd_f32(h, 76) as f64; // pixdim[0]
        if q < 0.0 {
            -1.0
        } else {
            1.0
        }
    };
    let (dx, dy, dz) = (rd_f32(h, 80) as f64, rd_f32(h, 84) as f64, rd_f32(h, 88) as f64);
    let r = [
        [a * a + b * b - c * c - d * d, 2.0 * (b * c - a * d), 2.0 * (b * d + a * c)],
        [2.0 * (b * c + a * d), a * a + c * c - b * b - d * d, 2.0 * (c * d - a * b)],
        [2.0 * (b * d - a * c), 2.0 * (c * d + a * b), a * a + d * d - b * b - c * c],
    ];
    let (ox, oy, oz) = (rd_f32(h, 268) as f64, rd_f32(h, 272) as f64, rd_f32(h, 276) as f64);
    [
        [r[0][0] * dx, r[0][1] * dy, r[0][2] * dz * qfac, ox],
        [r[1][0] * dx, r[1][1] * dy, r[1][2] * dz * qfac, oy],
        [r[2][0] * dx, r[2][1] * dy, r[2][2] * dz * qfac, oz],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

pub fn read_nifti(path: &str) -> Result<NiftiVol, String> {
    let bytes = read_all_bytes(path).map_err(|e| format!("read {path}: {e}"))?;
    if bytes.len() < 352 {
        return Err(format!("{path}: too short for a NIfTI-1 header"));
    }
    let hdr = &bytes[..348];
    if rd_i32(hdr, 0) != 348 {
        return Err(format!("{path}: unsupported/big-endian NIfTI (sizeof_hdr != 348)"));
    }
    let ndim = rd_i16(hdr, 40).max(0) as usize;
    let mut dims = Vec::new();
    for i in 1..=ndim.min(4) {
        dims.push(rd_i16(hdr, 40 + 2 * i).max(1) as usize);
    }
    while dims.len() < 3 {
        dims.push(1);
    }
    let datatype = rd_i16(hdr, 70);
    let vox_offset = rd_f32(hdr, 108) as usize;
    let mut slope = rd_f32(hdr, 112) as f64;
    let inter = rd_f32(hdr, 116) as f64;
    if slope == 0.0 || slope.is_nan() {
        slope = 1.0;
    }
    let inter = if inter.is_nan() { 0.0 } else { inter };

    let sform_code = rd_i16(hdr, 254);
    let affine = if sform_code > 0 {
        let mut a = [[0.0f64; 4]; 4];
        for (r, base) in [280usize, 296, 312].iter().enumerate() {
            for c in 0..4 {
                a[r][c] = rd_f32(hdr, base + 4 * c) as f64;
            }
        }
        a[3] = [0.0, 0.0, 0.0, 1.0];
        a
    } else {
        qform_affine(hdr)
    };

    let n: usize = dims.iter().product();
    let off = vox_offset.max(352);
    // Bytes-per-pixel for the supported datatypes; reject unknown codes before
    // allocating anything.
    let bpp: usize = match datatype {
        16 => 4,  // f32
        64 => 8,  // f64
        4 => 2,   // i16
        512 => 2, // u16
        8 => 4,   // i32
        2 => 1,   // u8
        dt => return Err(format!("{path}: unsupported datatype code {dt}")),
    };
    // Validate the declared volume against the ACTUAL file length with checked
    // arithmetic BEFORE reserving. A header can claim huge dims from a tiny file;
    // reserving n*8 up front would OOM-abort, and off+n*bpp could overflow. After
    // this check n is bounded by the real file size, so with_capacity and every
    // off+k*i read below are in bounds (this also covers the i16/u16/i32/u8 arms
    // that previously had no truncation guard).
    let need = n
        .checked_mul(bpp)
        .and_then(|b| b.checked_add(off))
        .ok_or_else(|| format!("{path}: NIfTI dimensions overflow the addressable range"))?;
    if bytes.len() < need {
        return Err(format!("{path}: truncated NIfTI data (need {need} bytes, have {})", bytes.len()));
    }
    let raw = &bytes;
    let mut data = Vec::with_capacity(n);
    match datatype {
        16 => for i in 0..n { data.push(rd_f32(raw, off + 4 * i) as f64); },
        64 => for i in 0..n {
            let o = off + 8 * i;
            let mut b = [0u8; 8];
            b.copy_from_slice(&raw[o..o + 8]);
            data.push(f64::from_le_bytes(b));
        },
        4 => for i in 0..n { data.push(rd_i16(raw, off + 2 * i) as f64); },
        512 => for i in 0..n { data.push(u16::from_le_bytes([raw[off + 2 * i], raw[off + 2 * i + 1]]) as f64); },
        8 => for i in 0..n { data.push(rd_i32(raw, off + 4 * i) as f64); },
        2 => for i in 0..n { data.push(raw[off + i] as f64); },
        _ => unreachable!("datatype validated above"),
    }
    if slope != 1.0 || inter != 0.0 {
        for v in data.iter_mut() {
            *v = *v * slope + inter;
        }
    }
    Ok(NiftiVol { data, dims, affine })
}

impl NiftiVol {
    /// 3D volume in C-order (values placed at [i,j,k] from disk i-fastest order).
    pub fn to_array3(&self) -> Array3<f64> {
        let (nx, ny, nz) = (self.dims[0], self.dims[1], self.dims[2]);
        Array3::from_shape_fn((nx, ny, nz), |(i, j, k)| self.data[i + nx * (j + ny * k)])
    }

    /// One temporal component `t` of a 4D volume.
    pub fn component(&self, t: usize) -> Array3<f64> {
        let (nx, ny, nz) = (self.dims[0], self.dims[1], self.dims[2]);
        let plane = nx * ny * nz;
        Array3::from_shape_fn((nx, ny, nz), |(i, j, k)| self.data[t * plane + i + nx * (j + ny * k)])
    }
}

/// Write a 3D f32 volume as a .nii.gz with the given affine (sform + qform=0).
pub fn write_nifti_f32(path: &str, vol: &Array3<f32>, affine: &Affine) -> Result<(), String> {
    let (nx, ny, nz) = vol.dim();
    let mut h = vec![0u8; 352];
    // sizeof_hdr
    h[0..4].copy_from_slice(&348i32.to_le_bytes());
    // dim
    let put_i16 = |h: &mut [u8], o: usize, v: i16| h[o..o + 2].copy_from_slice(&v.to_le_bytes());
    let put_f32 = |h: &mut [u8], o: usize, v: f32| h[o..o + 4].copy_from_slice(&v.to_le_bytes());
    put_i16(&mut h, 40, 3);
    put_i16(&mut h, 42, nx as i16);
    put_i16(&mut h, 44, ny as i16);
    put_i16(&mut h, 46, nz as i16);
    put_i16(&mut h, 48, 1);
    put_i16(&mut h, 50, 1);
    put_i16(&mut h, 52, 1);
    put_i16(&mut h, 54, 1);
    put_i16(&mut h, 70, 16); // datatype float32
    put_i16(&mut h, 72, 32); // bitpix
    // pixdim: qfac + voxel sizes from affine column norms
    let vsize = |c: usize| ((0..3).map(|r| affine[r][c] * affine[r][c]).sum::<f64>()).sqrt() as f32;
    put_f32(&mut h, 76, 1.0);
    put_f32(&mut h, 80, vsize(0));
    put_f32(&mut h, 84, vsize(1));
    put_f32(&mut h, 88, vsize(2));
    put_f32(&mut h, 108, 352.0); // vox_offset
    put_f32(&mut h, 112, 1.0); // scl_slope
    put_f32(&mut h, 116, 0.0); // scl_inter
    put_i16(&mut h, 252, 0); // qform_code
    put_i16(&mut h, 254, 2); // sform_code = aligned
    for (r, base) in [280usize, 296, 312].iter().enumerate() {
        for c in 0..4 {
            put_f32(&mut h, base + 4 * c, affine[r][c] as f32);
        }
    }
    h[344..348].copy_from_slice(b"n+1\0");

    // h is 352 bytes: the 348-byte header + the 4 extension bytes (all zero),
    // so data begins exactly at vox_offset = 352.
    let mut body = Vec::with_capacity(352 + nx * ny * nz * 4);
    body.extend_from_slice(&h);
    // data on disk: i fastest
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                body.extend_from_slice(&vol[[i, j, k]].to_le_bytes());
            }
        }
    }
    let f = File::create(path).map_err(|e| format!("create {path}: {e}"))?;
    let mut enc = GzEncoder::new(f, Compression::default());
    enc.write_all(&body).map_err(|e| format!("write {path}: {e}"))?;
    enc.finish().map_err(|e| format!("finish {path}: {e}"))?;
    Ok(())
}
