// SPDX-License-Identifier: Apache-2.0
//! Synthetic ground truth: phantoms distorted by known eddy-current fields. The phantoms and
//! the fields are continuous functions, so the distortion is computed exactly and only the
//! fit's own interpolation is approximate.

use dwi_ec_distortion::{Field, Geometry, Model, SecondLevel, fit, relax, second_level};
use dwi_shore::TargetFit;
use std::f64::consts::PI;

const DIMS: [usize; 3] = [24, 28, 16];
const READOUT: f64 = 0.05;

fn geometry() -> Geometry {
    Geometry::new(DIMS, [2.0; 3], 1, 1.0, READOUT).unwrap()
}

/// A deterministic Gaussian generator (SplitMix64 and Box-Muller).
struct Rng(u64);

impl Rng {
    fn uniform(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }

    fn gaussian(&mut self) -> f64 {
        let u = self.uniform().max(1e-300);
        (-2.0 * u.ln()).sqrt() * (2.0 * PI * self.uniform()).cos()
    }
}

fn voxel(v: usize) -> [f64; 3] {
    [
        (v % DIMS[0]) as f64,
        ((v / DIMS[0]) % DIMS[1]) as f64,
        (v / (DIMS[0] * DIMS[1])) as f64,
    ]
}

/// The phantom's frame: continuous voxel coordinates scaled to -1..1 over the image.
fn position(t: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|a| (t[a] + 0.5) / DIMS[a] as f64 * 2.0 - 1.0)
}

fn brain_mask() -> Vec<bool> {
    (0..DIMS.iter().product())
        .map(|v| {
            let p = position(voxel(v));
            p[0] * p[0] / 0.8 + p[1] * p[1] / 0.8 + p[2] * p[2] / 0.9 < 1.0
        })
        .collect()
}

/// A brain-like intensity with a soft edge and structure along every axis.
fn anatomy(p: [f64; 3]) -> f64 {
    let r2 = p[0] * p[0] / 0.8 + p[1] * p[1] / 0.8 + p[2] * p[2] / 0.9;
    let edge = 1.0 / (1.0 + ((r2 - 1.0) * 12.0).exp());
    edge * (600.0
        + 200.0 * (3.0 * p[0]).sin() * (2.5 * p[1]).cos()
        + 120.0 * (3.5 * p[2] + 2.0 * p[1]).sin())
}

fn sampled(image: impl Fn([f64; 3]) -> f64) -> Vec<f64> {
    (0..DIMS.iter().product())
        .map(|v| image(position(voxel(v))))
        .collect()
}

/// The field (Hz) at continuous voxel coordinates, from the model's definition: coordinates
/// scaled to -1..1 between the first and last voxel centre of each axis.
fn hz_at(field: &Field, t: [f64; 3]) -> f64 {
    let [x, y, z]: [f64; 3] = std::array::from_fn(|a| {
        let h = (DIMS[a] as f64 - 1.0) / 2.0;
        (t[a] - h) / h
    });
    let terms = [1.0, x, y, z, x * x, y * y, z * z, x * y, x * z, y * z];
    field
        .coefficients
        .iter()
        .zip(terms)
        .map(|(c, t)| c * t)
        .sum()
}

/// Distorts the continuous `image` with `field`: the signal at s appears at s + d(s) along
/// the PE axis (axis 1), scaled by 1/J. Each output voxel's source s comes from Newton's
/// method on s + d(s) = y.
fn distort(image: impl Fn([f64; 3]) -> f64, field: &Field) -> Vec<f32> {
    let d = |t: [f64; 3]| READOUT * hz_at(field, t);
    (0..DIMS.iter().product())
        .map(|v| {
            let y = voxel(v);
            let mut t = y;
            let mut slope = 0.0;
            for _ in 0..30 {
                let (up, down) = ([t[0], t[1] + 1e-4, t[2]], [t[0], t[1] - 1e-4, t[2]]);
                slope = (d(up) - d(down)) / 2e-4;
                t[1] -= (t[1] + d(t) - y[1]) / (1.0 + slope);
            }
            (image(position(t)) / (1.0 + slope)) as f32
        })
        .collect()
}

/// RMS difference of two displacement fields over the mask, in voxels.
fn displacement_error(a: &Field, b: &Field, mask: &[bool]) -> f64 {
    let g = geometry();
    let (da, db) = (a.displacement(&g), b.displacement(&g));
    let squares: Vec<f64> = da
        .iter()
        .zip(&db)
        .zip(mask)
        .filter(|(_, m)| **m)
        .map(|((x, y), _)| (x - y).powi(2))
        .collect();
    (squares.iter().sum::<f64>() / squares.len() as f64).sqrt()
}

