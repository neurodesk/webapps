// SPDX-License-Identifier: Apache-2.0
//! Eddy-current distortion for SHORELine (prototype, #481).
//!
//! The diffusion gradients induce eddy currents, whose field shifts the image along the
//! phase-encoding (PE) axis by a different amount in each volume. SHORELine's affine
//! registration absorbs only the linear part of that shift. FSL eddy models the field of each
//! volume as a polynomial in position (`--flm linear` or `quadratic`; Andersson and
//! Sotiropoulos 2016, NeuroImage 125:1063-1078). This crate is a clean-room implementation of
//! that model from the paper; no FSL code was read. It fits the field of one volume against
//! a model prediction of that volume (SHORELine's 3dSHORE leave-out prediction).
//!
//! The field (Hz) moves the signal at voxel x to x + d(x) along the PE axis, with
//! d = sign · readout_time · field in voxels. The corrected image is
//! `J(x) · observed(x + d(x))` with `J = 1 + ∂d/∂PE`, and the fit minimises its squared
//! difference from the prediction over the brain mask (Gauss-Newton with analytic
//! derivatives). Resampling is along the PE lines only, with cubic convolution.
//!
//! In SHORELine, each iteration predicts every volume from the others, fits each volume's
//! field (`fit`), replaces the fields by eddy's second-level model (`second_level`, linear
//! or quadratic), and moves part of the way (`relax`). The second-level model needs gradient
//! directions over the whole sphere; with 3dSHORE predictions the linear one is the more
//! accurate (README).
//!
//! Volumes are flat arrays in NIfTI voxel order (x fastest).

mod interpolate;
mod polynomial;

pub use polynomial::Model;

use interpolate::cubic;

/// The grid and the phase encoding of the volumes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub dims: [usize; 3],
    /// Voxel size along each axis (mm).
    pub voxel_size: [f64; 3],
    /// The PE voxel axis (0, 1 or 2).
    pub pe_axis: usize,
    /// +1 when the PE direction is the axis's positive direction ("j"), -1 otherwise ("j-").
    pub pe_sign: f64,
    /// Total readout time (s).
    pub readout_time: f64,
}

impl Geometry {
    pub fn new(
        dims: [usize; 3],
        voxel_size: [f64; 3],
        pe_axis: usize,
        pe_sign: f64,
        readout_time: f64,
    ) -> Result<Self, String> {
        if pe_axis > 2 {
            return Err(format!("The PE axis {pe_axis} is not 0, 1 or 2."));
        }
        if pe_sign.abs() != 1.0 {
            return Err(format!("The PE sign {pe_sign} is not +1 or -1."));
        }
        if !(readout_time.is_finite() && readout_time > 0.0) {
            return Err(format!(
                "The total readout time {readout_time} s is not positive."
            ));
        }
        if voxel_size.iter().any(|s| !(s.is_finite() && *s > 0.0)) {
            return Err("A voxel size is not positive.".into());
        }
        Ok(Self {
            dims,
            voxel_size,
            pe_axis,
            pe_sign,
            readout_time,
        })
    }

    pub fn voxels(&self) -> usize {
        self.dims.iter().product()
    }

    fn ijk(&self, v: usize) -> [usize; 3] {
        let [nx, ny, _] = self.dims;
        [v % nx, (v / nx) % ny, v / (nx * ny)]
    }

    fn stride(&self) -> usize {
        match self.pe_axis {
            0 => 1,
            1 => self.dims[0],
            _ => self.dims[0] * self.dims[1],
        }
    }

    /// Voxels of displacement per Hz.
    fn voxels_per_hz(&self) -> f64 {
        self.pe_sign * self.readout_time
    }
}

/// The eddy-current field of one volume: one coefficient (Hz) per term of `model`. The
/// terms use coordinates scaled to -1..1 over the grid (see `Model::terms`), so a
/// coefficient is the field at the edge of the grid.
#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    pub model: Model,
    pub coefficients: Vec<f64>,
}

impl Field {
    pub fn zero(model: Model) -> Self {
        Self {
            model,
            coefficients: vec![0.0; model.len()],
        }
    }

