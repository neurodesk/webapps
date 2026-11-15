//! Analysis of the fitted-HRF probes (validation/matlab/fitted-hrf-predictions.md).
//! Test-only, so the shipped module is untouched; a child of `matlab_math` so
//! it compares MATLAB's values with the port's own private primitives.
//!
//! SAMSRF_FITTED_HRF_DIR is the extracted fitted-hrf-reference.json pack and
//! SAMSRF_MATLAB_REFERENCE_DIR the 741-case pin whose traces it replays.
//! SAMSRF_FITTED_HRF_REPORT writes the per-stage counts as JSON.
// Stage arrays are indexed in parallel by sample and evaluation.
#![allow(clippy::needless_range_loop)]

use super::{deviance, exp, gammaln, log, stirlerr};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const LABELS: [&str; 2] = ["ubuntu-22.04", "ubuntu-24.04"];
const PROCESSES: [&str; 2] = ["first", "repeat"];
const FIRST_DIVERGENCE: [usize; 6] = [16, 15, 15, 35, 16, 16];
const DISCOVERY: [usize; 3] = [0, 1, 2];

const STAGE_ARRAYS: [(&str, usize); 5] = [("rfp", 10000), ("yp", 250), ("hrf", 33), ("conv", 282), ("cy", 250)];

fn require_stage_inventory(record: &Value) {
    let fits = record["traces"].as_array().expect("recorded traces");
    assert_eq!(fits.len(), FIRST_DIVERGENCE.len(), "six fitted-HRF traces");
    for (f, fit) in fits.iter().enumerate() {
        assert_eq!(fit["fit"], json!(f), "fit identity");
        let first = FIRST_DIVERGENCE[f];
        let expected: Vec<usize> = [0, 1, 2].into_iter().chain(first - 2..=first + 2).collect();
        let stages = fit["stages"].as_array().expect("recorded stages");
        let actual: Vec<u64> = stages.iter().map(|s| s["evaluation"].as_u64().expect("integral stage evaluation")).collect();
        assert_eq!(actual, expected.iter().map(|&e| e as u64).collect::<Vec<_>>(), "fit {f}: preregistered stage indices, once each and in order");
        for (stage, e) in stages.iter().zip(expected) {
            for (name, rows) in STAGE_ARRAYS {
                let descriptor = &stage[name];
                assert_eq!(descriptor, &json!({
                    "file": format!("fit{f}_eval{e}_{name}.f64"),
                    "shape": [rows, 1], "class": "double", "imaginary": ""
                }), "fit {f} evaluation {e}: {name} descriptor");
            }
            for field in ["r", "err", "errfun"] {
                assert!(stage[field].as_f64().expect("numeric stage result").is_finite(), "fit {f} evaluation {e}: finite {field}");
            }
        }
    }
}

fn require_repeat_record(first: &Value, repeat: &Value) {
    require_stage_inventory(first);
    // CPU frequency metadata can vary between processes; numerical records cannot.
    for field in ["traces", "heldOut"] {
        assert!(serde_json::to_vec(&first[field]).unwrap() == serde_json::to_vec(&repeat[field]).unwrap(), "fresh-process {field}, including stage descriptors and scalar results, must agree");
    }
}

fn checked_record(pack: &Path, label: &str) -> Value {
    let load = |process| serde_json::from_slice::<Value>(&std::fs::read(pack.join(label).join(process).join("fitted-hrf.json")).unwrap()).unwrap();
    let first = load("first");
    let repeat = load("repeat");
    require_repeat_record(&first, &repeat);
    // Reading every stage also enforces the declared payload byte counts.
    for process in PROCESSES {
        let dir = pack.join(label).join(process);
        for fit in first["traces"].as_array().unwrap() {
            for stage in fit["stages"].as_array().unwrap() {
                for (name, _) in STAGE_ARRAYS {
                    let _ = read(&dir, &stage[name]);
                }
            }
        }
    }
    first
}

