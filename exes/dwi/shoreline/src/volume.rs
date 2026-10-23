// SPDX-License-Identifier: Apache-2.0
//! One 3D grid: trilinear and cubic B-spline sampling, Gaussian smoothing, dilation.
//! Volumes are flat arrays in NIfTI voxel order (x fastest).

/// A grid of voxels. Positions are continuous voxel coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub dims: [usize; 3],
    /// Voxel size (mm) along each axis.
    pub voxel_size: [f64; 3],
}

impl Grid {
    pub fn voxels(&self) -> usize {
        self.dims.iter().product()
    }

    pub fn index(&self, i: usize, j: usize, k: usize) -> usize {
        i + self.dims[0] * (j + self.dims[1] * k)
    }

    pub fn ijk(&self, v: usize) -> [usize; 3] {
        let [nx, ny, _] = self.dims;
        [v % nx, (v / nx) % ny, v / (nx * ny)]
    }

    pub fn stride(&self, axis: usize) -> usize {
        match axis {
            0 => 1,
            1 => self.dims[0],
            _ => self.dims[0] * self.dims[1],
        }
    }

    /// Whether a position lies within the field of view (the voxels' extent, half a voxel
    /// beyond the first and last voxel centres).
    pub fn inside(&self, x: [f64; 3]) -> bool {
        (0..3).all(|a| x[a] >= -0.5 && x[a] <= self.dims[a] as f64 - 0.5)
    }

    /// A position within the field of view moved onto the voxel centres (the edge voxels
    /// extend to the edge of the field of view).
    fn clamp(&self, x: [f64; 3]) -> [f64; 3] {
        std::array::from_fn(|a| x[a].clamp(0.0, (self.dims[a] - 1) as f64))
    }

    /// The trilinear value at `x` and its derivative along voxel axis `axis`, or None
    /// outside the grid.
    pub fn trilinear_d(&self, vol: &[f32], x: [f64; 3], axis: usize) -> Option<(f64, f64)> {
        if !self.inside(x) {
            return None;
        }
        let x = self.clamp(x);
        let mut base = [0usize; 3];
        let mut f = [0.0f64; 3];
        for a in 0..3 {
            let n = self.dims[a];
            let i = (x[a] as usize).min(n.saturating_sub(2));
            base[a] = i;
            f[a] = x[a] - i as f64;
        }
        let s = [self.stride(0), self.stride(1), self.stride(2)];
        let o = base[0] * s[0] + base[1] * s[1] + base[2] * s[2];
        let step = |a: usize| if self.dims[a] > 1 { s[a] } else { 0 };
        let (sx, sy, sz) = (step(0), step(1), step(2));
        let c = |dx: usize, dy: usize, dz: usize| vol[o + dx * sx + dy * sy + dz * sz] as f64;
        let w = |a: usize, b: usize| if b == 1 { f[a] } else { 1.0 - f[a] };
        let dw = |b: usize| if b == 1 { 1.0 } else { -1.0 };
        let mut value = 0.0;
        let mut d = 0.0;
        for dz in 0..2 {
            for dy in 0..2 {
                for dx in 0..2 {
                    let v = c(dx, dy, dz);
                    let b = [dx, dy, dz];
                    let wx = [w(0, dx), w(1, dy), w(2, dz)];
                    value += v * wx[0] * wx[1] * wx[2];
                    let mut wd = dw(b[axis]);
                    for (a, w) in wx.iter().enumerate() {
                        if a != axis {
                            wd *= w;
                        }
                    }
                    d += v * wd;
                }
            }
        }
        Some((value, d))
    }

    /// The trilinear value at `x`, or None outside the grid.
    pub fn trilinear(&self, vol: &[f32], x: [f64; 3]) -> Option<f64> {
        if !self.inside(x) {
            return None;
        }
        let x = self.clamp(x);
        let mut o = 0;
        let mut f = [0.0f64; 3];
        let mut s = [0usize; 3];
        for a in 0..3 {
            let n = self.dims[a];
            let i = (x[a] as usize).min(n.saturating_sub(2));
            f[a] = x[a] - i as f64;
            o += i * self.stride(a);
            s[a] = if n > 1 { self.stride(a) } else { 0 };
        }
        let c = |d: usize| vol[o + d] as f64;
        let lerp = |a: f64, b: f64, t: f64| a + (b - a) * t;
        let along_x = |d: usize| lerp(c(d), c(d + s[0]), f[0]);
        let near = lerp(along_x(0), along_x(s[1]), f[1]);
        let far = lerp(along_x(s[2]), along_x(s[2] + s[1]), f[1]);
        Some(lerp(near, far, f[2]))
    }

