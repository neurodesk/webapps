// SPDX-License-Identifier: Artistic-2.0
//! NODDI by the NODDI toolbox 1.05 (Zhang et al. 2012): a port of its in-vivo
//! `WatsonSHStickTortIsoV_B0` model and its two-stage fit (`ThreeStageFittingVoxel` with
//! `noOfStages = 2`). Each function names the toolbox file it ports; README.md lists how
//! the port differs from the toolbox.
//!
//! The toolbox keeps eight parameters, scaled as `GetScalingFactors` does: ficvf, di (in
//! µm²/ms), kappa (the Watson concentration over 10), fiso, diso (µm²/ms), b0, theta and
//! phi. di = 1.7, diso = 3.0 and b0 (the mean b0 signal) stay fixed.

pub mod rician;
pub mod watson;

use dwi_gp::lbfgsb;
use std::f64::consts::PI;

/// `FSL2Protocol`'s gyromagnetic ratio and its maximum gradient strength.
const GAMMA: f64 = 2.675987E8;
const GMAX: f64 = 0.04;
/// `GetScalingFactors('WatsonSHStickTortIsoV_B0')` for the six non-angle parameters.
const SCALE: [f64; 6] = [1.0, 1E9, 0.1, 1.0, 1E9, 1.0];
/// `MakeModel`'s in-vivo fixed diffusivities (m²/s).
const DI: f64 = 1.7E-9;
const DISO: f64 = 3.0E-9;
/// `GetSearchGrid('WatsonSHStickTortIsoV_B0', 'invivo', ...)` with di and diso fixed.
const GRID_FICVF: [f64; 5] = [0.0, 0.25, 0.5, 0.75, 1.0];
const GRID_FISO: [f64; 5] = [0.0, 0.25, 0.5, 0.75, 1.0];
const GRID_KAPPA: [f64; 5] = [0.5, 1.0, 2.0, 4.0, 8.0];
/// `GradDescLimits`: the bounds of the encoded ficvf/fiso, kappa and angles.
const LARGE: f64 = 100000.0;
const K_MAX: f64 = 6.4;
const ANGLE_MAX: f64 = 100.0;
/// The parameters each gradient-descent stage fits: ficvf and fiso with the orientation and
/// kappa fixed, then ficvf, kappa, fiso, theta and phi.
const STAGE_1: [usize; 2] = [0, 3];
const STAGE_2: [usize; 5] = [0, 2, 3, 6, 7];

/// The acquisition as `FSL2Protocol(bval, bvec, b0threshold)` builds it.
pub struct Protocol {
    /// b-values in s/m², from the toolbox's pulse timing.
    b: Vec<f64>,
    /// Unit gradient directions; [1, 0, 0] for a b0.
    dirs: Vec<[f64; 3]>,
    b0: Vec<usize>,
    /// The terms of the fixed diffusivities at the grid's values and at the values the
    /// gradient descent decodes (the same up to rounding of the square-root encoding).
    grid: Fixed,
    descent: Fixed,
}

/// The parts of the signal that depend only on di and diso, which the model keeps fixed.
struct Fixed {
    di: f64,
    /// `LegendreGaussianIntegral(b · di, 6)` of each measurement.
    lgi: Vec<[f64; 7]>,
    /// `SynthMeasIsoGPD(diso)` of each measurement.
    iso: Vec<f64>,
}

impl Fixed {
    fn new(b: &[f64], di: f64, diso: f64) -> Self {
        Fixed {
            di,
            lgi: b
                .iter()
                .map(|&b| watson::legendre_gaussian_integral(b * di))
                .collect(),
            iso: b.iter().map(|&b| (-b * diso).exp()).collect(),
        }
    }
}