fn max_displacement(field: &Field, mask: &[bool]) -> f64 {
    let d = field.displacement(&geometry());
    d.iter()
        .zip(mask)
        .filter(|(_, m)| **m)
        .fold(0.0f64, |m, (x, _)| m.max(x.abs()))
}

fn true_field() -> Field {
    Field {
        model: Model::Quadratic,
        coefficients: vec![15.0, 25.0, -20.0, 12.0, 10.0, -15.0, 8.0, 12.0, -10.0, 8.0],
    }
}

#[test]
fn recovers_a_known_quadratic_field() {
    let g = geometry();
    let mask = brain_mask();
    let truth = sampled(anatomy);
    let field = true_field();
    let observed = distort(anatomy, &field);
    eprintln!(
        "largest displacement {:.2} voxels",
        max_displacement(&field, &mask)
    );

    let result = fit(&g, &observed, &truth, &mask, &Field::zero(Model::Quadratic)).unwrap();
    let error = displacement_error(&result.field, &field, &mask);
    eprintln!(
        "noiseless: displacement RMS error {error:.4} voxels, cost {:.1} -> {:.3}, {} iterations",
        result.initial_cost, result.cost, result.iterations
    );
    assert!(error < 0.02, "{error}");

    let mut rng = Rng(481);
    let noisy: Vec<f32> = observed
        .iter()
        .map(|&x| x + (12.0 * rng.gaussian()) as f32)
        .collect();
    let result = fit(&g, &noisy, &truth, &mask, &Field::zero(Model::Quadratic)).unwrap();
    let error = displacement_error(&result.field, &field, &mask);
    eprintln!("noise σ = 12: displacement RMS error {error:.4} voxels");
    assert!(error < 0.05, "{error}");
}

#[test]
fn a_linear_model_leaves_the_quadratic_part() {
    let g = geometry();
    let mask = brain_mask();
    let truth = sampled(anatomy);
    let field = true_field();
    let observed = distort(anatomy, &field);
    let quadratic = fit(&g, &observed, &truth, &mask, &Field::zero(Model::Quadratic)).unwrap();
    let linear = fit(&g, &observed, &truth, &mask, &Field::zero(Model::Linear)).unwrap();
    let linear_error = displacement_error(&linear.field, &field, &mask);
    eprintln!(
        "cost: linear {:.2}, quadratic {:.3}; linear displacement RMS error {linear_error:.3} voxels",
        linear.cost, quadratic.cost
    );
    assert!(linear.cost > 20.0 * quadratic.cost);
    assert!(linear_error > 0.2);
}

/// A golden-spiral set over the whole sphere: the second-level model needs it.
fn directions(n: usize, offset: f64) -> Vec<[f64; 3]> {
    (0..n)
        .map(|i| {
            let z = 1.0 - 2.0 * (i as f64 + 0.5) / n as f64;
            let r = (1.0 - z * z).sqrt();
            let phi = i as f64 * PI * (3.0 - 5f64.sqrt()) + offset;
            [r * phi.cos(), r * phi.sin(), z]
        })
        .collect()
}

/// The field of a volume with gradient `g` and b-value `b`: eddy currents scale with the
/// gradient amplitude (√b at fixed timing) and are odd in the gradient direction.
/// `extra` adds a part that is even in the direction, which the second-level model cannot
/// represent (as a fraction of the main pattern's size).
fn gradient_field(b: f64, g: [f64; 3], extra: f64) -> Field {
    let a = 2.5 * (b / 1000.0).sqrt();
    let [x, y, z] = g;
    let e = extra * 9.0;
    let pattern = [
        3.0 * x + e * x * y,
        9.0 * x + e * (y * z),
        7.0 * y - e * (x * z),
        6.0 * z + e * (x * x - y * y),
        3.0 * y,
        -3.0 * z,
        2.0 * x,
        3.0 * z,
        -2.0 * y,
        2.0 * x,
    ];
    Field {
        model: Model::Quadratic,
        coefficients: pattern.iter().map(|c| a * c).collect(),
    }
}

/// Two fibre populations whose angle varies smoothly, on the anatomy's intensity.
fn diffusion_signal(p: [f64; 3], b: f64, dir: [f64; 3]) -> f64 {
    let (a, c) = (0.6 * p[0] + 0.4 * p[2], 1.2 + 0.5 * p[1]);
    let f2 = [c.cos() * 0.3, c.sin(), 0.9];
    let norm = (f2[0] * f2[0] + f2[1] * f2[1] + f2[2] * f2[2]).sqrt();
    let fibres = [[a.cos(), a.sin(), 0.0], f2.map(|x| x / norm)];
    let mut s = 0.2 * (-b * 2.5e-3).exp();
    for f in fibres {
        let cos = f.iter().zip(&dir).map(|(x, y)| x * y).sum::<f64>();
        s += 0.4 * (-b * (0.3e-3 + 1.5e-3 * cos * cos)).exp();
    }
    anatomy(p).max(1.0) * s
}

