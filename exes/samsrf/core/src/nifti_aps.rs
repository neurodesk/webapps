//! Volumetric apertures (`MakeApsMat.m`, NIfTI branch): a 3-D image whose first two
//! dimensions are the aperture rows and columns and whose third is the frame. The
//! voxel array in file order is the MATLAB `ApFrm` column-major array
//! (`spm_read_vols`), scaled by `scl_slope` / `scl_inter` when the slope is non-zero.
//! Accepts `.nii` and gzip-compressed `.nii.gz` bytes.

use crate::apertures::Apertures;
use crate::error::{Error, Result};
use neurodesk_nifti::Nifti1Header;
use std::borrow::Cow;

const HEADER_LEN: usize = 348;

fn format_error(message: impl Into<String>) -> Error {
    Error::format("NIfTI", message)
}

pub fn read_apertures(bytes: &[u8]) -> Result<Apertures> {
    let bytes: Cow<[u8]> = if bytes.starts_with(&[0x1f, 0x8b]) {
        Cow::Owned(crate::gifti::inflate(bytes, usize::MAX).map_err(format_error)?)
    } else {
        Cow::Borrowed(bytes)
    };
    let raw_header: &[u8; HEADER_LEN] = bytes
        .get(..HEADER_LEN)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| format_error("file is shorter than a NIfTI-1 header"))?;
    let size = [raw_header[0], raw_header[1], raw_header[2], raw_header[3]];
    if i32::from_le_bytes(size) != 348 && i32::from_be_bytes(size) != 348 {
        return Err(format_error("not a NIfTI-1 file (sizeof_hdr is not 348)"));
    }
    let header = Nifti1Header::decode(raw_header);
    let rank = header.dim[0];
    if !(2..=7).contains(&rank) {
        return Err(format_error(format!("image has {rank} dimensions; apertures need rows x columns x frames")));
    }
    let dims = header.dim[1..=rank as usize]
        .iter()
        .map(|dim| usize::try_from(*dim).ok().filter(|dim| *dim > 0))
        .collect::<Option<Vec<usize>>>()
        .ok_or_else(|| format_error(format!("invalid dimensions {:?}", &header.dim[1..=rank as usize])))?;
    if dims.iter().skip(3).any(|dim| *dim != 1) {
        return Err(format_error(format!("image is {dims:?}; apertures need rows x columns x frames")));
    }
    let (height, width) = (dims[0], dims[1]);
    let volumes = dims.get(2).copied().unwrap_or(1);
    let (byte_width, decode) = header.scalar_decoder().map_err(format_error)?;
    let offset = header.vox_offset;
    if !(offset >= HEADER_LEN as f32 && offset.is_finite()) {
        return Err(format_error(format!("vox_offset {offset} is before the end of the header")));
    }
    let start = offset as usize;
    let end = dims
        .iter()
        .try_fold(byte_width, |length, dim| length.checked_mul(*dim))
        .and_then(|length| start.checked_add(length));
    let voxels = end
        .and_then(|end| bytes.get(start..end))
        .ok_or_else(|| format_error(format!("file ends before its {dims:?} voxels")))?;
    let slope = header.scl_slope as f64;
    let intercept = header.scl_inter as f64;
    let scaled = slope != 0.0 && slope.is_finite();
    let data: Vec<f64> = voxels
        .chunks_exact(byte_width)
        .map(|chunk| {
            let value = decode(chunk);
            if scaled {
                value * slope + intercept
            } else {
                value
            }
        })
        .collect();
    Apertures::from_dense(height, width, volumes, &data, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A little-endian NIfTI-1 single file whose data block is `voxels`.
    fn nifti(dims: &[i16], datatype: i16, voxels: &[u8], slope: f32, intercept: f32) -> Vec<u8> {
        let mut bytes = vec![0u8; 352];
        bytes[0..4].copy_from_slice(&348i32.to_le_bytes());
        bytes[40..42].copy_from_slice(&(dims.len() as i16).to_le_bytes());
        for (axis, dim) in dims.iter().enumerate() {
            bytes[42 + 2 * axis..44 + 2 * axis].copy_from_slice(&dim.to_le_bytes());
        }
        bytes[70..72].copy_from_slice(&datatype.to_le_bytes());
        bytes[108..112].copy_from_slice(&352f32.to_le_bytes());
        bytes[112..116].copy_from_slice(&slope.to_le_bytes());
        bytes[116..120].copy_from_slice(&intercept.to_le_bytes());
        bytes[344..348].copy_from_slice(b"n+1\0");
        bytes.extend_from_slice(voxels);
        bytes
    }

    fn movie() -> Vec<f64> {
        let mut data = vec![0.0; 4 * 6 * 2];
        data[1] = 1.0;
        data[24 + 23] = 0.5;
        data
    }

    #[test]
    fn float_image_is_the_column_major_movie() {
        let voxels: Vec<u8> = movie().iter().flat_map(|value| (*value as f32).to_le_bytes()).collect();
        let bytes = nifti(&[4, 6, 2], 16, &voxels, 0.0, 0.0);
        let expected = Apertures::from_dense(4, 6, 2, &movie(), None).expect("valid movie");
        assert_eq!(read_apertures(&bytes), Ok(expected.clone()));
        let gzipped = {
            let mut framed = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];
            framed.extend(miniz_oxide::deflate::compress_to_vec(&bytes, 6));
            framed.extend_from_slice(&[0; 8]);
            framed
        };
        assert_eq!(read_apertures(&gzipped), Ok(expected.clone()));
        let trailing = nifti(&[4, 6, 2, 1], 16, &voxels, 0.0, 0.0);
        assert_eq!(read_apertures(&trailing), Ok(expected));
    }

    #[test]
    fn scaled_integers_apply_slope_and_intercept() {
        let voxels: Vec<u8> = (0..24u8).map(|value| value % 3).collect();
        let bytes = nifti(&[4, 6, 1], 2, &voxels, 0.5, -0.5);
        let apertures = read_apertures(&bytes).expect("valid image");
        let expected: Vec<f64> = voxels.iter().map(|value| *value as f64 * 0.5 - 0.5).collect();
        assert_eq!(apertures.to_dense(), expected);
        let unscaled = read_apertures(&nifti(&[4, 6, 1], 2, &voxels, 0.0, 7.0)).expect("valid image");
        let raw: Vec<f64> = voxels.iter().map(|value| *value as f64).collect();
        assert_eq!(unscaled.to_dense(), raw);
    }

    #[test]
    fn refuses_truncated_four_d_and_foreign_files() {
        let voxels = vec![0u8; 24 * 4];
        let bytes = nifti(&[4, 6, 1], 16, &voxels, 0.0, 0.0);
        assert!(read_apertures(&bytes[..bytes.len() - 1]).is_err());
        assert!(read_apertures(&nifti(&[4, 6, 1, 2], 16, &voxels, 0.0, 0.0)).is_err());
        assert!(read_apertures(&nifti(&[5, 6, 1], 16, &voxels, 0.0, 0.0)).is_err());
        assert!(read_apertures(&[0; 400]).is_err());
        assert!(read_apertures(&[1, 2, 3]).is_err());
    }
}
