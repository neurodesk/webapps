use crate::par::{for_each_z, map_z};
use crate::{NiftiImage, Result};

#[derive(Clone, Copy)]
struct Coefficients {
    n: [f64; 4],
    d: [f64; 4],
    m: [f64; 4],
    bn: [f64; 4],
    bm: [f64; 4],
}

/// Coefficients from ITK's `RecursiveGaussianImageFilter`, zero order.
fn coefficients(sigma: f64) -> Option<Coefficients> {
    if sigma < 1e-3 {
        return None;
    }
    let (w1, l1, w2, l2) = (0.6681, -1.3932, 2.0787, -1.3732);
    let (sin1, cos1, exp1) = ((w1 / sigma).sin(), (w1 / sigma).cos(), (l1 / sigma).exp());
    let (sin2, cos2, exp2) = ((w2 / sigma).sin(), (w2 / sigma).cos(), (l2 / sigma).exp());
    let (a1, b1, a2, b2) = (1.3530, 1.8151, -0.3531, 0.0902);
    let mut n = [0.0; 4];
    n[0] = a1 + a2;
    n[1] =
        exp2 * (b2 * sin2 - (a2 + 2.0 * a1) * cos2) + exp1 * (b1 * sin1 - (a1 + 2.0 * a2) * cos1);
    n[2] = 2.0 * exp1 * exp2 * ((a1 + a2) * cos2 * cos1 - b1 * cos2 * sin1 - b2 * cos1 * sin2)
        + a2 * exp1 * exp1
        + a1 * exp2 * exp2;
    n[3] =
        exp2 * exp1 * exp1 * (b2 * sin2 - a2 * cos2) + exp1 * exp2 * exp2 * (b1 * sin1 - a1 * cos1);
    let d = [
        -2.0 * (exp2 * cos2 + exp1 * cos1),
        4.0 * cos2 * cos1 * exp1 * exp2 + exp1 * exp1 + exp2 * exp2,
        -2.0 * cos1 * exp1 * exp2 * exp2 - 2.0 * cos2 * exp2 * exp1 * exp1,
        exp1 * exp1 * exp2 * exp2,
    ];
    let sn = n.iter().sum::<f64>();
    let sd = 1.0 + d.iter().sum::<f64>();
    let alpha = 2.0 * sn / sd - n[0];
    for value in &mut n {
        *value /= alpha;
    }
    let sn = n.iter().sum::<f64>();
    let m = [
        n[1] - d[0] * n[0],
        n[2] - d[1] * n[0],
        n[3] - d[2] * n[0],
        -d[3] * n[0],
    ];
    let sm = m.iter().sum::<f64>();
    Some(Coefficients {
        n,
        d,
        m,
        bn: d.map(|value| value * sn / sd),
        bm: d.map(|value| value * sm / sd),
    })
}

