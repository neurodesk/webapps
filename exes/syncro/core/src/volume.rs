//! NIfTI-1 scalar volumes. Reading is SynthSR's port of `readVolume` (`exes/synthsr/src/nifti.rs`, shared by
//! path so both read identical geometry); writing mirrors `writeVolume` in packages/synthsr/src/volume.js.

#[path = "../../../synthsr/src/nifti.rs"]
#[allow(dead_code)]
mod synthsr_nifti;

pub use synthsr_nifti::{Affine, Volume, read};

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

/// `readAdditional(buffer, 'binary')`: at most two distinct finite values (after scaling, compared in f64). With
/// two, the larger is the lesion; with one, any nonzero value is.
pub fn read_binary(bytes: &[u8]) -> Result<Volume<u8>, String> {
    let geometry = read(bytes)?;
    let raw = gunzip(bytes)?;
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
