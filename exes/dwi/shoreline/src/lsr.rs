// SPDX-License-Identifier: Apache-2.0
//! Least-squares restoration of volume pairs acquired with opposite phase-encoding
//! polarities (eddy's `--resamp=lsr`; Andersson, Skare and Ashburner 2003, NeuroImage
//! 20:870-888), implemented from the paper; no FSL code was read.
//!
//! The two volumes of a pair have the same diffusion encoding and opposite distortions. After
//! their motion is undone, each line along the phase-encoding axis is a "push" of the same
//! undistorted line f: the signal of voxel j lands at j + d_j, shared between the two voxels
//! around it (which conserves intensity, so compression and stretching need no Jacobian).
//! The restored line minimises |K_a f - g_a|² + |K_b f - g_b|² + λ |D f|² (D the first
//! difference); where one volume is stretched, the other is compressed, and the pair
//! determines what each alone cannot.

use crate::Acquisition;
use crate::volume::Grid;

/// Pairs of volumes with the same b-value and direction and opposite polarities along the
/// same axis, nearest in acquisition order first. Each volume is in at most one pair.
pub fn pairs(
    bvals: &[f64],
    bvecs: &[[f64; 3]],
    acquisitions: &[Acquisition],
) -> Vec<(usize, usize)> {
    let n = bvals.len();
    let mut taken = vec![false; n];
    let mut out = Vec::new();
    for a in 0..n {
        if taken[a] {
            continue;
        }
        let matches = |b: usize| -> bool {
            let (pa, pb) = (&acquisitions[a], &acquisitions[b]);
            let same_encoding = if bvals[a] <= 50.0 && bvals[b] <= 50.0 {
                true
            } else {
                let g = (bvecs[a][0] * bvecs[b][0]
                    + bvecs[a][1] * bvecs[b][1]
                    + bvecs[a][2] * bvecs[b][2])
                    .abs();
                (bvals[a] - bvals[b]).abs() <= 50.0 && g > 0.999
            };
            !taken[b]
                && same_encoding
                && pa.pe_axis == pb.pe_axis
                && pa.pe_sign != pb.pe_sign
                && pa.readout_time > 0.0
                && pb.readout_time > 0.0
        };
        if let Some(b) = (a + 1..n).find(|&b| matches(b)) {
            taken[a] = true;
            taken[b] = true;
            out.push((a, b));
        }
    }
    out
}

/// Solves a symmetric positive-definite banded system (half-bandwidth `w`; `a[i][k]` holds
/// the entry (i, i - w + k)) in place by Cholesky.
fn banded_solve(a: &mut [Vec<f64>], w: usize, b: &mut [f64]) -> bool {
    let n = b.len();
    for i in 0..n {
        for k in 0..=w {
            let j = (i + k).checked_sub(w);
            let Some(j) = j else { continue };
            // Entry (i, j), j <= i.
            let mut s = a[i][k];
            let lo = i.saturating_sub(w).max(j.saturating_sub(w));
            for p in lo..j {
                s -= a[i][p + w - i] * a[j][p + w - j];
            }
            if i == j {
                if s <= 0.0 {
                    return false;
                }
                a[i][w] = s.sqrt();
            } else {
                a[i][k] = s / a[j][w];
            }
        }
    }
    for i in 0..n {
        let mut s = b[i];
        for p in i.saturating_sub(w)..i {
            s -= a[i][p + w - i] * b[p];
        }
        b[i] = s / a[i][w];
    }
    for i in (0..n).rev() {
        let mut s = b[i];
        for p in i + 1..n.min(i + w + 1) {
            s -= a[p][i + w - p] * b[p];
        }
        b[i] = s / a[i][w];
    }
    true
}

fn cubic(t: f64) -> f64 {
    let a = t.abs();
    if a < 1.0 {
        (4.0 - 6.0 * a * a + 3.0 * a * a * a) / 6.0
    } else if a < 2.0 {
        let b = 2.0 - a;
        b * b * b / 6.0
    } else {
        0.0
    }
}

