// SPDX-License-Identifier: Apache-2.0
// Ports NiFreeze code: Copyright The NiPreps Developers <nipreps@gmail.com> (LICENSE-NIFREEZE).
//! NiFreeze 3bcfb00's GP DWI model (`--models gp`): the leave-one-out fit and prediction of
//! each diffusion-weighted volume, on top of the `dwi-gp` crate.
//!
//! The parts and their sources (NiFreeze 3bcfb00, Apache-2.0):
//!
//! | Here | NiFreeze |
//! | --- | --- |
//! | [`read_gradients`] | `data/dmri/io.py:100-111`: `np.loadtxt(..., dtype="float32")` of the bvec and bval files |
//! | [`DwiSeries::split`] | `data/dmri/base.py:158-182`: the b0 split (`B0Rule::NiFreeze`, `b <= 50`) and `bzero` as the median of the b0 volumes |
//! | [`data_mask`] | `model/dmri.py:58-96` `_compute_data_mask`, called by `BaseDWIModel.__init__` (`dmri.py:249-254`) |
//! | [`GpModel::fit`], [`GpModel::fit_predict`] | `model/dmri.py` `GPModel._fit` and `GPModel.fit_predict`, with `model/_dipy.py` `GaussianProcessModel` |
//! | [`clip_prediction`] | `registration/ants.py:83-87` `_to_nifti`: `advanced_clip(data, inplace=True)` |
//!
//! # Memory layout
//!
//! Volumes are NIfTI buffers: x varies fastest, then y, then z, then the volume.
//! The targets of the GP are the voxels of the data mask in NumPy's C order of the
//! `(x, y, z)` array (`data[mask]`): x varies slowest and z fastest.
//!
//! # In-place changes that NiFreeze makes
//!
//! - `_compute_data_mask` writes `False` into `dataset.brainmask` where `bzero < 1e-5`. NiFreeze
//!   then writes that mask to `brainmask.nii.gz` and gives it to every registration as
//!   `--masks`. Thus [`GpModel::data_mask`] is also the registration mask of a GP run. The
//!   trivial model does not make this change.
//! - The prediction is a float64 volume, so the clip in `_to_nifti` overwrites it with the
//!   0-255 map ([`clip_prediction`]). Each prediction is a new array, so this has no effect on
//!   other volumes.
//!
//! # Validation
//!
//! `tests/gp_reference.rs` compares the model with NiFreeze's GP run of the M0 reference
//! (`hmc/reference/`, ds005577 sub-107): `bzero`, the data mask (161668 voxels), the fitted
//! hyperparameters and the 90 clipped predictions. It runs only when `HMC_REFERENCE` names the
//! folder, and it needs a release build (`cargo test --release`). On x86-64 Linux all 90
//! predictions are equal to NiFreeze's in every voxel; the run takes about 2 minutes and
//! 420 MiB.

use crate::clip::{ClipError, ClipReport, advanced_clip_in_place};
use dwi_gp::kernel::Params;
use dwi_gp::lbfgsb::OptimizeResult;
use dwi_gp::{FitError, GaussianProcess};
use dwi_gradients::RuledGradients;
use std::fmt;

/// `DEFAULT_MIN_S0` (`data/dmri/utils.py`): a voxel with a smaller `bzero` is not fitted.
pub const DEFAULT_MIN_S0: f64 = 1e-5;

/// `DTI_MIN_ORIENTATIONS` (`data/dmri/utils.py:48`): `BaseDWIModel.__init__` refuses a series
/// with fewer diffusion-weighted volumes.
pub const DTI_MIN_ORIENTATIONS: usize = 6;

/// Why the model cannot be made or run.
#[derive(Clone, Debug, PartialEq)]
pub enum ModelError {
    /// The data, mask or gradient lengths do not agree with the grid.
    Shape(String),
    /// Fewer than [`DTI_MIN_ORIENTATIONS`] diffusion-weighted volumes.
    TooFewVolumes(usize),
    /// The left-out index is not a diffusion-weighted volume of the series.
    Index { index: usize, volumes: usize },
    /// The data mask has no voxel.
    EmptyMask,
    /// The GP fit or prediction failed.
    Fit(FitError),
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ModelError::Shape(s) => f.write_str(s),
            ModelError::TooFewVolumes(n) => {
                write!(f, "DWI dataset is too small ({n} directions).")
            }
            ModelError::Index { index, volumes } => {
                write!(f, "volume {index} is not in a series of {volumes} volumes")
            }
            ModelError::EmptyMask => f.write_str("the data mask has no voxel"),
            ModelError::Fit(e) => write!(f, "GP: {e}"),
        }
    }
}

impl std::error::Error for ModelError {}

