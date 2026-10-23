// SPDX-License-Identifier: Apache-2.0
//! Synthetic ground truth: a crossing-fibre phantom with noise and slice dropouts put in at
//! known volumes and slices.

use dwi_shore::TargetFit;
use dwi_slice_outliers::{Params, SliceGrid, SliceStatistic, detect, replace, slice_statistics};
use std::f64::consts::PI;

const DIMS: [usize; 3] = [24, 24, 20];

/// A deterministic Gaussian generator (SplitMix64 and Box-Muller).
struct Rng(u64);

impl Rng {
    fn uniform(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }

    fn gaussian(&mut self) -> f64 {
        let u = self.uniform().max(1e-300);
        (-2.0 * u.ln()).sqrt() * (2.0 * PI * self.uniform()).cos()
    }
}

struct Phantom {
    grid: SliceGrid,
    bvals: Vec<f64>,
    bvecs: Vec<[f64; 3]>,
    mask: Vec<bool>,
    b0: Vec<f32>,
    truth: Vec<Vec<f64>>,
    observed: Vec<Vec<f32>>,
}

fn directions(n: usize, offset: f64) -> Vec<[f64; 3]> {
    (0..n)
        .map(|i| {
            let z = 1.0 - (i as f64 + 0.5) / n as f64;
            let r = (1.0 - z * z).sqrt();
            let phi = i as f64 * PI * (3.0 - 5f64.sqrt()) + offset;
            [r * phi.cos(), r * phi.sin(), z]
        })
        .collect()
}

/// Two shells (b = 1000 ×30, 2000 ×40), an ellipsoid brain whose top and bottom slices hold
/// fewer than 250 voxels, two fibre populations whose angle varies smoothly, noise σ = 20.
fn phantom() -> Phantom {
    let grid = SliceGrid::new(DIMS, 2).unwrap();
    let mut bvals = vec![1000.0; 30];
    bvals.extend(vec![2000.0; 40]);
    let mut bvecs = directions(30, 0.0);
    bvecs.extend(directions(40, 1.0));
    let [nx, ny, nz] = DIMS;
    let mut mask = Vec::new();
    let mut s0 = Vec::new();
    let mut fibres = Vec::new();
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                let p = [
                    (i as f64 + 0.5) / nx as f64 * 2.0 - 1.0,
                    (j as f64 + 0.5) / ny as f64 * 2.0 - 1.0,
                    (k as f64 + 0.5) / nz as f64 * 2.0 - 1.0,
                ];
                mask.push(p[0] * p[0] / 0.95 + p[1] * p[1] / 0.95 + p[2] * p[2] / 1.1 < 1.0);
                s0.push(900.0 + 200.0 * (p[0] * 2.0).cos() * (p[1] * 1.5).sin());
                let a = 0.6 * p[0] + 0.4 * p[2];
                let b = 1.2 + 0.5 * p[1];
                fibres.push([[a.cos(), a.sin(), 0.1], [b.cos() * 0.3, b.sin(), 0.9]]);
            }
        }
    }
    let unit = |v: [f64; 3]| {
        let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        v.map(|c| c / n)
    };
    let signal = |vox: usize, b: f64, g: [f64; 3]| -> f64 {
        let mut s = 0.0;
        for f in fibres[vox] {
            let c = unit(f).iter().zip(&g).map(|(x, y)| x * y).sum::<f64>();
            s += 0.4 * (-b * (0.3e-3 + 1.5e-3 * c * c)).exp();
        }
        s0[vox] * (s + 0.2 * (-b * 2.5e-3).exp())
    };
    let mut rng = Rng(480);
    let n = grid.voxels();
    let b0: Vec<f32> = (0..n)
        .map(|v| (s0[v] + 20.0 / 3.0 * rng.gaussian()) as f32)
        .collect();
    let truth: Vec<Vec<f64>> = bvals
        .iter()
        .zip(&bvecs)
        .map(|(&b, &g)| (0..n).map(|v| signal(v, b, g)).collect())
        .collect();
    let observed = truth
        .iter()
        .map(|t| {
            t.iter()
                .map(|&x| (x + 20.0 * rng.gaussian()) as f32)
                .collect()
        })
        .collect();
    Phantom {
        grid,
        bvals,
        bvecs,
        mask,
        b0,
        truth,
        observed,
    }
}

/// Multiplies slice `slice` of volume `volume` by `factor`.
fn drop_slice(p: &mut Phantom, volume: usize, slice: usize, factor: f32) {
    for v in 0..p.grid.voxels() {
        if p.grid.slice_of(v) == slice {
            p.observed[volume][v] *= factor;
        }
    }
}

fn shells(p: &Phantom) -> Vec<f64> {
    p.bvals.clone()
}

