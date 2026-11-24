//! NIfTI-1 scalar volumes (NIfTI-2 input is translated to NIfTI-1 first). Reading is SynthSR's port of `readVolume` (`exes/synthsr/src/nifti.rs`, shared by
//! path so both read identical geometry); writing mirrors `writeVolume` in packages/synthsr/src/volume.js.

#[path = "../../../synthsr/src/nifti.rs"]
#[allow(dead_code)]
#[rustfmt::skip]
mod synthsr_nifti;

pub use synthsr_nifti::{Affine, Volume};

use flate2::Compression;
use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use neurodesk_nifti::Nifti1Header;
use std::io::{Read, Write};

/// Voxel types `write` stores: float32 for intensities, uint8 for masks.
pub trait Voxel: Copy {
    const DATATYPE: i16;
    const BITPIX: i16;
    fn put(self, out: &mut Vec<u8>);
}
impl Voxel for f32 {
    const DATATYPE: i16 = 16;
    const BITPIX: i16 = 32;
    fn put(self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.to_le_bytes());
    }
}
impl Voxel for u8 {
    const DATATYPE: i16 = 2;
    const BITPIX: i16 = 8;
    fn put(self, out: &mut Vec<u8>) {
        out.push(self);
    }
}

/// `writeVolume`: NIfTI-1, sform only (code 1), spacing from the affine's column norms, `description` in descrip.
pub fn write<T: Voxel>(v: &Volume<T>, description: &str) -> Vec<u8> {
    let mut b = vec![0u8; 352];
    let put16 = |b: &mut [u8], o: usize, x: i16| b[o..o + 2].copy_from_slice(&x.to_le_bytes());
    let put32 = |b: &mut [u8], o: usize, x: f32| b[o..o + 4].copy_from_slice(&x.to_le_bytes());
    b[0..4].copy_from_slice(&348i32.to_le_bytes());
    put16(&mut b, 40, 3);
    for a in 0..7 {
        put16(&mut b, 42 + a * 2, if a < 3 { v.dims[a] as i16 } else { 1 });
    }
    put16(&mut b, 70, T::DATATYPE);
    put16(&mut b, 72, T::BITPIX);
    put32(&mut b, 76, 1.0);
    for a in 0..3 {
        let norm = (0..3)
            .map(|r| v.affine[r][a] * v.affine[r][a])
            .sum::<f64>()
            .sqrt();
        put32(&mut b, 80 + a * 4, norm as f32);
    }
    put32(&mut b, 108, 352.0);
    put32(&mut b, 112, 1.0);
    b[123] = 2;
    let desc = description.as_bytes();
    let n = desc.len().min(79);
    b[148..148 + n].copy_from_slice(&desc[..n]);
    put16(&mut b, 254, 1);
    for r in 0..3 {
        for c in 0..4 {
            put32(&mut b, 280 + 16 * r + 4 * c, v.affine[r][c] as f32);
        }
    }
    b[344..348].copy_from_slice(b"n+1\0");
    b.reserve(v.data.len() * (T::BITPIX as usize / 8));
    for &x in &v.data {
        x.put(&mut b);
    }
    b
}

pub fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return Ok(bytes.to_vec());
    }
    let mut out = Vec::new();
    MultiGzDecoder::new(bytes)
        .read_to_end(&mut out)
        .map_err(|e| format!("Cannot decompress NIfTI: {e}"))?;
    Ok(out)
}

pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

/// SynthSR's reader, after translating a NIfTI-2 header.
pub fn read(bytes: &[u8]) -> Result<Volume<f32>, String> {
    synthsr_nifti::read(&nifti1(gunzip(bytes)?)?)
}

