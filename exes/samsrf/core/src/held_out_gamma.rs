//! Section B of validation/matlab/constants-gamma-gemv-predictions.md: `gampdf`
//! at shapes below 1 never recorded before. Test-only, a child of `matlab_math`
//! so the candidate uses the port's private `stirlerr` and `deviance`.
//!
//! SAMSRF_CGG_PREDICT writes the predictions before any recording exists;
//! SAMSRF_CGG_DIR (one folder per host) compares the recording with each model.
use super::{deviance, exp, gammaln, log, poisson_raw, stirlerr};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const SHAPES: [f64; 9] = [0.05, 0.2, 0.3, 0.5, 0.55, 0.85, 0.9, 0.95, 0.999];
const SCALES: [f64; 4] = [1.0, 0.75, 1.5, 3.0];

/// The recorder's inputs: exact grids, powers of two, subnormals, multiples of 8,
/// thirteen points about the mode-free peak region `a * b`, then 0, -1 and Inf.
fn inputs(a: f64, b: f64) -> Vec<f64> {
    let mut x: Vec<f64> = (1..=640).map(|k| f64::from(k) / 16.0).collect();
    x.extend((1..=60).map(|k| 2f64.powi(-k)));
    x.extend([f64::from_bits(1), f64::from_bits(3), f64::MIN_POSITIVE]);
    x.extend((1..=100).map(|k| f64::from(k) * 8.0));
    x.extend((-6..=6).map(|j| (a * b) * f64::from(64 + j) / 64.0));
    x.extend([0.0, -1.0, f64::INFINITY]);
    x
}

/// Candidate from the shape-0.7 discovery recording: Loader's Poisson density at
/// `a` with `a / z` taken as `exp(log a - log z)`.
fn candidate(z: f64, a: f64, b: f64) -> f64 {
    let c = -0.5 * (log(2.0 * std::f64::consts::PI) + log(a)) - stirlerr(a);
    exp(log(a) - log(z)) * exp(c - deviance(a, z)) / b
}

type Model = fn(f64, f64, f64) -> f64;

const MODELS: [(&str, Model); 4] = [
    ("G1 candidate", candidate),
    ("G0 port closed form", |z, a, b| crate::hrf::gampdf(z * b, a, b)),
    ("G2 Loader (a/z)*P/b", |z, a, b| (a / z) * poisson_raw(a, z) / b),
    ("G3 exp((a-1) log z - z - gammaln a)/b", |z, a, b| exp((a - 1.0) * log(z) - z - gammaln(a)) / b),
];

/// Each model on the positive finite inputs; edges follow the port's `hrf::gampdf`.
fn evaluate(model: Model, x: f64, a: f64, b: f64) -> f64 {
    if x > 0.0 && x.is_finite() {
        model(x / b, a, b)
    } else {
        crate::hrf::gampdf(x, a, b)
    }
}

fn hash(values: &[f64]) -> String {
    Sha256::digest(values.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).iter().map(|b| format!("{b:02x}")).collect()
}

fn id(a: f64, b: f64) -> String {
    format!("gamma_a{a}_b{b}").replace('.', "p")
}

#[test]
fn predictions_are_written_before_the_recording() {
    let Some(out) = std::env::var_os("SAMSRF_CGG_PREDICT").map(PathBuf::from) else { return };
    std::fs::create_dir_all(&out).unwrap();
    let mut cases = Vec::new();
    for a in SHAPES {
        for b in SCALES {
            let x = inputs(a, b);
            let values: Vec<Vec<f64>> = MODELS.iter().map(|(_, m)| x.iter().map(|&x| evaluate(*m, x, a, b)).collect()).collect();
            cases.push(json!({
                "id": id(a, b),
                "x": hash(&x),
                "models": MODELS.iter().zip(&values).map(|((name, _), v)| (name.to_string(), json!({
                    "hash": hash(v),
                    "differFromG1": v.iter().zip(&values[0]).filter(|(p, q)| p.to_bits() != q.to_bits()).count(),
                }))).collect::<BTreeMap<_, _>>(),
            }));
        }
    }
    std::fs::write(out.join("gamma-predictions.json"), serde_json::to_string_pretty(&cases).unwrap()).unwrap();
}