/// The restored line from the two motion-corrected lines and their displacements (voxels,
/// at each true position). The true line is a cubic B-spline with one coefficient per voxel;
/// acquired sample i of a volume came from the position p with p + d(p) = i, and holds
/// f(p) / J(p) (J = 1 + d'). Both volumes' samples determine the coefficients by least
/// squares, with `lambda` on the coefficients' first differences.
fn restore_line(g: [&[f64]; 2], d: [&[f64]; 2], lambda: f64) -> Vec<f64> {
    let n = g[0].len();
    let w = 3;
    let mut a = vec![vec![0.0; w + 1]; n];
    let mut rhs = vec![0.0; n];
    let dl = |v: usize, p: f64| -> f64 {
        let p = p.clamp(0.0, (n - 1) as f64);
        let i0 = (p.floor() as usize).min(n.saturating_sub(2));
        let f = p - i0 as f64;
        (1.0 - f) * d[v][i0] + f * d[v][(i0 + 1).min(n - 1)]
    };
    for v in 0..2 {
        // The acquired position of each true voxel, and its inverse by monotone search.
        let x: Vec<f64> = (0..n).map(|j| j as f64 + d[v][j]).collect();
        let mut hint = 0usize;
        for (i, &acquired) in g[v].iter().enumerate() {
            let target = i as f64;
            // A true position p with p + d(p) = target, between voxels where x crosses it:
            // near the previous one (x almost always increases), else anywhere.
            let crosses =
                |k: usize| (x[k] - target) * (x[k + 1] - target) <= 0.0 && x[k] != x[k + 1];
            let Some(k) = (hint.saturating_sub(2)..n - 1)
                .take(8)
                .find(|&k| crosses(k))
                .or_else(|| (0..n - 1).find(|&k| crosses(k)))
            else {
                continue;
            };
            hint = k;
            let p = k as f64 + (target - x[k]) / (x[k + 1] - x[k]);
            let jac = 1.0 + (dl(v, p + 0.5) - dl(v, p - 0.5));
            if jac <= 0.05 {
                continue;
            }
            let y = acquired * jac;
            let base = p.floor() as isize;
            let mut row: Vec<(usize, f64)> = Vec::with_capacity(4);
            for c in base - 1..=base + 2 {
                let wgt = cubic(p - c as f64);
                if wgt == 0.0 {
                    continue;
                }
                let idx = c.clamp(0, n as isize - 1) as usize;
                match row.iter_mut().find(|r| r.0 == idx) {
                    Some(r) => r.1 += wgt,
                    None => row.push((idx, wgt)),
                }
            }
            for &(j, wj) in &row {
                rhs[j] += wj * y;
                for &(k, wk) in &row {
                    if k <= j && j - k <= w {
                        a[j][w - (j - k)] += wj * wk;
                    }
                }
            }
        }
    }
    for (j, row) in a.iter_mut().enumerate() {
        let neighbours = usize::from(j > 0) + usize::from(j + 1 < n);
        row[w] += lambda * neighbours as f64 + 1e-9;
        if j > 0 {
            row[w - 1] -= lambda;
        }
    }
    if !banded_solve(&mut a, w, &mut rhs) {
        return (0..n).map(|i| 0.5 * (g[0][i] + g[1][i])).collect();
    }
    // The spline at the voxels.
    (0..n)
        .map(|m| {
            let c = |k: isize| rhs[k.clamp(0, n as isize - 1) as usize];
            let m = m as isize;
            (c(m - 1) + 4.0 * c(m) + c(m + 1)) / 6.0
        })
        .collect()
}