fn flagged(map: &dwi_slice_outliers::OutlierMap) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for (v, row) in map.outlier.iter().enumerate() {
        for (s, &o) in row.iter().enumerate() {
            if o {
                out.push((v, s));
            }
        }
    }
    out
}

fn shore_predictions(p: &Phantom, observed: &[Vec<f32>]) -> Vec<Vec<f64>> {
    let refs: Vec<&[f32]> = observed.iter().map(|v| v.as_slice()).collect();
    (0..p.bvals.len())
        .map(|t| {
            TargetFit::new(&p.bvals, &p.bvecs, t)
                .unwrap()
                .predict(&p.b0, &refs, &p.mask)
        })
        .collect()
}

/// Volumes 5 and 48 lose the same slice: 3dSHORE predicts voxel by voxel, so a dropout biases
/// the other volumes' predictions only in its own slice.
const DROPOUTS: [(usize, usize, f32); 5] = [
    (5, 10, 0.3),
    (22, 6, 0.6),
    (41, 12, 0.5),
    (48, 10, 0.4),
    (63, 9, 0.7),
];

#[test]
fn finds_the_dropouts_with_the_true_signal_as_prediction() {
    let mut p = phantom();
    let clean = detect(
        &(0..p.bvals.len())
            .map(|v| slice_statistics(&p.grid, &p.observed[v], &p.truth[v], &p.mask))
            .collect::<Vec<_>>(),
        &shells(&p),
        &Params::default(),
    )
    .unwrap();
    assert_eq!(clean.count(), 0, "{:?}", clean.report());

    for (v, s, f) in DROPOUTS {
        drop_slice(&mut p, v, s, f);
    }
    // A bright slice is not an outlier unless positive outliers are asked for.
    drop_slice(&mut p, 30, 8, 1.6);
    // The top slice has fewer than 250 brain voxels: never flagged.
    drop_slice(&mut p, 12, DIMS[2] - 1, 0.2);
    let stats: Vec<_> = (0..p.bvals.len())
        .map(|v| slice_statistics(&p.grid, &p.observed[v], &p.truth[v], &p.mask))
        .collect();
    assert!(stats[12][DIMS[2] - 1].voxels < 250);
    let map = detect(&stats, &shells(&p), &Params::default()).unwrap();
    let expected: Vec<(usize, usize)> = DROPOUTS.iter().map(|&(v, s, _)| (v, s)).collect();
    assert_eq!(flagged(&map), expected);
    assert!(map.n_stdev[12][DIMS[2] - 1].is_nan());
    for line in map.report() {
        eprintln!("{line}");
    }

    let positive = detect(
        &stats,
        &shells(&p),
        &Params {
            positive: true,
            ..Params::default()
        },
    )
    .unwrap();
    assert!(flagged(&positive).contains(&(30, 8)));
}

