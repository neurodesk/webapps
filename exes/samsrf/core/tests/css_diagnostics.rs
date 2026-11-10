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
    assert_eq!(cases.len(), 268, "missing recorded cases");
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
fn extreme_dot_sums_preserve_every_recorded_css_objective_decision() {
    let Some((root, cases)) = recording() else {
        return;
    };
    for vertex in [60, 69] {
        for control in [
            "nonnegative0_recorded",
            "nonnegative0_recomputed",
            "nonnegative1_recomputed",
        ] {
            let id = format!("css_pipeline_double_v{vertex}_{control}");
            let case = cases
                .iter()
                .find(|case| case["id"] == id)
                .expect("missing overflow trace");
            let predicted = complex_array(&root, &case["predictionTrace"]);
            let observed = array(&root, &case["observations"]);
            let expected = complex_array(&root, &case["errors"]);
            assert_eq!(predicted.len(), observed.len() * expected.len());
            for (evaluation, (x, expected)) in predicted
                .chunks_exact(observed.len())
                .zip(expected)
                .enumerate()
            {
                let actual = css::objective(x, &observed, Precision::Double);
                let finite = |v: Complex64| v.re.is_finite() && v.im.is_finite();
                assert_eq!(
                    finite(actual),
                    finite(expected),
                    "{id} evaluation {evaluation}: {actual} != {expected}"
                );
            }
        }
    }
    // These specific calls overflow the old sequential dot accumulator even
    // though MATLAB's dot is finite. Rotation exercises the imaginary component
    // against the same correlation identity, without inventing another fixture.
    for (vertex, evaluation) in [(60, 787), (69, 590)] {
        let id = format!("css_pipeline_double_v{vertex}_nonnegative0_recorded");
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        let predicted = complex_array(&root, &case["predictionTrace"]);
        let observed = array(&root, &case["observations"]);
        let expected = complex_array(&root, &case["errors"])[evaluation];
        let x = &predicted[evaluation * observed.len()..(evaluation + 1) * observed.len()];
        assert!(
            x.iter()
                .all(|value| value.im == 0.0 && value.re.is_finite())
        );
        assert!(expected.re.is_finite() && expected.im == 0.0);
        let actual = css::objective(x, &observed, Precision::Double);
        assert!(
            (actual - expected).norm() <= 16.0 * f64::EPSILON,
            "{id}: {actual} != {expected}"
        );
        let rotated: Vec<_> = x
            .iter()
            .map(|value| Complex64::new(0.0, value.re))
            .collect();
        let actual = css::objective(&rotated, &observed, Precision::Double);
        assert!(
            (actual - (2.0 - expected)).norm() <= 16.0 * f64::EPSILON,
            "{id}: {actual}"
        );
    }
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
    assert_eq!(beta.to_bits(), expected[1].to_bits());
    // QR's untruncated solve retains the baseline, unlike mldivide. It is
    // essential that this gate uses the recorded mldivide coefficients.
    assert_eq!(case["qrMatchesMldivide"], false);
    assert_ne!(array(&root, &case["betaFromQr"])[0], 0.0);
}

#[test]
fn overflowing_css_design_matches_the_recorded_tiny_coefficient() {
    let Some((root, cases)) = recording() else {
        return;
    };
    let case = cases
        .iter()
        .find(|c| c["id"] == "css_pipeline_double_v88_nonnegative0_recorded")
        .unwrap();
    assert_eq!(case["accepted"], false);
    let x = complex_array(&root, &case["prediction"]);
    let y = array(&root, &case["observations"]);
    let expected = array(&root, &case["candidateBeta"]);
    assert!(x.iter().map(|v| v.norm_sqr()).sum::<f64>().is_infinite());
    let (beta, baseline) = css::fit_betas(&x, &y, Precision::Double);
    assert_eq!(expected[0], 0.0);
    assert_eq!(baseline, expected[0]);
    assert!(expected[1] > 0.0 && expected[1] < 1e-307);
    assert_eq!(beta.to_bits(), expected[1].to_bits(), "{beta} != {}", expected[1]);
}