/// A NIfTI-2 image as NIfTI-1 in the same byte order (affines rounded to float32, as every tool-facing file
/// is); anything else unchanged. NIfTI-1 stores scaling as float32, so a scaled image is decoded with its f64
/// slope and intercept into float64 voxels: an empty lesion stored as 100 * 0.01 - 1 must stay exactly 0.
fn nifti1(raw: Vec<u8>) -> Result<Vec<u8>, String> {
    if raw.len() < 540 || &raw[4..8] != b"n+2\0" {
        return Ok(raw);
    }
    let le = i32::from_le_bytes(raw[0..4].try_into().unwrap()) == 540;
    let order = |mut b: Vec<u8>| {
        if !le {
            b.reverse();
        }
        b
    };
    let int = |o: usize, n: usize| {
        let b = order(raw[o..o + n].to_vec());
        let mut w = [if b[n - 1] & 0x80 != 0 { 0xff } else { 0 }; 8];
        w[..n].copy_from_slice(&b);
        i64::from_le_bytes(w)
    };
    let real64 = |o: usize| f64::from_bits(int(o, 8) as u64);
    let real = |o: usize| real64(o) as f32;
    let mut h = vec![0u8; 352];
    let put =
        |h: &mut Vec<u8>, o: usize, b: &[u8]| h[o..o + b.len()].copy_from_slice(&order(b.to_vec()));
    put(&mut h, 0, &348i32.to_le_bytes());
    put(&mut h, 70, &(int(12, 2) as i16).to_le_bytes());
    put(&mut h, 72, &(int(14, 2) as i16).to_le_bytes());
    for a in 0..8 {
        let d = i16::try_from(int(16 + 8 * a, 8)).map_err(|_| "Unsupported image dimensions.")?;
        put(&mut h, 40 + 2 * a, &d.to_le_bytes());
        put(&mut h, 76 + 4 * a, &real(104 + 8 * a).to_le_bytes());
    }
    put(&mut h, 108, &352f32.to_le_bytes());
    put(&mut h, 112, &real(176).to_le_bytes());
    put(&mut h, 116, &real(184).to_le_bytes());
    put(&mut h, 252, &(int(344, 4) as i16).to_le_bytes());
    put(&mut h, 254, &(int(348, 4) as i16).to_le_bytes());
    // quatern_b..qoffset_z, then the three sform rows: f64 runs in NIfTI-2, f32 in NIfTI-1.
    for k in 0..18 {
        put(&mut h, 256 + 4 * k, &real(352 + 8 * k).to_le_bytes());
    }
    // A unit quaternion can exceed norm 1 once narrowed (0.6, 0.8, 0 -> 1 + 5e-8) and its rotation becomes NaN, so a
    // selected qform is built in f64 and stored as the sform, with nifti_quatern_to_mat44's near-unit case: a 180°
    // rotation (b = c = sqrt(0.5)) rounds to 1 + 2e-16 even in f64, so (b, c, d) is normalised and a set to 0.
    let (qcode, scode) = (int(344, 4), int(348, 4));
    if qcode > 0 && scode < qcode {
        let [mut b, mut c, mut d] = [0, 1, 2].map(|k| real64(352 + 8 * k));
        let norm = b * b + c * c + d * d;
        let a = if 1.0 - norm < 1e-7 {
            let s = norm.sqrt();
            (b, c, d) = (b / s, c / s, d / s);
            0.0
        } else {
            (1.0 - norm).sqrt()
        };
        let rot = [
            [
                a * a + b * b - c * c - d * d,
                2.0 * (b * c - a * d),
                2.0 * (b * d + a * c),
            ],
            [
                2.0 * (b * c + a * d),
                a * a + c * c - b * b - d * d,
                2.0 * (c * d - a * b),
            ],
            [
                2.0 * (b * d - a * c),
                2.0 * (c * d + a * b),
                a * a + d * d - c * c - b * b,
            ],
        ];
        let qfac = if real64(104) == 0.0 { 1.0 } else { real64(104) };
        for (r, row) in rot.iter().enumerate() {
            for (k, &e) in row.iter().enumerate() {
                let v = e * real64(112 + 8 * k) * if k == 2 { qfac } else { 1.0 };
                put(&mut h, 280 + 16 * r + 4 * k, &(v as f32).to_le_bytes());
            }
            put(&mut h, 280 + 16 * r + 12, &real(376 + 8 * r).to_le_bytes());
        }
        put(&mut h, 254, &(qcode as i16).to_le_bytes());
    }
    h[123] = raw[500 + if le { 0 } else { 3 }];
    h[344..348].copy_from_slice(b"n+1\0");
    let offset = usize::try_from(int(168, 8)).map_err(|_| "The NIfTI voxel data is truncated.")?;
    let voxels = raw
        .get(offset..)
        .ok_or("The NIfTI voxel data is truncated.")?;
    let (slope, inter) = (real64(176), real64(184));
    if slope == 0.0 || (slope == 1.0 && inter == 0.0) {
        h.extend_from_slice(voxels);
        return Ok(h);
    }
    let (width, decode) = Nifti1Header::decode(h[..348].try_into().unwrap()).scalar_decoder()?;
    put(&mut h, 70, &64i16.to_le_bytes());
    put(&mut h, 72, &64i16.to_le_bytes());
    put(&mut h, 112, &1f32.to_le_bytes());
    put(&mut h, 116, &0f32.to_le_bytes());
    h.reserve(voxels.len() / width * 8);
    let value = |c| decode(c) * slope + inter;
    if le {
        voxels
            .chunks_exact(width)
            .for_each(|c| h.extend_from_slice(&value(c).to_le_bytes()));
    } else {
        voxels
            .chunks_exact(width)
            .for_each(|c| h.extend_from_slice(&value(c).to_be_bytes()));
    }
    Ok(h)
}