impl From<FitError> for ModelError {
    fn from(e: FitError) -> Self {
        ModelError::Fit(e)
    }
}

/// Reads FSL bval and bvec text as `np.loadtxt(..., dtype="float32")` does, and widens each
/// value to f64 (`format_gradients` casts the table to float64). NumPy converts the text to a
/// double and then rounds it to float32, so this parses to f64 and then rounds.
///
/// The bvec text is 3 rows of n values, or n rows of 3 values (`io.py:105-107` transposes
/// a table with 3 rows and not 3 columns). Give the result to `B0Rule::NiFreeze.read`.
pub fn read_gradients(bval: &str, bvec: &str) -> Result<(Vec<f64>, Vec<[f64; 3]>), String> {
    let rows = |text: &str| -> Result<Vec<Vec<f64>>, String> {
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                line.split_whitespace()
                    .map(|v| {
                        v.parse::<f64>()
                            .map(|x| x as f32 as f64)
                            .map_err(|_| format!("{v:?} is not a number"))
                    })
                    .collect()
            })
            .collect()
    };
    let bvals = rows(bval)?.concat();
    let table = rows(bvec)?;
    let n = bvals.len();
    let bvecs: Vec<[f64; 3]> = if table.len() == 3 && table.iter().all(|r| r.len() == n) {
        (0..n)
            .map(|i| [table[0][i], table[1][i], table[2][i]])
            .collect()
    } else if table.len() == n && table.iter().all(|r| r.len() == 3) {
        table.iter().map(|r| [r[0], r[1], r[2]]).collect()
    } else {
        return Err(format!(
            "the bvec file is not a 3 x {n} or {n} x 3 table for {n} b-values"
        ));
    };
    Ok((bvals, bvecs))
}

/// The diffusion-weighted part of a series and its `bzero`, as NiFreeze's `DWI` object holds
/// them after `__attrs_post_init__` (`data/dmri/base.py:158-182`).
#[derive(Clone, Debug)]
pub struct DwiSeries<T> {
    /// (nx, ny, nz).
    pub shape: [usize; 3],
    /// The diffusion-weighted volumes, in their order in the input. NIfTI order.
    pub dwi: Vec<T>,
    /// Their directions, from the gradient table (`dataset.gradients[:, :3]`).
    pub bvecs: Vec<[f64; 3]>,
    /// Their b-values.
    pub bvals: Vec<f64>,
    /// The index in the input series of each diffusion-weighted volume.
    pub dwi_volumes: Vec<usize>,
    /// The index in the input series of each b0 volume.
    pub b0_volumes: Vec<usize>,
    /// The median of the b0 volumes for each voxel, or `None` when the series has no b0.
    pub bzero: Option<Vec<f64>>,
}

impl<T: Copy + Into<f64>> DwiSeries<T> {
    /// Splits a 4-D series (NIfTI order, `shape` × volumes) with a gradient table read by a
    /// `B0Rule` (NiFreeze's rule is `B0Rule::NiFreeze`). `bzero` is `np.median` of the b0
    /// volumes over the volume axis, in float64: the middle value of an odd count, the mean of
    /// the two middle values of an even count. One b0 volume is used as it is.
    pub fn split(
        data: &[T],
        shape: [usize; 3],
        gradients: &RuledGradients,
    ) -> Result<Self, ModelError> {
        let nvox = voxel_count(shape)?;
        let nvol = gradients.len();
        if nvol.checked_mul(nvox) != Some(data.len()) {
            return Err(ModelError::Shape(format!(
                "{} values do not fill {nvol} volumes of {shape:?}",
                data.len()
            )));
        }
        let b0_volumes = gradients.b0_volumes();
        let dwi_volumes = gradients.dwi_volumes();
        let bzero = if b0_volumes.is_empty() {
            None
        } else {
            let mut column = vec![0.0f64; b0_volumes.len()];
            let mut bzero = vec![0.0f64; nvox];
            for (v, out) in bzero.iter_mut().enumerate() {
                for (c, &b) in column.iter_mut().zip(&b0_volumes) {
                    *c = data[b * nvox + v].into();
                }
                *out = median(&mut column);
            }
            Some(bzero)
        };
        let mut dwi = Vec::with_capacity(dwi_volumes.len() * nvox);
        for &v in &dwi_volumes {
            dwi.extend_from_slice(&data[v * nvox..(v + 1) * nvox]);
        }
        Ok(DwiSeries {
            shape,
            dwi,
            bvecs: dwi_volumes.iter().map(|&v| gradients.bvecs[v]).collect(),
            bvals: dwi_volumes.iter().map(|&v| gradients.bvals[v]).collect(),
            dwi_volumes,
            b0_volumes,
            bzero,
        })
    }

