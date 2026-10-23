// SPDX-License-Identifier: Apache-2.0
//! SHORELine with an eddy-style estimation: head motion, eddy-current fields, a
//! susceptibility field and slice outliers of a diffusion series, estimated together
//! against model predictions, then one resampling.
//!
//! The method follows Andersson and Sotiropoulos 2016 (NeuroImage 125:1063-1078) and
//! Andersson et al. 2016 (NeuroImage 141:556-572), implemented from the papers; no FSL code
//! was read. Where FSL eddy predicts each volume with a Gaussian process, this uses
//! SHORELine's 3dSHORE leave-out prediction (`dwi-shore`) for diffusion-weighted volumes and
//! the mean of the other b0 volumes for b0 volumes.
//!
//! The forward model of volume i: a point m of the model (reference) space came from the
//! point q = M_i⁻¹(m) of the volume's own frame (M_i rigid), and was acquired at
//! x = q + d_i(q) along the phase-encoding (PE) axis, with
//! d_i = sign · readout_time · (field(m) + ec_i(q)) voxels: `field` the susceptibility field
//! (Hz, in model space: it moves with the head) and `ec_i` the volume's eddy-current field
//! (Hz, a polynomial in the scanner frame). The corrected image is
//! C_i(m) = J_i(q) · y_i(x), with J_i = 1 + ∂d_i/∂PE.
//!
//! Each iteration: correct every volume with the current parameters, predict each volume
//! from the others, and take Gauss-Newton steps on the squared difference between the
//! prediction and the corrected volume over the mask (analytic derivatives). Then the
//! eddy-current fields are replaced by the second-level model, the part of the field offset
//! that it does not explain is moved into the PE translation, and the parameters are
//! referred to volume 0. With outlier replacement, the slices whose observed signal is far
//! below the prediction (in the volume's own space) are replaced by the prediction.
//! Finally each diffusion shell's mean is aligned to the b0 mean by mutual information, and
//! every volume is resampled once (cubic B-spline, Jacobian modulation).

mod gp;
pub mod lsr;
pub mod mbs;
pub mod nifti;
mod peas;
pub mod rigid;
pub mod volume;

use dwi_ec_distortion::{Field, Model, SecondLevel};
use dwi_shore::TargetFit;
use dwi_slice_outliers::{OutlierMap, Params as OutlierParams, SliceGrid};
use rayon::prelude::*;
use rigid::{Mat3, Rigid};
use volume::Grid;

/// The phase encoding of one volume.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Acquisition {
    /// The voxel axis of the phase encoding.
    pub pe_axis: usize,
    /// +1 or -1: the direction along that axis in which a positive field moves the signal.
    pub pe_sign: f64,
    /// Total readout time (s). A volume with 0 has no distortion.
    pub readout_time: f64,
}

impl Acquisition {
    fn voxels_per_hz(&self) -> f64 {
        self.pe_sign * self.readout_time
    }
}

#[derive(Clone, Debug)]
pub struct Options {
    pub iterations: usize,
    /// Smoothing (FWHM, mm) of data and predictions per iteration; the last value repeats.
    pub fwhm: Vec<f64>,
    /// The eddy-current model of diffusion-weighted volumes (`None`: motion only).
    pub ec_model: Option<Model>,
    pub second_level: Option<SecondLevel>,
    /// Move the field offset not explained by the second-level model into the PE translation.
    pub separate_offset: bool,
    pub repol: bool,
    pub outliers: OutlierParams,
    pub outlier_type: OutlierType,
    /// Gauss-Newton steps per volume per iteration.
    pub gauss_newton_steps: usize,
    /// Gauss-Newton stops early once a step moves the volume less than this (mm).
    pub gn_tolerance: f64,
    /// The second-level model is linear in g · (b / b_max)^slm_power.
    pub slm_power: f64,
    /// Align each shell's mean to the b0 mean after the estimation.
    pub peas: bool,
    pub b0_threshold: f64,
    /// The slice (acquisition) axis.
    pub slice_axis: usize,
    /// Set voxels that some volume does not cover to 0 in the output.
    pub mask_output: bool,
    /// Interpolation during the estimation.
    pub interpolation: Interpolation,
    /// Huber weighting of the registration's residuals (robust to dropped slices and other
    /// artefacts); off: least squares, as eddy.
    pub robust: bool,
    /// Find and replace outlier slices in the coarse iterations too.
    pub coarse_repol: bool,
    /// Find and replace outlier slices once before the first iteration.
    pub initial_repol: bool,
    /// The final resampling (eddy's `--resamp`).
    pub resampling: Resampling,
    /// Regularisation of the least-squares restoration (eddy's `--lsr_lambda`).
    pub lsr_lambda: f64,
    /// How the diffusion-weighted volumes are predicted.
    pub model: PredictionModel,
    /// Factor on the Gaussian process's noise variance (eddy's `--ff`). `None`: 30, best or
    /// near best on all six small-scheme phantoms of `tools/eddy_benchmark.py` (6 to 30
    /// directions, b = 1000 and 2000); eddy's default is 10.
    pub gp_fudge: Option<f64>,
    /// Include each volume in its own Gaussian-process prediction (posterior mean at a noisy
    /// sample) rather than leaving it out.
    pub gp_include_target: bool,
    /// Weight of each diffusion-weighted volume's own corrected image in the prediction it is
    /// registered to (with 3dSHORE): a damping that keeps it from following the prediction's
    /// error.
    /// None: 0.3 for data that are not shelled (`SHELLED_AT_MOST`), else 0.
    pub self_weight: Option<f64>,
    /// The first of the `iterations` (0-based) that uses `self_weight`: the earlier ones make
    /// the large corrections, which damping would hold back.
    pub self_weight_from: usize,
    /// With 3dSHORE, take each volume's b0 term from the b0 volumes acquired around it rather
    /// than the session's b0 mean.
    pub local_b0: bool,
    /// Turn each volume's gradient direction by its estimated rotation for the predictions.
    pub rotate_gradients: bool,
    /// Fit only the eddy currents of the diffusion-weighted volumes in the first iteration
    /// with 3dSHORE too (always with the Gaussian process).
    pub first_ec_only: bool,
    /// Hold each shell's mean position to the b0 volumes' trajectory (see `anchor_shells`).
    pub anchor_shells: bool,
    /// Take the b0 volumes' PE trajectory out of the total PE shift before fitting the
    /// offset's second-level model.
    pub detrend_offset: bool,
    /// Iterations that estimate only the linear eddy-current terms (offset and gradients)
    /// before the quadratic ones. A large offset (tens of Hz, several voxels) is otherwise
    /// traded against the squared terms, which over a centred brain look like a constant.
    pub linear_iterations: usize,
    /// Smoothing (FWHM, mm) of extra coarse iterations before `iterations`, which bring large
    /// movements and field offsets within reach of the Gauss-Newton steps (eddy's
    /// documentation suggests a decreasing `--fwhm` for the same reason).
    pub coarse_fwhm: Vec<f64>,
    /// Slice-to-volume movement: the number of cosine orders (eddy's `--mporder`; 0: off).
    pub mporder: usize,
    /// Iterations with slice-to-volume movement after `iterations` (eddy's `--s2v_niter`).
    pub s2v_iterations: usize,
    /// Smoothness of the movement within a volume (eddy's `--s2v_lambda`).
    pub s2v_lambda: f64,
    /// Smoothing (FWHM, mm) in the slice-to-volume iterations (eddy's `--s2v_fwhm`).
    pub s2v_fwhm: f64,
    /// Estimate how the susceptibility field changes with rotations about x and y (eddy's
    /// `--estimate_move_by_susceptibility`); needs a field.
    pub mbs: bool,
    /// Smoothness of those fields (eddy's `--mbs_lambda`).
    pub mbs_lambda: f64,
    /// Their knot spacing, mm (eddy's `--mbs_ksp`).
    pub mbs_spacing: f64,
    /// Their updates (eddy's `--mbs_niter`).
    pub mbs_iterations: usize,
    /// Rounds of the fields' estimate, each followed by two iterations of the movement.
    pub mbs_rounds: usize,
}

/// What an outlier is (eddy's `--ol_type`): a slice, a multiband group of slices acquired
/// together (`Input::slice_groups`), or either.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutlierType {
    Slice,
    Group,
    Both,
}

/// The final resampling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resampling {
    /// Each volume on its own, with Jacobian modulation (`--resamp=jac`).
    Jacobian,
    /// Pairs with opposite phase-encoding polarities restored together (`--resamp=lsr`);
    /// volumes without a partner as `Jacobian`.
    LeastSquares,
}

/// How the diffusion-weighted volumes are predicted from each other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PredictionModel {
    /// 3dSHORE when there are enough volumes for its coefficients, else the Gaussian process.
    Auto,
    /// SHORELine's 3dSHORE leave-out prediction (QSIPrep 26.1.1).
    Shore,
    /// A Gaussian process over the gradients, as FSL eddy (`gp`).
    GaussianProcess,
}

/// How volumes are sampled during the estimation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interpolation {
    Trilinear,
    /// Cubic B-spline (eddy's default for the estimation).
    Spline,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            iterations: 5,
            fwhm: vec![0.0],
            ec_model: Some(Model::Quadratic),
            second_level: Some(SecondLevel::Linear),
            separate_offset: true,
            repol: false,
            outliers: OutlierParams::default(),
            outlier_type: OutlierType::Slice,
            gauss_newton_steps: 2,
            gn_tolerance: 0.05,
            slm_power: 1.0,
            peas: true,
            b0_threshold: 50.0,
            slice_axis: 2,
            mask_output: true,
            interpolation: Interpolation::Spline,
            robust: false,
            coarse_repol: true,
            initial_repol: true,
            resampling: Resampling::Jacobian,
            lsr_lambda: 0.01,
            model: PredictionModel::Auto,
            gp_fudge: None,
            gp_include_target: true,
            self_weight: None,
            self_weight_from: 2,
            local_b0: true,
            rotate_gradients: false,
            first_ec_only: false,
            anchor_shells: true,
            detrend_offset: true,
            linear_iterations: 1,
            coarse_fwhm: vec![8.0, 4.0],
            mporder: 0,
            s2v_iterations: 5,
            s2v_lambda: 1.0,
            s2v_fwhm: 0.0,
            mbs: false,
            mbs_lambda: 100.0,
            mbs_spacing: 10.0,
            mbs_iterations: 10,
            mbs_rounds: 0,
        }
    }
}

