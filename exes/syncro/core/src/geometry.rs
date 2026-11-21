//! Grid comparisons and de-shearing. A port of packages/syncro/src/pipeline.js (55199029d): f64 geometry, f32
//! voxels, the same tolerances, so both hosts accept the same inputs and resample them identically.

use crate::volume::{Affine, Volume};
use neurodesk_nifti::affine::inverse3;

/// The output grid of a resampling: dims and a 3×4 affine.
#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    pub dims: [usize; 3],
    pub affine: Affine,
}

pub fn same_geometry<T, U>(a: &Volume<T>, b: &Volume<U>) -> bool {
    a.dims == b.dims
        && (0..3).all(|r| (0..4).all(|c| (a.affine[r][c] - b.affine[r][c]).abs() <= 0.01))
}

/// A lesion map may be one voxel larger or smaller per axis (a border) on the same frame.
pub fn compatible_mask_geometry<T, U>(reference: &Volume<T>, mask: &Volume<U>) -> bool {
    if (0..3).any(|a| reference.dims[a].abs_diff(mask.dims[a]) > 1) {
        return false;
    }
    for r in 0..3 {
        if (0..3).any(|c| (reference.affine[r][c] - mask.affine[r][c]).abs() > 0.01) {
            return false;
        }
        let row = |m: &Affine| m[r][..3].iter().map(|v| v.abs()).sum::<f64>();
        let tolerance = row(&reference.affine).max(row(&mask.affine)) + 0.01;
        if (reference.affine[r][3] - mask.affine[r][3]).abs() > tolerance {
            return false;
        }
    }
    true
}

fn spacing(affine: &Affine) -> [f64; 3] {
    [0, 1, 2].map(|a| {
        (0..3)
            .map(|r| affine[r][a] * affine[r][a])
            .sum::<f64>()
            .sqrt()
    })
}

/// Greedy's test: the row Gram matrix of the column-normalised sform departs from identity by more than 1e-4.
pub fn has_shear(affine: &Affine) -> bool {
    let s = spacing(affine);
    (0..3).any(|r| {
        (0..3).any(|t| {
            let dot: f64 = (0..3)
                .map(|a| (affine[r][a] / s[a]) * (affine[t][a] / s[a]))
                .sum();
            (dot - f64::from(u8::from(r == t))).abs() > 1e-4
        })
    })
}

const PERMUTATIONS: [([usize; 3], f64); 6] = [
    ([0, 1, 2], 1.0),
    ([0, 2, 1], -1.0),
    ([1, 0, 2], -1.0),
    ([1, 2, 0], 1.0),
    ([2, 0, 1], 1.0),
    ([2, 1, 0], -1.0),
];

/// The orthogonal grid of the same spacing and handedness that covers a sheared scan's voxels; `None` when the
/// affine is already orthonormal.
pub fn orthogonal_grid(dims: [usize; 3], affine: &Affine) -> Result<Option<Grid>, String> {
    let s = spacing(affine);
    if !has_shear(affine) {
        return Ok(None);
    }
    let unit = |r: usize, a: usize| affine[r][a] / s[a];
    let candidates: Vec<([usize; 3], f64, f64)> = PERMUTATIONS
        .iter()
        .map(|&(axes, parity)| {
            let term = (0..3).fold(parity, |t, a| t * unit(axes[a], a));
            let score: f64 = (0..3).map(|a| unit(axes[a], a).abs()).sum();
            (axes, term, score)
        })
        .collect();
    let direction = candidates.iter().map(|c| c.1).sum::<f64>().signum();
    // JS: filter, then a stable sort by descending score, so the first of equal scores wins.
    let mut best: Option<&([usize; 3], f64, f64)> = None;
    for c in candidates.iter().filter(|c| c.1 * direction > 0.0) {
        if best.is_none_or(|b| c.2 > b.2) {
            best = Some(c);
        }
    }
    let axes = best.ok_or("The image affine is singular.")?.0;
    let steps = [0, 1, 2].map(|a| affine[axes[a]][a].signum() * s[a]);
    let mut grid = [[0.0; 4]; 3];
    let mut shape = [0usize; 3];
    for a in 0..3 {
        let r = axes[a];
        let projected = [0, 1, 2].map(|k| affine[r][k] / steps[a]);
        let ends = [0, 1, 2].map(|k| projected[k] * (dims[k] as f64 - 1.0));
        let low: f64 = ends.iter().map(|e| e.min(0.0)).sum();
        let high: f64 = ends.iter().map(|e| e.max(0.0)).sum();
        let half_voxel: f64 = projected.iter().map(|p| p.abs() / 2.0).sum();
        let padding = (half_voxel - 0.5).max(0.0);
        grid[r][a] = steps[a];
        grid[r][3] = affine[r][3] + (low - padding) * steps[a];
        let size = ((high - low + 2.0 * padding - 1e-6).ceil() + 1.0).max(2.0);
        if size.is_nan() || size > 32767.0 {
            return Err(TOO_LARGE.into());
        }
        shape[a] = size as usize;
    }
    if shape.iter().product::<usize>() > 128 * 1024 * 1024 {
        return Err(TOO_LARGE.into());
    }
    Ok(Some(Grid {
        dims: shape,
        affine: grid,
    }))
}

