// ponytail: loops mirror the JS port index for index; clamp differs from max/min only for NaN, which is rejected earlier.
#![allow(clippy::needless_range_loop, clippy::manual_clamp)]
// SynthSR spatial/intensity contract, ported from packages/synthsr/src/volume.js.
// Arithmetic is f64 with f32 storage at the same points as the JS, so results match bit for bit.
use crate::nifti::{product, Affine, Volume};
use neurodesk_nifti::affine::ras_axes;

#[inline]
fn index(x: usize, y: usize, z: usize, d: &[usize; 3]) -> usize {
    x + d[0] * (y + d[1] * z)
}

fn reflect(i: isize, n: isize) -> usize {
    let p = ((i % (2 * n)) + 2 * n) % (2 * n);
    (if p < n { p } else { 2 * n - 1 - p }) as usize
}

// scipy.ndimage.gaussian_filter: separable, reflect boundaries, truncate=4.
pub fn gaussian(data: &[f32], dims: &[usize; 3], sigmas: [f64; 3]) -> Vec<f32> {
    let mut current: Vec<f32> = data.to_vec();
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
        let mut out = vec![0f32; data.len()];
        let stride = [1, dims[0], dims[0] * dims[1]][axis];
        let n = dims[axis] as isize;
        for z in 0..dims[2] {
            for y in 0..dims[1] {
                for x in 0..dims[0] {
                    let pos = [x, y, z][axis];
                    let base = index(x, y, z, dims) - pos * stride;
                    let mut value = 0.0f64;
                    for k in -radius..=radius {
                        value += current[base + reflect(pos as isize + k, n) * stride] as f64
                            * kernel[(k + radius) as usize]
                            / sum;
                    }
                    out[index(x, y, z, dims)] = value as f32;
                }
            }
        }
        current = out;
    }
    current
}

pub fn resample_1mm(v: &Volume<f32>) -> Result<Volume<f32>, String> {
    let (data, dims, affine) = (&v.data, &v.dims, &v.affine);
    let factors: [f64; 3] = std::array::from_fn(|a| {
        (0..3)
            .fold(0.0, |s, r| s + affine[r][a] * affine[r][a])
            .sqrt()
    });
    if factors.iter().any(|&s| !(0.05..=20.0).contains(&s)) {
        return Err("Voxel spacing is outside the supported range (0.05–20 mm).".into());
    }
    // Match NumPy arange(start, stop, step), including its endpoint rounding.
    let starts = factors.map(|f| -(f - 1.0) / (2.0 * f));
    let steps = factors.map(|f| 1.0 / f);
    let shape: [usize; 3] = std::array::from_fn(|a| {
        (((starts[a] + steps[a] * (dims[a] as f64 * factors[a]).ceil()) - starts[a]) / steps[a])
            .ceil() as usize
    });
    if product(&shape) > 48 * 1024 * 1024 {
        return Err(
            "The 1 mm output is too large. Crop excess background before synthesis.".into(),
        );
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
    let mut out = vec![0f32; product(&shape)];
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
                let lerp =
                    |b: usize| filtered[b + x0] as f64 * (1.0 - tx) + filtered[b + x1] as f64 * tx;
                let (v00, v10, v01, v11) = (lerp(b00), lerp(b10), lerp(b01), lerp(b11));
                out[index(x, y, z, &shape)] = ((v00 * (1.0 - ty) + v10 * ty) * (1.0 - tz)
                    + (v01 * (1.0 - ty) + v11 * ty) * tz)
                    as f32;
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
        affine: aff,
    })
}

pub struct Prepared {
    pub input: Vec<f32>,
    pub padded: [usize; 3],
    pub aligned: [usize; 3],
    pub offsets: [usize; 3],
    pub axes: [usize; 3],
    pub flips: [bool; 3],
    pub dims: [usize; 3],
    pub affine: Affine,
}

