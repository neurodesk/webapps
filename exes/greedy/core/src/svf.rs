use crate::nmi::{
    corner_gradient, histogram_sample, joint_histogram, score_gradient_from_histogram,
};
use crate::par::for_each_z;
use crate::{Error, Grid, NiftiImage, Result, VectorField, bin_image, build_pyramid, grids_match};

fn sample_voxel(field: &VectorField, voxel: [f64; 3]) -> [f32; 3] {
    let base = voxel.map(f64::floor);
    let fraction = [voxel[0] - base[0], voxel[1] - base[1], voxel[2] - base[2]];
    let one_minus = fraction.map(|f| 1.0 - f);
    let base = base.map(|x| x as isize);
    let dims = field.grid.dims;
    let (wx, wy, wz) = (
        [one_minus[0], fraction[0]],
        [one_minus[1], fraction[1]],
        [one_minus[2], fraction[2]],
    );
    let weight = |dx: usize, dy: usize, dz: usize| wx[dx] * wy[dy] * wz[dz];
    let mut value = [0.0_f64; 3];
    if (0..3).all(|axis| base[axis] >= 0 && base[axis] + 1 < dims[axis] as isize) {
        let origin = base[0] as usize + dims[0] * (base[1] as usize + dims[1] * base[2] as usize);
        let (step_y, step_z) = (dims[0], dims[0] * dims[1]);
        for dz in 0..2 {
            for dy in 0..2 {
                for dx in 0..2 {
                    let sample = field.data[origin + dx + step_y * dy + step_z * dz];
                    let weight = weight(dx, dy, dz);
                    for (value, sample) in value.iter_mut().zip(sample) {
                        *value += sample as f64 * weight;
                    }
                }
            }
        }
        return value.map(|v| v as f32);
    }
    for dz in 0..2_usize {
        for dy in 0..2_usize {
            for dx in 0..2_usize {
                let (x, y, z) = (
                    base[0] + dx as isize,
                    base[1] + dy as isize,
                    base[2] + dz as isize,
                );
                if x < 0
                    || y < 0
                    || z < 0
                    || x >= dims[0] as isize
                    || y >= dims[1] as isize
                    || z >= dims[2] as isize
                {
                    continue;
                }
                let sample = field.data[x as usize + dims[0] * (y as usize + dims[1] * z as usize)];
                let weight = weight(dx, dy, dz);
                for (value, sample) in value.iter_mut().zip(sample) {
                    *value += sample as f64 * weight;
                }
            }
        }
    }
    value.map(|v| v as f32)
}

/// `output = field + field(id + field)`, Greedy's one squaring step.
fn compose_voxel(field: &VectorField, output: &mut [[f32; 3]]) {
    let dims = field.grid.dims;
    for_each_z(output, dims[2], |z, slab| {
        for (row, y) in slab.chunks_exact_mut(dims[0]).zip(0..dims[1]) {
            let line = dims[0] * (y + dims[1] * z);
            for (x, out) in row.iter_mut().enumerate() {
                let current = field.data[line + x];
                let sampled = sample_voxel(
                    field,
                    [
                        x as f64 + current[0] as f64,
                        y as f64 + current[1] as f64,
                        z as f64 + current[2] as f64,
                    ],
                );
                *out = std::array::from_fn(|axis| current[axis] + sampled[axis]);
            }
        }
    });
}

/// Greedy's `vimg_exp`: the stored velocity is already divided by 2^steps
/// (each update is scaled by 1/(2 << steps)), so squaring starts from it
/// directly and the field represents exp(2^steps * v).
pub(crate) fn exp(velocity: &VectorField, steps: usize) -> Result<VectorField> {
    let mut field = velocity.clone();
    let mut scratch = vec![[0.0_f32; 3]; field.data.len()];
    for _ in 0..steps {
        compose_voxel(&field, &mut scratch);
        std::mem::swap(&mut field.data, &mut scratch);
    }
    Ok(field)
}