impl Protocol {
    /// `bvals` in s/mm²; a volume with b ≤ `b0_threshold` is a b0 volume.
    pub fn new(bvals: &[f64], bvecs: &[[f64; 3]], b0_threshold: f64) -> Result<Self, String> {
        if bvals.len() != bvecs.len() {
            return Err("The gradient table needs one b-vector per b-value.".into());
        }
        let b0: Vec<usize> = (0..bvals.len())
            .filter(|&i| bvals[i] <= b0_threshold)
            .collect();
        if b0.is_empty() {
            return Err("The NODDI toolbox fit needs a b0 volume.".into());
        }
        let max_b = bvals
            .iter()
            .copied()
            .filter(|&b| b > b0_threshold)
            .fold(f64::NAN, f64::max);
        if max_b.is_nan() {
            return Err("The NODDI toolbox fit needs diffusion-weighted volumes.".into());
        }
        // delta = smalldel = tmp; G = sqrt(B / maxB) * Gmax for each shell B.
        let tmp = (3.0 * max_b * 1e6 / (2.0 * GAMMA * GAMMA * GMAX * GMAX)).cbrt();
        let mut b = Vec::with_capacity(bvals.len());
        let mut dirs = Vec::with_capacity(bvals.len());
        for (&bval, g) in bvals.iter().zip(bvecs) {
            if bval <= b0_threshold {
                b.push(0.0);
                dirs.push([1.0, 0.0, 0.0]);
                continue;
            }
            let gradient = (bval / max_b).sqrt() * GMAX;
            let mod_q = GAMMA * tmp * gradient;
            b.push((tmp - tmp / 3.0) * mod_q * mod_q);
            let norm = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
            if norm.is_nan() || norm == 0.0 {
                return Err("Every diffusion-weighted volume needs a non-zero b-vector.".into());
            }
            dirs.push([g[0] / norm, g[1] / norm, g[2] / norm]);
        }
        let grid = Fixed::new(&b, DI, DISO);
        // The gradient descent decodes di and diso from their square roots.
        let decoded = decode(&encode(&[
            0.0,
            DI * SCALE[1],
            0.0,
            0.0,
            DISO * SCALE[4],
            1.0,
            0.0,
            0.0,
        ]));
        let descent = Fixed::new(&b, decoded[1] / SCALE[1], decoded[4] / SCALE[4]);
        Ok(Protocol {
            b,
            dirs,
            b0,
            grid,
            descent,
        })
    }

    pub fn len(&self) -> usize {
        self.b.len()
    }

    pub fn is_empty(&self) -> bool {
        self.b.is_empty()
    }
}

/// The free parameters of one evaluation, unscaled: ficvf, kappa (the Watson concentration),
/// fiso, b0 and the fibre direction. di and diso are in [`Fixed`].
struct Params {
    ficvf: f64,
    kappa: f64,
    fiso: f64,
    b0: f64,
    dir: [f64; 3],
}

/// `SynthMeasWatsonSHStickTortIsoV_B0` at the measurements in `kept`, written into `out`.
/// `fixed` holds the terms of di and diso.
fn synth(p: &Params, fixed: &Fixed, protocol: &Protocol, kept: &[usize], out: &mut [f64]) {
    // The stick: SynthMeasWatsonSHCylNeuman_PGSE with R = 0, so LePerp = 0.
    let coeff = watson::sh_coeff(p.kappa);
    let mut min_positive = f64::INFINITY;
    for (e, &m) in out.iter_mut().zip(kept) {
        let lgi = fixed.lgi[m];
        let g = protocol.dirs[m];
        let mut cos = g[0] * p.dir[0] + g[1] * p.dir[1] + g[2] * p.dir[2];
        if cos.abs() > 1.0 {
            cos /= cos.abs();
        }
        // P_0 .. P_12 at cos by Bonnet's recurrence; the even orders weight the coefficients.
        let mut legendre = [0.0; 13];
        legendre[0] = 1.0;
        legendre[1] = cos;
        for l in 1..12 {
            let k = l as f64;
            legendre[l + 1] =
                ((2.0 * k + 1.0) * cos * legendre[l] - k * legendre[l - 1]) / (k + 1.0);
        }
        let mut sum = 0.0;
        for i in 0..7 {
            let sh = ((i as f64 + 1.0 - 0.75) / PI).sqrt() * legendre[2 * i];
            sum += lgi[i] * coeff[i] * sh;
        }
        *e = sum;
        if sum > 0.0 {
            min_positive = min_positive.min(sum);
        }
    }
    // The hindered compartment with tortuosity: dPerp = di (1 - ficvf).
    let d_perp = fixed.di * (1.0 - p.ficvf);
    let [dw_par, dw_perp] = watson::hindered_coeff(fixed.di, d_perp, p.kappa);
    for (e, &m) in out.iter_mut().zip(kept) {
        if *e <= 0.0 {
            *e = min_positive * 0.1;
        }
        let stick = 0.5 * *e;
        let g = protocol.dirs[m];
        let cos = g[0] * p.dir[0] + g[1] * p.dir[1] + g[2] * p.dir[2];
        let hindered = (-protocol.b[m] * ((dw_par - dw_perp) * (cos * cos) + dw_perp)).exp();
        let aniso = (1.0 - p.ficvf) * hindered + p.ficvf * stick;
        let iso = fixed.iso[m];
        *e = ((1.0 - p.fiso) * aniso + p.fiso * iso) * p.b0;
    }
}

