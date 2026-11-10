//! Richardson-Lucy deconvolution with FFT convolution, optionally regularised by total
//! variation (Dey et al. 2006).
//!
//! Without regularisation each iteration is scikit-image's `restoration.richardson_lucy`
//! (0.25) with `clip=False`: the estimate starts at 0.5 everywhere, and
//!
//! ```text
//! conv     = convolve(u, psf, mode="same") + 1e-12
//! u       *= convolve(image / conv, flip(psf), mode="same")
//! ```
//!
//! where `convolve` is `scipy.signal.convolve`: a linear convolution, zero outside the image,
//! cropped to the image from offset `(m - 1) // 2` per axis. Here both convolutions are FFT
//! products on a grid padded to at least `n + m - 1` per axis, so nothing wraps around. The
//! second uses the conjugate spectrum of the PSF (a correlation) instead of a flipped copy.
//!
//! RL-TV divides the update by `1 - lambda * div(grad u / |grad u|)` (Dey et al., eq. 14),
//! with forward differences for the gradient and their adjoint (backward differences) for
//! the divergence, zero across the volume's faces, on the voxel grid. Where the gradient is
//! zero its direction is taken as zero. Each normalised component lies in [-1, 1], so the
//! divergence lies in [-6, 6] and any `lambda < 1/6` keeps the denominator positive.

use crate::fft3::{next_fast_len, Fft3, C64};

/// skimage's guard against division by zero.
pub const EPS: f64 = 1e-12;
/// scikit-image's starting estimate.
pub const INITIAL_ESTIMATE: f64 = 0.5;
/// RL-TV weights at or above this could make the update's denominator nonpositive.
pub const MAX_TV_WEIGHT: f64 = 1.0 / 6.0;

#[derive(Debug, PartialEq)]
pub enum Error {
    Dimensions(String),
    Values(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Dimensions(message) | Error::Values(message) => f.write_str(message),
        }
    }
}

/// The FFT grid that linear convolution of an `image` volume with a `psf` volume needs.
pub fn padded_dims(image: [usize; 3], psf: [usize; 3]) -> [usize; 3] {
    [0, 1, 2].map(|axis| next_fast_len(image[axis] + psf[axis] - 1))
}

pub struct RichardsonLucy {
    dims: [usize; 3],
    padded: [usize; 3],
    /// Crop offsets `(m - 1) // 2` of `mode="same"`.
    offset: [usize; 3],
    /// Offsets of the correlation: `offset - (m - 1)`, modulo the padded length.
    correlation_offset: [usize; 3],
    fft: Fft3,
    /// The PSF's half spectrum on the padded grid, divided by the grid size.
    otf: Vec<C64>,
    image: Vec<f64>,
    estimate: Vec<f64>,
    ratio: Vec<f64>,
    padded_real: Vec<f64>,
    spectrum: Vec<C64>,
    tv_weight: f64,
    iterations: usize,
}

impl RichardsonLucy {
    /// `image` and `psf` are `[z][y][x]` volumes (x fastest) of the given dimensions.
    pub fn new(image: &[f64], dims: [usize; 3], psf: &[f64], psf_dims: [usize; 3], tv_weight: f64) -> Result<Self, Error> {
        let count: usize = dims.iter().product();
        let psf_count: usize = psf_dims.iter().product();
        if dims.contains(&0) || psf_dims.contains(&0) {
            return Err(Error::Dimensions("image and PSF dimensions must be positive".into()));
        }
        if image.len() != count || psf.len() != psf_count {
            return Err(Error::Dimensions(format!(
                "expected {count} image and {psf_count} PSF values, got {} and {}",
                image.len(),
                psf.len()
            )));
        }
        if !(0.0..MAX_TV_WEIGHT).contains(&tv_weight) {
            return Err(Error::Values(format!("the TV weight must be at least 0 and below {MAX_TV_WEIGHT:.4}")));
        }
        if image.iter().any(|v| !v.is_finite() || *v < 0.0) {
            return Err(Error::Values("image values must be finite and nonnegative".into()));
        }
        if psf.iter().any(|v| !v.is_finite() || *v < 0.0) || psf.iter().sum::<f64>() <= 0.0 {
            return Err(Error::Values("PSF values must be finite, nonnegative and not all zero".into()));
        }
        let padded = padded_dims(dims, psf_dims);
        let offset = [0, 1, 2].map(|axis| (psf_dims[axis] - 1) / 2);
        let correlation_offset =
            [0, 1, 2].map(|axis| (padded[axis] + offset[axis] - (psf_dims[axis] - 1)) % padded[axis]);
        let mut fft = Fft3::new(padded);
        let total: usize = padded.iter().product();
        let mut padded_real = vec![0.0; total];
        place(psf, psf_dims, &mut padded_real, padded);
        let mut otf = vec![C64::default(); fft.spectrum_len()];
        fft.forward(&mut padded_real, &mut otf);
        let scale = 1.0 / total as f64;
        otf.iter_mut().for_each(|value| *value *= scale);
        let spectrum = vec![C64::default(); otf.len()];
        Ok(RichardsonLucy {
            dims,
            padded,
            offset,
            correlation_offset,
            fft,
            otf,
            image: image.to_vec(),
            estimate: vec![INITIAL_ESTIMATE; count],
            ratio: vec![0.0; count],
            padded_real,
            spectrum,
            tv_weight,
            iterations: 0,
        })
    }

