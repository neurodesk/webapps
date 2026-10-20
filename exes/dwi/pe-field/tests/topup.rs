// SPDX-License-Identifier: Apache-2.0
//! Holds the coefficient evaluation to the field topup itself writes (`--fout`), on the two
//! synthetic cases of tests/fixtures/topup.json (tools/topup_reference.py).

use dwi_pe_field::{Affine, PhaseEncoding, TopupCoefficients, displacement_lps, fsl_flips_x};
use serde_json::Value;

fn fixture() -> Value {
    let path = format!("{}/tests/fixtures/topup.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn numbers(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

fn float32(v: &Value) -> Vec<f32> {
    numbers(v).into_iter().map(|x| x as f32).collect()
}

fn dims(v: &Value) -> [usize; 3] {
    let n = numbers(v);
    [n[0] as usize, n[1] as usize, n[2] as usize]
}

fn affine(v: &Value) -> Affine {
    let rows: Vec<Vec<f64>> = v.as_array().unwrap().iter().map(numbers).collect();
    std::array::from_fn(|r| std::array::from_fn(|c| rows[r][c]))
}

fn datain(row: &Value) -> PhaseEncoding {
    let r = numbers(row);
    PhaseEncoding::from_datain(&format!("{} {} {} {}", r[0], r[1], r[2], r[3])).unwrap()
}

fn coefficients(case: &Value) -> TopupCoefficients {
    let k = numbers(&case["knot_spacing"]);
    TopupCoefficients::new(
        dims(&case["coef_dims"]),
        [k[0], k[1], k[2]],
        &float32(&case["coefficients"]),
    )
    .unwrap()
}

fn relative_error(ours: &[f64], theirs: &[f32]) -> f64 {
    let scale = theirs.iter().fold(0.0f64, |m, &x| m.max((x as f64).abs()));
    let diff = ours
        .iter()
        .zip(theirs)
        .fold(0.0f64, |m, (&a, &b)| m.max((a - b as f64).abs()));
    diff / scale
}

#[test]
fn evaluates_the_field_that_topup_writes() {
    let f = fixture();
    for case in f["cases"].as_array().unwrap() {
        assert_eq!(
            case["intent_code"].as_i64().unwrap(),
            dwi_pe_field::INTENT_TOPUP_CUBIC_SPLINE as i64
        );
        let a = affine(&case["affine"]);
        let hz = coefficients(case)
            .evaluate(dims(&case["dims"]), fsl_flips_x(&a))
            .unwrap();
        let error = relative_error(&hz, &float32(&case["fout"]));
        eprintln!("case {}: {error:.2e} of the largest |field|", case["name"]);
        // topup writes --fout as float32: 6e-8 relative is its rounding.
        assert!(error <= 1e-6, "{error}");
    }
}

#[test]
fn the_x_flip_matters_for_a_positive_determinant() {
    let f = fixture();
    let case = &f["cases"][1];
    assert!(fsl_flips_x(&affine(&case["affine"])));
    let hz = coefficients(case)
        .evaluate(dims(&case["dims"]), false)
        .unwrap();
    let error = relative_error(&hz, &float32(&case["fout"]));
    assert!(error > 0.1, "{error}");
}

#[test]
fn the_displacement_undoes_the_distortion() {
    // The generator moved the first image's signal by +true_field·readout voxels along the
    // file's voxel axis. The unwarping displacement must point the same way, for both
    // affine handednesses.
    let f = fixture();
    let readout = f["readout_time"].as_f64().unwrap();
    for case in f["cases"].as_array().unwrap() {
        let a = affine(&case["affine"]);
        let d = dims(&case["dims"]);
        let pe = datain(&case["datain"][0]);
        let hz = coefficients(case).evaluate(d, fsl_flips_x(&a)).unwrap();
        let displacement = displacement_lps(&hz, &a, &pe);
        let axis = pe.voxel_axis(&a);
        let column = [-a[0][axis], -a[1][axis], a[2][axis]];
        let spacing2: f64 = column.iter().map(|c| c * c).sum();
        let truth = numbers(&case["true_field"]);
        let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
        for (v, disp) in displacement.iter().enumerate() {
            let ijk = [v % d[0], (v / d[0]) % d[1], v / (d[0] * d[1])];
            if (0..3).any(|k| ijk[k] < 3 || ijk[k] + 3 >= d[k]) {
                continue;
            }
            // Voxels along the file's axis.
            let voxels =
                (disp[0] * column[0] + disp[1] * column[1] + disp[2] * column[2]) / spacing2;
            let expected = truth[v] * readout;
            sxy += voxels * expected;
            sxx += voxels * voxels;
            syy += expected * expected;
        }
        let r = sxy / (sxx * syy).sqrt();
        eprintln!("case {}: r = {r:.3}", case["name"]);
        assert!(r > 0.8, "case {}: r = {r}", case["name"]);
    }
}