#[test]
fn finds_the_dropouts_with_3dshore_predictions_and_replacement_helps() {
    let mut p = phantom();
    for (v, s, f) in DROPOUTS {
        drop_slice(&mut p, v, s, f);
    }
    // Iteration 1: predict from the corrupted data, detect, replace.
    let predicted = shore_predictions(&p, &p.observed);
    let stats: Vec<_> = (0..p.bvals.len())
        .map(|v| slice_statistics(&p.grid, &p.observed[v], &predicted[v], &p.mask))
        .collect();
    let map = detect(&stats, &shells(&p), &Params::default()).unwrap();
    for line in map.report() {
        eprintln!("{line}");
    }
    let expected: Vec<(usize, usize)> = DROPOUTS.iter().map(|&(v, s, _)| (v, s)).collect();
    assert_eq!(flagged(&map), expected);

    let mut corrected = p.observed.clone();
    for (v, row) in map.outlier.iter().enumerate() {
        replace(&p.grid, &mut corrected[v], &predicted[v], &p.mask, row);
    }
    // Iteration 2: predictions from the replaced data are closer to the truth in the slices
    // that held a dropout, and detection from them still finds the same slices.
    let again = shore_predictions(&p, &corrected);
    // Errors against the truth over the brain voxels of slice s of volume v.
    let errors = |images: &[Vec<f64>], v: usize, s: usize| -> Vec<f64> {
        images[v]
            .iter()
            .zip(&p.truth[v])
            .enumerate()
            .filter(|&(x, _)| p.mask[x] && p.grid.slice_of(x) == s)
            .map(|(_, (a, t))| a - t)
            .collect()
    };
    let slice_rms = |images: &[Vec<f64>], v: usize, s: usize| -> f64 {
        let e = errors(images, v, s);
        (e.iter().map(|x| x * x).sum::<f64>() / e.len() as f64).sqrt()
    };
    let slice_bias = |images: &[Vec<f64>], v: usize, s: usize| -> f64 {
        let e = errors(images, v, s);
        e.iter().sum::<f64>() / e.len() as f64
    };
    // The dropout of the other volume in slice 10 no longer pulls these predictions down;
    // the other slices' predictions do not change.
    for &(v, s, _) in &DROPOUTS {
        let (before, after) = (slice_bias(&predicted, v, s), slice_bias(&again, v, s));
        let (rms_before, rms_after) = (slice_rms(&predicted, v, s), slice_rms(&again, v, s));
        eprintln!(
            "volume {v} slice {s}: prediction bias {before:.2} -> {after:.2}, RMS error {rms_before:.2} -> {rms_after:.2}"
        );
        if s == 10 {
            assert!(after.abs() < 0.5 * before.abs(), "{before} -> {after}");
            assert!(rms_after < rms_before);
        } else {
            assert!((rms_after - rms_before).abs() < 1e-9);
        }
    }
    // Iteration 2, as eddy iterates: detect again on the original data with the new
    // predictions, and replace from them.
    let stats: Vec<_> = (0..p.bvals.len())
        .map(|v| slice_statistics(&p.grid, &p.observed[v], &again[v], &p.mask))
        .collect();
    let map = detect(&stats, &shells(&p), &Params::default()).unwrap();
    assert_eq!(flagged(&map), expected);
    let mut final_data = p.observed.clone();
    for (v, row) in map.outlier.iter().enumerate() {
        replace(&p.grid, &mut final_data[v], &again[v], &p.mask, row);
    }
    let as_f64 = |images: &[Vec<f32>]| -> Vec<Vec<f64>> {
        images
            .iter()
            .map(|c| c.iter().map(|&x| x as f64).collect())
            .collect()
    };
    let (observed, first, second) = (as_f64(&p.observed), as_f64(&corrected), as_f64(&final_data));
    for &(v, s, _) in &DROPOUTS {
        let (raw, one, two) = (
            slice_rms(&observed, v, s),
            slice_rms(&first, v, s),
            slice_rms(&second, v, s),
        );
        eprintln!(
            "volume {v} slice {s}: data RMS error {raw:.1}, after iteration 1 {one:.1}, after iteration 2 {two:.1}"
        );
        assert!(two < 0.25 * raw);
        assert!(two <= one + 1e-9);
    }
}

#[test]
fn many_dropouts_do_not_hide_each_other() {
    // A session with much motion: 60 dropouts (signal x 0.5 to 0.8) over the brain slices.
    // With a mean and standard deviation, these would inflate the spread and hide each
    // other; the robust standardisation finds all of them.
    let mut p = phantom();
    let mut rng = Rng(4800);
    let mut expected = Vec::new();
    while expected.len() < 60 {
        let v = (rng.uniform() * p.bvals.len() as f64) as usize;
        let s = 3 + (rng.uniform() * (DIMS[2] - 6) as f64) as usize;
        if !expected.contains(&(v, s)) {
            expected.push((v, s));
            drop_slice(&mut p, v, s, (0.5 + 0.3 * rng.uniform()) as f32);
        }
    }
    expected.sort();
    let stats: Vec<_> = (0..p.bvals.len())
        .map(|v| slice_statistics(&p.grid, &p.observed[v], &p.truth[v], &p.mask))
        .collect();
    let map = detect(&stats, &shells(&p), &Params::default()).unwrap();
    assert_eq!(flagged(&map), expected);
}

#[test]
fn a_small_shell_keeps_a_centre_per_slice_position() {
    // ADNI's b = 500 shell has 6 volumes. Near the skull base, the prediction error of one
    // slice position is the same in all of them; that is not an outlier. A real dropout in
    // the same shell is.
    let mut rng = Rng(500);
    let slices = 20;
    let mut stats = Vec::new();
    let mut shells = Vec::new();
    for (shell, n) in [(1000.0, 40), (500.0, 6)] {
        for v in 0..n {
            let row: Vec<SliceStatistic> = (0..slices)
                .map(|s| {
                    let mut mean = rng.gaussian();
                    if shell == 500.0 && s == 2 {
                        mean -= 15.0;
                    }
                    if shell == 500.0 && v == 3 && s == 10 {
                        mean -= 20.0;
                    }
                    SliceStatistic {
                        mean,
                        mean_square: mean * mean,
                        voxels: 1000,
                    }
                })
                .collect();
            stats.push(row);
            shells.push(shell);
        }
    }
    let map = detect(&stats, &shells, &Params::default()).unwrap();
    assert_eq!(flagged(&map), vec![(43, 10)]);
}
