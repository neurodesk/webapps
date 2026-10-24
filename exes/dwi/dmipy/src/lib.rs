// SPDX-License-Identifier: MIT
//! dmipy 1.0.5 NODDI-Watson forward model and brute2fine fit.
//! Source: AthenaEPI/dmipy@2d6073218eb4ebc97645ac6e275270c36834e33d.
//! Arrays use [theta, phi, ODI, ICVF, ISOVF]; b values are s/mm².

mod harmonics;
mod sampling;

use harmonics::{basis, count, project, pseudoinverse, rotational_basis};
use std::f64::consts::PI;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(pub &'static str);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}

struct Shell {
    bval: f64,
    order: usize,
    members: Vec<usize>,
    design: Vec<Vec<f64>>,
    inverse_rh: Vec<Vec<f64>>,
}

pub struct Model {
    bvals: Vec<f64>,
    b0: Vec<usize>,
    shells: Vec<Shell>,
    inverse_watson: Vec<Vec<Vec<f64>>>,
    grid: Vec<[f64; 5]>,
    signals: Vec<Vec<f64>>,
}

fn shell_order(bval: f64) -> usize {
    let thresholds = [
        202.020202,
        707.070707,
        1212.12121,
        2525.25253,
        3131.31313,
        5353.53535,
        f64::INFINITY,
    ];
    2 * (thresholds.iter().position(|&limit| bval < limit).unwrap() + 1)
}
fn watson_order(odi: f64) -> usize {
    let thresholds = [
        0.80606061, 0.46666667, 0.25333333, 0.15636364, 0.09818182, 0.06909091, 0.0,
    ];
    2 * (thresholds.iter().position(|&limit| odi > limit).unwrap() + 1)
}

// hyp1f1(1/2, 3/2, kappa) = sum kappa^n / (n! (2n+1)).
// This is dmipy's normalizer; its bounded positive kappa has no cancellation.
fn normalizer(kappa: f64) -> f64 {
    let mut power = 1.0;
    let mut sum = 1.0;
    for n in 1..1000 {
        power *= kappa / n as f64;
        let term = power / (2 * n + 1) as f64;
        sum += term;
        if term <= sum * 1e-17 {
            break;
        }
    }
    4.0 * PI * sum
}

impl Model {
    pub fn volumes(&self) -> usize {
        self.bvals.len()
    }

    pub fn new(bvals: &[f64], gradients: &[[f64; 3]]) -> Result<Self, Error> {
        if bvals.len() != gradients.len()
            || bvals.len() < 2
            || bvals.iter().any(|v| !v.is_finite() || *v < 0.0)
            || gradients.iter().flatten().any(|v| !v.is_finite())
        {
            return Err(Error("Finite matching b-values and gradients are required"));
        }
        let b0: Vec<_> = (0..bvals.len()).filter(|&i| bvals[i] <= 50.0).collect();
        if b0.is_empty() || b0.len() == bvals.len() {
            return Err(Error(
                "The model requires b0 and diffusion-weighted measurements",
            ));
        }
        let mut directions = gradients.to_vec();
        for i in 0..bvals.len() {
            if bvals[i] <= 50.0 {
                directions[i] = [0.0; 3];
            } else {
                let norm = directions[i].iter().map(|v| v * v).sum::<f64>().sqrt();
                if !norm.is_finite() || norm <= 0.0 {
                    return Err(Error(
                        "Diffusion-weighted directions must have finite positive length",
                    ));
                }
                directions[i].iter_mut().for_each(|value| *value /= norm);
            }
        }
        let inverse_watson = (0..=14)
            .step_by(2)
            .map(|order| {
                pseudoinverse(
                    &sampling::HEMISPHERE
                        .iter()
                        .map(|&v| basis(order, v))
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        // scipy's default single-linkage clusters reduce to adjacent sorted gaps.
        let mut indices: Vec<_> = (0..bvals.len()).collect();
        indices.sort_by(|&a, &b| bvals[a].total_cmp(&bvals[b]));
        let mut groups: Vec<Vec<usize>> = vec![];
        for i in indices {
            if groups
                .last()
                .is_none_or(|group| bvals[i] - bvals[*group.last().unwrap()] > 50.0)
            {
                groups.push(vec![]);
            }
            groups.last_mut().unwrap().push(i);
        }
        let mut shells = vec![];
        for mut members in groups {
            if members.iter().all(|&i| bvals[i] <= 50.0) {
                continue;
            }
            if members.iter().any(|&i| bvals[i] <= 50.0) {
                return Err(Error("A shell cannot straddle the b0 threshold"));
            }
            members.sort_unstable();
            let mean = members.iter().map(|&i| bvals[i]).sum::<f64>() / members.len() as f64;
            let order = shell_order(mean);
            let rh = (0..10)
                .map(|i| rotational_basis(order, (PI * 0.5 * i as f64 / 9.0).cos()))
                .collect::<Vec<_>>();
            shells.push(Shell {
                bval: mean,
                order,
                design: members
                    .iter()
                    .map(|&i| basis(order, directions[i]))
                    .collect(),
                inverse_rh: pseudoinverse(&rh),
                members,
            });
        }
        let mut model = Self {
            bvals: bvals.to_vec(),
            b0,
            shells,
            inverse_watson,
            grid: vec![],
            signals: vec![],
        };
        // np.meshgrid's flattened traversal: paired orientation, ODI, ICVF, ISOVF.
        for v in sampling::START_DIRECTIONS {
            let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
            let theta = (v[2] / norm).acos();
            let phi = v[1].atan2(v[0]);
            for o in 0..5 {
                for intra in 0..5 {
                    for iso in 0..5 {
                        let parameters = [
                            theta,
                            phi,
                            0.02 + 0.97 * o as f64 / 4.0,
                            0.01 + 0.98 * intra as f64 / 4.0,
                            iso as f64 / 4.0,
                        ];
                        model.signals.push(model.predict_unchecked(parameters));
                        model.grid.push(parameters);
                    }
                }
            }
        }
        Ok(model)
    }

    fn predict_unchecked(&self, p: [f64; 5]) -> Vec<f64> {
        let [theta, phi, odi, intra, iso] = p;
        let mu = [
            theta.sin() * phi.cos(),
            theta.sin() * phi.sin(),
            theta.cos(),
        ];
        let kappa = 1.0 / (PI * 0.5 * odi).tan();
        let denominator = normalizer(kappa);
        let distribution = sampling::HEMISPHERE
            .iter()
            .map(|v| {
                let dot = (0..3).map(|j| v[j] * mu[j]).sum::<f64>();
                (kappa * dot * dot).exp() / denominator
            })
            .collect::<Vec<_>>();
        let order = watson_order(odi);
        let watson = project(&self.inverse_watson[order / 2], &distribution);
        let mut out = self
            .bvals
            .iter()
            .map(|b| iso * (-b * 0.003).exp() + (1.0 - iso))
            .collect::<Vec<_>>();
        for shell in &self.shells {
            let mut kernels = vec![0.0; 10];
            for (i, value) in kernels.iter_mut().enumerate() {
                let z2 = (PI * 0.5 * i as f64 / 9.0).cos().powi(2);
                let stick = (-shell.bval * 0.0017 * z2).exp();
                let perpendicular = 0.0017 * (1.0 - intra);
                let zeppelin =
                    (-shell.bval * (perpendicular + (0.0017 - perpendicular) * z2)).exp();
                *value = intra * stick + (1.0 - intra) * zeppelin;
            }
            let rh = project(&shell.inverse_rh, &kernels);
            let used_order = shell.order.min(order);
            let mut convolved = Vec::with_capacity(count(used_order));
            let mut index = 0;
            for l in (0..=used_order).step_by(2) {
                for _ in 0..2 * l + 1 {
                    convolved
                        .push(watson[index] * rh[l / 2] * (4.0 * PI / (2 * l + 1) as f64).sqrt());
                    index += 1;
                }
            }
            for (&frame, row) in shell.members.iter().zip(&shell.design) {
                let dispersed = row.iter().zip(&convolved).map(|(a, b)| a * b).sum::<f64>();
                out[frame] = iso * (-self.bvals[frame] * 0.003).exp() + (1.0 - iso) * dispersed;
            }
        }
        out
    }

    pub fn predict(&self, parameters: [f64; 5]) -> Result<Vec<f64>, Error> {
        if parameters.iter().any(|v| !v.is_finite())
            || !(0.02..=0.99).contains(&parameters[2])
            || parameters[3..].iter().any(|v| !(0.0..=1.0).contains(v))
        {
            return Err(Error(
                "Parameters must be finite with bounded ODI and fractions",
            ));
        }
        Ok(self.predict_unchecked(parameters))
    }

    pub fn starting_grid(&self) -> &[[f64; 5]] {
        &self.grid
    }

    pub fn starting_parameters(&self, normalized: &[f64]) -> Result<[f64; 5], Error> {
        self.check_signal(normalized)?;
        let closest = self
            .signals
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| mse(a, normalized).total_cmp(&mse(b, normalized)))
            .unwrap()
            .0;
        Ok(self.grid[closest])
    }

    fn check_signal(&self, data: &[f64]) -> Result<(), Error> {
        if data.len() != self.bvals.len() || data.iter().any(|v| !v.is_finite()) {
            return Err(Error(
                "Signal must contain one finite value per measurement",
            ));
        }
        Ok(())
    }

    pub fn fit(&self, data: &[f64]) -> Result<Fit, Error> {
        self.check_signal(data)?;
        if data[0] <= 0.0 {
            return Err(Error(
                "dmipy skips voxels with a nonpositive first measurement",
            ));
        }
        let s0 = self.b0.iter().map(|&i| data[i]).sum::<f64>() / self.b0.len() as f64;
        if !s0.is_finite() || s0 <= 0.0 {
            return Err(Error("Mean b0 signal must be finite and positive"));
        }
        let normalized = data.iter().map(|v| v / s0).collect::<Vec<_>>();
        let start = self.starting_parameters(&normalized)?;
        let lower = [0.0, -PI, 0.02, 0.01, 0.01];
        let upper = [PI, PI, 0.99, 0.99, 0.99];
        let result = dwi_gp::lbfgsb::minimize(
            |x, gradient| {
                let f = mse(&self.predict_unchecked(x.try_into().unwrap()), &normalized);
                // scipy's default absolute two-point finite difference step is 1e-8,
                // adjusted to the nearest feasible forward or backward point.
                for i in 0..5 {
                    let mut moved = x.to_vec();
                    let mut step = 1e-8;
                    if x[i] + step > upper[i] {
                        step = -step;
                    }
                    moved[i] += step;
                    let actual = moved[i] - x[i];
                    gradient[i] = (mse(
                        &self.predict_unchecked(moved.as_slice().try_into().unwrap()),
                        &normalized,
                    ) - f)
                        / actual;
                }
                f
            },
            &start,
            &lower,
            &upper,
            &dwi_gp::lbfgsb::Options::default(),
        )
        .map_err(|_| Error("L-BFGS-B rejected the optimization inputs"))?;
        if !result.fun.is_finite() || result.x.iter().any(|v| !v.is_finite()) {
            return Err(Error("Nonlinear fit returned nonfinite parameters"));
        }
        let converged = result.success();
        Ok(Fit {
            parameters: result.x.try_into().unwrap(),
            start,
            mse: result.fun,
            converged,
            iterations: result.nit,
        })
    }
}

fn mse(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (x - y).powi(2)).sum::<f64>() / a.len() as f64
}

#[derive(Clone, Debug)]
pub struct Fit {
    pub parameters: [f64; 5],
    pub start: [f64; 5],
    pub mse: f64,
    pub converged: bool,
    pub iterations: usize,
}
