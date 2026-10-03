//! detect + load_all on the example tree: "drop your files" end to end.
#[path = "readers_common/mod.rs"]
mod common;
use common::*;
use fida::io::detect::{detect, load_all, Format, LoadOptions, NamedFile};
use std::path::{Path, PathBuf};

fn walk(root: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = std::fs::read_dir(root.join(rel)) else { return };
    let mut ents: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    ents.sort_by_key(|e| e.file_name());
    for e in ents {
        let name = e.file_name().to_string_lossy().into_owned();
        let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let p = e.path();
        if p.is_dir() {
            walk(root, &r, out);
        } else {
            out.push((r, p));
        }
    }
}

#[test]
fn detect_example_tree() {
    let Some(dir) = data_dir("detect_example_tree") else { return };
    let mut paths = Vec::new();
    for sub in ["Siemens/sample01_megapress", "GE/sample01_press", "Bruker/sample01_press", "Philips", "LCModel", "RDA", "NIfTI-MRS"] {
        walk(&dir, sub, &mut paths);
    }
    if paths.is_empty() {
        skip("example tree not found");
        return;
    }
    let data: Vec<(String, Vec<u8>)> = paths.iter().map(|(r, p)| (r.clone(), std::fs::read(p).unwrap())).collect();
    let files: Vec<NamedFile> = data.iter().map(|(n, b)| NamedFile { name: n, bytes: b }).collect();
    let det = detect(&files);
    let name = |i: usize| files[i].name.to_string();
    let mut pairs: Vec<(Format, String, Option<String>)> = det
        .pairs
        .iter()
        .map(|p| (p.metabolite.format, name(p.metabolite.files[0]), p.water.as_ref().map(|w| name(w.files[0]))))
        .collect();
    pairs.sort_by(|a, b| a.1.cmp(&b.1));
    for p in &pairs {
        eprintln!("{p:?}");
    }
    let pair_of = |m: &str| pairs.iter().find(|p| p.1.ends_with(m)).map(|p| p.2.clone()).unwrap_or_else(|| panic!("{m} not detected"));
    assert!(pair_of("megapress/megapressDLPFC.dat").unwrap().ends_with("megapress_w/megapressDLPFC_w.dat"));
    assert!(pair_of("press/acqp").unwrap().starts_with("Bruker/sample01_press/press_w/"));
    assert!(pair_of("P17920.7").is_none());
    assert!(pair_of("philips_spar_sdat_WS.SDAT").unwrap().ends_with("philips_spar_sdat_W.SDAT"));
    assert!(pair_of("ge_press.RAW").unwrap().ends_with("ge_press.H2O"));
    assert!(pair_of("NIfTI-MRS/ge_press.nii.gz").unwrap().ends_with("ge_press_ref.nii.gz"));
    // No twix or P-file is ignored (Bruker's press_w/spectrum.dat is a text export, not twix).
    assert!(det.ignored.iter().all(|(n, _)| !n.starts_with("Siemens/") && !n.starts_with("GE/")), "{:?}", det.ignored);

    let (_, loaded) = load_all(&files, &LoadOptions::default());
    for (p, (m, w)) in det.pairs.iter().zip(loaded.iter()) {
        let m = m.as_ref().unwrap_or_else(|e| panic!("{}: {e}", name(p.metabolite.files[0])));
        if let Some(w) = w {
            w.as_ref().unwrap_or_else(|e| panic!("water of {}: {e}", name(p.metabolite.files[0])));
        }
        if name(p.metabolite.files[0]).ends_with("megapressDLPFC.dat") {
            let r = reference(&dir, "twix_megapress").unwrap();
            // the default (intended 'vd' handling) equals FID-A on a VB file
            compare("detect twix_megapress", &m.out, &r, &[]);
        }
        if name(p.metabolite.files[0]).ends_with("P17920.7") {
            let r = reference(&dir, "ge_press_wref").unwrap();
            compare("detect ge_press water frames", m.embedded_water.as_ref().unwrap(), &r, &[]);
        }
    }
}
