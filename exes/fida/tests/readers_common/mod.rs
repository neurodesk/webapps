//! Comparison of a Rust reader result with FID-A's (exported by
//! validation/export_readers.m into $FIDA_TEST_DATA/ref).
#![allow(dead_code)]

use fida::Spectra;
use serde_json::Value;
use std::path::PathBuf;

#[path = "../common/skip.rs"]
mod skip;
pub use skip::skip;

/// `$FIDA_TEST_DATA`, or None (see `skip`) when it is not set.
pub fn data_dir(test: &str) -> Option<PathBuf> {
    let d = std::env::var_os("FIDA_TEST_DATA").map(PathBuf::from);
    if d.is_none() {
        skip(&format!("{test}: FIDA_TEST_DATA is not set"));
    }
    d
}

/// Read an input file, or None (see `skip`) when it is absent.
pub fn input(dir: &PathBuf, rel: &str) -> Option<Vec<u8>> {
    let p = dir.join(rel);
    let b = std::fs::read(&p).ok();
    if b.is_none() {
        skip(&format!("{} not found", p.display()));
    }
    b
}

pub struct Reference {
    pub h: Value,
    pub fids: Vec<(f64, f64)>,
}

pub fn reference(dir: &PathBuf, name: &str) -> Option<Reference> {
    reference_in(dir, "ref", name)
}

/// A reference from another export directory (e.g. `ref_vfix`), or None
/// (see `skip`) when it is absent.
pub fn reference_in(dir: &PathBuf, sub: &str, name: &str) -> Option<Reference> {
    let r = optional_reference(dir, sub, name);
    if r.is_none() {
        skip(&format!("reference {sub}/{name} not found in {}", dir.display()));
    }
    r
}

/// FID-A's FAILED list in an export directory: the cases its reader errors on.
pub fn fida_failed(dir: &PathBuf, sub: &str, name: &str) -> bool {
    std::fs::read_to_string(dir.join(sub).join("FAILED")).unwrap_or_default().lines().any(|l| l == name)
}

/// A reference that may legitimately not exist (a water reference).
pub fn optional_reference(dir: &PathBuf, sub: &str, name: &str) -> Option<Reference> {
    let j = dir.join(sub).join(format!("{name}.json"));
    let b = dir.join(sub).join(format!("{name}.bin"));
    let (Ok(js), Ok(bin)) = (std::fs::read_to_string(&j), std::fs::read(&b)) else {
        return None;
    };
    let h: Value = serde_json::from_str(&js).expect("reference json");
    let fids = bin
        .chunks_exact(16)
        .map(|c| (f64::from_le_bytes(c[..8].try_into().unwrap()), f64::from_le_bytes(c[8..].try_into().unwrap())))
        .collect();
    Some(Reference { h, fids })
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Array(a) if a.len() == 1 => num(&a[0]),
        _ => None,
    }
}

fn vec_of(v: &Value) -> Vec<f64> {
    match v {
        Value::Array(a) => a.iter().map(|x| num(x).unwrap_or(f64::NAN)).collect(),
        other => vec![num(other).unwrap_or(f64::NAN)],
    }
}

fn close(a: f64, b: f64, rel: f64) -> bool {
    a == b || (a - b).abs() <= rel * a.abs().max(b.abs()) || (a.is_nan() && b.is_nan())
}

/// Report of one comparison.
pub struct Cmp {
    pub fids_rel: f64,
    pub ppm_rel: f64,
    pub t_rel: f64,
}

