// SPDX-License-Identifier: BSD-3-Clause
//! Times one SHORELine prediction pass at the size of the ds005577 sub-107 reference:
//! 30 directions at b = 1000 and 60 at b = 3000, 250 000 brain voxels (synthetic values).
//! cargo run --release -p dwi-shore --example profile
use dwi_shore::TargetFit;
use std::f64::consts::PI;
use std::time::Instant;

fn main() {
    let mut bvals = Vec::new();
    let mut bvecs = Vec::new();
    for (b, n) in [(1000.0, 30), (3000.0, 60)] {
        for i in 0..n {
            let z = 1.0 - (i as f64 + 0.5) / n as f64;
            let r = (1.0 - z * z).sqrt();
            let phi = i as f64 * PI * (3.0 - 5f64.sqrt()) + b;
            bvals.push(b);
            bvecs.push([r * phi.cos(), r * phi.sin(), z]);
        }
    }
    let voxels = 250_000;
    let b0: Vec<f32> = (0..voxels).map(|v| 1000.0 + (v % 97) as f32).collect();
    let dwis: Vec<Vec<f32>> = (0..bvals.len())
        .map(|i| {
            (0..voxels)
                .map(|v| 300.0 + ((v * 7 + i * 13) % 101) as f32)
                .collect()
        })
        .collect();
    let refs: Vec<&[f32]> = dwis.iter().map(|v| v.as_slice()).collect();
    let mask = vec![true; voxels];

    let mut fit_time = 0.0;
    let mut predict_time = 0.0;
    for target in 0..bvals.len() {
        let t = Instant::now();
        let fit = TargetFit::new(&bvals, &bvecs, target).unwrap();
        fit_time += t.elapsed().as_secs_f64();
        let t = Instant::now();
        let prediction = fit.predict(&b0, &refs, &mask);
        predict_time += t.elapsed().as_secs_f64();
        assert!(prediction[0].is_finite());
    }
    let n = bvals.len() as f64;
    println!(
        "{} targets, {voxels} voxels: weights {:.2} ms and prediction {:.1} ms per volume (one thread)",
        bvals.len(),
        1e3 * fit_time / n,
        1e3 * predict_time / n
    );
}
