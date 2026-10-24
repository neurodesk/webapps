// SPDX-License-Identifier: MIT
use dwi_dmipy::Model;
use serde_json::Value;
use std::{fs, path::Path};

fn values(value: &Value) -> Vec<f64> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}
fn doubles(root: &Path, file: &str) -> Vec<f64> {
    let bytes = fs::read(root.join(file)).unwrap();
    assert_eq!(bytes.len() % 8, 0);
    bytes
        .chunks_exact(8)
        .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
        .collect()
}

#[test]
fn nonlinear_maps_meet_the_pinned_dmipy_wm_gate() {
    let Some(root) = std::env::var_os("NODDI_DMIPY_PREPARED") else {
        assert!(
            std::env::var_os("DMIPY_REQUIRE_REFERENCE").is_none(),
            "NODDI_DMIPY_PREPARED is required in CI"
        );
        eprintln!("NODDI_DMIPY_PREPARED is not set; run validation/prepare_reference.py first");
        return;
    };
    let root = Path::new(&root);
    let metadata: Value =
        serde_json::from_slice(&fs::read(root.join("prepared.json")).unwrap()).unwrap();
    let gradients = metadata["gradients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| values(v).try_into().unwrap())
        .collect::<Vec<_>>();
    let bvals = values(&metadata["bvals"]);
    let model = Model::new(&bvals, &gradients).unwrap();
    let signals = doubles(root, "signals.f64");
    let expected = doubles(root, "expected.f64");
    let indices = metadata["wmIndices"].as_array().unwrap();
    assert_eq!(indices.len(), 13324);
    assert_eq!(signals.len(), 45951 * bvals.len());
    assert_eq!(expected.len(), 45951 * 6);
    let mut errors = [vec![], vec![], vec![]];
    let mut nonconverged = 0;
    for value in indices {
        let i = value.as_u64().unwrap() as usize;
        let fit = model
            .fit(&signals[i * bvals.len()..(i + 1) * bvals.len()])
            .unwrap();
        nonconverged += usize::from(!fit.converged);
        for (axis, row) in errors.iter_mut().enumerate() {
            row.push((fit.parameters[axis + 2] - expected[6 * i + axis + 2]).abs());
        }
    }
    for (name, mut row) in ["ODI", "ICVF", "ISOVF"].into_iter().zip(errors) {
        row.sort_by(f64::total_cmp);
        let median = (row[(row.len() - 1) / 2] + row[row.len() / 2]) * 0.5;
        eprintln!("{name}: WM median={median}, max={}", row.last().unwrap());
        assert!(median < 0.02, "{name} WM median exceeds the accepted gate");
    }
    eprintln!("13324 WM voxels fitted; {nonconverged} optimizer stops without convergence");
}
