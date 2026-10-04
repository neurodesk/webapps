// ponytail: loops mirror the Python index for index; clamp differs from max/min only for NaN, which is rejected earlier.
#![allow(clippy::needless_range_loop, clippy::manual_clamp)]
// Minimal NIfTI-1 scalar volume I/O (from exes/synthsr). Reads to f64 like nibabel get_fdata,
// averages 4D channels like SynthSeg's preprocess(), writes int32 label maps.
use neurodesk_nifti::Nifti1Header;
use std::io::Read;

pub type Affine = [[f64; 4]; 3];

pub struct Volume<T> {
    pub data: Vec<T>,
    pub dims: [usize; 3],
    pub pixdim: [f64; 3],
    pub affine: Affine,
    /// qform_code, sform_code and xyzt_units: nibabel keeps the input's for the 1 mm path and writes
    /// (0, 2, mm) for a resampled image, so the output header mirrors that.
    pub codes: [i16; 2],
    pub units: u8,
}

// Saturating so the voxel caps below still trip on wasm32, where usize is 32-bit.
pub fn product(d: &[usize; 3]) -> usize {
    d[0].saturating_mul(d[1]).saturating_mul(d[2])
}

pub fn read(bytes: &[u8]) -> Result<Volume<f64>, String> {
    let owned;
    let buf = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut v = Vec::new();
        // Cap the decompressed size before any header is trusted (a gzip of zeros expands ~1000x).
        const CAP: u64 = 2 << 30;
        std::io::Read::take(flate2::read::MultiGzDecoder::new(bytes), CAP + 1)
            .read_to_end(&mut v)
            .map_err(|e| format!("Cannot decompress NIfTI: {e}"))?;
        if v.len() as u64 > CAP {
            return Err("The decompressed NIfTI exceeds 2 GB.".into());
        }
        owned = v;
        &owned[..]
    } else {
        bytes
    };
    if buf.len() < 352 || &buf[344..347] != b"n+1" {
        return Err("Choose a NIfTI image (.nii or .nii.gz).".into());
    }
    let header = Nifti1Header::decode(buf[..348].try_into().unwrap());
    let ndim = header.dim[0] as usize;
    let dim = header.dim;
    if ndim < 3 || (5..=ndim.min(7)).any(|a| dim[a] > 1) {
        return Err("SynthSeg needs a 3D image (or 4D multichannel).".into());
    }
    let dims = [dim[1], dim[2], dim[3]];
    if dims.iter().any(|&d| d < 2) {
        return Err("Unsupported image dimensions.".into());
    }
    let dims = dims.map(|d| d as usize);
    let channels = if ndim >= 4 { dim[4].max(1) as usize } else { 1 };
    if product(&dims).saturating_mul(channels) > 256 * 1024 * 1024 {
        return Err("Unsupported image dimensions.".into());
    }
    let (width, decode) = header.scalar_decoder()?;
    let offset = header.vox_offset;
    if !(352.0..=buf.len() as f32).contains(&offset) {
        return Err("Invalid NIfTI vox_offset.".into());
    }
    let n = product(&dims);
    let raw = buf
        .get(offset as usize..offset as usize + n * channels * width)
        .ok_or("The NIfTI voxel data is truncated.")?;
    // nibabel: a zero or non-finite slope/intercept means "unscaled".
    let (slope, inter) = (header.scl_slope as f64, header.scl_inter as f64);
    let (slope, inter) = if slope != 0.0 && slope.is_finite() && inter.is_finite() {
        (slope, inter)
    } else {
        (1.0, 0.0)
    };
    let mut data = vec![0f64; n];
    for (i, c) in raw.chunks_exact(width).enumerate() {
        let v = decode(c) * slope + inter;
        if !v.is_finite() {
            return Err("The image contains non-finite intensities.".into());
        }
        data[i % n] += v / channels as f64;
    }
    // nibabel: sform when sform_code > 0, else qform when qform_code > 0, else pixdim.
    let pixdim: Vec<f64> = header.pixdim[..4].iter().map(|&v| v as f64).collect();
    let (qcode, scode) = (header.qform_code, header.sform_code);
    let mut affine = [[0.0f64; 4]; 3];
    if scode > 0 {
        for r in 0..3 {
            for k in 0..4 {
                affine[r][k] = header.srow[r][k] as f64;
            }
        }
    } else if qcode > 0 {
        let (b, c, d) = (
            header.quaternion[0] as f64,
            header.quaternion[1] as f64,
            header.quaternion[2] as f64,
        );
        let a = (1.0 - (b * b + c * c + d * d)).max(0.0).sqrt();
        let qfac = if pixdim[0] < 0.0 { -1.0 } else { 1.0 };
        let rot = [
            [
                a * a + b * b - c * c - d * d,
                2.0 * b * c - 2.0 * a * d,
                2.0 * b * d + 2.0 * a * c,
            ],
            [
                2.0 * b * c + 2.0 * a * d,
                a * a + c * c - b * b - d * d,
                2.0 * c * d - 2.0 * a * b,
            ],
            [
                2.0 * b * d - 2.0 * a * c,
                2.0 * c * d + 2.0 * a * b,
                a * a + d * d - c * c - b * b,
            ],
        ];
        for r in 0..3 {
            for k in 0..3 {
                affine[r][k] = rot[r][k] * pixdim[k + 1] * if k == 2 { qfac } else { 1.0 };
            }
            affine[r][3] = header.qoffset[r] as f64;
        }
    } else {
        // nibabel fallback: shape_zoom_affine with x flipped, origin at the volume centre.
        for r in 0..3 {
            let z = pixdim[r + 1] * if r == 0 { -1.0 } else { 1.0 };
            affine[r][r] = z;
            affine[r][3] = -z * (dims[r] - 1) as f64 / 2.0;
        }
    }
    if affine.iter().flatten().any(|v| !v.is_finite()) {
        return Err("Invalid NIfTI affine.".into());
    }
    crate::volume::inverse3(&affine)?;
    Ok(Volume {
        data,
        dims,
        pixdim: [pixdim[1].abs(), pixdim[2].abs(), pixdim[3].abs()],
        affine,
        codes: [qcode, scode],
        units: if header.xyzt_units == 0 {
            2
        } else {
            header.xyzt_units
        }, // nibabel writes mm when the input has no units
    })
}