pub struct Input {
    pub grid: Grid,
    pub volumes: Vec<Vec<f32>>,
    pub bvals: Vec<f64>,
    /// Directions along the grid's voxel axes (FSL's vectors with x reversed for an affine
    /// with a positive determinant), the frame of the rigid transforms.
    pub bvecs: Vec<[f64; 3]>,
    pub mask: Vec<bool>,
    pub acquisitions: Vec<Acquisition>,
    /// The susceptibility field (Hz) on the grid, in the space of volume 0.
    pub field_hz: Option<Vec<f32>>,
    /// The acquisition time of each slice (along `Options::slice_axis`) within a volume, 0..1
    /// (from `--slspec` or `SliceTiming`); needed for slice-to-volume correction.
    pub slice_times: Option<Vec<f64>>,
    /// The slices acquired together (multiband groups), for group-wise outliers.
    pub slice_groups: Option<Vec<Vec<usize>>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VolumeParams {
    /// Volume frame to model space.
    pub rigid: Rigid,
    /// Eddy-current field coefficients (Hz), the terms of `dwi_ec_distortion::Model` on
    /// coordinates scaled to -1..1 over the grid. Empty for motion only.
    pub ec: Vec<f64>,
    /// Movement within the volume (slice-to-volume): coefficients of cos(π k τ), k = 1, 2,
    /// ..., for the 6 rigid parameters (translations, then rotations), with τ in 0..1 the
    /// time of a slice within the volume. Empty: the volume moves as a whole.
    pub s2v: Vec<[f64; 6]>,
}

impl VolumeParams {
    /// The rigid transform of a slice acquired at time `tau` (0..1 within the volume).
    pub fn rigid_at(&self, tau: f64) -> Rigid {
        let mut r = self.rigid;
        for (k, c) in self.s2v.iter().enumerate() {
            let phi = (std::f64::consts::PI * (k + 1) as f64 * tau).cos();
            for a in 0..3 {
                r.translation[a] += c[a] * phi;
                r.rotation[a] += c[3 + a] * phi;
            }
        }
        r
    }
}

pub struct Output {
    pub corrected: Vec<Vec<f32>>,
    /// The input volumes of each output volume: one, or a pair restored together
    /// (`Resampling::LeastSquares`).
    pub sources: Vec<Vec<usize>>,
    pub params: Vec<VolumeParams>,
    pub outliers: Option<OutlierMap>,
    /// Per diffusion shell: its b-value and the alignment applied (model to shell).
    pub peas: Vec<(f64, Rigid)>,
    /// RMS displacement over the mask relative to volume 0 and to the previous volume (mm).
    pub movement_rms: Vec<[f64; 2]>,
    /// Movement-by-susceptibility: the field's change (Hz per radian) about x and y.
    pub mbs_fields: Option<[Vec<f32>; 2]>,
}

/// The susceptibility field and its gradient (Hz per voxel along each axis).
struct FieldMap {
    hz: Vec<f32>,
    grad: [Vec<f32>; 3],
}

impl FieldMap {
    fn new(grid: &Grid, hz: Vec<f32>) -> Self {
        let grad = std::array::from_fn(|a| {
            let s = grid.stride(a);
            let n = grid.dims[a];
            (0..grid.voxels())
                .map(|v| {
                    let p = grid.ijk(v)[a];
                    if n < 2 {
                        return 0.0;
                    }
                    let lo = if p == 0 { v } else { v - s };
                    let hi = if p + 1 == n { v } else { v + s };
                    let span = ((p + 1).min(n - 1) - p.saturating_sub(1)) as f32;
                    (hz[hi] - hz[lo]) / span
                })
                .collect()
        });
        Self { hz, grad }
    }
}

/// The eddy-current terms at a continuous voxel position, and their derivative along `axis`.
fn ec_terms(model: Model, grid: &Grid, q: [f64; 3], axis: usize) -> ([f64; 10], [f64; 10]) {
    let mut u = [0.0; 3];
    let mut du = [0.0; 3];
    for a in 0..3 {
        let half = ((grid.dims[a] as f64 - 1.0) / 2.0).max(0.5);
        let centre = (grid.dims[a] as f64 - 1.0) / 2.0;
        u[a] = (q[a] - centre) / half;
        if a == axis {
            du[a] = 1.0 / half;
        }
    }
    let [x, y, z] = u;
    let [dx, dy, dz] = du;
    let mut t = [0.0; 10];
    let mut d = [0.0; 10];
    t[..4].copy_from_slice(&[1.0, x, y, z]);
    d[..4].copy_from_slice(&[0.0, dx, dy, dz]);
    if model == Model::Quadratic {
        t[4..].copy_from_slice(&[x * x, y * y, z * z, x * y, x * z, y * z]);
        d[4..].copy_from_slice(&[
            2.0 * x * dx,
            2.0 * y * dy,
            2.0 * z * dz,
            dx * y + x * dy,
            dx * z + x * dz,
            dy * z + y * dz,
        ]);
    }
    (t, d)
}

/// The mapping of one volume with given parameters.
/// One rigid transform, with what the mapping needs of it.
#[derive(Clone)]
struct Transform {
    r: Mat3,
    rt: Mat3,
    t: [f64; 3],
    /// ∂(model voxel b)/∂(volume voxel along the PE axis).
    dm_dq: [f64; 3],
    rigid: Rigid,
}

impl Transform {
    fn new(rigid: Rigid, grid: &Grid, axis: usize) -> Self {
        let r = rigid.matrix();
        let vs = grid.voxel_size;
        Self {
            r,
            rt: rigid::transpose(&r),
            t: rigid.translation,
            dm_dq: std::array::from_fn(|b| r[b][axis] * vs[axis] / vs[b]),
            rigid,
        }
    }
}

struct Warp<'a> {
    grid: &'a Grid,
    centre: [f64; 3],
    r: Mat3,
    rt: Mat3,
    t: [f64; 3],
    /// Per slice (along the slice axis), with slice-to-volume movement; empty otherwise.
    slices: Vec<Transform>,
    slice_axis: usize,
    k: f64,
    axis: usize,
    model: Option<Model>,
    ec: &'a [f64],
    /// 1 / half the grid's extent per axis: `ec_terms`' coordinates are (q - centre) · scale.
    ec_scale: [f64; 3],
    field: Option<&'a FieldMap>,
    /// Movement-by-susceptibility: the field's change per radian about x and y, and this
    /// volume's rotations.
    mbs: Option<(std::sync::Arc<[FieldMap; 2]>, [f64; 2])>,
    /// ∂(model voxel b)/∂(volume voxel along the PE axis).
    dm_dq: [f64; 3],
}

/// Where a model voxel's signal was acquired.
struct Source {
    /// The point in the volume's own (undistorted) frame, voxels.
    q: [f64; 3],
    /// The acquired position, voxels.
    x: [f64; 3],
    jacobian: f64,
}

impl<'a> Warp<'a> {
    fn new(
        grid: &'a Grid,
        params: &'a VolumeParams,
        acquisition: &Acquisition,
        model: Option<Model>,
        field: Option<&'a FieldMap>,
        mbs: Option<std::sync::Arc<[FieldMap; 2]>>,
        // The slices' acquisition times and the slice axis (slice-to-volume movement).
        slicing: (Option<&[f64]>, usize),
    ) -> Self {
        let (slice_times, slice_axis) = slicing;
        let r = params.rigid.matrix();
        let a = acquisition.pe_axis;
        let vs = grid.voxel_size;
        let slices = match slice_times {
            Some(times) if !params.s2v.is_empty() => times
                .iter()
                .map(|&tau| Transform::new(params.rigid_at(tau), grid, a))
                .collect(),
            _ => Vec::new(),
        };
        Self {
            grid,
            centre: std::array::from_fn(|i| (grid.dims[i] as f64 - 1.0) / 2.0),
            r,
            rt: rigid::transpose(&r),
            t: params.rigid.translation,
            slices,
            slice_axis,
            k: acquisition.voxels_per_hz(),
            axis: a,
            model: if params.ec.is_empty() { None } else { model },
            ec: &params.ec,
            ec_scale: std::array::from_fn(|a| 1.0 / ((grid.dims[a] as f64 - 1.0) / 2.0).max(0.5)),
            field,
            mbs: mbs.map(|m| (m, [params.rigid.rotation[0], params.rigid.rotation[1]])),
            dm_dq: std::array::from_fn(|b| r[b][a] * vs[a] / vs[b]),
        }
    }

    fn to_mm(&self, x: [f64; 3]) -> [f64; 3] {
        std::array::from_fn(|i| (x[i] - self.centre[i]) * self.grid.voxel_size[i])
    }

    fn to_voxel(&self, p: [f64; 3]) -> [f64; 3] {
        std::array::from_fn(|i| p[i] / self.grid.voxel_size[i] + self.centre[i])
    }

    /// The acquired slice of a position (voxels), with slice-to-volume movement.
    fn slice_of(&self, x: [f64; 3]) -> Option<usize> {
        if self.slices.is_empty() {
            return None;
        }
        let n = self.slices.len();
        Some(((x[self.slice_axis] + 0.5).max(0.0) as usize).min(n - 1))
    }

    /// The transform of a slice (`None`: the volume's).
    fn transform(&self, slice: Option<usize>) -> (Mat3, Mat3, [f64; 3], [f64; 3]) {
        match slice {
            Some(s) => {
                let t = &self.slices[s];
                (t.r, t.rt, t.t, t.dm_dq)
            }
            None => (self.r, self.rt, self.t, self.dm_dq),
        }
    }

    /// The model point (voxels) of a volume-frame point (voxels) in a given slice.
    fn model_voxel_in(&self, q: [f64; 3], slice: Option<usize>) -> [f64; 3] {
        let (r, _, t, _) = self.transform(slice);
        let p = rigid::apply(&r, self.to_mm(q));
        self.to_voxel(std::array::from_fn(|i| p[i] + t[i]))
    }

    /// The eddy-current field (Hz) at a volume-frame point and its derivative along the PE
    /// axis: `ec_terms` summed with the coefficients.
    fn ec_at(&self, q: [f64; 3]) -> (f64, f64) {
        let Some(model) = self.model else {
            return (0.0, 0.0);
        };
        let c = self.ec;
        let scale = self.ec_scale;
        let [x, y, z]: [f64; 3] = std::array::from_fn(|a| (q[a] - self.centre[a]) * scale[a]);
        let mut value = c[0] + c[1] * x + c[2] * y + c[3] * z;
        let mut gradient = [c[1], c[2], c[3]];
        if model == Model::Quadratic {
            value += c[4] * x * x
                + c[5] * y * y
                + c[6] * z * z
                + c[7] * x * y
                + c[8] * x * z
                + c[9] * y * z;
            gradient[0] += 2.0 * c[4] * x + c[7] * y + c[8] * z;
            gradient[1] += 2.0 * c[5] * y + c[7] * x + c[9] * z;
            gradient[2] += 2.0 * c[6] * z + c[8] * x + c[9] * y;
        }
        (value, gradient[self.axis] * scale[self.axis])
    }

    /// The field (Hz) at a model voxel index, and its derivative along the volume's PE axis.
    fn field_at_voxel(&self, v: usize, dm_dq: [f64; 3]) -> (f64, f64) {
        let at = |f: &FieldMap| -> (f64, f64) {
            (
                f.hz[v] as f64,
                (0..3).map(|b| f.grad[b][v] as f64 * dm_dq[b]).sum(),
            )
        };
        let (mut hz, mut d) = self.field.map_or((0.0, 0.0), at);
        if let Some((fields, theta)) = &self.mbs {
            for (f, t) in fields.iter().zip(theta) {
                let (h, dh) = at(f);
                hz += t * h;
                d += t * dh;
            }
        }
        (hz, d)
    }

    /// The displacement (voxels along the PE axis) at volume-frame point `q`, whose model
    /// point is `m`; None where the field is not defined.
    fn displacement(&self, q: [f64; 3], m: [f64; 3]) -> Option<f64> {
        let mut hz = match self.field {
            None => 0.0,
            Some(f) => self.grid.trilinear(&f.hz, m)?,
        };
        if let Some((fields, theta)) = &self.mbs {
            for (f, t) in fields.iter().zip(theta) {
                hz += t * self.grid.trilinear(&f.hz, m)?;
            }
        }
        Some(self.k * (hz + self.ec_at(q).0))
    }

    fn source(&self, v: usize) -> Source {
        self.source_in(v).0
    }

    /// Where a model voxel's signal was acquired, and (with slice-to-volume movement) the
    /// slice it was acquired in: found by mapping with the volume's transform, then with the
    /// transform of the slice that lands in, twice.
    fn source_in(&self, v: usize) -> (Source, Option<usize>) {
        let ijk = self.grid.ijk(v);
        let m = self.to_mm(ijk.map(|i| i as f64));
        let map = |slice: Option<usize>| -> Source {
            let (_, rt, t, dm_dq) = self.transform(slice);
            let q = self.to_voxel(rigid::apply(&rt, std::array::from_fn(|i| m[i] - t[i])));
            let (hz, dhz) = self.field_at_voxel(v, dm_dq);
            let (ec, dec) = self.ec_at(q);
            let mut x = q;
            x[self.axis] += self.k * (hz + ec);
            Source {
                q,
                x,
                jacobian: 1.0 + self.k * (dhz + dec),
            }
        };
        let mut source = map(None);
        let mut slice = None;
        for _ in 0..2 {
            let Some(s) = self.slice_of(source.x) else {
                break;
            };
            if slice == Some(s) {
                break;
            }
            slice = Some(s);
            source = map(slice);
        }
        (source, slice)
    }
}

