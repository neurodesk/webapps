// SPDX-License-Identifier: BSD-3-Clause
//! Compares the displacement and the Jacobian with QSIPrep 26.1.1's `TopupFieldToWarp` and
//! `jacobian_determinant` (tests/fixtures/qsiprep.json, from tools/oracle.py), on case A's
//! topup field with an axis-aligned and an oblique affine.

use dwi_pe_field::{Affine, PhaseEncoding, displacement_lps, jacobian_pe, modulation_weights};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn numbers(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

#[test]
fn matches_qsiprep() {
    let topup = fixture("topup.json");
    let q = fixture("qsiprep.json");
    let case = &topup["cases"][0];
    assert_eq!(case["name"], q["case"]);
    let d = numbers(&case["dims"]);
    let dims = [d[0] as usize, d[1] as usize, d[2] as usize];
    // QSIPrep reads topup's float32 field.
    let hz: Vec<f64> = numbers(&case["fout"])
        .into_iter()
        .map(|x| x as f32 as f64)
        .collect();
    let row = numbers(&q["datain"][0]);
    let pe = PhaseEncoding::from_datain(&format!("{} {} {} {}", row[0], row[1], row[2], row[3]))
        .unwrap();
    for grid in q["grids"].as_array().unwrap() {
        let rows: Vec<Vec<f64>> = grid["affine"]
            .as_array()
            .unwrap()
            .iter()
            .map(numbers)
            .collect();
        let affine: Affine = std::array::from_fn(|r| std::array::from_fn(|c| rows[r][c]));
        let pe_axis = pe.voxel_axis(&affine);
        assert_eq!(pe_axis as u64, grid["pe_axis"].as_u64().unwrap());

        let ours = displacement_lps(&hz, &affine, &pe);
        let theirs = numbers(&grid["displacement"]);
        let scale = theirs.iter().fold(0.0f64, |m, x| m.max(x.abs()));
        let diff = ours
            .iter()
            .flatten()
            .zip(&theirs)
            .fold(0.0f64, |m, (a, b)| m.max((a - (*b as f32 as f64)).abs()));
        // QSIPrep multiplies in float32 and stores float32.
        let displacement_error = diff / scale;

        let (weights, _) = modulation_weights(&jacobian_pe(&ours, dims, &affine, pe_axis), None);
        let jacobian_error = weights
            .iter()
            .zip(numbers(&grid["jacobian"]))
            .fold(0.0f64, |m, (a, b)| m.max((a - b).abs()));
        eprintln!(
            "{}: displacement {displacement_error:.2e} of the largest, Jacobian {jacobian_error:.2e}",
            grid["label"]
        );
        assert!(displacement_error <= 1e-6, "{displacement_error}");
        assert!(jacobian_error <= 1e-5, "{jacobian_error}");
    }
}

#[test]
fn bids_direction_equals_the_datain_vector() {
    let radiological: Affine = [
        [-2.0, 0.0, 0.0, 0.0],
        [0.0, 2.0, 0.0, 0.0],
        [0.0, 0.0, 2.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let neurological: Affine = [
        [2.0, 0.0, 0.0, 0.0],
        [0.0, 2.0, 0.0, 0.0],
        [0.0, 0.0, 2.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let j = PhaseEncoding::from_bids("j-", 0.05, &radiological).unwrap();
    assert_eq!(j, PhaseEncoding::from_datain("0 -1 0 0.05").unwrap());
    let i = PhaseEncoding::from_bids("i", 0.05, &neurological).unwrap();
    assert_eq!(i, PhaseEncoding::from_datain("-1 0 0 0.05").unwrap());
    // Either way, the world step is the file's +i axis.
    assert_eq!(i.step_ras(&neurological), [2.0, 0.0, 0.0]);
    assert!(PhaseEncoding::from_bids("y", 0.05, &radiological).is_err());
    assert!(PhaseEncoding::from_bids("j", 0.0, &radiological).is_err());
    assert!(PhaseEncoding::from_datain("0 1 1 0.05").is_err());
}

#[test]
fn jacobian_of_a_linear_shift_is_constant() {
    // u_PE = 0.1 · (PE position in mm) gives a Jacobian of 1.1 inside, 1 on the edge slices.
    let dims = [4, 5, 3];
    let affine: Affine = [
        [-2.0, 0.0, 0.0, 0.0],
        [0.0, 2.5, 0.0, 0.0],
        [0.0, 0.0, 2.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let displacement: Vec<[f64; 3]> = (0..60)
        .map(|v| [0.0, -0.1 * 2.5 * ((v / 4) % 5) as f64, 0.0])
        .collect();
    let j = jacobian_pe(&displacement, dims, &affine, 1);
    for (v, &x) in j.iter().enumerate() {
        let y = (v / 4) % 5;
        let expected = if y == 0 || y == 4 { 1.0 } else { 1.1 };
        assert!((x - expected).abs() < 1e-12, "{v}: {x}");
    }
    let (weights, folds) = modulation_weights(&[0.5, -0.2, 1.0], Some(&[true, true, false]));
    assert_eq!((weights, folds), (vec![0.5, 0.2, 1.0], 1));
}
