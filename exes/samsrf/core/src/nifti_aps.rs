//! Volumetric apertures (`MakeApsMat.m`, NIfTI branch): a 3-D image whose first two
//! dimensions are the aperture rows and columns and whose third is the frame. The
//! voxel array in file order is the MATLAB `ApFrm` column-major array
//! (`spm_read_vols`), scaled by `scl_slope` / `scl_inter` when the slope is non-zero.
//! Accepts `.nii` and gzip-compressed `.nii.gz` bytes.

use crate::apertures::Apertures;
use crate::error::Result;

pub fn read_apertures(bytes: &[u8]) -> Result<Apertures> {
    let _ = bytes;
    Err(crate::Error::NotImplemented("nifti_aps::read_apertures"))
}
