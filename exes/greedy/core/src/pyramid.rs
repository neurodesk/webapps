use crate::par::for_each_z;
use crate::reslice::trilinear_scalar;
use crate::{Grid, Mat4, NiftiImage, Result, gaussian_smooth};

/// Greedy's v1 schedule is fixed at 4x, 2x, and native resolution.
pub const FACTORS: [usize; 3] = [4, 2, 1];

fn adjusted_factors(grid: &Grid, factor: usize) -> [usize; 3] {
    grid.dims.map(|dimension| {
        let mut adjusted = factor;
        while dimension < adjusted && adjusted > 1 {
            adjusted >>= 1;
        }
        adjusted
    })
}

pub fn downsample_grid(grid: &Grid, factor: usize) -> Grid {
    if factor <= 1 {
        return grid.clone();
    }
    let factors = adjusted_factors(grid, factor);
    let dims = std::array::from_fn(|axis| grid.dims[axis].div_ceil(factors[axis]));
    let mut linear = grid.lps_from_voxel.0;
    for axis in 0..3 {
        let scale = grid.dims[axis] as f64 / dims[axis] as f64;
        for row in linear.iter_mut().take(3) {
            let old = row[axis];
            row[axis] *= scale;
            // NIfTI image indices start at zero, so both ITK indices are zero.
            row[3] += 0.5 * (row[axis] - old);
        }
    }
    Grid {
        dims,
        lps_from_voxel: Mat4(linear),
    }
}

/// Resampling uses physical coordinates.
pub fn resample(image: &NiftiImage, grid: Grid) -> Result<NiftiImage> {
    let moving_from_lps = image.grid.lps_from_voxel.inverse()?;
    let per_slab = grid.dims[0] * grid.dims[1];
    let mut data = vec![0.0_f32; grid.dims.iter().product()];
    for_each_z(&mut data, grid.dims[2], |z, slab| {
        for (offset, out) in slab.iter_mut().enumerate() {
            let lps = grid.voxel_to_lps(grid.voxel(z * per_slab + offset));
            *out = trilinear_scalar(image, moving_from_lps.apply(lps));
        }
    });
    Ok(NiftiImage {
        grid,
        data,
        scalar_type: image.scalar_type,
    })
}

/// Takes the image by value: the full-resolution level is the input itself.
pub fn build(image: NiftiImage) -> Result<[NiftiImage; 3]> {
    let level = |factor| {
        let factors = adjusted_factors(&image.grid, factor);
        let filtered = gaussian_smooth(&image, factors.map(|axis| 0.5 * axis as f64))?;
        resample(&filtered, downsample_grid(&image.grid, factor))
    };
    Ok([level(FACTORS[0])?, level(FACTORS[1])?, image])
}