fn resample_voxel(field: &VectorField, grid: Grid) -> Result<VectorField> {
    let field_from_lps = field.grid.lps_from_voxel.inverse()?;
    let per_slab = grid.dims[0] * grid.dims[1];
    let mut data = vec![[0.0_f32; 3]; grid.dims.iter().product()];
    for_each_z(&mut data, grid.dims[2], |z, slab| {
        for (offset, out) in slab.iter_mut().enumerate() {
            let lps = grid.voxel_to_lps(grid.voxel(z * per_slab + offset));
            *out = sample_voxel(field, field_from_lps.apply(lps));
        }
    });
    Ok(VectorField { grid, data })
}

fn smooth_field(field: &VectorField, sigma_vox: [f64; 3]) -> Result<VectorField> {
    let mut data = vec![[0.0; 3]; field.data.len()];
    for component in 0..3 {
        let values = field.data.iter().map(|v| v[component]).collect::<Vec<_>>();
        let smoothed = crate::gaussian::smooth_data(&values, field.grid.dims, sigma_vox);
        for (target, value) in data.iter_mut().zip(smoothed) {
            target[component] = value;
        }
    }
    Ok(VectorField {
        grid: field.grid.clone(),
        data,
    })
}

fn nmi_gradient(
    fixed: &NiftiImage,
    fixed_bins: &[u8],
    moving: &NiftiImage,
    moving_bins: &[u8],
    displacement: &VectorField,
) -> Result<(f64, VectorField)> {
    if !grids_match(&fixed.grid, &displacement.grid, 1e-4) {
        return Err(Error(
            "deformation grid must match the fixed image grid".into(),
        ));
    }
    let dims = fixed.grid.dims;
    let position = |x: usize, y: usize, z: usize, index: usize| {
        let shift = displacement.data[index];
        [
            x as f64 + shift[0] as f64,
            y as f64 + shift[1] as f64,
            z as f64 + shift[2] as f64,
        ]
    };
    let (joint, sum) = joint_histogram(fixed_bins, dims, |line, y, z, corners| {
        for x in 0..dims[0] {
            let index = line + x;
            corners(
                index,
                histogram_sample::<false>(&moving.grid, moving_bins, position(x, y, z, index)),
            );
        }
    })?;
    let (score, weights) = score_gradient_from_histogram(&joint, sum)?;
    let mut data = vec![[0.0_f32; 3]; fixed.data.len()];
    for_each_z(&mut data, dims[2], |z, slab| {
        for (row, y) in slab.chunks_exact_mut(dims[0]).zip(0..dims[1]) {
            let line = dims[0] * (y + dims[1] * z);
            for (x, out) in row.iter_mut().enumerate() {
                let index = line + x;
                let fixed_bin = fixed_bins[index] as usize;
                if fixed_bin == 0 {
                    continue;
                }
                let (corners, _, derivatives) =
                    histogram_sample::<true>(&moving.grid, moving_bins, position(x, y, z, index));
                *out = corner_gradient(&weights, fixed_bin, corners, derivatives).map(|v| v as f32);
            }
        }
    });
    Ok((
        score,
        VectorField {
            grid: fixed.grid.clone(),
            data,
        },
    ))
}

fn normalize(field: &mut VectorField, length: f64) {
    let maximum = field
        .data
        .iter()
        .map(|value| {
            (value[0] as f64 * value[0] as f64
                + value[1] as f64 * value[1] as f64
                + value[2] as f64 * value[2] as f64)
                .sqrt()
        })
        .fold(0.0_f64, f64::max);
    if maximum > 0.0 {
        let scale = (length / maximum) as f32;
        for value in &mut field.data {
            for component in value {
                *component *= scale;
            }
        }
    }
}

