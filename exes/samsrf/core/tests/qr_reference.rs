//! MATLAB R2023b's `[ones x] \ y` (and `[x ones] \ y`) for 348 recorded
//! designs. The native workflow downloads the pinned recording
//! (packages/samsrf/validation/matlab/qr-reference.json) and sets
//! SAMSRF_QR_REFERENCE_DIR. MATLAB ran MKL's `CNR branch auto` on AMD EPYC
//! 7763 hosts. Every rank and rank-warning tolerance must match. Coefficients
//! are frozen per case in tests/data/qr-outcomes.json (300 bit-identical, the
//! others no further in ULPs than recorded) and must stay within an empirical
//! acceptance scale. This is measured agreement with that backend on this
//! finite set, not bit parity on arbitrary inputs.
use num_complex::Complex64;
use samsrf_core::{lstsq, precision::Precision};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn recording() -> Option<(PathBuf, Vec<Value>)> {
    let root = PathBuf::from(std::env::var_os("SAMSRF_QR_REFERENCE_DIR")?).join("ubuntu-24.04").join("compatible");
    let metadata: Value = serde_json::from_slice(&std::fs::read(root.join("qr.json")).unwrap()).unwrap();
    assert_eq!(metadata["environment"]["interpreter"], "MATLAB", "Octave is not a numerical reference");
    let cases = metadata["cases"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 348, "missing recorded least-squares cases");
    Some((root, cases))
}

fn array(root: &Path, file: &str, shape: &Value) -> Vec<f64> {
    assert_eq!(Path::new(file).file_name().unwrap(), file);
    let bytes = std::fs::read(root.join(file)).unwrap();
    let count: usize = shape.as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).product();
    assert_eq!(bytes.len(), count * 8, "{file}");
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn complex(root: &Path, descriptor: &Value) -> Vec<Complex64> {
    let re = array(root, descriptor["file"].as_str().unwrap(), &descriptor["shape"]);
    let im = match descriptor["imaginary"].as_str().filter(|s| !s.is_empty()) {
        Some(file) => array(root, file, &descriptor["shape"]),
        None => vec![0.0; re.len()],
    };
    re.into_iter().zip(im).map(|(re, im)| Complex64::new(re, im)).collect()
}

/// Euclidean norm without overflow or underflow at the recorded extremes.
fn norm(values: impl Iterator<Item = f64> + Clone) -> f64 {
    let scale = values.clone().map(f64::abs).fold(0.0, f64::max);
    if scale == 0.0 || !scale.is_finite() {
        return scale;
    }
    scale * values.map(|v| (v / scale).powi(2)).sum::<f64>().sqrt()
}

struct Case {
    id: String,
    single: bool,
    port: lstsq::Solution,
    matlab: Vec<Complex64>,
    warning: Option<(usize, f64)>,
    tolerance: f64,
    /// MATLAB's `qr(A,0)` R (column-major) and zero-based pivot.
    matlab_r: Vec<Complex64>,
    matlab_pivot: Vec<usize>,
    /// ||A||_F ||b||_2 and ||y - A b||_2 with MATLAB's b and the inputs in
    /// the design's class, for the acceptance scale.
    observations: f64,
    residual: f64,
}

