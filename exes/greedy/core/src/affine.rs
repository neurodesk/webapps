use crate::nmi::{
    corner_gradient, histogram_sample, joint_histogram, score_from_histogram,
    score_gradient_from_histogram,
};
use crate::par::map_z;
use crate::reslice::{trilinear_scalar, trilinear_scalar_gradient};
use crate::{Grid, Mat4, NiftiImage, Result, bin_image, build_pyramid};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AffineMetric {
    Ssd,
    Nmi,
}

#[derive(Clone, Copy, Debug)]
pub struct AffineOptions {
    pub iterations: usize,
    pub verbose: bool,
}

impl Default for AffineOptions {
    fn default() -> Self {
        Self {
            iterations: 100,
            verbose: false,
        }
    }
}

pub fn parameters(matrix: Mat4) -> [f64; 12] {
    let mut out = [0.0; 12];
    for row in 0..3 {
        out[row * 4] = matrix.0[row][3];
        for column in 0..3 {
            out[row * 4 + column + 1] = matrix.0[row][column];
        }
    }
    out
}

pub fn matrix(parameters: [f64; 12]) -> Mat4 {
    let mut matrix = Mat4::IDENTITY;
    for row in 0..3 {
        matrix.0[row][3] = parameters[row * 4];
        for column in 0..3 {
            matrix.0[row][column] = parameters[row * 4 + column + 1];
        }
    }
    matrix
}

/// Greedy's `-ia-image-centers`: voxel coordinates are `dims / 2`, not
/// `(dims - 1) / 2`; the returned transform is fixed RAS -> moving RAS.
pub fn image_centers(fixed: &Grid, moving: &Grid) -> Mat4 {
    let fixed_center = fixed.voxel_to_lps(fixed.dims.map(|x| x as f64 / 2.0));
    let moving_center = moving.voxel_to_lps(moving.dims.map(|x| x as f64 / 2.0));
    let fixed_center = Grid::ras_from_lps(fixed_center);
    let moving_center = Grid::ras_from_lps(moving_center);
    let mut matrix = Mat4::IDENTITY;
    for axis in 0..3 {
        matrix.0[axis][3] = moving_center[axis] - fixed_center[axis];
    }
    matrix
}

fn ras_from_voxel(grid: &Grid) -> Mat4 {
    let mut ras = grid.lps_from_voxel.0;
    for value in &mut ras[0] {
        *value = -*value;
    }
    for value in &mut ras[1] {
        *value = -*value;
    }
    Mat4(ras)
}

fn product(left: Mat4, right: Mat4) -> Mat4 {
    Mat4(std::array::from_fn(|row| {
        std::array::from_fn(|column| (0..4).map(|k| left.0[row][k] * right.0[k][column]).sum())
    }))
}

/// Greedy maps physical parameters in double then stores its voxel transform
/// in `MatrixOffsetTransformBase<float>` for a `-float` run.
fn voxel_transform(fixed: &Grid, moving: &Grid, matrix: Mat4) -> Result<Mat4> {
    let transform = product(
        product(ras_from_voxel(moving).inverse()?, matrix),
        ras_from_voxel(fixed),
    );
    let mut values = transform.0;
    for row in values.iter_mut().take(3) {
        for value in row {
            *value = *value as f32 as f64;
        }
    }
    Ok(Mat4(values))
}

/// Per-evaluation sums in fixed voxel space: `offset` = sum of sample
/// gradients, `linear[r][c]` = sum of gradient_r * index_c. Greedy accumulates
/// the same way and maps to physical parameters once per evaluation.
#[derive(Clone, Copy, Default)]
struct VoxelSums {
    offset: [f64; 3],
    linear: [[f64; 3]; 3],
}