/// The voxels the estimation works on: the mask grown by a margin, in a compact order.
struct Domain {
    voxels: Vec<usize>,
    /// Full index to compact index (u32::MAX outside).
    position: Vec<u32>,
    /// Compact indices of the mask voxels.
    mask: Vec<usize>,
    /// Compact indices of the mask voxels and their neighbours (what a registration step
    /// needs, with the gradients).
    near: Vec<usize>,
    /// The smallest and largest voxel coordinates of the domain along each axis.
    bounds: [[f64; 2]; 3],
}

impl Domain {
    fn new(grid: &Grid, mask: &[bool], margin: usize) -> Self {
        let grown = grid.dilate(mask, margin);
        let voxels: Vec<usize> = (0..grid.voxels()).filter(|&v| grown[v]).collect();
        let mut position = vec![u32::MAX; grid.voxels()];
        for (c, &v) in voxels.iter().enumerate() {
            position[v] = c as u32;
        }
        let compact = |within: &[bool]| -> Vec<usize> {
            voxels
                .iter()
                .enumerate()
                .filter(|&(_, &v)| within[v])
                .map(|(c, _)| c)
                .collect()
        };
        let near = compact(&grid.dilate(mask, 1));
        let mask = compact(mask);
        let mut bounds = [[f64::INFINITY, f64::NEG_INFINITY]; 3];
        for &v in &voxels {
            for (b, i) in bounds.iter_mut().zip(grid.ijk(v)) {
                b[0] = b[0].min(i as f64);
                b[1] = b[1].max(i as f64);
            }
        }
        Self {
            voxels,
            position,
            mask,
            near,
            bounds,
        }
    }

    /// The part of the segment from `a` to `b` (voxels) within the domain's bounding box
    /// (grown by a voxel), as fractions of its length; None when it misses the box.
    fn clip(&self, a: [f64; 3], b: [f64; 3]) -> Option<(f64, f64)> {
        let (mut t0, mut t1) = (0.0f64, 1.0f64);
        for axis in 0..3 {
            let (lo, hi) = (self.bounds[axis][0] - 1.0, self.bounds[axis][1] + 1.0);
            let d = b[axis] - a[axis];
            if d.abs() < 1e-12 {
                if a[axis] < lo || a[axis] > hi {
                    return None;
                }
                continue;
            }
            let (u, w) = ((lo - a[axis]) / d, (hi - a[axis]) / d);
            t0 = t0.max(u.min(w));
            t1 = t1.min(u.max(w));
        }
        (t0 <= t1).then_some((t0, t1))
    }

    fn expand(&self, n: usize, compact: &[f32]) -> Vec<f32> {
        let mut out = vec![f32::NAN; n];
        for (&v, &c) in self.voxels.iter().zip(compact) {
            out[v] = c;
        }
        out
    }
}

struct Context<'a> {
    input: &'a Input,
    options: &'a Options,
    field: Option<FieldMap>,
    /// Movement-by-susceptibility fields (Hz per radian about x and y), once estimated.
    mbs: std::sync::RwLock<Option<std::sync::Arc<[FieldMap; 2]>>>,
    domain: Domain,
    b0: Vec<usize>,
    dwi: Vec<usize>,
    /// Prediction weights per diffusion-weighted volume (index into `dwi`): 3dSHORE, or the
    /// Gaussian process, whose hyperparameters are refitted every iteration.
    fits: std::sync::RwLock<Vec<TargetFit>>,
    /// Leave-out prediction weights, for the outlier slices: a prediction that includes the
    /// volume would include its dropped slice. The same as `fits` for 3dSHORE.
    leave_out: std::sync::RwLock<Vec<TargetFit>>,
    slice_times: Option<Vec<f64>>,
}

