// SPDX-License-Identifier: Apache-2.0
//! Movement-by-susceptibility (eddy's `--estimate_move_by_susceptibility`; Andersson et al.
//! 2018, NeuroImage 171:277-295), implemented from the paper; no FSL code was read.
//!
//! The susceptibility field depends on the head's orientation in the main field: a rotation
//! about the two axes perpendicular to it (pitch and roll) changes the field, not only moves
//! it. To first order the field of volume v is f₀ + θ_x D_x + θ_y D_y, with θ the volume's
//! rotations (radians) about the voxel x and y axes and D smooth fields (Hz per radian),
//! cubic B-splines with knots every `spacing` voxels. Given each voxel's weights from all
//! volumes (`Accumulator`), the coefficients solve a regularised least-squares problem by
//! conjugate gradients, without forming its matrix.

use crate::volume::Grid;

/// A cubic B-spline field on a coarse knot grid covering the image grid.
#[derive(Clone, Debug)]
pub struct Spline {
    knots: [usize; 3],
    spacing: [f64; 3],
    pub coefficients: Vec<f64>,
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

impl Spline {
    pub fn zero(grid: &Grid, spacing_mm: f64) -> Self {
        let spacing: [f64; 3] = std::array::from_fn(|a| (spacing_mm / grid.voxel_size[a]).max(1.0));
        // Knot j at voxel (j - 1)·spacing, enough to cover the grid with the cubic support.
        let knots =
            std::array::from_fn(|a| ((grid.dims[a] as f64 - 1.0) / spacing[a]).ceil() as usize + 3);
        Self {
            knots,
            spacing,
            coefficients: vec![0.0; knots.iter().product()],
        }
    }

    pub fn len(&self) -> usize {
        self.coefficients.len()
    }

    pub fn is_empty(&self) -> bool {
        self.coefficients.is_empty()
    }

    /// The (knot index, weight) pairs of a voxel: 4 per axis, 64 in all.
    fn weights(&self, ijk: [usize; 3]) -> ([[usize; 4]; 3], [[f64; 4]; 3]) {
        let mut idx = [[0usize; 4]; 3];
        let mut w = [[0.0; 4]; 3];
        for a in 0..3 {
            let u = ijk[a] as f64 / self.spacing[a] + 1.0;
            let first = u.floor() as usize - 1;
            for k in 0..4 {
                let j = (first + k).min(self.knots[a] - 1);
                idx[a][k] = j;
                w[a][k] = cubic(u - (first + k) as f64);
            }
        }
        (idx, w)
    }

    /// The field at every voxel of the grid.
    pub fn evaluate(&self, grid: &Grid) -> Vec<f32> {
        use rayon::prelude::*;
        (0..grid.voxels())
            .into_par_iter()
            .map(|v| self.at(&self.coefficients, grid.ijk(v)) as f32)
            .collect()
    }

    fn at(&self, c: &[f64], ijk: [usize; 3]) -> f64 {
        let (idx, w) = self.weights(ijk);
        let [kx, ky, _] = self.knots;
        let mut sum = 0.0;
        for (wz, &iz) in w[2].iter().zip(&idx[2]) {
            for (wy, &iy) in w[1].iter().zip(&idx[1]) {
                for (wx, &ix) in w[0].iter().zip(&idx[0]) {
                    sum += wx * wy * wz * c[ix + kx * (iy + ky * iz)];
                }
            }
        }
        sum
    }

    fn spread(&self, out: &mut [f64], ijk: [usize; 3], value: f64) {
        let (idx, w) = self.weights(ijk);
        let [kx, ky, _] = self.knots;
        for (wz, &iz) in w[2].iter().zip(&idx[2]) {
            for (wy, &iy) in w[1].iter().zip(&idx[1]) {
                for (wx, &ix) in w[0].iter().zip(&idx[0]) {
                    out[ix + kx * (iy + ky * iz)] += wx * wy * wz * value;
                }
            }
        }
    }

