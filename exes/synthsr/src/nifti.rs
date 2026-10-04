// ponytail: loops mirror the JS port index for index; clamp differs from max/min only for NaN, which is rejected earlier.
#![allow(clippy::needless_range_loop, clippy::manual_clamp)]
// Minimal NIfTI-1 scalar volume I/O. Mirrors packages/synthsr/src/volume.js readVolume/writeVolume
// and the affine rules of nifti-reader-js so both front ends see identical geometry.
use neurodesk_nifti::Nifti1Header;
use std::io::Read;

pub type Affine = [[f64; 4]; 3];

pub struct Volume<T> {
    pub data: Vec<T>,
    pub dims: [usize; 3],
    pub affine: Affine,
}

pub fn product(d: &[usize; 3]) -> usize {
    d[0] * d[1] * d[2]
}

pub fn read(bytes: &[u8]) -> Result<Volume<f32>, String> {
    let owned;
    let buf = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut v = Vec::new();
        flate2::read::MultiGzDecoder::new(bytes)
            .read_to_end(&mut v)
            .map_err(|e| format!("Cannot decompress NIfTI: {e}"))?;
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
    if (4..=ndim.min(7)).any(|a| dim[a] > 1) {
        return Err(
            "SynthSR needs a single 3D image. Extract a volume from this 4D image first.".into(),
        );
    }
    let dims = [dim[1], dim[2], dim[3]];
    if dims.iter().any(|&d| d < 2) {
        return Err("Unsupported image dimensions.".into());
    }
    let dims = dims.map(|d| d as usize);
    if product(&dims) > 128 * 1024 * 1024 {
        return Err("Unsupported image dimensions.".into());
    }
    let (width, decode) = header.scalar_decoder()?;
    let offset = header.vox_offset as usize;
    let n = product(&dims);
    let raw = buf
        .get(offset..offset + n * width)
        .ok_or("The NIfTI voxel data is truncated.")?;
    let slope = header.scl_slope as f64;
    let (slope, inter) = if slope != 0.0 {
        (slope, header.scl_inter as f64)
    } else {
        (1.0, 0.0)
    };
    let mut data = Vec::with_capacity(n);
    for c in raw.chunks_exact(width) {
        let v = decode(c);
        let v = (v * slope + inter) as f32;
        if !v.is_finite() {
            return Err("The image contains non-finite intensities. Clean NaN/Infinity values before synthesis.".into());
        }
        data.push(v);
    }
    // nifti-reader-js: qform when qform_code > 0 and sform_code < qform_code, else sform, else pixdim.
    let pixdim: Vec<f64> = header.pixdim[..4].iter().map(|&v| v as f64).collect();
    let (qcode, scode) = (header.qform_code, header.sform_code);
    let mut affine = [[0.0f64; 4]; 3];
    if qcode < 1 && scode < 1 {
        for r in 0..3 {
            affine[r][r] = pixdim[r + 1];
        }
    }
    if qcode > 0 && scode < qcode {
        let (b, c, d) = (
            header.quaternion[0] as f64,
            header.quaternion[1] as f64,
            header.quaternion[2] as f64,
        );
        let a = (1.0 - (b * b + c * c + d * d)).sqrt();
        let qfac = if pixdim[0] == 0.0 { 1.0 } else { pixdim[0] };
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
    } else if scode > 0 {
        for r in 0..3 {
            for k in 0..4 {
                affine[r][k] = header.srow[r][k] as f64;
            }
        }
    }
    let scale = match header.xyzt_units & 7 {
        1 => 1000.0,
        3 => 0.001,
        _ => 1.0,
    };
    for row in affine.iter_mut() {
        for v in row.iter_mut() {
            *v *= scale;
        }
    }
    if affine.iter().flatten().any(|v| !v.is_finite()) {
        return Err("Invalid NIfTI affine.".into());
    }
    crate::volume::inverse3(&affine)?;
    Ok(Volume { data, dims, affine })
}

pub fn write(v: &Volume<u8>) -> Vec<u8> {
    let mut b = vec![0u8; 352 + v.data.len()];
    let put16 = |b: &mut [u8], o: usize, x: i16| b[o..o + 2].copy_from_slice(&x.to_le_bytes());
    let put32 = |b: &mut [u8], o: usize, x: f32| b[o..o + 4].copy_from_slice(&x.to_le_bytes());
    b[0..4].copy_from_slice(&348i32.to_le_bytes());
    put16(&mut b, 40, 3);
    for a in 0..7 {
        put16(&mut b, 42 + a * 2, if a < 3 { v.dims[a] as i16 } else { 1 });
    }
    put16(&mut b, 70, 2);
    put16(&mut b, 72, 8);
    put32(&mut b, 76, 1.0);
    for a in 0..3 {
        put32(
            &mut b,
            80 + a * 4,
            (0..3)
                .map(|r| v.affine[r][a] * v.affine[r][a])
                .sum::<f64>()
                .sqrt() as f32,
        );
    }
    put32(&mut b, 108, 352.0);
    put32(&mut b, 112, 1.0);
    b[123] = 2;
    let desc = b"SynthSR synthetic T1; 1mm; not acquired T1";
    b[148..148 + desc.len()].copy_from_slice(desc);
    put16(&mut b, 254, 1);
    for r in 0..3 {
        for c in 0..4 {
            put32(&mut b, 280 + 16 * r + 4 * c, v.affine[r][c] as f32);
        }
    }
    b[344..348].copy_from_slice(b"n+1\0");
    b[352..].copy_from_slice(&v.data);
    b
}
