//! Compares the port with DIPY 1.12.1 Patch2Self version 1 on the ds005134 slab (67 × 92 × 10 ×
//! 137). DWIDENOISE_ORACLE names the dataset's `dwidenoise/validation` directory; the input is
//! read from `../../noddi/examples` next to it, or from DWIDENOISE_INPUT (a `.nii.gz` with its
//! `.bval` beside it). Without DWIDENOISE_ORACLE the test is skipped.

use std::io::Read;
use std::path::{Path, PathBuf};

const ORACLE: &str = "sub-01_dir-AP_desc-slabpatch2self_dwi.nii.gz";
const INPUT: &str = "sub-01_dir-AP_desc-slab_dwi.nii.gz";

struct Nifti {
    dims: [usize; 4],
    data: Vec<f64>,
}

fn i16_at(b: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([b[o], b[o + 1]])
}

fn f32_at(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// A little-endian NIfTI-1 `.nii.gz` with int16, uint16, int32, float32 or float64 voxels.
fn read_nifti(path: &Path) -> Nifti {
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(
        i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        348
    );
    let ndim = i16_at(&bytes, 40) as usize;
    let mut dims = [1usize; 4];
    for (d, dim) in dims.iter_mut().enumerate().take(ndim.min(4)) {
        *dim = i16_at(&bytes, 42 + 2 * d) as usize;
    }
    let datatype = i16_at(&bytes, 70);
    let offset = (f32_at(&bytes, 108) as usize).max(352);
    let (slope, inter) = (f32_at(&bytes, 112), f32_at(&bytes, 116));
    let count: usize = dims.iter().product();
    let raw = &bytes[offset..];
    let data: Vec<f64> = match datatype {
        4 => raw
            .chunks_exact(2)
            .take(count)
            .map(|c| f64::from(i16::from_le_bytes([c[0], c[1]])))
            .collect(),
        512 => raw
            .chunks_exact(2)
            .take(count)
            .map(|c| f64::from(u16::from_le_bytes([c[0], c[1]])))
            .collect(),
        8 => raw
            .chunks_exact(4)
            .take(count)
            .map(|c| f64::from(i32::from_le_bytes([c[0], c[1], c[2], c[3]])))
            .collect(),
        16 => raw
            .chunks_exact(4)
            .take(count)
            .map(|c| f64::from(f32::from_le_bytes([c[0], c[1], c[2], c[3]])))
            .collect(),
        64 => raw
            .chunks_exact(8)
            .take(count)
            .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
            .collect(),
        other => panic!("unsupported NIfTI datatype {other}"),
    };
    assert_eq!(data.len(), count);
    let data = if slope != 0.0 && slope.is_finite() && (slope != 1.0 || inter != 0.0) {
        data.iter()
            .map(|v| v * f64::from(slope) + f64::from(inter))
            .collect()
    } else {
        data
    };
    Nifti { dims, data }
}

#[test]
fn matches_dipy_patch2self_v1_on_the_slab() {
    let Ok(dir) = std::env::var("DWIDENOISE_ORACLE") else {
        eprintln!("DWIDENOISE_ORACLE is not set; skipping");
        return;
    };
    let dir = PathBuf::from(dir);
    let input_path = std::env::var("DWIDENOISE_INPUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dir.join("../../noddi/examples").join(INPUT));
    let bval_path = PathBuf::from(input_path.to_str().unwrap().replace(".nii.gz", ".bval"));
    let input = read_nifti(&input_path);
    let oracle = read_nifti(&dir.join(ORACLE));
    assert_eq!(input.dims, oracle.dims);
    let bvals: Vec<f64> = std::fs::read_to_string(&bval_path)
        .unwrap()
        .split_whitespace()
        .map(|s| s.parse().unwrap())
        .collect();
    let nvox = input.dims[0] * input.dims[1] * input.dims[2];
    assert_eq!(bvals.len(), input.dims[3]);

    let start = std::time::Instant::now();
    let mut ours = input.data.clone();
    dwi_denoise::denoise(&mut ours, nvox, &bvals).unwrap();
    eprintln!(
        "f64 storage: {nvox} voxels × {} volumes in {:?}",
        bvals.len(),
        start.elapsed()
    );

    let mut ours32: Vec<f32> = input.data.iter().map(|&v| v as f32).collect();
    dwi_denoise::denoise(&mut ours32, nvox, &bvals).unwrap();

    let max = oracle.data.iter().copied().fold(f64::MIN, f64::max);
    let min = oracle.data.iter().copied().fold(f64::MAX, f64::min);
    let (mut worst, mut worst32, mut over) = (0.0f64, 0.0f64, 0usize);
    for ((&got, &got32), &want) in ours.iter().zip(&ours32).zip(&oracle.data) {
        // The oracle is the float64 result stored as float32: allow one f32 ulp of it.
        let want32 = want as f32;
        let ulp = f64::from(f32::from_bits(want32.abs().to_bits() + 1) - want32.abs());
        worst = worst.max((got - want).abs());
        worst32 = worst32.max((f64::from(got32) - want).abs());
        if (got - want).abs() > ulp + 1e-9 * (max - min) {
            over += 1;
        }
    }
    eprintln!(
        "max |f64 port - oracle| {worst:.3e} ({:.2e} of range), max |f32 port - oracle| \
         {worst32:.3e}, beyond one f32 ulp: {over}",
        worst / (max - min)
    );
    assert_eq!(over, 0);
}
