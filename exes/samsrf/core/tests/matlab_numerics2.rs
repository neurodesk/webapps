//! The second MATLAB R2023b probe recording (`numerics2-reference.json`): `gampdf`
//! for shapes 0.7-100.1 and scales 0.5-2, and `conv` on short courses and long
//! sparse ones. The workflow supplies it; without it these return.
use num_complex::Complex64;
use samsrf_core::matlab_math as m;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The recording's hosts, found by CPU rather than by runner label.
fn hosts() -> Option<(PathBuf, String, String)> {
    let root = PathBuf::from(std::env::var_os("SAMSRF_MATLAB_NUMERICS2_DIR")?);
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let host = |prefix: &str| {
        manifest["hosts"].as_object().unwrap().iter()
            .find(|(_, v)| v["cpu"].as_str().unwrap().to_uppercase().starts_with(prefix))
            .map(|(k, _)| k.clone())
            .unwrap()
    };
    let (amd, intel) = (host("AMD EPYC"), host("INTEL(R) XEON"));
    Some((root, amd, intel))
}

fn cases(root: &Path, host: &str) -> (PathBuf, BTreeMap<String, Value>) {
    let dir = root.join(host).join("compatible");
    let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("numerics.json")).unwrap()).unwrap();
    let cases = recording["cases"].as_array().unwrap().iter()
        .map(|case| (case["id"].as_str().unwrap().to_string(), case.clone()))
        .collect();
    (dir, cases)
}

fn real(dir: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name);
    std::fs::read(dir.join(name)).unwrap().as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn complex(dir: &Path, descriptor: &Value) -> Vec<Complex64> {
    let re = real(dir, descriptor);
    let im = match descriptor["imaginary"].as_str().filter(|s| !s.is_empty()) {
        Some(name) => real(dir, &serde_json::json!({ "file": name })),
        None => vec![0.0; re.len()],
    };
    re.into_iter().zip(im).map(|(re, im)| Complex64::new(re, im)).collect()
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || a.is_nan() && b.is_nan()
}

/// Every recorded value with shape a >= 1, the HRF domain, on both hosts. The
/// identified form agrees with MATLAB on these probes; it is not MATLAB's source.
/// Shapes below 1 take another MATLAB form, and the port declines them.
#[test]
fn gampdf_matches_every_recorded_value_with_shape_at_least_one() {
    let Some((root, amd, intel)) = hosts() else { return };
    for host in [&amd, &intel] {
        let (dir, cases) = cases(&root, host);
        let (mut matched, mut declined) = (0, 0);
        for case in cases.values().filter(|case| case["kind"] == "gampdf") {
            let (a, b) = (case["a"].as_f64().unwrap(), case["b"].as_f64().unwrap());
            let x = real(&dir, &case["x"]);
            let expected = real(&dir, &case["gampdf"]);
            assert_eq!(expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), real(&dir, &case["pdf"]).iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "pdf('Gamma') is gampdf");
            for (x, e) in x.iter().zip(&expected) {
                match m::gampdf(*x, a, b) {
                    Some(actual) => {
                        assert!(same(actual, *e), "{host} gampdf({x}, {a}, {b}) = {actual:e}, MATLAB {e:e}");
                        matched += 1;
                    }
                    None => {
                        assert!(a < 1.0);
                        declined += 1;
                    }
                }
            }
        }
        assert_eq!((matched, declined), (9_760, 1_220), "{host}");
    }
}

/// Every output of conv for 9-65-sample courses with 2-33-tap kernels, real and
/// complex, and sparse courses of 300-2000 samples. Sparse complex courses longer
/// than 800 samples are outside the model: MATLAB orders a few outputs near
/// multiples of 512 differently. Their count is part of the evidence.
#[test]
fn short_and_sparse_convolutions_match_matlab() {
    const EXPECTED: (usize, usize, usize) = (1_308, 10, 95);
    let Some((root, amd, intel)) = hosts() else { return };
    for host in [&amd, &intel] {
        let (dir, cases) = cases(&root, host);
        let (mut checked, mut outside, mut outside_differing) = (0, 0, 0);
        for (id, case) in cases.iter().filter(|(_, case)| case["kind"] == "conv") {
            let y = complex(&dir, &case["y"]);
            let kernel = real(&dir, &case["kernel"]);
            let expected = complex(&dir, &case["result"]);
            let actual: Vec<Complex64> = if case["isreal"] == true {
                let re: Vec<f64> = y.iter().map(|v| v.re).collect();
                m::convolve_real(&re, &kernel, 1).into_iter().map(|v| Complex64::new(v, 0.0)).collect()
            } else {
                m::convolve_complex(&y, &kernel, 1)
            };
            let differing = (0..y.len()).filter(|&k| !(same(actual[k].re, expected[k].re) && same(actual[k].im, expected[k].im))).count();
            let sparse = 4 * y.iter().filter(|v| v.re != 0.0 || v.im != 0.0).count() < y.len();
            if case["isreal"] == false && sparse && y.len() > 800 {
                outside += 1;
                outside_differing += differing;
                continue;
            }
            assert_eq!(differing, 0, "{host} {id}");
            checked += 1;
        }
        eprintln!("{host}: {checked} convolutions exact; {outside} outside the model with {outside_differing} differing outputs");
        assert_eq!((checked, outside, outside_differing), EXPECTED, "{host}");
    }
}
