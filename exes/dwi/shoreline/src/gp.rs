// SPDX-License-Identifier: Apache-2.0
//! Gaussian-process prediction of diffusion-weighted volumes (Andersson and Sotiropoulos
//! 2015, NeuroImage 122:166-176), implemented from the paper; no FSL code was read. It works
//! for any number of directions and shells, where 3dSHORE needs at least as many volumes as
//! its 72 coefficients.
//!
//! Each voxel's signal, minus its mean over the shell, is a Gaussian process over the
//! gradients: covariance `c(θ) · exp(-ln(b_i / b_j)² / (2 ℓ²))`, with θ the angle between the
//! directions (antipodally symmetric) and c the spherical covariance of range `a`, plus noise
//! `σ²` relative to the signal variance. The prediction of a volume from the others is
//! linear in their signals with weights that do not depend on the voxel, so it has the form
//! of `dwi_shore::TargetFit` (with a zero b0 weight). The hyperparameters are chosen by
//! leave-one-out cross-validation on sample voxels (eddy's default `--hpcf=CV`).

use dwi_shore::TargetFit;

/// Hyperparameters: angular range (radians), b-value length scale (in ln b), noise variance
/// relative to the signal variance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hyper {
    pub range: f64,
    pub b_scale: f64,
    pub noise: f64,
}

impl Default for Hyper {
    fn default() -> Self {
        Self {
            range: 1.0,
            b_scale: 1.0,
            noise: 0.1,
        }
    }
}

fn spherical(theta: f64, range: f64) -> f64 {
    if theta >= range {
        0.0
    } else {
        let r = theta / range;
        1.0 - 1.5 * r + 0.5 * r * r * r
    }
}

/// Covariance between two gradients (without noise).
fn covariance(h: &Hyper, (bi, gi): (f64, [f64; 3]), (bj, gj): (f64, [f64; 3])) -> f64 {
    let dot = (gi[0] * gj[0] + gi[1] * gj[1] + gi[2] * gj[2])
        .abs()
        .min(1.0);
    let lb = (bi / bj).ln();
    spherical(dot.acos(), h.range) * (-lb * lb / (2.0 * h.b_scale * h.b_scale)).exp()
}

/// Cholesky factor (lower) of a symmetric positive-definite matrix, row major.
fn cholesky(a: &[f64], n: usize) -> Option<Vec<f64>> {
    let mut l = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..=i {
            let mut s = a[i * n + j];
            for k in 0..j {
                s -= l[i * n + k] * l[j * n + k];
            }
            if i == j {
                if s <= 0.0 {
                    return None;
                }
                l[i * n + i] = s.sqrt();
            } else {
                l[i * n + j] = s / l[j * n + j];
            }
        }
    }
    Some(l)
}

fn cholesky_solve(l: &[f64], n: usize, b: &[f64]) -> Vec<f64> {
    let mut y = b.to_vec();
    for i in 0..n {
        for k in 0..i {
            y[i] -= l[i * n + k] * y[k];
        }
        y[i] /= l[i * n + i];
    }
    for i in (0..n).rev() {
        for k in i + 1..n {
            y[i] -= l[k * n + i] * y[k];
        }
        y[i] /= l[i * n + i];
    }
    y
}

/// The covariance matrix of `gradients` plus noise on the diagonal.
fn matrix(h: &Hyper, gradients: &[(f64, [f64; 3])]) -> Vec<f64> {
    let n = gradients.len();
    let mut k = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..=i {
            let c = covariance(h, gradients[i], gradients[j]);
            k[i * n + j] = c;
            k[j * n + i] = c;
        }
        k[i * n + i] += h.noise;
    }
    k
}

/// Shells: index of each gradient's shell (b-values within 100 of each other).
fn shells(gradients: &[(f64, [f64; 3])]) -> Vec<usize> {
    let mut centres: Vec<f64> = Vec::new();
    gradients
        .iter()
        .map(
            |&(b, _)| match centres.iter().position(|c| (c - b).abs() <= 100.0) {
                Some(i) => i,
                None => {
                    centres.push(b);
                    centres.len() - 1
                }
            },
        )
        .collect()
}