impl Context<'_> {
    /// Prepares a volume for `sample`: B-spline coefficients, or the volume itself.
    fn prepare(&self, data: &[f32], interpolation: Interpolation) -> Vec<f32> {
        match interpolation {
            Interpolation::Trilinear => data.to_vec(),
            Interpolation::Spline => volume::bspline_coefficients(&self.input.grid, data),
        }
    }

    fn sample(&self, data: &[f32], x: [f64; 3], interpolation: Interpolation) -> Option<f64> {
        match interpolation {
            Interpolation::Trilinear => self.input.grid.trilinear(data, x),
            Interpolation::Spline => volume::bspline(&self.input.grid, data, x),
        }
    }

    fn sample_d(
        &self,
        data: &[f32],
        x: [f64; 3],
        axis: usize,
        interpolation: Interpolation,
    ) -> Option<(f64, f64)> {
        match interpolation {
            Interpolation::Trilinear => self.input.grid.trilinear_d(data, x, axis),
            Interpolation::Spline => volume::bspline_d(&self.input.grid, data, x, Some(axis)),
        }
    }

    fn warp<'b>(&'b self, v: usize, params: &'b VolumeParams) -> Warp<'b> {
        Warp::new(
            &self.input.grid,
            params,
            &self.input.acquisitions[v],
            self.options.ec_model,
            self.field.as_ref(),
            self.mbs.read().unwrap().clone(),
            (self.slice_times.as_deref(), self.options.slice_axis),
        )
    }

    /// The corrected volume on the domain (NaN where the source is outside the grid).
    fn correct(
        &self,
        v: usize,
        data: &[f32],
        params: &VolumeParams,
        interpolation: Interpolation,
    ) -> Vec<f32> {
        let warp = self.warp(v, params);
        self.domain
            .voxels
            .iter()
            .map(|&i| {
                let s = warp.source(i);
                match self.sample(data, s.x, interpolation) {
                    Some(y) => (s.jacobian * y) as f32,
                    None => f32::NAN,
                }
            })
            .collect()
    }

    /// Predictions of every volume from the corrected volumes, with `fits` (the registration's)
    /// or, with `leave_out`, the leave-out weights.
    fn predict(&self, corrected: &[Vec<f32>], leave_out: bool, alpha: f64) -> Vec<Vec<f32>> {
        let n = self.domain.voxels.len();
        let mut b0_sum = vec![0.0f64; n];
        for &b in &self.b0 {
            for (s, &c) in b0_sum.iter_mut().zip(&corrected[b]) {
                *s += c as f64;
            }
        }
        let nb0 = self.b0.len() as f64;
        let b0_mean: Vec<f64> = b0_sum.iter().map(|s| s / nb0).collect();
        let fits = if leave_out {
            self.leave_out.read().unwrap()
        } else {
            self.fits.read().unwrap()
        };
        // The b0 volumes around each diffusion-weighted volume and the weight of the later one.
        let around = |v: usize| -> (usize, usize, f64) {
            match self.b0.iter().position(|&b| b > v) {
                Some(0) => (self.b0[0], self.b0[0], 0.0),
                None => {
                    let last = *self.b0.last().unwrap();
                    (last, last, 0.0)
                }
                Some(i) => {
                    let (lo, hi) = (self.b0[i - 1], self.b0[i]);
                    (lo, hi, (v - lo) as f64 / (hi - lo) as f64)
                }
            }
        };
        // Volume v's prediction on the voxels `range`, into `out`.
        let predict_range = |v: usize, range: std::ops::Range<usize>, out: &mut [f32]| {
            if self.b0.binary_search(&v).is_ok() {
                if self.b0.len() < 2 {
                    out.copy_from_slice(&corrected[v][range.clone()]);
                } else {
                    for ((o, s), &c) in out
                        .iter_mut()
                        .zip(&b0_sum[range.clone()])
                        .zip(&corrected[v][range.clone()])
                    {
                        *o = ((s - c as f64) / (nb0 - 1.0)) as f32;
                    }
                }
                return;
            }
            let fit = &fits[self.dwi.binary_search(&v).unwrap()];
            let mut sum: Vec<f64> =
                if self.options.local_b0 && self.b0.len() > 1 && fit.b0_weight != 0.0 {
                    // The b0 signal at the time of the volume: the b0 volumes before and after
                    // it, interpolated (they share its position-dependent distortion and coil
                    // sensitivity, which the mean over the session does not).
                    let (lo, hi, w) = around(v);
                    corrected[lo][range.clone()]
                        .iter()
                        .zip(&corrected[hi][range.clone()])
                        .map(|(&a, &b)| fit.b0_weight * ((1.0 - w) * a as f64 + w * b as f64))
                        .collect()
                } else {
                    b0_mean[range.clone()]
                        .iter()
                        .map(|b| fit.b0_weight * b)
                        .collect()
                };
            for (&i, &w) in fit.volumes.iter().zip(&fit.weights) {
                for (o, &c) in sum.iter_mut().zip(&corrected[self.dwi[i]][range.clone()]) {
                    *o += w * c as f64;
                }
            }
            if !leave_out && alpha > 0.0 {
                for (o, &c) in sum.iter_mut().zip(&corrected[v][range.clone()]) {
                    *o = (1.0 - alpha) * *o + alpha * c as f64;
                }
            }
            for (o, x) in out.iter_mut().zip(sum) {
                *o = x as f32;
            }
        };
        // In blocks of voxels, every volume's prediction: the block of the whole series stays
        // in cache while every target reads it.
        const BLOCK: usize = 2048;
        let nv = corrected.len();
        let mut out: Vec<Vec<f32>> = vec![vec![0.0f32; n]; nv];
        let mut blocks: Vec<Vec<&mut [f32]>> = (0..n.div_ceil(BLOCK))
            .map(|_| Vec::with_capacity(nv))
            .collect();
        for o in out.iter_mut() {
            for (block, slice) in blocks.iter_mut().zip(o.chunks_mut(BLOCK)) {
                block.push(slice);
            }
        }
        blocks.into_par_iter().enumerate().for_each(|(k, slices)| {
            let start = k * BLOCK;
            for (v, slice) in slices.into_iter().enumerate() {
                let end = start + slice.len();
                predict_range(v, start..end, slice);
            }
        });
        out
    }

    /// The residuals (prediction minus corrected volume) over the mask.
    fn residuals(
        &self,
        v: usize,
        data: &[f32],
        params: &VolumeParams,
        prediction: &[f32],
        interpolation: Interpolation,
    ) -> Vec<f64> {
        let warp = self.warp(v, params);
        self.domain
            .mask
            .iter()
            .filter_map(|&c| {
                let p = prediction[c];
                if !p.is_finite() {
                    return None;
                }
                let s = warp.source(self.domain.voxels[c]);
                self.sample(data, s.x, interpolation)
                    .map(|y| p as f64 - s.jacobian * y)
            })
            .collect()
    }

    /// The corrected volume for `params` with what a Gauss-Newton step needs at each mask
    /// voxel, and the mean Huber loss of the residuals over the mask.
    fn evaluate(
        &self,
        v: usize,
        data: &[f32],
        params: &VolumeParams,
        prediction: &[f32],
        objective: Objective,
    ) -> Evaluation {
        let Objective {
            k,
            derivative,
            interpolation,
        } = objective;
        let warp = self.warp(v, params);
        let mut corrected = vec![f32::NAN; self.domain.voxels.len()];
        let mut at_mask = Vec::with_capacity(self.domain.mask.len());
        let mut mask = self.domain.mask.iter().peekable();
        let (mut loss, mut count) = (0.0, 0usize);
        for &c in &self.domain.near {
            let full = self.domain.voxels[c];
            let in_mask = mask.next_if_eq(&&c).is_some();
            let (s, slice) = warp.source_in(full);
            let sampled = if in_mask && derivative {
                self.sample_d(data, s.x, warp.axis, interpolation)
            } else {
                self.sample(data, s.x, interpolation).map(|y| (y, 0.0))
            };
            if let Some((y, _)) = sampled {
                corrected[c] = (s.jacobian * y) as f32;
                if in_mask && prediction[c].is_finite() {
                    loss += huber(prediction[c] as f64 - s.jacobian * y, k);
                    count += 1;
                }
            }
            if in_mask {
                let (y, dy) = sampled.unwrap_or((f64::NAN, f64::NAN));
                at_mask.push(MaskSample {
                    y: y as f32,
                    dy: dy as f32,
                    jacobian: s.jacobian as f32,
                    slice: slice.map_or(u32::MAX, |s| s as u32),
                });
            }
        }
        Evaluation {
            corrected,
            at_mask,
            cost: if count == 0 {
                f64::INFINITY
            } else {
                loss / count as f64
            },
        }
    }

    /// Gauss-Newton (Levenberg-Marquardt) steps for one volume.
    fn register(
        &self,
        v: usize,
        data: &[f32],
        prediction: &[f32],
        start: &VolumeParams,
        scope: Scope,
    ) -> VolumeParams {
        let Scope {
            steps,
            active_ec,
            estimate_rigid,
            interpolation,
        } = scope;
        let grid = &self.input.grid;
        let vs = grid.voxel_size;
        // The first `active_ec` eddy-current terms are estimated; the others stay as they are.
        let n_ec = start.ec.len().min(active_ec);
        // Slice-to-volume: 6 coefficients per order, after the eddy currents.
        let orders = start.s2v.len();
        let times = self.slice_times.as_deref();
        let n = 6 + n_ec + 6 * orders;
        let acquisition = &self.input.acquisitions[v];
        let mm_per_hz = (acquisition.voxels_per_hz() * vs[acquisition.pe_axis]).abs();
        let mut params = start.clone();
        // Robust estimation: residuals beyond k = 1.345 σ (σ from the median absolute
        // residual at the start) count linearly, so that a dropped slice or another
        // artefact does not pull the volume.
        let k = if self.options.robust {
            let mut a: Vec<f64> = self
                .residuals(v, data, &params, prediction, interpolation)
                .iter()
                .map(|r| r.abs())
                .collect();
            a.sort_by(f64::total_cmp);
            let sigma = 1.4826 * a.get(a.len() / 2).copied().unwrap_or(0.0);
            if sigma > 0.0 {
                1.345 * sigma
            } else {
                f64::INFINITY
            }
        } else {
            f64::INFINITY
        };
        let objective = Objective {
            k,
            derivative: n_ec > 0,
            interpolation,
        };
        let mut current = self.evaluate(v, data, &params, prediction, objective);
        for _ in 0..steps {
            let corrected = &current.corrected;
            let warp = self.warp(v, &params);
            let dr = params.rigid.matrix_derivatives();
            // Per slice: the rotation derivatives of its transform.
            let slice_dr: Vec<[Mat3; 3]> = warp
                .slices
                .iter()
                .map(|t| t.rigid.matrix_derivatives())
                .collect();
            let mut h = vec![vec![0.0f64; n]; n];
            let mut g = vec![0.0f64; n];
            let mut row = vec![0.0f64; n];
            for (&c, sample) in self.domain.mask.iter().zip(&current.at_mask) {
                let p = prediction[c];
                let value = corrected[c];
                if !p.is_finite() || !value.is_finite() {
                    continue;
                }
                let full = self.domain.voxels[c];
                let ijk = grid.ijk(full);
                if (0..3).any(|a| ijk[a] == 0 || ijk[a] + 1 >= grid.dims[a]) {
                    continue;
                }
                // Gradient of the corrected volume (per mm) by central differences.
                let mut grad = [0.0f64; 3];
                let mut ok = true;
                for (a, ga) in grad.iter_mut().enumerate() {
                    let s = grid.stride(a);
                    let lo = self.domain.position[full - s];
                    let hi = self.domain.position[full + s];
                    if lo == u32::MAX || hi == u32::MAX {
                        ok = false;
                        break;
                    }
                    let (l, u) = (corrected[lo as usize], corrected[hi as usize]);
                    if !l.is_finite() || !u.is_finite() {
                        ok = false;
                        break;
                    }
                    *ga = (u - l) as f64 / (2.0 * vs[a]);
                }
                if !ok {
                    continue;
                }
                let m = warp.to_mm(ijk.map(|i| i as f64));
                let slice = (sample.slice != u32::MAX).then_some(sample.slice as usize);
                let (_, rt, t, _) = warp.transform(slice);
                let q = rigid::apply(&rt, std::array::from_fn(|i| m[i] - t[i]));
                let derivatives = match slice {
                    Some(sl) => &slice_dr[sl],
                    None => &dr,
                };
                for a in 0..3 {
                    row[a] = -grad[a];
                }
                for (j, d) in derivatives.iter().enumerate() {
                    let dq = rigid::apply(d, q);
                    row[3 + j] = -(grad[0] * dq[0] + grad[1] * dq[1] + grad[2] * dq[2]);
                }
                if orders > 0 {
                    let tau = match (slice, times) {
                        (Some(sl), Some(times)) => times[sl],
                        _ => 0.5,
                    };
                    for k in 0..orders {
                        let phi = (std::f64::consts::PI * (k + 1) as f64 * tau).cos();
                        for j in 0..6 {
                            row[6 + n_ec + 6 * k + j] = phi * row[j];
                        }
                    }
                }
                if n_ec > 0 {
                    let (y, dy, jacobian) =
                        (sample.y as f64, sample.dy as f64, sample.jacobian as f64);
                    let (t, dt) = ec_terms(warp.model.unwrap(), grid, warp.to_voxel(q), warp.axis);
                    for j in 0..n_ec {
                        row[6 + j] = warp.k * (jacobian * dy * t[j] + y * dt[j]);
                    }
                }
                let r = (p - value) as f64;
                // Huber weight (iteratively reweighted least squares).
                let weight = if r.abs() <= k { 1.0 } else { k / r.abs() };
                for x in row.iter_mut() {
                    *x *= weight.sqrt();
                }
                let r = r * weight.sqrt();
                for a in 0..n {
                    g[a] += row[a] * r;
                    let ra = row[a];
                    for (hb, rb) in h[a][..=a].iter_mut().zip(&row[..=a]) {
                        *hb += ra * rb;
                    }
                }
            }
            // Smoothness of the movement within the volume: each order's coefficients are
            // penalised in proportion to k² and to the information on the rigid parameter.
            for k in 0..orders {
                for j in 0..6 {
                    let idx = 6 + n_ec + 6 * k + j;
                    let order = (k + 1) as f64;
                    h[idx][idx] += self.options.s2v_lambda * 0.05 * order * order * h[j][j] + 1e-9;
                }
            }
            if !estimate_rigid {
                // The rigid parameters stay: their rows and columns become the identity.
                for (a, row) in h.iter_mut().enumerate() {
                    for (b, x) in row.iter_mut().enumerate() {
                        if a < 6 || b < 6 {
                            *x = if a == b { 1.0 } else { 0.0 };
                        }
                    }
                }
                for x in g.iter_mut().take(6) {
                    *x = 0.0;
                }
            }
            for a in 0..n {
                let (upper, lower) = h.split_at_mut(a);
                for (b, row) in upper.iter_mut().enumerate() {
                    row[a] = lower[0][b];
                }
            }
            let mut lambda = 1e-3;
            let mut improved = false;
            let mut moved = 0.0;
            for _ in 0..6 {
                let mut damped = h.clone();
                for (a, row) in damped.iter_mut().enumerate() {
                    row[a] += lambda * h[a][a] + 1e-12;
                }
                let Some(step) = solve(damped, g.clone()) else {
                    lambda *= 10.0;
                    continue;
                };
                let mut trial = params.clone();
                for a in 0..3 {
                    trial.rigid.translation[a] += step[a];
                    trial.rigid.rotation[a] += step[3 + a];
                }
                for j in 0..n_ec {
                    trial.ec[j] += step[6 + j];
                }
                for k in 0..orders {
                    for j in 0..6 {
                        trial.s2v[k][j] += step[6 + n_ec + 6 * k + j];
                    }
                }
                let evaluated = self.evaluate(v, data, &trial, prediction, objective);
                if evaluated.cost < current.cost {
                    params = trial;
                    current = evaluated;
                    // How far the step moved the volume (mm): translation, rotation at a
                    // radius of 50 mm, eddy-current field (its terms are at most 1), and the
                    // same for each slice-to-volume order.
                    let norm = |x: &[f64]| x.iter().map(|v| v * v).sum::<f64>().sqrt();
                    let rigid = |x: &[f64]| norm(&x[..3]) + 50.0 * norm(&x[3..6]);
                    moved = rigid(&step[..6]) + mm_per_hz * norm(&step[6..6 + n_ec]);
                    for k in 0..orders {
                        let o = 6 + n_ec + 6 * k;
                        moved += rigid(&step[o..o + 6]);
                    }
                    improved = true;
                    break;
                }
                lambda *= 10.0;
            }
            if !improved || moved < self.options.gn_tolerance {
                break;
            }
        }
        params
    }

    /// The prediction of a volume in its own (acquired) space and the voxels it covers, on
    /// the slices `only` marks (every slice when None). Along each phase-encoding line of the
    /// volume frame, the displacement is evaluated once per voxel and inverted between
    /// voxels, where it is linear; the Jacobian comes from its differences.
    fn predict_acquired(
        &self,
        v: usize,
        params: &VolumeParams,
        prediction: &[f32],
        mask_image: &[f32],
        only: Option<&[bool]>,
    ) -> (Vec<f64>, Vec<bool>) {
        let grid = &self.input.grid;
        let full = self.domain.expand(grid.voxels(), prediction);
        let warp = self.warp(v, params);
        let axis = warp.axis;
        let slice_axis = self.options.slice_axis;
        let n = grid.dims[axis];
        let s = grid.stride(axis);
        let mut predicted = vec![0.0f64; grid.voxels()];
        let mut covered = vec![false; grid.voxels()];
        let mut forward = vec![f64::NAN; n];
        let mut d = vec![f64::NAN; n];
        let mut jacobian = vec![f64::NAN; n];
        let wanted = |x: [f64; 3]| only.is_none_or(|o| o[x[slice_axis] as usize]);
        for start in (0..grid.voxels()).filter(|&i| grid.ijk(i)[axis] == 0) {
            let x0 = grid.ijk(start).map(|a| a as f64);
            if axis != slice_axis && !wanted(x0) {
                continue;
            }
            let at = |j: f64| -> [f64; 3] {
                let mut x = x0;
                x[axis] = j;
                x
            };
            // The voxels of the line whose model points can be in the domain: the line is a
            // straight segment in model space (each slice moves rigidly), clipped to the
            // domain's bounding box. Were the phase encoding along the slice axis, each voxel
            // would have its own slice transform: then the whole line.
            let (first, last) = if axis == slice_axis {
                (0, n - 1)
            } else {
                let slice = warp.slice_of(x0);
                let a = warp.model_voxel_in(at(0.0), slice);
                let b = warp.model_voxel_in(at((n - 1) as f64), slice);
                match self.domain.clip(a, b) {
                    Some((t0, t1)) => {
                        let scale = (n - 1) as f64;
                        (
                            ((t0 * scale) as usize).saturating_sub(1),
                            (((t1 * scale) as usize) + 2).min(n - 1),
                        )
                    }
                    None => continue,
                }
            };
            // The displacement (voxels) at each voxel of the line whose model point is in the
            // domain: a voxel that maps into the mask lies between two such.
            for (j, dj) in d.iter_mut().enumerate() {
                *dj = f64::NAN;
                if j < first || j > last {
                    continue;
                }
                let q = at(j as f64);
                let m = warp.model_voxel_in(q, warp.slice_of(q));
                // The nearest voxel (truncation, as the position is non-negative).
                let near = m.map(|a| a + 0.5);
                if (0..3).all(|a| near[a] >= 0.0 && near[a] < grid.dims[a] as f64)
                    && self.domain.position
                        [grid.index(near[0] as usize, near[1] as usize, near[2] as usize)]
                        != u32::MAX
                {
                    *dj = warp.displacement(q, m).unwrap_or(f64::NAN);
                }
            }
            if d.iter().all(|x| x.is_nan()) {
                continue;
            }
            for j in 0..n {
                forward[j] = j as f64 + d[j];
                let lo = if j > 0 && d[j - 1].is_finite() {
                    j - 1
                } else {
                    j
                };
                let hi = if j + 1 < n && d[j + 1].is_finite() {
                    j + 1
                } else {
                    j
                };
                jacobian[j] = if hi > lo {
                    1.0 + (d[hi] - d[lo]) / (hi - lo) as f64
                } else {
                    f64::NAN
                };
            }
            let (lowest, highest) = forward
                .iter()
                .filter(|x| x.is_finite())
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &x| {
                    (a.min(x), b.max(x))
                });
            let mut hint = 0usize;
            for i in 0..n {
                let x = at(i as f64);
                if (i as f64) < lowest || (i as f64) > highest || (axis == slice_axis && !wanted(x))
                {
                    continue;
                }
                // The volume-frame position p with p + d(p) = i: between the voxels where the
                // forward map crosses i, near the previous one (it almost always increases).
                let target = i as f64;
                let crosses = |k: usize| {
                    let (a, b) = (forward[k], forward[k + 1]);
                    a.is_finite() && b.is_finite() && (a - target) * (b - target) <= 0.0 && a != b
                };
                let Some(k) = (hint.saturating_sub(2)..n - 1)
                    .take(8)
                    .find(|&k| crosses(k))
                    .or_else(|| (0..n - 1).find(|&k| crosses(k)))
                else {
                    continue;
                };
                hint = k;
                let f = (target - forward[k]) / (forward[k + 1] - forward[k]);
                let q = at(k as f64 + f);
                let m = warp.model_voxel_in(q, warp.slice_of(x));
                match grid.trilinear(mask_image, m) {
                    Some(in_mask) if in_mask >= 0.5 => {}
                    _ => continue,
                }
                let jac = (1.0 - f) * jacobian[k] + f * jacobian[k + 1];
                if let Some(value) = grid.trilinear(&full, m)
                    && value.is_finite()
                    && jac > 0.0
                {
                    let o = start + i * s;
                    predicted[o] = value / jac;
                    covered[o] = true;
                }
            }
        }
        (predicted, covered)
    }
}

