//! Greedy's `-m NCC rxryrz` for deformable registration
//! (`MultiComponentWeightedNCCImageMetric`, unweighted): the signed squared
//! correlation `cov * |cov| / (var_f * var_m)` over a box window, summed over
//! the fixed voxels, and its exact gradient from a second box pass.
use crate::{Error, NiftiImage, Result, VectorField, grids_match};

/// Greedy's regulariser of both variances (`eps` in the weighted NCC metric).
const EPS: f64 = 1.0e-2;

/// Greedy's `AdjustNCCRadius`: a window never spans the whole image.
pub(crate) fn adjust_radius(radius: [usize; 3], dims: [usize; 3]) -> [usize; 3] {
    std::array::from_fn(|axis| {
        if radius[axis] * 2 + 1 >= dims[axis] {
            (dims[axis] - 1) / 2
        } else {
            radius[axis]
        }
    })
}

/// In place: each value becomes the sum of the values within `radius` along
/// `axis`, the window cut off at the image edge (Greedy's
/// `OneDimensionalInPlaceAccumulateFilter`).
fn box_axis(data: &mut [f32], dims: [usize; 3], axis: usize, radius: usize, line: &mut Vec<f64>) {
    if radius == 0 {
        return;
    }
    let stride = [1, dims[0], dims[0] * dims[1]][axis];
    let length = dims[axis];
    let (outer_a, outer_b) = match axis {
        0 => (dims[1], dims[2]),
        1 => (dims[0], dims[2]),
        _ => (dims[0], dims[1]),
    };
    for b in 0..outer_b {
        for a in 0..outer_a {
            let start = match axis {
                0 => dims[0] * (a + dims[1] * b),
                1 => a + dims[0] * dims[1] * b,
                _ => a + dims[0] * b,
            };
            line.clear();
            line.extend((0..length).map(|i| data[start + i * stride] as f64));
            let mut sum: f64 = line[..radius.min(length)].iter().sum();
            for i in 0..length {
                if i + radius < length {
                    sum += line[i + radius];
                }
                if i > radius {
                    sum -= line[i - radius - 1];
                }
                data[start + i * stride] = sum as f32;
            }
        }
    }
}

fn box_sum(data: &mut [f32], dims: [usize; 3], radius: [usize; 3]) {
    let mut line = Vec::new();
    for (axis, &radius) in radius.iter().enumerate() {
        box_axis(data, dims, axis, radius, &mut line);
    }
}

/// Trilinear value and gradient (per voxel step) of `image` at a voxel
/// position; corners outside the image count as zero.
fn sample_with_gradient(image: &NiftiImage, voxel: [f64; 3]) -> (f64, [f64; 3]) {
    let dims = image.grid.dims;
    let base = voxel.map(f64::floor);
    let fraction = [voxel[0] - base[0], voxel[1] - base[1], voxel[2] - base[2]];
    let base = base.map(|x| x as isize);
    let mut value = 0.0;
    let mut gradient = [0.0; 3];
    for dz in 0..2_usize {
        for dy in 0..2_usize {
            for dx in 0..2_usize {
                let corner = [
                    base[0] + dx as isize,
                    base[1] + dy as isize,
                    base[2] + dz as isize,
                ];
                if (0..3).any(|axis| corner[axis] < 0 || corner[axis] >= dims[axis] as isize) {
                    continue;
                }
                let sample = image.data[corner[0] as usize
                    + dims[0] * (corner[1] as usize + dims[1] * corner[2] as usize)]
                    as f64;
                let offset = [dx, dy, dz];
                let weight = |axis: usize| {
                    if offset[axis] == 1 {
                        fraction[axis]
                    } else {
                        1.0 - fraction[axis]
                    }
                };
                let slope = |axis: usize| if offset[axis] == 1 { 1.0 } else { -1.0 };
                value += sample * weight(0) * weight(1) * weight(2);
                gradient[0] += sample * slope(0) * weight(1) * weight(2);
                gradient[1] += sample * weight(0) * slope(1) * weight(2);
                gradient[2] += sample * weight(0) * weight(1) * slope(2);
            }
        }
    }
    (value, gradient)
}