fn stage_record_for_test() -> Value {
    let indices = [
        [0, 1, 2, 14, 15, 16, 17, 18],
        [0, 1, 2, 13, 14, 15, 16, 17],
        [0, 1, 2, 13, 14, 15, 16, 17],
        [0, 1, 2, 33, 34, 35, 36, 37],
        [0, 1, 2, 14, 15, 16, 17, 18],
        [0, 1, 2, 14, 15, 16, 17, 18],
    ];
    json!({"traces": indices.iter().enumerate().map(|(f, indices)| {
        json!({"fit": f, "stages": indices.iter().map(|e| {
            let mut stage = json!({"evaluation": e, "r": 0.5, "err": 0.75, "errfun": 0.75});
            for (name, rows) in STAGE_ARRAYS {
                stage[name] = json!({"file": format!("fit{f}_eval{e}_{name}.f64"), "shape": [rows, 1], "class": "double", "imaginary": ""});
            }
            stage
        }).collect::<Vec<_>>()})
    }).collect::<Vec<_>>()})
}

#[test]
fn stage_inventory_rejects_missing_duplicate_and_reordered_evaluations() {
    let valid = stage_record_for_test();
    require_stage_inventory(&valid);
    for f in 0..6 {
        for mutation in 0..5 {
            let mut changed = valid.clone();
            let stages = changed["traces"][f]["stages"].as_array_mut().unwrap();
            match mutation {
                0 => stages.clear(),
                1 => { stages.pop(); }
                2 => stages[7] = stages[6].clone(),
                3 => stages.swap(3, 4),
                _ => stages[3]["evaluation"] = json!(14.5),
            }
            assert!(std::panic::catch_unwind(|| require_stage_inventory(&changed)).is_err(), "fit {f}, mutation {mutation}");
        }
    }
}

#[test]
fn stage_inventory_rejects_invalid_descriptors() {
    let valid = stage_record_for_test();
    for (field, value) in [
        ("class", json!("single")),
        ("imaginary", json!("imag.f64")),
        ("shape", json!([1, 10000])),
        ("shape", json!([10000.5, 1])),
        ("file", json!("fit0_eval1_rfp.f64")),
    ] {
        let mut changed = valid.clone();
        changed["traces"][0]["stages"][0]["rfp"][field] = value;
        assert!(std::panic::catch_unwind(|| require_stage_inventory(&changed)).is_err(), "{field}");
    }
}

#[test]
fn stage_inventory_rejects_inconsistent_repeat_records() {
    let valid = stage_record_for_test();
    require_repeat_record(&valid, &valid);
    let mut missing = valid.clone();
    missing["traces"][0]["stages"] = json!([]);
    let mut different = valid.clone();
    different["traces"][0]["stages"][0]["errfun"] = json!(0.5);
    for repeat in [missing, different] {
        assert!(std::panic::catch_unwind(|| require_repeat_record(&valid, &repeat)).is_err());
    }
}

fn read(root: &Path, descriptor: &Value) -> (Vec<f64>, Vec<usize>) {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name, "{name}");
    let shape: Vec<usize> = match &descriptor["shape"] {
        Value::Array(dims) => dims.iter().map(|d| d.as_u64().unwrap() as usize).collect(),
        other => vec![other.as_u64().unwrap() as usize],
    };
    let bytes = std::fs::read(root.join(name)).unwrap();
    assert_eq!(bytes.len(), shape.iter().product::<usize>() * 8, "{name}: bytes for shape {shape:?}");
    (bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect(), shape)
}

fn column(values: &[f64], rows: usize, c: usize) -> &[f64] {
    &values[c * rows..(c + 1) * rows]
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
}

/// Signed distance in units in the last place (both finite and of one sign), else
/// `i64::MAX` when they differ.
fn ulps(a: f64, b: f64) -> i64 {
    if same(a, b) {
        return 0;
    }
    if a.is_finite() && b.is_finite() && a.is_sign_negative() == b.is_sign_negative() {
        (a.to_bits() as i64 - b.to_bits() as i64).abs()
    } else {
        i64::MAX
    }
}