    /// Separable Gaussian smoothing with standard deviation `sigma_mm`; edges repeat.
    pub fn smooth(&self, vol: &[f32], sigma_mm: f64) -> Vec<f32> {
        let mut out: Vec<f32> = vol.to_vec();
        if sigma_mm <= 0.0 {
            return out;
        }
        let mut tmp = vec![0.0f32; vol.len()];
        for axis in 0..3 {
            let sigma = sigma_mm / self.voxel_size[axis];
            let r = (3.0 * sigma).ceil() as isize;
            if r < 1 || self.dims[axis] < 2 {
                continue;
            }
            let kernel: Vec<f64> = (-r..=r)
                .map(|t| (-(t * t) as f64 / (2.0 * sigma * sigma)).exp())
                .collect();
            let total: f64 = kernel.iter().sum();
            let kernel: Vec<f32> = kernel.iter().map(|k| (k / total) as f32).collect();
            let n = self.dims[axis];
            let s = self.stride(axis);
            let clamped =
                |i: usize, q: usize| (i as isize + q as isize - r).clamp(0, n as isize - 1);
            if s == 1 {
                for (src, dst) in out.chunks(n).zip(tmp.chunks_mut(n)) {
                    for (i, d) in dst.iter_mut().enumerate() {
                        let mut acc = 0.0f32;
                        for (q, &k) in kernel.iter().enumerate() {
                            acc += k * src[clamped(i, q) as usize];
                        }
                        *d = acc;
                    }
                }
                std::mem::swap(&mut out, &mut tmp);
                continue;
            }
            // Blocks of n rows of s values: row i holds sample i of s lines, side by side.
            for (src, dst) in out.chunks(n * s).zip(tmp.chunks_mut(n * s)) {
                for (i, row) in dst.chunks_mut(s).enumerate() {
                    row.fill(0.0);
                    for (q, &k) in kernel.iter().enumerate() {
                        let j = clamped(i, q) as usize;
                        for (d, &x) in row.iter_mut().zip(&src[j * s..(j + 1) * s]) {
                            *d += k * x;
                        }
                    }
                }
            }
            std::mem::swap(&mut out, &mut tmp);
        }
        out
    }

    /// The mask grown by `r` voxels along every axis (a cube).
    pub fn dilate(&self, mask: &[bool], r: usize) -> Vec<bool> {
        let mut out = mask.to_vec();
        for axis in 0..3 {
            let s = self.stride(axis);
            let n = self.dims[axis];
            let prev = out.clone();
            for (v, o) in out.iter_mut().enumerate() {
                if *o {
                    continue;
                }
                let p = self.ijk(v)[axis];
                let start = v - p * s;
                let lo = p.saturating_sub(r);
                let hi = (p + r).min(n - 1);
                *o = (lo..=hi).any(|i| prev[start + i * s]);
            }
        }
        out
    }
}

/// Cubic B-spline interpolation coefficients of a volume (Unser's recursive prefilter,
/// mirror boundaries).
pub fn bspline_coefficients(grid: &Grid, vol: &[f32]) -> Vec<f32> {
    let z = 3f64.sqrt() - 2.0;
    let mut c: Vec<f64> = vol.iter().map(|&v| v as f64).collect();
    for axis in 0..3 {
        let n = grid.dims[axis];
        if n < 2 {
            continue;
        }
        let s = grid.stride(axis);
        let mut sum = vec![0.0f64; s];
        // Blocks of n rows of s values: row i holds sample i of s lines, filtered together.
        for block in c.chunks_mut(n * s) {
            for x in block.iter_mut() {
                *x *= 6.0;
            }
            // Causal initialisation, mirror boundary: exact for short lines, a truncated sum
            // (|z|^30 < 1e-17) for long ones.
            if n <= 30 {
                let z2n = z.powi(2 * n as i32 - 2);
                let zn = z.powi(n as i32 - 1);
                for (j, x) in sum.iter_mut().enumerate() {
                    *x = block[j] + zn * block[(n - 1) * s + j];
                }
                for k in 1..n - 1 {
                    let w = z.powi(k as i32) + z.powi(2 * n as i32 - 2 - k as i32);
                    for (x, &l) in sum.iter_mut().zip(&block[k * s..(k + 1) * s]) {
                        *x += w * l;
                    }
                }
                for (b, x) in block[..s].iter_mut().zip(&sum) {
                    *b = x / (1.0 - z2n);
                }
            } else {
                sum.copy_from_slice(&block[..s]);
                let mut zn = z;
                for k in 1..30 {
                    for (x, &l) in sum.iter_mut().zip(&block[k * s..(k + 1) * s]) {
                        *x += zn * l;
                    }
                    zn *= z;
                }
                block[..s].copy_from_slice(&sum);
            }
            for i in 1..n {
                let (before, after) = block.split_at_mut(i * s);
                for (x, &p) in after[..s].iter_mut().zip(&before[(i - 1) * s..]) {
                    *x += z * p;
                }
            }
            let (before, last) = block.split_at_mut((n - 1) * s);
            for (x, &p) in last.iter_mut().zip(&before[(n - 2) * s..]) {
                *x = z / (z * z - 1.0) * (z * p + *x);
            }
            for i in (0..n - 1).rev() {
                let (before, after) = block.split_at_mut((i + 1) * s);
                for (x, &p) in before[i * s..].iter_mut().zip(&after[..s]) {
                    *x = z * (p - *x);
                }
            }
        }
    }
    c.into_iter().map(|v| v as f32).collect()
}