    /// The field (Hz) at every voxel.
    pub fn hz(&self, geometry: &Geometry) -> Vec<f64> {
        (0..geometry.voxels())
            .map(|v| {
                let terms = self.model.terms(geometry, geometry.ijk(v));
                terms
                    .iter()
                    .zip(&self.coefficients)
                    .map(|(t, c)| t * c)
                    .sum()
            })
            .collect()
    }

    /// The displacement (voxels along the PE axis) at every voxel.
    pub fn displacement(&self, geometry: &Geometry) -> Vec<f64> {
        let k = geometry.voxels_per_hz();
        self.hz(geometry).into_iter().map(|f| f * k).collect()
    }

    /// The corrected volume `J(x) · observed(x + d(x))`.
    pub fn correct(&self, geometry: &Geometry, observed: &[f32]) -> Vec<f64> {
        (0..geometry.voxels())
            .map(|v| {
                let (d, j) = self.shift(geometry, v);
                let (value, _) = sample(geometry, observed, v, d);
                j * value
            })
            .collect()
    }

    /// The displacement and the Jacobian 1 + ∂d/∂PE at voxel `v`.
    fn shift(&self, geometry: &Geometry, v: usize) -> (f64, f64) {
        let ijk = geometry.ijk(v);
        let terms = self.model.terms(geometry, ijk);
        let slopes = self.model.pe_derivatives(geometry, ijk);
        let k = geometry.voxels_per_hz();
        let d: f64 = terms
            .iter()
            .zip(&self.coefficients)
            .map(|(t, c)| t * c)
            .sum();
        let s: f64 = slopes
            .iter()
            .zip(&self.coefficients)
            .map(|(t, c)| t * c)
            .sum();
        (k * d, 1.0 + k * s)
    }
}

/// `observed` at voxel `v` moved by `d` voxels along the PE axis, and its derivative along
/// that axis. The PE line is extended with its edge values.
fn sample(geometry: &Geometry, observed: &[f32], v: usize, d: f64) -> (f64, f64) {
    let n = geometry.dims[geometry.pe_axis];
    let stride = geometry.stride();
    let p = geometry.ijk(v)[geometry.pe_axis];
    let start = v - p * stride;
    cubic(|i| observed[start + i * stride] as f64, n, p as f64 + d)
}

/// The result of `fit`.
#[derive(Clone, Debug, PartialEq)]
pub struct Fit {
    pub field: Field,
    /// Mean squared difference from the prediction over the mask, before and after.
    pub initial_cost: f64,
    pub cost: f64,
    pub iterations: usize,
}

