//! Reading FID-A reference exports (validation/export_fida.m,
//! validation/export_values.m) back for the tests.
#![allow(dead_code)]

use fida::{Dims, Flags, Spectra};
use num_complex::Complex64 as C;
use serde_json::Value;
use std::path::{Path, PathBuf};

mod skip;
pub use skip::skip;

/// `$FIDA_TEST_DATA/ops/<sub>`, or None (see `skip`) when absent.
pub fn data_dir(sub: &str) -> Option<PathBuf> {
    let Some(root) = std::env::var_os("FIDA_TEST_DATA") else {
        skip(&format!("FIDA_TEST_DATA is not set ({sub})"));
        return None;
    };
    let d = PathBuf::from(root).join("ops").join(sub);
    if !d.is_dir() {
        skip(&format!("{} is missing", d.display()));
        return None;
    }
    Some(d)
}

fn nums(v: &Value) -> Vec<f64> {
    match v {
        Value::Array(a) => a.iter().flat_map(nums).collect(),
        Value::Number(n) => vec![n.as_f64().unwrap()],
        Value::Null => vec![f64::NAN],
        Value::Bool(b) => vec![if *b { 1.0 } else { 0.0 }],
        _ => Vec::new(),
    }
}

fn num(h: &Value, k: &str) -> f64 {
    h.get(k).map(|v| nums(v).first().copied().unwrap_or(f64::NAN)).unwrap_or(0.0)
}

fn flag(f: &Value, k: &str) -> bool {
    f.get(k).map(|v| nums(v).first().copied().unwrap_or(0.0) != 0.0).unwrap_or(false)
}

/// Read `path.json` + `path.bin` as a `Spectra`.
pub fn load(path: &Path) -> Spectra {
    let js = std::fs::read_to_string(path.with_extension("json")).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let h: Value = serde_json::from_str(&js).unwrap();
    let bin = std::fs::read(path.with_extension("bin")).unwrap();
    let fids: Vec<C> = bin
        .chunks_exact(16)
        .map(|c| C::new(f64::from_le_bytes(c[..8].try_into().unwrap()), f64::from_le_bytes(c[8..].try_into().unwrap())))
        .collect();
    let sz: Vec<usize> = nums(&h["sz"]).iter().map(|&v| v as usize).collect();
    let d = &h["dims"];
    let dims = Dims { t: num(d, "t") as usize, coils: num(d, "coils") as usize, averages: num(d, "averages") as usize, sub_specs: num(d, "subSpecs") as usize, extras: num(d, "extras") as usize };
    let f = &h["flags"];
    let flags = Flags {
        writtentostruct: flag(f, "writtentostruct"),
        gotparams: flag(f, "gotparams"),
        leftshifted: flag(f, "leftshifted"),
        filtered: flag(f, "filtered"),
        zeropadded: flag(f, "zeropadded"),
        freqcorrected: flag(f, "freqcorrected"),
        phasecorrected: flag(f, "phasecorrected"),
        averaged: flag(f, "averaged"),
        addedrcvrs: flag(f, "addedrcvrs"),
        subtracted: flag(f, "subtracted"),
        writtentotext: flag(f, "writtentotext"),
        downsampled: flag(f, "downsampled"),
        avg_normalized: flag(f, "avgNormalized"),
        is_four_steps: flag(f, "isFourSteps"),
    };
    assert_eq!(fids.len(), sz.iter().product::<usize>(), "{}", path.display());
    Spectra {
        fids,
        sz,
        dims,
        ppm: nums(&h["ppm"]),
        t: nums(&h["t"]),
        spectralwidth: num(&h, "spectralwidth"),
        dwelltime: num(&h, "dwelltime"),
        txfrq: num(&h, "txfrq"),
        te: num(&h, "te"),
        tr: num(&h, "tr"),
        bo: num(&h, "Bo"),
        seq: h.get("seq").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        date: String::new(),
        averages: num(&h, "averages") as usize,
        raw_averages: num(&h, "rawAverages") as usize,
        subspecs: num(&h, "subspecs") as usize,
        raw_subspecs: num(&h, "rawSubspecs") as usize,
        points_to_leftshift: num(&h, "pointsToLeftshift"),
        flags,
        nucleus: "1H".into(),
    }
}

/// values.json from export_values.m.
pub struct Values(pub Value);

impl Values {
    pub fn load(path: &Path) -> Values {
        Values(serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap())
    }
    pub fn has(&self, k: &str) -> bool {
        self.0.get(k).is_some() || self.0.get(format!("{k}_re")).is_some()
    }
    pub fn vec(&self, k: &str) -> Vec<f64> {
        nums(self.0.get(k).unwrap_or_else(|| panic!("missing value {k}")))
    }
    pub fn cvec(&self, k: &str) -> Vec<C> {
        if self.0.get(k).is_some() {
            return self.vec(k).into_iter().map(|v| C::new(v, 0.0)).collect();
        }
        let re = self.vec(&format!("{k}_re"));
        let im = self.vec(&format!("{k}_im"));
        re.into_iter().zip(im).map(|(a, b)| C::new(a, b)).collect()
    }
    pub fn f(&self, k: &str) -> f64 {
        self.vec(k)[0]
    }
    pub fn size(&self, k: &str) -> Vec<usize> {
        self.vec(&format!("{k}_size")).iter().map(|&v| v as usize).collect()
    }
}

/// max |a-b| / max |b|.
pub fn rel_err(a: &[C], b: &[C]) -> f64 {
    assert_eq!(a.len(), b.len(), "length mismatch");
    let mx = b.iter().map(|z| z.norm()).fold(0.0, f64::max);
    let d = a.iter().zip(b).map(|(x, y)| (x - y).norm()).fold(0.0, f64::max);
    if mx == 0.0 {
        d
    } else {
        d / mx
    }
}

pub fn max_abs_diff(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len(), "length mismatch");
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f64::max)
}

/// Compare a structure with a reference: shape, dims, axes and fids.
/// Returns the relative fids error.
pub fn compare(name: &str, got: &Spectra, want: &Spectra, tol: f64) -> f64 {
    assert_eq!(got.sz, want.sz, "{name}: sz");
    assert_eq!(got.dims, want.dims, "{name}: dims");
    assert_eq!(got.averages, want.averages, "{name}: averages");
    assert_eq!(got.subspecs, want.subspecs, "{name}: subspecs");
    assert_eq!(got.ppm.len(), want.ppm.len(), "{name}: ppm length");
    assert!(max_abs_diff(&got.ppm, &want.ppm) < 1e-9, "{name}: ppm");
    assert!(max_abs_diff(&got.t, &want.t) < 1e-12, "{name}: t");
    assert!((got.spectralwidth - want.spectralwidth).abs() <= 1e-9 * want.spectralwidth.abs(), "{name}: spectralwidth");
    assert!((got.dwelltime - want.dwelltime).abs() <= 1e-9 * want.dwelltime.abs(), "{name}: dwelltime");
    let f = &got.flags;
    let w = &want.flags;
    assert_eq!(
        (f.leftshifted, f.filtered, f.zeropadded, f.freqcorrected, f.averaged, f.addedrcvrs, f.subtracted),
        (w.leftshifted, w.filtered, w.zeropadded, w.freqcorrected, w.averaged, w.addedrcvrs, w.subtracted),
        "{name}: flags"
    );
    let e = rel_err(&got.fids, &want.fids);
    eprintln!("{name}: relative fids error {e:.2e}");
    assert!(e < tol, "{name}: relative fids error {e:.3e} >= {tol:.1e}");
    e
}
