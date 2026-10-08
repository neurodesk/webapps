// ponytail: loops mirror the Python index for index.
#![allow(clippy::needless_range_loop, clippy::manual_clamp)]
// SynthSeg preprocess() port: resample to 1 mm, align to RAS, percentile rescale, pad.
// Arithmetic is f64 like the NumPy reference; the model input is stored as f32 at the end.
use crate::nifti::{product, Affine, Volume};
use neurodesk_nifti::affine::ras_axes;

/// NIfTI memory order: x fastest.
#[inline]
pub fn ni(x: usize, y: usize, z: usize, d: &[usize; 3]) -> usize {
    x + d[0] * (y + d[1] * z)
}
/// Model tensor order (NDHWC / NCDHW spatial): z fastest.
#[inline]
pub fn mi(x: usize, y: usize, z: usize, d: &[usize; 3]) -> usize {
    (x * d[1] + y) * d[2] + z
}

fn reflect(i: isize, n: isize) -> usize {
    let p = ((i % (2 * n)) + 2 * n) % (2 * n);
    (if p < n { p } else { 2 * n - 1 - p }) as usize
}

// scipy.ndimage.gaussian_filter: separable, reflect boundaries, truncate=4.
pub fn gaussian(data: &[f64], dims: &[usize; 3], sigmas: [f64; 3]) -> Vec<f64> {
    let mut current: Vec<f64> = data.to_vec();
    for axis in 0..3 {
        let sigma = sigmas[axis];
        let radius = (4.0 * sigma + 0.5).floor() as isize;
        if sigma < 1e-15 || radius == 0 {
            continue;
        }
        let kernel: Vec<f64> = (0..=2 * radius)
            .map(|i| (-0.5 * ((i - radius) as f64 / sigma).powi(2)).exp())
            .collect();
        let sum: f64 = kernel.iter().sum();
        let mut out = vec![0f64; data.len()];
        let stride = [1, dims[0], dims[0] * dims[1]][axis];
        let n = dims[axis] as isize;
        for z in 0..dims[2] {
            for y in 0..dims[1] {
                for x in 0..dims[0] {
                    let pos = [x, y, z][axis];
                    let base = ni(x, y, z, dims) - pos * stride;
                    let mut value = 0.0f64;
                    for k in -radius..=radius {
                        value += current[base + reflect(pos as isize + k, n) * stride]
                            * kernel[(k + radius) as usize]
                            / sum;
                    }
                    out[ni(x, y, z, dims)] = value;
                }
            }
        }
        current = out;
    }
    current
}

// SynthSeg resample_volume(volume, aff, [1,1,1]): blur when downsampling, linear interpolation on
// the NumPy arange grid, coordinates clamped to the volume.
pub fn resample_1mm(v: &Volume<f64>) -> Result<Volume<f64>, String> {
    let (data, dims, affine) = (&v.data, &v.dims, &v.affine);
    let factors: [f64; 3] = std::array::from_fn(|a| {
        (0..3)
            .fold(0.0, |s, r| s + affine[r][a] * affine[r][a])
            .sqrt()
    });
    if factors.iter().any(|&s| !(0.05..=20.0).contains(&s)) {
        return Err("Voxel spacing is outside the supported range (0.05–20 mm).".into());
    }
    let starts = factors.map(|f| -(f - 1.0) / (2.0 * f));
    let steps = factors.map(|f| 1.0 / f);
    let shape: [usize; 3] = std::array::from_fn(|a| {
        (((starts[a] + steps[a] * (dims[a] as f64 * factors[a]).ceil()) - starts[a]) / steps[a])
            .ceil() as usize
    });
    if product(&shape) > 64 * 1024 * 1024 {
        return Err("The 1 mm image is too large.".into());
    }
    let filtered = gaussian(
        data,
        dims,
        factors.map(|f| if f > 1.0 { 0.0 } else { 0.25 / f }),
    );
    let coords: Vec<Vec<f64>> = (0..3)
        .map(|a| {
            (0..shape[a])
                .map(|i| {
                    (starts[a] + i as f64 * ((starts[a] + steps[a]) - starts[a]))
                        .max(0.0)
                        .min((dims[a] - 1) as f64)
                })
                .collect()
        })
        .collect();
    let mut out = vec![0f64; product(&shape)];
    for z in 0..shape[2] {
        let fz = coords[2][z];
        let z0 = fz.floor() as usize;
        let z1 = (z0 + 1).min(dims[2] - 1);
        let tz = fz - z0 as f64;
        for y in 0..shape[1] {
            let fy = coords[1][y];
            let y0 = fy.floor() as usize;
            let y1 = (y0 + 1).min(dims[1] - 1);
            let ty = fy - y0 as f64;
            let b00 = dims[0] * (y0 + dims[1] * z0);
            let b10 = dims[0] * (y1 + dims[1] * z0);
            let b01 = dims[0] * (y0 + dims[1] * z1);
            let b11 = dims[0] * (y1 + dims[1] * z1);
            for x in 0..shape[0] {
                let fx = coords[0][x];
                let x0 = fx.floor() as usize;
                let x1 = (x0 + 1).min(dims[0] - 1);
                let tx = fx - x0 as f64;
                let lerp = |b: usize| filtered[b + x0] * (1.0 - tx) + filtered[b + x1] * tx;
                let (v00, v10, v01, v11) = (lerp(b00), lerp(b10), lerp(b01), lerp(b11));
                out[ni(x, y, z, &shape)] =
                    (v00 * (1.0 - ty) + v10 * ty) * (1.0 - tz) + (v01 * (1.0 - ty) + v11 * ty) * tz;
            }
        }
    }
    let mut aff = *affine;
    for r in 0..3 {
        for a in 0..3 {
            aff[r][a] /= factors[a];
        }
        aff[r][3] -= (0..3).fold(0.0, |v, a| v + aff[r][a] * 0.5 * (factors[a] - 1.0));
    }
    Ok(Volume {
        data: out,
        dims: shape,
        pixdim: [1.0; 3],
        affine: aff,
        codes: [0, 2], // nibabel: qform unknown, sform aligned, when the affine changed
        units: v.units,
    })
}