    /// The number of diffusion-weighted volumes (`len(dataset)`).
    pub fn len(&self) -> usize {
        self.bvecs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bvecs.is_empty()
    }
}

/// `np.median` of a column (`numpy/lib/_function_base_impl.py`): NaN propagates; otherwise the middle
/// value, or the mean of the two middle values, `(a + b) / 2` as `np.mean` gives it.
fn median(column: &mut [f64]) -> f64 {
    if column.iter().any(|value| value.is_nan()) {
        return f64::NAN;
    }
    column.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = column.len();
    if n % 2 == 1 {
        column[n / 2]
    } else {
        (column[n / 2 - 1] + column[n / 2]) / 2.0
    }
}

fn voxel_count(shape: [usize; 3]) -> Result<usize, ModelError> {
    shape
        .iter()
        .try_fold(1usize, |n, &a| if a == 0 { None } else { n.checked_mul(a) })
        .ok_or_else(|| ModelError::Shape(format!("{shape:?} is not a grid")))
}

/// `_compute_data_mask` with `ignore_bzero=False`: the brain mask (all voxels when there is
/// none), with `False` where `bzero < DEFAULT_MIN_S0`. NIfTI order.
pub fn data_mask(nvox: usize, brainmask: Option<&[bool]>, bzero: Option<&[f64]>) -> Vec<bool> {
    let mut mask = brainmask.map_or_else(|| vec![true; nvox], <[bool]>::to_vec);
    if let Some(bzero) = bzero {
        for (m, &b) in mask.iter_mut().zip(bzero) {
            if b < DEFAULT_MIN_S0 {
                *m = false;
            }
        }
    }
    mask
}

/// The fitted hyperparameters of one leave-one-out fit.
#[derive(Clone, Debug)]
pub struct FitSummary {
    /// `kernel_.theta`: ln(a, lambda, sigma2).
    pub theta: [f64; 3],
    /// `kernel.bounds`, in log space.
    pub bounds_log: [(f64, f64); 3],
    /// exp(theta): the kernel is `SphericalKriging(a, lambda) + WhiteKernel(sigma2)`.
    pub params: Params,
    /// `log_marginal_likelihood_value_`.
    pub lml: f64,
    /// The optimizer result.
    pub result: OptimizeResult,
}

impl FitSummary {
    /// Whether hyperparameter `k` (0 = a, 1 = lambda, 2 = sigma2) is close to its lower bound,
    /// which is when scikit-learn warns "close to the specified lower bound". The test is
    /// scikit-learn's `_check_bounds_params`: `np.isclose(bounds, theta)` in log space, with
    /// NumPy's default tolerances.
    pub fn at_lower_bound(&self, k: usize) -> bool {
        is_close(self.bounds_log[k].0, self.theta[k])
    }
}

/// `np.isclose(a, b)` with NumPy's defaults: |a - b| <= atol + rtol * |b|.
fn is_close(a: f64, b: f64) -> bool {
    const RTOL: f64 = 1e-5;
    const ATOL: f64 = 1e-8;
    a == b || (a - b).abs() <= ATOL + RTOL * b.abs()
}

/// One leave-one-out prediction.
#[derive(Clone, Debug)]
pub struct Prediction {
    /// The float64 volume that `fit_predict` returns (NIfTI order): the GP posterior mean in
    /// the data mask, 0 elsewhere. [`clip_prediction`] turns it into the registration target.
    pub volume: Vec<f64>,
    /// The fit that made it.
    pub fit: FitSummary,
}

/// NiFreeze's `GPModel` over one series.
#[derive(Clone, Debug)]
pub struct GpModel<'a, T> {
    series: &'a DwiSeries<T>,
    mask: Vec<bool>,
    /// The data-mask voxels, in NumPy's C order of the (x, y, z) array, as NIfTI indices.
    voxels: Vec<usize>,
    gp: GaussianProcess,
}

impl<'a, T: Copy + Into<f64>> GpModel<'a, T> {
    /// `GPModel(dataset)` with NiFreeze's defaults: the spherical kernel, `beta_a = 0.1`,
    /// `beta_l = 2.0`, `sigma_sq = 1.0` (`dwi_gp::GaussianProcess::default()`).
    ///
    /// `brainmask` is in NIfTI order; NiFreeze reads the mask file as `bool`, so any nonzero
    /// value counts. The data mask is computed here, once, as NiFreeze does when it makes the
    /// model.
    pub fn new(series: &'a DwiSeries<T>, brainmask: Option<&[bool]>) -> Result<Self, ModelError> {
        Self::with_gp(series, brainmask, GaussianProcess::default())
    }

