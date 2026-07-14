//! Affine resampling — port of the Python `resample_to`
//! (`scipy.ndimage.map_coordinates`, order=1, mode='constant').
//!
//! Matches Python's dtype path: the affine `inv(src)@tgt` and the sampling
//! coordinates are computed in f32, source values interpolated in f64.

use ndarray::Array3;

pub type Affine = [[f64; 4]; 4];

fn inv3(r: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
        - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
        + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    let id = 1.0 / det;
    [
        [
            (r[1][1] * r[2][2] - r[1][2] * r[2][1]) * id,
            (r[0][2] * r[2][1] - r[0][1] * r[2][2]) * id,
            (r[0][1] * r[1][2] - r[0][2] * r[1][1]) * id,
        ],
        [
            (r[1][2] * r[2][0] - r[1][0] * r[2][2]) * id,
            (r[0][0] * r[2][2] - r[0][2] * r[2][0]) * id,
            (r[0][2] * r[1][0] - r[0][0] * r[1][2]) * id,
        ],
        [
            (r[1][0] * r[2][1] - r[1][1] * r[2][0]) * id,
            (r[0][1] * r[2][0] - r[0][0] * r[2][1]) * id,
            (r[0][0] * r[1][1] - r[0][1] * r[1][0]) * id,
        ],
    ]
}

/// Inverse of an affine (bottom row [0,0,0,1]).
fn inv_affine(a: &Affine) -> Affine {
    let r = [
        [a[0][0], a[0][1], a[0][2]],
        [a[1][0], a[1][1], a[1][2]],
        [a[2][0], a[2][1], a[2][2]],
    ];
    let ri = inv3(r);
    let t = [a[0][3], a[1][3], a[2][3]];
    let ti = [
        -(ri[0][0] * t[0] + ri[0][1] * t[1] + ri[0][2] * t[2]),
        -(ri[1][0] * t[0] + ri[1][1] * t[1] + ri[1][2] * t[2]),
        -(ri[2][0] * t[0] + ri[2][1] * t[1] + ri[2][2] * t[2]),
    ];
    [
        [ri[0][0], ri[0][1], ri[0][2], ti[0]],
        [ri[1][0], ri[1][1], ri[1][2], ti[1]],
        [ri[2][0], ri[2][1], ri[2][2], ti[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

fn matmul4(a: &Affine, b: &Affine) -> Affine {
    let mut o = [[0.0f64; 4]; 4];
    for r in 0..4 {
        for c in 0..4 {
            let mut s = 0.0;
            for k in 0..4 {
                s += a[r][k] * b[k][c];
            }
            o[r][c] = s;
        }
    }
    o
}

/// Trilinear sample of `src` at (x,y,z) with out-of-bounds = `cval`.
/// Zero-weight corners are skipped so an exact-edge coordinate is not
/// NaN-poisoned, matching `map_coordinates(order=1, mode='constant')`.
fn sample_trilinear(src: &Array3<f32>, x: f64, y: f64, z: f64, cval: f64) -> f64 {
    let (nx, ny, nz) = src.dim();
    let x0 = x.floor();
    let y0 = y.floor();
    let z0 = z.floor();
    let wx = x - x0;
    let wy = y - y0;
    let wz = z - z0;
    let (ix, iy, iz) = (x0 as isize, y0 as isize, z0 as isize);
    let mut acc = 0.0f64;
    for (dx, cx) in [(0isize, 1.0 - wx), (1, wx)] {
        if cx == 0.0 {
            continue;
        }
        for (dy, cy) in [(0isize, 1.0 - wy), (1, wy)] {
            if cy == 0.0 {
                continue;
            }
            for (dz, cz) in [(0isize, 1.0 - wz), (1, wz)] {
                if cz == 0.0 {
                    continue;
                }
                let w = cx * cy * cz;
                let (px, py, pz) = (ix + dx, iy + dy, iz + dz);
                let v = if px >= 0 && px < nx as isize && py >= 0 && py < ny as isize && pz >= 0 && pz < nz as isize {
                    src[[px as usize, py as usize, pz as usize]] as f64
                } else {
                    cval
                };
                acc += w * v;
            }
        }
    }
    acc
}

/// Resample `src` (with `src_aff`) into the grid `(tgt_shape, tgt_aff)`.
pub fn resample_to(
    src: &Array3<f32>,
    src_aff: &Affine,
    tgt_shape: (usize, usize, usize),
    tgt_aff: &Affine,
    cval: f64,
) -> Array3<f32> {
    // A = inv(src_aff) @ tgt_aff, then cast to f32 (matches numpy)
    let a64 = matmul4(&inv_affine(src_aff), tgt_aff);
    let mut a = [[0.0f32; 4]; 4];
    for r in 0..4 {
        for c in 0..4 {
            a[r][c] = a64[r][c] as f32;
        }
    }
    let (tx, ty, tz) = tgt_shape;
    let mut out = Array3::from_elem((tx, ty, tz), 0.0f32);
    for i in 0..tx {
        let fi = i as f32;
        for j in 0..ty {
            let fj = j as f32;
            for k in 0..tz {
                let fk = k as f32;
                // f32 coordinate arithmetic (as in the numpy version)
                let x = a[0][0] * fi + a[0][1] * fj + a[0][2] * fk + a[0][3];
                let y = a[1][0] * fi + a[1][1] * fj + a[1][2] * fk + a[1][3];
                let z = a[2][0] * fi + a[2][1] * fj + a[2][2] * fk + a[2][3];
                out[[i, j, k]] = sample_trilinear(src, x as f64, y as f64, z as f64, cval) as f32;
            }
        }
    }
    out
}
