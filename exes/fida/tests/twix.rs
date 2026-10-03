//! io_loadspec_twix against FID-A.
//!
//! Each file is checked twice: with `octave_version_quirk` against FID-A as
//! it runs in Octave (`ref/`), and with the default options against FID-A with
//! the `version` assignment fixed (`ref_vfix/`, validation/README.md).
#[path = "readers_common/mod.rs"]
mod common;
use common::*;
use fida::io::twix::{load_with, TwixOptions};

fn check(name: &str, sub: &str, bytes: &[u8], opts: TwixOptions, dir: &std::path::PathBuf) {
    let t0 = std::time::Instant::now();
    let res = load_with(bytes, opts);
    if fida_failed(dir, sub, name) {
        // FID-A failed on this file: so must we
        if let Ok(x) = &res {
            panic!("{name} ({sub}): FID-A errors on this file but we read sz {:?}", x.out.sz);
        }
        return;
    }
    let Some(r) = reference_in(dir, sub, name) else { return };
    let res = res.unwrap_or_else(|e| panic!("{name} ({sub}): {e}"));
    eprintln!("{name} ({sub}): read {} MB in {:?}", bytes.len() / 1_000_000, t0.elapsed());
    compare(&format!("{name} ({sub})"), &res.out, &r, &[]);
    match (optional_reference(dir, sub, &format!("{name}_wref")), &res.out_w) {
        (Some(rw), Some(w)) => {
            compare(&format!("{name}_wref ({sub})"), w, &rw, &[]);
        }
        (None, None) => {}
        (Some(_), None) => panic!("{name}: FID-A found a water reference and we did not"),
        (None, Some(_)) => panic!("{name}: we found a water reference and FID-A did not"),
    }
}

fn case(name: &str, rel: &str) {
    let Some(dir) = data_dir(name) else { return };
    let Some(bytes) = input(&dir, rel) else { return };
    check(name, "ref", &bytes, TwixOptions { octave_version_quirk: true }, &dir);
    check(name, "ref_vfix", &bytes, TwixOptions::default(), &dir);
}

#[test]
fn twix_megapress() {
    case("twix_megapress", "Siemens/sample01_megapress/megapress/megapressDLPFC.dat");
}

#[test]
fn twix_megapress_w() {
    case("twix_megapress_w", "Siemens/sample01_megapress/megapress_w/megapressDLPFC_w.dat");
}

#[test]
fn twix_special() {
    case("twix_special", "Siemens/sample02_special/special/specialDLPFC.dat");
}

#[test]
fn twix_special_w() {
    case("twix_special_w", "Siemens/sample02_special/special_w/specialDLPFC_w.dat");
}

/// VB example files rewritten in the VD multi-RAID layout by
/// validation/twix_vb_to_vd.py (FID-A takes its 'vd' code paths).
#[test]
fn twixvd_megapress() {
    case("twixvd_megapress", "SiemensVD/megapress_vd.dat");
}

#[test]
fn twixvd_special_w() {
    case("twixvd_special_w", "SiemensVD/special_w_vd.dat");
}

/// Sequence-renamed variants (validation/twix_rename_seq.py, VB and VD) that
/// drive every sequence family io_loadspec_twix distinguishes. Where FID-A
/// errors (recorded in FAILED) we must error too.
#[test]
fn twix_sequence_families() {
    let Some(dir) = data_dir("twix_sequence_families") else { return };
    let Ok(rd) = std::fs::read_dir(dir.join("SiemensSeq")) else {
        skip("no SiemensSeq directory");
        return;
    };
    let mut names: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    for f in names {
        let Some(stem) = f.strip_suffix(".dat") else { continue };
        let name = format!("twix_{stem}");
        let bytes = std::fs::read(dir.join("SiemensSeq").join(&f)).unwrap();
        // FID-A's out_w isFourSteps line names an undefined variable
        // (out_wop_pl); we compute the flag instead of failing.
        if name == "twix_vd_svs_slaser_cu" {
            check(&name, "ref", &bytes, TwixOptions { octave_version_quirk: true }, &dir);
            let r = load_with(&bytes, TwixOptions::default()).expect("Columbia sLASER, vd");
            assert!(r.out_w.is_some());
            continue;
        }
        check(&name, "ref", &bytes, TwixOptions { octave_version_quirk: true }, &dir);
        check(&name, "ref_vfix", &bytes, TwixOptions::default(), &dir);
    }
}

/// Truncating a real file must give an error or a shorter result, never a panic.
#[test]
fn twix_truncated() {
    let Some(dir) = data_dir("twix_truncated") else { return };
    let Some(bytes) = input(&dir, "Siemens/sample01_megapress/megapress_w/megapressDLPFC_w.dat") else { return };
    for cut in [10usize, 1000, 600_000, bytes.len() / 2, bytes.len() - 7] {
        let _ = fida::io::twix::load(&bytes[..cut]);
    }
}
