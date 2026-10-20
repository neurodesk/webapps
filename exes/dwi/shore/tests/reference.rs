// SPDX-License-Identifier: BSD-3-Clause
//! Compares the port with one SHORELine iteration of a QSIPrep 26.1.1 run, every volume.
//! SHORE_REFERENCE names a directory that tools/reference.py wrote; without it the test is
//! skipped. Run it in release mode:
//! SHORE_REFERENCE=DIR cargo test --release -p dwi-shore --test reference -- --nocapture

use dwi_shore::{TargetFit, mask_from_image};
use serde_json::Value;
use std::path::Path;
use std::time::Instant;

fn read_f32(dir: &Path, name: &Value) -> Vec<f32> {
    let bytes = std::fs::read(dir.join(name.as_str().unwrap())).unwrap();
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

#[test]
fn matches_qsiprep_iteration() {
    let Ok(dir) = std::env::var("SHORE_REFERENCE") else {
        eprintln!("SHORE_REFERENCE is not set; skipping");
        return;
    };
    let dir = Path::new(&dir);
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let bvals: Vec<f64> = manifest["bvals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_f64().unwrap())
        .collect();
    let bvecs: Vec<[f64; 3]> = manifest["bvecs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            let g: Vec<f64> = g
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c.as_f64().unwrap())
                .collect();
            [g[0], g[1], g[2]]
        })
        .collect();
    let mask = mask_from_image(&read_f32(dir, &manifest["mask"]));
    let b0 = read_f32(dir, &manifest["b0_mean"]);
    let dwis: Vec<Vec<f32>> = manifest["dwis"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| read_f32(dir, n))
        .collect();
    let refs: Vec<&[f32]> = dwis.iter().map(|v| v.as_slice()).collect();
    let mut worst = (0.0f64, 0);
    let mut seconds = 0.0;
    for (t, name) in manifest["predicted"].as_array().unwrap().iter().enumerate() {
        let theirs = read_f32(dir, name);
        let start = Instant::now();
        let ours = TargetFit::new(&bvals, &bvecs, t)
            .unwrap()
            .predict(&b0, &refs, &mask);
        seconds += start.elapsed().as_secs_f64();
        let scale = theirs.iter().fold(0.0f64, |m, &x| m.max((x as f64).abs()));
        let diff = ours
            .iter()
            .zip(&theirs)
            .fold(0.0f64, |m, (&a, &b)| m.max((a - b as f64).abs()));
        let error = diff / scale;
        eprintln!(
            "volume {t:3} (b = {:6.0}): {error:.2e} of its maximum",
            bvals[t]
        );
        if error > worst.0 {
            worst = (error, t);
        }
    }
    let n = bvals.len() as f64;
    eprintln!(
        "{} volumes, {} mask voxels: worst {:.2e} (volume {}), {:.1} ms per volume",
        bvals.len(),
        mask.iter().filter(|&&m| m).count(),
        worst.0,
        worst.1,
        1e3 * seconds / n
    );
    assert!(
        worst.0 <= 1e-5,
        "volume {} differs by {:.2e}",
        worst.1,
        worst.0
    );
}
