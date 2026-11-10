//! MATLAB R2023b's `[ones x] \ y` (and `[x ones] \ y`) for 348 recorded
//! designs. The native workflow downloads the pinned recording
//! (packages/samsrf/validation/matlab/qr-reference.json) and sets
//! SAMSRF_QR_REFERENCE_DIR. MATLAB ran MKL's `CNR branch auto` on AMD EPYC
//! 7763 hosts. 123 of the 348 cases are bit-identical; the others are gated
//! by the least-squares rounding scale, so this is measured agreement with
//! that backend on this finite set, not bit parity on arbitrary inputs.
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
    /// ||A||_F ||b||_2 and ||y - A b||_2 (MATLAB's b), for the rounding scale.
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
        let design = norm(columns.iter().flat_map(|c| c.iter()).flat_map(|v| [v.re, v.im]));
        let observations = design * norm(matlab.iter().flat_map(|b| [b.re, b.im]));
        let residuals: Vec<Complex64> = y.iter().enumerate()
            .map(|(i, &y)| Complex64::new(y, 0.0) - columns[0][i] * matlab[0] - columns[1][i] * matlab[1])
            .collect();
        let residual = norm(residuals.iter().flat_map(|r| [r.re, r.im]));
        Case {
            id: case["id"].as_str().unwrap().into(),
            single,
            port,
            matlab,
            warning,
            tolerance: factor * y.len() as f64 * epsilon * r11,
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

/// The standard least-squares perturbation scale of each coefficient,
/// eps * ||row of R^-1|| * (||A|| ||b|| + kappa ||r||), in original column order.
/// Columns beyond the rank have none.
fn scales(case: &Case) -> Vec<Option<f64>> {
    let epsilon = if case.single { f64::from(f32::EPSILON) } else { f64::EPSILON };
    let r = &case.port.r;
    let (rows, kappa): (Vec<f64>, f64) = match case.port.rank {
        2 => {
            let (r11, r12, r22) = (r[0][0].norm(), r[0][1].norm(), r[1][1].norm());
            let rows = vec![(1.0 / (r11 * r11) + (r12 / (r11 * r22)).powi(2)).sqrt(), 1.0 / r22];
            let inverse = rows.iter().map(|v| v * v).sum::<f64>().sqrt();
            (rows, (r11 * r11 + r12 * r12 + r22 * r22).sqrt() * inverse)
        }
        1 => (vec![1.0 / r[0][0].norm()], 1.0),
        _ => (vec![], 1.0),
    };
    let mut result = vec![None; case.port.coefficients.len()];
    for (position, row) in rows.into_iter().enumerate() {
        result[case.port.pivot[position]] = Some(epsilon * row * (case.observations + kappa * case.residual));
    }
    result
}

#[test]
fn coefficients_agree_within_the_measured_rounding_scale() {
    let Some(cases) = cases() else { return; };
    let mut worst: std::collections::BTreeMap<String, (f64, String)> = Default::default();
    let mut exact: std::collections::BTreeMap<String, usize> = Default::default();
    for case in &cases {
        let complex_result = case.matlab.iter().any(|c| c.im != 0.0);
        let group = format!("{}-{}", if case.single { "single" } else { "double" }, if complex_result { "complex" } else { "real" });
        if case.port.coefficients.iter().zip(&case.matlab).all(|(p, m)| p.re.to_bits() == m.re.to_bits() && p.im.to_bits() == m.im.to_bits()) {
            *exact.entry(group.clone()).or_default() += 1;
        }
        for ((port, matlab), scale) in case.port.coefficients.iter().zip(&case.matlab).zip(scales(case)) {
            if !complex_result {
                assert_eq!(port.im, 0.0, "{}: MATLAB's result is real", case.id);
            }
            let Some(scale) = scale else {
                assert_eq!(*port, Complex64::new(0.0, 0.0), "{}: dropped column", case.id);
                assert_eq!(*matlab, Complex64::new(0.0, 0.0), "{}: dropped column", case.id);
                continue;
            };
            // Both the real and the imaginary part enter the distance. The
            // largest measured ratio is 0.93 (random_double_9).
            let ratio = if port == matlab { 0.0 } else { (port - matlab).norm() / scale };
            assert!(ratio <= 1.0, "{}: |{port} - {matlab}| is {ratio} rounding scales", case.id);
            let entry = worst.entry(group.clone()).or_insert((0.0, String::new()));
            if ratio > entry.0 {
                *entry = (ratio, case.id.clone());
            }
        }
    }
    eprintln!("largest ratios {worst:?}; bit-identical cases {exact:?}");
    // Bit-identical coefficients (both parts, both columns) with the recorded
    // MKL backend. A change that loses any of them is a regression.
    for (group, minimum) in [("double-complex", 6), ("double-real", 49), ("single-complex", 10), ("single-real", 58)] {
        assert!(exact.get(group).copied().unwrap_or(0) >= minimum, "{group}: fewer bit-identical cases than {minimum}");
    }
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
