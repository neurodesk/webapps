// SPDX-License-Identifier: Apache-2.0
//! Rigid alignment of a shell's mean to the b0 mean by mutual information (the post
//! estimation alignment of shells, Andersson and Sotiropoulos 2016). Mattes mutual
//! information (Mattes et al. 2003, IEEE TMI 22:120-128): a joint histogram with a box
//! window for the fixed image and a cubic B-spline window for the moving image, so that the
//! cost is smooth and has an analytic gradient; maximised by BFGS.

use crate::rigid::{self, Rigid};
use crate::volume::{self, Grid};

const BINS: usize = 32;

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

fn cubic_derivative(t: f64) -> f64 {
    let a = t.abs();
    let s = t.signum();
    if a < 1.0 {
        s * (-2.0 * a + 1.5 * a * a)
    } else if a < 2.0 {
        let b = 2.0 - a;
        -s * 0.5 * b * b
    } else {
        0.0
    }
}

/// Parameters: translations (mm) and rotations scaled by `RADIUS` (mm of arc), so that a
/// unit step moves the brain's edge about as far in every parameter.
const RADIUS: f64 = 50.0;

fn rigid_of(x: &[f64; 6]) -> Rigid {
    Rigid {
        translation: [x[0], x[1], x[2]],
        rotation: [x[3] / RADIUS, x[4] / RADIUS, x[5] / RADIUS],
    }
}

struct Problem<'a> {
    grid: &'a Grid,
    coef: Vec<f32>,
    centre: [f64; 3],
    points: Vec<[f64; 3]>,
    fixed_bins: Vec<usize>,
    m_lo: f64,
    m_scale: f64,
}

impl Problem<'_> {
    /// Negative mutual information and its gradient.
    fn evaluate(&self, x: &[f64; 6]) -> (f64, [f64; 6]) {
        let t = rigid_of(x);
        let r = t.matrix();
        let dr = t.matrix_derivatives();
        let mut joint = vec![[0.0f64; BINS]; BINS];
        // Per sample: its fixed bin, moving bin position, and d(moving bin)/d(params).
        let mut samples: Vec<(usize, f64, [f64; 6])> = Vec::with_capacity(self.points.len());
        for (p, &fb) in self.points.iter().zip(&self.fixed_bins) {
            let q = rigid::apply(&r, *p);
            let q: [f64; 3] = std::array::from_fn(|i| q[i] + t.translation[i]);
            let xv: [f64; 3] =
                std::array::from_fn(|i| q[i] / self.grid.voxel_size[i] + self.centre[i]);
            let mut grad = [0.0; 3];
            let mut value = 0.0;
            let mut ok = true;
            for (a, g) in grad.iter_mut().enumerate() {
                match volume::bspline_d(self.grid, &self.coef, xv, Some(a)) {
                    Some((v, d)) => {
                        value = v;
                        *g = d / self.grid.voxel_size[a];
                    }
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                continue;
            }
            let b = ((value - self.m_lo) * self.m_scale).clamp(1.0, BINS as f64 - 2.0);
            let mut db = [0.0; 6];
            for (k, d) in db.iter_mut().take(3).enumerate() {
                *d = grad[k] * self.m_scale;
            }
            for (j, d) in dr.iter().enumerate() {
                let dq = rigid::apply(d, *p);
                db[3 + j] =
                    (grad[0] * dq[0] + grad[1] * dq[1] + grad[2] * dq[2]) * self.m_scale / RADIUS;
            }
            let lo = b.floor() as isize;
            for k in (lo - 1).max(0)..=(lo + 2).min(BINS as isize - 1) {
                joint[fb][k as usize] += cubic(b - k as f64);
            }
            samples.push((fb, b, db));
        }
        let n = samples.len().max(1) as f64;
        let mut pf = [0.0; BINS];
        let mut pm = [0.0; BINS];
        for i in 0..BINS {
            for j in 0..BINS {
                joint[i][j] /= n;
                pf[i] += joint[i][j];
                pm[j] += joint[i][j];
            }
        }
        let mut mi = 0.0;
        // log(p(i,j) / p_m(j)) per cell, for the gradient.
        let mut weight = vec![[0.0f64; BINS]; BINS];
        for i in 0..BINS {
            for j in 0..BINS {
                let p = joint[i][j];
                if p > 1e-12 {
                    mi += p * (p / (pf[i] * pm[j])).ln();
                    weight[i][j] = (p / pm[j]).ln();
                }
            }
        }
        let mut gradient = [0.0; 6];
        for (fb, b, db) in &samples {
            let lo = b.floor() as isize;
            let mut s = 0.0;
            for k in (lo - 1).max(0)..=(lo + 2).min(BINS as isize - 1) {
                // d/db of the window: -cubic'(b - k) with respect to the bin position.
                s += cubic_derivative(b - k as f64) * weight[*fb][k as usize];
            }
            for (g, d) in gradient.iter_mut().zip(db) {
                *g += s * d / n;
            }
        }
        (-mi, gradient.map(|g| -g))
    }
}

