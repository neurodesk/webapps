use crate::par::map_z;
use crate::{Error, Grid, NiftiImage, Result};

pub const BINS: usize = 128;

/// Greedy's NMI preprocessing maps the 1st and 99th percentile to 1 and 127;
/// bin zero remains reserved for samples outside the moving image.
pub fn bin_image(image: &NiftiImage) -> Result<Vec<u8>> {
    let mut finite = image
        .data
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if finite.is_empty() {
        return Err(Error("cannot compute NMI bins for an all-NaN image".into()));
    }
    let low = finite.len() / 100;
    let high = finite.len() - finite.len() / 100 - 1;
    let (_, lower, _) = finite.select_nth_unstable_by(low, f32::total_cmp);
    let lower = *lower;
    let (_, upper, _) = finite.select_nth_unstable_by(high, f32::total_cmp);
    let upper = *upper;
    if upper <= lower {
        return Ok(image
            .data
            .iter()
            .map(|value| if value.is_finite() { 1 } else { 0 })
            .collect());
    }
    // Greedy calculates this remapping scale and shift in `double`, then
    // truncates the resulting value to an unsigned-char bin.
    let scale = 126.0_f64 / (upper as f64 - lower as f64);
    let shift = lower as f64 * scale - 1.0;
    Ok(image
        .data
        .iter()
        .map(|&value| {
            let mapped = value as f64 * scale - shift;
            if !mapped.is_finite() || mapped < 1.0 {
                0
            } else if mapped > 127.0 {
                127
            } else {
                mapped as u8
            }
        })
        .collect())
}

/// Greedy's partial-volume sample: the eight trilinear corner bins, their
/// weights, and each weight's derivative with respect to the voxel coordinate.
pub(crate) fn histogram_sample<const DERIVATIVES: bool>(
    grid: &Grid,
    data: &[u8],
    voxel: [f64; 3],
) -> ([u8; 8], [f64; 8], [[f64; 3]; 8]) {
    // Greedy's NMI interpolator is instantiated with `TReal = float`.  This
    // cast is observable at near-integer coordinates: it selects the same
    // one-sided partial-volume derivative as the reference implementation.
    let voxel = voxel.map(|value| value as f32 as f64);
    let base = voxel.map(f64::floor);
    let fraction = [voxel[0] - base[0], voxel[1] - base[1], voxel[2] - base[2]];
    let base = base.map(|x| x as isize);
    let mut bins = [0; 8];
    let empty_weights = [0.0; 8];
    let mut derivatives = [[0.0; 3]; 8];
    let inside = (0..3).all(|axis| base[axis] >= 0 && base[axis] + 1 < grid.dims[axis] as isize);
    if !inside && (0..3).any(|axis| base[axis] < -1 || base[axis] + 1 > grid.dims[axis] as isize) {
        return (bins, empty_weights, derivatives);
    }
    let one_minus = fraction.map(|value| 1.0 - value);
    let mut weights = [0.0; 8];
    for dz in 0..2_usize {
        for dy in 0..2_usize {
            for dx in 0..2_usize {
                let corner = dx + 2 * (dy + 2 * dz);
                let (wx, wy, wz) = (
                    [one_minus[0], fraction[0]][dx],
                    [one_minus[1], fraction[1]][dy],
                    [one_minus[2], fraction[2]][dz],
                );
                weights[corner] = wx * wy * wz;
                if DERIVATIVES {
                    let (wx, wy, wz) = (
                        [1.0 - fraction[0], fraction[0]][dx],
                        [1.0 - fraction[1], fraction[1]][dy],
                        [1.0 - fraction[2], fraction[2]][dz],
                    );
                    derivatives[corner] = [
                        if dx == 0 { -1.0 } else { 1.0 } * wy * wz,
                        wx * if dy == 0 { -1.0 } else { 1.0 } * wz,
                        wx * wy * if dz == 0 { -1.0 } else { 1.0 },
                    ];
                }
                let (x, y, z) = (
                    base[0] + dx as isize,
                    base[1] + dy as isize,
                    base[2] + dz as isize,
                );
                if inside
                    || (x >= 0
                        && y >= 0
                        && z >= 0
                        && (x as usize) < grid.dims[0]
                        && (y as usize) < grid.dims[1]
                        && (z as usize) < grid.dims[2])
                {
                    bins[corner] =
                        data[x as usize + grid.dims[0] * (y as usize + grid.dims[1] * z as usize)];
                }
            }
        }
    }
    (bins, weights, derivatives)
}

