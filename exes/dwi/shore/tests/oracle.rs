// SPDX-License-Identifier: BSD-3-Clause
//! Compares the port with QSIPrep 26.1.1's 3dSHORE code on the committed fixtures, which
//! tools/oracle.py writes from QSIPrep's own Python.

use dwi_shore::{
    RADIAL_ORDER, TargetFit, ZETA, basis, nonoverlapping_samples, weights_with_penalty,
};
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

fn vectors(v: &Value) -> Vec<[f64; 3]> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|g| {
            let g = numbers(g);
            [g[0], g[1], g[2]]
        })
        .collect()
}

fn max_abs(v: impl IntoIterator<Item = f64>) -> f64 {
    v.into_iter().fold(0.0, |m, x| m.max(x.abs()))
}

#[test]
fn basis_equals_qsiprep() {
    let f = fixture("basis.json");
    let index: Vec<(usize, usize, i32)> = f["index"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let r = numbers(r);
            (r[0] as usize, r[1] as usize, r[2] as i32)
        })
        .collect();
    assert_eq!(basis::index_matrix(RADIAL_ORDER), index);
    let ours = basis::basis(
        RADIAL_ORDER,
        ZETA,
        dwi_shore::tau(),
        &numbers(&f["bvals"]),
        &vectors(&f["bvecs"]),
    )
    .unwrap();
    let theirs: Vec<Vec<f64>> = f["basis"].as_array().unwrap().iter().map(numbers).collect();
    let scale = max_abs(theirs.iter().flatten().copied());
    let mut worst = 0.0f64;
    for (a, b) in ours.iter().zip(&theirs) {
        assert_eq!(a.len(), 72);
        for (x, y) in a.iter().zip(b) {
            worst = worst.max((x - y).abs());
        }
    }
    eprintln!(
        "basis: max |difference| {worst:.2e}, {:.2e} of the largest entry",
        worst / scale
    );
    assert!(worst <= 1e-12, "{worst}");
    assert!(worst / scale <= 1e-12, "{}", worst / scale);
}

#[test]
fn leave_out_masks_equal_qsiprep() {
    let f = fixture("leaveout.json");
    let bvals = numbers(&f["bvals"]);
    let bvecs = vectors(&f["bvecs"]);
    let mut all_bvals = vec![0.0];
    all_bvals.extend(&bvals);
    let mut all_bvecs = vec![[0.0; 3]];
    all_bvecs.extend(&bvecs);
    for (t, keep) in f["keep"].as_array().unwrap().iter().enumerate() {
        let keep: Vec<bool> = keep
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_bool().unwrap())
            .collect();
        let ours = nonoverlapping_samples(
            bvals[t],
            bvecs[t],
            &all_bvals,
            &all_bvecs,
            f["cutoff"].as_f64().unwrap(),
        );
        assert_eq!(ours, keep, "target {t}");
    }
}

struct Data {
    bvals: Vec<f64>,
    bvecs: Vec<[f64; 3]>,
    mask: Vec<bool>,
    b0: Vec<f32>,
    dwis: Vec<Vec<f32>>,
}

fn data(f: &Value) -> Data {
    let to_f32 = |v: &Value| {
        numbers(v)
            .into_iter()
            .map(|x| x as f32)
            .collect::<Vec<f32>>()
    };
    let mask: Vec<f32> = to_f32(&f["mask"]);
    Data {
        bvals: numbers(&f["bvals"]),
        bvecs: vectors(&f["bvecs"]),
        mask: dwi_shore::mask_from_image(&mask),
        b0: to_f32(&f["b0_mean"]),
        dwis: f["dwis"].as_array().unwrap().iter().map(to_f32).collect(),
    }
}

/// max |ours - theirs| / max |theirs| over one volume.
fn volume_error(ours: &[f64], theirs: &[f64]) -> f64 {
    let diff = max_abs(ours.iter().zip(theirs).map(|(a, b)| a - b));
    diff / max_abs(theirs.iter().copied())
}

#[test]
fn weights_and_predictions_equal_qsiprep() {
    let f = fixture("predict.json");
    let d = data(&f);
    let refs: Vec<&[f32]> = d.dwis.iter().map(|v| v.as_slice()).collect();
    let mut worst_weight = 0.0f64;
    let mut worst_prediction = 0.0f64;
    for (t, (pred, w)) in f["predictions"]
        .as_array()
        .unwrap()
        .iter()
        .zip(f["weights"].as_array().unwrap())
        .enumerate()
    {
        let fit = TargetFit::new(&d.bvals, &d.bvecs, t).unwrap();
        let volumes: Vec<usize> = numbers(&w["volumes"])
            .into_iter()
            .map(|v| v as usize)
            .collect();
        assert_eq!(fit.volumes, volumes, "target {t}");
        let theirs = numbers(&w["weights"]);
        let mut ours = vec![fit.b0_weight];
        ours.extend(&fit.weights);
        worst_weight = worst_weight.max(volume_error(&ours, &theirs));
        let prediction = fit.predict(&d.b0, &refs, &d.mask);
        let theirs = numbers(pred);
        for (v, (&p, &q)) in prediction.iter().zip(&theirs).enumerate() {
            if !d.mask[v] {
                assert_eq!(
                    (p, q),
                    (0.0, 0.0),
                    "target {t} voxel {v} is outside the mask"
                );
            }
        }
        worst_prediction = worst_prediction.max(volume_error(&prediction, &theirs));
    }
    eprintln!(
        "weights: {worst_weight:.2e}; predictions: {worst_prediction:.2e} of each volume's maximum"
    );
    assert!(worst_weight <= 1e-10, "{worst_weight}");
    assert!(worst_prediction <= 1e-5, "{worst_prediction}");
}

#[test]
fn a_plain_small_ridge_misses_the_gate() {
    // rank(M) is 31 of 72 here, so the fit is not determined by the data: without QSIPrep's
    // n/l penalty (a near-pseudoinverse solve), the predictions are different.
    let f = fixture("predict.json");
    let d = data(&f);
    let refs: Vec<&[f32]> = d.dwis.iter().map(|v| v.as_slice()).collect();
    let mut worst = 0.0f64;
    for (t, pred) in f["predictions"].as_array().unwrap().iter().enumerate() {
        let fit = TargetFit::new(&d.bvals, &d.bvecs, t).unwrap();
        let mut bvals = vec![0.0];
        let mut bvecs = vec![[0.0; 3]];
        for &i in &fit.volumes {
            bvals.push(d.bvals[i]);
            bvecs.push(d.bvecs[i]);
        }
        let w = weights_with_penalty(&bvals, &bvecs, d.bvals[t], d.bvecs[t], |_, _| 1e-14).unwrap();
        let ridge = TargetFit {
            b0_weight: w[0],
            volumes: fit.volumes.clone(),
            weights: w[1..].to_vec(),
        };
        worst = worst.max(volume_error(
            &ridge.predict(&d.b0, &refs, &d.mask),
            &numbers(pred),
        ));
    }
    eprintln!("plain ridge: {worst:.2e} of each volume's maximum");
    assert!(worst > 1e-3, "{worst}");
}