impl VoxelSums {
    fn add(&mut self, gradient: [f64; 3], index: [f64; 3]) {
        for ((offset, row), g) in self.offset.iter_mut().zip(&mut self.linear).zip(gradient) {
            *offset += g;
            for (entry, i) in row.iter_mut().zip(index) {
                *entry += g * i;
            }
        }
    }
    fn merge(&mut self, other: &VoxelSums) {
        for r in 0..3 {
            self.offset[r] += other.offset[r];
            for c in 0..3 {
                self.linear[r][c] += other.linear[r][c];
            }
        }
    }
    /// Chain rule through `A_vox = Qm^-1 A Qf`, `b_vox = Qm^-1 (A s_f + b) + ...`
    /// for RAS parameters `[b0, A00, A01, A02, b1, ...]`.
    fn physical(&self, fixed: &Grid, moving: &Grid) -> Result<[f64; 12]> {
        let q_fixed = ras_from_voxel(fixed).0;
        let q_moving_inverse = ras_from_voxel(moving).inverse()?.0;
        let mut out = [0.0; 12];
        for r in 0..3 {
            // Rows of Qm^-T are the columns of Qm^-1.
            let weighted: [f64; 3] = std::array::from_fn(|k| q_moving_inverse[k][r]);
            out[r * 4] = (0..3).map(|k| weighted[k] * self.offset[k]).sum();
            for c in 0..3 {
                out[r * 4 + c + 1] = (0..3)
                    .map(|k| {
                        weighted[k]
                            * ((0..3)
                                .map(|j| self.linear[k][j] * q_fixed[c][j])
                                .sum::<f64>()
                                + self.offset[k] * q_fixed[c][3])
                    })
                    .sum();
            }
        }
        Ok(out)
    }
}

/// Evaluates one full-resolution affine metric. This is the shared, testable
/// objective used by the affine optimizer.
pub fn score(
    fixed: &NiftiImage,
    moving: &NiftiImage,
    matrix: Mat4,
    metric: AffineMetric,
) -> Result<f64> {
    let voxel_matrix = voxel_transform(&fixed.grid, &moving.grid, matrix)?;
    let dims = fixed.grid.dims;
    match metric {
        AffineMetric::Ssd => {
            let slabs = map_z(dims[2], |z| {
                let mut ssd = 0.0;
                for y in 0..dims[1] {
                    let line = dims[0] * (y + dims[1] * z);
                    for x in 0..dims[0] {
                        let voxel = voxel_matrix.apply([x as f64, y as f64, z as f64]);
                        let delta =
                            fixed.data[line + x] as f64 - trilinear_scalar(moving, voxel) as f64;
                        ssd += delta * delta;
                    }
                }
                ssd
            });
            Ok(slabs.iter().sum::<f64>() / fixed.data.len() as f64)
        }
        AffineMetric::Nmi => {
            let fixed_bins = bin_image(fixed)?;
            let moving_bins = bin_image(moving)?;
            let step = [
                voxel_matrix.0[0][0],
                voxel_matrix.0[1][0],
                voxel_matrix.0[2][0],
            ];
            let (joint, sum) = joint_histogram(&fixed_bins, dims, |line, y, z, corners| {
                let mut position = voxel_matrix.apply([0.0, y as f64, z as f64]);
                for x in 0..dims[0] {
                    corners(
                        line + x,
                        histogram_sample::<false>(&moving.grid, &moving_bins, position),
                    );
                    for axis in 0..3 {
                        position[axis] += step[axis];
                    }
                }
            })?;
            score_from_histogram(&joint, sum)
        }
    }
}

/// SSD value and derivative with respect to the 12 physical-RAS affine
/// parameters `[b0, A00, A01, A02, b1, ...]`.
pub fn ssd_score_gradient(
    fixed: &NiftiImage,
    moving: &NiftiImage,
    transform: Mat4,
) -> Result<(f64, [f64; 12])> {
    let voxel_matrix = voxel_transform(&fixed.grid, &moving.grid, transform)?;
    let dims = fixed.grid.dims;
    let slabs = map_z(dims[2], |z| {
        let mut value = 0.0;
        let mut sums = VoxelSums::default();
        for y in 0..dims[1] {
            let line = dims[0] * (y + dims[1] * z);
            for x in 0..dims[0] {
                let index = [x as f64, y as f64, z as f64];
                let (sample, voxel_gradient) =
                    trilinear_scalar_gradient(moving, voxel_matrix.apply(index));
                let delta = sample as f64 - fixed.data[line + x] as f64;
                value += delta * delta;
                sums.add(voxel_gradient.map(|g| 2.0 * delta * g), index);
            }
        }
        (value, sums)
    });
    let count = fixed.data.len() as f64;
    let (value, sums) = merge(slabs);
    Ok((
        value / count,
        sums.physical(&fixed.grid, &moving.grid)?.map(|g| g / count),
    ))
}