pub fn prepare(v: &Volume<f32>, ct: bool) -> Result<Prepared, String> {
    let r = resample_1mm(v)?;
    let axes = ras_axes(&r.affine)?;
    let flips: [bool; 3] = std::array::from_fn(|i| r.affine[i][axes[i]] < 0.0);
    let aligned = axes.map(|a| r.dims[a]);
    let padded = aligned.map(|s| s.div_ceil(32) * 32);
    let offsets: [usize; 3] = std::array::from_fn(|a| (padded[a] - aligned[a]) / 2);
    let mut input = vec![0f32; product(&padded)];
    let has_padding = input.len() > r.data.len();
    let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
    for x in 0..aligned[0] {
        for y in 0..aligned[1] {
            for z in 0..aligned[2] {
                let mut src = [0usize; 3];
                for (a, p) in [x, y, z].into_iter().enumerate() {
                    src[axes[a]] = if flips[a] { aligned[a] - 1 - p } else { p };
                }
                let mut val = r.data[index(src[0], src[1], src[2], &r.dims)] as f64;
                if ct {
                    val = val.max(0.0).min(80.0);
                }
                input[((x + offsets[0]) * padded[1] + y + offsets[1]) * padded[2]
                    + z
                    + offsets[2]] = val as f32;
                min = min.min(val);
                max = max.max(val);
            }
        }
    }
    if max <= min {
        return Err("The input has no intensity variation after preprocessing.".into());
    }
    if has_padding {
        min = min.min(0.0);
        max = max.max(0.0);
    }
    for v in input.iter_mut() {
        *v = ((*v as f64 - min) / (max - min)) as f32;
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
    })
}

pub fn flip_input(input: &[f32], dims: &[usize; 3]) -> Vec<f32> {
    let slab = dims[1] * dims[2];
    let mut out = vec![0f32; input.len()];
    for x in 0..dims[0] {
        out[(dims[0] - 1 - x) * slab..(dims[0] - x) * slab]
            .copy_from_slice(&input[x * slab..(x + 1) * slab]);
    }
    out
}

pub fn finish(prediction: &[f32], p: &Prepared, sharpen: bool) -> Volume<u8> {
    let (d, pd, o) = (&p.aligned, &p.padded, &p.offsets);
    let mut aligned = vec![0f32; product(d)];
    for x in 0..d[0] {
        for y in 0..d[1] {
            for z in 0..d[2] {
                aligned[index(x, y, z, d)] =
                    prediction[((x + o[0]) * pd[1] + y + o[1]) * pd[2] + z + o[2]];
            }
        }
    }
    if sharpen {
        let smooth = gaussian(&aligned, d, [1.5; 3]);
        for (a, s) in aligned.iter_mut().zip(&smooth) {
            *a = (2.0 * *a as f64 - *s as f64) as f32;
        }
    }
    let mut data = vec![0u8; product(&p.dims)];
    for x in 0..d[0] {
        for y in 0..d[1] {
            for z in 0..d[2] {
                let mut dst = [0usize; 3];
                for (a, v) in [x, y, z].into_iter().enumerate() {
                    dst[p.axes[a]] = if p.flips[a] { d[a] - 1 - v } else { v };
                }
                // numpy uint8 conversion truncates, it does not round.
                data[index(dst[0], dst[1], dst[2], &p.dims)] =
                    (2.0 * aligned[index(x, y, z, d)] as f64)
                        .max(0.0)
                        .min(255.0) as u8;
            }
        }
    }
    Volume {
        data,
        dims: p.dims,
        affine: p.affine,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_constant_images_before_padding() {
        for size in [2, 32] {
            for value in [-5.0, 0.0, 5.0] {
                let v = Volume {
                    data: vec![value; size * size * size],
                    dims: [size; 3],
                    affine: [[1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 1., 0.]],
                };
                assert!(prepare(&v, false).err().unwrap().contains("variation"));
            }
        }
        let v = Volume {
            data: (0..8).map(|i| 100.0 + i as f32).collect(),
            dims: [2; 3],
            affine: [[1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 1., 0.]],
        };
        assert!(prepare(&v, true).err().unwrap().contains("variation"));
        assert!(prepare(&v, false).is_ok());
    }
}