const TOO_LARGE: &str =
    "The orthogonal output grid is too large. Crop excess background before normalization.";

/// The source voxel coordinates of each output voxel: `inverse(source) · grid`, rows of [i, j, k, 1] coefficients.
fn voxel_map(source: &Affine, grid: &Grid) -> Result<[[f64; 4]; 3], String> {
    let inverse = inverse3(source)?;
    let offset = [0, 1, 2].map(|r| grid.affine[r][3] - source[r][3]);
    Ok([0, 1, 2].map(|r| {
        [0, 1, 2, 3].map(|c| {
            (0..3)
                .map(|k| inverse[r][k] * if c < 3 { grid.affine[k][c] } else { offset[k] })
                .sum()
        })
    }))
}

/// Trilinear resampling onto `grid` (same world space). Voxels whose centre lies more than half a voxel outside
/// the source get `fill`; the outer half of each boundary voxel belongs to the image.
pub fn resample_linear(v: &Volume<f32>, grid: &Grid, fill: f32) -> Result<Volume<f32>, String> {
    let map = voxel_map(&v.affine, grid)?;
    let d = v.dims;
    let limit = d.map(|n| n as f64 - 0.5);
    let at = |x: usize, y: usize, z: usize| v.data[x + d[0] * (y + d[1] * z)];
    let [nx, ny, nz] = grid.dims;
    let mut out = Vec::with_capacity(nx * ny * nz);
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                let (i, j, k) = (i as f64, j as f64, k as f64);
                let x = map[0][0] * i + map[0][1] * j + map[0][2] * k + map[0][3];
                let y = map[1][0] * i + map[1][1] * j + map[1][2] * k + map[1][3];
                let z = map[2][0] * i + map[2][1] * j + map[2][2] * k + map[2][3];
                if x < -0.5 || y < -0.5 || z < -0.5 || x > limit[0] || y > limit[1] || z > limit[2]
                {
                    out.push(fill);
                    continue;
                }
                let x = x.clamp(0.0, d[0] as f64 - 1.0);
                let y = y.clamp(0.0, d[1] as f64 - 1.0);
                let z = z.clamp(0.0, d[2] as f64 - 1.0);
                let (x0, y0, z0) = (x.floor() as usize, y.floor() as usize, z.floor() as usize);
                let (x1, y1, z1) = (
                    (x0 + 1).min(d[0] - 1),
                    (y0 + 1).min(d[1] - 1),
                    (z0 + 1).min(d[2] - 1),
                );
                let (tx, ty, tz) = (x - x0 as f64, y - y0 as f64, z - z0 as f64);
                let a = |x, y, z| at(x, y, z) as f64;
                let front = (a(x0, y0, z0) * (1.0 - tx) + a(x1, y0, z0) * tx) * (1.0 - ty)
                    + (a(x0, y1, z0) * (1.0 - tx) + a(x1, y1, z0) * tx) * ty;
                let back = (a(x0, y0, z1) * (1.0 - tx) + a(x1, y0, z1) * tx) * (1.0 - ty)
                    + (a(x0, y1, z1) * (1.0 - tx) + a(x1, y1, z1) * tx) * ty;
                out.push((front * (1.0 - tz) + back * tz) as f32);
            }
        }
    }
    Ok(Volume {
        data: out,
        dims: grid.dims,
        affine: grid.affine,
    })
}

/// Nearest-neighbour resampling of a binary map onto `grid`; outside voxels are 0.
pub fn resample_nearest(v: &Volume<u8>, grid: &Grid) -> Result<Volume<u8>, String> {
    let map = voxel_map(&v.affine, grid)?;
    let d = v.dims;
    let limit = d.map(|n| n as f64 - 0.5);
    let [nx, ny, nz] = grid.dims;
    let mut out = Vec::with_capacity(nx * ny * nz);
    // JS Math.round: halves round up.
    let round = |t: f64| (t + 0.5).floor() as usize;
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                let (i, j, k) = (i as f64, j as f64, k as f64);
                let x = map[0][0] * i + map[0][1] * j + map[0][2] * k + map[0][3];
                let y = map[1][0] * i + map[1][1] * j + map[1][2] * k + map[1][3];
                let z = map[2][0] * i + map[2][1] * j + map[2][2] * k + map[2][3];
                if x < -0.5 || y < -0.5 || z < -0.5 || x > limit[0] || y > limit[1] || z > limit[2]
                {
                    out.push(0);
                    continue;
                }
                let x = round(x.clamp(0.0, d[0] as f64 - 1.0));
                let y = round(y.clamp(0.0, d[1] as f64 - 1.0));
                let z = round(z.clamp(0.0, d[2] as f64 - 1.0));
                out.push(v.data[x + d[0] * (y + d[1] * z)]);
            }
        }
    }
    Ok(Volume {
        data: out,
        dims: grid.dims,
        affine: grid.affine,
    })
}