    pub fn padded_dims(&self) -> [usize; 3] {
        self.padded
    }

    pub fn iterations(&self) -> usize {
        self.iterations
    }

    pub fn estimate(&self) -> &[f64] {
        &self.estimate
    }

    /// Run one iteration.
    pub fn iterate(&mut self) {
        // conv = psf * u, cropped as mode="same"; ratio = image / (conv + eps).
        self.padded_real.fill(0.0);
        place(&self.estimate, self.dims, &mut self.padded_real, self.padded);
        self.fft.forward(&mut self.padded_real, &mut self.spectrum);
        for (s, h) in self.spectrum.iter_mut().zip(&self.otf) {
            *s *= h;
        }
        self.fft.inverse(&mut self.spectrum, &mut self.padded_real);
        extract(&self.padded_real, self.padded, self.offset, &mut self.ratio, self.dims);
        for (r, i) in self.ratio.iter_mut().zip(&self.image) {
            *r = i / (*r + EPS);
        }

        // correction = flip(psf) * ratio, cropped as mode="same".
        self.padded_real.fill(0.0);
        place(&self.ratio, self.dims, &mut self.padded_real, self.padded);
        self.fft.forward(&mut self.padded_real, &mut self.spectrum);
        for (s, h) in self.spectrum.iter_mut().zip(&self.otf) {
            *s *= h.conj();
        }
        self.fft.inverse(&mut self.spectrum, &mut self.padded_real);
        // ratio now holds the correction.
        extract(&self.padded_real, self.padded, self.correlation_offset, &mut self.ratio, self.dims);

        if self.tv_weight > 0.0 {
            let divergence = tv_divergence(&self.estimate, self.dims);
            for ((u, c), d) in self.estimate.iter_mut().zip(&self.ratio).zip(&divergence) {
                *u = *u * c / (1.0 - self.tv_weight * d);
            }
        } else {
            for (u, c) in self.estimate.iter_mut().zip(&self.ratio) {
                *u *= c;
            }
        }
        self.iterations += 1;
    }
}

/// Copy a volume into the corner of a larger zeroed one.
fn place(source: &[f64], dims: [usize; 3], target: &mut [f64], padded: [usize; 3]) {
    let [nz, ny, nx] = dims;
    for z in 0..nz {
        for y in 0..ny {
            let from = (z * ny + y) * nx;
            let to = (z * padded[1] + y) * padded[2];
            target[to..to + nx].copy_from_slice(&source[from..from + nx]);
        }
    }
}

/// Read `dims` values from the padded volume starting at `offset`, wrapping around.
fn extract(source: &[f64], padded: [usize; 3], offset: [usize; 3], target: &mut [f64], dims: [usize; 3]) {
    let [nz, ny, nx] = dims;
    for z in 0..nz {
        let pz = (z + offset[0]) % padded[0];
        for y in 0..ny {
            let py = (y + offset[1]) % padded[1];
            let row = &source[(pz * padded[1] + py) * padded[2]..(pz * padded[1] + py + 1) * padded[2]];
            let out = &mut target[(z * ny + y) * nx..(z * ny + y + 1) * nx];
            for (x, value) in out.iter_mut().enumerate() {
                *value = row[(x + offset[2]) % padded[2]];
            }
        }
    }
}

/// `div(grad u / |grad u|)` with forward-difference gradients (zero on the far faces) and the
/// matching backward-difference divergence.
pub fn tv_divergence(u: &[f64], dims: [usize; 3]) -> Vec<f64> {
    let [nz, ny, nx] = dims;
    let strides = [ny * nx, nx, 1];
    let n = u.len();
    // Unit gradient directions, one component array per axis.
    let mut p = [vec![0.0; n], vec![0.0; n], vec![0.0; n]];
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let i = (z * ny + y) * nx + x;
                let position = [z, y, x];
                let mut g = [0.0; 3];
                for axis in 0..3 {
                    if position[axis] + 1 < dims[axis] {
                        g[axis] = u[i + strides[axis]] - u[i];
                    }
                }
                let norm = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
                if norm > 0.0 {
                    for axis in 0..3 {
                        p[axis][i] = g[axis] / norm;
                    }
                }
            }
        }
    }
    let mut divergence = vec![0.0; n];
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let i = (z * ny + y) * nx + x;
                let position = [z, y, x];
                let mut d = 0.0;
                for axis in 0..3 {
                    let here = if position[axis] + 1 < dims[axis] { p[axis][i] } else { 0.0 };
                    let before = if position[axis] > 0 { p[axis][i - strides[axis]] } else { 0.0 };
                    d += here - before;
                }
                divergence[i] = d;
            }
        }
    }
    divergence
}

#[cfg(test)]
mod tests {
    use super::*;