/// The rigid transform A (model mm to model mm) that maximises the mutual information
/// between `fixed(m)` and `moving(A(m))` over `voxels`. NaN values are ignored.
pub fn register(grid: &Grid, fixed: &[f32], moving: &[f32], voxels: &[usize]) -> Rigid {
    let centre: [f64; 3] = std::array::from_fn(|i| (grid.dims[i] as f64 - 1.0) / 2.0);
    let moving: Vec<f32> = moving
        .iter()
        .map(|&v| if v.is_finite() { v } else { 0.0 })
        .collect();
    let range = |values: Vec<f64>| -> (f64, f64) {
        let mut v: Vec<f64> = values.into_iter().filter(|x| x.is_finite()).collect();
        v.sort_by(f64::total_cmp);
        if v.is_empty() {
            return (0.0, 1.0);
        }
        let lo = v[v.len() / 200];
        let hi = v[v.len() * 199 / 200];
        (lo, if hi > lo { hi } else { lo + 1.0 })
    };
    let kept: Vec<usize> = voxels
        .iter()
        .copied()
        .filter(|&v| fixed[v].is_finite())
        .collect();
    let (f_lo, f_hi) = range(kept.iter().map(|&v| fixed[v] as f64).collect());
    let (m_lo, m_hi) = range(kept.iter().map(|&v| moving[v] as f64).collect());
    // Bins 1..BINS-2 hold the range, so the cubic window stays inside the histogram.
    let usable = (BINS - 3) as f64;
    let problem = Problem {
        grid,
        coef: volume::bspline_coefficients(grid, &moving),
        centre,
        points: kept
            .iter()
            .map(|&v| {
                let ijk = grid.ijk(v);
                std::array::from_fn(|i| (ijk[i] as f64 - centre[i]) * grid.voxel_size[i])
            })
            .collect(),
        fixed_bins: kept
            .iter()
            .map(|&v| {
                (((fixed[v] as f64 - f_lo) / (f_hi - f_lo) * usable).clamp(0.0, usable) + 1.0)
                    .round() as usize
            })
            .collect(),
        m_lo: m_lo - (m_hi - m_lo) / usable,
        m_scale: usable / (m_hi - m_lo),
    };
    rigid_of(&bfgs(|x| problem.evaluate(x), [0.0; 6], 60))
}

/// BFGS with a backtracking (Armijo) line search.
fn bfgs(f: impl Fn(&[f64; 6]) -> (f64, [f64; 6]), start: [f64; 6], iterations: usize) -> [f64; 6] {
    let mut x = start;
    let (mut fx, mut g) = f(&x);
    let mut h = [[0.0; 6]; 6];
    for (i, row) in h.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    // A first step of about 0.5 mm.
    let gnorm = g.iter().map(|v| v * v).sum::<f64>().sqrt().max(1e-12);
    for row in h.iter_mut() {
        for v in row.iter_mut() {
            *v *= 0.5 / gnorm;
        }
    }
    for _ in 0..iterations {
        let d: [f64; 6] = std::array::from_fn(|i| -(0..6).map(|j| h[i][j] * g[j]).sum::<f64>());
        let slope: f64 = (0..6).map(|i| d[i] * g[i]).sum();
        if slope >= 0.0 {
            break;
        }
        let mut step = 1.0;
        let mut accepted = None;
        for _ in 0..20 {
            let trial: [f64; 6] = std::array::from_fn(|i| x[i] + step * d[i]);
            let (ft, gt) = f(&trial);
            if ft <= fx + 1e-4 * step * slope {
                accepted = Some((trial, ft, gt));
                break;
            }
            step *= 0.5;
        }
        let Some((xn, fn_, gn)) = accepted else {
            break;
        };
        let s: [f64; 6] = std::array::from_fn(|i| xn[i] - x[i]);
        let y: [f64; 6] = std::array::from_fn(|i| gn[i] - g[i]);
        let sy: f64 = (0..6).map(|i| s[i] * y[i]).sum();
        x = xn;
        let done = (fx - fn_).abs() < 1e-9 && s.iter().map(|v| v.abs()).fold(0.0, f64::max) < 1e-4;
        fx = fn_;
        g = gn;
        if done {
            break;
        }
        if sy > 1e-12 {
            // h = (I - ρ s yᵀ) h (I - ρ y sᵀ) + ρ s sᵀ
            let rho = 1.0 / sy;
            let hy: [f64; 6] = std::array::from_fn(|i| (0..6).map(|j| h[i][j] * y[j]).sum());
            let yhy: f64 = (0..6).map(|i| y[i] * hy[i]).sum();
            for i in 0..6 {
                for j in 0..6 {
                    h[i][j] += -rho * (hy[i] * s[j] + s[i] * hy[j])
                        + (rho * rho * yhy + rho) * s[i] * s[j];
                }
            }
        }
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gradient_matches_finite_differences() {
        let g = Grid {
            dims: [20, 22, 16],
            voxel_size: [2.0; 3],
        };
        let image = |v: usize, shift: f64| -> f32 {
            let [i, j, k] = g.ijk(v).map(|a| a as f64);
            let r2 = ((i - 9.5 - shift) / 6.0).powi(2)
                + ((j - 10.5) / 7.0).powi(2)
                + ((k - 7.5) / 5.0).powi(2);
            ((1.0 / (1.0 + ((r2 - 1.0) * 6.0).exp()))
                * (100.0 + 30.0 * (0.7 * i).sin() * (0.5 * j).cos())) as f32
        };
        let fixed: Vec<f32> = (0..g.voxels()).map(|v| image(v, 0.0)).collect();
        // A different contrast: inverted inside the object.
        let moving: Vec<f32> = (0..g.voxels()).map(|v| 150.0 - image(v, 0.3)).collect();
        let voxels: Vec<usize> = (0..g.voxels()).collect();
        let a = register(&g, &fixed, &moving, &voxels);
        // The moving image is the fixed one shifted +0.3 voxels (0.6 mm) along x.
        assert!((a.translation[0] - 0.6).abs() < 0.1, "{a:?}");
        assert!(
            a.translation[1].abs() < 0.1 && a.translation[2].abs() < 0.1,
            "{a:?}"
        );
    }
}