pub struct Prepared {
    /// Padded model input, `mi` order.
    pub input: Vec<f32>,
    pub padded: [usize; 3],
    pub aligned: [usize; 3],
    pub offsets: [usize; 3],
    pub axes: [usize; 3],
    pub flips: [bool; 3],
    /// 1 mm volume in the input axis order: the output geometry.
    pub dims: [usize; 3],
    pub affine: Affine,
    pub codes: [i16; 2],
    pub units: u8,
}

// np.percentile(v, p) with linear interpolation; two order statistics via selection, not a full sort.
fn percentile(v: &mut [f64], p: f64) -> f64 {
    let pos = p / 100.0 * (v.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = (lo + 1).min(v.len() - 1);
    let cmp = |a: &f64, b: &f64| a.partial_cmp(b).unwrap();
    let (_, &mut x_lo, rest) = v.select_nth_unstable_by(lo, cmp);
    let x_hi = if hi > lo {
        *rest.select_nth_unstable_by(0, cmp).1
    } else {
        x_lo
    };
    // numpy's _lerp switches form at t >= 0.5 to stay monotonic; match it bit for bit.
    let t = pos - lo as f64;
    if t < 0.5 {
        x_lo + (x_hi - x_lo) * t
    } else {
        x_hi - (x_hi - x_lo) * (1.0 - t)
    }
}

pub fn prepare(v: &Volume<f64>, ct: bool) -> Result<Prepared, String> {
    let resampled;
    let r = if v.pixdim.iter().any(|&p| !(0.95..=1.05).contains(&p)) {
        resampled = resample_1mm(v)?;
        &resampled
    } else {
        v
    };
    let axes = ras_axes(&r.affine)?;
    let flips: [bool; 3] = std::array::from_fn(|i| r.affine[i][axes[i]] < 0.0);
    let aligned = axes.map(|a| r.dims[a]);
    let padded = aligned.map(|s| s.div_ceil(32) * 32).map(|s| s.max(128));
    if product(&padded) > 64 * 1024 * 1024 || aligned.iter().any(|&s| s > i16::MAX as usize) {
        return Err("The 1 mm image is too large.".into());
    }
    let mut im = vec![0f64; product(&aligned)];
    for x in 0..aligned[0] {
        for y in 0..aligned[1] {
            for z in 0..aligned[2] {
                let mut src = [0usize; 3];
                for (a, p) in [x, y, z].into_iter().enumerate() {
                    src[axes[a]] = if flips[a] { aligned[a] - 1 - p } else { p };
                }
                let val = r.data[ni(src[0], src[1], src[2], &r.dims)];
                im[mi(x, y, z, &aligned)] = if ct { val.max(0.0).min(80.0) } else { val };
            }
        }
    }
    let mut scratch = im.clone();
    let (min, max) = (
        percentile(&mut scratch, 0.5),
        percentile(&mut scratch, 99.5),
    );
    drop(scratch);
    let offsets: [usize; 3] = std::array::from_fn(|a| (padded[a] - aligned[a]) / 2);
    let mut input = vec![0f32; product(&padded)];
    for x in 0..aligned[0] {
        for y in 0..aligned[1] {
            for z in 0..aligned[2] {
                let val = im[mi(x, y, z, &aligned)].max(min).min(max);
                let scaled = if max > min {
                    (val - min) / (max - min)
                } else {
                    0.0
                };
                input[mi(x + offsets[0], y + offsets[1], z + offsets[2], &padded)] = scaled as f32;
            }
        }
    }
    Ok(Prepared {
        input,
        padded,
        aligned,
        offsets,
        axes,
        flips,
        dims: r.dims,
        affine: r.affine,
        codes: r.codes,
        units: r.units,
    })
}

/// Flip along the first model axis (SynthSeg RandomFlip(flip_axis=0)).
pub fn flip_x(input: &[f32], dims: &[usize; 3]) -> Vec<f32> {
    let slab = dims[1] * dims[2];
    let mut out = vec![0f32; input.len()];
    for x in 0..dims[0] {
        out[(dims[0] - 1 - x) * slab..(dims[0] - x) * slab]
            .copy_from_slice(&input[x * slab..(x + 1) * slab]);
    }
    out
}

/// Aligned-space labels (`mi` order over `p.aligned`) back to the input axis order.
pub fn restore(labels: &[i32], p: &Prepared) -> Volume<i32> {
    let d = &p.aligned;
    let mut data = vec![0i32; product(&p.dims)];
    for x in 0..d[0] {
        for y in 0..d[1] {
            for z in 0..d[2] {
                let mut dst = [0usize; 3];
                for (a, v) in [x, y, z].into_iter().enumerate() {
                    dst[p.axes[a]] = if p.flips[a] { d[a] - 1 - v } else { v };
                }
                data[ni(dst[0], dst[1], dst[2], &p.dims)] = labels[mi(x, y, z, d)];
            }
        }
    }
    Volume {
        data,
        dims: p.dims,
        pixdim: [1.0; 3],
        affine: p.affine,
        codes: p.codes,
        units: p.units,
    }
}
