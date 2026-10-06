//! io_loadspec_bruk against FID-A on the FID-A Bruker example (PV 5.1).
#[path = "readers_common/mod.rs"]
mod common;
use common::*;
use std::path::Path;

fn scan(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut v = Vec::new();
    for f in ["acqp", "method", "fid", "fid.raw", "fid.ref", "rawdata.job0", "fid.refscan", "pdata/1/fid_refscan.64"] {
        if let Ok(b) = std::fs::read(dir.join(f)) {
            v.push((f.to_string(), b));
        }
    }
    v
}

fn case(name: &str, rel: &str) {
    let Some(dir) = data_dir(name) else { return };
    let files = scan(&dir.join(rel));
    if files.is_empty() {
        skip(&format!("{rel} not found"));
        return;
    }
    let Some(r) = reference(&dir, name) else { return };
    let view: Vec<(String, &[u8])> = files.iter().map(|(n, b)| (n.clone(), b.as_slice())).collect();
    let res = fida::io::bruker::load(&view, true, 68).expect("bruker");
    compare(name, &res.out, &r, &[]);
    let rw = reference(&dir, &format!("{name}_wref")).expect("FID-A found reference scans");
    compare(&format!("{name}_wref"), res.ref_scan.as_ref().expect("reference scans"), &rw, &[]);

    // rawData='n': FID-A errors (undefined variable); we read the combined fid
    let n = fida::io::bruker::load(&view, false, 68).expect("combined fid");
    assert_eq!(n.out.sz, vec![res.out.sz[0], 1]);
    assert!(n.out.flags.averaged);
    let failed = std::fs::read_to_string(dir.join("ref/FAILED")).unwrap_or_default();
    if name == "bruker_press" {
        assert!(failed.lines().any(|l| l == "bruker_press_n"), "FID-A's rawData='n' failure should be recorded");
    }
}

#[test]
fn bruker_press() {
    case("bruker_press", "Bruker/sample01_press/press");
}

#[test]
fn bruker_press_w() {
    case("bruker_press_w", "Bruker/sample01_press/press_w");
}