/// Filters `n` rows of `row_len` contiguous samples (rows `stride` apart)
/// along the row direction. Running the recurrence row by row keeps the inner
/// loops contiguous, so the y and z passes vectorize across x. `scratch`
/// holds the causal result for every row plus a four-row ring for the
/// anti-causal pass; it is reused between calls.
#[allow(clippy::too_many_arguments)]
fn filter_rows(
    source: &[f32],
    (src_base, src_stride): (usize, usize),
    target: &mut [f32],
    (dst_base, dst_stride): (usize, usize),
    row_len: usize,
    n: usize,
    c: &Coefficients,
    scratch: &mut Vec<f64>,
) {
    let src = |i: usize| &source[src_base + i * src_stride..][..row_len];
    if row_len == 1 {
        return filter_line(source, src_base, target, dst_base, n, c, scratch);
    }
    if n < 4 {
        for i in 0..n {
            target[dst_base + i * dst_stride..][..row_len].copy_from_slice(src(i));
        }
        return;
    }
    scratch.clear();
    scratch.resize((n + 6) * row_len, 0.0);
    let (causal, rest) = scratch.split_at_mut(n * row_len);
    let (ring, rest) = rest.split_at_mut(4 * row_len);
    let (zero, current) = rest.split_at_mut(row_len);
    // One fused pass per row: four input taps, four feedback taps. Feedback
    // taps that fall before the line start read a zero row with weight 0 and
    // charge the boundary term to the first input row instead (ITK's scheme).
    for i in 0..n {
        let (previous, current) = causal.split_at_mut(i * row_len);
        let out = &mut current[..row_len];
        let inputs: [&[f32]; 4] = std::array::from_fn(|k| src(i.saturating_sub(k)));
        let first = src(0);
        let mut feedback: [&[f64]; 4] = [&zero[..row_len]; 4];
        let mut weights = c.d;
        let mut boundary = 0.0;
        for k in 0..4 {
            if i > k {
                feedback[k] = &previous[(i - 1 - k) * row_len..][..row_len];
            } else {
                weights[k] = 0.0;
                boundary += c.bn[k];
            }
        }
        for x in 0..row_len {
            out[x] = c.n[0] * inputs[0][x] as f64
                + c.n[1] * inputs[1][x] as f64
                + c.n[2] * inputs[2][x] as f64
                + c.n[3] * inputs[3][x] as f64
                - boundary * first[x] as f64
                - weights[0] * feedback[0][x]
                - weights[1] * feedback[1][x]
                - weights[2] * feedback[2][x]
                - weights[3] * feedback[3][x];
        }
    }
    for i in (0..n).rev() {
        let inputs: [&[f32]; 4] = std::array::from_fn(|k| src((i + 1 + k).min(n - 1)));
        let mut feedback: [&[f64]; 4] = [&zero[..row_len]; 4];
        let mut weights = c.d;
        let mut boundary = 0.0;
        for k in 0..4 {
            if i + 1 + k < n {
                let slot = ((i + 1 + k) % 4) * row_len;
                feedback[k] = &ring[slot..slot + row_len];
            } else {
                weights[k] = 0.0;
                boundary += c.bm[k];
            }
        }
        let out = &mut target[dst_base + i * dst_stride..][..row_len];
        let forward = &causal[i * row_len..][..row_len];
        let slot = (i % 4) * row_len;
        // The ring slot being written is never among the feedback rows, so
        // compute into a spare row first to satisfy the borrow checker.
        for x in 0..row_len {
            let backward = c.m[0] * inputs[0][x] as f64
                + c.m[1] * inputs[1][x] as f64
                + c.m[2] * inputs[2][x] as f64
                + c.m[3] * inputs[3][x] as f64
                - boundary * inputs[3][x] as f64
                - weights[0] * feedback[0][x]
                - weights[1] * feedback[1][x]
                - weights[2] * feedback[2][x]
                - weights[3] * feedback[3][x];
            current[x] = backward;
            out[x] = (forward[x] + backward) as f32;
        }
        ring[slot..slot + row_len].copy_from_slice(current);
    }
}