/// One comparison: how many values were compared, how many differ, the largest
/// ULP distance and the first differing (column, row).
#[derive(Default, Clone)]
struct Tally {
    compared: usize,
    differ: usize,
    max_ulps: i64,
    first: Option<(usize, usize)>,
}

impl Tally {
    fn add(&mut self, column: usize, row: usize, port: f64, matlab: f64) {
        self.compared += 1;
        let d = ulps(port, matlab);
        if d != 0 {
            self.differ += 1;
            self.max_ulps = self.max_ulps.max(d);
            if self.first.is_none_or(|(c, r)| (column, row) < (c, r)) {
                self.first = Some((column, row));
            }
        }
    }
    fn json(&self) -> Value {
        json!({"compared": self.compared, "differ": self.differ, "maxUlps": if self.max_ulps == i64::MAX { json!("sign/nonfinite") } else { json!(self.max_ulps) }, "first": self.first})
    }
}

/// The port's gampdf (a >= 1) split into the recorded stages, on MATLAB's own
/// `x` and `b`: each stage from the port's previous stage.
struct PortParts {
    k: f64,
    gammaln_k1: f64,
    log_k: f64,
    log_norm: f64,
    stirlerr: f64,
}

fn port_scalars(k: f64) -> PortParts {
    PortParts { k, gammaln_k1: gammaln(k + 1.0), log_k: log(k), log_norm: log(2.0 * std::f64::consts::PI * k), stirlerr: stirlerr(k) }
}

fn pack_root() -> Option<(PathBuf, PathBuf)> {
    let pack = PathBuf::from(std::env::var_os("SAMSRF_FITTED_HRF_DIR")?);
    let reference = PathBuf::from(std::env::var_os("SAMSRF_MATLAB_REFERENCE_DIR").expect("SAMSRF_MATLAB_REFERENCE_DIR with SAMSRF_FITTED_HRF_DIR"));
    Some((pack, reference))
}

/// The pinned traces: per fit, the (evaluations x 10) rows.
fn pinned_traces(reference: &Path) -> Vec<(usize, Vec<f64>)> {
    let pin: Value = serde_json::from_slice(&std::fs::read(reference.join("reference.json")).unwrap()).unwrap();
    let case = pin["cases"].as_array().unwrap().iter().find(|c| c["id"] == "fit_double_fitted_hrf").unwrap();
    case["traces"].as_array().unwrap().iter().map(|t| {
        let (values, shape) = read(reference, t);
        assert_eq!(shape[1], 10);
        (shape[0], values)
    }).collect()
}

#[test]
fn fitted_hrf_probes_inventory() {
    let Some((pack, reference)) = pack_root() else { return };
    let run: Value = serde_json::from_slice(&std::fs::read(pack.join("run.json")).unwrap()).unwrap();
    let files = run["files"].as_object().unwrap();
    let mut present = Vec::new();
    for entry in walk(&pack) {
        let relative = entry.strip_prefix(&pack).unwrap().to_string_lossy().to_string();
        if relative != "run.json" {
            present.push(relative);
        }
    }
    present.sort();
    let mut listed: Vec<String> = files.keys().cloned().collect();
    listed.sort();
    assert_eq!(present, listed, "the pack holds exactly the files run.json lists");
    for (name, entry) in files {
        let bytes = std::fs::read(pack.join(name)).unwrap();
        assert_eq!(bytes.len() as u64, entry["bytes"].as_u64().unwrap(), "{name}: bytes");
        assert_eq!(sha256(&bytes), entry["sha256"].as_str().unwrap(), "{name}: sha256");
    }
    let traces = pinned_traces(&reference);
    for label in LABELS {
        let first = pack.join(label).join("first");
        let repeat = pack.join(label).join("repeat");
        let mut names: Vec<_> = std::fs::read_dir(&first).unwrap().map(|e| e.unwrap().file_name()).filter(|n| n.to_string_lossy().ends_with(".f64")).collect();
        names.sort();
        assert!(!names.is_empty());
        for name in &names {
            assert_eq!(std::fs::read(first.join(name)).unwrap(), std::fs::read(repeat.join(name)).unwrap(), "{label}: {name:?} differs between processes");
        }
        let record = checked_record(&pack, label);
        assert!(record["environment"]["matlab"].as_str().unwrap().starts_with("23.2.0.3097123"), "{label}: MATLAB R2023b Update 11");
        let fits = record["traces"].as_array().unwrap();
        assert_eq!(fits.len(), 6, "{label}: traces");
        for (f, fit) in fits.iter().enumerate() {
            let (rows, _) = traces[f];
            let (evaluations, _) = read(&first, &fit["evaluations"]);
            assert_eq!(evaluations, (0..rows).map(|e| e as f64).collect::<Vec<_>>(), "{label} fit {f}: every recorded evaluation");
            for (name, height) in [("g1", 33), ("g2raw", 33), ("g2", 33), ("hrf", 33), ("g1Scalar", 33), ("g2rawScalar", 33), ("shape", 5), ("parameters", 8), ("err", 1)] {
                let (_, shape) = read(&first, &fit[name]);
                assert_eq!(shape, vec![height, rows], "{label} fit {f}: {name} shape");
            }
            assert_eq!(fit["firstDivergence"].as_u64().unwrap() as usize, FIRST_DIVERGENCE[f]);
        }
        assert_eq!(record["heldOut"]["pairs"]["count"], 200, "{label}: held-out pairs");
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(bytes))
}

