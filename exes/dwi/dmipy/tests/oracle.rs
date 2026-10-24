// SPDX-License-Identifier: MIT
use dwi_dmipy::Model;
use serde_json::Value;

fn values(value: &Value) -> Vec<f64> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}

#[test]
fn forward_starting_grid_and_nonlinear_fit_follow_pinned_dmipy() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/oracle.json")).unwrap();
    let gradients = fixture["gradients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| values(v).try_into().unwrap())
        .collect::<Vec<_>>();
    let model = Model::new(&values(&fixture["bvals"]), &gradients).unwrap();
    let grid = fixture["grid"].as_array().unwrap();
    assert_eq!(model.starting_grid().len(), 3750);
    for (actual, expected) in model.starting_grid().iter().zip(grid) {
        for (&a, b) in actual.iter().zip(values(expected)) {
            assert!((a - b).abs() < 1e-14, "Grid differs: {a} != {b}");
        }
    }
    for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        let predicted = model
            .predict(values(&case["parameters"]).try_into().unwrap())
            .unwrap();
        let maximum = predicted
            .iter()
            .zip(values(&case["prediction"]))
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        assert!(
            maximum < 2e-12,
            "case{index} forward model maximum error {maximum}"
        );
        let signal = values(&case["measured"]);
        let start = model.starting_parameters(&signal).unwrap();
        for (&a, b) in start.iter().zip(values(&case["start"])) {
            assert!(
                (a - b).abs() < 1e-14,
                "case{index} starting parameters differ: {a} != {b}"
            );
        }
        let fit = model.fit(&signal).unwrap();
        let expected = values(&case["fitted"]);
        eprintln!(
            "case{index}: fit {:?}, reference {:?}, mse{} expected{}",
            fit.parameters, expected, fit.mse, case["objective"]
        );
        for (axis, &wanted) in expected.iter().enumerate().take(5).skip(2) {
            assert!(
                (fit.parameters[axis] - wanted).abs() < 2e-5,
                "case{index} map{axis} differs"
            );
        }
        assert!(
            (fit.mse - case["objective"].as_f64().unwrap()).abs() < 1e-9,
            "case{index} objective differs"
        );
    }
    assert!(model.fit(&vec![0.0; gradients.len()]).is_err());
    assert!(model.fit(&vec![f64::NAN; gradients.len()]).is_err());
}
