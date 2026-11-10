//! Widefield and confocal 3D deconvolution for packages/deconvolution: a theoretical
//! Gibson-Lanni PSF by direct integration (`psf`), real 3D FFTs (`fft3`) and
//! Richardson-Lucy with optional total-variation regularisation (`rl`).

pub mod fft3;
pub mod psf;
pub mod rl;