fn bspline_weights(t: f64) -> [f64; 4] {
    let u = 1.0 - t;
    [
        u * u * u / 6.0,
        (4.0 - 6.0 * t * t + 3.0 * t * t * t) / 6.0,
        (1.0 + 3.0 * t + 3.0 * t * t - 3.0 * t * t * t) / 6.0,
        t * t * t / 6.0,
    ]
}

fn bspline_derivative_weights(t: f64) -> [f64; 4] {
    let u = 1.0 - t;
    [
        -u * u / 2.0,
        -2.0 * t + 1.5 * t * t,
        0.5 + t - 1.5 * t * t,
        t * t / 2.0,
    ]
}

/// The cubic B-spline value at `x` from `bspline_coefficients`, or None outside the grid.
pub fn bspline(grid: &Grid, coef: &[f32], x: [f64; 3]) -> Option<f64> {
    if !grid.inside(x) {
        return None;
    }
    let (idx, w, _) = bspline_support(grid, x, None);
    let mut value = 0.0;
    for (wz, &iz) in w[2].iter().zip(&idx[2]) {
        let mut plane = 0.0;
        for (wy, &iy) in w[1].iter().zip(&idx[1]) {
            let o = iy + iz;
            let row = w[0][0] * coef[idx[0][0] + o] as f64
                + w[0][1] * coef[idx[0][1] + o] as f64
                + w[0][2] * coef[idx[0][2] + o] as f64
                + w[0][3] * coef[idx[0][3] + o] as f64;
            plane += wy * row;
        }
        value += wz * plane;
    }
    Some(value)
}

/// The offsets (mirrored at the edges) and weights of the 4 × 4 × 4 coefficients around
/// `x`, and with `axis` the derivative weights along it.
#[allow(clippy::type_complexity)]
#[inline(always)]
fn bspline_support(
    grid: &Grid,
    x: [f64; 3],
    axis: Option<usize>,
) -> ([[usize; 4]; 3], [[f64; 4]; 3], [[f64; 4]; 3]) {
    let mut idx = [[0usize; 4]; 3];
    let mut w = [[0.0; 4]; 3];
    let mut dw = [[0.0; 4]; 3];
    for a in 0..3 {
        let n = grid.dims[a] as isize;
        // Positions inside the grid are at least -0.5, where truncation is the floor (and
        // cheaper than the library call).
        let i0 = (x[a] + 1.0) as isize - 1;
        let t = x[a] - i0 as f64;
        w[a] = bspline_weights(t);
        if axis == Some(a) {
            dw[a] = bspline_derivative_weights(t);
        }
        let stride = grid.stride(a);
        if i0 >= 1 && i0 + 2 < n {
            for (k, slot) in idx[a].iter_mut().enumerate() {
                *slot = (i0 - 1 + k as isize) as usize * stride;
            }
            continue;
        }
        for (k, slot) in idx[a].iter_mut().enumerate() {
            let mut i = i0 - 1 + k as isize;
            // Mirror.
            if n == 1 {
                i = 0;
            } else {
                if i < 0 {
                    i = -i;
                }
                if i >= n {
                    i = 2 * (n - 1) - i;
                }
                i = i.clamp(0, n - 1);
            }
            *slot = i as usize * stride;
        }
    }
    (idx, w, dw)
}

