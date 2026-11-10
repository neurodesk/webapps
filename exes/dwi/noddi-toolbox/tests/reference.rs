// SPDX-License-Identifier: Apache-2.0
//! The WM gate against the pinned NODDI toolbox 1.05 reference (#424, #425): the median
//! absolute difference of ICVF, ISOVF and ODI over the 13327 gate voxels must be below 0.02.
//! validation/prepare_reference.py stages the voxels; without NODDI_TOOLBOX_PREPARED the test
//! skips, unless NODDI_TOOLBOX_REQUIRE_REFERENCE is set (CI).

use dwi_noddi_toolbox::{Protocol, fit_voxel};
use serde_json::Value;
use std::{fs, path::Path};

fn doubles(root: &Path, file: &str) -> Vec<f64> {
    let bytes = fs::read(root.join(file)).unwrap();
    assert_eq!(bytes.len() % 8, 0);
    bytes
        .chunks_exact(8)
        .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
        .collect()
}

fn numbers(value: &Value) -> Vec<f64> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}

#[test]
fn maps_meet_the_toolbox_wm_gate() {
    let Some(root) = std::env::var_os("NODDI_TOOLBOX_PREPARED") else {
        assert!(
            std::env::var_os("NODDI_TOOLBOX_REQUIRE_REFERENCE").is_none(),
            "NODDI_TOOLBOX_PREPARED is required in CI"
        );
        eprintln!("NODDI_TOOLBOX_PREPARED is not set; run validation/prepare_reference.py");
        return;
    };
    let root = Path::new(&root);
    let metadata: Value =
        serde_json::from_slice(&fs::read(root.join("prepared.json")).unwrap()).unwrap();
    let bvals = numbers(&metadata["bvals"]);
    let bvecs: Vec<[f64; 3]> = metadata["bvecs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| numbers(row).try_into().unwrap())
        .collect();
    // FSL2Protocol's default b0 threshold, as the reference ran.
    let protocol = Protocol::new(&bvals, &bvecs, 0.0).unwrap();
    let signals = doubles(root, "signals.f64");
    let expected = doubles(root, "expected.f64");
    let n = bvals.len();
    let voxels = signals.len() / n;
    assert_eq!(voxels, 13327);
    assert_eq!(expected.len(), voxels * 4);

    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    let per = voxels.div_ceil(threads);
    let maps: Vec<[f64; 4]> = std::thread::scope(|scope| {
        let handles: Vec<_> = signals
            .chunks(per * n)
            .map(|chunk| {
                let protocol = &protocol;
                scope.spawn(move || {
                    chunk
                        .chunks_exact(n)
                        .map(|signal| {
                            let fit = fit_voxel(protocol, signal);
                            assert_eq!(fit.error_code, 0);
                            assert!(fit.converged, "a stage stopped at the iteration limit");
                            [fit.ficvf(), fit.fiso(), fit.odi(), fit.log_likelihood]
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect()
    });
    for (axis, name) in ["ICVF", "ISOVF", "ODI"].into_iter().enumerate() {
        let mut errors: Vec<f64> = (0..voxels)
            .map(|v| (maps[v][axis] - expected[4 * v + axis]).abs())
            .collect();
        errors.sort_by(f64::total_cmp);
        let median = (errors[(voxels - 1) / 2] + errors[voxels / 2]) * 0.5;
        let p95 = errors[voxels * 95 / 100];
        eprintln!(
            "{name}: WM median |difference| {median:.2e}, 95th percentile {p95:.2e}, max {:.3}",
            errors[voxels - 1]
        );
        assert!(
            median < 0.02,
            "{name}: WM median {median} is not below 0.02"
        );
    }
    // Where a map differs by more than 0.01, the two optimizers ended at different points;
    // compare their Rician log-likelihoods (the toolbox's fmin is stored as float32).
    let (mut differ, mut higher) = (0, 0);
    for v in 0..voxels {
        if (0..3).any(|axis| (maps[v][axis] - expected[4 * v + axis]).abs() > 0.01) {
            differ += 1;
            let toolbox = expected[4 * v + 3];
            higher += usize::from(maps[v][3] >= toolbox - 1e-6 * toolbox.abs());
        }
    }
    eprintln!(
        "{differ} voxels differ by more than 0.01 in a map; the port's likelihood is at least the toolbox's in {higher} of them"
    );
}
