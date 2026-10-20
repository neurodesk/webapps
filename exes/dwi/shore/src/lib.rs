// SPDX-License-Identifier: BSD-3-Clause
//! 3dSHORE signal prediction for SHORELine head motion correction: a port of QSIPrep 26.1.1's
//! `SignalPrediction` with `model='3dshore'` (`qsiprep/interfaces/shoreline.py`), its
//! `BrainSuiteShoreModel(regularization='L2')` and `brainsuite_shore_basis`
//! (`qsiprep/utils/brainsuite_shore.py`).
//!
//! For each target volume, QSIPrep fits the 72 SHORE coefficients of every masked voxel to the
//! other volumes and evaluates them at the target's q-space point:
//! `coef = solve(MᵀM + λN·N + λL·L, Mᵀ) · data` and `prediction = coef · m_pred`.
//! The fit is linear in the data, so the prediction is `w · data` with
//! `w = M (MᵀM + λN·N + λL·L)⁻¹ m_pred`, one weight per training volume. This crate computes
//! `w` once per target and applies it to every voxel.

pub mod basis;
mod special;

use std::f64::consts::PI;

/// `BrainSuiteShoreModel` defaults that `SignalPrediction` uses.
pub const RADIAL_ORDER: usize = 6;
pub const ZETA: f64 = 700.0;
pub const LAMBDA_N: f64 = 1e-8;
pub const LAMBDA_L: f64 = 1e-8;

/// `SignalPrediction.minimal_q_distance`, in percent of the largest q.
pub const MINIMAL_Q_DISTANCE: f64 = 2.0;

/// `SignalPrediction` predicts in voxels where the mask image is above this value.
pub const MASK_THRESHOLD: f64 = 1e-6;

/// The effective diffusion time without pulse timing, 1/(4π²), so that q = √b.
pub fn tau() -> f64 {
    1.0 / (4.0 * (PI * PI))
}

/// `_nonoverlapping_qspace_samples`: which candidate samples may train the prediction of
/// the sample (`pred_b`, `pred_g`). q = √(b - min b), scaled to percent of the largest q; a
/// candidate is kept when its scaled q-vector and its antipode are both more than `cutoff`
/// from the target's. The target itself is never kept.
pub fn nonoverlapping_samples(
    pred_b: f64,
    pred_g: [f64; 3],
    bvals: &[f64],
    bvecs: &[[f64; 3]],
    cutoff: f64,
) -> Vec<bool> {
    let min_b = bvals.iter().copied().fold(pred_b, f64::min);
    let q: Vec<f64> = bvals.iter().map(|b| (b - min_b).sqrt()).collect();
    let pred_q = (pred_b - min_b).sqrt();
    let max_q = q.iter().copied().fold(pred_q, f64::max);
    let pred_scaled = pred_q / max_q * 100.0;
    let target = pred_g.map(|c| c * pred_scaled);
    q.iter()
        .zip(bvecs)
        .map(|(&qi, g)| {
            let scaled = qi / max_q * 100.0;
            let v = g.map(|c| c * scaled);
            let d = distance(v, target, 1.0);
            let d_flip = distance(v, target, -1.0);
            d > cutoff && d_flip > cutoff
        })
        .collect()
}