fn cases() -> Option<Vec<Case>> {
    let (root, cases) = recording()?;
    Some(cases.iter().map(|case| {
        let single = case["precision"] == "single";
        let x = complex(&root, &case["x"]);
        let y: Vec<f64> = array(&root, case["y"]["file"].as_str().unwrap(), &case["y"]["shape"]);
        let ones = vec![Complex64::new(1.0, 0.0); x.len()];
        let columns: [&[Complex64]; 2] = if case["order"] == "ones-first" { [&ones, &x] } else { [&x, &ones] };
        let precision = if single { Precision::Single } else { Precision::Double };
        let port = lstsq::mldivide(&columns, &y, precision);
        let message = case["warning"].as_str().unwrap_or("");
        let warning = message.strip_prefix("Rank deficient, rank = ").map(|rest| {
            let (rank, tolerance) = rest.split_once(", tol = ").unwrap();
            (rank.parse().unwrap(), tolerance.trim().trim_end_matches('.').parse().unwrap())
        });
        assert!(warning.is_some() || message.is_empty(), "{}: unexpected warning {message}", case["id"]);
        let complex_design = x.iter().any(|v| if single { v.im as f32 != 0.0 } else { v.im != 0.0 });
        let r11 = complex(&root, &case["rWithoutRhs"])[0].norm();
        let epsilon = if single { f64::from(f32::EPSILON) } else { f64::EPSILON };
        let factor = if complex_design { 10.0 } else { 1.0 };
        let matlab = complex(&root, &case["beta"]);
        let class = |v: Complex64| if single { Complex64::new(f64::from(v.re as f32), f64::from(v.im as f32)) } else { v };
        let converted: Vec<Vec<Complex64>> = columns.iter().map(|c| c.iter().map(|&v| class(v)).collect()).collect();
        let design = norm(converted.iter().flatten().flat_map(|v| [v.re, v.im]));
        let observations = design * norm(matlab.iter().flat_map(|b| [b.re, b.im]));
        let residuals: Vec<Complex64> = y.iter().enumerate()
            .map(|(i, &y)| Complex64::new(y, 0.0) - converted[0][i] * matlab[0] - converted[1][i] * matlab[1])
            .collect();
        let residual = norm(residuals.iter().flat_map(|r| [r.re, r.im]));
        Case {
            id: case["id"].as_str().unwrap().into(),
            single,
            port,
            matlab,
            warning,
            tolerance: factor * y.len() as f64 * epsilon * r11,
            matlab_r: complex(&root, &case["rWithoutRhs"]),
            matlab_pivot: array(&root, case["pivotWithoutRhs"]["file"].as_str().unwrap(), &case["pivotWithoutRhs"]["shape"])
                .iter().map(|&p| p as usize - 1).collect(),
            observations,
            residual,
        }
    }).collect())
}

#[test]
fn rank_and_tolerance_match_every_matlab_warning() {
    let Some(cases) = cases() else { return; };
    let mut deficient = 0;
    for case in &cases {
        match case.warning {
            Some((rank, tolerance)) => {
                deficient += 1;
                assert_eq!(case.port.rank, rank, "{}: rank", case.id);
                // MATLAB prints the tolerance to seven significant digits.
                assert!((case.tolerance - tolerance).abs() <= 5e-7 * tolerance, "{}: tolerance {} != {tolerance}", case.id, case.tolerance);
            }
            None => assert_eq!(case.port.rank, 2, "{}: MATLAB found full rank", case.id),
        }
        for (port, matlab) in case.port.coefficients.iter().zip(&case.matlab) {
            if case.port.rank < 2 && *matlab == Complex64::new(0.0, 0.0) {
                continue;
            }
            assert!(port.re.is_finite() && port.im.is_finite(), "{}", case.id);
        }
    }
    assert_eq!(deficient, 89, "missing rank-deficient recordings");
}

/// An empirical acceptance scale for each coefficient, shaped like the
/// first-order least-squares perturbation estimate
/// eps * ||row of R^-1|| * (||A|| ||b|| + kappa ||r||), from MATLAB's own R,
/// pivot and coefficients. It is not a proven bound on either solver's error
/// and its constant (1) is not derived; 0.93 is the largest measured ratio.
/// Columns beyond MATLAB's rank have none.
fn scales(case: &Case) -> Vec<Option<f64>> {
    let epsilon = if case.single { f64::from(f32::EPSILON) } else { f64::EPSILON };
    let r = &case.matlab_r;
    let rank = case.warning.map_or(2, |(rank, _)| rank);
    let (rows, kappa): (Vec<f64>, f64) = match rank {
        2 => {
            // Column-major 2x2: R11, R21 (zero), R12, R22.
            let (r11, r12, r22) = (r[0].norm(), r[2].norm(), r[3].norm());
            let rows = vec![(1.0 / (r11 * r11) + (r12 / (r11 * r22)).powi(2)).sqrt(), 1.0 / r22];
            let inverse = rows.iter().map(|v| v * v).sum::<f64>().sqrt();
            (rows, (r11 * r11 + r12 * r12 + r22 * r22).sqrt() * inverse)
        }
        1 => (vec![1.0 / r[0].norm()], 1.0),
        _ => (vec![], 1.0),
    };
    let mut result = vec![None; case.matlab.len()];
    for (position, row) in rows.into_iter().enumerate() {
        result[case.matlab_pivot[position]] = Some(epsilon * row * (case.observations + kappa * case.residual));
    }
    result
}