/// Fits the eddy-current field of one volume: the field whose correction of `observed` is
/// closest to `predicted` over `mask`. Starts from `start` (a zero field, or the previous
/// iteration's).
pub fn fit(
    geometry: &Geometry,
    observed: &[f32],
    predicted: &[f64],
    mask: &[bool],
    start: &Field,
) -> Result<Fit, String> {
    let n = geometry.voxels();
    if observed.len() != n || predicted.len() != n || mask.len() != n {
        return Err("The observed, predicted and mask volumes must match the grid.".into());
    }
    let voxels: Vec<usize> = (0..n).filter(|&v| mask[v]).collect();
    if voxels.is_empty() {
        return Err("The mask is empty.".into());
    }
    let k = geometry.voxels_per_hz();
    let terms: Vec<Vec<f64>> = voxels
        .iter()
        .map(|&v| start.model.terms(geometry, geometry.ijk(v)))
        .collect();
    let slopes: Vec<Vec<f64>> = voxels
        .iter()
        .map(|&v| start.model.pe_derivatives(geometry, geometry.ijk(v)))
        .collect();
    let cost_of = |field: &Field| -> f64 {
        voxels
            .iter()
            .map(|&v| {
                let (d, j) = field.shift(geometry, v);
                let r = j * sample(geometry, observed, v, d).0 - predicted[v];
                r * r
            })
            .sum::<f64>()
            / voxels.len() as f64
    };
    let m = start.model.len();
    let mut field = start.clone();
    let initial_cost = cost_of(&field);
    let mut cost = initial_cost;
    let mut iterations = 0;
    for _ in 0..50 {
        iterations += 1;
        let mut normal = vec![vec![0.0; m]; m];
        let mut gradient = vec![0.0; m];
        for (idx, &v) in voxels.iter().enumerate() {
            let (d, j) = field.shift(geometry, v);
            let (value, derivative) = sample(geometry, observed, v, d);
            let r = j * value - predicted[v];
            let row: Vec<f64> = (0..m)
                .map(|t| k * (j * derivative * terms[idx][t] + value * slopes[idx][t]))
                .collect();
            for ((g, ra), na) in gradient.iter_mut().zip(&row).zip(normal.iter_mut()) {
                *g += ra * r;
                for (n, rb) in na.iter_mut().zip(&row) {
                    *n += ra * rb;
                }
            }
        }
        // A little Levenberg damping keeps a near-singular step (an empty quadratic term)
        // finite.
        for (a, na) in normal.iter_mut().enumerate() {
            na[a] = na[a] * (1.0 + 1e-9) + 1e-12;
        }
        let step = solve(normal, gradient.iter().map(|g| -g).collect())
            .ok_or("The eddy-current normal matrix is singular.")?;
        // Halve the step until the cost goes down.
        let mut scale = 1.0;
        let mut accepted = None;
        for _ in 0..20 {
            let trial = Field {
                model: field.model,
                coefficients: field
                    .coefficients
                    .iter()
                    .zip(&step)
                    .map(|(c, s)| c + scale * s)
                    .collect(),
            };
            let trial_cost = cost_of(&trial);
            if trial_cost <= cost {
                accepted = Some((trial, trial_cost));
                break;
            }
            scale *= 0.5;
        }
        let Some((trial, trial_cost)) = accepted else {
            break;
        };
        let improvement = (cost - trial_cost) / cost.max(f64::MIN_POSITIVE);
        field = trial;
        cost = trial_cost;
        if improvement < 1e-10 {
            break;
        }
    }
    Ok(Fit {
        field,
        initial_cost,
        cost,
        iterations,
    })
}

/// The second-level model, as eddy's `--slm`: how a field coefficient varies across the
/// volumes, as a function of q = gradient direction · √(b / b_max) (the gradient amplitude
/// at fixed timing). Neither has a constant term.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecondLevel {
    /// `--slm linear`: q_x, q_y, q_z.
    Linear,
    /// `--slm quadratic`: also q_x², q_y², q_z², q_x q_y, q_x q_z, q_y q_z.
    Quadratic,
}

impl SecondLevel {
    fn terms(&self, q: [f64; 3]) -> Vec<f64> {
        let [x, y, z] = q;
        let mut t = vec![x, y, z];
        if *self == SecondLevel::Quadratic {
            t.extend([x * x, y * y, z * z, x * y, x * z, y * z]);
        }
        t
    }
}

/// Replaces each volume's field by the second-level model fitted across the volumes (least
/// squares, one coefficient at a time).
///
/// Fitted one volume at a time, the fields have a part that is the same in every volume:
/// it moves every prediction with it, so the data cannot fix it, and it drifts from one
/// iteration to the next. The second-level model removes that part and pools the noise of
/// the single-volume fits. It needs gradient directions over the whole sphere: on a half
/// sphere the neighbours of a direction share its distortion, and the predictions carry it.
pub fn second_level(
    fields: &[Field],
    bvals: &[f64],
    bvecs: &[[f64; 3]],
    model: SecondLevel,
) -> Result<Vec<Field>, String> {
    if fields.len() != bvals.len() || bvals.len() != bvecs.len() {
        return Err("There must be one field, b-value and direction per volume.".into());
    }
    let Some(first) = fields.first() else {
        return Ok(Vec::new());
    };
    if fields.iter().any(|f| f.model != first.model) {
        return Err("All fields must use one model.".into());
    }
    let b_max = bvals.iter().copied().fold(0.0, f64::max);
    let rows: Vec<Vec<f64>> = bvals
        .iter()
        .zip(bvecs)
        .map(|(&b, g)| model.terms(g.map(|c| c * (b / b_max).sqrt())))
        .collect();
    let p = rows[0].len();
    let mut normal = vec![vec![0.0; p]; p];
    for row in &rows {
        for (na, ra) in normal.iter_mut().zip(row) {
            for (n, rb) in na.iter_mut().zip(row) {
                *n += ra * rb;
            }
        }
    }
    let mut out: Vec<Field> = fields.iter().map(|f| Field::zero(f.model)).collect();
    for k in 0..first.model.len() {
        let mut rhs = vec![0.0; p];
        for (row, f) in rows.iter().zip(fields) {
            for (r, ra) in rhs.iter_mut().zip(row) {
                *r += ra * f.coefficients[k];
            }
        }
        let weights = solve(normal.clone(), rhs).ok_or(match model {
            SecondLevel::Linear => "The gradient directions do not span three dimensions.",
            SecondLevel::Quadratic => {
                "The gradient directions do not determine a quadratic second-level model."
            }
        })?;
        for (o, row) in out.iter_mut().zip(&rows) {
            o.coefficients[k] = row.iter().zip(&weights).map(|(r, w)| r * w).sum();
        }
    }
    Ok(out)
}