/// The restored volume of a pair: `images` resampled for motion only into the reference
/// space, `displacements` (voxels along `axis`) at each reference voxel.
pub fn restore(
    grid: &Grid,
    axis: usize,
    images: [&[f32]; 2],
    displacements: [&[f32]; 2],
    lambda: f64,
) -> Vec<f32> {
    let n = grid.dims[axis];
    let s = grid.stride(axis);
    let mut out = vec![0.0f32; grid.voxels()];
    let starts: Vec<usize> = (0..grid.voxels())
        .filter(|&v| grid.ijk(v)[axis] == 0)
        .collect();
    let lines: Vec<(usize, Vec<f64>)> = {
        use rayon::prelude::*;
        starts
            .par_iter()
            .map(|&start| {
                let take =
                    |x: &[f32]| -> Vec<f64> { (0..n).map(|i| x[start + i * s] as f64).collect() };
                let (ga, gb) = (take(images[0]), take(images[1]));
                if ga.iter().chain(&gb).all(|&x| x == 0.0) {
                    return (start, vec![0.0; n]);
                }
                let (da, db) = (take(displacements[0]), take(displacements[1]));
                (start, restore_line([&ga, &gb], [&da, &db], lambda))
            })
            .collect()
    };
    for (start, line) in lines {
        for (i, v) in line.into_iter().enumerate() {
            out[start + i * s] = v as f32;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banded_solve_matches_a_dense_solution() {
        // A tridiagonal SPD system.
        let n = 6;
        let mut a: Vec<Vec<f64>> = (0..n)
            .map(|i| vec![if i > 0 { -1.0 } else { 0.0 }, 4.0])
            .collect();
        let x: Vec<f64> = (0..n).map(|i| i as f64 + 1.0).collect();
        let mut b: Vec<f64> = (0..n)
            .map(|i| {
                4.0 * x[i]
                    - if i > 0 { x[i - 1] } else { 0.0 }
                    - if i + 1 < n { x[i + 1] } else { 0.0 }
            })
            .collect();
        assert!(banded_solve(&mut a, 1, &mut b));
        for (u, v) in b.iter().zip(&x) {
            assert!((u - v).abs() < 1e-12);
        }
    }

    #[test]
    fn a_pair_restores_a_line_that_each_volume_distorts() {
        // A smooth line with a step, acquired with +d and -d: sample i holds f(p) / J(p)
        // with p + d(p) = i.
        let n = 48;
        let truth = |p: f64| {
            50.0 + 40.0 * (0.3 * p).sin() + if (18.0..24.0).contains(&p) { 30.0 } else { 0.0 }
        };
        let disp = |p: f64| 2.5 * (std::f64::consts::PI * p / n as f64).sin();
        let acquire = |sign: f64| -> Vec<f64> {
            (0..n)
                .map(|i| {
                    let (mut lo, mut hi) = (-10.0, n as f64 + 10.0);
                    for _ in 0..60 {
                        let mid = 0.5 * (lo + hi);
                        if mid + sign * disp(mid) < i as f64 {
                            lo = mid
                        } else {
                            hi = mid
                        }
                    }
                    let p = 0.5 * (lo + hi);
                    let jac = 1.0 + sign * (disp(p + 1e-4) - disp(p - 1e-4)) / 2e-4;
                    if (0.0..=(n - 1) as f64).contains(&p) {
                        truth(p) / jac
                    } else {
                        0.0
                    }
                })
                .collect()
        };
        let (ga, gb) = (acquire(1.0), acquire(-1.0));
        let da: Vec<f64> = (0..n).map(|j| disp(j as f64)).collect();
        let db: Vec<f64> = da.iter().map(|x| -x).collect();
        let f = restore_line([&ga, &gb], [&da, &db], 1e-3);
        // Away from the step (a spline rings a few voxels around it) and the ends.
        let err: f64 = (4..n - 4)
            .filter(|&i| !(12..30).contains(&i))
            .map(|i| (f[i] - truth(i as f64)).abs())
            .fold(0.0, f64::max);
        assert!(err < 1.0, "worst error {err}");
    }
}