/// Compare one recorded gamma's per-sample parts (rows `samples`, one column per
/// evaluation or pair) with the port, on MATLAB's own inputs at every stage.
#[allow(clippy::too_many_arguments)]
fn compare_parts(dir: &Path, parts: &Value, x_of: &dyn Fn(usize) -> Vec<f64>, a_of: &dyn Fn(usize) -> f64, b_of: &dyn Fn(usize) -> f64, density: &(Vec<f64>, usize), density_scalar: &(Vec<f64>, usize), tallies: &mut BTreeMap<&'static str, Tally>) {
    let (scalars, shape) = read(dir, &parts["scalars"]);
    let columns = shape[1];
    let samples = density.1;
    let field = |name: &str| read(dir, &parts[name]).0;
    let (z, bd0, arg, exp_scalar, exp_vector, assembled) = (field("z"), field("bd0"), field("arg"), field("expScalar"), field("expVector"), field("density"));
    for c in 0..columns {
        let s = column(&scalars, 5, c);
        let k = s[0];
        let port = port_scalars(k);
        assert!(same(port.k, k));
        tallies.entry("gammaln(k+1)").or_default().add(c, 0, port.gammaln_k1, s[1]);
        tallies.entry("log(k)").or_default().add(c, 0, port.log_k, s[2]);
        tallies.entry("log(2 pi k)").or_default().add(c, 0, port.log_norm, s[3]);
        tallies.entry("stirlerr(k), port").or_default().add(c, 0, port.stirlerr, s[4]);
        // The port's stirlerr on MATLAB's gammaln and log: the formula alone.
        if k <= 15.0 && (2.0 * k).round() != 2.0 * k {
            let formula = s[1] - (k + 0.5) * s[2] + k - 0.9189385332046727418;
            tallies.entry("stirlerr formula on MATLAB primitives").or_default().add(c, 0, formula, s[4]);
        }
        let x = x_of(c);
        let a = a_of(c);
        let b = b_of(c);
        assert!(same(a - 1.0, k), "k is MATLAB's a - 1");
        for r in 0..samples {
            let i = c * samples + r;
            tallies.entry("z = x / b").or_default().add(c, r, x[r] / b, z[i]);
            if z[i] > 0.0 && k > 0.0 {
                tallies.entry("bd0 (port, MATLAB z)").or_default().add(c, r, deviance(k, z[i]), bd0[i]);
                tallies.entry("arg (MATLAB parts)").or_default().add(c, r, (-0.5 * s[3] - s[4]) - bd0[i], arg[i]);
                tallies.entry("exp (port libm on MATLAB arg)").or_default().add(c, r, exp(arg[i]), exp_scalar[i]);
            }
            tallies.entry("MATLAB exp: vector vs scalar").or_default().add(c, r, exp_vector[i], exp_scalar[i]);
            tallies.entry("MATLAB gampdf vs port algorithm in MATLAB").or_default().add(c, r, assembled[i], density.0[i]);
            tallies.entry("MATLAB gampdf: scalar vs vector").or_default().add(c, r, density_scalar.0[i], density.0[i]);
            tallies.entry("port gampdf vs MATLAB gampdf").or_default().add(c, r, super::gampdf(x[r], a, b).unwrap(), density.0[i]);
        }
    }
}