/// One Gauss-Newton linearisation point: the corrected volume on the domain, and at each mask
/// voxel the sampled value, its derivative along the PE axis, the Jacobian and the slice
/// (u32::MAX without slice-to-volume movement).
struct Evaluation {
    corrected: Vec<f32>,
    at_mask: Vec<MaskSample>,
    cost: f64,
}

/// How `Context::evaluate` scores and samples: Huber threshold `k` (infinite for squared
/// error), whether it needs the derivative along the PE axis, and the interpolation.
#[derive(Clone, Copy)]
struct Objective {
    k: f64,
    derivative: bool,
    interpolation: Interpolation,
}

struct MaskSample {
    y: f32,
    dy: f32,
    jacobian: f32,
    slice: u32,
}

/// What one registration estimates: Gauss-Newton steps, the number of eddy-current terms
/// (the first ones), and whether the rigid parameters move; and how it samples the data
/// (which `Context::prepare` made for it).
#[derive(Clone, Copy, Debug)]
struct Scope {
    steps: usize,
    active_ec: usize,
    estimate_rigid: bool,
    interpolation: Interpolation,
}

/// Huber's loss: r²/2 within k, linear beyond.
fn huber(r: f64, k: f64) -> f64 {
    let a = r.abs();
    if a <= k {
        0.5 * r * r
    } else {
        k * a - 0.5 * k * k
    }
}

/// Solves a small dense symmetric system (Gaussian elimination, partial pivoting).
fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    let scale = a
        .iter()
        .enumerate()
        .map(|(i, r)| r[i].abs())
        .fold(0.0, f64::max);
    for col in 0..n {
        let pivot = (col..n).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[pivot][col].abs() <= 1e-14 * scale {
            return None;
        }
        a.swap(col, pivot);
        b.swap(col, pivot);
        let (top, rest) = a.split_at_mut(col + 1);
        let pivot_row = &top[col];
        for (r, row) in rest.iter_mut().enumerate() {
            let f = row[col] / pivot_row[col];
            for (x, p) in row[col..].iter_mut().zip(&pivot_row[col..]) {
                *x -= f * p;
            }
            b[col + 1 + r] -= f * b[col];
        }
    }
    let mut x = vec![0.0; n];
    for r in (0..n).rev() {
        let s: f64 = (r + 1..n).map(|c| a[r][c] * x[c]).sum();
        x[r] = (b[r] - s) / a[r][r];
    }
    Some(x)
}

/// The second-level model: each eddy-current coefficient as a function, without a constant
/// term, of the gradient vector scaled by the b-value, g · b / b_max (linear), or also its
/// products (quadratic). Eddy currents scale with the gradient area; with the b-value
/// (rather than its square root) this matches the parameters FSL eddy reports exactly.
fn second_level(
    fields: &[Field],
    gradients: &[(f64, [f64; 3])],
    model: SecondLevel,
    power: f64,
) -> Result<Vec<Field>, String> {
    let b_max = gradients.iter().map(|g| g.0).fold(0.0, f64::max);
    let rows: Vec<Vec<f64>> = gradients
        .iter()
        .map(|&(b, g)| {
            let scale = (b / b_max).powf(power);
            let [x, y, z] = g.map(|c| c * scale);
            let mut t = vec![x, y, z];
            if model == SecondLevel::Quadratic {
                t.extend([x * x, y * y, z * z, x * y, x * z, y * z]);
            }
            t
        })
        .collect();
    let p = rows.first().map_or(0, |r| r.len());
    let mut normal = vec![vec![0.0; p]; p];
    for row in &rows {
        for (na, ra) in normal.iter_mut().zip(row) {
            for (n, rb) in na.iter_mut().zip(row) {
                *n += ra * rb;
            }
        }
    }
    let mut out: Vec<Field> = fields.to_vec();
    let n_terms = fields.first().map_or(0, |f| f.coefficients.len());
    for k in 0..n_terms {
        let mut rhs = vec![0.0; p];
        for (row, f) in rows.iter().zip(fields) {
            for (r, ra) in rhs.iter_mut().zip(row) {
                *r += ra * f.coefficients[k];
            }
        }
        let w = solve(normal.clone(), rhs)
            .ok_or("The gradient directions do not determine the second-level model.")?;
        for (o, row) in out.iter_mut().zip(&rows) {
            o.coefficients[k] = row.iter().zip(&w).map(|(r, w)| r * w).sum();
        }
    }
    Ok(out)
}

/// Shells of the diffusion-weighted volumes: b-values within 100 of each other.
fn shell_of(bvals: &[f64], b0_threshold: f64) -> Vec<f64> {
    let mut centres: Vec<f64> = Vec::new();
    for &b in bvals.iter().filter(|&&b| b > b0_threshold) {
        if !centres.iter().any(|c| (c - b).abs() <= 100.0) {
            centres.push(b);
        }
    }
    bvals
        .iter()
        .map(|&b| {
            if b <= b0_threshold {
                0.0
            } else {
                *centres
                    .iter()
                    .min_by(|x, y| (*x - b).abs().total_cmp(&(*y - b).abs()))
                    .unwrap()
            }
        })
        .collect()
}

/// Data with more distinct b-values (100 apart) than this are not shelled.
const SHELLED_AT_MOST: usize = 6;
/// Shells with fewer volumes than this are aligned together (`alignment_groups`).
const POOL_BELOW: usize = 20;
/// The group label of the pooled small shells.
const POOLED: f64 = -1.0;

/// The groups whose mean position is held to the b0 trajectory and aligned to the b0 mean:
/// each shell with at least `POOL_BELOW` volumes, and all smaller shells together. Holding a
/// shell of a few volumes to the trajectory removes their own movement, and the mean of a few
/// volumes aligns poorly; diffusion spectrum imaging and other designs with many b-values
/// have only small shells.
fn alignment_groups(shells: &[f64], dwi: &[usize]) -> Vec<f64> {
    let count = |shell: f64| dwi.iter().filter(|&&v| shells[v] == shell).count();
    shells
        .iter()
        .map(|&s| {
            if s > 0.0 && count(s) < POOL_BELOW {
                POOLED
            } else {
                s
            }
        })
        .collect()
}

