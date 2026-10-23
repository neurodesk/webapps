// SPDX-License-Identifier: Apache-2.0
//! NIfTI-1 single-file images (`.nii`, `.nii.gz`), little endian, read as f32.

use std::io::{Read, Write};

use rayon::prelude::*;

pub type Affine = [[f64; 4]; 4];

/// An image: its header bytes (kept for writing), dimensions, voxel sizes, affine and data
/// (NIfTI order, x fastest, volumes last), scaled by `scl_slope`/`scl_inter`.
#[derive(Clone, Debug)]
pub struct Image {
    pub header: Vec<u8>,
    pub dims: Vec<usize>,
    pub pixdim: [f64; 3],
    pub affine: Affine,
    pub intent_code: i16,
    pub data: Vec<f32>,
}

fn i16_at(h: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([h[o], h[o + 1]])
}

fn f32_at(h: &[u8], o: usize) -> f32 {
    f32::from_le_bytes([h[o], h[o + 1], h[o + 2], h[o + 3]])
}

fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    if raw.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::with_capacity(raw.len() * 3);
        flate2::read::MultiGzDecoder::new(&raw[..])
            .read_to_end(&mut out)
            .map_err(|e| format!("{path}: {e}"))?;
        Ok(out)
    } else {
        Ok(raw)
    }
}

/// Byte-swaps a big-endian NIfTI-1 header to little endian, field by field.
fn swap_header(h: &mut [u8]) {
    let four: Vec<usize> = [0usize, 32, 56, 60, 64]
        .into_iter()
        .chain((76..108).step_by(4))
        .chain([108, 112, 116, 124, 128, 132, 136, 140, 144])
        .chain((256..328).step_by(4))
        .collect();
    for o in four {
        h[o..o + 4].reverse();
    }
    let two: Vec<usize> = [36usize]
        .into_iter()
        .chain((40..56).step_by(2))
        .chain([68, 70, 72, 74, 120, 252, 254])
        .collect();
    for o in two {
        h[o..o + 2].reverse();
    }
}

/// The NIfTI-1 header (little endian) equivalent to a NIfTI-2 header: the fields this crate
/// reads and writes. Dimensions must fit NIfTI-1's 16-bit fields.
fn nifti2_as_nifti1(h2: &[u8], big_endian: bool) -> Result<Vec<u8>, String> {
    let take = |o: usize, n: usize| -> Vec<u8> {
        let mut b = h2[o..o + n].to_vec();
        if big_endian {
            b.reverse();
        }
        b
    };
    let i16_ = |o: usize| i16::from_le_bytes(take(o, 2).try_into().unwrap());
    let i32_ = |o: usize| i32::from_le_bytes(take(o, 4).try_into().unwrap());
    let i64_ = |o: usize| i64::from_le_bytes(take(o, 8).try_into().unwrap());
    let f64_ = |o: usize| f64::from_le_bytes(take(o, 8).try_into().unwrap());
    let mut h = vec![0u8; 348];
    let put16 = |h: &mut Vec<u8>, o: usize, v: i16| h[o..o + 2].copy_from_slice(&v.to_le_bytes());
    let put32 = |h: &mut Vec<u8>, o: usize, v: f32| h[o..o + 4].copy_from_slice(&v.to_le_bytes());
    h[0..4].copy_from_slice(&348i32.to_le_bytes());
    for i in 0..8 {
        let d = i64_(16 + 8 * i);
        let d =
            i16::try_from(d).map_err(|_| format!("NIfTI-2 dimension {d} does not fit NIfTI-1."))?;
        put16(&mut h, 40 + 2 * i, d);
    }
    for (i, o) in [80usize, 88, 96].into_iter().enumerate() {
        put32(&mut h, 56 + 4 * i, f64_(o) as f32);
    }
    put16(&mut h, 68, i32_(504) as i16);
    put16(&mut h, 70, i16_(12));
    put16(&mut h, 72, i16_(14));
    for i in 0..8 {
        put32(&mut h, 76 + 4 * i, f64_(104 + 8 * i) as f32);
    }
    put32(&mut h, 108, i64_(168) as f32);
    put32(&mut h, 112, f64_(176) as f32);
    put32(&mut h, 116, f64_(184) as f32);
    h[123] = i32_(500) as u8;
    put16(&mut h, 252, i32_(344) as i16);
    put16(&mut h, 254, i32_(348) as i16);
    for i in 0..6 {
        put32(&mut h, 256 + 4 * i, f64_(352 + 8 * i) as f32);
    }
    for i in 0..12 {
        put32(&mut h, 280 + 4 * i, f64_(400 + 8 * i) as f32);
    }
    h[344..348].copy_from_slice(b"n+1\0");
    Ok(h)
}

