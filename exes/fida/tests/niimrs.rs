//! io_loadspec_niimrs against FID-A (with the nii_tool shim of
//! validation/octave-shims) on every file in $FIDA_TEST_DATA/NIfTI-MRS.
#[path = "readers_common/mod.rs"]
mod common;
use common::*;

#[test]
fn niimrs_all() {
    let Some(dir) = data_dir("niimrs_all") else { return };
    let Ok(rd) = std::fs::read_dir(dir.join("NIfTI-MRS")) else {
        skip("no NIfTI-MRS directory");
        return;
    };
    let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let mut n = 0;
    for f in names {
        let case: String = f.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
        let name = format!("nii_{case}");
        let Some(r) = reference(&dir, &name) else { continue };
        let bytes = std::fs::read(dir.join("NIfTI-MRS").join(&f)).unwrap();
        let s = fida::io::niimrs::load(&bytes).unwrap_or_else(|e| panic!("{f}: {e}"));
        compare(&name, &s, &r, &[]);
        n += 1;
    }
    eprintln!("{n} NIfTI-MRS files compared");
}
