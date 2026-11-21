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

/// A NIfTI-2 image as NIfTI-1 in the same byte order, voxels untouched (affines rounded to float32, as every
/// tool-facing file is); anything else unchanged.
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
    let real = |o: usize| f64::from_bits(int(o, 8) as u64) as f32;
    let mut h = vec![0u8; 352];
    let mut put = |o: usize, b: &[u8]| h[o..o + b.len()].copy_from_slice(&order(b.to_vec()));
    put(0, &348i32.to_le_bytes());
    put(70, &(int(12, 2) as i16).to_le_bytes());
    put(72, &(int(14, 2) as i16).to_le_bytes());
    for a in 0..8 {
        let d = i16::try_from(int(16 + 8 * a, 8)).map_err(|_| "Unsupported image dimensions.")?;
        put(40 + 2 * a, &d.to_le_bytes());
        put(76 + 4 * a, &real(104 + 8 * a).to_le_bytes());
    }
    put(108, &352f32.to_le_bytes());
    put(112, &real(176).to_le_bytes());
    put(116, &real(184).to_le_bytes());
    put(252, &(int(344, 4) as i16).to_le_bytes());
    put(254, &(int(348, 4) as i16).to_le_bytes());
    // quatern_b..qoffset_z, then the three sform rows: f64 runs in NIfTI-2, f32 in NIfTI-1.
    for k in 0..18 {
        put(256 + 4 * k, &real(352 + 8 * k).to_le_bytes());
    }
    h[123] = raw[500 + if le { 0 } else { 3 }];
    h[344..348].copy_from_slice(b"n+1\0");
    let offset = usize::try_from(int(168, 8)).map_err(|_| "The NIfTI voxel data is truncated.")?;
    h.extend_from_slice(
        raw.get(offset..)
            .ok_or("The NIfTI voxel data is truncated.")?,
    );
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
        let v = super::read(&b).unwrap();
        assert_eq!(v.dims, [2, 2, 2]);
        assert_eq!(v.data, (1..=8).map(|v| v as f32).collect::<Vec<_>>());
        assert_eq!(v.affine, sform);
    }
}
