//! Native CLI: NIfTI in -> MP2RAGE T1 mapping -> NIfTI out.
//! Mirrors the Python pipeline; sequence params default to the 7T protocol and
//! are overridable. Intended for validation and batch/native use (the browser
//! app uses the WASM core directly).

use std::collections::HashMap;
use std::process::exit;

use ndarray::Array3;

use mp2rage_cli::load::load;
use mp2rage_cli::nifti_io::write_nifti_f32;
use mp2rage_core::model::{Mp2rageParams, Sa2rageParams};
use mp2rage_core::pipeline::{run_b1map, run_sa2rage, Outputs};

fn usage() -> ! {
    eprintln!(
        "usage:\n  mp2rage-t1map --uni U.nii[.gz] --inv2 I.nii --sa2rage S.nii --out DIR\n  \
         mp2rage-t1map --uni U.nii --inv2 I.nii --b1-map B.nii [--b1-map-type tfl|percent|relative] \
         [--b1-ref-angle 80] [--b1-extend-fov] [--fallback-uncorrected] --out DIR\n\n\
         MP2RAGE params (defaults 7T): --mp-tr 4.3 --mp-ti 0.840 2.370 --mp-fa 5 6 \
         --mp-nz 64 128 --mp-trflash 0.007 --inv-eff 0.96\n\
         SA2RAGE params: --sa-tr 2.4 --sa-ti 0.150 1.500 --sa-fa 6 6 --sa-nz 24 24 \
         --sa-trflash 0.005 --sa-avgt1 1.5"
    );
    exit(2);
}

/// tiny flag parser: --key may take 1 or 2 following values.
fn parse() -> HashMap<String, Vec<String>> {
    let mut m: HashMap<String, Vec<String>> = HashMap::new();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(key) = a.strip_prefix("--") {
            let mut vals = Vec::new();
            while i + 1 < args.len() && !args[i + 1].starts_with("--") {
                vals.push(args[i + 1].clone());
                i += 1;
            }
            m.insert(key.to_string(), vals);
        }
        i += 1;
    }
    m
}

fn f(m: &HashMap<String, Vec<String>>, k: &str, i: usize, d: f64) -> f64 {
    m.get(k).and_then(|v| v.get(i)).map(|s| s.parse().unwrap()).unwrap_or(d)
}
fn path<'a>(m: &'a HashMap<String, Vec<String>>, k: &str) -> Option<&'a String> {
    m.get(k).and_then(|v| v.first())
}

fn save(dir: &str, name: &str, vol: &Array3<f64>, aff: &mp2rage_core::Affine) {
    std::fs::create_dir_all(dir).ok();
    let p = format!("{dir}/{name}");
    if let Err(e) = write_nifti_f32(&p, &vol.mapv(|v| v as f32), aff) {
        eprintln!("error writing {p}: {e}");
        exit(1);
    }
    println!("  wrote {p}");
}

/// Hidden self-test: read a DICOM folder, assemble, and write a derived series
/// using the assembled volume itself as the "T1" — so a pydicom round-trip can
/// confirm the writer preserves pixels + geometry.
fn dicom_selftest(dir: &str, outdir: &str) {
    use mp2rage_core::dicom;
    let mut paths: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok())
        .map(|e| e.path()).filter(|p| p.is_file()).collect();
    paths.sort();
    let dcm: Vec<Vec<u8>> = paths.iter().filter_map(|p| std::fs::read(p).ok())
        .filter(|b| dicom::parse(b).is_ok()).collect();
    let files: Vec<_> = dcm.iter().map(|b| dicom::parse(b).unwrap()).collect();
    let s = dicom::assemble(files).unwrap();
    println!("assembled [{},{},{},{}]", s.nx, s.ny, s.nz, s.nt);
    let sources: Vec<&[u8]> = dcm.iter().map(|b| b.as_slice()).collect();
    let t1: Vec<f32> = s.data[..s.nx * s.ny * s.nz].to_vec();
    let out = dicom::write_derived_series(&sources, &t1, s.nx, s.ny, s.nz, "97531", false).unwrap();
    std::fs::create_dir_all(outdir).unwrap();
    for (i, f) in out.iter().enumerate() {
        std::fs::write(format!("{outdir}/t1_{i:04}.dcm"), f).unwrap();
    }
    println!("wrote {} derived DICOM files to {outdir}", out.len());
}