/// Prediction weights from every volume, the target included (the posterior mean at a
/// noisy sample): the target's own weight is 1 - σ² [(K + σ²I)⁻¹]_tt, which a larger noise
/// (eddy's `--ff`) lowers.
pub fn fits_including_target(
    h: &Hyper,
    gradients: &[(f64, [f64; 3])],
) -> Result<Vec<TargetFit>, String> {
    let n = gradients.len();
    let shell = shells(gradients);
    let l = cholesky(&matrix(h, gradients), n)
        .ok_or("The Gaussian-process covariance is not positive definite.")?;
    (0..n)
        .map(|t| {
            let k: Vec<f64> = gradients
                .iter()
                .map(|&gj| covariance(h, gradients[t], gj))
                .collect();
            let z = cholesky_solve(&l, n, &k);
            let mut sum = vec![0.0; n];
            let mut count = vec![0usize; n];
            for j in 0..n {
                sum[shell[j]] += z[j];
                count[shell[j]] += 1;
            }
            let own = count[shell[t]];
            let weights = (0..n)
                .map(|j| {
                    let s = shell[j];
                    let mut w = z[j] - sum[s] / count[s] as f64;
                    if s == shell[t] {
                        w += 1.0 / own as f64;
                    }
                    w
                })
                .collect();
            Ok(TargetFit {
                b0_weight: 0.0,
                volumes: (0..n).collect(),
                weights,
            })
        })
        .collect()
}

/// Leave-one-out prediction weights for every volume with hyperparameters `h`.
pub fn fits(h: &Hyper, gradients: &[(f64, [f64; 3])]) -> Result<Vec<TargetFit>, String> {
    let n = gradients.len();
    let shell = shells(gradients);
    (0..n)
        .map(|t| {
            let others: Vec<usize> = (0..n).filter(|&j| j != t).collect();
            let g: Vec<(f64, [f64; 3])> = others.iter().map(|&j| gradients[j]).collect();
            let m = others.len();
            let l = cholesky(&matrix(h, &g), m)
                .ok_or("The Gaussian-process covariance is not positive definite.")?;
            let k: Vec<f64> = g
                .iter()
                .map(|&gj| covariance(h, gradients[t], gj))
                .collect();
            let z = cholesky_solve(&l, m, &k);
            // Shell means of the other volumes: z minus its shell mean (Pᵀz), plus the mean
            // of the target's shell.
            let mut sum = vec![0.0; n];
            let mut count = vec![0usize; n];
            for (i, &j) in others.iter().enumerate() {
                sum[shell[j]] += z[i];
                count[shell[j]] += 1;
            }
            let own = count[shell[t]];
            let weights = others
                .iter()
                .enumerate()
                .map(|(i, &j)| {
                    let s = shell[j];
                    let mut w = z[i] - sum[s] / count[s] as f64;
                    if s == shell[t] && own > 0 {
                        w += 1.0 / own as f64;
                    }
                    w
                })
                .collect();
            Ok(TargetFit {
                b0_weight: 0.0,
                volumes: others,
                weights,
            })
        })
        .collect()
}

/// Mean squared leave-one-out error over the sample voxels (`samples[v]` holds one value per
/// gradient), from one factorisation: the residual of volume t is (C r)_t / C_tt with C the
/// inverse covariance and r the signal minus its shell means.
fn cv_error(
    h: &Hyper,
    gradients: &[(f64, [f64; 3])],
    shell: &[usize],
    samples: &[Vec<f32>],
) -> f64 {
    let n = gradients.len();
    let Some(l) = cholesky(&matrix(h, gradients), n) else {
        return f64::INFINITY;
    };
    let diag: Vec<f64> = (0..n)
        .map(|t| {
            let mut e = vec![0.0; n];
            e[t] = 1.0;
            cholesky_solve(&l, n, &e)[t]
        })
        .collect();
    let shells = shell.iter().max().map_or(0, |m| m + 1);
    let mut total = 0.0;
    let mut count = 0usize;
    for y in samples {
        let mut mean = vec![0.0; shells];
        let mut size = vec![0usize; shells];
        for (t, &v) in y.iter().enumerate() {
            mean[shell[t]] += v as f64;
            size[shell[t]] += 1;
        }
        let r: Vec<f64> = y
            .iter()
            .enumerate()
            .map(|(t, &v)| v as f64 - mean[shell[t]] / size[shell[t]] as f64)
            .collect();
        let a = cholesky_solve(&l, n, &r);
        for t in 0..n {
            let e = a[t] / diag[t];
            total += e * e;
            count += 1;
        }
    }
    total / count.max(1) as f64
}

