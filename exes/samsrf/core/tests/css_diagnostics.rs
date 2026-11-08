//! Focused MATLAB evidence for extreme CSS scales. The workflow supplies the
//! pinned recording; these gates do not assert complete double CSS parity.
use num_complex::Complex64;
use samsrf_core::{css, precision::Precision};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn recording() -> Option<(PathBuf, Vec<Value>)> {
    let root = PathBuf::from(std::env::var_os("SAMSRF_CSS_DIAGNOSTICS_DIR")?);
    let metadata: Value =
        serde_json::from_slice(&std::fs::read(root.join("diagnostics.json")).unwrap()).unwrap();
    assert_eq!(
        metadata["smoke"], false,
        "Octave is not a numerical reference"
    );
    let cases = metadata["cases"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 238, "missing recorded cases");
    Some((root, cases))
}

fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name);
    let bytes = std::fs::read(root.join(name)).unwrap();
    let count: usize = descriptor["shape"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_u64().unwrap() as usize)
        .product();
    assert_eq!(bytes.len(), count * 8);
    bytes
        .as_chunks::<8>()
        .0
        .iter()
        .map(|b| f64::from_le_bytes(*b))
        .collect()
}

fn complex_array(root: &Path, descriptor: &Value) -> Vec<Complex64> {
    let real = array(root, descriptor);
    let imaginary = match descriptor["imaginary"].as_str().filter(|s| !s.is_empty()) {
        Some(name) => array(
            root,
            &serde_json::json!({"file":name,"shape":descriptor["shape"]}),
        ),
        None => vec![0.0; real.len()],
    };
    real.into_iter()
        .zip(imaginary)
        .map(|(re, im)| Complex64::new(re, im))
        .collect()
}

#[test]
fn double_css_objective_survives_recorded_underflow_and_overflow_scales() {
    let Some((root, cases)) = recording() else {
        return;
    };
    let mut count = 0;
    for case in cases.iter().filter(|c| c["kind"] == "css-correlation") {
        count += 1;
        let x = complex_array(&root, &case["prediction"]);
        let y = array(&root, &case["observations"]);
        let expected = complex_array(&root, &case["objective"])[0];
        let actual = css::objective(&x, &y, Precision::Double);
        assert!(
            actual.re.is_finite() && actual.im.is_finite(),
            "{}: {actual}",
            case["id"]
        );
        // Both components are dimensionless and bounded in these ten cases.
        assert!(
            (actual - expected).norm() <= 16.0 * f64::EPSILON,
            "{}: {actual} != {expected}",
            case["id"]
        );
    }
    assert_eq!(count, 10);
}

#[test]
fn complex_css_rank_threshold_drops_the_recorded_baseline_column() {
    let Some((root, cases)) = recording() else {
        return;
    };
    let case = cases
        .iter()
        .find(|c| c["id"] == "css_pipeline_double_v81_nonnegative0_recorded")
        .unwrap();
    let x = complex_array(&root, &case["prediction"]);
    let y = array(&root, &case["observations"]);
    let expected = array(&root, &case["candidateBeta"]);
    let (beta, baseline) = css::fit_betas(&x, &y, Precision::Double);
    assert_eq!(expected[0], 0.0);
    assert_eq!(baseline, expected[0]);
    assert!((beta - expected[1]).abs() <= 16.0 * f64::EPSILON * expected[1].abs());
    // QR's untruncated solve retains the baseline, unlike mldivide. It is
    // essential that this gate uses the recorded mldivide coefficients.
    assert_eq!(case["qrMatchesMldivide"], false);
    assert_ne!(array(&root, &case["betaFromQr"])[0], 0.0);
}