/// Runs the correction. `log` receives progress lines.
pub fn run(
    input: &Input,
    options: &Options,
    log: &mut dyn FnMut(String),
) -> Result<Output, String> {
    let grid = &input.grid;
    let nv = input.volumes.len();
    if nv == 0
        || input.bvals.len() != nv
        || input.bvecs.len() != nv
        || input.acquisitions.len() != nv
    {
        return Err("There must be one b-value, direction and acquisition per volume.".into());
    }
    if input.mask.len() != grid.voxels() || input.volumes.iter().any(|v| v.len() != grid.voxels()) {
        return Err("The mask and every volume must match the grid.".into());
    }
    let b0: Vec<usize> = (0..nv)
        .filter(|&v| input.bvals[v] <= options.b0_threshold)
        .collect();
    let dwi: Vec<usize> = (0..nv)
        .filter(|&v| input.bvals[v] > options.b0_threshold)
        .collect();
    if b0.is_empty() {
        return Err("The series has no b0 volume.".into());
    }
    if dwi.is_empty() {
        return Err("The series has no diffusion-weighted volume.".into());
    }
    // 3dSHORE needs, in each leave-out fit, about as many samples as its coefficients.
    let coefficients = dwi_shore::basis::index_matrix(dwi_shore::RADIAL_ORDER).len();
    let model = match options.model {
        PredictionModel::Auto if dwi.len() >= coefficients => PredictionModel::Shore,
        PredictionModel::Auto => PredictionModel::GaussianProcess,
        PredictionModel::Shore if dwi.len() < coefficients => {
            return Err(format!(
                "The series has {} diffusion-weighted volumes; 3dSHORE needs at least {coefficients}, one per coefficient (use the Gaussian process).",
                dwi.len()
            ));
        }
        m => m,
    };
    let dwi_bvals: Vec<f64> = dwi.iter().map(|&v| input.bvals[v]).collect();
    let dwi_bvecs: Vec<[f64; 3]> = dwi.iter().map(|&v| input.bvecs[v]).collect();
    let gradients: Vec<(f64, [f64; 3])> = dwi_bvals
        .iter()
        .copied()
        .zip(dwi_bvecs.iter().copied())
        .collect();
    let fits = match model {
        PredictionModel::Shore => (0..dwi.len())
            .into_par_iter()
            .map(|t| TargetFit::new(&dwi_bvals, &dwi_bvecs, t))
            .collect::<Result<Vec<_>, _>>()?,
        _ => gp::fits(&gp::Hyper::default(), &gradients)?,
    };
    let ctx = Context {
        input,
        options,
        field: input.field_hz.clone().map(|hz| FieldMap::new(grid, hz)),
        mbs: std::sync::RwLock::new(None),
        domain: Domain::new(grid, &input.mask, 3),
        slice_times: input.slice_times.clone(),
        b0,
        dwi,
        leave_out: std::sync::RwLock::new(fits.clone()),
        fits: std::sync::RwLock::new(fits),
    };
    log(format!(
        "prediction model: {}",
        if model == PredictionModel::Shore {
            "3dSHORE"
        } else {
            "Gaussian process"
        }
    ));
    let start = std::time::Instant::now();
    let elapsed = || start.elapsed().as_secs_f64();
    log(format!(
        "{} volumes ({} b0), {} mask voxels, {} domain voxels",
        nv,
        ctx.b0.len(),
        ctx.domain.mask.len(),
        ctx.domain.voxels.len()
    ));
    let n_ec = options.ec_model.map_or(0, |m| m.len());
    let mut params: Vec<VolumeParams> = (0..nv)
        .map(|v| VolumeParams {
            rigid: Rigid::default(),
            ec: if ctx.b0.contains(&v) {
                Vec::new()
            } else {
                vec![0.0; n_ec]
            },
            s2v: Vec::new(),
        })
        .collect();
    initialise(&ctx, &mut params);
    log(format!("[{:7.1} s] initial alignment done", elapsed()));
    let shells = shell_of(&input.bvals, options.b0_threshold);
    let groups = alignment_groups(&shells, &ctx.dwi);
    // Without shells (diffusion spectrum imaging, b-values spread over a range), 3dSHORE's
    // leave-out predictions extrapolate across b with large, cancelling weights, and the
    // registration follows their error: damping by the volume's own image holds it (on a DSI
    // phantom 0.035 against 0.083). With shells it holds back large movements.
    let self_weight = options.self_weight.unwrap_or({
        let mut distinct: Vec<f64> = ctx.dwi.iter().map(|&v| shells[v]).collect();
        distinct.sort_by(f64::total_cmp);
        distinct.dedup();
        if distinct.len() > SHELLED_AT_MOST {
            0.3
        } else {
            0.0
        }
    });
    let mask_image: Vec<f32> = input
        .mask
        .iter()
        .map(|&m| if m { 1.0 } else { 0.0 })
        .collect();
    // The series with the outlier slices replaced: only the volumes that have any are copied.
    let mut data = Series {
        base: &input.volumes,
        replaced: std::collections::HashMap::new(),
    };
    let mut outlier_map = None;
    // Coarse iterations first (smoothing `coarse_fwhm`, linear eddy-current model, no outlier
    // replacement), then the iterations with the requested settings.
    let coarse = options.coarse_fwhm.len();
    if options.outlier_type != OutlierType::Slice && input.slice_groups.is_none() {
        return Err(
            "Group-wise outliers need the multiband groups (--mb, --slspec or --json).".into(),
        );
    }
    // Outliers from the start: with few volumes, every prediction is made from volumes with
    // dropped slices, and a dark slice in the predictions misleads the first registrations.
    if options.repol && options.initial_repol {
        let (map, replaced) = detect_outliers(&ctx, &params, &mask_image, &shells, &data)?;
        log(format!("initial outlier slices: {}", map.count()));
        data.replaced = replaced;
    }
    let mut mbs_splines = [
        mbs::Spline::zero(grid, options.mbs_spacing),
        mbs::Spline::zero(grid, options.mbs_spacing),
    ];
    // Then, with slice-to-volume movement, its iterations.
    let s2v_steps = if options.mporder > 0 {
        if ctx.slice_times.is_none() {
            return Err(
                "Slice-to-volume correction needs the slice timing (--slspec or --json).".into(),
            );
        }
        options.s2v_iterations
    } else {
        0
    };
    // Movement-by-susceptibility alternates with the movement: rounds of the fields' estimate
    // (movement fixed) and two iterations (fields fixed).
    let estimate_mbs = options.mbs && ctx.field.is_some();
    let mbs_steps = if estimate_mbs {
        2 * options.mbs_rounds
    } else {
        0
    };
    let main_steps = coarse + options.iterations + s2v_steps;
    for step in 0..main_steps + mbs_steps {
        if step >= main_steps && (step - main_steps) % 2 == 0 {
            mbs_stage(&ctx, &params, &data, &mut mbs_splines)?;
            log(format!(
                "movement-by-susceptibility round {}",
                (step - main_steps) / 2 + 1
            ));
        }
        let is_coarse = step < coarse;
        let is_s2v = step >= coarse + options.iterations && step < main_steps;
        let iteration = step
            .saturating_sub(coarse)
            .min(coarse + options.iterations + s2v_steps);
        if is_s2v && params[0].s2v.is_empty() {
            for p in params.iter_mut() {
                p.s2v = vec![[0.0; 6]; options.mporder];
            }
        }
        let fwhm = if is_coarse {
            options.coarse_fwhm[step]
        } else if is_s2v {
            options.s2v_fwhm
        } else {
            *options
                .fwhm
                .get(iteration)
                .or(options.fwhm.last())
                .unwrap_or(&0.0)
        };
        let sigma = fwhm / (8.0 * 2f64.ln()).sqrt();
        // The coarse iterations' images are smoothed far beyond what the interpolation
        // changes: trilinear, without the B-spline prefilter.
        let interpolation = if is_coarse {
            Interpolation::Trilinear
        } else {
            options.interpolation
        };
        let smoothed: Vec<Vec<f32>> = (0..nv)
            .into_par_iter()
            .map(|v| ctx.prepare(&grid.smooth(data.get(v), sigma), interpolation))
            .collect();
        let corrected: Vec<Vec<f32>> = (0..nv)
            .into_par_iter()
            .map(|v| ctx.correct(v, &smoothed[v], &params[v], interpolation))
            .collect();
        // The gradients relative to the head: each volume's direction turned by its rotation
        // (eddy's `--rbvde`), so that a large rotation does not make the volume's signal look
        // like another direction's.
        let gradients: Vec<(f64, [f64; 3])> = if options.rotate_gradients {
            ctx.dwi
                .iter()
                .zip(&gradients)
                .map(|(&v, &(b, g))| (b, rigid::apply(&params[v].rigid.matrix(), g)))
                .collect()
        } else {
            gradients.clone()
        };
        if options.rotate_gradients && model == PredictionModel::Shore {
            let bvals: Vec<f64> = gradients.iter().map(|g| g.0).collect();
            let bvecs: Vec<[f64; 3]> = gradients.iter().map(|g| g.1).collect();
            let fits = (0..bvals.len())
                .into_par_iter()
                .map(|t| TargetFit::new(&bvals, &bvecs, t))
                .collect::<Result<Vec<_>, _>>()?;
            *ctx.leave_out.write().unwrap() = fits.clone();
            *ctx.fits.write().unwrap() = fits;
        }
        if model == PredictionModel::GaussianProcess {
            // Sample voxels of the mask, with every diffusion-weighted volume defined.
            let step = (ctx.domain.mask.len() / 1500).max(1);
            let samples: Vec<Vec<f32>> = ctx
                .domain
                .mask
                .iter()
                .step_by(step)
                .map(|&c| {
                    ctx.dwi
                        .iter()
                        .map(|&v| corrected[v][c])
                        .collect::<Vec<f32>>()
                })
                .filter(|y| y.iter().all(|x| x.is_finite()))
                .collect();
            let mut hyper = gp::fit_hyper(&gradients, &samples);
            // eddy's `--ff`: predictions with more noise than cross-validation finds follow
            // the (still misaligned) neighbours less closely.
            hyper.noise *= options.gp_fudge.unwrap_or(30.0);
            let leave_out = gp::fits(&hyper, &gradients)?;
            // Including the volume damps its registration: good against the prediction's
            // error once the volumes are close, but it holds back large corrections, so the
            // first iteration leaves it out.
            *ctx.fits.write().unwrap() = if options.gp_include_target && step > 0 {
                gp::fits_including_target(&hyper, &gradients)?
            } else {
                leave_out.clone()
            };
            *ctx.leave_out.write().unwrap() = leave_out;
            log(format!(
                "Gaussian process: range {:.2} rad, b scale {:.2}, noise {:.3}",
                hyper.range, hyper.b_scale, hyper.noise
            ));
        }
        // The Gaussian process damps by including the volume in its fits instead.
        let alpha = if model == PredictionModel::Shore
            && !is_coarse
            && !is_s2v
            && iteration >= options.self_weight_from
        {
            self_weight
        } else {
            0.0
        };
        let predictions = ctx.predict(&corrected, step == 0, alpha);
        drop(corrected);
        let t_predicted = elapsed();
        let mut updated: Vec<VolumeParams> = (0..nv)
            .into_par_iter()
            .map(|v| {
                ctx.register(
                    v,
                    &smoothed[v],
                    &predictions[v],
                    &params[v],
                    Scope {
                        steps: options.gauss_newton_steps,
                        active_ec: if is_coarse || iteration < options.linear_iterations {
                            4
                        } else {
                            usize::MAX
                        },
                        // The Gaussian process's first (leave-out) iteration fits only the
                        // eddy currents of the diffusion-weighted volumes: their motion
                        // stays between the b0 volumes, where the prediction's error cannot
                        // pull it.
                        estimate_rigid: !(step == 0
                            && !ctx.b0.contains(&v)
                            && (model == PredictionModel::GaussianProcess
                                || options.first_ec_only)),
                        interpolation,
                    },
                )
            })
            .collect();
        drop(smoothed);
        drop(predictions);
        // Second-level eddy-current model and offset separation.
        if let (Some(model), Some(slm)) = (options.ec_model, options.second_level) {
            // With offset separation, the offset's second-level model is fitted to the total
            // PE shift (offset plus the PE component of the translation, in Hz), which the
            // data determine; the two parts alone are nearly interchangeable. The head's own
            // PE position, interpolated from the b0 volumes, is taken out first, so that its
            // drift does not leak into the fit. What the model does not explain is movement.
            let pe_mm = |p: &VolumeParams, axis: usize| -> f64 {
                rigid::apply(&rigid::transpose(&p.rigid.matrix()), p.rigid.translation)[axis]
            };
            let trajectory = |v: usize, axis: usize| -> f64 {
                let b0 = &ctx.b0;
                match b0.iter().position(|&b| b > v) {
                    Some(0) => pe_mm(&updated[b0[0]], axis),
                    None => pe_mm(&updated[*b0.last().unwrap()], axis),
                    Some(i) => {
                        let (lo, hi) = (b0[i - 1], b0[i]);
                        let w = (v - lo) as f64 / (hi - lo) as f64;
                        (1.0 - w) * pe_mm(&updated[lo], axis) + w * pe_mm(&updated[hi], axis)
                    }
                }
            };
            let fields: Vec<Field> = ctx
                .dwi
                .iter()
                .map(|&v| {
                    let p = &updated[v];
                    let mut coefficients = p.ec.clone();
                    let acq = &input.acquisitions[v];
                    let k_mm = acq.voxels_per_hz() * grid.voxel_size[acq.pe_axis];
                    if options.separate_offset && k_mm != 0.0 {
                        let head = if options.detrend_offset {
                            trajectory(v, acq.pe_axis)
                        } else {
                            0.0
                        };
                        coefficients[0] -= (pe_mm(p, acq.pe_axis) - head) / k_mm;
                    }
                    Field {
                        model,
                        coefficients,
                    }
                })
                .collect();
            let modelled = second_level(
                &fields,
                &ctx.dwi
                    .iter()
                    .map(|&v| (input.bvals[v], input.bvecs[v]))
                    .collect::<Vec<_>>(),
                slm,
                options.slm_power,
            )?;
            for (&v, m) in ctx.dwi.iter().zip(modelled) {
                let p = &mut updated[v];
                if options.separate_offset {
                    let acq = &input.acquisitions[v];
                    let shift_mm = acq.voxels_per_hz()
                        * (p.ec[0] - m.coefficients[0])
                        * grid.voxel_size[acq.pe_axis];
                    let mut e = [0.0; 3];
                    e[acq.pe_axis] = shift_mm;
                    // The same acquired position with the offset removed: q moves by +shift
                    // along PE, so t moves by -R·shift.
                    let re = rigid::apply(&p.rigid.matrix(), e);
                    for (t, r) in p.rigid.translation.iter_mut().zip(re) {
                        *t -= r;
                    }
                    p.ec = m.coefficients;
                } else {
                    let offset = p.ec[0];
                    p.ec = m.coefficients;
                    p.ec[0] = offset;
                }
            }
        }
        if options.anchor_shells {
            anchor_shells(&ctx, &groups, &mut updated);
        }
        // Refer every volume to volume 0.
        let to_reference = updated[ctx.b0[0]].rigid.inverse();
        for p in updated.iter_mut() {
            p.rigid = to_reference.compose(&p.rigid);
        }
        params = updated;
        let t_registered = elapsed();
        if options.repol && (!is_coarse || options.coarse_repol) {
            let (map, replaced) = detect_outliers(&ctx, &params, &mask_image, &shells, &data)?;
            log(format!(
                "iteration {}: {} outlier slices",
                iteration + 1,
                map.count()
            ));
            data.replaced = replaced;
            outlier_map = Some(map);
        }
        let label = if is_coarse {
            format!("coarse iteration {}", step + 1)
        } else if is_s2v {
            format!(
                "slice-to-volume iteration {}",
                iteration + 1 - options.iterations
            )
        } else {
            format!("iteration {}", iteration + 1)
        };
        log(format!(
            "{label} done (fwhm {fwhm}): prediction until {t_predicted:.1} s, registration until {t_registered:.1} s, outliers until {:.1} s",
            elapsed()
        ));
    }
    if options.mbs && ctx.field.is_some() {
        mbs_stage(&ctx, &params, &data, &mut mbs_splines)?;
        log("movement-by-susceptibility fields estimated".into());
    }
    // Post-estimation alignment of each shell's mean to the b0 mean.
    let mut peas = Vec::new();
    if options.peas && !ctx.dwi.is_empty() {
        let corrected: Vec<Vec<f32>> = (0..nv)
            .into_par_iter()
            .map(|v| ctx.correct(v, data.get(v), &params[v], Interpolation::Trilinear))
            .collect();
        let mean_of = |members: &[usize]| -> Vec<f32> {
            let n = ctx.domain.voxels.len();
            let mut sum = vec![0.0f64; n];
            for &v in members {
                for (s, &c) in sum.iter_mut().zip(&corrected[v]) {
                    *s += c as f64;
                }
            }
            let full: Vec<f32> = sum
                .iter()
                .map(|s| (s / members.len() as f64) as f32)
                .collect();
            ctx.domain.expand(grid.voxels(), &full)
        };
        let b0_mean = mean_of(&ctx.b0);
        let mut distinct: Vec<f64> = ctx.dwi.iter().map(|&v| groups[v]).collect();
        distinct.sort_by(f64::total_cmp);
        distinct.dedup();
        for shell in distinct {
            let members: Vec<usize> = ctx
                .dwi
                .iter()
                .copied()
                .filter(|&v| groups[v] == shell)
                .collect();
            let shell_mean = mean_of(&members);
            let a = peas::register(grid, &b0_mean, &shell_mean, &ctx.domain.voxels);
            let name = if shell == POOLED {
                format!("shells with fewer than {POOL_BELOW} volumes")
            } else {
                format!("shell {shell}")
            };
            log(format!(
                "PEAS {name}: translation {:.3} {:.3} {:.3} mm, rotation {:.3} {:.3} {:.3} deg",
                a.translation[0],
                a.translation[1],
                a.translation[2],
                a.rotation[0].to_degrees(),
                a.rotation[1].to_degrees(),
                a.rotation[2].to_degrees()
            ));
            let inverse = a.inverse();
            for &v in &members {
                params[v].rigid = inverse.compose(&params[v].rigid);
            }
            peas.push((shell, a));
        }
        log("shell alignment done".into());
    }
    // Final resampling: cubic B-spline, Jacobian modulation.
    let resampled: Vec<(Vec<f32>, Vec<bool>)> = (0..nv)
        .into_par_iter()
        .map(|v| {
            let warp = ctx.warp(v, &params[v]);
            let coef = volume::bspline_coefficients(grid, data.get(v));
            let mut out = vec![0.0f32; grid.voxels()];
            let mut covered = vec![false; grid.voxels()];
            for (i, (o, c)) in out.iter_mut().zip(covered.iter_mut()).enumerate() {
                let s = warp.source(i);
                if let Some(y) = volume::bspline(grid, &coef, s.x) {
                    *o = (s.jacobian * y) as f32;
                    *c = true;
                }
            }
            (out, covered)
        })
        .collect();
    let mut all_covered = vec![true; grid.voxels()];
    for (_, c) in &resampled {
        for (a, &b) in all_covered.iter_mut().zip(c) {
            *a &= b;
        }
    }
    // Least-squares restoration of pairs with opposite phase encoding: one output volume per
    // pair, replacing the pair's two Jacobian-modulated volumes.
    let mut resampled: Vec<(Vec<f32>, Vec<bool>)> = resampled;
    let mut sources: Vec<Vec<usize>> = (0..nv).map(|v| vec![v]).collect();
    if options.resampling == Resampling::LeastSquares {
        let pairs = lsr::pairs(&input.bvals, &input.bvecs, &input.acquisitions);
        log(format!("least-squares restoration: {} pairs", pairs.len()));
        let restored: Vec<Vec<f32>> = pairs
            .iter()
            .map(|&(a, b)| {
                let axis = input.acquisitions[a].pe_axis;
                // Motion only, and the displacement along the axis, on the reference grid.
                let undo = |v: usize| -> (Vec<f32>, Vec<f32>) {
                    let coef = volume::bspline_coefficients(grid, data.get(v));
                    let warp = ctx.warp(v, &params[v]);
                    (0..grid.voxels())
                        .into_par_iter()
                        .map(|i| {
                            let s = warp.source(i);
                            let value = volume::bspline(grid, &coef, s.q).unwrap_or(0.0);
                            (value as f32, (s.x[axis] - s.q[axis]) as f32)
                        })
                        .unzip()
                };
                let (ga, da) = undo(a);
                let (gb, db) = undo(b);
                lsr::restore(grid, axis, [&ga, &gb], [&da, &db], options.lsr_lambda)
            })
            .collect();
        let mut keep: Vec<Option<(Vec<f32>, Vec<bool>)>> =
            resampled.into_iter().map(Some).collect();
        let paired: std::collections::HashMap<usize, usize> =
            pairs.iter().map(|&(a, b)| (b, a)).collect();
        let mut out = Vec::new();
        sources.clear();
        let mut restored = restored.into_iter();
        for v in 0..nv {
            if paired.contains_key(&v) {
                continue;
            }
            let (image, covered) = keep[v].take().unwrap();
            if let Some(&(a, b)) = pairs.iter().find(|p| p.0 == v) {
                let mut both = covered;
                for (c, &o) in both.iter_mut().zip(&keep[b].as_ref().unwrap().1) {
                    *c &= o;
                }
                out.push((restored.next().unwrap(), both));
                sources.push(vec![a, b]);
            } else {
                out.push((image, covered));
                sources.push(vec![v]);
            }
        }
        resampled = out;
    }
    let corrected: Vec<Vec<f32>> = resampled
        .into_iter()
        .map(|(mut out, _)| {
            if options.mask_output {
                for (o, &c) in out.iter_mut().zip(&all_covered) {
                    if !c {
                        *o = 0.0;
                    }
                }
            }
            out
        })
        .collect();
    log("resampling done".into());
    let movement_rms = movement_rms(grid, &input.mask, &params);
    Ok(Output {
        corrected,
        sources,
        params,
        outliers: outlier_map,
        peas,
        movement_rms,
        mbs_fields: ctx
            .mbs
            .read()
            .unwrap()
            .as_ref()
            .map(|f| [f[0].hz.clone(), f[1].hz.clone()]),
    })
}