fn merge(slabs: Vec<(f64, VoxelSums)>) -> (f64, VoxelSums) {
    let mut value = 0.0;
    let mut sums = VoxelSums::default();
    for (slab_value, slab_sums) in &slabs {
        value += slab_value;
        sums.merge(slab_sums);
    }
    (value, sums)
}

/// NMI value and derivative with respect to the 12 physical-RAS affine
/// parameters. Histogram derivatives follow Greedy's eight-corner spatial
/// partial-volume accumulation.
pub fn nmi_score_gradient_affine(
    fixed: &NiftiImage,
    moving: &NiftiImage,
    transform: Mat4,
) -> Result<(f64, [f64; 12])> {
    nmi_score_gradient_binned(
        fixed,
        &bin_image(fixed)?,
        moving,
        &bin_image(moving)?,
        transform,
    )
}

fn nmi_score_gradient_binned(
    fixed: &NiftiImage,
    fixed_bins: &[u8],
    moving: &NiftiImage,
    moving_bins: &[u8],
    transform: Mat4,
) -> Result<(f64, [f64; 12])> {
    let voxel_matrix = voxel_transform(&fixed.grid, &moving.grid, transform)?;
    let dims = fixed.grid.dims;
    // Sample positions advance by one matrix column per x, like Greedy.
    let step = [
        voxel_matrix.0[0][0],
        voxel_matrix.0[1][0],
        voxel_matrix.0[2][0],
    ];
    let line_start = |y: usize, z: usize| voxel_matrix.apply([0.0, y as f64, z as f64]);
    // Two passes over the samples: the histogram first, then its per-bin
    // derivatives spread back to the voxels. Recomputing the eight corners is
    // far cheaper than storing them.
    let (joint, sum) = joint_histogram(fixed_bins, dims, |line, y, z, corners| {
        let mut position = line_start(y, z);
        for x in 0..dims[0] {
            corners(
                line + x,
                histogram_sample::<false>(&moving.grid, moving_bins, position),
            );
            for axis in 0..3 {
                position[axis] += step[axis];
            }
        }
    })?;
    let (value, weights) = score_gradient_from_histogram(&joint, sum)?;
    let slabs = map_z(dims[2], |z| {
        let mut sums = VoxelSums::default();
        for y in 0..dims[1] {
            let line = dims[0] * (y + dims[1] * z);
            let mut position = line_start(y, z);
            for x in 0..dims[0] {
                let fixed_bin = fixed_bins[line + x] as usize;
                if fixed_bin != 0 {
                    let (corners, _, derivatives) =
                        histogram_sample::<true>(&moving.grid, moving_bins, position);
                    sums.add(
                        corner_gradient(&weights, fixed_bin, corners, derivatives),
                        [x as f64, y as f64, z as f64],
                    );
                }
                for axis in 0..3 {
                    position[axis] += step[axis];
                }
            }
        }
        (0.0, sums)
    });
    Ok((value, merge(slabs).1.physical(&fixed.grid, &moving.grid)?))
}