/// Reads a NIfTI-1 image.
pub fn read(path: &str) -> Result<Image, String> {
    let (mut image, volumes) = read_series(path)?;
    image.data = volumes.concat();
    Ok(image)
}

/// Reads a NIfTI-1 image as one array per 3D volume (`Image::data` is left empty), without
/// holding the whole series twice.
pub fn read_series(path: &str) -> Result<(Image, Vec<Vec<f32>>), String> {
    let bytes = read_bytes(path)?;
    if bytes.len() < 348 {
        return Err(format!("{path} is not a NIfTI file."));
    }
    let first = [bytes[0], bytes[1], bytes[2], bytes[3]];
    let (mut header, big_endian) = match (i32::from_le_bytes(first), i32::from_be_bytes(first)) {
        (348, _) => (bytes[..348].to_vec(), false),
        (_, 348) => (bytes[..348].to_vec(), true),
        (540, _) | (_, 540) if bytes.len() >= 540 => {
            let big = i32::from_le_bytes(first) != 540;
            (nifti2_as_nifti1(&bytes[..540], big)?, big)
        }
        _ => return Err(format!("{path} is not a NIfTI-1 or NIfTI-2 file.")),
    };
    if big_endian
        && header.len() == 348
        && i32::from_le_bytes([header[0], header[1], header[2], header[3]]) != 348
    {
        swap_header(&mut header);
    }
    let h = &header[..];
    let ndim = i16_at(h, 40).clamp(1, 7) as usize;
    let dims: Vec<usize> = (1..=ndim)
        .map(|i| i16_at(h, 40 + 2 * i).max(1) as usize)
        .collect();
    let datatype = i16_at(h, 70);
    let pixdim = [1, 2, 3].map(|i| f32_at(h, 76 + 4 * i).abs() as f64);
    let offset = f32_at(h, 108) as usize;
    let mut slope = f32_at(h, 112);
    let inter = f32_at(h, 116);
    if slope == 0.0 || !slope.is_finite() {
        slope = 1.0;
    }
    let n: usize = dims.iter().product();
    let size = match datatype {
        2 | 256 => 1,
        4 | 512 => 2,
        8 | 16 | 768 => 4,
        64 => 8,
        _ => {
            return Err(format!(
                "{path}: NIfTI datatype {datatype} is not supported."
            ));
        }
    };
    let body = bytes
        .get(offset..offset + n * size)
        .ok_or_else(|| format!("{path} is shorter than its header says."))?;
    let per_volume = dims.iter().take(3).product::<usize>().max(1);
    let convert = |raw: &[u8]| -> f32 {
        let mut b = [0u8; 8];
        b[..raw.len()].copy_from_slice(raw);
        if big_endian {
            b[..raw.len()].reverse();
        }
        let v = match datatype {
            2 => b[0] as f32,
            256 => b[0] as i8 as f32,
            4 => i16::from_le_bytes([b[0], b[1]]) as f32,
            512 => u16::from_le_bytes([b[0], b[1]]) as f32,
            8 => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32,
            768 => u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32,
            16 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            _ => f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) as f32,
        };
        v * slope + inter
    };
    let volumes: Vec<Vec<f32>> = body
        .par_chunks(per_volume * size)
        .map(|chunk| chunk.chunks_exact(size).map(convert).collect())
        .collect();
    Ok((
        Image {
            header: h.to_vec(),
            dims,
            pixdim,
            affine: affine_of(h),
            intent_code: i16_at(h, 68),
            data: Vec::new(),
        },
        volumes,
    ))
}