    /// Σ over neighbouring knots of squared differences: (Lc) with L the graph Laplacian.
    fn laplacian(&self, c: &[f64], out: &mut [f64], lambda: f64) {
        let [kx, ky, kz] = self.knots;
        for z in 0..kz {
            for y in 0..ky {
                for x in 0..kx {
                    let i = x + kx * (y + ky * z);
                    let mut s = 0.0;
                    let mut add = |j: usize| s += c[i] - c[j];
                    if x > 0 {
                        add(i - 1);
                    }
                    if x + 1 < kx {
                        add(i + 1);
                    }
                    if y > 0 {
                        add(i - kx);
                    }
                    if y + 1 < ky {
                        add(i + kx);
                    }
                    if z > 0 {
                        add(i - kx * ky);
                    }
                    if z + 1 < kz {
                        add(i + kx * ky);
                    }
                    out[i] += lambda * s;
                }
            }
        }
    }
}

/// Per voxel, summed over the volumes: the normal-equation weights of the two derivative
/// fields at that voxel (2 × 2, symmetric) and the right-hand side (2).
pub struct Accumulator {
    pub voxels: Vec<usize>,
    pub weight: Vec<[f64; 3]>,
    pub rhs: Vec<[f64; 2]>,
}

/// Solves for the two derivative fields (`fields[0]` for θ_x, `fields[1]` for θ_y), starting
/// from their current values, by conjugate gradients on
/// (Bᵀ W B + λ L) c = Bᵀ g, with B the spline basis at the accumulated voxels.
pub fn solve(
    grid: &Grid,
    fields: &mut [Spline; 2],
    acc: &Accumulator,
    lambda: f64,
    iterations: usize,
) {
    let n = fields[0].len();
    let ijk: Vec<[usize; 3]> = acc.voxels.iter().map(|&v| grid.ijk(v)).collect();
    let apply = |c: &[f64]| -> Vec<f64> {
        let (cx, cy) = c.split_at(n);
        let mut out = vec![0.0; 2 * n];
        {
            let (ox, oy) = out.split_at_mut(n);
            for (k, p) in ijk.iter().enumerate() {
                let (a, b) = (fields[0].at(cx, *p), fields[1].at(cy, *p));
                let w = acc.weight[k];
                fields[0].spread(ox, *p, w[0] * a + w[1] * b);
                fields[1].spread(oy, *p, w[1] * a + w[2] * b);
            }
            fields[0].laplacian(cx, ox, lambda);
            fields[1].laplacian(cy, oy, lambda);
        }
        out
    };
    let mut b = vec![0.0; 2 * n];
    {
        let (bx, by) = b.split_at_mut(n);
        for (k, p) in ijk.iter().enumerate() {
            fields[0].spread(bx, *p, acc.rhs[k][0]);
            fields[1].spread(by, *p, acc.rhs[k][1]);
        }
    }
    // The equations are for the increment of the coefficients.
    let mut x = vec![0.0; 2 * n];
    let current: Vec<f64> = fields[0]
        .coefficients
        .iter()
        .chain(&fields[1].coefficients)
        .copied()
        .collect();
    // Regularise the total field, not the increment: b -= λ L c_current.
    {
        let mut lc = vec![0.0; 2 * n];
        let (lx, ly) = lc.split_at_mut(n);
        fields[0].laplacian(&current[..n], lx, lambda);
        fields[1].laplacian(&current[n..], ly, lambda);
        for (bi, li) in b.iter_mut().zip(&lc) {
            *bi -= li;
        }
    }
    let mut r = b.clone();
    let mut p = r.clone();
    let mut rr: f64 = r.iter().map(|v| v * v).sum();
    let tol = 1e-8 * rr.max(1e-30);
    for _ in 0..iterations {
        if rr <= tol {
            break;
        }
        let ap = apply(&p);
        let pap: f64 = p.iter().zip(&ap).map(|(a, b)| a * b).sum();
        if pap <= 0.0 {
            break;
        }
        let alpha = rr / pap;
        for i in 0..2 * n {
            x[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
        }
        let rr_new: f64 = r.iter().map(|v| v * v).sum();
        let beta = rr_new / rr;
        rr = rr_new;
        for i in 0..2 * n {
            p[i] = r[i] + beta * p[i];
        }
    }
    for (c, dx) in fields[0].coefficients.iter_mut().zip(&x[..n]) {
        *c += dx;
    }
    for (c, dx) in fields[1].coefficients.iter_mut().zip(&x[n..]) {
        *c += dx;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_smooth_fields_from_weighted_samples() {
        // Each voxel sees y = θx Dx + θy Dy for many (θx, θy): with the exact normal
        // equations the fields come back.
        let grid = Grid {
            dims: [20, 18, 12],
            voxel_size: [2.0; 3],
        };
        let truth = |p: [usize; 3]| -> [f64; 2] {
            let (x, y, z) = (p[0] as f64, p[1] as f64, p[2] as f64);
            [
                10.0 * (0.15 * x).sin() + 0.5 * z,
                8.0 * (0.2 * y).cos() - 0.3 * x,
            ]
        };
        let thetas: Vec<[f64; 2]> = (0..30)
            .map(|i| {
                [
                    ((i * 7) % 11) as f64 / 11.0 - 0.5,
                    ((i * 5) % 13) as f64 / 13.0 - 0.5,
                ]
            })
            .collect();
        let voxels: Vec<usize> = (0..grid.voxels()).collect();
        let mut weight = Vec::new();
        let mut rhs = Vec::new();
        for &v in &voxels {
            let t = truth(grid.ijk(v));
            let mut w = [0.0; 3];
            let mut g = [0.0; 2];
            for th in &thetas {
                let y = th[0] * t[0] + th[1] * t[1];
                w[0] += th[0] * th[0];
                w[1] += th[0] * th[1];
                w[2] += th[1] * th[1];
                g[0] += th[0] * y;
                g[1] += th[1] * y;
            }
            weight.push(w);
            rhs.push(g);
        }
        let acc = Accumulator {
            voxels,
            weight,
            rhs,
        };
        let mut fields = [Spline::zero(&grid, 6.0), Spline::zero(&grid, 6.0)];
        solve(&grid, &mut fields, &acc, 1e-4, 500);
        let (fx, fy) = (fields[0].evaluate(&grid), fields[1].evaluate(&grid));
        let mut worst: f64 = 0.0;
        for v in 0..grid.voxels() {
            let p = grid.ijk(v);
            if (0..3).any(|a| p[a] < 2 || p[a] + 2 >= grid.dims[a]) {
                continue;
            }
            let t = truth(p);
            worst = worst
                .max((fx[v] as f64 - t[0]).abs())
                .max((fy[v] as f64 - t[1]).abs());
        }
        assert!(worst < 1.0, "worst error {worst}");
    }
}