fn evaluate(
    fixed: &NiftiImage,
    moving: &NiftiImage,
    bins: &Option<(Vec<u8>, Vec<u8>)>,
    scaled: [f64; 12],
    scale: [f64; 12],
    metric: AffineMetric,
) -> Result<(f64, [f64; 12])> {
    let parameters = std::array::from_fn(|index| scaled[index] / scale[index]);
    let (value, gradient) = match (metric, bins) {
        (AffineMetric::Ssd, _) => ssd_score_gradient(fixed, moving, matrix(parameters))?,
        // Greedy minimizes -10000 times NMI rather than maximizing an
        // unscaled score. The constant changes its first Netlib step.
        (AffineMetric::Nmi, Some((fixed_bins, moving_bins))) => {
            let (value, gradient) = nmi_score_gradient_binned(
                fixed,
                fixed_bins,
                moving,
                moving_bins,
                matrix(parameters),
            )?;
            (-10_000.0 * value, gradient.map(|value| -10_000.0 * value))
        }
        (AffineMetric::Nmi, None) => unreachable!("NMI bins are computed per level"),
    };
    Ok((
        value,
        std::array::from_fn(|index| gradient[index] / scale[index]),
    ))
}

fn dot(left: [f64; 12], right: [f64; 12]) -> f64 {
    left.into_iter().zip(right).map(|(a, b)| a * b).sum()
}

fn norm(values: [f64; 12]) -> f64 {
    dot(values, values).sqrt()
}

type ValueGradient = (f64, [f64; 12]);
type LineSearchResult = ([f64; 12], f64, [f64; 12], f64);

// Direct translation of Netlib's LBFGS / MCSRCH / MCSTEP (Nocedal; More and
// Thuente). Keeping its state transitions intact matters because Greedy's
// accepted affine parameters depend on this exact trial-step sequence.
#[allow(clippy::too_many_arguments)]
fn mcstep(
    stx: &mut f64,
    fx: &mut f64,
    dx: &mut f64,
    sty: &mut f64,
    fy: &mut f64,
    dy: &mut f64,
    stp: &mut f64,
    fp: f64,
    dp: f64,
    brackt: &mut bool,
    stpmin: f64,
    stpmax: f64,
) -> bool {
    if (*brackt && (*stp <= stx.min(*sty) || *stp >= stx.max(*sty)))
        || *dx * (*stp - *stx) >= 0.0
        || stpmax < stpmin
    {
        return false;
    }
    let sgnd = dp * (*dx / dx.abs());
    let (stpf, bound) = if fp > *fx {
        let theta = 3.0 * (*fx - fp) / (*stp - *stx) + *dx + dp;
        let s = theta.abs().max(dx.abs()).max(dp.abs());
        let mut gamma = s * ((theta / s).powi(2) - (*dx / s) * (dp / s)).sqrt();
        if *stp < *stx {
            gamma = -gamma;
        }
        let p = (gamma - *dx) + theta;
        let q = ((gamma - *dx) + gamma) + dp;
        let stpc = *stx + (p / q) * (*stp - *stx);
        let stpq = *stx + (*dx / ((*fx - fp) / (*stp - *stx) + *dx) / 2.0) * (*stp - *stx);
        *brackt = true;
        (
            if (stpc - *stx).abs() < (stpq - *stx).abs() {
                stpc
            } else {
                stpc + (stpq - stpc) / 2.0
            },
            true,
        )
    } else if sgnd < 0.0 {
        let theta = 3.0 * (*fx - fp) / (*stp - *stx) + *dx + dp;
        let s = theta.abs().max(dx.abs()).max(dp.abs());
        let mut gamma = s * ((theta / s).powi(2) - (*dx / s) * (dp / s)).sqrt();
        if *stp > *stx {
            gamma = -gamma;
        }
        let p = (gamma - dp) + theta;
        let q = ((gamma - dp) + gamma) + *dx;
        let stpc = *stp + (p / q) * (*stx - *stp);
        let stpq = *stp + (dp / (dp - *dx)) * (*stx - *stp);
        *brackt = true;
        (
            if (stpc - *stp).abs() > (stpq - *stp).abs() {
                stpc
            } else {
                stpq
            },
            false,
        )
    } else if dp.abs() < dx.abs() {
        let theta = 3.0 * (*fx - fp) / (*stp - *stx) + *dx + dp;
        let s = theta.abs().max(dx.abs()).max(dp.abs());
        let mut gamma = s * ((theta / s).powi(2) - (*dx / s) * (dp / s)).max(0.0).sqrt();
        if *stp > *stx {
            gamma = -gamma;
        }
        let p = (gamma - dp) + theta;
        let q = (gamma + (*dx - dp)) + gamma;
        let r = p / q;
        let stpc = if r < 0.0 && gamma != 0.0 {
            *stp + r * (*stx - *stp)
        } else if *stp > *stx {
            stpmax
        } else {
            stpmin
        };
        let stpq = *stp + (dp / (dp - *dx)) * (*stx - *stp);
        let step = if *brackt {
            if (*stp - stpc).abs() < (*stp - stpq).abs() {
                stpc
            } else {
                stpq
            }
        } else if (*stp - stpc).abs() > (*stp - stpq).abs() {
            stpc
        } else {
            stpq
        };
        (step, true)
    } else if *brackt {
        let theta = 3.0 * (fp - *fy) / (*sty - *stp) + *dy + dp;
        let s = theta.abs().max(dy.abs()).max(dp.abs());
        let mut gamma = s * ((theta / s).powi(2) - (*dy / s) * (dp / s)).sqrt();
        if *stp > *sty {
            gamma = -gamma;
        }
        let p = (gamma - dp) + theta;
        let q = ((gamma - dp) + gamma) + *dy;
        (*stp + (p / q) * (*sty - *stp), false)
    } else if *stp > *stx {
        (stpmax, false)
    } else {
        (stpmin, false)
    };
    if fp > *fx {
        *sty = *stp;
        *fy = fp;
        *dy = dp;
    } else {
        if sgnd < 0.0 {
            *sty = *stx;
            *fy = *fx;
            *dy = *dx;
        }
        *stx = *stp;
        *fx = fp;
        *dx = dp;
    }
    *stp = stpf.clamp(stpmin, stpmax);
    if *brackt && bound {
        *stp = if *sty > *stx {
            (*stx + 0.66 * (*sty - *stx)).min(*stp)
        } else {
            (*stx + 0.66 * (*sty - *stx)).max(*stp)
        };
    }
    true
}