/// Hyperparameters that minimise the leave-one-out error, by a coarse grid and then a
/// coordinate search in log space. `samples[v]` holds the signals of one voxel.
pub fn fit_hyper(gradients: &[(f64, [f64; 3])], samples: &[Vec<f32>]) -> Hyper {
    let shell = shells(gradients);
    let multi = shell.iter().any(|&s| s != shell[0]);
    // The signal variance sets the scale of the noise term: express the noise relative to
    // the mean squared residual of the samples.
    let mut best = (f64::INFINITY, Hyper::default());
    let ranges = [0.4, 0.7, 1.0, 1.4, 2.0];
    let scales: &[f64] = if multi { &[0.3, 0.7, 1.5] } else { &[1.0] };
    let noises = [0.003, 0.01, 0.05, 0.2, 1.0];
    for &range in &ranges {
        for &b_scale in scales {
            for &noise in &noises {
                let h = Hyper {
                    range,
                    b_scale,
                    noise,
                };
                let e = cv_error(&h, gradients, &shell, samples);
                if e < best.0 {
                    best = (e, h);
                }
            }
        }
    }
    let (mut error, mut h) = best;
    let mut step = 0.4f64;
    while step > 0.02 {
        let mut moved = false;
        for k in 0..if multi { 3 } else { 2 } {
            for dir in [1.0, -1.0] {
                let f = (dir * step).exp();
                let mut t = h;
                match k {
                    0 => t.range = (t.range * f).min(std::f64::consts::PI),
                    1 => t.noise = (t.noise * f).max(1e-3),
                    _ => t.b_scale *= f,
                }
                let e = cv_error(&t, gradients, &shell, samples);
                if e < error {
                    error = e;
                    h = t;
                    moved = true;
                }
            }
        }
        if !moved {
            step *= 0.5;
        }
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directions(n: usize) -> Vec<[f64; 3]> {
        (0..n)
            .map(|i| {
                let z = 1.0 - 2.0 * (i as f64 + 0.5) / n as f64;
                let r = (1.0 - z * z).sqrt();
                let phi = i as f64 * std::f64::consts::PI * (3.0 - 5f64.sqrt());
                [r * phi.cos(), r * phi.sin(), z]
            })
            .collect()
    }

    fn tensor(b: f64, g: [f64; 3], e: [f64; 3]) -> f32 {
        let c = g[0] * e[0] + g[1] * e[1] + g[2] * e[2];
        (1000.0 * (-b * (0.5e-3 + 1.0e-3 * c * c)).exp()) as f32
    }

    /// Median relative error of the leave-one-out predictions, and of the shell mean of the
    /// other volumes (the prediction without any model).
    fn errors(gradients: &[(f64, [f64; 3])], samples: &[Vec<f32>]) -> (f64, f64) {
        let h = fit_hyper(gradients, samples);
        let fits = fits(&h, gradients).unwrap();
        let shell = shells(gradients);
        let (mut model, mut mean) = (Vec::new(), Vec::new());
        for y in samples {
            for (t, f) in fits.iter().enumerate() {
                let p: f64 = f
                    .volumes
                    .iter()
                    .zip(&f.weights)
                    .map(|(&j, w)| w * y[j] as f64)
                    .sum();
                model.push(((p - y[t] as f64) / y[t] as f64).abs());
                let same: Vec<f64> = (0..y.len())
                    .filter(|&j| j != t && shell[j] == shell[t])
                    .map(|j| y[j] as f64)
                    .collect();
                let m = same.iter().sum::<f64>() / same.len() as f64;
                mean.push(((m - y[t] as f64) / y[t] as f64).abs());
            }
        }
        let median = |mut v: Vec<f64>| {
            v.sort_by(f64::total_cmp);
            v[v.len() / 2]
        };
        (median(model), median(mean))
    }

    #[test]
    fn predicts_a_tensor_from_few_directions() {
        // 12 directions on one shell: far too few for 3dSHORE.
        let gradients: Vec<(f64, [f64; 3])> =
            directions(12).into_iter().map(|g| (1000.0, g)).collect();
        let samples: Vec<Vec<f32>> = directions(40)
            .iter()
            .map(|&e| gradients.iter().map(|&(b, g)| tensor(b, g, e)).collect())
            .collect();
        let (model, mean) = errors(&gradients, &samples);
        assert!(
            model < 0.5 * mean,
            "median relative error {model:.3}, shell mean {mean:.3}"
        );
        // The weights of a prediction sum to one: a constant is predicted exactly.
        let fits = fits(&fit_hyper(&gradients, &samples), &gradients).unwrap();
        for f in &fits {
            assert!((f.weights.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn works_across_shells() {
        let mut gradients = Vec::new();
        for (b, n) in [(500.0, 6), (1000.0, 20), (2000.0, 30)] {
            for g in directions(n) {
                gradients.push((b, g));
            }
        }
        let samples: Vec<Vec<f32>> = directions(30)
            .iter()
            .map(|&e| gradients.iter().map(|&(b, g)| tensor(b, g, e)).collect())
            .collect();
        let (model, mean) = errors(&gradients, &samples);
        assert!(
            model < 0.5 * mean,
            "median relative error {model:.3}, shell mean {mean:.3}"
        );
    }
}