/// Movement-by-susceptibility with the movement fixed (estimating both in one step lets the
/// rotations chase the field): the field's change with rotation, from the residuals, with
/// the predictions remade after each update.
fn mbs_stage(
    ctx: &Context,
    params: &[VolumeParams],
    data: &Series,
    mbs_splines: &mut [mbs::Spline; 2],
) -> Result<(), String> {
    let grid = &ctx.input.grid;
    let nv = params.len();
    let fwhm = *ctx.options.fwhm.last().unwrap_or(&0.0);
    let sigma = fwhm / (8.0 * 2f64.ln()).sqrt();
    let interpolation = ctx.options.interpolation;
    let smoothed: Vec<Vec<f32>> = (0..nv)
        .into_par_iter()
        .map(|v| ctx.prepare(&grid.smooth(data.get(v), sigma), interpolation))
        .collect();
    // The total squared residual against the predictions, and the predictions.
    let residual = || -> (f64, Vec<Vec<f32>>) {
        let corrected: Vec<Vec<f32>> = (0..nv)
            .into_par_iter()
            .map(|v| ctx.correct(v, &smoothed[v], &params[v], interpolation))
            .collect();
        let predictions = ctx.predict(&corrected, true, 0.0);
        let total = (0..nv)
            .into_par_iter()
            .map(|v| {
                ctx.domain
                    .mask
                    .iter()
                    .map(|&c| (predictions[v][c] - corrected[v][c]) as f64)
                    .filter(|r| r.is_finite())
                    .map(|r| r * r)
                    .sum::<f64>()
            })
            .sum();
        (total, predictions)
    };
    let (mut cost, mut predictions) = residual();
    for _ in 0..ctx.options.mbs_iterations {
        // A Gauss-Newton step, shortened until the residual goes down: the predictions
        // change with the fields too, so a full step can overshoot.
        let current = mbs_splines.clone();
        let mut proposed = current.clone();
        mbs_update(
            ctx,
            &mut proposed,
            params,
            &smoothed,
            &predictions,
            interpolation,
        )?;
        let mut accepted = false;
        for halving in 0..5 {
            let f = 0.5f64.powi(halving);
            let mut trial = current.clone();
            for (t, (c, p)) in trial.iter_mut().zip(current.iter().zip(&proposed)) {
                for (x, (a, b)) in t
                    .coefficients
                    .iter_mut()
                    .zip(c.coefficients.iter().zip(&p.coefficients))
                {
                    *x = a + f * (b - a);
                }
            }
            set_mbs(ctx, &trial);
            let (trial_cost, trial_predictions) = residual();
            if trial_cost < cost {
                cost = trial_cost;
                predictions = trial_predictions;
                *mbs_splines = trial;
                accepted = true;
                break;
            }
        }
        if !accepted {
            set_mbs(ctx, mbs_splines);
            break;
        }
    }
    Ok(())
}

/// Per mask voxel: the 2 × 2 normal-equation weights ([W00, W01, W11]) and right-hand side.
type NormalTerms = (Vec<[f64; 3]>, Vec<[f64; 2]>);

/// One movement-by-susceptibility update: from each volume's residual against its
/// prediction and the derivative of its corrected image with respect to the field, the
/// increments of the two derivative fields (linearised), then their images.
fn mbs_update(
    ctx: &Context,
    splines: &mut [mbs::Spline; 2],
    params: &[VolumeParams],
    data: &[Vec<f32>],
    predictions: &[Vec<f32>],
    interpolation: Interpolation,
) -> Result<(), String> {
    let grid = &ctx.input.grid;
    let nm = ctx.domain.mask.len();
    // A volume is compared with a prediction from the others, which carry the same field
    // change at their own rotations: the residual sees the rotation's difference from the
    // mean of its group (b0 or diffusion-weighted volumes), not the rotation.
    let mean_rotation = |group: &[usize]| -> [f64; 2] {
        let n = group.len().max(1) as f64;
        std::array::from_fn(|a| {
            group
                .iter()
                .map(|&v| params[v].rigid.rotation[a])
                .sum::<f64>()
                / n
        })
    };
    let (b0_mean, dwi_mean) = (mean_rotation(&ctx.b0), mean_rotation(&ctx.dwi));
    // Per mask voxel: [W00, W01, W11] and [g0, g1], summed over volumes.
    let per_volume: Vec<NormalTerms> = (0..params.len())
        .into_par_iter()
        .map(|v| {
            let warp = ctx.warp(v, &params[v]);
            let mean = if ctx.b0.contains(&v) {
                b0_mean
            } else {
                dwi_mean
            };
            let theta = [
                params[v].rigid.rotation[0] - mean[0],
                params[v].rigid.rotation[1] - mean[1],
            ];
            let mut w = vec![[0.0; 3]; nm];
            let mut g = vec![[0.0; 2]; nm];
            for (k, &c) in ctx.domain.mask.iter().enumerate() {
                let p = predictions[v][c];
                if !p.is_finite() {
                    continue;
                }
                let s = warp.source(ctx.domain.voxels[c]);
                let Some((y, dy)) = ctx.sample_d(&data[v], s.x, warp.axis, interpolation) else {
                    continue;
                };
                let r = p as f64 - s.jacobian * y;
                // ∂C/∂(field at this voxel), the field's Jacobian term left out.
                let dc = warp.k * s.jacobian * dy;
                let (a, b) = (theta[0] * dc, theta[1] * dc);
                w[k] = [a * a, a * b, b * b];
                g[k] = [a * r, b * r];
            }
            (w, g)
        })
        .collect();
    let mut weight = vec![[0.0; 3]; nm];
    let mut rhs = vec![[0.0; 2]; nm];
    for (w, g) in &per_volume {
        for k in 0..nm {
            for j in 0..3 {
                weight[k][j] += w[k][j];
            }
            for j in 0..2 {
                rhs[k][j] += g[k][j];
            }
        }
    }
    let mean = weight.iter().map(|w| w[0] + w[2]).sum::<f64>() / (2.0 * nm.max(1) as f64);
    let acc = mbs::Accumulator {
        voxels: ctx
            .domain
            .mask
            .iter()
            .map(|&c| ctx.domain.voxels[c])
            .collect(),
        weight,
        rhs,
    };
    // The penalty scales with the data's weight, so `mbs_lambda` does not depend on units.
    mbs::solve(
        grid,
        splines,
        &acc,
        ctx.options.mbs_lambda * 0.01 * mean,
        200,
    );
    Ok(())
}