fn line_search(
    base: [f64; 12],
    f0: f64,
    g0: [f64; 12],
    direction: [f64; 12],
    initial_step: f64,
    evaluate: &mut impl FnMut([f64; 12]) -> Result<Option<ValueGradient>>,
) -> Result<Option<LineSearchResult>> {
    let dginit = dot(g0, direction);
    if dginit >= 0.0 {
        return Ok(None);
    }
    let (mut stx, mut fx, mut dx): (f64, f64, f64) = (0.0, f0, dginit);
    let (mut sty, mut fy, mut dy): (f64, f64, f64) = (0.0, f0, dginit);
    let (mut step, mut brackt, mut stage1) = (initial_step, false, true);
    let (mut width, mut width1) = (1e20, 2e20);
    let dgtest = 1e-4 * dginit;
    let mut nfev = 0;
    loop {
        let (stmin, stmax) = if brackt {
            (stx.min(sty), stx.max(sty))
        } else {
            (stx, step + 4.0 * (step - stx))
        };
        step = step.clamp(1e-20, 1e20);
        if brackt && (step <= stmin || step >= stmax || stmax - stmin <= 1e-16 * stmax)
            || nfev >= 19
        {
            step = stx;
        }
        let trial = std::array::from_fn(|index| base[index] + step * direction[index]);
        let Some((fp, gp)) = evaluate(trial)? else {
            return Ok(None);
        };
        nfev += 1;
        let dp = dot(gp, direction);
        let ftest1 = f0 + step * dgtest;
        if fp <= ftest1 && dp.abs() <= 0.9 * -dginit {
            return Ok(Some((trial, fp, gp, step)));
        }
        if (brackt && (step <= stmin || step >= stmax || stmax - stmin <= 1e-16 * stmax))
            || nfev >= 20
            || (step == 1e20 && fp <= ftest1 && dp <= dgtest)
            || (step == 1e-20 && (fp > ftest1 || dp >= dgtest))
        {
            return Ok(None);
        }
        if stage1 && fp <= ftest1 && dp >= 1e-4_f64.min(0.9) * dginit {
            stage1 = false;
        }
        let info = if stage1 && fp <= fx && fp > ftest1 {
            let fm = fp - step * dgtest;
            let mut fxm = fx - stx * dgtest;
            let mut fym = fy - sty * dgtest;
            let dgm = dp - dgtest;
            let mut dxm = dx - dgtest;
            let mut dym = dy - dgtest;
            let info = mcstep(
                &mut stx,
                &mut fxm,
                &mut dxm,
                &mut sty,
                &mut fym,
                &mut dym,
                &mut step,
                fm,
                dgm,
                &mut brackt,
                stmin,
                stmax,
            );
            fx = fxm + stx * dgtest;
            fy = fym + sty * dgtest;
            dx = dxm + dgtest;
            dy = dym + dgtest;
            info
        } else {
            mcstep(
                &mut stx,
                &mut fx,
                &mut dx,
                &mut sty,
                &mut fy,
                &mut dy,
                &mut step,
                fp,
                dp,
                &mut brackt,
                stmin,
                stmax,
            )
        };
        if !info {
            return Ok(None);
        }
        if brackt {
            if (sty - stx).abs() >= 0.66 * width1 {
                step = stx + 0.5 * (sty - stx);
            }
            width1 = width;
            width = (sty - stx).abs();
        }
    }
}