/// nibabel-style quaternion for an affine whose rotation part is orthonormal; None when it has shear.
fn quaternion(affine: &Affine, pixdim: &[f64; 3]) -> Option<(f64, [f64; 3])> {
    let mut r = [[0f64; 3]; 3];
    for c in 0..3 {
        for row in 0..3 {
            r[row][c] = affine[row][c] / pixdim[c];
        }
    }
    for i in 0..3 {
        for j in 0..3 {
            let dot: f64 = (0..3).map(|k| r[k][i] * r[k][j]).sum();
            if (dot - if i == j { 1.0 } else { 0.0 }).abs() > 1e-4 {
                return None;
            }
        }
    }
    let det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
        - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
        + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    let qfac = if det < 0.0 { -1.0 } else { 1.0 };
    for row in r.iter_mut() {
        row[2] *= qfac;
    }
    let mut a = (1.0 + r[0][0] + r[1][1] + r[2][2]).max(0.0).sqrt() / 2.0;
    let (b, c, d) = if a > 0.5 {
        (
            (r[2][1] - r[1][2]) / (4.0 * a),
            (r[0][2] - r[2][0]) / (4.0 * a),
            (r[1][0] - r[0][1]) / (4.0 * a),
        )
    } else {
        // nifti1 reference: pick the largest diagonal term.
        let xd = 1.0 + r[0][0] - (r[1][1] + r[2][2]);
        let yd = 1.0 + r[1][1] - (r[0][0] + r[2][2]);
        let zd = 1.0 + r[2][2] - (r[0][0] + r[1][1]);
        if xd > 1.0 {
            let b = 0.5 * xd.sqrt();
            a = (r[2][1] - r[1][2]) / (4.0 * b);
            (
                b,
                0.25 * (r[0][1] + r[1][0]) / b,
                0.25 * (r[0][2] + r[2][0]) / b,
            )
        } else if yd > 1.0 {
            let c = 0.5 * yd.sqrt();
            a = (r[0][2] - r[2][0]) / (4.0 * c);
            (
                0.25 * (r[0][1] + r[1][0]) / c,
                c,
                0.25 * (r[1][2] + r[2][1]) / c,
            )
        } else {
            let d = 0.5 * zd.sqrt();
            a = (r[1][0] - r[0][1]) / (4.0 * d);
            (
                0.25 * (r[0][2] + r[2][0]) / d,
                0.25 * (r[1][2] + r[2][1]) / d,
                d,
            )
        }
    };
    let sign = if a < 0.0 { -1.0 } else { 1.0 };
    Some((qfac, [b * sign, c * sign, d * sign]))
}