/// Makes the warps use these movement-by-susceptibility fields.
fn set_mbs(ctx: &Context, splines: &[mbs::Spline; 2]) {
    let grid = &ctx.input.grid;
    let fields = [
        FieldMap::new(grid, splines[0].evaluate(grid)),
        FieldMap::new(grid, splines[1].evaluate(grid)),
    ];
    *ctx.mbs.write().unwrap() = Some(std::sync::Arc::new(fields));
}

/// The diffusion-weighted volumes are registered to predictions made from each other, so
/// a movement they share (by shell) moves the predictions with them and is barely
/// observable. The head does not know which volume is a b0 volume: on average over a shell,
/// its position follows the b0 volumes' trajectory (interpolated in acquisition order). This
/// removes each shell's mean deviation from that trajectory, after each iteration.
fn anchor_shells(ctx: &Context, shells: &[f64], params: &mut [VolumeParams]) {
    let b0 = &ctx.b0;
    let vector = |r: &Rigid| -> [f64; 6] {
        let [a, b, c] = r.translation;
        let [d, e, f] = r.rotation;
        [a, b, c, d, e, f]
    };
    let trajectory = |v: usize| -> [f64; 6] {
        let after = b0.iter().position(|&b| b > v);
        match after {
            Some(0) => vector(&params[b0[0]].rigid),
            None => vector(&params[*b0.last().unwrap()].rigid),
            Some(i) => {
                let (lo, hi) = (b0[i - 1], b0[i]);
                let w = (v - lo) as f64 / (hi - lo) as f64;
                let (a, b) = (vector(&params[lo].rigid), vector(&params[hi].rigid));
                std::array::from_fn(|k| a[k] + w * (b[k] - a[k]))
            }
        }
    };
    let mut distinct: Vec<f64> = ctx.dwi.iter().map(|&v| shells[v]).collect();
    distinct.sort_by(f64::total_cmp);
    distinct.dedup();
    let mut corrections: Vec<(Vec<usize>, [f64; 6])> = Vec::new();
    for shell in distinct {
        let members: Vec<usize> = ctx
            .dwi
            .iter()
            .copied()
            .filter(|&v| shells[v] == shell)
            .collect();
        let mut mean = [0.0; 6];
        for &v in &members {
            let (p, t) = (vector(&params[v].rigid), trajectory(v));
            for k in 0..6 {
                mean[k] += (p[k] - t[k]) / members.len() as f64;
            }
        }
        corrections.push((members, mean));
    }
    for (members, mean) in corrections {
        for v in members {
            let r = &mut params[v].rigid;
            for k in 0..3 {
                r.translation[k] -= mean[k];
                r.rotation[k] -= mean[3 + k];
            }
        }
    }
}

/// Starting positions: each b0 volume registered to volume 0, coarse to fine (smoothing
/// FWHM 8, 4 and 2 mm), so that large movements are within reach of the Gauss-Newton steps;
/// each diffusion-weighted volume starts between the b0 volumes around it (in acquisition
/// order).
fn initialise(ctx: &Context, params: &mut [VolumeParams]) {
    let grid = &ctx.input.grid;
    let interpolation = ctx.options.interpolation;
    let sigma = |fwhm: f64| fwhm / (8.0 * 2f64.ln()).sqrt();
    let levels = [8.0, 4.0, 2.0];
    let references: Vec<Vec<f32>> = levels
        .iter()
        .map(|&f| {
            let reference = ctx.prepare(
                &grid.smooth(&ctx.input.volumes[ctx.b0[0]], sigma(f)),
                interpolation,
            );
            ctx.correct(ctx.b0[0], &reference, &params[ctx.b0[0]], interpolation)
        })
        .collect();
    let registered: Vec<(usize, Rigid)> = ctx.b0[1..]
        .par_iter()
        .map(|&v| {
            let mut p = params[v].clone();
            for (level, &f) in levels.iter().enumerate() {
                let data =
                    ctx.prepare(&grid.smooth(&ctx.input.volumes[v], sigma(f)), interpolation);
                p = ctx.register(
                    v,
                    &data,
                    &references[level],
                    &p,
                    Scope {
                        steps: 8,
                        active_ec: 0,
                        estimate_rigid: true,
                        interpolation,
                    },
                );
            }
            (v, p.rigid)
        })
        .collect();
    for (v, r) in registered {
        params[v].rigid = r;
    }
    // Diffusion-weighted volumes: interpolated between the b0 volumes before and after them
    // (the nearest one at the ends of the series).
    for &v in &ctx.dwi {
        let after = ctx.b0.iter().position(|&b| b > v);
        params[v].rigid = match after {
            Some(0) => params[ctx.b0[0]].rigid,
            None => params[*ctx.b0.last().unwrap()].rigid,
            Some(i) => {
                let (lo, hi) = (ctx.b0[i - 1], ctx.b0[i]);
                let w = (v - lo) as f64 / (hi - lo) as f64;
                let (a, b) = (params[lo].rigid, params[hi].rigid);
                Rigid {
                    translation: std::array::from_fn(|k| {
                        a.translation[k] + w * (b.translation[k] - a.translation[k])
                    }),
                    rotation: std::array::from_fn(|k| {
                        a.rotation[k] + w * (b.rotation[k] - a.rotation[k])
                    }),
                }
            }
        };
    }
}

/// The input series with some volumes replaced (outlier slices filled in).
struct Series<'a> {
    base: &'a [Vec<f32>],
    replaced: std::collections::HashMap<usize, Vec<f32>>,
}

impl Series<'_> {
    fn get(&self, v: usize) -> &[f32] {
        self.replaced
            .get(&v)
            .map_or(&self.base[v], |r| r.as_slice())
    }
}

/// Detects outlier slices in each volume's own space against the current predictions, and
/// returns the original data with those slices replaced by the prediction.
fn detect_outliers(
    ctx: &Context,
    params: &[VolumeParams],
    mask_image: &[f32],
    shells: &[f64],
    data: &Series,
) -> Result<(OutlierMap, std::collections::HashMap<usize, Vec<f32>>), String> {
    let input = ctx.input;
    let grid = &input.grid;
    let nv = data.base.len();
    // Predictions from the data with the previous replacements.
    let corrected: Vec<Vec<f32>> = (0..nv)
        .into_par_iter()
        .map(|v| ctx.correct(v, data.get(v), &params[v], Interpolation::Trilinear))
        .collect();
    let predictions = ctx.predict(&corrected, true, 0.0);
    drop(corrected);
    let slice_grid = SliceGrid::new(grid.dims, ctx.options.slice_axis)?;
    // One volume at a time: the predictions in the volumes' own space are as large as the
    // series in 64-bit, so only the statistics are kept, and the few volumes with outliers
    // are predicted again for the replacement.
    let statistics: Vec<_> = ctx
        .dwi
        .par_iter()
        .map(|&v| {
            let (p, c) = ctx.predict_acquired(v, &params[v], &predictions[v], mask_image, None);
            dwi_slice_outliers::slice_statistics(&slice_grid, &input.volumes[v], &p, &c)
        })
        .collect();
    let dwi_shells: Vec<f64> = ctx.dwi.iter().map(|&v| shells[v]).collect();
    let settings = &ctx.options.outliers;
    let dwi_map = match (ctx.options.outlier_type, &input.slice_groups) {
        (OutlierType::Slice, _) | (_, None) => {
            dwi_slice_outliers::detect(&statistics, &dwi_shells, settings)?
        }
        (kind, Some(groups)) => {
            // Each group's statistics over the brain voxels of all its slices.
            let grouped: Vec<Vec<dwi_slice_outliers::SliceStatistic>> = statistics
                .iter()
                .map(|slices| {
                    groups
                        .iter()
                        .map(|g| {
                            let voxels: usize = g.iter().map(|&s| slices[s].voxels).sum();
                            let n = voxels.max(1) as f64;
                            let sum = |f: fn(&dwi_slice_outliers::SliceStatistic) -> f64| {
                                g.iter()
                                    .map(|&s| slices[s].voxels as f64 * f(&slices[s]))
                                    .sum::<f64>()
                                    / n
                            };
                            dwi_slice_outliers::SliceStatistic {
                                mean: sum(|x| x.mean),
                                mean_square: sum(|x| x.mean_square),
                                voxels,
                            }
                        })
                        .collect()
                })
                .collect();
            let by_group = dwi_slice_outliers::detect(&grouped, &dwi_shells, settings)?;
            let mut map = dwi_slice_outliers::detect(&statistics, &dwi_shells, settings)?;
            for (v, row) in map.outlier.iter_mut().enumerate() {
                for (g, members) in groups.iter().enumerate() {
                    for &s in members {
                        if kind == OutlierType::Group {
                            row[s] = by_group.outlier[v][g];
                            map.n_stdev[v][s] = by_group.n_stdev[v][g];
                            map.n_sqr_stdev[v][s] = by_group.n_sqr_stdev[v][g];
                        } else {
                            row[s] |= by_group.outlier[v][g];
                        }
                    }
                }
            }
            map
        }
    };
    // Back to all volumes (b0 volumes are never outliers).
    let slices = grid.dims[ctx.options.slice_axis];
    let mut map = OutlierMap {
        outlier: vec![vec![false; slices]; nv],
        n_stdev: vec![vec![f64::NAN; slices]; nv],
        n_sqr_stdev: vec![vec![f64::NAN; slices]; nv],
    };
    for (d, &v) in ctx.dwi.iter().enumerate() {
        map.outlier[v] = dwi_map.outlier[d].clone();
        map.n_stdev[v] = dwi_map.n_stdev[d].clone();
        map.n_sqr_stdev[v] = dwi_map.n_sqr_stdev[d].clone();
    }
    let flagged: Vec<usize> = ctx
        .dwi
        .iter()
        .copied()
        .filter(|&v| map.outlier[v].iter().any(|&o| o))
        .collect();
    let replaced = flagged
        .par_iter()
        .map(|&v| {
            let (p, c) = ctx.predict_acquired(
                v,
                &params[v],
                &predictions[v],
                mask_image,
                Some(&map.outlier[v]),
            );
            let mut volume = input.volumes[v].clone();
            dwi_slice_outliers::replace(&slice_grid, &mut volume, &p, &c, &map.outlier[v]);
            (v, volume)
        })
        .collect();
    Ok((map, replaced))
}

fn movement_rms(grid: &Grid, mask: &[bool], params: &[VolumeParams]) -> Vec<[f64; 2]> {
    let centre: [f64; 3] = std::array::from_fn(|i| (grid.dims[i] as f64 - 1.0) / 2.0);
    let points: Vec<[f64; 3]> = (0..grid.voxels())
        .filter(|&v| mask[v])
        .step_by(7)
        .map(|v| {
            let ijk = grid.ijk(v);
            std::array::from_fn(|i| (ijk[i] as f64 - centre[i]) * grid.voxel_size[i])
        })
        .collect();
    let rms = |a: &Rigid, b: &Rigid| -> f64 {
        let s: f64 = points
            .iter()
            .map(|&p| {
                let (x, y) = (a.apply(p), b.apply(p));
                (0..3).map(|i| (x[i] - y[i]).powi(2)).sum::<f64>()
            })
            .sum();
        (s / points.len().max(1) as f64).sqrt()
    };
    (0..params.len())
        .map(|v| {
            let previous = if v == 0 {
                &params[0].rigid
            } else {
                &params[v - 1].rigid
            };
            [
                rms(&params[v].rigid, &params[0].rigid),
                rms(&params[v].rigid, previous),
            ]
        })
        .collect()
}

/// Directions rotated into model space. `flip_x`: the directions use FSL's voxel axes, with
/// x reversed (images whose affine has a positive determinant).
pub fn rotate_bvecs(bvecs: &[[f64; 3]], params: &[VolumeParams], flip_x: bool) -> Vec<[f64; 3]> {
    let f = if flip_x { -1.0 } else { 1.0 };
    bvecs
        .iter()
        .zip(params)
        .map(|(g, p)| {
            let r = rigid::apply(&p.rigid.matrix(), [f * g[0], g[1], g[2]]);
            [f * r[0], r[1], r[2]]
        })
        .collect()
}