/// The SHORELine loop on a phantom whose fields have an even part of relative size `extra`,
/// which only the quadratic second-level model represents; returns the mean displacement
/// RMS error before correction and after each iteration.
fn shoreline_loop(extra: f64, slm: SecondLevel) -> (f64, Vec<f64>) {
    let g = geometry();
    let mask = brain_mask();
    let mut bvals = vec![1000.0; 30];
    bvals.extend(vec![2000.0; 40]);
    let mut bvecs = directions(30, 0.0);
    bvecs.extend(directions(40, 1.0));
    let mut rng = Rng(482);
    let b0: Vec<f32> = sampled(|p| anatomy(p).max(1.0))
        .into_iter()
        .map(|s| (s + 2.0 * rng.gaussian()) as f32)
        .collect();
    let fields: Vec<Field> = bvals
        .iter()
        .zip(&bvecs)
        .map(|(&b, &dir)| gradient_field(b, dir, extra))
        .collect();
    let observed: Vec<Vec<f32>> = (0..bvals.len())
        .map(|i| {
            distort(|p| diffusion_signal(p, bvals[i], bvecs[i]), &fields[i])
                .into_iter()
                .map(|x| x + (4.0 * rng.gaussian()) as f32)
                .collect()
        })
        .collect();
    let largest = fields
        .iter()
        .map(|f| max_displacement(f, &mask))
        .fold(0.0, f64::max);
    eprintln!("largest displacement {largest:.2} voxels");

    let mean_error = |estimates: &[Field]| -> f64 {
        estimates
            .iter()
            .zip(&fields)
            .map(|(e, t)| displacement_error(e, t, &mask))
            .sum::<f64>()
            / fields.len() as f64
    };
    let mut estimates: Vec<Field> = (0..bvals.len())
        .map(|_| Field::zero(Model::Quadratic))
        .collect();
    let initial = mean_error(&estimates);
    eprintln!("no correction: mean displacement RMS error {initial:.3} voxels");
    let mut corrected: Vec<Vec<f32>> = observed.clone();
    let mut errors = Vec::new();
    for iteration in 1..=3 {
        let refs: Vec<&[f32]> = corrected.iter().map(|v| v.as_slice()).collect();
        let predictions: Vec<Vec<f64>> = (0..bvals.len())
            .map(|t| {
                TargetFit::new(&bvals, &bvecs, t)
                    .unwrap()
                    .predict(&b0, &refs, &mask)
            })
            .collect();
        let single: Vec<Field> = (0..bvals.len())
            .map(|i| {
                fit(&g, &observed[i], &predictions[i], &mask, &estimates[i])
                    .unwrap()
                    .field
            })
            .collect();
        estimates = relax(
            &estimates,
            &second_level(&single, &bvals, &bvecs, slm).unwrap(),
            0.65,
        );
        corrected = estimates
            .iter()
            .zip(&observed)
            .map(|(f, o)| f.correct(&g, o).into_iter().map(|x| x as f32).collect())
            .collect();
        let error = mean_error(&estimates);
        eprintln!("iteration {iteration}: mean displacement RMS error {error:.3} voxels");
        errors.push(error);
    }
    (initial, errors)
}

#[test]
fn shoreline_loop_with_3dshore_predictions() {
    let (initial, errors) = shoreline_loop(0.0, SecondLevel::Linear);
    assert!(errors[2] < 0.05, "{errors:?}");
    assert!(errors[2] < 0.1 * initial, "{errors:?}");
}

/// `--slm quadratic` adds terms that are even in the gradient direction. The 3dSHORE basis is
/// antipodally symmetric, so the prediction for direction g treats g and -g as one signal:
/// an even field part is the same at g, at -g and at their neighbours, the prediction
/// carries it, and the fit cannot see it. The quadratic model still corrects most of the
/// distortion, but with these predictions it is less accurate than the linear one and does
/// not recover even parts.
#[test]
fn quadratic_second_level_in_the_loop() {
    for extra in [0.0, 0.15] {
        let (initial, linear) = shoreline_loop(extra, SecondLevel::Linear);
        let (_, quadratic) = shoreline_loop(extra, SecondLevel::Quadratic);
        eprintln!("even part {extra}: --slm linear {linear:.3?}, --slm quadratic {quadratic:.3?}");
        assert!(quadratic[2] < 0.25 * initial, "{initial} {quadratic:?}");
        assert!(linear[2] < 0.25 * initial, "{initial} {linear:?}");
    }
}
