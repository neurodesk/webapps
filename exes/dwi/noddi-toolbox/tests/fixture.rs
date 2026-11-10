// SPDX-License-Identifier: Apache-2.0
//! Twelve gate voxels of the toolbox reference (tests/fixtures/voxels.json, tools/fixture.py)
//! fitted without downloads. packages/noddi/test/toolbox.test.js holds the WebAssembly module
//! to the same values.

use dwi_noddi_toolbox::{Protocol, fit_voxel};
use serde_json::Value;

fn numbers(value: &Value) -> Vec<f64> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}

#[test]
fn fixture_voxels_match_the_toolbox() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/voxels.json")).unwrap();
    let bvals = numbers(&fixture["bvals"]);
    let bvecs: Vec<[f64; 3]> = fixture["bvecs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| numbers(row).try_into().unwrap())
        .collect();
    let protocol = Protocol::new(&bvals, &bvecs, 0.0).unwrap();
    for voxel in fixture["voxels"].as_array().unwrap() {
        let fit = fit_voxel(&protocol, &numbers(&voxel["signal"]));
        assert_eq!(fit.error_code, 0);
        let got = [fit.ficvf(), fit.fiso(), fit.odi()];
        let want = ["icvf", "isovf", "odi"].map(|key| voxel[key].as_f64().unwrap());
        eprintln!("{}: {got:?} toolbox {want:?}", voxel["ijk"]);
        for (g, w) in got.iter().zip(want) {
            assert!(
                (g - w).abs() < 1e-3,
                "{}: {got:?} vs {want:?}",
                voxel["ijk"]
            );
        }
    }
}