fn validate_descriptor(descriptor: &Value, len: usize) {
    assert_eq!(descriptor["imaginary"], "", "gamma arrays must be real");
    assert_eq!(descriptor["shape"], json!([1, len]), "{}", descriptor["file"]);
    assert_eq!(descriptor["class"], "double");
}

fn recorded(dir: &Path, descriptor: &Value, len: usize) -> Vec<f64> {
    validate_descriptor(descriptor, len);
    let bytes = std::fs::read(dir.join(descriptor["file"].as_str().unwrap())).unwrap();
    assert_eq!(bytes.len(), 8 * len);
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

#[test]
fn small_shapes_against_the_recording() {
    let Some(root) = std::env::var_os("SAMSRF_CGG_DIR").map(PathBuf::from) else { return };
    let mut report = BTreeMap::new();
    for host in ["ubuntu-22.04", "ubuntu-24.04"] {
        let dir = root.join(host);
        let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("gamma.json")).unwrap()).unwrap();
        let cases = recording["cases"].as_array().unwrap();
        assert_eq!(cases.len(), SHAPES.len() * SCALES.len(), "{host}: gamma inventory");
        let mut tallies = BTreeMap::<String, [usize; 2]>::new();
        let mut misses = Vec::new();
        for (case, (a, b)) in cases.iter().zip(SHAPES.iter().flat_map(|&a| SCALES.iter().map(move |&b| (a, b)))) {
            assert_eq!(case["id"], id(a, b).as_str());
            assert_eq!((case["a"].as_f64(), case["b"].as_f64()), (Some(a), Some(b)));
            let x = inputs(a, b);
            assert_eq!(recorded(&dir, &case["x"], x.len()).iter().map(|v| v.to_bits()).collect::<Vec<_>>(), x.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "{host} {}: inputs", id(a, b));
            let matlab = recorded(&dir, &case["gampdf"], x.len());
            for (name, model) in MODELS {
                for (&x, &e) in x.iter().zip(&matlab) {
                    let region = if x > 0.0 && x.is_finite() { "positive" } else { "edge" };
                    let hit = evaluate(model, x, a, b).to_bits() == e.to_bits();
                    let entry = tallies.entry(format!("{region} {name}")).or_default();
                    entry[0] += usize::from(hit);
                    entry[1] += 1;
                    if !hit && name.starts_with("G1") && misses.len() < 40 {
                        misses.push(json!({ "a": a, "b": b, "x": x, "matlab": e, "candidate": evaluate(model, x, a, b) }));
                    }
                }
            }
        }
        // Run 43882331042: the candidate fails the held-out shapes on both hosts, so
        // production keeps its closed form below shape 1 (pre-registered decision).
        let count = |key: &str| tallies[key];
        assert_eq!(count("positive G1 candidate"), [23_941, 29_376], "{host}: candidate");
        assert_eq!(count("positive G0 port closed form"), [2_054, 29_376], "{host}: production");
        for (name, _) in MODELS {
            assert_eq!(count(&format!("edge {name}")), [108, 108], "{host}: edges {name}");
        }
        report.insert(host, json!({ "tallies": tallies, "candidateMisses": misses }));
    }
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

#[test]
fn refuses_wrong_array_representation() {
    let valid = json!({"file": "values.f64", "shape": [1, 2], "class": "double", "imaginary": ""});
    validate_descriptor(&valid, 2);
    for (field, value) in [("class", "single"), ("imaginary", "imaginary.f64")] {
        let mut wrong = valid.clone();
        wrong[field] = json!(value);
        assert!(std::panic::catch_unwind(|| validate_descriptor(&wrong, 2)).is_err());
    }
}
