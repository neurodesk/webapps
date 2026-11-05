//! Real-to-complex 3D FFTs on a `[z][y][x]` volume (x fastest): realfft along x, then rustfft
//! along y and z on the half spectrum. Unnormalised in both directions, like FFTW.

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

pub type C64 = Complex<f64>;

/// The smallest `n >= target` whose only prime factors are 2, 3 and 5, as
/// `scipy.fft.next_fast_len` for real transforms.
pub fn next_fast_len(target: usize) -> usize {
    let mut n = target.max(1);
    loop {
        let mut m = n;
        for p in [2, 3, 5] {
            while m.is_multiple_of(p) {
                m /= p;
            }
        }
        if m == 1 {
            return n;
        }
        n += 1;
    }
}

pub struct Fft3 {
    /// Dimensions `[nz, ny, nx]` of the real volume.
    pub dims: [usize; 3],
    /// Length of each half-spectrum row, `nx / 2 + 1`.
    pub half: usize,
    r2c: Arc<dyn RealToComplex<f64>>,
    c2r: Arc<dyn ComplexToReal<f64>>,
    forward_y: Arc<dyn Fft<f64>>,
    inverse_y: Arc<dyn Fft<f64>>,
    forward_z: Arc<dyn Fft<f64>>,
    inverse_z: Arc<dyn Fft<f64>>,
    lines: Vec<C64>,
    scratch: Vec<C64>,
}

impl Fft3 {
    pub fn new(dims: [usize; 3]) -> Self {
        let [nz, ny, nx] = dims;
        let mut real = RealFftPlanner::<f64>::new();
        let mut complex = FftPlanner::<f64>::new();
        let r2c = real.plan_fft_forward(nx);
        let c2r = real.plan_fft_inverse(nx);
        let forward_y = complex.plan_fft_forward(ny);
        let inverse_y = complex.plan_fft_inverse(ny);
        let forward_z = complex.plan_fft_forward(nz);
        let inverse_z = complex.plan_fft_inverse(nz);
        let half = nx / 2 + 1;
        let scratch_len = [
            r2c.get_scratch_len(),
            c2r.get_scratch_len(),
            forward_y.get_inplace_scratch_len(),
            inverse_y.get_inplace_scratch_len(),
            forward_z.get_inplace_scratch_len(),
            inverse_z.get_inplace_scratch_len(),
        ]
        .into_iter()
        .max()
        .unwrap_or(0);
        Fft3 {
            dims,
            half,
            r2c,
            c2r,
            forward_y,
            inverse_y,
            forward_z,
            inverse_z,
            lines: vec![C64::default(); half * ny.max(nz)],
            scratch: vec![C64::default(); scratch_len],
        }
    }

    /// Number of complex values in the half spectrum.
    pub fn spectrum_len(&self) -> usize {
        self.dims[0] * self.dims[1] * self.half
    }

    /// Forward transform. `input` is used as scratch and left unspecified.
    pub fn forward(&mut self, input: &mut [f64], output: &mut [C64]) {
        let [nz, ny, nx] = self.dims;
        let half = self.half;
        for (row_in, row_out) in input.chunks_exact_mut(nx).zip(output.chunks_exact_mut(half)) {
            self.r2c
                .process_with_scratch(row_in, row_out, &mut self.scratch)
                .expect("row lengths match the plan");
        }
        self.along_y(output, ny, true);
        self.along_z(output, nz, ny, true);
    }

    /// Inverse transform, unnormalised. `input` is used as scratch and left unspecified.
    pub fn inverse(&mut self, input: &mut [C64], output: &mut [f64]) {
        let [nz, ny, nx] = self.dims;
        let half = self.half;
        self.along_z(input, nz, ny, false);
        self.along_y(input, ny, false);
        for (row_in, row_out) in input.chunks_exact_mut(half).zip(output.chunks_exact_mut(nx)) {
            // A Hermitian spectrum has real DC and Nyquist terms; drop rounding residue.
            row_in[0].im = 0.0;
            if nx.is_multiple_of(2) {
                row_in[half - 1].im = 0.0;
            }
            self.c2r
                .process_with_scratch(row_in, row_out, &mut self.scratch)
                .expect("row lengths match the plan");
        }
    }