    /// As [`GpModel::new`], with other GP settings.
    pub fn with_gp(
        series: &'a DwiSeries<T>,
        brainmask: Option<&[bool]>,
        gp: GaussianProcess,
    ) -> Result<Self, ModelError> {
        let [nx, ny, nz] = series.shape;
        let nvox = voxel_count(series.shape)?;
        if nvox.checked_mul(series.len()) != Some(series.dwi.len())
            || series.bvals.len() != series.len()
        {
            return Err(ModelError::Shape(
                "the series data and gradients do not agree".into(),
            ));
        }
        if brainmask.is_some_and(|m| m.len() != nvox)
            || series.bzero.as_ref().is_some_and(|b| b.len() != nvox)
        {
            return Err(ModelError::Shape(format!(
                "the brain mask or bzero is not a {:?} volume",
                series.shape
            )));
        }
        if series.len() < DTI_MIN_ORIENTATIONS {
            return Err(ModelError::TooFewVolumes(series.len()));
        }
        let mask = data_mask(nvox, brainmask, series.bzero.as_deref());
        let mut voxels = Vec::new();
        for x in 0..nx {
            for y in 0..ny {
                for z in 0..nz {
                    let v = x + nx * (y + ny * z);
                    if mask[v] {
                        voxels.push(v);
                    }
                }
            }
        }
        if voxels.is_empty() {
            return Err(ModelError::EmptyMask);
        }
        Ok(GpModel {
            series,
            mask,
            voxels,
            gp,
        })
    }

    /// The data mask (NIfTI order). NiFreeze writes it into `dataset.brainmask`, so it is also
    /// the `--masks` image of every registration of the run.
    pub fn data_mask(&self) -> &[bool] {
        &self.mask
    }

    /// The number of fitted voxels (GP targets).
    pub fn voxel_count(&self) -> usize {
        self.voxels.len()
    }

    /// `GPModel._fit(index)`: one GP on all diffusion-weighted volumes except `index`, both
    /// shells together. X is their b-vectors; y holds the data-mask voxels, in the data type of
    /// the series. `index` counts diffusion-weighted volumes only, as NiFreeze does.
    pub fn fit(&self, index: usize) -> Result<dwi_gp::Fit, ModelError> {
        let n = self.series.len();
        if index >= n {
            return Err(ModelError::Index { index, volumes: n });
        }
        let nvox = voxel_count(self.series.shape)?;
        let x: Vec<[f64; 3]> = (0..n)
            .filter(|&v| v != index)
            .map(|v| self.series.bvecs[v])
            .collect();
        let mut y: Vec<T> = Vec::with_capacity(self.voxels.len() * (n - 1));
        for &p in &self.voxels {
            for v in (0..n).filter(|&v| v != index) {
                y.push(self.series.dwi[v * nvox + p]);
            }
        }
        Ok(self.gp.fit(&x, &y)?)
    }

    /// `GPModel.fit_predict(index)`: the leave-one-out fit, then the posterior mean at the
    /// direction of `index`, scattered into a float64 volume of zeros.
    pub fn fit_predict(&self, index: usize) -> Result<Prediction, ModelError> {
        let fit = self.fit(index)?;
        let mean = fit.predict(&[self.series.bvecs[index]])?;
        let mut volume = vec![0.0f64; self.mask.len()];
        for (&p, &m) in self.voxels.iter().zip(&mean) {
            volume[p] = m;
        }
        let summary = FitSummary {
            theta: fit.theta,
            bounds_log: fit.bounds_log,
            params: fit.params(),
            lml: fit.lml,
            result: fit.result.clone(),
        };
        Ok(Prediction {
            volume,
            fit: summary,
        })
    }
}

/// `_to_nifti(predicted, ..., clip=True)`: `advanced_clip(data, inplace=True)` on the float64
/// prediction, which overwrites it with the 0-255 map (still float64). `shape` is (nx, ny, nz)
/// of the NIfTI-order volume.
pub fn clip_prediction(volume: &mut [f64], shape: [usize; 3]) -> Result<ClipReport, ClipError> {
    let [nx, ny, nz] = shape;
    advanced_clip_in_place(volume, [nz, ny, nx])
}

#[cfg(test)]
mod tests {
    use super::is_close;

    #[test]
    fn is_close_follows_numpy_defaults() {
        let lower = 0.1_f64.ln();
        assert!(is_close(lower, lower));
        // A few ulps above the bound: scikit-learn still warns.
        assert!(is_close(lower, lower + 1e-12));
        // Inside atol + rtol * |theta| (about 2.3e-5 here).
        assert!(is_close(lower, lower + 2e-5));
        assert!(!is_close(lower, lower + 3e-5));
        assert!(!is_close(lower, lower + 0.1));
    }
}
