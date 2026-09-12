use std::str::FromStr;

use crate::par::for_each_z;
use crate::{Error, Grid, Mat4, NiftiImage, Result, VectorField};

#[derive(Clone, Debug)]
pub enum Transform {
    Affine(Mat4),
    Warp(VectorField),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interpolation {
    Linear,
    Nearest,
}

pub fn read_matrix(text: &str) -> Result<Mat4> {
    let values = text
        .split_whitespace()
        .map(f64::from_str)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| Error("transform matrix must contain finite decimal values".into()))?;
    if values.len() != 16 || values.iter().any(|x| !x.is_finite()) {
        return Err(Error(
            "transform matrix must contain exactly 16 finite values".into(),
        ));
    }
    let mut matrix = [[0.0; 4]; 4];
    for r in 0..4 {
        matrix[r].copy_from_slice(&values[r * 4..r * 4 + 4]);
    }
    if matrix[3]
        .iter()
        .zip([0.0, 0.0, 0.0, 1.0])
        .any(|(a, b)| (a - b).abs() > 1e-6)
    {
        return Err(Error(
            "transform matrix must be affine (last row 0 0 0 1)".into(),
        ));
    }
    Ok(Mat4(matrix))
}

/// Compares effective LPS geometry rather than raw qform/sform header fields.
pub fn grids_match(left: &Grid, right: &Grid, tolerance_mm: f64) -> bool {
    left.dims == right.dims
        && left
            .lps_from_voxel
            .0
            .iter()
            .flatten()
            .zip(right.lps_from_voxel.0.iter().flatten())
            .all(|(a, b)| (a - b).abs() <= tolerance_mm)
}

fn index(grid: &Grid, x: usize, y: usize, z: usize) -> usize {
    x + grid.dims[0] * (y + grid.dims[1] * z)
}

pub(crate) fn trilinear_scalar(image: &NiftiImage, voxel: [f64; 3]) -> f32 {
    trilinear_scalar_gradient(image, voxel).0
}

fn nearest_scalar(image: &NiftiImage, voxel: [f64; 3], background: f32) -> f32 {
    let voxel = voxel.map(|value| value.round() as isize);
    if voxel
        .iter()
        .zip(image.grid.dims)
        .any(|(&value, dimension)| value < 0 || value as usize >= dimension)
    {
        return background;
    }
    image.data[index(
        &image.grid,
        voxel[0] as usize,
        voxel[1] as usize,
        voxel[2] as usize,
    )]
}

/// Trilinear sample and its derivative with respect to voxel coordinates.
/// Missing border corners have value zero, matching `trilinear_scalar`.
pub(crate) fn trilinear_scalar_gradient(image: &NiftiImage, voxel: [f64; 3]) -> (f32, [f64; 3]) {
    trilinear_scalar_gradient_with_background(image, voxel, 0.0)
}

fn trilinear_scalar_gradient_with_background(
    image: &NiftiImage,
    voxel: [f64; 3],
    background: f32,
) -> (f32, [f64; 3]) {
    let base = voxel.map(f64::floor);
    let fraction = [voxel[0] - base[0], voxel[1] - base[1], voxel[2] - base[2]];
    let base = base.map(|x| x as isize);
    let mut total = background as f64;
    let mut gradient = [0.0; 3];
    for dz in 0..2 {
        for dy in 0..2 {
            for dx in 0..2 {
                let x = base[0] + dx;
                let y = base[1] + dy;
                let z = base[2] + dz;
                if x >= 0
                    && y >= 0
                    && z >= 0
                    && (x as usize) < image.grid.dims[0]
                    && (y as usize) < image.grid.dims[1]
                    && (z as usize) < image.grid.dims[2]
                {
                    let wx = if dx == 0 {
                        1.0 - fraction[0]
                    } else {
                        fraction[0]
                    };
                    let wy = if dy == 0 {
                        1.0 - fraction[1]
                    } else {
                        fraction[1]
                    };
                    let wz = if dz == 0 {
                        1.0 - fraction[2]
                    } else {
                        fraction[2]
                    };
                    let value = image.data[index(&image.grid, x as usize, y as usize, z as usize)]
                        as f64
                        - background as f64;
                    total += value * wx * wy * wz;
                    gradient[0] += value * if dx == 0 { -1.0 } else { 1.0 } * wy * wz;
                    gradient[1] += value * wx * if dy == 0 { -1.0 } else { 1.0 } * wz;
                    gradient[2] += value * wx * wy * if dz == 0 { -1.0 } else { 1.0 };
                }
            }
        }
    }
    (total as f32, gradient)
}