fn distance(a: [f64; 3], b: [f64; 3], sign: f64) -> f64 {
    let d = [a[0] + sign * b[0], a[1] + sign * b[1], a[2] + sign * b[2]];
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

/// The prediction weights for one target: `w = M A⁻¹ m_pred` with
/// `A = MᵀM + λN diag((n(n+1))²) + λL diag((l(l+1))²)`, M the basis of the training samples
/// and m_pred the basis row of the target. `prediction = Σ w_i · training_i`.
///
/// QSIPrep solves `A X = Mᵀ` with LAPACK `gesv` and then multiplies by m_pred. A is
/// symmetric positive definite and well conditioned at real schemes (the penalty is of the
/// same order as MᵀM because the basis values are small), so the Cholesky solve here agrees
/// with it to rounding.
pub fn prediction_weights(
    train_bvals: &[f64],
    train_bvecs: &[[f64; 3]],
    pred_b: f64,
    pred_g: [f64; 3],
) -> Result<Vec<f64>, String> {
    weights_with_penalty(train_bvals, train_bvecs, pred_b, pred_g, |n, l| {
        LAMBDA_N * (n * (n + 1.0)).powi(2) + LAMBDA_L * (l * (l + 1.0)).powi(2)
    })
}

/// `prediction_weights` with another diagonal penalty, a function of each column's (n, l).
/// Tests use it to show that the result depends on QSIPrep's penalty.
pub fn weights_with_penalty(
    train_bvals: &[f64],
    train_bvecs: &[[f64; 3]],
    pred_b: f64,
    pred_g: [f64; 3],
    penalty: impl Fn(f64, f64) -> f64,
) -> Result<Vec<f64>, String> {
    let m = basis::basis(RADIAL_ORDER, ZETA, tau(), train_bvals, train_bvecs)?;
    let m_pred = basis::basis_row(RADIAL_ORDER, ZETA, tau(), pred_b, pred_g)?;
    let index = basis::index_matrix(RADIAL_ORDER);
    let k = index.len();
    let mut a = vec![vec![0.0; k]; k];
    for row in &m {
        for i in 0..k {
            for j in 0..=i {
                a[i][j] += row[i] * row[j];
            }
        }
    }
    for (i, &(n, l, _)) in index.iter().enumerate() {
        a[i][i] += penalty(n as f64, l as f64);
    }
    let z = cholesky_solve(a, m_pred).ok_or(
        "The 3dSHORE normal matrix is not positive definite: no training sample has b = 0.",
    )?;
    Ok(m.iter()
        .map(|row| row.iter().zip(&z).map(|(r, z)| r * z).sum())
        .collect())
}

/// Solves A z = b for symmetric positive definite A, given its lower triangle.
fn cholesky_solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let k = b.len();
    for j in 0..k {
        let d = a[j][j] - a[j][..j].iter().map(|x| x * x).sum::<f64>();
        if d <= 0.0 || !d.is_finite() {
            return None;
        }
        let d = d.sqrt();
        a[j][j] = d;
        for i in j + 1..k {
            let s = a[i][j]
                - a[i][..j]
                    .iter()
                    .zip(&a[j][..j])
                    .map(|(x, y)| x * y)
                    .sum::<f64>();
            a[i][j] = s / d;
        }
    }
    for i in 0..k {
        let mut s = b[i];
        for p in 0..i {
            s -= a[i][p] * b[p];
        }
        b[i] = s / a[i][i];
    }
    for i in (0..k).rev() {
        let mut s = b[i];
        for p in i + 1..k {
            s -= a[p][i] * b[p];
        }
        b[i] = s / a[i][i];
    }
    Some(b)
}

/// One target's training set and weights, as `SignalPrediction` assembles it.
#[derive(Clone, Debug)]
pub struct TargetFit {
    /// The weight of the b0 mean, which is always training sample 0.
    pub b0_weight: f64,
    /// Indices into the model DWI volumes that train this target, ascending.
    pub volumes: Vec<usize>,
    /// The weight of each volume in `volumes`.
    pub weights: Vec<f64>,
}

impl TargetFit {
    /// The training set and weights for model volume `target`. `bvals` and `bvecs` describe
    /// the model DWI volumes: the series without its b0 volumes (QSIPrep's `b < 100` rule,
    /// applied by the caller), in series order, with the current (rotated) directions.
    /// The b0 mean is prepended as sample 0 with b = 0 and a zero direction.
    pub fn new(bvals: &[f64], bvecs: &[[f64; 3]], target: usize) -> Result<Self, String> {
        if bvals.len() != bvecs.len() {
            return Err("bvals and bvecs differ in length.".into());
        }
        let mut all_bvals = vec![0.0];
        all_bvals.extend_from_slice(bvals);
        let mut all_bvecs = vec![[0.0; 3]];
        all_bvecs.extend_from_slice(bvecs);
        let keep = nonoverlapping_samples(
            bvals[target],
            bvecs[target],
            &all_bvals,
            &all_bvecs,
            MINIMAL_Q_DISTANCE,
        );
        // SignalPrediction always loads the b0 mean first; if the rule dropped it, QSIPrep's
        // images and gradients would no longer line up.
        if !keep[0] {
            return Err(format!(
                "Volume {target} (b = {}) is within {MINIMAL_Q_DISTANCE}% of q = 0; SHORELine cannot predict it.",
                bvals[target]
            ));
        }
        let volumes: Vec<usize> = (0..bvals.len()).filter(|&i| keep[i + 1]).collect();
        let train_bvals: Vec<f64> = (0..all_bvals.len())
            .filter(|&i| keep[i])
            .map(|i| all_bvals[i])
            .collect();
        let train_bvecs: Vec<[f64; 3]> = (0..all_bvecs.len())
            .filter(|&i| keep[i])
            .map(|i| all_bvecs[i])
            .collect();
        let w = prediction_weights(&train_bvals, &train_bvecs, bvals[target], bvecs[target])?;
        Ok(Self {
            b0_weight: w[0],
            volumes,
            weights: w[1..].to_vec(),
        })
    }

