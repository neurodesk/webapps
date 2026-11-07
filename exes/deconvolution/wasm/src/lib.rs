//! wasm-bindgen surface of deconvolution-core. Volumes are `[z][y][x]` (x fastest) and
//! dimensions are given as `[nz, ny, nx]`.

use deconvolution_core::psf::{psf_volume, Microscope, Modality, PsfSpec};
use deconvolution_core::rl;
use wasm_bindgen::prelude::*;

fn dims3(values: &[u32], what: &str) -> Result<[usize; 3], JsError> {
    match values {
        [z, y, x] => Ok([*z as usize, *y as usize, *x as usize]),
        _ => Err(JsError::new(&format!("{what} dimensions must be [nz, ny, nx]"))),
    }
}

/// The scalar Gibson-Lanni PSF on a centred `nz x xy_size x xy_size` grid, peak 1.
/// `excitation_um` > 0 gives the confocal product of excitation and emission PSFs; 0 gives
/// the widefield emission PSF. The coverslip and working distance keep psfmodels' defaults
/// (170 um of index 1.515, 150 um); the immersion design and experimental indices are both `ni`.
#[wasm_bindgen(js_name = gibsonLanniPsf)]
#[allow(clippy::too_many_arguments)]
pub fn gibson_lanni_psf(
    na: f64,
    ni: f64,
    ns: f64,
    emission_um: f64,
    excitation_um: f64,
    dxy: f64,
    dz: f64,
    xy_size: u32,
    nz: u32,
    pz: f64,
) -> Result<Vec<f64>, JsError> {
    let finite = [na, ni, ns, emission_um, excitation_um, dxy, dz, pz].iter().all(|v| v.is_finite());
    if !finite || na <= 0.0 || na >= ni || ns <= 0.0 || emission_um <= 0.0 || excitation_um < 0.0 || dxy <= 0.0 || dz <= 0.0 || pz < 0.0 {
        return Err(JsError::new("PSF parameters must be finite, positive, with NA below the immersion index"));
    }
    if xy_size == 0 || nz == 0 || xy_size.is_multiple_of(2) || nz.is_multiple_of(2) {
        return Err(JsError::new("PSF dimensions must be odd and positive"));
    }
    let microscope = Microscope { na, ni, ni0: ni, ns, ..Microscope::default() };
    let modality = if excitation_um > 0.0 { Modality::Confocal { excitation_um } } else { Modality::Widefield };
    Ok(psf_volume(&PsfSpec { microscope, modality, emission_um, dxy, dz, xy_size: xy_size as usize, nz: nz as usize, pz }))
}

/// The padded FFT grid `[nz, ny, nx]` a deconvolution of these sizes uses.
#[wasm_bindgen(js_name = paddedDims)]
pub fn padded_dims(image_dims: &[u32], psf_dims: &[u32]) -> Result<Vec<u32>, JsError> {
    let padded = rl::padded_dims(dims3(image_dims, "image")?, dims3(psf_dims, "PSF")?);
    Ok(padded.iter().map(|&n| n as u32).collect())
}

/// Richardson-Lucy (RL-TV when `tv_weight` > 0), one iteration per `iterate` call so the
/// caller can report progress and stop between iterations.
#[wasm_bindgen]
pub struct Deconvolver {
    inner: rl::RichardsonLucy,
}

#[wasm_bindgen]
impl Deconvolver {
    #[wasm_bindgen(constructor)]
    pub fn new(image: &[f64], dims: &[u32], psf: &[f64], psf_dims: &[u32], tv_weight: f64) -> Result<Deconvolver, JsError> {
        let inner = rl::RichardsonLucy::new(image, dims3(dims, "image")?, psf, dims3(psf_dims, "PSF")?, tv_weight)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Deconvolver { inner })
    }

    pub fn iterate(&mut self, count: u32) {
        for _ in 0..count {
            self.inner.iterate();
        }
    }

    pub fn iterations(&self) -> u32 {
        self.inner.iterations() as u32
    }

    pub fn estimate(&self) -> Vec<f64> {
        self.inner.estimate().to_vec()
    }
}