    fn along_y(&mut self, data: &mut [C64], ny: usize, forward: bool) {
        let half = self.half;
        let plan = if forward { &self.forward_y } else { &self.inverse_y };
        let lines = &mut self.lines[..half * ny];
        for plane in data.chunks_exact_mut(ny * half) {
            for y in 0..ny {
                for k in 0..half {
                    lines[k * ny + y] = plane[y * half + k];
                }
            }
            plan.process_with_scratch(lines, &mut self.scratch);
            for y in 0..ny {
                for k in 0..half {
                    plane[y * half + k] = lines[k * ny + y];
                }
            }
        }
    }

    fn along_z(&mut self, data: &mut [C64], nz: usize, ny: usize, forward: bool) {
        let half = self.half;
        let plan = if forward { &self.forward_z } else { &self.inverse_z };
        let lines = &mut self.lines[..half * nz];
        let plane = ny * half;
        for y in 0..ny {
            for z in 0..nz {
                let row = &data[z * plane + y * half..z * plane + (y + 1) * half];
                for (k, value) in row.iter().enumerate() {
                    lines[k * nz + z] = *value;
                }
            }
            plan.process_with_scratch(lines, &mut self.scratch);
            for z in 0..nz {
                let row = &mut data[z * plane + y * half..z * plane + (y + 1) * half];
                for (k, value) in row.iter_mut().enumerate() {
                    *value = lines[k * nz + z];
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_lengths_are_5_smooth() {
        assert_eq!(next_fast_len(1), 1);
        assert_eq!(next_fast_len(7), 8);
        assert_eq!(next_fast_len(286), 288);
        assert_eq!(next_fast_len(71), 72);
        assert_eq!(next_fast_len(97), 100);
    }

    #[test]
    fn round_trip_on_odd_and_even_lengths() {
        for dims in [[5, 6, 7], [4, 9, 10], [1, 3, 8], [3, 1, 1]] {
            let n: usize = dims.iter().product();
            let original: Vec<f64> = (0..n).map(|i| ((i * 7919) % 101) as f64 / 13.0 - 3.0).collect();
            let mut fft = Fft3::new(dims);
            let mut work = original.clone();
            let mut spectrum = vec![C64::default(); fft.spectrum_len()];
            fft.forward(&mut work, &mut spectrum);
            // The DC term is the sum.
            let sum: f64 = original.iter().sum();
            assert!((spectrum[0].re - sum).abs() < 1e-9 && spectrum[0].im.abs() < 1e-9);
            let mut back = vec![0.0; n];
            fft.inverse(&mut spectrum, &mut back);
            for (a, b) in original.iter().zip(&back) {
                assert!((a - b / n as f64).abs() < 1e-12, "{dims:?}");
            }
        }
    }

    #[test]
    fn matches_a_direct_dft_bin() {
        let dims = [3, 4, 5];
        let n: usize = dims.iter().product();
        let data: Vec<f64> = (0..n).map(|i| (i as f64 * 0.37).sin()).collect();
        let mut fft = Fft3::new(dims);
        let mut spectrum = vec![C64::default(); fft.spectrum_len()];
        fft.forward(&mut data.clone(), &mut spectrum);
        let (kz, ky, kx) = (2usize, 1usize, 2usize);
        let mut want = C64::default();
        for z in 0..3 {
            for y in 0..4 {
                for x in 0..5 {
                    let angle = -2.0 * std::f64::consts::PI * ((kz * z) as f64 / 3.0 + (ky * y) as f64 / 4.0 + (kx * x) as f64 / 5.0);
                    want += C64::new(angle.cos(), angle.sin()) * data[(z * 4 + y) * 5 + x];
                }
            }
        }
        let got = spectrum[(kz * 4 + ky) * fft.half + kx];
        assert!((got - want).norm() < 1e-12, "{got} vs {want}");
    }
}