fn direction(theta: f64, phi: f64) -> [f64; 3] {
    [
        phi.cos() * theta.sin(),
        phi.sin() * theta.sin(),
        theta.cos(),
    ]
}

/// `GradDescEncode('WatsonSHStickTortIsoV_B0', x)`.
fn encode(x: &[f64; 8]) -> [f64; 8] {
    [
        x[0].sqrt().asin(),
        x[1].sqrt(),
        x[2].sqrt(),
        x[3].sqrt().asin(),
        x[4].sqrt(),
        x[5].sqrt(),
        x[6],
        x[7],
    ]
}

/// `GradDescDecode('WatsonSHStickTortIsoV_B0', x)`.
fn decode(x: &[f64; 8]) -> [f64; 8] {
    let sin2 = |v: f64| v.sin() * v.sin();
    [
        sin2(x[0]),
        x[1] * x[1],
        x[2] * x[2],
        sin2(x[3]),
        x[4] * x[4],
        x[5] * x[5],
        x[6],
        x[7],
    ]
}

/// The toolbox's scaled parameters as the forward model takes them (`fobj_rician`).
fn unscale(x: &[f64; 8]) -> Params {
    Params {
        ficvf: x[0] / SCALE[0],
        kappa: x[2] / SCALE[2],
        fiso: x[3] / SCALE[3],
        b0: x[5] / SCALE[5],
        dir: direction(x[6], x[7]),
    }
}

/// One voxel's result. `params` are the toolbox's `mlps` (scaled, see the crate docs).
#[derive(Clone, Debug, PartialEq)]
pub struct Fit {
    pub params: [f64; 8],
    /// The grid-search start (`gsps`).
    pub grid: [f64; 8],
    /// The Rician log-likelihood at `params` (`fobj_ml`).
    pub log_likelihood: f64,
    /// 0: fitted; 1: too few positive measurements; 2: the gradient descent failed.
    pub error_code: u8,
    /// Neither gradient-descent stage stopped at the iteration limit. The toolbox does not
    /// check fmincon's exit flag; this is a diagnostic only.
    pub converged: bool,
}

impl Fit {
    pub fn ficvf(&self) -> f64 {
        self.params[0]
    }

    pub fn fiso(&self) -> f64 {
        self.params[3]
    }

    /// `SaveParamsAsNIfTI`'s ODI: atan2(1, kappa · 10) · 2/π.
    pub fn odi(&self) -> f64 {
        1f64.atan2(self.params[2] * 10.0) * 2.0 / PI
    }

    /// `GetFibreOrientation`: the unit fibre direction in the b-vector frame.
    pub fn direction(&self) -> [f64; 3] {
        direction(self.params[6], self.params[7])
    }
}