/// Registers images already expressed on the same fixed grid using Greedy's
/// stationary-velocity update shape: NMI, pre/post smoothing, normalization,
/// and six-step scaling-and-squaring. The returned field is the residual
/// physical-LPS warp for use before the affine in a transform chain.
pub fn register_nmi_svf(
    fixed: NiftiImage,
    moving: NiftiImage,
    iterations: [usize; 3],
    verbose: bool,
    mut dump: impl FnMut(&str, &VectorField),
) -> Result<VectorField> {
    if !grids_match(&fixed.grid, &moving.grid, 1e-4) {
        return Err(Error(
            "SV registration requires moving resampled onto the fixed grid".into(),
        ));
    }
    let fixed_levels = build_pyramid(fixed)?;
    let moving_levels = build_pyramid(moving)?;
    let mut velocity = VectorField {
        grid: fixed_levels[0].grid.clone(),
        data: vec![[0.0; 3]; fixed_levels[0].data.len()],
    };
    for level in 0..3 {
        if level > 0 {
            velocity = resample_voxel(&velocity, fixed_levels[level].grid.clone())?;
            for vector in &mut velocity.data {
                for value in vector {
                    *value *= 2.0;
                }
            }
        }
        if iterations[level] == 0 {
            continue;
        }
        let fixed_bins = bin_image(&fixed_levels[level])?;
        let moving_bins = bin_image(&moving_levels[level])?;
        for iteration in 0..iterations[level] {
            let (score, mut gradient) = nmi_gradient(
                &fixed_levels[level],
                &fixed_bins,
                &moving_levels[level],
                &moving_bins,
                &exp(&velocity, 6)?,
            )?;
            if verbose {
                println!("Level {level:03}  Iter {iteration:05}    Energy = {score:.6}");
            }
            dump(
                &format!("gradient_lev{level:02}_iter{iteration:04}"),
                &gradient,
            );
            gradient = smooth_field(&gradient, [1.732_050_8; 3])?;
            normalize(&mut gradient, 1.0);
            dump(
                &format!("optflow_lev{level:02}_iter{iteration:04}"),
                &gradient,
            );
            for (velocity, gradient) in velocity.data.iter_mut().zip(gradient.data) {
                for component in 0..3 {
                    velocity[component] += gradient[component] / 128.0;
                }
            }
            dump(&format!("uk1_lev{level:02}_iter{iteration:04}"), &velocity);
            velocity = smooth_field(&velocity, [std::f64::consts::FRAC_1_SQRT_2; 3])?;
        }
        if verbose {
            let max = velocity
                .data
                .iter()
                .map(|v| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt())
                .fold(0.0_f32, f32::max);
            println!("END OF LEVEL {level:3}    max |v| = {max:.4} vox");
        }
    }
    let warp = exp(&velocity, 6)?;
    let linear = warp.grid.lps_from_voxel.0;
    Ok(VectorField {
        grid: warp.grid,
        data: warp
            .data
            .into_iter()
            .map(|voxel| {
                std::array::from_fn(|row| {
                    (0..3)
                        .map(|column| linear[row][column] * voxel[column] as f64)
                        .sum::<f64>() as f32
                })
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::exp;
    use crate::{Grid, Mat4, VectorField};

    #[test]
    fn exponential_scales_a_constant_velocity_by_two_to_the_steps() {
        // The stored velocity is pre-divided by 2^6, as in Greedy's vimg_exp.
        let field = VectorField {
            grid: Grid {
                dims: [9, 9, 9],
                lps_from_voxel: Mat4::IDENTITY,
            },
            data: vec![[0.01, -0.01, 0.0]; 729],
        };
        let result = exp(&field, 6).unwrap();
        let vector = result.data[4 + 9 * (4 + 9 * 4)];
        for (actual, expected) in vector.into_iter().zip([0.64, -0.64, 0.0]) {
            assert!((actual - expected).abs() < 1e-4, "{actual} != {expected}");
        }
    }
}