#[test]
fn fitted_hrf_probes_report() {
    let Some((pack, reference)) = pack_root() else { return };
    let traces = pinned_traces(&reference);
    let mut report = serde_json::Map::new();
    for label in LABELS {
        let dir = pack.join(label).join(PROCESSES[0]);
        let record = checked_record(&pack, label);
        let cpu = record["environment"]["cpu"].as_str().unwrap_or("");
        let vendor = if cpu.contains("AuthenticAMD") { "AMD" } else if cpu.contains("GenuineIntel") { "Intel" } else { "unknown" };
        let mut sets = serde_json::Map::new();
        for (set, fits) in [("discovery", DISCOVERY.to_vec()), ("holdout", vec![3, 4, 5])] {
            let mut tallies: BTreeMap<&'static str, Tally> = BTreeMap::new();
            let mut first_kernel = Vec::new();
            for &f in &fits {
                let fit = &record["traces"][f];
                let (rows, trace) = &traces[f];
                let rows = *rows;
                let (params, _) = read(&dir, &fit["parameters"]);
                let (shape, _) = read(&dir, &fit["shape"]);
                let (err, _) = read(&dir, &fit["err"]);
                let (hrf, _) = read(&dir, &fit["hrf"]);
                let (g1, _) = read(&dir, &fit["g1"]);
                let (g2raw, _) = read(&dir, &fit["g2raw"]);
                let (g2, _) = read(&dir, &fit["g2"]);
                let mut first = None;
                for e in 0..rows {
                    let p = column(&params, 8, e);
                    for (j, value) in p.iter().enumerate() {
                        assert!(same(*value, trace[j * rows + e]), "{label} fit {f} evaluation {e}: recorded parameters are the pin's");
                    }
                    tallies.entry("MATLAB err vs pinned trace").or_default().add(f, e, err[e], trace[8 * rows + e]);
                    let q = &p[3..8];
                    let port_shape = [q[0] / q[2], q[2], q[1] / q[3], q[3], q[4]];
                    for (r, v) in port_shape.iter().enumerate() {
                        tallies.entry("shape and scale").or_default().add(f, e * 5 + r, *v, shape[e * 5 + r]);
                    }
                    let kernel = crate::hrf::doublegamma(1.0, q);
                    let mut kernel_differs = false;
                    for r in 0..33 {
                        let i = e * 33 + r;
                        tallies.entry("hrf: port vs MATLAB").or_default().add(f, i, kernel[r], hrf[i]);
                        tallies.entry("hrf from MATLAB g1 - g2").or_default().add(f, i, g1[i] - g2[i], hrf[i]);
                        tallies.entry("g2 = g2raw / p5").or_default().add(f, i, g2raw[i] / q[4], g2[i]);
                        kernel_differs |= !same(kernel[r], hrf[i]);
                    }
                    if kernel_differs && first.is_none() {
                        first = Some(e);
                    }
                }
                first_kernel.push(json!({"fit": f, "firstKernelDifference": first, "firstObjectiveDifference": FIRST_DIVERGENCE[f]}));
                let t: Vec<f64> = (0..33).map(|s| s as f64).collect();
                let shape_ref = &shape;
                for (gamma, density, scalar) in [("parts1", &g1, "g1Scalar"), ("parts2", &g2raw, "g2rawScalar")] {
                    let a_index = if gamma == "parts1" { 0 } else { 2 };
                    let scalar = read(&dir, &fit[scalar]).0;
                    compare_parts(&dir, &fit[gamma], &|_| t.clone(), &|c| shape_ref[c * 5 + a_index], &|c| shape_ref[c * 5 + a_index + 1], &(density.clone(), 33), &(scalar, 33), &mut tallies);
                }
            }
            sets.insert(set.into(), json!({"fits": fits, "kernel": first_kernel, "stages": tallies.iter().map(|(k, v)| (k.to_string(), v.json())).collect::<serde_json::Map<_, _>>()}));
        }
        // Generated held-out densities.
        let held = &record["heldOut"];
        let (pairs, _) = read(&dir, &held["pairs"]["shape"]);
        let mut held_sets = serde_json::Map::new();
        for grid in ["kernel", "random"] {
            let (xs, _) = read(&dir, &held[format!("{grid}Grid")]);
            let samples = xs.len();
            let vector = read(&dir, &held[grid]["vector"]).0;
            let scalar = read(&dir, &held[grid]["scalar"]).0;
            let mut tallies: BTreeMap<&'static str, Tally> = BTreeMap::new();
            compare_parts(&dir, &held[grid]["parts"], &|_| xs.clone(), &|c| pairs[c * 2], &|c| pairs[c * 2 + 1], &(vector, samples), &(scalar, samples), &mut tallies);
            held_sets.insert(grid.into(), json!(tallies.iter().map(|(k, v)| (k.to_string(), v.json())).collect::<serde_json::Map<_, _>>()));
        }
        report.insert(label.into(), json!({"vendor": vendor, "cpu": cpu.lines().find(|l| l.contains("Model name")).unwrap_or(""), "traces": sets, "generated": held_sets}));
    }
    let text = serde_json::to_string_pretty(&report).unwrap();
    if let Some(path) = std::env::var_os("SAMSRF_FITTED_HRF_REPORT") {
        std::fs::write(path, text + "\n").unwrap();
    } else {
        println!("{text}");
    }
}