/// Greedy's Netlib L-BFGS path: five corrections, More--Thuente line search,
/// and an evaluation (not iteration) budget.
pub fn optimize(
    fixed: &NiftiImage,
    moving: &NiftiImage,
    initial: Mat4,
    metric: AffineMetric,
    options: AffineOptions,
) -> Result<Mat4> {
    if options.iterations == 0 {
        return Ok(initial);
    }
    let scale = [
        1.0,
        fixed.grid.dims[0] as f64,
        fixed.grid.dims[1] as f64,
        fixed.grid.dims[2] as f64,
        1.0,
        fixed.grid.dims[0] as f64,
        fixed.grid.dims[1] as f64,
        fixed.grid.dims[2] as f64,
        1.0,
        fixed.grid.dims[0] as f64,
        fixed.grid.dims[1] as f64,
        fixed.grid.dims[2] as f64,
    ];
    let mut x = std::array::from_fn(|index| parameters(initial)[index] * scale[index]);
    let bins = match metric {
        AffineMetric::Nmi => Some((bin_image(fixed)?, bin_image(moving)?)),
        AffineMetric::Ssd => None,
    };
    let (mut value, mut gradient) = evaluate(fixed, moving, &bins, x, scale, metric)?;
    let (mut best_value, mut best_x) = (value, x);
    if options.verbose {
        println!(
            "  N=12   NUMBER OF CORRECTIONS=5       INITIAL VALUES F= {:.6}   GNORM= {:.6}\n   I   NFN    FUNC        GNORM       STEPLENGTH",
            value,
            norm(gradient)
        );
    }
    // `vnl_lbfgs` checks its limit after each evaluation. Consequently a
    // limit of one still evaluates the initial More--Thuente trial; preserve
    // that slightly surprising but consequential behavior.
    let mut evaluations = 1;
    let mut history: Vec<([f64; 12], [f64; 12])> = Vec::new();
    let mut iteration = 0;
    loop {
        iteration += 1;
        let direction = if history.is_empty() {
            gradient.map(|value| -value)
        } else {
            let (last_s, last_y) = history.last().unwrap();
            let gamma = dot(*last_s, *last_y) / dot(*last_y, *last_y);
            let mut q = gradient.map(|value| -value);
            let mut alpha = Vec::with_capacity(history.len());
            for (s, y) in history.iter().rev() {
                let a = dot(*s, q) / dot(*y, *s);
                alpha.push(a);
                q = std::array::from_fn(|index| q[index] - a * y[index]);
            }
            q = q.map(|entry| gamma * entry);
            for ((s, y), a) in history.iter().zip(alpha.into_iter().rev()) {
                let beta = dot(*y, q) / dot(*y, *s);
                q = std::array::from_fn(|index| q[index] + (a - beta) * s[index]);
            }
            q
        };
        let first_step = 1.0 / norm(gradient);
        let start_step = if history.is_empty() { first_step } else { 1.0 };
        let outcome = {
            let mut trial = |candidate| {
                let result = evaluate(fixed, moving, &bins, candidate, scale, metric)?;
                evaluations += 1;
                if result.0 < best_value {
                    best_value = result.0;
                    best_x = candidate;
                }
                Ok((evaluations <= options.iterations).then_some(result))
            };
            line_search(x, value, gradient, direction, start_step, &mut trial)?
        };
        let Some((next_x, next_value, next_gradient, step)) = outcome else {
            if options.verbose {
                println!(" IFLAG= -1  LINE SEARCH FAILED");
            }
            break;
        };
        if options.verbose {
            println!(
                "{:4} {:4}    {:.3}  {:.3}       {:.3}",
                iteration,
                evaluations,
                next_value,
                norm(next_gradient),
                step
            );
        }
        let s = std::array::from_fn(|index| next_x[index] - x[index]);
        let y = std::array::from_fn(|index| next_gradient[index] - gradient[index]);
        if history.len() == 5 {
            history.remove(0);
        }
        history.push((s, y));
        x = next_x;
        value = next_value;
        gradient = next_gradient;
        if norm(gradient) / norm(x).max(1.0) <= 1e-5 {
            break;
        }
    }
    Ok(matrix(std::array::from_fn(|index| {
        best_x[index] / scale[index]
    })))
}

