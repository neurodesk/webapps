//! Replays the single-precision CF Gaussian fits of the single-kernel recording
//! (`record_single_kernels.m`) from MATLAB's own profiles and compares every
//! logged `fminsearch` evaluation. `SAMSRF_SINGLE_KERNELS_DIR` holds the pinned
//! recording (one directory per host).
use samsrf_core::optim::{fminsearch, FminsearchOptions};
use serde_json::Value;
use std::path::{Path, PathBuf};

const LN2_HI: f32 = f32::from_bits(0x3f31_7000);
const INV_LN2: f32 = f32::from_bits(0x3fb8_aa3b);
const P: [f32; 5] = [1.666_666_7e-1, -2.777_777_8e-3, 6.613_756e-5, -1.653_390_2e-6, 4.138_137e-8];

fn ln2_lo() -> f32 {
    (std::f64::consts::LN_2 - f64::from(LN2_HI)) as f32
}

/// The fdlibm-structure candidate for MATLAB's single `exp` (see analyse-single-kernels.mjs).
fn expf(x: f32) -> f32 {
    if x.is_nan() {
        return x;
    }
    if x > 88.722_83 {
        return f32::INFINITY;
    }
    if x < (-149.0 * std::f64::consts::LN_2) as f32 {
        return 0.0;
    }
    let magnitude = x.to_bits() & 0x7fff_ffff;
    let negative = x < 0.0;
    let (mut k, mut hi, mut lo, mut r) = (0i32, x, 0.0f32, x);
    if magnitude > 0x3eb1_7218 {
        if magnitude < 0x3f85_1592 {
            k = if negative { -1 } else { 1 };
            hi = x - k as f32 * LN2_HI;
            lo = k as f32 * ln2_lo();
        } else {
            k = (INV_LN2 * x + if negative { -0.5 } else { 0.5 }) as i32;
            hi = x - k as f32 * LN2_HI;
            lo = k as f32 * ln2_lo();
        }
        r = hi - lo;
    } else if magnitude < 0x3180_0000 {
        return 1.0 + x;
    }
    let t = r * r;
    let mut p = P[4];
    for &q in P[..4].iter().rev() {
        p = q + t * p;
    }
    let c = r - t * p;
    let rc = r * c;
    let y = if k == 0 { 1.0 - (rc / (c - 2.0) - r) } else { 1.0 - ((lo - rc / (2.0 - c)) - hi) };
    if k == 0 {
        y
    } else if k >= -125 {
        (f64::from(y) * 2f64.powi(k)) as f32
    } else {
        (f64::from(y) * 2f64.powi(k + 100) * 2f64.powi(-100)) as f32
    }
}

/// MATLAB's `sum` of single values (four lanes from 44 elements).
fn sum_single(values: &[f32]) -> f32 {
    if values.len() < 44 {
        return values.iter().fold(0.0, |sum, &value| sum + value);
    }
    let mut lanes = [0.0f32; 4];
    for (index, &value) in values.iter().enumerate() {
        lanes[index % 4] += value;
    }
    lanes.iter().fold(0.0, |sum, &value| sum + value)
}

/// single op double: computed in double, rounded to single.
fn mixed(value: f64) -> f32 {
    value as f32
}

struct Array {
    shape: Vec<usize>,
    data: Vec<f64>,
}

impl Array {
    fn at(&self, row: usize, column: usize) -> f64 {
        self.data[column * self.shape[0] + row]
    }
}