/// Bit equality of two arrays, NaN equal to NaN; panics at the first difference.
fn require_same(context: &str, port: &[f64], matlab: &[f64]) {
    assert_eq!(port.len(), matlab.len(), "{context}: lengths");
    if let Some(i) = (0..port.len()).find(|&i| !same(port[i], matlab[i])) {
        panic!("{context}: element {i}: port {:e} != MATLAB {:e} ({} ulps)", port[i], matlab[i], ulps(port[i], matlab[i]));
    }
}

/// The port's gampdf before the normaliser took log(2 pi) and log(k) separately:
/// `-log(2 pi k) / 2`. Kept only as the negative control the recording must reject.
fn gampdf_joint_log(x: f64, a: f64, b: f64) -> f64 {
    let k = a - 1.0;
    let z = x / b;
    if z == 0.0 {
        return if a == 1.0 { 1.0 / b } else { 0.0 };
    }
    if k == 0.0 {
        return exp(-z) / b;
    }
    exp((-0.5 * log(2.0 * std::f64::consts::PI * k) - stirlerr(k)) - deviance(k, z)) / b
}

#[test]
fn require_same_rejects_one_ulp_and_nan_changes() {
    require_same("equal", &[1.0, f64::NAN, -0.0], &[1.0, f64::NAN, -0.0]);
    for (port, matlab) in [(vec![1.0 + f64::EPSILON], vec![1.0]), (vec![0.0], vec![-0.0]), (vec![f64::NAN], vec![1.0]), (vec![1.0, 2.0], vec![1.0])] {
        assert!(std::panic::catch_unwind(|| require_same("mutated", &port, &matlab)).is_err(), "{port:?} {matlab:?}");
    }
}

