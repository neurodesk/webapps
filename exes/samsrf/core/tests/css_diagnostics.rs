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
        assert!(same_complex(actual, expected), "{id}: {actual} != {expected}");
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
        assert!(same_complex(actual, expected), "{}: {actual} != {expected}", case["id"]);
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
    assert!(beta > 0.0 && beta < 1e-307);
    assert!(
        beta.to_bits().abs_diff(expected[1].to_bits()) <= 8,
        "{beta} != {} within 8 ULP",
        expected[1]
    );
}

/// The pinned pipeline inputs (apertures, HRF) that every trace was recorded with.
fn source_reference() -> PathBuf {
    PathBuf::from(
        std::env::var_os("SAMSRF_MATLAB_REFERENCE_DIR")
            .expect("CSS trace gates need SAMSRF_MATLAB_REFERENCE_DIR with the pinned source reference"),
    )
}

/// Equal bits, NaN to NaN, and zero to zero of either sign. When a negative
/// response's power underflows entirely, the signs of its zero parts can differ
/// from MATLAB's (`matlab_math::power`); no nonzero value may differ.
fn same(actual: f64, expected: f64) -> bool {
    actual.to_bits() == expected.to_bits() || actual.is_nan() && expected.is_nan() || actual == 0.0 && expected == 0.0
}

fn same_complex(actual: Complex64, expected: Complex64) -> bool {
    same(actual.re, expected.re) && same(actual.im, expected.im)
}

fn check_trace(reference: &Path, root: &Path, case: &Value) -> Result<usize, String> {
    use samsrf_core::{expr::{AnonymousFunction, Value as Expression}, fit_prf, hrf, mat, optim, prf};
    let id = case["id"].as_str().unwrap();
    let precision = match case["precision"].as_str() {
        Some("double") => Precision::Double,
        Some("single") => Precision::Single,
        _ => return Err(format!("{id}: missing precision")),
    };
    let pipeline: Value = serde_json::from_slice(
        &std::fs::read(reference.join(format!("{}.json", case["pipeline"].as_str().unwrap()))).unwrap(),
    )
    .unwrap();
    assert_eq!(pipeline["precision"], case["precision"], "{id}: pipeline precision");
    let model = &pipeline["model"];
    let mut apertures = mat::read_apertures(
        &std::fs::read(reference.join(format!("{}.mat", model["Aperture_File"].as_str().unwrap()))).unwrap(),
    )
    .unwrap();
    if case["nonnegativeApertures"] == true {
        for frame in &mut apertures.frames {
            for value in &mut frame.values {
                *value = value.max(0.0);
            }
        }
    }
    let xy = apertures.scaled_xy(model["Scaling_Factor"].as_f64().unwrap());
    let coordinates = fit_prf::xy_value(&xy);
    let function = AnonymousFunction::parse(model["Prf_Function"].as_str().unwrap()).unwrap();
    let kernel = array(reference, &pipeline["hrf"]);
    let downsampling = model["Downsample_Predictions"].as_u64().unwrap() as usize;
    let observed = array(root, &case["observations"]);
    let seed = array(root, &case["seed"]);
    let trace = array(root, &case["trace"]);
    let evaluations = case["trace"]["shape"][0].as_u64().unwrap() as usize;
    let raw = array(root, &case["rawTrace"]);
    let compressed = complex_array(root, &case["compressedTrace"]);
    let predicted = complex_array(root, &case["predictionTrace"]);
    let errors = complex_array(root, &case["errors"]);
    let volumes = observed.len();
    let parameters = |evaluation: usize| -> Vec<f64> {
        (0..seed.len()).map(|i| trace[i * evaluations + evaluation]).collect()
    };
    for (evaluation, &expected) in errors.iter().enumerate() {
        let p = parameters(evaluation);
        let exponent = *p.last().unwrap();
        let profile = function.evaluate(&[Expression::column(p.clone()), coordinates.clone()]).unwrap();
        let ours = prf::predict_timecourse(&profile.data, &apertures);
        let at = evaluation * volumes;
        for (k, &value) in ours.iter().enumerate() {
            if !same(value, raw[at + k]) {
                return Err(format!("{id}: evaluation {evaluation} raw {k}: {value:e} != {:e}", raw[at + k]));
            }
            let power = css::power(value, exponent);
            if !same_complex(power, compressed[at + k]) {
                return Err(format!("{id}: evaluation {evaluation} power {k}: {power} != {}", compressed[at + k]));
            }
        }
        let prediction = css::predict(&ours, exponent, &kernel, downsampling);
        for (k, value) in prediction.iter().enumerate() {
            if !same_complex(*value, predicted[at + k]) {
                return Err(format!("{id}: evaluation {evaluation} prediction {k}: {value} != {}", predicted[at + k]));
            }
        }
        let error = css::objective(&prediction, &observed, precision);
        let recorded = css::objective(&predicted[at..at + volumes], &observed, precision);
        if !same_complex(error, expected) || !same_complex(recorded, expected) {
            return Err(format!("{id}: evaluation {evaluation} objective {error} / {recorded} != {expected}"));
        }
    }
    let mut native = Vec::new();
    optim::fminsearch(
        |p| {
            native.push(p.to_vec());
            prf::errfun_with_convention(&function, &apertures, &xy, &hrf::ErrfunHrf::Kernel(kernel.clone()), p, &observed, downsampling, true, precision, css::Convention::Samsrf).unwrap()
        },
        &seed,
        &optim::FminsearchOptions {
            tol_x: model["Nelder_Mead_Tolerance"].as_f64().unwrap_or(1e-4),
            stop_when_not_finite: true,
            ..Default::default()
        },
    );
    if native.len() != evaluations {
        return Err(format!("{id}: {} native evaluations, MATLAB {evaluations}", native.len()));
    }
    for (evaluation, p) in native.iter().enumerate() {
        if p.iter().zip(parameters(evaluation)).any(|(a, b)| a.to_bits() != b.to_bits()) {
            return Err(format!("{id}: evaluation {evaluation} parameters {p:?} != {:?}", parameters(evaluation)));
        }
    }
    Ok(evaluations)
}

fn check_every_trace(precision: &str) {
    let Some((root, cases)) = recording() else {
        return;
    };
    let reference = source_reference();
    let traces: Vec<_> = cases
        .iter()
        .filter(|case| case["kind"] == "css-trace" && case["precision"] == precision && case["fineFitRun"] == true)
        .collect();
    assert_eq!(traces.len(), 54, "{precision} traces that ran a fine fit");
    let failures: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = traces
            .chunks(traces.len().div_ceil(8))
            .map(|chunk| {
                let (reference, root) = (&reference, &root);
                scope.spawn(move || chunk.iter().filter_map(|case| check_trace(reference, root, case).err()).collect::<Vec<_>>())
            })
            .collect();
        handles.into_iter().flat_map(|handle| handle.join().unwrap()).collect()
    });
    assert!(failures.is_empty(), "{} traces differ:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn every_double_css_trace_follows_matlab_operation_by_operation() {
    check_every_trace("double");
}

#[test]
fn every_single_css_trace_follows_matlab_operation_by_operation() {
    check_every_trace("single");
}