    /// The predicted volume: `w · data` in each voxel where `mask` is set, 0 elsewhere.
    /// `dwis[i]` is model volume i; every volume and `b0_mean` has one value per voxel.
    pub fn predict(&self, b0_mean: &[f32], dwis: &[&[f32]], mask: &[bool]) -> Vec<f64> {
        // Volume by volume, for memory locality; each voxel still sums b0 first, then the
        // volumes in ascending order.
        let mut out: Vec<f64> = b0_mean
            .iter()
            .zip(mask)
            .map(|(&b0, &m)| if m { self.b0_weight * b0 as f64 } else { 0.0 })
            .collect();
        for (&i, &w) in self.volumes.iter().zip(&self.weights) {
            for ((value, &x), &m) in out.iter_mut().zip(dwis[i]).zip(mask) {
                if m {
                    *value += w * x as f64;
                }
            }
        }
        out
    }
}

/// The voxels that `SignalPrediction` predicts: mask image values above `MASK_THRESHOLD`.
pub fn mask_from_image(mask: &[f32]) -> Vec<bool> {
    mask.iter().map(|&m| m as f64 > MASK_THRESHOLD).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scheme() -> (Vec<f64>, Vec<[f64; 3]>) {
        // 3 shells of a golden-spiral set: enough directions for a determined fit.
        let mut bvals = Vec::new();
        let mut bvecs = Vec::new();
        for (b, n) in [(500.0, 12), (1000.0, 30), (2000.0, 40)] {
            for i in 0..n {
                let z = 1.0 - (i as f64 + 0.5) / n as f64;
                let r = (1.0 - z * z).sqrt();
                let phi = i as f64 * PI * (3.0 - 5f64.sqrt()) + b / 1000.0;
                bvals.push(b);
                bvecs.push([r * phi.cos(), r * phi.sin(), z]);
            }
        }
        (bvals, bvecs)
    }

    #[test]
    fn the_target_and_its_antipode_are_left_out() {
        let (mut bvals, mut bvecs) = scheme();
        bvals.push(1000.0);
        bvecs.push(bvecs[20].map(|c| -c));
        let mut all_bvals = vec![0.0];
        all_bvals.extend(&bvals);
        let mut all_bvecs = vec![[0.0; 3]];
        all_bvecs.extend(&bvecs);
        let keep = nonoverlapping_samples(bvals[20], bvecs[20], &all_bvals, &all_bvecs, 2.0);
        assert!(keep[0]);
        assert!(!keep[21]);
        assert!(!keep[all_bvals.len() - 1]);
        assert!(keep.iter().filter(|&&k| k).count() >= all_bvals.len() - 4);
    }

    #[test]
    fn predicts_a_signal_inside_the_model_space() {
        // A signal that is a combination of basis functions is reproduced up to the penalty.
        let (bvals, bvecs) = scheme();
        let target = 25;
        let fit = TargetFit::new(&bvals, &bvecs, target).unwrap();
        let signal = |b: f64, g: [f64; 3]| -> f64 {
            let d = 0.7e-3 + 1.0e-3 * g[0] * g[0];
            (-b * d).exp()
        };
        let b0 = [1.0f32];
        let dwis: Vec<Vec<f32>> = bvals
            .iter()
            .zip(&bvecs)
            .map(|(&b, &g)| vec![signal(b, g) as f32])
            .collect();
        let refs: Vec<&[f32]> = dwis.iter().map(|v| v.as_slice()).collect();
        let pred = fit.predict(&b0, &refs, &[true])[0];
        let truth = signal(bvals[target], bvecs[target]);
        assert!((pred - truth).abs() < 0.02, "{pred} vs {truth}");
        assert!(!fit.volumes.contains(&target));
    }

    #[test]
    fn masked_out_voxels_are_zero() {
        let (bvals, bvecs) = scheme();
        let fit = TargetFit::new(&bvals, &bvecs, 3).unwrap();
        let dwis: Vec<Vec<f32>> = bvals.iter().map(|_| vec![0.5, 0.5]).collect();
        let refs: Vec<&[f32]> = dwis.iter().map(|v| v.as_slice()).collect();
        let pred = fit.predict(&[1.0, 1.0], &refs, &mask_from_image(&[1.0, 0.0]));
        assert!(pred[0] != 0.0);
        assert_eq!(pred[1], 0.0);
    }
}
