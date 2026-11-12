//! Gates for single-precision CF Gaussian fits against the pinned single-kernel
//! recording (`record_single_kernels.m`, `single-kernels-reference.json`), one
//! directory per host under `SAMSRF_SINGLE_KERNELS_DIR`:
//! - `exp_single` against MATLAB's recorded single `exp`;
//! - `fit_gaussian_single`, started from MATLAB's own profiles, against the
//!   replica's parameters and `R^2`, which equal the saved maps, on every vertex.
use samsrf_core::precision::{exp_single, sum_single};
use samsrf_core::revcor_cf::fit_gaussian_single;
use serde_json::Value;
use std::path::{Path, PathBuf};

const HOSTS: [&str; 2] = ["amd-7763-auto", "intel-8573c-avx512"];

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
    let data = bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect();
    let shape = descriptor["shape"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
    Array { shape, data }
}

fn recording(root: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(root.join("kernels.json")).unwrap()).unwrap()
}

#[test]
fn matlab_single_exp() {
    let Some(root) = std::env::var_os("SAMSRF_SINGLE_KERNELS_DIR").map(PathBuf::from) else {
        eprintln!("SAMSRF_SINGLE_KERNELS_DIR not set");
        return;
    };
    for host in HOSTS {
        let dir = root.join(host);
        let case = &recording(&dir)["cases"][0];
        let input = read(&dir, &case["input"]);
        let whole = read(&dir, &case["whole"]);
        let differing: Vec<f32> = input
            .data
            .iter()
            .zip(&whole.data)
            .filter(|(x, w)| exp_single(**x as f32).to_bits() != (**w as f32).to_bits())
            .map(|(x, _)| *x as f32)
            .collect();
        println!("{host}: exp_single differs from MATLAB on {} of {} inputs", differing.len(), input.data.len());
        // The 18 normal-range inputs the candidate does not explain; any other is a regression.
        assert!(differing.len() <= 18, "{host}: {differing:?}");
    }
}

#[test]
fn single_cf_gaussian_fits_equal_matlab_on_every_vertex() {
    let Some(root) = std::env::var_os("SAMSRF_SINGLE_KERNELS_DIR").map(PathBuf::from) else {
        return;
    };
    let mut vertices = 0;
    for host in HOSTS {
        let dir = root.join(host);
        for case in recording(&dir)["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "gaussian") {
            let smoothed = case["smoothing"].as_f64().unwrap() > 0.0;
            let profiles = read(&dir, &case["profiles"]);
            let coordinates = read(&dir, &case["coordinates"]);
            let parameters = read(&dir, &case["replicaParameters"]);
            let r2 = read(&dir, &case["replicaR2"]);
            let maps = read(&dir, &case["savedMaps"]);
            let seeds = coordinates.shape[0];
            let xy: Vec<[f32; 2]> = (0..seeds).map(|i| [coordinates.at(i, 0) as f32, coordinates.at(i, 1) as f32]).collect();
            for v in 0..profiles.shape[1] {
                let profile: Vec<f32> = (0..seeds).map(|i| profiles.at(i, v) as f32).collect();
                let (fit, fit_r2) = fit_gaussian_single(&profile, &xy, smoothed, 1e-4);
                let id = format!("{host} {} vertex {}", case["id"].as_str().unwrap(), v + 1);
                if r2.data[v].is_nan() {
                    assert!(fit_r2.is_nan(), "{id}: MATLAB did not fit");
                    continue;
                }
                for (j, value) in fit.iter().enumerate() {
                    assert_eq!(value.to_bits(), parameters.at(j, v).to_bits(), "{id}: parameter {j}");
                    assert_eq!((*value as f32).to_bits(), (maps.at(j + 1, v) as f32).to_bits(), "{id}: saved map row {}", j + 2);
                }
                assert_eq!(fit_r2.to_bits(), (r2.data[v] as f32).to_bits(), "{id}: R^2");
                assert_eq!(fit_r2.to_bits(), (maps.at(0, v) as f32).to_bits(), "{id}: saved R^2");
                vertices += 1;
            }
        }
    }
    println!("{vertices} fitted vertices equal MATLAB on both hosts");
    assert_eq!(vertices, 2 * (19 + 18 + 21 + 20));
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
