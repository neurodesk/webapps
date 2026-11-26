//! The FID-A data structure.

use num_complex::Complex64;
use rustfft::FftPlanner;

/// FID-A `dims`: the 1-based position of each dimension in `sz`, 0 when absent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Dims {
    pub t: usize,
    pub coils: usize,
    pub averages: usize,
    pub sub_specs: usize,
    pub extras: usize,
}

/// FID-A `flags`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flags {
    pub writtentostruct: bool,
    pub gotparams: bool,
    pub leftshifted: bool,
    pub filtered: bool,
    pub zeropadded: bool,
    pub freqcorrected: bool,
    pub phasecorrected: bool,
    pub averaged: bool,
    pub addedrcvrs: bool,
    pub subtracted: bool,
    pub writtentotext: bool,
    pub downsampled: bool,
    pub avg_normalized: bool,
    pub is_four_steps: bool,
}

/// A FID-A structure. `fids` is stored column-major over `sz`, exactly as
/// MATLAB stores `out.fids`; `dims` says which axis is which.
#[derive(Clone, Debug, Default)]
pub struct Spectra {
    pub fids: Vec<Complex64>,
    /// MATLAB `size(fids)` (trailing singleton dimensions dropped, at least 2 entries).
    pub sz: Vec<usize>,
    pub dims: Dims,
    /// Frequency axis in ppm, as the FID-A reader computed it (length sz[0]).
    pub ppm: Vec<f64>,
    /// Time axis in s.
    pub t: Vec<f64>,
    /// Hz.
    pub spectralwidth: f64,
    /// s.
    pub dwelltime: f64,
    /// Transmitter frequency, Hz.
    pub txfrq: f64,
    /// Echo time, ms.
    pub te: f64,
    /// Mixing time, ms (STEAM; seconds in NIfTI-MRS until normalised).
    pub tm: Option<f64>,
    /// Repetition time, ms.
    pub tr: f64,
    /// Field strength, T.
    pub bo: f64,
    pub seq: String,
    pub date: String,
    pub averages: usize,
    pub raw_averages: usize,
    pub subspecs: usize,
    pub raw_subspecs: usize,
    pub points_to_leftshift: f64,
    pub flags: Flags,
    /// Nucleus, "1H" unless the reader says otherwise.
    pub nucleus: String,
}

impl Spectra {
    /// Number of time points.
    pub fn n(&self) -> usize {
        self.sz.first().copied().unwrap_or(0)
    }

    /// Size of a 1-based dimension position (1 if beyond `sz`, as MATLAB).
    pub fn size(&self, dim: usize) -> usize {
        if dim == 0 {
            1
        } else {
            self.sz.get(dim - 1).copied().unwrap_or(1)
        }
    }

    /// Number of FIDs (product of all dimensions after the first).
    pub fn n_fids(&self) -> usize {
        self.sz.iter().skip(1).product::<usize>().max(1)
    }

    /// FID number `k` (0-based, column-major over the non-time dimensions).
    pub fn fid(&self, k: usize) -> &[Complex64] {
        let n = self.n();
        &self.fids[k * n..(k + 1) * n]
    }

    pub fn fid_mut(&mut self, k: usize) -> &mut [Complex64] {
        let n = self.n();
        &mut self.fids[k * n..(k + 1) * n]
    }

    /// FID-A `specs`: `fftshift(ifft(fids, [], 1), 1)` for every FID.
    pub fn specs(&self) -> Vec<Complex64> {
        let n = self.n();
        let mut out = Vec::with_capacity(self.fids.len());
        for k in 0..self.n_fids() {
            out.extend(spec_of(self.fid(k)));
            let _ = n;
        }
        out
    }

    /// FID-A: `fids = fft(fftshift(specs, 1), [], 1)` for every spectrum.
    pub fn set_specs(&mut self, specs: &[Complex64]) {
        let n = self.n();
        for k in 0..self.n_fids() {
            let f = fid_of(&specs[k * n..(k + 1) * n]);
            self.fid_mut(k).copy_from_slice(&f);
        }
    }

    /// Drop trailing singleton dimensions from `sz` (MATLAB keeps at least 2).
    pub fn squeeze_sz(&mut self) {
        while self.sz.len() > 2 && *self.sz.last().unwrap() == 1 {
            self.sz.pop();
        }
    }
}

/// `fftshift(ifft(x))` (MATLAB ifft divides by N).
pub fn spec_of(fid: &[Complex64]) -> Vec<Complex64> {
    let n = fid.len();
    let mut buf = fid.to_vec();
    FftPlanner::new().plan_fft_inverse(n).process(&mut buf);
    let scale = 1.0 / n as f64;
    for v in buf.iter_mut() {
        *v *= scale;
    }
    fftshift(&buf)
}

/// `fft(fftshift(spec))`, the inverse of `spec_of` as FID-A writes it.
pub fn fid_of(spec: &[Complex64]) -> Vec<Complex64> {
    let n = spec.len();
    let mut buf = fftshift(spec);
    FftPlanner::new().plan_fft_forward(n).process(&mut buf);
    buf
}

/// MATLAB `fftshift` of a vector.
pub fn fftshift<T: Clone>(x: &[T]) -> Vec<T> {
    let n = x.len();
    let h = n / 2 + n % 2;
    let mut out = Vec::with_capacity(n);
    out.extend_from_slice(&x[h..]);
    out.extend_from_slice(&x[..h]);
    out
}

/// MATLAB `ifftshift` of a vector.
pub fn ifftshift<T: Clone>(x: &[T]) -> Vec<T> {
    let n = x.len();
    let h = n / 2;
    let mut out = Vec::with_capacity(n);
    out.extend_from_slice(&x[h..]);
    out.extend_from_slice(&x[..h]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_fid_round_trip() {
        let fid: Vec<Complex64> = (0..8).map(|k| Complex64::new(k as f64, -(k as f64) / 2.0)).collect();
        let back = fid_of(&spec_of(&fid));
        for (a, b) in fid.iter().zip(back.iter()) {
            assert!((a - b).norm() < 1e-12);
        }
        assert_eq!(fftshift(&[1, 2, 3, 4, 5]), vec![4, 5, 1, 2, 3]);
        assert_eq!(ifftshift(&[4, 5, 1, 2, 3]), vec![1, 2, 3, 4, 5]);
    }
}