/// `readAdditional(buffer, 'binary')`: at most two distinct finite values (after scaling, compared in f64). With
/// two, the larger is the lesion; with one, any nonzero value is.
pub fn read_binary(bytes: &[u8]) -> Result<Volume<u8>, String> {
    let raw = nifti1(gunzip(bytes)?)?;
    let geometry = synthsr_nifti::read(&raw)?;
    let header = Nifti1Header::decode(raw[..348].try_into().unwrap());
    let (width, decode) = header.scalar_decoder()?;
    let offset = header.vox_offset as usize;
    let n = geometry.data.len();
    let voxels = raw
        .get(offset..offset + n * width)
        .ok_or("The NIfTI voxel data is truncated.")?;
    let slope = header.scl_slope as f64;
    let (slope, inter) = if slope != 0.0 {
        (slope, header.scl_inter as f64)
    } else {
        (1.0, 0.0)
    };
    let values: Vec<f64> = voxels
        .chunks_exact(width)
        .map(|c| decode(c) * slope + inter)
        .collect();
    let first = values[0];
    let mut second: Option<f64> = None;
    for &v in &values {
        if !v.is_finite() {
            return Err("Lesion maps must contain finite values.".into());
        }
        if v != first && second.is_none() {
            second = Some(v);
        } else if v != first && Some(v) != second {
            return Err("Lesion maps must contain no more than two discrete values.".into());
        }
    }
    let data = match second {
        None => values.iter().map(|&v| u8::from(v != 0.0)).collect(),
        Some(s) => {
            let foreground = first.max(s);
            values.iter().map(|&v| u8::from(v == foreground)).collect()
        }
    };
    Ok(Volume {
        data,
        dims: geometry.dims,
        affine: geometry.affine,
    })
}

/// True for an image holding exactly two distinct values (a mask passed where a scan belongs).
pub fn has_two_values(data: &[f32]) -> bool {
    let first = data[0];
    let mut second: Option<f32> = None;
    for &v in data {
        if v == first || Some(v) == second {
            continue;
        }
        if second.is_none() {
            second = Some(v);
        } else {
            return false;
        }
    }
    second.is_some()
}

#[cfg(test)]
mod tests {
    // The previous JavaScript pipeline and the app's reader accept NIfTI-2; the core must too.
    #[test]
    fn reads_nifti2() {
        let mut b = vec![0u8; 544];
        b[0..4].copy_from_slice(&540i32.to_le_bytes());
        b[4..12].copy_from_slice(b"n+2\0\r\n\x1a\n");
        b[12..14].copy_from_slice(&16i16.to_le_bytes());
        b[14..16].copy_from_slice(&32i16.to_le_bytes());
        for (a, d) in [3i64, 2, 2, 2, 1, 1, 1, 1].iter().enumerate() {
            b[16 + 8 * a..24 + 8 * a].copy_from_slice(&d.to_le_bytes());
        }
        b[168..176].copy_from_slice(&544i64.to_le_bytes());
        b[348..352].copy_from_slice(&1i32.to_le_bytes());
        let sform = [
            [2.0, 0.0, 0.0, -10.0],
            [0.0, 3.0, 0.0, 20.0],
            [0.0, 0.0, 4.0, 30.0],
        ];
        for (r, row) in sform.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                let o = 400 + 32 * r + 8 * c;
                b[o..o + 8].copy_from_slice(&f64::to_le_bytes(*v));
            }
        }
        for v in 1..=8 {
            b.extend_from_slice(&(v as f32).to_le_bytes());
        }
        let mut empty = b.clone();
        let v = super::read(&b).unwrap();
        assert_eq!(v.dims, [2, 2, 2]);
        assert_eq!(v.data, (1..=8).map(|v| v as f32).collect::<Vec<_>>());
        assert_eq!(v.affine, sform);
        // A valid quaternion (0.6, 0.8, 0) selected over the sform (audit 2026-11-24): narrowed to f32 its norm
        // exceeds 1; nifti-reader-js gives [[-0.28, 0.96, 0], [0.96, 0.28, 0], [0, 0, -1]] from the f64 header.
        let mut q = b.clone();
        q[344..348].copy_from_slice(&2i32.to_le_bytes());
        for (o, v) in [(104, 1.0), (352, 0.6), (360, 0.8)] {
            q[o..o + 8].copy_from_slice(&f64::to_le_bytes(v));
        }
        for o in [112, 120, 128] {
            q[o..o + 8].copy_from_slice(&1f64.to_le_bytes());
        }
        let close = |q: &[u8], expected: [[f64; 3]; 3]| {
            let affine = super::read(q).unwrap().affine;
            for (row, want) in affine.iter().zip(expected) {
                for (got, want) in row.iter().zip(want) {
                    assert!((got - want).abs() < 1e-6, "{affine:?}");
                }
            }
        };
        close(
            &q,
            [[-0.28, 0.96, 0.0], [0.96, 0.28, 0.0], [0.0, 0.0, -1.0]],
        );
        // A 180° rotation, b = c = sqrt(0.5): |q|^2 is 1 + 2e-16 in f64 (re-audit).
        for o in [352, 360] {
            q[o..o + 8].copy_from_slice(&0.5f64.sqrt().to_le_bytes());
        }
        close(&q, [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]]);
        // An empty lesion stored scaled: 100 * 0.01 - 1 is 0 in f64, but not with float32 scaling.
        empty[12..14].copy_from_slice(&2i16.to_le_bytes());
        empty[14..16].copy_from_slice(&8i16.to_le_bytes());
        empty[176..184].copy_from_slice(&0.01f64.to_le_bytes());
        empty[184..192].copy_from_slice(&(-1f64).to_le_bytes());
        empty.truncate(544);
        empty.extend_from_slice(&[100; 8]);
        assert_eq!(super::read_binary(&empty).unwrap().data, [0; 8]);
    }
}