fn affine_of(h: &[u8]) -> Affine {
    let mut a = [
        [0.0, 0.0, 0.0, 0.0],
        [0.0; 4],
        [0.0; 4],
        [0.0, 0.0, 0.0, 1.0],
    ];
    if i16_at(h, 254) > 0 {
        for (r, row) in a.iter_mut().take(3).enumerate() {
            for (c, v) in row.iter_mut().enumerate() {
                *v = f32_at(h, 280 + 16 * r + 4 * c) as f64;
            }
        }
        return a;
    }
    let p = [1, 2, 3].map(|i| f32_at(h, 76 + 4 * i) as f64);
    if i16_at(h, 252) > 0 {
        let (b, c, d) = (
            f32_at(h, 256) as f64,
            f32_at(h, 260) as f64,
            f32_at(h, 264) as f64,
        );
        let aa = (1.0 - (b * b + c * c + d * d)).max(0.0).sqrt();
        let qfac = if f32_at(h, 76) < 0.0 { -1.0 } else { 1.0 };
        let r = [
            [
                aa * aa + b * b - c * c - d * d,
                2.0 * (b * c - aa * d),
                2.0 * (b * d + aa * c),
            ],
            [
                2.0 * (b * c + aa * d),
                aa * aa + c * c - b * b - d * d,
                2.0 * (c * d - aa * b),
            ],
            [
                2.0 * (b * d - aa * c),
                2.0 * (c * d + aa * b),
                aa * aa + d * d - c * c - b * b,
            ],
        ];
        let scale = [p[0], p[1], qfac * p[2]];
        for i in 0..3 {
            for j in 0..3 {
                a[i][j] = r[i][j] * scale[j];
            }
            a[i][3] = f32_at(h, 268 + 4 * i) as f64;
        }
        return a;
    }
    for i in 0..3 {
        a[i][i] = p[i];
    }
    a
}

/// Writes float32 data with the header of `like` and dimensions `dims` (gzipped when the
/// name ends in `.gz`, in parallel members).
pub fn write(path: &str, like: &Image, dims: &[usize], data: &[f32]) -> Result<(), String> {
    write_series(path, like, dims, &[data])
}