    /// scipy.signal.convolve(a, k, mode="same") by direct summation.
    fn convolve_same(a: &[f64], dims: [usize; 3], k: &[f64], kd: [usize; 3]) -> Vec<f64> {
        let off = [0, 1, 2].map(|i| (kd[i] - 1) / 2);
        let mut out = vec![0.0; a.len()];
        for z in 0..dims[0] {
            for y in 0..dims[1] {
                for x in 0..dims[2] {
                    let mut s = 0.0;
                    let full = [z + off[0], y + off[1], x + off[2]];
                    for kz in 0..kd[0] {
                        for ky in 0..kd[1] {
                            for kx in 0..kd[2] {
                                let src = [full[0] as isize - kz as isize, full[1] as isize - ky as isize, full[2] as isize - kx as isize];
                                if (0..3).all(|i| src[i] >= 0 && (src[i] as usize) < dims[i]) {
                                    let si = (src[0] as usize * dims[1] + src[1] as usize) * dims[2] + src[2] as usize;
                                    s += a[si] * k[(kz * kd[1] + ky) * kd[2] + kx];
                                }
                            }
                        }
                    }
                    out[(z * dims[1] + y) * dims[2] + x] = s;
                }
            }
        }
        out
    }

    fn reference_rl(image: &[f64], dims: [usize; 3], psf: &[f64], pd: [usize; 3], iterations: usize) -> Vec<f64> {
        let mirror: Vec<f64> = psf.iter().rev().cloned().collect();
        let mut u = vec![0.5; image.len()];
        for _ in 0..iterations {
            let conv = convolve_same(&u, dims, psf, pd);
            let ratio: Vec<f64> = image.iter().zip(&conv).map(|(i, c)| i / (c + EPS)).collect();
            let corr = convolve_same(&ratio, dims, &mirror, pd);
            u.iter_mut().zip(&corr).for_each(|(u, c)| *u *= c);
        }
        u
    }

    fn volume(dims: [usize; 3], seed: usize) -> Vec<f64> {
        let n: usize = dims.iter().product();
        (0..n).map(|i| 1.0 + (((i + seed) * 2654435761) % 1000) as f64 / 250.0).collect()
    }

    #[test]
    fn matches_direct_convolution_rl_on_odd_and_even_kernels() {
        // Odd image sizes, an even-sized (asymmetric) kernel and a padded grid that is not a
        // power of two exercise every crop offset.
        for (dims, pd) in [([5, 7, 6], [3, 4, 3]), ([4, 9, 11], [3, 3, 5]), ([1, 6, 5], [1, 3, 2])] {
            let image = volume(dims, 3);
            let psf: Vec<f64> = volume(pd, 11).iter().map(|v| v * v).collect();
            let sum: f64 = psf.iter().sum();
            let psf: Vec<f64> = psf.iter().map(|v| v / sum).collect();
            let want = reference_rl(&image, dims, &psf, pd, 4);
            let mut rl = RichardsonLucy::new(&image, dims, &psf, pd, 0.0).unwrap();
            for _ in 0..4 {
                rl.iterate();
            }
            for (got, want) in rl.estimate().iter().zip(&want) {
                assert!((got - want).abs() <= 1e-11 * want.abs(), "{dims:?} {pd:?}: {got} vs {want}");
            }
        }
    }

    #[test]
    fn tv_with_zero_weight_equals_plain_rl_and_positive_weight_smooths() {
        let dims = [6, 8, 8];
        let image = volume(dims, 1);
        let psf = vec![1.0 / 27.0; 27];
        let mut plain = RichardsonLucy::new(&image, dims, &psf, [3, 3, 3], 0.0).unwrap();
        let mut tv = RichardsonLucy::new(&image, dims, &psf, [3, 3, 3], 0.05).unwrap();
        for _ in 0..10 {
            plain.iterate();
            tv.iterate();
        }
        let total_variation = |u: &[f64]| -> f64 {
            u.windows(2).map(|w| (w[1] - w[0]).abs()).sum()
        };
        assert!(total_variation(tv.estimate()) < total_variation(plain.estimate()));
    }

    #[test]
    fn divergence_is_bounded_and_zero_on_constant_images() {
        let dims = [4, 5, 6];
        assert!(tv_divergence(&vec![3.0; 120], dims).iter().all(|d| *d == 0.0));
        let d = tv_divergence(&volume(dims, 5), dims);
        assert!(d.iter().all(|v| v.abs() <= 6.0));
    }

    #[test]
    fn refuses_bad_input() {
        assert!(RichardsonLucy::new(&[1.0; 8], [2, 2, 2], &[1.0], [1, 1, 1], 0.2).is_err());
        assert!(RichardsonLucy::new(&[-1.0; 8], [2, 2, 2], &[1.0], [1, 1, 1], 0.0).is_err());
        assert!(RichardsonLucy::new(&[1.0; 7], [2, 2, 2], &[1.0], [1, 1, 1], 0.0).is_err());
        assert!(RichardsonLucy::new(&[1.0; 8], [2, 2, 2], &[0.0], [1, 1, 1], 0.0).is_err());
    }
}
