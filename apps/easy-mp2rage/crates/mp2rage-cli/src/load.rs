//! Unified input loader: a path is either a NIfTI file or a DICOM series folder.

use std::fs;

use ndarray::Array3;

use mp2rage_core::dicom;
use mp2rage_core::Affine;

use crate::nifti_io::read_nifti;

pub struct Vol {
    pub c0: Array3<f64>,          // first volume
    pub c1: Option<Array3<f64>>, // second volume (SA2RAGE)
    pub affine: Affine,
    pub role: Option<String>,    // detected role (DICOM only)
    pub nt: usize,
}

pub fn load(path: &str) -> Result<Vol, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    if meta.is_dir() {
        let mut files = Vec::new();
        let mut entries: Vec<_> = fs::read_dir(path).map_err(|e| e.to_string())?
            .filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_file()).collect();
        entries.sort();
        for p in entries {
            if let Ok(bytes) = fs::read(&p) {
                if let Ok(df) = dicom::parse(&bytes) {
                    files.push(df);
                }
            }
        }
        if files.is_empty() {
            return Err(format!("no readable DICOM files in {path}"));
        }
        let s = dicom::assemble(files)?;
        let comp = |t: usize| Array3::from_shape_fn((s.nx, s.ny, s.nz),
            |(i, j, k)| s.data[s.nx * s.ny * (k + s.nz * t) + i + s.nx * j] as f64);
        let nt = s.nt;
        Ok(Vol { c0: comp(0), c1: if nt > 1 { Some(comp(1)) } else { None }, affine: s.affine, role: Some(s.role), nt })
    } else {
        let v = read_nifti(path)?;
        let is4d = v.dims.len() >= 4 && v.dims[3] >= 2;
        Ok(Vol {
            c0: v.to_array3(),
            c1: if is4d { Some(v.component(1)) } else { None },
            affine: v.affine,
            role: None,
            nt: if is4d { 2 } else { 1 },
        })
    }
}
