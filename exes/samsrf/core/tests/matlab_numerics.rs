//! MATLAB R2023b's arithmetic on generated inputs (`record_numerics_probes.m`,
//! pinned by `numerics-reference.json`), compared operation by operation with
//! `matlab_math`. The workflow supplies the recording; without it these return.
use num_complex::Complex64;
use samsrf_core::matlab_math as m;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const AMD: &str = "ubuntu-24.04";
const INTEL: &str = "ubuntu-22.04";

fn root() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("SAMSRF_MATLAB_NUMERICS_DIR")?);
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    // The recording's hosts are part of the evidence, not interchangeable labels.
    assert!(manifest["hosts"][AMD]["cpu"].as_str().unwrap().starts_with("AMD EPYC"));
    assert!(manifest["hosts"][INTEL]["cpu"].as_str().unwrap().starts_with("Intel(R) Xeon"));
    Some(root)
}

fn cases(root: &Path, host: &str, process: &str) -> (PathBuf, BTreeMap<String, Value>) {
    let dir = root.join(host).join(process);
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

#[test]
fn elementary_functions_are_fdlibm_on_intel_and_amd() {
    let Some(root) = root() else { return };
    for host in [AMD, INTEL] {
        let (dir, cases) = cases(&root, host, "compatible");
        for (id, f) in [("exp_double", m::exp as fn(f64) -> f64), ("log_double", m::log), ("sin_double", m::sin), ("cos_double", m::cos)] {
            let input = real(&dir, &cases[id]["input"]);
            let result = real(&dir, &cases[id]["result"]);
            assert!(input.len() > 8000);
            for (x, expected) in input.iter().zip(&result) {
                assert!(same(f(*x), *expected), "{host} {id}({x:e}) = {:e}, MATLAB {expected:e}", f(*x));
            }
        }
        let case = &cases["pow_double"];
        let (base, exponent, result) = (real(&dir, &case["base"]), real(&dir, &case["exponent"]), real(&dir, &case["result"]));
        for ((x, y), expected) in base.iter().zip(&exponent).zip(&result) {
            assert!(same(m::pow(*x, *y), *expected), "{host} pow({x:e}, {y}) != {expected:e}");
        }
    }
}

/// Every MATLAB power is reproduced, including half-integer exponents and the
/// NaN and infinite parts of overflowing results. The only difference allowed is
/// the sign of a zero part of an underflowed result; the count of such parts is
/// part of the evidence.
#[test]
fn negative_base_powers_match_every_matlab_result() {
    let Some(root) = root() else { return };
    let (dir, cases) = cases(&root, AMD, "compatible");
    let (mut compared, mut nonfinite, mut zero_signs) = (0, 0, 0);
    for case in cases.values().filter(|case| case["kind"] == "power") {
        let exponent = case["exponent"].as_f64().unwrap();
        let base = real(&dir, &case["base"]);
        let result = complex(&dir, &case["result"]);
        for (x, expected) in base.iter().zip(&result) {
            compared += 1;
            nonfinite += usize::from(!(expected.re.is_finite() && expected.im.is_finite()));
            let actual = m::power(*x, exponent);
            for (a, b) in [(actual.re, expected.re), (actual.im, expected.im)] {
                if same(a, b) {
                    continue;
                }
                assert!(a == 0.0 && b == 0.0, "({x:e})^{exponent} = {actual}, MATLAB {expected}");
                zero_signs += 1;
            }
        }
    }
    assert_eq!((compared, nonfinite, zero_signs), (13_776, 1_688, 2_440));
}

/// Every output SamSrf keeps, for every recorded course and kernel length (1-129
/// taps, 16-1000 samples, dense and sparse). Not covered (validation/matlab/README.md):
/// sparse complex courses of 1000 samples, where a few outputs near output 512
/// differ by one ULP.
#[test]
fn convolution_matches_matlab_for_every_recorded_length() {
    let Some(root) = root() else { return };
    let (dir, cases) = cases(&root, AMD, "compatible");
    let mut checked = 0;
    for (id, case) in cases.iter().filter(|(_, case)| case["kind"] == "conv") {
        let y = complex(&dir, &case["y"]);
        let kernel = real(&dir, &case["kernel"]);
        let expected = complex(&dir, &case["result"]);
        let sparse = 4 * y.iter().filter(|v| v.re != 0.0 || v.im != 0.0).count() < y.len();
        if case["isreal"] == false && sparse && y.len() >= 1000 {
            continue;
        }
        let actual: Vec<Complex64> = if case["isreal"] == true {
            let re: Vec<f64> = y.iter().map(|v| v.re).collect();
            m::convolve_real(&re, &kernel, 1).into_iter().map(|v| Complex64::new(v, 0.0)).collect()
        } else {
            m::convolve_complex(&y, &kernel, 1)
        };
        for k in 0..y.len() {
            assert!(same(actual[k].re, expected[k].re) && same(actual[k].im, expected[k].im), "{id} output {k}: {} != {}", actual[k], expected[k]);
        }
        checked += 1;
    }
    assert_eq!(checked, 288, "convolutions");
}

/// The HRF kernels at six TRs: `gampdf`, both double-gamma kernels and the scaled
/// `samsrf_hrf`, bit for bit, on both hosts. These grids were not used to identify
/// the `gampdf` form (numerics2-reference.json).
#[test]
fn hrf_kernels_match_matlab_at_six_trs() {
    let Some(root) = root() else { return };
    use samsrf_core::hrf;
    let mut checked = 0;
    for host in [AMD, INTEL] {
        let (dir, cases) = cases(&root, host, "compatible");
        for case in cases.values().filter(|case| case["kind"] == "hrf") {
            let tr = case["tr"].as_f64().unwrap();
            let time = real(&dir, &case["time"]);
            for (key, shape) in [("canonicalG1", 6.0), ("canonicalG2", 16.0), ("haasG1", 5.5278), ("haasG2", 16.8621)] {
                let expected = real(&dir, &case[key]);
                for (t, e) in time.iter().zip(&expected) {
                    assert!(same(hrf::gampdf(*t, shape, 1.0), *e), "{host} TR {tr} {key} at {t}");
                }
            }
            let kernels = [
                ("canonical", hrf::spm_canonical(tr)),
                ("haas", hrf::doublegamma(tr, &[5.5278, 16.8621, 1.0, 1.0, 1.0205, 0.0, 32.0])),
                ("samsrfHrf", hrf::de_haas(tr)),
            ];
            for (key, actual) in kernels {
                let expected = real(&dir, &case[key]);
                assert_eq!(actual.len(), expected.len(), "{host} TR {tr} {key}");
                for (a, e) in actual.iter().zip(&expected) {
                    assert!(same(*a, *e), "{host} TR {tr} {key}: {a:e} != {e:e}");
                }
            }
            checked += 1;
        }
    }
    assert_eq!(checked, 12);
}

/// MKL's SSE2 kernels on the AMD host. MATLAB's real `x'*y` takes another path
/// for 8-19 elements, shorter than any SamSrf time course.
#[test]
fn dot_products_and_norms_match_mkl_on_the_amd_reference_host() {
    let Some(root) = root() else { return };
    let (dir, cases) = cases(&root, AMD, "compatible");
    let mut checked = 0;
    for case in cases.values().filter(|case| case["kind"] == "blas") {
        let (x, y, z) = (real(&dir, &case["x"]), real(&dir, &case["y"]), complex(&dir, &case["z"]));
        let n = x.len();
        if n >= 20 {
            assert!(same(m::ddot(&x, &y), real(&dir, &case["dot"])[0]), "ddot n={n}");
        }
        let dot = complex(&dir, &case["complexDot"])[0];
        let actual = m::zdotc_real(&z, &y);
        assert!(same(actual.re, dot.re) && same(actual.im, dot.im), "zdotc n={n}");
        assert!(same(m::nrm2(x.iter().copied()), real(&dir, &case["norm"])[0]), "dnrm2 n={n}");
        assert!(same(m::nrm2(z.iter().flat_map(|v| [v.re, v.im])), real(&dir, &case["complexNorm"])[0]), "dznrm2 n={n}");
        checked += 1;
    }
    assert_eq!(checked, 24);
}

/// Reproducibility evidence: only the MKL results depend on the host, and on the
/// Intel host MATLAB's results are identical whether MKL_CBWR requests AUTO or
/// COMPATIBLE, so that request does not select MKL's branch inside MATLAB.
#[test]
fn only_blas_differs_across_hosts_and_mkl_cbwr_does_not_change_matlab() {
    let Some(root) = root() else { return };
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let files = manifest["files"].as_object().unwrap();
    let hash = |host: &str, process: &str, name: &str| files[&format!("{host}/{process}/{name}")].as_str().unwrap().to_string();
    let (_, cases) = cases(&root, AMD, "compatible");
    let mut blas_differs = 0;
    let mut checked = 0;
    for case in cases.values() {
        let names = case.as_object().unwrap().values()
            .filter(|v| v.get("file").is_some())
            .flat_map(|descriptor| ["file", "imaginary"].into_iter()
                .filter_map(move |key| descriptor[key].as_str().filter(|name| !name.is_empty())));
        for name in names {
            checked += 1;
            for process in ["compatible", "repeat"] {
                assert_eq!(hash(AMD, process, name), hash(AMD, "compatible", name), "AMD repeat {name}");
                assert_eq!(hash(INTEL, process, name), hash(INTEL, "compatible", name), "Intel repeat {name}");
            }
            if case["kind"] == "blas" {
                assert_eq!(hash(INTEL, "auto", name), hash(INTEL, "compatible", name), "Intel AUTO {name}");
                assert_eq!(hash(AMD, "auto", name), hash(AMD, "compatible", name), "AMD AUTO {name}");
                blas_differs += usize::from(hash(INTEL, "compatible", name) != hash(AMD, "compatible", name));
            } else {
                assert_eq!(hash(INTEL, "compatible", name), hash(AMD, "compatible", name), "{name} differs across hosts");
            }
        }
    }
    assert_eq!(checked, 1_584, "real and imaginary arrays checked per process");
    assert_eq!(blas_differs, 83, "BLAS arrays that differ across hosts");
}