/// Writes one array per 3D volume, gzipped (one member per volume, compressed in parallel)
/// when the name ends in `.gz`.
pub fn write_series(
    path: &str,
    like: &Image,
    dims: &[usize],
    volumes: &[&[f32]],
) -> Result<(), String> {
    let mut h = like.header.clone();
    h[40..42].copy_from_slice(&(dims.len() as i16).to_le_bytes());
    for i in 0..7 {
        let d = dims.get(i).copied().unwrap_or(1) as i16;
        h[42 + 2 * i..44 + 2 * i].copy_from_slice(&d.to_le_bytes());
    }
    h[70..72].copy_from_slice(&16i16.to_le_bytes());
    h[72..74].copy_from_slice(&32i16.to_le_bytes());
    h[108..112].copy_from_slice(&352f32.to_le_bytes());
    h[112..116].copy_from_slice(&1f32.to_le_bytes());
    h[116..120].copy_from_slice(&0f32.to_le_bytes());
    h[68..70].copy_from_slice(&0i16.to_le_bytes());
    let mut head = h;
    head.extend_from_slice(&[0, 0, 0, 0]);
    let bytes = |v: &[f32]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
    let file = std::fs::File::create(path).map_err(|e| format!("{path}: {e}"))?;
    let mut out = std::io::BufWriter::new(file);
    let fail = |e: std::io::Error| format!("{path}: {e}");
    if path.ends_with(".gz") {
        let gz = |raw: &[u8]| -> Vec<u8> {
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(4));
            e.write_all(raw).unwrap();
            e.finish().unwrap()
        };
        out.write_all(&gz(&head)).map_err(fail)?;
        // Compress a batch of volumes at a time, so that memory holds one batch.
        for batch in volumes.chunks(rayon::current_num_threads().max(1) * 2) {
            let members: Vec<Vec<u8>> = batch.par_iter().map(|v| gz(&bytes(v))).collect();
            for m in members {
                out.write_all(&m).map_err(fail)?;
            }
        }
    } else {
        out.write_all(&head).map_err(fail)?;
        for v in volumes {
            out.write_all(&bytes(v)).map_err(fail)?;
        }
    }
    out.flush().map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_big_endian_files() {
        let dir = std::env::temp_dir().join(format!("shoreline-nifti-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut header = vec![0u8; 348];
        header[0..4].copy_from_slice(&348i32.to_le_bytes());
        for (i, p) in [1.0f32, 2.0, 2.0, 2.5].iter().enumerate() {
            header[76 + 4 * i..80 + 4 * i].copy_from_slice(&p.to_le_bytes());
        }
        header[344..348].copy_from_slice(b"n+1\0");
        let like = Image {
            header,
            dims: vec![2, 3, 2],
            pixdim: [2.0, 2.0, 2.5],
            affine: [[0.0; 4]; 4],
            intent_code: 0,
            data: Vec::new(),
        };
        let values: Vec<f32> = (0..12).map(|v| v as f32 * 1.5 - 3.0).collect();
        let little = dir.join("little.nii");
        write(little.to_str().unwrap(), &like, &[2, 3, 2], &values).unwrap();
        // The same file in big endian: header fields and voxels swapped.
        let mut bytes = std::fs::read(&little).unwrap();
        let mut h = bytes[..348].to_vec();
        // Swapping a little-endian header gives the big-endian one (the swap is symmetric).
        swap_header(&mut h);
        bytes[..348].copy_from_slice(&h);
        for v in bytes[352..].chunks_exact_mut(4) {
            v.reverse();
        }
        let big = dir.join("big.nii");
        std::fs::write(&big, &bytes).unwrap();
        let image = read(big.to_str().unwrap()).unwrap();
        assert_eq!(image.dims, vec![2, 3, 2]);
        assert_eq!(image.pixdim, [2.0, 2.0, 2.5]);
        assert_eq!(image.data, values);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_nifti2_files() {
        let dir = std::env::temp_dir().join(format!("shoreline-nifti2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut h = vec![0u8; 544];
        h[0..4].copy_from_slice(&540i32.to_le_bytes());
        h[4..12].copy_from_slice(b"n+2\0\r\n\x1a\n");
        h[12..14].copy_from_slice(&16i16.to_le_bytes());
        h[14..16].copy_from_slice(&32i16.to_le_bytes());
        for (i, d) in [4i64, 3, 2, 2, 2, 1, 1, 1].iter().enumerate() {
            h[16 + 8 * i..24 + 8 * i].copy_from_slice(&d.to_le_bytes());
        }
        for (i, p) in [1.0f64, 2.0, 2.0, 2.5, 1.0, 0.0, 0.0, 0.0]
            .iter()
            .enumerate()
        {
            h[104 + 8 * i..112 + 8 * i].copy_from_slice(&p.to_le_bytes());
        }
        h[168..176].copy_from_slice(&544i64.to_le_bytes());
        h[176..184].copy_from_slice(&1.0f64.to_le_bytes());
        h[348..352].copy_from_slice(&1i32.to_le_bytes());
        let srow = [
            [-2.0f64, 0.0, 0.0, 10.0],
            [0.0, 2.0, 0.0, -5.0],
            [0.0, 0.0, 2.5, 3.0],
        ];
        for (r, row) in srow.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                let o = 400 + 32 * r + 8 * c;
                h[o..o + 8].copy_from_slice(&v.to_le_bytes());
            }
        }
        let values: Vec<f32> = (0..24).map(|v| v as f32 * 0.5).collect();
        for v in &values {
            h.extend_from_slice(&v.to_le_bytes());
        }
        let path = dir.join("two.nii");
        std::fs::write(&path, &h).unwrap();
        let (image, volumes) = read_series(path.to_str().unwrap()).unwrap();
        assert_eq!(image.dims, vec![3, 2, 2, 2]);
        assert_eq!(image.pixdim, [2.0, 2.0, 2.5]);
        assert_eq!(image.affine[0], [-2.0, 0.0, 0.0, 10.0]);
        assert_eq!(volumes.concat(), values);
        // Written back as NIfTI-1.
        let out = dir.join("one.nii");
        write(out.to_str().unwrap(), &image, &[3, 2, 2, 2], &values).unwrap();
        assert_eq!(read(out.to_str().unwrap()).unwrap().data, values);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