/// Joint partial-volume histogram accumulated per z slab of `fixed`;
/// `sample(index)` yields the corner bins and weights at that fixed voxel.
/// Joint partial-volume histogram accumulated per z slab. `lines(line, y, z,
/// corners)` walks one x line, calling `corners(index, sample)` per voxel; the
/// sample's weights are binned against the fixed bin at `index`.
pub(crate) fn joint_histogram(
    fixed: &[u8],
    dims: [usize; 3],
    lines: impl Fn(usize, usize, usize, &mut dyn FnMut(usize, ([u8; 8], [f64; 8], [[f64; 3]; 8])))
    + Sync,
) -> Result<(Vec<f64>, f64)> {
    let slabs = map_z(dims[2], |z| {
        let mut joint = vec![0.0_f64; BINS * BINS];
        for y in 0..dims[1] {
            let line = dims[0] * (y + dims[1] * z);
            lines(line, y, z, &mut |index, (corners, weights, _)| {
                let fixed_bin = fixed[index] as usize;
                if fixed_bin == 0 {
                    return;
                }
                for (&moving_bin, &weight) in corners.iter().zip(&weights) {
                    if moving_bin > 0 {
                        joint[fixed_bin * BINS + moving_bin as usize] += weight;
                    }
                }
            });
        }
        joint
    });
    let mut joint = vec![0.0; BINS * BINS];
    for slab in slabs {
        for (total, value) in joint.iter_mut().zip(slab) {
            *total += value;
        }
    }
    let sum = joint.iter().sum::<f64>();
    Ok((joint, sum))
}

/// Sums the histogram-count derivatives over a sample's corners, weighted by
/// each corner's coordinate derivative.
pub(crate) fn corner_gradient(
    weights: &[f64],
    fixed_bin: usize,
    corners: [u8; 8],
    derivatives: [[f64; 3]; 8],
) -> [f64; 3] {
    let mut gradient = [0.0; 3];
    for (corner, derivative) in corners.iter().zip(derivatives) {
        let weight = weights[fixed_bin * BINS + *corner as usize];
        for (gradient, derivative) in gradient.iter_mut().zip(derivative) {
            *gradient += weight * derivative;
        }
    }
    gradient
}

pub(crate) fn score_from_histogram(joint: &[f64], sum: f64) -> Result<f64> {
    // Greedy reports NaN for a transform with no overlapping samples.  Its
    // L-BFGS line search rejects that trial and continues from the last
    // valid transform; turning it into an error aborts the whole registration.
    if sum == 0.0 {
        return Ok(f64::NAN);
    }
    let (_, _, _, fixed_entropy, moving_entropy, joint_entropy) = entropies(joint, sum);
    if joint_entropy == 0.0 {
        return Err(Error("NMI joint entropy is zero".into()));
    }
    Ok((fixed_entropy + moving_entropy) / joint_entropy)
}

/// NMI value and its derivative with respect to every joint-bin count, exactly
/// as Greedy converts its probability derivatives to counts.
pub(crate) fn score_gradient_from_histogram(joint: &[f64], sum: f64) -> Result<(f64, Vec<f64>)> {
    if sum == 0.0 {
        return Ok((f64::NAN, vec![f64::NAN; BINS * BINS]));
    }
    let (
        probability,
        marginal_fixed,
        marginal_moving,
        fixed_entropy,
        moving_entropy,
        joint_entropy,
    ) = entropies(joint, sum);
    if joint_entropy == 0.0 {
        return Err(Error("NMI joint entropy is zero".into()));
    }
    let score = (fixed_entropy + moving_entropy) / joint_entropy;
    let mut gradient = vec![0.0; BINS * BINS];
    for fixed_bin in 1..BINS {
        for moving_bin in 1..BINS {
            let probability_joint = probability[fixed_bin * BINS + moving_bin];
            if probability_joint > 0.0 {
                gradient[fixed_bin * BINS + moving_bin] =
                    (2.0 + marginal_fixed[fixed_bin].ln() + marginal_moving[moving_bin].ln()
                        - score * (probability_joint.ln() + 1.0))
                        / joint_entropy;
            }
        }
    }
    let expectation = gradient
        .iter()
        .zip(&probability)
        .map(|(gradient, probability)| gradient * probability)
        .sum::<f64>();
    for fixed_bin in 1..BINS {
        for moving_bin in 1..BINS {
            let gradient = &mut gradient[fixed_bin * BINS + moving_bin];
            *gradient = (*gradient - expectation) / sum;
        }
    }
    Ok((score, gradient))
}

fn entropies(joint: &[f64], sum: f64) -> (Vec<f64>, [f64; BINS], [f64; BINS], f64, f64, f64) {
    let mut probability = vec![0.0; BINS * BINS];
    let mut fixed = [0.0; BINS];
    let mut moving = [0.0; BINS];
    for f in 1..BINS {
        for m in 1..BINS {
            let value = joint[f * BINS + m] / sum;
            probability[f * BINS + m] = value;
            fixed[f] += value;
            moving[m] += value;
        }
    }
    let entropy = |values: &[f64]| {
        values
            .iter()
            .skip(1)
            .filter(|&&value| value > 0.0)
            .map(|&value| value * value.ln())
            .sum::<f64>()
    };
    let joint_entropy = entropy(&probability);
    (
        probability,
        fixed,
        moving,
        entropy(&fixed),
        entropy(&moving),
        joint_entropy,
    )
}
