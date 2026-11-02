//! FreeSurfer binary surfaces (`fs_read_surf`: triangle and quad files), curvature
//! files (`fs_read_curv`: new float32 and old int16/100 formats) and ASCII labels
//! (`Read_FreeSurfer` / `samsrf_loadlabel`). All big-endian.

use crate::error::Result;
use crate::surface::{Anatomy, Label, Surface};

pub fn read_surface(bytes: &[u8]) -> Result<Surface> {
    let _ = bytes;
    Err(crate::Error::NotImplemented("freesurfer::read_surface"))
}

pub fn read_curv(bytes: &[u8]) -> Result<Vec<f64>> {
    let _ = bytes;
    Err(crate::Error::NotImplemented("freesurfer::read_curv"))
}

/// Parses a `.label` file: a comment line, the vertex count, then one vertex per line
/// (`index x y z value`). Indices stay 0-based.
pub fn read_label(text: &str) -> Result<Label> {
    let _ = text;
    Err(crate::Error::NotImplemented("freesurfer::read_label"))
}

/// The files `samsrf_gii2srf` reads from a `surf` folder for one hemisphere. The
/// caller supplies bytes (it owns file access); `thickness` may be absent.
pub struct AnatomyFiles<'a> {
    pub white: &'a [u8],
    pub pial: &'a [u8],
    pub inflated: &'a [u8],
    pub sphere: &'a [u8],
    pub curv: &'a [u8],
    pub area: &'a [u8],
    pub thickness: Option<&'a [u8]>,
}

/// Reads the folder and checks every file has the white surface's vertex count.
pub fn read_anatomy(files: &AnatomyFiles<'_>) -> Result<Anatomy> {
    let _ = files;
    Err(crate::Error::NotImplemented("freesurfer::read_anatomy"))
}