/// Under-relaxation between iterations: `previous + omega · (new - previous)` per
/// coefficient. Each volume is fitted against predictions from volumes that are still
/// distorted, and its antipodal neighbours are distorted the opposite way, so a full step
/// overshoots (by about 1.55 on the synthetic phantom); `omega` = 0.65 removes most of it.
pub fn relax(previous: &[Field], new: &[Field], omega: f64) -> Vec<Field> {
    previous
        .iter()
        .zip(new)
        .map(|(p, n)| Field {
            model: n.model,
            coefficients: p
                .coefficients
                .iter()
                .zip(&n.coefficients)
                .map(|(a, b)| a + omega * (b - a))
                .collect(),
        })
        .collect()
}

/// Solves a small dense system by Gaussian elimination with partial pivoting. A pivot below
/// 1e-13 of the largest entry counts as singular, so a rank-deficient system is refused
/// rather than solved from rounding noise.
fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    let scale = a.iter().flatten().fold(0.0f64, |m, x| m.max(x.abs()));
    for col in 0..n {
        let pivot = (col..n).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[pivot][col].abs() <= 1e-13 * scale || !a[pivot][col].is_finite() {
            return None;
        }
        a.swap(col, pivot);
        b.swap(col, pivot);
        for row in col + 1..n {
            let f = a[row][col] / a[col][col];
            let pivot_row = a[col].clone();
            for (x, p) in a[row][col..].iter_mut().zip(&pivot_row[col..]) {
                *x -= f * p;
            }
            b[row] -= f * b[col];
        }
    }
    let mut x = vec![0.0; n];
    for row in (0..n).rev() {
        let s: f64 = (row + 1..n).map(|c| a[row][c] * x[c]).sum();
        x[row] = (b[row] - s) / a[row][row];
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solve_small_system() {
        let x = solve(vec![vec![0.0, 2.0], vec![3.0, 1.0]], vec![4.0, 5.0]).unwrap();
        assert!((x[0] - 1.0).abs() < 1e-15 && (x[1] - 2.0).abs() < 1e-15);
        assert!(solve(vec![vec![0.0, 0.0], vec![0.0, 0.0]], vec![1.0, 1.0]).is_none());
    }

    #[test]
    fn second_level_keeps_the_gradient_linear_part_and_drops_the_common_part() {
        let bvals = [1000.0, 1000.0, 2000.0, 2000.0, 2000.0, 1000.0];
        let bvecs = [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [-0.6, 0.8, 0.0],
            [0.0, -0.6, -0.8],
            [0.48, 0.6, -0.64],
        ];
        // Coefficient 0 is 3·q_x + 5 in every volume: the 5 is common to all and goes.
        let fields: Vec<Field> = bvals
            .iter()
            .zip(&bvecs)
            .map(|(&b, g)| {
                let q = g.map(|c| c * (b / 2000.0f64).sqrt());
                let mut f = Field::zero(Model::Linear);
                f.coefficients[0] = 3.0 * q[0];
                f.coefficients[2] = -2.0 * q[1] + 4.0 * q[2];
                f
            })
            .collect();
        let modelled = second_level(&fields, &bvals, &bvecs, SecondLevel::Linear).unwrap();
        for (m, f) in modelled.iter().zip(&fields) {
            for (a, b) in m.coefficients.iter().zip(&f.coefficients) {
                assert!((a - b).abs() < 1e-12);
            }
        }
        let shifted: Vec<Field> = fields
            .iter()
            .map(|f| {
                let mut f = f.clone();
                f.coefficients[0] += 5.0;
                f
            })
            .collect();
        let modelled = second_level(&shifted, &bvals, &bvecs, SecondLevel::Linear).unwrap();
        let mean: f64 = modelled.iter().map(|f| f.coefficients[0]).sum::<f64>() / 6.0;
        let original: f64 = fields.iter().map(|f| f.coefficients[0]).sum::<f64>() / 6.0;
        assert!((mean - original).abs() < 2.0, "{mean} vs {original}");
        assert!(second_level(&fields, &bvals[..5], &bvecs[..5], SecondLevel::Linear).is_err());
    }

    #[test]
    fn quadratic_second_level_keeps_even_parts_that_linear_drops() {
        // 20 directions over the sphere, two shells.
        let bvecs: Vec<[f64; 3]> = (0..20)
            .map(|i| {
                let z = 1.0 - 2.0 * (i as f64 + 0.5) / 20.0;
                let r = (1.0 - z * z).sqrt();
                let phi = i as f64 * 2.399_963;
                [r * phi.cos(), r * phi.sin(), z]
            })
            .collect();
        let bvals: Vec<f64> = (0..20)
            .map(|i| if i % 2 == 0 { 1000.0 } else { 2000.0 })
            .collect();
        let fields: Vec<Field> = bvals
            .iter()
            .zip(&bvecs)
            .map(|(&b, g)| {
                let q = g.map(|c| c * (b / 2000.0f64).sqrt());
                let mut f = Field::zero(Model::Linear);
                f.coefficients[1] = 2.0 * q[0] + 3.0 * q[0] * q[1] - q[2] * q[2];
                f
            })
            .collect();
        let quadratic = second_level(&fields, &bvals, &bvecs, SecondLevel::Quadratic).unwrap();
        for (m, f) in quadratic.iter().zip(&fields) {
            assert!((m.coefficients[1] - f.coefficients[1]).abs() < 1e-12);
        }
        let linear = second_level(&fields, &bvals, &bvecs, SecondLevel::Linear).unwrap();
        let residual = linear
            .iter()
            .zip(&fields)
            .map(|(m, f)| (m.coefficients[1] - f.coefficients[1]).abs())
            .fold(0.0, f64::max);
        assert!(residual > 0.1, "{residual}");
        // Fewer volumes than terms cannot determine the quadratic model.
        assert!(
            second_level(
                &fields[..6],
                &bvals[..6],
                &bvecs[..6],
                SecondLevel::Quadratic
            )
            .is_err()
        );
    }

    #[test]
    fn relax_moves_part_of_the_way() {
        let mut a = Field::zero(Model::Linear);
        let mut b = Field::zero(Model::Linear);
        a.coefficients[1] = 1.0;
        b.coefficients[1] = 3.0;
        assert_eq!(relax(&[a], &[b], 0.25)[0].coefficients[1], 1.5);
    }

    #[test]
    fn geometry_is_checked() {
        assert!(Geometry::new([4, 4, 4], [2.0; 3], 3, 1.0, 0.05).is_err());
        assert!(Geometry::new([4, 4, 4], [2.0; 3], 1, 0.5, 0.05).is_err());
        assert!(Geometry::new([4, 4, 4], [2.0; 3], 1, 1.0, 0.0).is_err());
        assert!(Geometry::new([4, 4, 4], [2.0, 0.0, 2.0], 1, 1.0, 0.05).is_err());
    }

    #[test]
    fn a_constant_field_moves_a_ramp_by_its_displacement() {
        // observed(p) = p along the PE axis; a 10 Hz field with 0.05 s readout moves by 0.5.
        let g = Geometry::new([1, 8, 1], [2.0; 3], 1, 1.0, 0.05).unwrap();
        let observed: Vec<f32> = (0..8).map(|p| p as f32).collect();
        let mut field = Field::zero(Model::Linear);
        field.coefficients[0] = 10.0;
        let corrected = field.correct(&g, &observed);
        for (p, &c) in corrected.iter().enumerate().take(6).skip(1) {
            assert!((c - (p as f64 + 0.5)).abs() < 1e-12, "{p}: {c}");
        }
    }
}