/// The cubic B-spline value at `x` and, with `axis`, its derivative along that voxel axis.
pub fn bspline_d(
    grid: &Grid,
    coef: &[f32],
    x: [f64; 3],
    axis: Option<usize>,
) -> Option<(f64, f64)> {
    if !grid.inside(x) {
        return None;
    }
    let (idx, w, dw) = bspline_support(grid, x, axis);
    let wd = |a: usize| if axis == Some(a) { &dw[a] } else { &w[a] };
    let (dx, dy, dz) = (wd(0), wd(1), wd(2));
    let mut value = 0.0;
    let mut derivative = 0.0;
    for k in 0..4 {
        let iz = idx[2][k];
        for j in 0..4 {
            let iy = idx[1][j];
            let mut row = 0.0;
            let mut drow = 0.0;
            for i in 0..4 {
                let c = coef[idx[0][i] + iy + iz] as f64;
                row += w[0][i] * c;
                drow += dx[i] * c;
            }
            if axis.is_some() {
                derivative += dz[k] * dy[j] * if axis == Some(0) { drow } else { row };
            }
            value += w[2][k] * w[1][j] * row;
        }
    }
    Some((value, derivative))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(g: &Grid) -> Vec<f32> {
        (0..g.voxels())
            .map(|v| {
                let [i, j, k] = g.ijk(v);
                (1.0 + 2.0 * i as f64 - 0.5 * j as f64 + 0.25 * (k * k) as f64) as f32
            })
            .collect()
    }

    #[test]
    fn trilinear_is_exact_on_a_linear_ramp() {
        let g = Grid {
            dims: [6, 5, 4],
            voxel_size: [1.0; 3],
        };
        let lin: Vec<f32> = (0..g.voxels())
            .map(|v| {
                let [i, j, k] = g.ijk(v);
                (1.0 + 2.0 * i as f64 - 0.5 * j as f64 + 3.0 * k as f64) as f32
            })
            .collect();
        let (v, d) = g.trilinear_d(&lin, [2.3, 1.7, 2.2], 2).unwrap();
        assert!((v - (1.0 + 4.6 - 0.85 + 6.6)).abs() < 1e-5);
        assert!((d - 3.0).abs() < 1e-5);
        assert!(g.trilinear(&lin, [5.6, 0.0, 0.0]).is_none());
        assert!((g.trilinear(&lin, [5.4, 0.0, 0.0]).unwrap() - 11.0).abs() < 1e-5);
    }

    #[test]
    fn bspline_interpolates_the_samples() {
        let g = Grid {
            dims: [9, 8, 24],
            voxel_size: [1.0; 3],
        };
        let vol = ramp(&g);
        let c = bspline_coefficients(&g, &vol);
        for v in [0, 17, 100, g.voxels() - 1] {
            let [i, j, k] = g.ijk(v);
            let s = bspline(&g, &c, [i as f64, j as f64, k as f64]).unwrap();
            assert!((s - vol[v] as f64).abs() < 1e-3, "{s} {}", vol[v]);
        }
        // A quadratic in k is reproduced between samples away from the edges.
        let s = bspline(&g, &c, [4.0, 4.0, 11.5]).unwrap();
        let exact = 1.0 + 8.0 - 2.0 + 0.25 * 11.5 * 11.5;
        assert!((s - exact).abs() < 0.02, "{s} {exact}");
    }

    #[test]
    fn bspline_derivative_matches_finite_differences() {
        let g = Grid {
            dims: [9, 8, 24],
            voxel_size: [1.0; 3],
        };
        let c = bspline_coefficients(&g, &ramp(&g));
        for axis in 0..3 {
            let x = [3.3, 4.6, 10.2];
            let (_, d) = bspline_d(&g, &c, x, Some(axis)).unwrap();
            let mut hi = x;
            let mut lo = x;
            hi[axis] += 1e-4;
            lo[axis] -= 1e-4;
            let fd = (bspline(&g, &c, hi).unwrap() - bspline(&g, &c, lo).unwrap()) / 2e-4;
            assert!((d - fd).abs() < 1e-3, "{axis}: {d} {fd}");
        }
    }

    #[test]
    fn smoothing_keeps_a_constant_and_dilation_grows() {
        let g = Grid {
            dims: [5, 5, 5],
            voxel_size: [2.0; 3],
        };
        let s = g.smooth(&vec![3.0; g.voxels()], 1.5);
        assert!(s.iter().all(|v| (v - 3.0).abs() < 1e-5));
        let mut m = vec![false; g.voxels()];
        m[g.index(2, 2, 2)] = true;
        assert_eq!(g.dilate(&m, 1).iter().filter(|&&b| b).count(), 27);
    }
}