/// Units in the last place of the design's class between two values.
fn ulps(a: f64, b: f64, single: bool) -> u64 {
    if a == b {
        return 0;
    }
    if !a.is_finite() || !b.is_finite() {
        return u64::MAX;
    }
    let ordered = |v: f64| -> i128 {
        if single {
            let bits = (v as f32).to_bits() as i32;
            i128::from(if bits < 0 { -(bits & 0x7fff_ffff) } else { bits })
        } else {
            let bits = v.to_bits() as i64;
            i128::from(if bits < 0 { -(bits & 0x7fff_ffff_ffff_ffff) } else { bits })
        }
    };
    (ordered(a) - ordered(b)).unsigned_abs() as u64
}

fn outcome(case: &Case) -> Value {
    let distances: Vec<[u64; 2]> = case.port.coefficients.iter().zip(&case.matlab)
        .map(|(p, m)| [ulps(p.re, m.re, case.single), ulps(p.im, m.im, case.single)])
        .collect();
    let exact = case.port.coefficients.iter().zip(&case.matlab)
        .all(|(p, m)| p.re.to_bits() == m.re.to_bits() && p.im.to_bits() == m.im.to_bits());
    serde_json::json!({ "exact": exact, "ulps": distances })
}

#[test]
fn coefficients_stay_within_frozen_outcomes_and_the_acceptance_scale() {
    let Some(cases) = cases() else { return; };
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/qr-outcomes.json");
    if std::env::var_os("SAMSRF_QR_WRITE_OUTCOMES").is_some() {
        let frozen: serde_json::Map<String, Value> = cases.iter().map(|case| (case.id.clone(), outcome(case))).collect();
        std::fs::write(&path, serde_json::to_string_pretty(&frozen).unwrap() + "\n").unwrap();
    }
    let frozen: serde_json::Map<String, Value> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(frozen.len(), cases.len(), "every recorded case has a frozen outcome");
    let mut worst = (0.0, String::new());
    let mut exact = 0;
    for case in &cases {
        // Per case: a bit-identical case stays bit-identical, and no part of a
        // coefficient moves further from MATLAB's than when the file was written.
        let expected = &frozen[&case.id];
        let actual = outcome(case);
        if expected["exact"] == true {
            assert_eq!(actual["exact"], true, "{}: was bit-identical to MATLAB", case.id);
            exact += 1;
        }
        let parts = |v: &Value| v["ulps"].as_array().unwrap().iter().flat_map(|c| c.as_array().unwrap().clone()).map(|n| n.as_u64().unwrap()).collect::<Vec<_>>();
        for (now, then) in parts(&actual).into_iter().zip(parts(expected)) {
            assert!(now <= then, "{}: {now} ULPs from MATLAB, frozen at {then}", case.id);
        }
        let complex_result = case.matlab.iter().any(|c| c.im != 0.0);
        for ((port, matlab), scale) in case.port.coefficients.iter().zip(&case.matlab).zip(scales(case)) {
            if !complex_result {
                assert_eq!(port.im, 0.0, "{}: MATLAB's result is real", case.id);
            }
            let Some(scale) = scale else {
                assert_eq!(*port, Complex64::new(0.0, 0.0), "{}: dropped column", case.id);
                assert_eq!(*matlab, Complex64::new(0.0, 0.0), "{}: dropped column", case.id);
                continue;
            };
            // Real and imaginary parts enter the distance together.
            let ratio = if port == matlab { 0.0 } else { (port - matlab).norm() / scale };
            assert!(ratio <= 1.0, "{}: |{port} - {matlab}| is {ratio} acceptance scales", case.id);
            if ratio > worst.0 {
                worst = (ratio, case.id.clone());
            }
        }
    }
    eprintln!("largest acceptance ratio {worst:?}; {exact} bit-identical cases");
    assert_eq!(exact, 300, "frozen bit-identical cases");
}

/// With SAMSRF_QR_REPORT set, write the port's coefficients for the analysis
/// in packages/samsrf/validation/matlab/qr-accuracy.py.
#[test]
fn coefficients_report() {
    let Some(cases) = cases() else { return; };
    let Some(path) = std::env::var_os("SAMSRF_QR_REPORT") else { return; };
    let rows: Vec<Value> = cases.iter().map(|case| serde_json::json!({
        "id": case.id,
        "rank": case.port.rank,
        "re": case.port.coefficients.iter().map(|c| c.re).collect::<Vec<_>>(),
        "im": case.port.coefficients.iter().map(|c| c.im).collect::<Vec<_>>(),
        "pivot": case.port.pivot,
        "r": case.port.r.iter().flatten().map(|c| [c.re, c.im]).collect::<Vec<_>>(),
    })).collect();
    std::fs::write(path, serde_json::to_string(&rows).unwrap()).unwrap();
}