/// `ThreeStageFittingVoxel(signal, protocol, MakeModel('WatsonSHStickTortIsoV_B0'))`.
pub fn fit_voxel(protocol: &Protocol, signal: &[f64]) -> Fit {
    assert_eq!(signal.len(), protocol.len());
    let failed = |error_code| Fit {
        params: [0.0; 8],
        grid: [0.0; 8],
        log_likelihood: 0.0,
        error_code,
        converged: false,
    };
    // RemoveNegMeas: drop non-positive measurements, keeping at least one b0 and six others.
    let kept: Vec<usize> = (0..signal.len()).filter(|&i| signal[i] > 0.0).collect();
    let b0: Vec<usize> = protocol
        .b0
        .iter()
        .copied()
        .filter(|&i| signal[i] > 0.0)
        .collect();
    if b0.is_empty() || kept.len() - b0.len() < 6 {
        return failed(1);
    }
    let meas: Vec<f64> = kept.iter().map(|&i| signal[i]).collect();

    // EstimateSigma: the population standard deviation of the b0 signal, at least
    // minSNR (0.02) times its mean, divided by sigma.scaling (100).
    let b0_mean = b0.iter().map(|&i| signal[i]).sum::<f64>() / b0.len() as f64;
    let variance = b0
        .iter()
        .map(|&i| (signal[i] - b0_mean) * (signal[i] - b0_mean))
        .sum::<f64>()
        / b0.len() as f64;
    let sig = variance.sqrt().max(0.02 * b0_mean) / 100.0;

    // GridSearchRician: the tensor's principal direction and S0, then the best grid point.
    let Some((fibredir, s0)) = linear_tensor(protocol, &kept, &b0, signal) else {
        return failed(2);
    };
    let theta = fibredir[2].acos();
    let phi = fibredir[1].atan2(fibredir[0]);
    let mut predicted = vec![0.0; kept.len()];
    let mut best = (f64::NEG_INFINITY, [0.0; 3]);
    for &ficvf in &GRID_FICVF {
        for &fiso in &GRID_FISO {
            for &kappa in &GRID_KAPPA {
                let p = Params {
                    ficvf,
                    kappa,
                    fiso,
                    b0: s0,
                    dir: fibredir,
                };
                synth(&p, &protocol.grid, protocol, &kept, &mut predicted);
                let lik = rician::log_likelihood(&meas, &predicted, sig);
                if lik > best.0 {
                    best = (lik, [ficvf, kappa, fiso]);
                }
            }
        }
    }
    let [ficvf, kappa, fiso] = best.1;
    let grid = [
        ficvf * SCALE[0],
        DI * SCALE[1],
        kappa * SCALE[2],
        fiso * SCALE[3],
        DISO * SCALE[4],
        s0 * SCALE[5],
        theta,
        phi,
    ];
    let mut result = Fit {
        params: grid,
        grid,
        log_likelihood: best.0,
        error_code: 0,
        converged: false,
    };
    if !best.0.is_finite() {
        result.error_code = 2;
        return result;
    }

    // Two fmincon_fix stages on fobj_rician_fix in the encoded parameters.
    let objective = |x: &[f64; 8], predicted: &mut [f64]| {
        synth(
            &unscale(&decode(x)),
            &protocol.descent,
            protocol,
            &kept,
            predicted,
        );
        -rician::log_likelihood(&meas, predicted, sig)
    };
    let start = encode(&grid);
    let Some(stage_1) = minimize(&objective, &start, &STAGE_1, &mut predicted) else {
        result.error_code = 2;
        return result;
    };
    let Some(stage_2) = minimize(&objective, &stage_1.0, &STAGE_2, &mut predicted) else {
        result.error_code = 2;
        return result;
    };
    result.converged = stage_1.2 && stage_2.2;
    if -stage_2.1 > result.log_likelihood {
        result.log_likelihood = -stage_2.1;
        result.params = decode(&stage_2.0);
    }
    result
}

/// `GradDescLimits` of one encoded parameter.
fn limits(index: usize) -> (f64, f64) {
    match index {
        0 | 3 => (0.0, LARGE),
        2 => (0.0, K_MAX.sqrt()),
        _ => (-ANGLE_MAX, ANGLE_MAX),
    }
}