fn main() {
    let m = parse();
    if let Some(st) = m.get("dicom-selftest") {
        if st.len() >= 2 {
            dicom_selftest(&st[0], &st[1]);
            return;
        }
    }
    let (uni_p, inv2_p, out) = match (path(&m, "uni"), path(&m, "inv2"), path(&m, "out")) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => usage(),
    };
    let fallback = m.contains_key("fallback-uncorrected");

    let mp = Mp2rageParams {
        tr: f(&m, "mp-tr", 0, 4.3),
        tis: (f(&m, "mp-ti", 0, 0.840), f(&m, "mp-ti", 1, 2.370)),
        flip: (f(&m, "mp-fa", 0, 5.0), f(&m, "mp-fa", 1, 6.0)),
        nz: (f(&m, "mp-nz", 0, 64.0), f(&m, "mp-nz", 1, 128.0)),
        flash_tr: f(&m, "mp-trflash", 0, 7.0e-3),
        inv_eff: f(&m, "inv-eff", 0, 0.96),
    };

    let load_ = |p: &str| load(p).unwrap_or_else(|e| {
        eprintln!("{e}");
        exit(1);
    });
    let uni_v = load_(uni_p);
    let inv2_v = load_(inv2_p);
    if let Some(r) = &uni_v.role {
        println!("  UNI input: {} (DICOM role detected: {r})", uni_p);
    }
    let uni = &uni_v.c0;
    let inv2 = &inv2_v.c0;

    let out_data: Outputs = if let Some(sa_p) = path(&m, "sa2rage") {
        let sa = Sa2rageParams {
            tr: f(&m, "sa-tr", 0, 2.4),
            tis: (f(&m, "sa-ti", 0, 0.150), f(&m, "sa-ti", 1, 1.500)),
            flip: (f(&m, "sa-fa", 0, 6.0), f(&m, "sa-fa", 1, 6.0)),
            nz: (f(&m, "sa-nz", 0, 24.0), f(&m, "sa-nz", 1, 24.0)),
            flash_tr: f(&m, "sa-trflash", 0, 5.0e-3),
            average_t1: f(&m, "sa-avgt1", 0, 1.5),
        };
        let sa_v = load_(sa_p);
        let s_b = match &sa_v.c1 {
            Some(v) => v,
            None => { eprintln!("SA2RAGE must be a 2-volume (S1,S2) image"); exit(1); }
        };
        println!("[SA2RAGE B1 source]");
        run_sa2rage(uni, inv2, &sa_v.c0, s_b, &uni_v.affine, &sa_v.affine, &mp, &sa, fallback)
    } else if let Some(b1_p) = path(&m, "b1-map") {
        let kind = m.get("b1-map-type").and_then(|v| v.first()).map(|s| s.as_str()).unwrap_or("tfl");
        let ref_angle = f(&m, "b1-ref-angle", 0, 80.0);
        let extend_fov = m.contains_key("b1-extend-fov");
        let b1_v = load_(b1_p);
        println!("[B1-map source: type={kind}, extend-fov={extend_fov}]");
        run_b1map(uni, inv2, &b1_v.c0, &uni_v.affine, &b1_v.affine, kind, ref_angle, &mp, extend_fov, fallback)
    } else {
        eprintln!("need --sa2rage or --b1-map");
        usage();
    };

    save(out, "T1map.nii.gz", &out_data.t1_corr, &uni_v.affine);
    save(out, "B1map.nii.gz", &out_data.b1, &uni_v.affine);
    save(out, "T1map_uncorrected.nii.gz", &out_data.t1_uncorr, &uni_v.affine);
    save(out, "UNI_b1corrected.nii.gz", &out_data.uni_corr, &uni_v.affine);
    let brain = out_data.mask.iter().filter(|&&b| b).count();
    println!("done. brain voxels: {brain}");
}