/// Compare everything FID-A exported; panics with the list of mismatches.
/// `skip` names header fields not to compare.
pub fn compare(name: &str, s: &Spectra, r: &Reference, skip: &[&str]) -> Cmp {
    let mut bad: Vec<String> = Vec::new();
    let h = &r.h;
    let sz: Vec<usize> = vec_of(&h["sz"]).iter().map(|&x| x as usize).collect();
    if s.sz != sz {
        bad.push(format!("sz {:?} vs FID-A {:?}", s.sz, sz));
    }
    let d = &h["dims"];
    let dims = [
        ("t", s.dims.t),
        ("coils", s.dims.coils),
        ("averages", s.dims.averages),
        ("subSpecs", s.dims.sub_specs),
        ("extras", s.dims.extras),
    ];
    for (k, v) in dims {
        let want = num(&d[k]).unwrap_or(0.0) as usize;
        if v != want {
            bad.push(format!("dims.{k} {v} vs FID-A {want}"));
        }
    }
    let mut fids_rel = f64::NAN;
    if s.fids.len() != r.fids.len() {
        bad.push(format!("fids length {} vs FID-A {}", s.fids.len(), r.fids.len()));
    } else {
        let mut maxabs: f64 = 0.0;
        let mut maxdiff: f64 = 0.0;
        for (a, b) in s.fids.iter().zip(r.fids.iter()) {
            maxabs = maxabs.max((b.0 * b.0 + b.1 * b.1).sqrt());
            maxdiff = maxdiff.max(((a.re - b.0).powi(2) + (a.im - b.1).powi(2)).sqrt());
        }
        fids_rel = if maxabs > 0.0 { maxdiff / maxabs } else { maxdiff };
        if !(fids_rel < 1e-6) {
            bad.push(format!("fids max |diff|/max|fids| = {fids_rel:e}"));
        }
    }
    let axis = |ours: &[f64], key: &str, bad: &mut Vec<String>| -> f64 {
        let theirs = vec_of(&h[key]);
        if ours.len() != theirs.len() {
            bad.push(format!("{key} length {} vs FID-A {}", ours.len(), theirs.len()));
            return f64::NAN;
        }
        let mut m: f64 = 0.0;
        for (a, b) in ours.iter().zip(theirs.iter()) {
            let e = if a == b { 0.0 } else { (a - b).abs() / a.abs().max(b.abs()).max(1e-300) };
            m = m.max(e);
        }
        if m > 1e-12 {
            bad.push(format!("{key} max relative difference {m:e}"));
        }
        m
    };
    let ppm_rel = axis(&s.ppm, "ppm", &mut bad);
    let t_rel = axis(&s.t, "t", &mut bad);
    let fields: [(&str, f64); 11] = [
        ("spectralwidth", s.spectralwidth),
        ("dwelltime", s.dwelltime),
        ("txfrq", s.txfrq),
        ("te", s.te),
        ("tr", s.tr),
        ("Bo", s.bo),
        ("averages", s.averages as f64),
        ("rawAverages", s.raw_averages as f64),
        ("subspecs", s.subspecs as f64),
        ("rawSubspecs", s.raw_subspecs as f64),
        ("pointsToLeftshift", s.points_to_leftshift),
    ];
    for (k, v) in fields {
        if skip.contains(&k) {
            continue;
        }
        match &h[k] {
            Value::Null => {
                if !h.as_object().map(|o| o.contains_key(k)).unwrap_or(false) {
                    continue; // FID-A did not set it
                }
                bad.push(format!("{k}: FID-A value is not numeric, ours {v}"));
            }
            x => {
                let w = num(x).unwrap_or(f64::NAN);
                if !close(v, w, 1e-14) {
                    bad.push(format!("{k} {v} vs FID-A {w}"));
                }
            }
        }
    }
    if !skip.contains(&"seq") {
        if let Some(seq) = h.get("seq").and_then(|v| v.as_str()) {
            if s.seq != seq {
                bad.push(format!("seq {:?} vs FID-A {:?}", s.seq, seq));
            }
        }
    }
    if let Some(fl) = h.get("flags").and_then(|v| v.as_object()) {
        let f = &s.flags;
        let ours = [
            ("writtentostruct", f.writtentostruct),
            ("gotparams", f.gotparams),
            ("leftshifted", f.leftshifted),
            ("filtered", f.filtered),
            ("zeropadded", f.zeropadded),
            ("freqcorrected", f.freqcorrected),
            ("phasecorrected", f.phasecorrected),
            ("averaged", f.averaged),
            ("addedrcvrs", f.addedrcvrs),
            ("subtracted", f.subtracted),
            ("writtentotext", f.writtentotext),
            ("downsampled", f.downsampled),
            ("avgNormalized", f.avg_normalized),
            ("isFourSteps", f.is_four_steps),
        ];
        for (k, v) in ours {
            if let Some(x) = fl.get(k) {
                let w = num(x).unwrap_or(0.0) != 0.0;
                if v != w {
                    bad.push(format!("flags.{k} {v} vs FID-A {w}"));
                }
            }
        }
    }
    eprintln!("{name}: fids rel {fids_rel:e}, ppm rel {ppm_rel:e}, t rel {t_rel:e}");
    if !bad.is_empty() {
        panic!("{name} differs from FID-A:\n  {}", bad.join("\n  "));
    }
    Cmp { fids_rel, ppm_rel, t_rel }
}