/// Minimises `objective` over the parameters in `free`, the others fixed at `start`, within
/// `GradDescLimits`. The toolbox calls fmincon's active-set SQP; this is L-BFGS-B with central
/// difference gradients. Returns the parameters, the objective and whether it stopped
/// before the iteration limit; None when the objective is not finite (`FunValCheck`).
fn minimize<F>(
    objective: &F,
    start: &[f64; 8],
    free: &[usize],
    predicted: &mut [f64],
) -> Option<([f64; 8], f64, bool)>
where
    F: Fn(&[f64; 8], &mut [f64]) -> f64,
{
    let full = |values: &[f64]| {
        let mut x = *start;
        for (&i, &v) in free.iter().zip(values) {
            x[i] = v;
        }
        x
    };
    let lower: Vec<f64> = free.iter().map(|&i| limits(i).0).collect();
    let upper: Vec<f64> = free.iter().map(|&i| limits(i).1).collect();
    let x0: Vec<f64> = free.iter().map(|&i| start[i]).collect();
    let mut finite = true;
    let result = lbfgsb::minimize(
        |values, gradient| {
            let f = objective(&full(values), predicted);
            finite &= f.is_finite();
            for k in 0..values.len() {
                let h = 1e-6 * values[k].abs().max(1.0);
                let mut moved = values.to_vec();
                moved[k] = (values[k] + h).min(upper[k]);
                let up = objective(&full(&moved), predicted);
                let hi = moved[k];
                moved[k] = (values[k] - h).max(lower[k]);
                let down = objective(&full(&moved), predicted);
                gradient[k] = (up - down) / (hi - moved[k]);
            }
            f
        },
        &x0,
        &lower,
        &upper,
        &lbfgsb::Options {
            maxiter: MAX_ITERATIONS,
            ftol: 0.0,
            ..lbfgsb::Options::default()
        },
    )
    .ok()?;
    // status 1 is the iteration or evaluation limit.
    (finite && result.fun.is_finite()).then(|| (full(&result.x), result.fun, result.status != 1))
}

/// The toolbox stops fmincon at TolFun 1e-6, absolute on a log-likelihood of 1e5 to 1e6.
/// L-BFGS-B's ftol is relative, and scipy's default (2.2e-9) stopped it short of the toolbox's
/// optimum in 1548 of the 13327 WM gate voxels. With ftol 0 each stage runs until its line
/// search cannot lower the objective; 259 voxels then differ by more than 0.01, and on the
/// gate no stage reached this iteration limit.
const MAX_ITERATIONS: usize = 1000;

/// `FitLinearDT(E, protocol)` without S0, then `GridSearchRician`'s fibre direction: the
/// eigenvector of the eigenvalue largest in magnitude. Returns it and S0 = mean b0 signal.
fn linear_tensor(
    protocol: &Protocol,
    kept: &[usize],
    b0: &[usize],
    signal: &[f64],
) -> Option<([f64; 3], f64)> {
    let s0 = b0.iter().map(|&i| signal[i]).sum::<f64>() / b0.len() as f64;
    // Normal equations of the six tensor elements on log(E / S0) (pinv(X) * y for a full-rank X).
    let mut normal = [[0.0; 6]; 6];
    let mut rhs = [0.0; 6];
    for &m in kept {
        let g = protocol.dirs[m];
        let b = protocol.b[m];
        let row = [
            -b * g[0] * g[0],
            -2.0 * b * g[0] * g[1],
            -2.0 * b * g[0] * g[2],
            -b * g[1] * g[1],
            -2.0 * b * g[1] * g[2],
            -b * g[2] * g[2],
        ];
        let y = (signal[m] / s0).ln();
        for r in 0..6 {
            rhs[r] += row[r] * y;
            for c in 0..6 {
                normal[r][c] += row[r] * row[c];
            }
        }
    }
    let d = solve6(normal, rhs)?;
    let (values, vectors) =
        dwi_tensor::eigen_symmetric([[d[0], d[1], d[2]], [d[1], d[3], d[4]], [d[2], d[4], d[5]]]);
    let largest = (0..3).max_by(|&i, &j| values[i].abs().total_cmp(&values[j].abs()))?;
    vectors[largest]
        .iter()
        .all(|v| v.is_finite())
        .then_some((vectors[largest], s0))
}