/// The NCC metric summed over the fixed voxels inside `mask` (all when
/// `None`), and its gradient with respect to the voxel displacement of every
/// fixed voxel. `moving` is already on the fixed grid.
pub(crate) fn ncc_gradient(
    fixed: &NiftiImage,
    moving: &NiftiImage,
    mask: Option<&[bool]>,
    radius: [usize; 3],
    displacement: &VectorField,
) -> Result<(f64, VectorField)> {
    if !grids_match(&fixed.grid, &displacement.grid, 1e-4)
        || !grids_match(&fixed.grid, &moving.grid, 1e-4)
    {
        return Err(Error(
            "NCC needs the moving image and the deformation on the fixed grid".into(),
        ));
    }
    let dims = fixed.grid.dims;
    let radius = adjust_radius(radius, dims);
    let patch = radius.iter().map(|&r| (2 * r + 1) as f64).product::<f64>();
    let count = fixed.data.len();
    let mut warped = Vec::with_capacity(count);
    let mut moving_gradient = Vec::with_capacity(count);
    for index in 0..count {
        let voxel = fixed.grid.voxel(index);
        let shift = displacement.data[index];
        let (value, gradient) = sample_with_gradient(
            moving,
            std::array::from_fn(|axis| voxel[axis] + shift[axis] as f64),
        );
        warped.push(value);
        moving_gradient.push(gradient);
    }
    // First pass: the window sums of f, m, f², m² and fm.
    let mut sums: [Vec<f32>; 5] = Default::default();
    for (index, (&f, &m)) in fixed.data.iter().zip(&warped).enumerate() {
        let f = f as f64;
        let products = [f, m, f * f, m * m, f * m];
        for (sum, product) in sums.iter_mut().zip(products) {
            if index == 0 {
                sum.reserve(count);
            }
            sum.push(product as f32);
        }
    }
    for sum in &mut sums {
        box_sum(sum, dims, radius);
    }
    // Per voxel: the metric, and the three terms the second pass sums.
    let mut metric = 0.0;
    let mut terms: [Vec<f32>; 3] = [vec![0.0; count], vec![0.0; count], vec![0.0; count]];
    for index in 0..count {
        if mask.is_some_and(|mask| !mask[index]) {
            continue;
        }
        let [sum_f, sum_m, sum_ff, sum_mm, sum_fm] = sums.each_ref().map(|s| s[index] as f64);
        let var_f = patch * sum_ff - sum_f * sum_f + EPS;
        let var_m = patch * sum_mm - sum_m * sum_m + EPS;
        let cov = patch * sum_fm - sum_f * sum_m;
        let one_over_denominator = 1.0 / (var_f * var_m);
        let ncc = cov.abs() * cov * one_over_denominator;
        metric += ncc;
        let q_fm = cov.abs() * one_over_denominator;
        let q_m = ncc / var_m;
        terms[0][index] = (patch * q_fm) as f32;
        terms[1][index] = (patch * q_m) as f32;
        terms[2][index] = (sum_m * q_m - sum_f * q_fm) as f32;
    }
    drop(sums);
    for term in &mut terms {
        box_sum(term, dims, radius);
    }
    let data = (0..count)
        .map(|index| {
            let f = fixed.data[index] as f64;
            let m = warped[index];
            let derivative = 2.0
                * (terms[0][index] as f64 * f - terms[1][index] as f64 * m
                    + terms[2][index] as f64);
            moving_gradient[index].map(|g| (g * derivative) as f32)
        })
        .collect();
    Ok((
        metric,
        VectorField {
            grid: fixed.grid.clone(),
            data,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Grid, Mat4, ScalarType};

    fn image(dims: [usize; 3], value: impl Fn([f64; 3]) -> f64) -> NiftiImage {
        let grid = Grid {
            dims,
            lps_from_voxel: Mat4::IDENTITY,
        };
        let data = (0..dims.iter().product())
            .map(|index| value(grid.voxel(index)) as f32)
            .collect();
        NiftiImage {
            grid,
            data,
            scalar_type: ScalarType::F32,
        }
    }

    #[test]
    fn box_sums_cut_the_window_at_the_edge() {
        let mut data = vec![1.0_f32; 5];
        box_sum(&mut data, [5, 1, 1], [1, 0, 0]);
        assert_eq!(data, [2.0, 3.0, 3.0, 3.0, 2.0]);
    }

    #[test]
    fn identical_images_correlate_perfectly_in_every_window() {
        let dims = [12, 11, 10];
        let fixed = image(dims, |[x, y, z]| {
            (0.3 * x).sin() + 0.2 * y * y - (0.4 * z).cos()
        });
        let zero = VectorField {
            grid: fixed.grid.clone(),
            data: vec![[0.0; 3]; fixed.data.len()],
        };
        let (metric, _) = ncc_gradient(&fixed, &fixed, None, [2, 2, 2], &zero).unwrap();
        // Each window's NCC is 1 up to the variance regulariser.
        let voxels = fixed.data.len() as f64;
        assert!((metric / voxels - 1.0).abs() < 1e-3, "{}", metric / voxels);
    }

    #[test]
    fn the_gradient_is_the_derivative_of_the_metric() {
        let dims = [10, 9, 8];
        let fixed = image(dims, |[x, y, z]| {
            (0.5 * x).sin() + 0.3 * (0.7 * y).cos() + 0.1 * z
        });
        let moving = image(dims, |[x, y, z]| {
            (0.5 * x + 0.4).sin() + 0.25 * (0.6 * y).cos() + 0.15 * z + 0.05 * x * y
        });
        let mask: Vec<bool> = (0..fixed.data.len()).map(|i| i % 7 != 0).collect();
        let field = |data: Vec<[f32; 3]>| VectorField {
            grid: fixed.grid.clone(),
            data,
        };
        // Off the voxel lattice, where trilinear interpolation is smooth.
        let shift: Vec<[f32; 3]> = (0..fixed.data.len())
            .map(|i| [0.3 + 0.01 * (i % 5) as f32, -0.2, 0.15])
            .collect();
        let (_, gradient) = ncc_gradient(
            &fixed,
            &moving,
            Some(&mask),
            [1, 2, 1],
            &field(shift.clone()),
        )
        .unwrap();
        let step = 2e-2_f32;
        for &(index, axis) in &[
            (5 + 10 * (4 + 9 * 3), 0),
            (3 + 10 * (2 + 9 * 5), 1),
            (7 + 10 * (6 + 9 * 4), 2),
        ] {
            let mut plus = shift.clone();
            plus[index][axis] += step;
            let mut minus = shift.clone();
            minus[index][axis] -= step;
            let (up, _) =
                ncc_gradient(&fixed, &moving, Some(&mask), [1, 2, 1], &field(plus)).unwrap();
            let (down, _) =
                ncc_gradient(&fixed, &moving, Some(&mask), [1, 2, 1], &field(minus)).unwrap();
            let numeric = (up - down) / (2.0 * step as f64);
            let analytic = gradient.data[index][axis] as f64;
            assert!(
                (numeric - analytic).abs() <= 2e-3 * analytic.abs().max(1.0),
                "voxel {index} axis {axis}: {numeric} vs {analytic}"
            );
        }
    }
}