pub fn register(
    fixed: NiftiImage,
    moving: NiftiImage,
    metric: AffineMetric,
    iterations: [usize; 3],
    verbose: bool,
) -> Result<Mat4> {
    if iterations == [0, 0, 0] {
        return Ok(image_centers(&fixed.grid, &moving.grid));
    }
    let fixed_pyramid = build_pyramid(fixed)?;
    let moving_pyramid = build_pyramid(moving)?;
    // Greedy initializes at the coarsest reference spaces, not the original
    // input grids. The physical matrix is then carried to finer levels.
    let mut transform = image_centers(&fixed_pyramid[0].grid, &moving_pyramid[0].grid);
    for level in 0..3 {
        transform = optimize(
            &fixed_pyramid[level],
            &moving_pyramid[level],
            transform,
            metric,
            AffineOptions {
                iterations: iterations[level],
                verbose,
            },
        )?;
        if verbose {
            println!("END OF LEVEL {level:3}\nLevel {level:3}  Final RAS Transform:");
            for row in transform.0 {
                println!("{:9.4}{:9.4}{:9.4}{:9.4}", row[0], row[1], row[2], row[3]);
            }
        }
    }
    Ok(transform)
}

#[cfg(test)]
mod tests {
    use super::{dot, line_search, norm};

    #[test]
    fn more_thuente_accepts_a_strong_wolfe_quadratic_step() {
        let target = [3.0; 12];
        let base = [0.0; 12];
        let gradient = target.map(|value| -2.0 * value);
        let direction = gradient.map(|value| -value);
        let mut evaluations = 0;
        let result = line_search(
            base,
            dot(target, target),
            gradient,
            direction,
            1.0 / norm(gradient),
            &mut |candidate| {
                evaluations += 1;
                let delta = std::array::from_fn(|index| candidate[index] - target[index]);
                Ok(Some((dot(delta, delta), delta.map(|value| 2.0 * value))))
            },
        )
        .unwrap()
        .unwrap();

        assert!(evaluations > 1);
        assert!(result.1 < dot(target, target), "{}", result.1);
        let result_gradient = std::array::from_fn(|index| 2.0 * (result.0[index] - target[index]));
        assert!(dot(result_gradient, direction).abs() <= 0.9 * -dot(gradient, direction));
    }
}