/// Scalar form of `filter_rows` for contiguous x lines (one sample per row).
fn filter_line(
    source: &[f32],
    src_base: usize,
    target: &mut [f32],
    dst_base: usize,
    n: usize,
    c: &Coefficients,
    scratch: &mut Vec<f64>,
) {
    let input = &source[src_base..src_base + n];
    let output = &mut target[dst_base..dst_base + n];
    if n < 4 {
        output.copy_from_slice(input);
        return;
    }
    scratch.clear();
    scratch.resize(n, 0.0);
    let first = input[0] as f64;
    let last = input[n - 1] as f64;
    let tap = |i: usize| input[i] as f64;
    for i in 0..4_usize {
        let mut value = 0.0;
        for k in 0..4 {
            value += c.n[k] * tap(i.saturating_sub(k));
            value -= if i > k {
                c.d[k] * scratch[i - 1 - k]
            } else {
                c.bn[k] * first
            };
        }
        scratch[i] = value;
    }
    for i in 4..n {
        scratch[i] =
            c.n[0] * tap(i) + c.n[1] * tap(i - 1) + c.n[2] * tap(i - 2) + c.n[3] * tap(i - 3)
                - c.d[0] * scratch[i - 1]
                - c.d[1] * scratch[i - 2]
                - c.d[2] * scratch[i - 3]
                - c.d[3] * scratch[i - 4];
    }
    let mut ring = [0.0; 4];
    for i in (0..n).rev() {
        let value = if i + 4 < n {
            c.m[0] * tap(i + 1) + c.m[1] * tap(i + 2) + c.m[2] * tap(i + 3) + c.m[3] * tap(i + 4)
                - c.d[0] * ring[(i + 1) % 4]
                - c.d[1] * ring[(i + 2) % 4]
                - c.d[2] * ring[(i + 3) % 4]
                - c.d[3] * ring[i % 4]
        } else {
            let mut value = 0.0;
            for k in 0..4 {
                value += c.m[k] * tap((i + 1 + k).min(n - 1));
                value -= if i + 1 + k < n {
                    c.d[k] * ring[(i + 1 + k) % 4]
                } else {
                    c.bm[k] * last
                };
            }
            value
        };
        ring[i % 4] = value;
        output[i] = (scratch[i] + value) as f32;
    }
}

fn smooth_axis(
    source: &[f32],
    target: &mut [f32],
    dims: [usize; 3],
    axis: usize,
    coefficients: Coefficients,
) {
    let per_slab = dims[0] * dims[1];
    match axis {
        // x lines are single contiguous rows of one sample each; y lines within
        // a z slab are rows of dims[0] samples spaced dims[0] apart.
        0 | 1 => {
            let (lines, row_len, stride, count) = if axis == 0 {
                (dims[1], 1, 1, dims[0])
            } else {
                (1, dims[0], dims[0], dims[1])
            };
            for_each_z(target, dims[2], |z, slab| {
                let mut scratch = Vec::new();
                for line in 0..lines {
                    let start = line * dims[0];
                    filter_rows(
                        source,
                        (z * per_slab + start, stride),
                        slab,
                        (start, stride),
                        row_len,
                        count,
                        &coefficients,
                        &mut scratch,
                    );
                }
            });
        }
        _ => {
            let rows = map_z(dims[1], |y| {
                let mut block = vec![0.0; dims[0] * dims[2]];
                let mut scratch = Vec::new();
                filter_rows(
                    source,
                    (y * dims[0], per_slab),
                    &mut block,
                    (0, dims[0]),
                    dims[0],
                    dims[2],
                    &coefficients,
                    &mut scratch,
                );
                block
            });
            for (y, block) in rows.into_iter().enumerate() {
                for (z, row) in block.chunks_exact(dims[0]).enumerate() {
                    let start = dims[0] * (y + dims[1] * z);
                    target[start..start + dims[0]].copy_from_slice(row);
                }
            }
        }
    }
}

/// ITK-compatible zero-order recursive Gaussian with edge-extension
/// boundaries. `sigma_vox` is sigma in the corresponding axis's voxel units.
pub(crate) fn smooth_data(data: &[f32], dims: [usize; 3], sigma_vox: [f64; 3]) -> Vec<f32> {
    let mut data = data.to_vec();
    let mut buffer = vec![0.0; data.len()];
    for (axis, sigma) in sigma_vox.into_iter().enumerate() {
        if let Some(coefficients) = coefficients(sigma) {
            smooth_axis(&data, &mut buffer, dims, axis, coefficients);
            std::mem::swap(&mut data, &mut buffer);
        }
    }
    data
}

pub fn smooth(image: &NiftiImage, sigma_vox: [f64; 3]) -> Result<NiftiImage> {
    Ok(NiftiImage {
        grid: image.grid.clone(),
        data: smooth_data(&image.data, image.grid.dims, sigma_vox),
        scalar_type: image.scalar_type,
    })
}