pub fn write(v: &Volume<i32>) -> Vec<u8> {
    let mut b = vec![0u8; 352 + v.data.len() * 4];
    let put16 = |b: &mut [u8], o: usize, x: i16| b[o..o + 2].copy_from_slice(&x.to_le_bytes());
    let put32 = |b: &mut [u8], o: usize, x: f32| b[o..o + 4].copy_from_slice(&x.to_le_bytes());
    b[0..4].copy_from_slice(&348i32.to_le_bytes());
    put16(&mut b, 40, 3);
    for a in 0..7 {
        put16(&mut b, 42 + a * 2, if a < 3 { v.dims[a] as i16 } else { 1 });
    }
    put16(&mut b, 70, 8);
    put16(&mut b, 72, 32);
    let pixdim: [f64; 3] = std::array::from_fn(|a| {
        (0..3)
            .map(|r| v.affine[r][a] * v.affine[r][a])
            .sum::<f64>()
            .sqrt()
    });
    for a in 0..8 {
        put32(
            &mut b,
            76 + a * 4,
            if (1..4).contains(&a) {
                pixdim[a - 1] as f32
            } else {
                1.0
            },
        );
    }
    put32(&mut b, 108, 352.0);
    put32(&mut b, 112, 1.0);
    b[123] = v.units;
    let desc = b"SynthSeg 2.0 segmentation";
    b[148..148 + desc.len()].copy_from_slice(desc);
    // nibabel stores the quaternion even when qform_code is 0.
    if let Some((qfac, q)) = quaternion(&v.affine, &pixdim) {
        put32(&mut b, 76, qfac as f32);
        put16(&mut b, 252, v.codes[0]);
        for i in 0..3 {
            put32(&mut b, 256 + 4 * i, q[i] as f32);
            put32(&mut b, 268 + 4 * i, v.affine[i][3] as f32);
        }
    }
    put16(&mut b, 254, v.codes[1].max(1));
    for r in 0..3 {
        for c in 0..4 {
            put32(&mut b, 280 + 16 * r + 4 * c, v.affine[r][c] as f32);
        }
    }
    b[344..348].copy_from_slice(b"n+1\0");
    for (i, x) in v.data.iter().enumerate() {
        b[352 + 4 * i..356 + 4 * i].copy_from_slice(&x.to_le_bytes());
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qform_roundtrips_rotations_with_a_negative_scalar_quaternion() {
        for axis in 0..3 {
            let angle = 220.0f64.to_radians();
            let mut affine = [[0.0; 4]; 3];
            affine[axis][axis] = 1.0;
            let (first, second) = ((axis + 1) % 3, (axis + 2) % 3);
            affine[first][first] = angle.cos();
            affine[first][second] = -angle.sin();
            affine[second][first] = angle.sin();
            affine[second][second] = angle.cos();
            let volume = Volume {
                data: vec![0i32; 8],
                dims: [2; 3],
                pixdim: [1.0; 3],
                affine,
                codes: [1, 1],
                units: 2,
            };
            let mut bytes = write(&volume);
            // Force the reader to use qform so a correct sform cannot hide a bad quaternion.
            bytes[254..256].copy_from_slice(&0i16.to_le_bytes());
            let decoded = read(&bytes).unwrap();
            for (actual, expected) in decoded.affine.iter().flatten().zip(affine.iter().flatten()) {
                assert!((actual - expected).abs() < 1e-6, "{actual} != {expected}");
            }
        }
    }
}