fn read(root: &Path, descriptor: &Value) -> Array {
    let bytes = std::fs::read(root.join(descriptor["file"].as_str().unwrap())).unwrap();
    let data = bytes.chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect();
    let shape = descriptor["shape"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
    Array { shape, data }
}

/// samsrf_fit2dprf's errfun with SamSrf's classes: single coordinates and
/// profile, double parameters.
fn objective(observed: &[f32], x: &[f32], y: &[f32], p: &[f64], smoothed: bool) -> f32 {
    let denominator = 2.0 * p[2] * p[2];
    let model: Vec<f32> = x
        .iter()
        .zip(y)
        .map(|(&xi, &yi)| {
            let dx = mixed(f64::from(xi) - p[0]);
            let dy = mixed(f64::from(yi) - p[1]);
            let exponent = -mixed(f64::from(dx * dx + dy * dy) / denominator);
            let rf = expf(exponent);
            mixed(f64::from(mixed(f64::from(rf) * p[3])) + p[4])
        })
        .collect();
    let squares: Vec<f32> = if smoothed {
        observed.iter().zip(&model).map(|(o, m)| (o - m) * (o - m)).collect()
    } else {
        // A row minus a column: Ds(i, j) = observed(j) - model(i), column-major.
        observed.iter().flat_map(|o| model.iter().map(move |m| (o - m) * (o - m))).collect()
    };
    sum_single(&squares)
}

struct Outcome {
    vertices: usize,
    exact: usize,
    first_divergence: Vec<(usize, usize)>,
    evaluations: usize,
    objectives_differing: usize,
}

fn replay(root: &Path, case: &Value) -> Outcome {
    let smoothed = case["smoothing"].as_f64().unwrap() > 0.0;
    let profiles = read(root, &case["profiles"]);
    let coordinates = read(root, &case["coordinates"]);
    let evaluations = read(root, &case["evaluations"]);
    let vertex = read(root, &case["evaluationVertex"]);
    let parameters = read(root, &case["replicaParameters"]);
    let r2 = read(root, &case["replicaR2"]);
    let seeds = coordinates.shape[0];
    let x: Vec<f32> = (0..seeds).map(|i| coordinates.at(i, 0) as f32).collect();
    let y: Vec<f32> = (0..seeds).map(|i| coordinates.at(i, 1) as f32).collect();
    let objectives = read(root, &case["objectives"]);
    let mut outcome = Outcome { vertices: 0, exact: 0, first_divergence: Vec::new(), evaluations: 0, objectives_differing: 0 };
    for v in 0..profiles.shape[1] {
        let logged: Vec<usize> = (0..evaluations.shape[0]).filter(|&row| vertex.data[row] as usize == v + 1).collect();
        if logged.is_empty() {
            continue;
        }
        outcome.vertices += 1;
        let mut r: Vec<f32> = (0..seeds).map(|i| profiles.at(i, v) as f32).collect();
        let peak = r.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let m = r.iter().position(|&value| value == peak).unwrap();
        let half = mixed(f64::from(peak) / 2.0);
        for value in &mut r {
            *value -= half;
            if *value < 0.0 {
                *value = 0.0;
            }
        }
        let mut trace: Vec<[f64; 5]> = Vec::new();
        let mut values: Vec<f32> = Vec::new();
        let mut best: Option<([f64; 5], f32)> = None;
        for exponent in -2..=2 {
            // [single single double] concatenates to single, so Sigma's seed is single.
            let seed = [x[m] as f64, y[m] as f64, f64::from(10f64.powi(exponent) as f32), 1.0, 0.0];
            let result = fminsearch(
                |p: &[f64]| {
                    trace.push(p.try_into().unwrap());
                    let value = objective(&r, &x, &y, p, smoothed);
                    values.push(value);
                    f64::from(value)
                },
                &seed,
                &FminsearchOptions::default(),
            );
            let mean = sum_single(&r) / r.len() as f32;
            let squares: Vec<f32> = r.iter().map(|value| (value - mean) * (value - mean)).collect();
            let fit = 1.0 - mixed(result.fval / f64::from(sum_single(&squares)));
            if best.as_ref().map_or(!fit.is_nan(), |(_, b)| fit > *b) {
                best = Some((result.x.clone().try_into().unwrap(), fit));
            }
        }
        let first = logged.iter().zip(&trace).position(|(&row, p)| (0..5).any(|j| evaluations.at(row, j).to_bits() != p[j].to_bits()));
        outcome.evaluations += logged.len();
        outcome.objectives_differing += logged.iter().zip(&values).filter(|(&row, value)| (objectives.data[row] as f32).to_bits() != value.to_bits()).count();
        let (params, fit) = best.unwrap();
        let maps_equal = (0..5).all(|j| params[j].to_bits() == parameters.at(j, v).to_bits()) && fit.to_bits() == (r2.data[v] as f32).to_bits();
        if first.is_none() && trace.len() == logged.len() && maps_equal {
            outcome.exact += 1;
        } else {
            outcome.first_divergence.push((v + 1, first.map_or(trace.len().min(logged.len()) + 1, |e| e + 1)));
        }
    }
    outcome
}

#[test]
fn single_cf_gaussian_replay() {
    let Some(root) = std::env::var_os("SAMSRF_SINGLE_KERNELS_DIR").map(PathBuf::from) else {
        eprintln!("SAMSRF_SINGLE_KERNELS_DIR not set");
        return;
    };
    for host in ["amd-7763-auto", "intel-8573c-avx512"] {
        let dir = root.join(host);
        let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("kernels.json")).unwrap()).unwrap();
        for case in recording["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "gaussian") {
            let outcome = replay(&dir, case);
            println!(
                "{host} {}: {}/{} vertices replay exactly; {} of {} objectives differ; diverging (vertex, evaluation): {:?}",
                case["id"].as_str().unwrap(),
                outcome.exact,
                outcome.vertices,
                outcome.objectives_differing,
                outcome.evaluations,
                outcome.first_divergence
            );
        }
    }
}