/// Solves a symmetric positive-definite 6×6 system by Gaussian elimination with partial
/// pivoting; None when it is singular.
fn solve6(mut a: [[f64; 6]; 6], mut b: [f64; 6]) -> Option<[f64; 6]> {
    for col in 0..6 {
        let pivot = (col..6).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        let size = a[pivot][col].abs();
        if size.is_nan() || size == 0.0 {
            return None;
        }
        a.swap(col, pivot);
        b.swap(col, pivot);
        let pivot_row = a[col];
        for row in col + 1..6 {
            let factor = a[row][col] / pivot_row[col];
            for (value, &p) in a[row].iter_mut().zip(&pivot_row).skip(col) {
                *value -= factor * p;
            }
            b[row] -= factor * b[col];
        }
    }
    let mut x = [0.0; 6];
    for row in (0..6).rev() {
        let mut sum = b[row];
        for k in row + 1..6 {
            sum -= a[row][k] * x[k];
        }
        x[row] = sum / a[row][row];
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protocol() -> Protocol {
        let mut bvals = vec![0.0; 3];
        let mut bvecs = vec![[0.0; 3]; 3];
        for (shell, count) in [(1000.0, 30), (2000.0, 30)] {
            for i in 0..count {
                // Points on a spiral over the sphere.
                let z = 1.0 - 2.0 * (i as f64 + 0.5) / count as f64;
                let r = (1.0 - z * z).sqrt();
                let a = i as f64 * 2.399963 + shell / 1000.0;
                bvals.push(shell);
                bvecs.push([r * a.cos(), r * a.sin(), z]);
            }
        }
        Protocol::new(&bvals, &bvecs, 0.0).unwrap()
    }

    #[test]
    fn protocol_reproduces_the_b_values() {
        let p = protocol();
        assert_eq!(p.b0, vec![0, 1, 2]);
        assert!((p.b[3] / 1e9 - 1.0).abs() < 1e-12, "{}", p.b[3]);
        assert!((p.b[40] / 2e9 - 1.0).abs() < 1e-12, "{}", p.b[40]);
    }

    #[test]
    fn fit_recovers_a_noise_free_voxel() {
        let p = protocol();
        let all: Vec<usize> = (0..p.len()).collect();
        let truth = [0.6, 1.7, 0.25, 0.1, 3.0, 1000.0, 0.7, 0.4];
        let mut signal = vec![0.0; p.len()];
        synth(&unscale(&truth), &p.descent, &p, &all, &mut signal);
        // EstimateSigma needs b0 spread; perturb the b0s symmetrically.
        signal[0] *= 1.01;
        signal[2] *= 0.99;
        let fit = fit_voxel(&p, &signal);
        assert_eq!(fit.error_code, 0);
        assert!((fit.ficvf() - 0.6).abs() < 0.01, "{fit:?}");
        assert!((fit.fiso() - 0.1).abs() < 0.01, "{fit:?}");
        assert!((fit.params[2] - 0.25).abs() < 0.01, "{fit:?}");
        let d = fit.direction();
        let want = direction(0.7, 0.4);
        let dot = d[0] * want[0] + d[1] * want[1] + d[2] * want[2];
        assert!(dot.abs() > 0.9999, "{d:?}");
        assert!(fit.log_likelihood >= rician_at(&p, &signal, &fit.grid));
    }

    fn rician_at(p: &Protocol, signal: &[f64], x: &[f64; 8]) -> f64 {
        let all: Vec<usize> = (0..p.len()).collect();
        let mut predicted = vec![0.0; p.len()];
        synth(&unscale(x), &p.descent, p, &all, &mut predicted);
        let b0 = [signal[0], signal[1], signal[2]];
        let mean = b0.iter().sum::<f64>() / 3.0;
        let sd = (b0.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / 3.0).sqrt();
        rician::log_likelihood(signal, &predicted, sd.max(0.02 * mean) / 100.0)
    }

    #[test]
    fn too_few_positive_measurements_is_error_code_1() {
        let p = protocol();
        let mut signal = vec![0.0; p.len()];
        signal[0] = 100.0;
        for v in signal.iter_mut().skip(3).take(5) {
            *v = 50.0;
        }
        let fit = fit_voxel(&p, &signal);
        assert_eq!(fit.error_code, 1);
        assert_eq!(fit.params, [0.0; 8]);
        assert_eq!(fit.odi(), 1.0);
    }
}