#[test]
fn fitted_hrf_probes_match_the_port() {
    let Some((pack, reference)) = pack_root() else { return };
    let traces = pinned_traces(&reference);
    let pin: Value = serde_json::from_slice(&std::fs::read(reference.join("reference.json")).unwrap()).unwrap();
    let case = pin["cases"].as_array().unwrap().iter().find(|c| c["id"] == "fit_double_fitted_hrf").unwrap();
    let (observations, _) = read(&reference, &case["observations"]);
    let apertures = crate::mat::read_apertures(&std::fs::read(reference.join("fit-apertures.mat")).unwrap()).unwrap();
    let xy = apertures.scaled_xy(9.5);
    let function = crate::expr::AnonymousFunction::parse("@(P,XY)prf_gaussian_rf(P(1),P(2),P(3),XY)").unwrap();
    let xy_value = crate::expr::Value { rows: xy.len(), cols: 2, data: xy.iter().map(|q| q[0]).chain(xy.iter().map(|q| q[1])).collect() };
    let run: Value = serde_json::from_slice(&std::fs::read(pack.join("run.json")).unwrap()).unwrap();
    let mut joint_log_rejected = 0usize;
    let mut gammaln_differs = 0usize;
    let mut host_arrays: BTreeMap<&str, Vec<Vec<f64>>> = BTreeMap::new();
    for label in LABELS {
        let dir = pack.join(label).join("first");
        let record = checked_record(&pack, label);
        let vendor = run["hosts"][label]["vendor"].as_str().unwrap();
        let mut densities = Vec::new();
        for (f, fit) in record["traces"].as_array().unwrap().iter().enumerate() {
            let (rows, trace) = &traces[f];
            let rows = *rows;
            let (params, _) = read(&dir, &fit["parameters"]);
            let (err, _) = read(&dir, &fit["err"]);
            let y = &observations[f * 250..(f + 1) * 250];
            // MATLAB's prf_errfun at the pinned parameters is the pinned trace on the
            // pin's CPU vendor; the Intel host is reported, not required.
            let pinned: Vec<f64> = (0..rows).map(|e| trace[8 * rows + e]).collect();
            if vendor == "AMD" {
                require_same(&format!("{label} fit {f}: MATLAB err vs the pinned trace"), &err, &pinned);
            }
            let mut port_err = Vec::with_capacity(rows);
            let mut port_hrf = Vec::with_capacity(rows * 33);
            let mut port_g = [Vec::new(), Vec::new()];
            for e in 0..rows {
                let p = column(&params, 8, e);
                let q = &p[3..8];
                port_hrf.extend(crate::hrf::doublegamma(1.0, q));
                for (j, (a, b)) in [(q[0] / q[2], q[2]), (q[1] / q[3], q[3])].into_iter().enumerate() {
                    for t in 0..33 {
                        port_g[j].push(super::gampdf(t as f64, a, b).unwrap());
                    }
                }
                port_err.push(crate::prf::errfun_with_convention(&function, &apertures, &xy, &crate::hrf::ErrfunHrf::Fit { tr: 1.0 }, p, y, 1, false, crate::precision::Precision::Double, crate::css::Convention::Samsrf).unwrap().re);
            }
            let context = |what: &str| format!("{label} fit {f}: {what}");
            let (hrf, _) = read(&dir, &fit["hrf"]);
            require_same(&context("kernel"), &port_hrf, &hrf);
            for (j, (vector, scalar)) in [("g1", "g1Scalar"), ("g2raw", "g2rawScalar")].into_iter().enumerate() {
                let (v, _) = read(&dir, &fit[vector]);
                let (s, _) = read(&dir, &fit[scalar]);
                require_same(&context(vector), &port_g[j], &v);
                require_same(&context(scalar), &port_g[j], &s);
                densities.push(v);
            }
            densities.push(hrf);
            // corr's MKL ddot sums in another tree on Intel's AVX-512 branch (arithmetic
            // order, #841), so the objective is required on the AMD host only.
            if vendor == "AMD" {
                require_same(&context("objective at every recorded evaluation"), &port_err, &err);
            }
            // prf_errfun's stages in the window around each first divergence.
            for stage in fit["stages"].as_array().unwrap() {
                let e = stage["evaluation"].as_u64().unwrap() as usize;
                let p = column(&params, 8, e);
                let profile = function.evaluate(&[crate::expr::Value::column(p.to_vec()), xy_value.clone()]).unwrap();
                require_same(&context(&format!("evaluation {e} rfp")), &profile.data, &read(&dir, &stage["rfp"]).0);
                let yp = crate::prf::predict_timecourse(&profile.data, &apertures);
                require_same(&context(&format!("evaluation {e} yp")), &yp, &read(&dir, &stage["yp"]).0);
                let kernel = crate::hrf::doublegamma(1.0, &p[3..8]);
                require_same(&context(&format!("evaluation {e} hrf")), &kernel, &read(&dir, &stage["hrf"]).0);
                let cy = super::convolve_real(&yp, &kernel, 1);
                let (conv, _) = read(&dir, &stage["conv"]);
                require_same(&context(&format!("evaluation {e} conv (kept outputs)")), &cy, &conv[..cy.len()]);
                require_same(&context(&format!("evaluation {e} cy")), &cy, &read(&dir, &stage["cy"]).0);
                let errfun = stage["errfun"].as_f64().unwrap();
                assert!(same(stage["err"].as_f64().unwrap(), errfun), "{label} fit {f} evaluation {e}: 1 - R^2 is prf_errfun's err");
                if vendor == "AMD" {
                    assert!(same(port_err[e], errfun), "{label} fit {f} evaluation {e}: err");
                }
            }
            // MATLAB's gammaln differs from the port's Cody gammaln only where stirlerr
            // takes its table instead (half-integer k), so it never reaches a density.
            for gamma in ["parts1", "parts2"] {
                let (scalars, shape) = read(&dir, &fit[gamma]["scalars"]);
                for c in 0..shape[1] {
                    let k = scalars[c * 5];
                    if !same(gammaln(k + 1.0), scalars[c * 5 + 1]) {
                        gammaln_differs += 1;
                        assert!(k <= 15.0 && (2.0 * k).round() == 2.0 * k, "{label} fit {f}: gammaln differs at k = {k}, outside the stirlerr table");
                    }
                }
            }
            for e in 0..rows {
                let p = column(&params, 8, e);
                let q = &p[3..8];
                let (a, b) = (q[0] / q[2], q[2]);
                joint_log_rejected += (1..33).filter(|&t| !same(gampdf_joint_log(t as f64, a, b), super::gampdf(t as f64, a, b).unwrap())).count();
            }
        }
        // Generated held-out densities, as a vector and per sample.
        let held = &record["heldOut"];
        let (pairs, _) = read(&dir, &held["pairs"]["shape"]);
        for grid in ["kernel", "random"] {
            let (xs, _) = read(&dir, &held[format!("{grid}Grid")]);
            let mut port = Vec::with_capacity(pairs.len() / 2 * xs.len());
            for c in 0..pairs.len() / 2 {
                port.extend(xs.iter().map(|&x| super::gampdf(x, pairs[2 * c], pairs[2 * c + 1]).unwrap()));
            }
            let (vector, _) = read(&dir, &held[grid]["vector"]);
            require_same(&format!("{label} generated {grid}: vector"), &port, &vector);
            require_same(&format!("{label} generated {grid}: scalar"), &port, &read(&dir, &held[grid]["scalar"]).0);
            densities.push(vector);
        }
        host_arrays.insert(label, densities);
    }
    // MATLAB's densities and kernels are the same bits on both CPU vendors.
    let (amd, intel) = (&host_arrays[LABELS[0]], &host_arrays[LABELS[1]]);
    assert_eq!(amd.len(), intel.len());
    for (i, (a, b)) in amd.iter().zip(intel).enumerate() {
        require_same(&format!("densities and kernels, array {i}: one host vs the other"), a, b);
    }
    assert!(joint_log_rejected > 0, "the recording must reject the joint log(2 pi k) normaliser");
    eprintln!("gammaln differs at {gammaln_differs} trace columns (both hosts), all half-integer k; the joint normaliser differs at {joint_log_rejected} kernel samples");
}
