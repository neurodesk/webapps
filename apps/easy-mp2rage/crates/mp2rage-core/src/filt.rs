//! Separable Gaussian filter + binary morphology, matching
//! `scipy.ndimage` (gaussian_filter / binary_closing / binary_fill_holes).

use ndarray::{Array3, Axis};

/// Half-sample-symmetric reflect index (SciPy `mode='reflect'`), robust to any
/// offset (folds through the period so a radius-4 kernel works on tiny axes).
#[inline]
fn reflect_index(mut p: isize, n: isize) -> usize {
    if n == 1 {
        return 0;
    }
    let period = 2 * n;
    p %= period;
    if p < 0 {
        p += period;
    }
    if p >= n {
        p = period - 1 - p;
    }
    p as usize
}

/// SciPy `_gaussian_kernel1d(sigma, order=0, radius)`: normalized samples of a
/// Gaussian on `[-radius, radius]`. Symmetric, so filter reversal is a no-op.
pub fn gaussian_kernel1d(sigma: f64, radius: isize) -> Vec<f64> {
    let sigma2 = sigma * sigma;
    let mut phi: Vec<f64> = (-radius..=radius)
        .map(|x| (-0.5 / sigma2 * (x as f64) * (x as f64)).exp())
        .collect();
    let s: f64 = phi.iter().sum();
    for v in phi.iter_mut() {
        *v /= s;
    }
    phi
}

fn gaussian_axis(input: &Array3<f64>, ax: usize, w: &[f64], radius: isize, store_f32: bool) -> Array3<f64> {
    let mut out = input.clone();
    let axis = Axis(ax);
    for (in_lane, mut out_lane) in input.lanes(axis).into_iter().zip(out.lanes_mut(axis)) {
        let n = in_lane.len() as isize;
        for i in 0..n {
            let mut acc = 0.0f64;
            for k in -radius..=radius {
                let p = reflect_index(i + k, n);
                acc += w[(k + radius) as usize] * in_lane[p];
            }
            out_lane[i as usize] = if store_f32 { acc as f32 as f64 } else { acc };
        }
    }
    out
}

/// Separable Gaussian filter (`truncate=4.0`, `mode='reflect'`) applied along
/// axes 0,1,2 in order. `store_f32` rounds each axis pass to f32 (matching
/// SciPy on a float32 array, which accumulates in double but stores f32).
pub fn gaussian_filter3(input: &Array3<f64>, sigma: f64, store_f32: bool) -> Array3<f64> {
    let radius = (4.0 * sigma + 0.5) as isize; // int(truncate*sigma + 0.5)
    let w = gaussian_kernel1d(sigma, radius);
    let mut cur = input.clone();
    for ax in 0..3 {
        cur = gaussian_axis(&cur, ax, &w, radius, store_f32);
    }
    cur
}

// ---------------------------------------------------------------------------
// Binary morphology (6-connectivity structure = generate_binary_structure(3,1))
// ---------------------------------------------------------------------------
const NEIGH6: [(isize, isize, isize); 6] = [
    (-1, 0, 0), (1, 0, 0), (0, -1, 0), (0, 1, 0), (0, 0, -1), (0, 0, 1),
];

fn dilate6(m: &Array3<bool>) -> Array3<bool> {
    let (nx, ny, nz) = m.dim();
    let mut out = Array3::from_elem((nx, ny, nz), false);
    for i in 0..nx {
        for j in 0..ny {
            for k in 0..nz {
                let mut v = m[[i, j, k]];
                if !v {
                    for &(di, dj, dk) in NEIGH6.iter() {
                        let (ii, jj, kk) = (i as isize + di, j as isize + dj, k as isize + dk);
                        if ii >= 0 && ii < nx as isize && jj >= 0 && jj < ny as isize && kk >= 0 && kk < nz as isize
                            && m[[ii as usize, jj as usize, kk as usize]]
                        {
                            v = true;
                            break;
                        }
                    }
                }
                out[[i, j, k]] = v;
            }
        }
    }
    out
}

fn erode6(m: &Array3<bool>) -> Array3<bool> {
    // border_value = 0 -> out-of-bounds counts as false (erodes the volume edge)
    let (nx, ny, nz) = m.dim();
    let mut out = Array3::from_elem((nx, ny, nz), false);
    for i in 0..nx {
        for j in 0..ny {
            for k in 0..nz {
                if !m[[i, j, k]] {
                    continue;
                }
                let mut all = true;
                for &(di, dj, dk) in NEIGH6.iter() {
                    let (ii, jj, kk) = (i as isize + di, j as isize + dj, k as isize + dk);
                    let inside = ii >= 0 && ii < nx as isize && jj >= 0 && jj < ny as isize && kk >= 0 && kk < nz as isize;
                    if !inside || !m[[ii as usize, jj as usize, kk as usize]] {
                        all = false;
                        break;
                    }
                }
                out[[i, j, k]] = all;
            }
        }
    }
    out
}

/// `scipy.ndimage.binary_closing(m, iterations)` = dilate x iterations then
/// erode x iterations (default 6-connectivity, border_value 0).
pub fn binary_closing(m: &Array3<bool>, iterations: usize) -> Array3<bool> {
    let mut d = m.clone();
    for _ in 0..iterations {
        d = dilate6(&d);
    }
    for _ in 0..iterations {
        d = erode6(&d);
    }
    d
}

/// `scipy.ndimage.binary_fill_holes` — background not connected to the border
/// (via 6-connectivity) is filled. Flood-fills background from the volume edge.
pub fn binary_fill_holes(m: &Array3<bool>) -> Array3<bool> {
    let (nx, ny, nz) = m.dim();
    let mut reachable = Array3::from_elem((nx, ny, nz), false);
    let mut stack: Vec<(usize, usize, usize)> = Vec::new();
    // seed: all background voxels on the volume border
    for i in 0..nx {
        for j in 0..ny {
            for k in 0..nz {
                let border = i == 0 || i == nx - 1 || j == 0 || j == ny - 1 || k == 0 || k == nz - 1;
                if border && !m[[i, j, k]] && !reachable[[i, j, k]] {
                    reachable[[i, j, k]] = true;
                    stack.push((i, j, k));
                }
            }
        }
    }
    while let Some((i, j, k)) = stack.pop() {
        for &(di, dj, dk) in NEIGH6.iter() {
            let (ii, jj, kk) = (i as isize + di, j as isize + dj, k as isize + dk);
            if ii >= 0 && ii < nx as isize && jj >= 0 && jj < ny as isize && kk >= 0 && kk < nz as isize {
                let (a, b, c) = (ii as usize, jj as usize, kk as usize);
                if !m[[a, b, c]] && !reachable[[a, b, c]] {
                    reachable[[a, b, c]] = true;
                    stack.push((a, b, c));
                }
            }
        }
    }
    // fill background that is NOT reachable from the border
    let mut out = m.clone();
    for i in 0..nx {
        for j in 0..ny {
            for k in 0..nz {
                if !m[[i, j, k]] && !reachable[[i, j, k]] {
                    out[[i, j, k]] = true;
                }
            }
        }
    }
    out
}