fn trilinear_vector(field: &VectorField, voxel: [f64; 3]) -> [f64; 3] {
    let base = voxel.map(f64::floor);
    let fraction = [voxel[0] - base[0], voxel[1] - base[1], voxel[2] - base[2]];
    let base = base.map(|x| x as isize);
    let mut total = [0.0; 3];
    for dz in 0..2 {
        for dy in 0..2 {
            for dx in 0..2 {
                let x = base[0] + dx;
                let y = base[1] + dy;
                let z = base[2] + dz;
                if x < -1
                    || y < -1
                    || z < -1
                    || x > field.grid.dims[0] as isize
                    || y > field.grid.dims[1] as isize
                    || z > field.grid.dims[2] as isize
                {
                    continue;
                }
                let wx = if dx == 0 {
                    1.0 - fraction[0]
                } else {
                    fraction[0]
                };
                let wy = if dy == 0 {
                    1.0 - fraction[1]
                } else {
                    fraction[1]
                };
                let wz = if dz == 0 {
                    1.0 - fraction[2]
                } else {
                    fraction[2]
                };
                if x >= 0
                    && y >= 0
                    && z >= 0
                    && (x as usize) < field.grid.dims[0]
                    && (y as usize) < field.grid.dims[1]
                    && (z as usize) < field.grid.dims[2]
                {
                    for (c, total) in total.iter_mut().enumerate() {
                        *total += field.data[index(&field.grid, x as usize, y as usize, z as usize)]
                            [c] as f64
                            * wx
                            * wy
                            * wz;
                    }
                }
            }
        }
    }
    total
}

/// A transform-chain step with its voxel lookup precomputed.
enum Step<'a> {
    Affine(Mat4),
    Warp(&'a VectorField, Mat4),
}

fn steps(chain: &[Transform]) -> Result<Vec<Step<'_>>> {
    chain
        .iter()
        .map(|transform| {
            Ok(match transform {
                Transform::Affine(matrix) => Step::Affine(*matrix),
                Transform::Warp(field) => Step::Warp(field, field.grid.lps_from_voxel.inverse()?),
            })
        })
        .collect()
}

fn apply_chain(mut point: [f64; 3], chain: &[Step<'_>]) -> [f64; 3] {
    for step in chain {
        point = match step {
            Step::Affine(matrix) => Grid::lps_from_ras(matrix.apply(Grid::ras_from_lps(point))),
            Step::Warp(field, voxel_from_lps) => {
                let vector = trilinear_vector(field, voxel_from_lps.apply(point));
                std::array::from_fn(|axis| point[axis] + vector[axis])
            }
        };
    }
    point
}

/// `chain` is supplied in greedy CLI order: `-r warp.nii.gz aff.mat`.
pub fn reslice(
    fixed_grid: &Grid,
    moving: &NiftiImage,
    chain: &[Transform],
    expected_moving_grid: Option<&Grid>,
) -> Result<NiftiImage> {
    reslice_with_interpolation(
        fixed_grid,
        moving,
        chain,
        expected_moving_grid,
        Interpolation::Linear,
    )
}

pub fn reslice_with_interpolation(
    fixed_grid: &Grid,
    moving: &NiftiImage,
    chain: &[Transform],
    expected_moving_grid: Option<&Grid>,
    interpolation: Interpolation,
) -> Result<NiftiImage> {
    reslice_with_background(
        fixed_grid,
        moving,
        chain,
        expected_moving_grid,
        interpolation,
        0.0,
    )
}

pub fn reslice_with_background(
    fixed_grid: &Grid,
    moving: &NiftiImage,
    chain: &[Transform],
    expected_moving_grid: Option<&Grid>,
    interpolation: Interpolation,
    background: f32,
) -> Result<NiftiImage> {
    if !background.is_finite() {
        return Err(Error("reslice background must be finite".into()));
    }
    if let Some(expected) = expected_moving_grid {
        if !grids_match(&moving.grid, expected, 1e-4) {
            return Err(Error("--verify-aligned failed: moving image grid differs from the registration source grid".into()));
        }
    }
    if chain.is_empty() {
        return Err(Error(
            "reslice requires at least one transform after -r".into(),
        ));
    }
    let chain = steps(chain)?;
    let moving_from_lps = moving.grid.lps_from_voxel.inverse()?;
    let per_slab = fixed_grid.dims[0] * fixed_grid.dims[1];
    let mut data = vec![background; fixed_grid.dims.iter().product()];
    for_each_z(&mut data, fixed_grid.dims[2], |z, slab| {
        for (offset, out) in slab.iter_mut().enumerate() {
            let fixed_lps = fixed_grid.voxel_to_lps(fixed_grid.voxel(z * per_slab + offset));
            let voxel = moving_from_lps.apply(apply_chain(fixed_lps, &chain));
            *out = match interpolation {
                Interpolation::Linear => {
                    trilinear_scalar_gradient_with_background(moving, voxel, background).0
                }
                Interpolation::Nearest => nearest_scalar(moving, voxel, background),
            };
        }
    });
    Ok(NiftiImage {
        grid: fixed_grid.clone(),
        data,
        scalar_type: moving.scalar_type,
    })
}