/// The port's single `corr` against MATLAB's, and each recorded piece.
#[test]
fn single_corr_pieces() {
    let Some(root) = std::env::var_os("SAMSRF_SINGLE_KERNELS_DIR").map(PathBuf::from) else {
        return;
    };
    for host in ["amd-7763-auto", "intel-8573c-avx512"] {
        let dir = root.join(host);
        let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("kernels.json")).unwrap()).unwrap();
        for case in recording["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "corr") {
            let courses = read(&dir, &case["courses"]);
            let seeds = read(&dir, &case["seedCourses"]);
            let corr = read(&dir, &case["corr"]);
            let mean_seed = read(&dir, &case["meanSeed"]);
            let norm_seed = read(&dir, &case["normSeed"]);
            let mean_course = read(&dir, &case["meanCourse"]);
            let norm_course = read(&dir, &case["normCourse"]);
            let product = read(&dir, &case["product"]);
            let n = courses.shape[0];
            let column = |a: &Array, j: usize| -> Vec<f32> { (0..n).map(|i| a.at(i, j) as f32).collect() };
            let mean = |v: &[f32]| sum_single(v) / v.len() as f32;
            let norm = |v: &[f32]| v.iter().map(|&x| f64::from(x).powi(2)).sum::<f64>().sqrt() as f32;
            let centred = |v: &[f32]| { let m = mean(v); v.iter().map(|x| x - m).collect::<Vec<f32>>() };
            let (mut port, mut means_s, mut norms_s, mut means_c, mut norms_c, mut quotient) = (0, 0, 0, 0, 0, 0);
            let rois = courses.shape[1];
            let nseed = seeds.shape[1];
            for j in 0..nseed {
                let x = column(&seeds, j);
                means_s += usize::from(mean(&x).to_bits() == (mean_seed.data[j] as f32).to_bits());
                norms_s += usize::from(norm(&centred(&x)).to_bits() == (norm_seed.data[j] as f32).to_bits());
            }
            for v in 0..rois {
                let y = column(&courses, v);
                means_c += usize::from(mean(&y).to_bits() == (mean_course.data[v] as f32).to_bits());
                norms_c += usize::from(norm(&centred(&y)).to_bits() == (norm_course.data[v] as f32).to_bits());
                for j in 0..nseed {
                    let x: Vec<f64> = column(&seeds, j).iter().map(|&value| f64::from(value)).collect();
                    let yd: Vec<f64> = y.iter().map(|&value| f64::from(value)).collect();
                    let value = samsrf_core::precision::correlation_single_pair(&yd, &x);
                    port += usize::from(value.to_bits() == (corr.at(v, j) as f32).to_bits());
                    // MATLAB's own pieces, divided as its corr does: (product / normY) / normX.
                    let rebuilt = (product.at(v, j) as f32 / norm_course.data[v] as f32) / norm_seed.data[j] as f32;
                    quotient += usize::from(rebuilt.to_bits() == (corr.at(v, j) as f32).to_bits());
                }
            }
            println!(
                "{host} {}: corr {port}/{} | (product/normY)/normX from MATLAB's pieces {quotient} | seed means {means_s}/{nseed} norms {norms_s} | course means {means_c}/{rois} norms {norms_c}",
                case["id"].as_str().unwrap(),
                rois * nseed
            );
        }
    }
}
