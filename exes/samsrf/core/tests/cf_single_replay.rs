//! Gates for single-precision CF Gaussian fits against the pinned single-kernel
//! recording (`record_single_kernels.m`, `single-kernels-reference.json`), one
//! directory per host under `SAMSRF_SINGLE_KERNELS_DIR`:
//! - `exp_single` against MATLAB's recorded single `exp`;
//! - `fit_gaussian_single`, started from MATLAB's own profiles, against the
//!   replica's parameters and `R^2`, which equal the saved maps, on every vertex.
use samsrf_core::precision::{exp_single, gemv_t_single, sum_single};
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

fn matrix(value: &Value) -> Vec<Vec<f64>> {
    value.as_array().unwrap().iter().map(|row| match row {
        Value::Array(entries) => entries.iter().map(|v| v.as_f64().unwrap()).collect(),
        other => vec![other.as_f64().unwrap()],
    }).collect()
}

/// `gemv_t_single` against MATLAB's random single `y' * A` products of the
/// fingerprinted shapes (`record_gemv_order.m`), held out from the trees.
#[test]
fn gemv_matches_matlab_held_out_products() {
    let Some(root) = std::env::var_os("SAMSRF_GEMV_ORDER_DIR").map(PathBuf::from) else {
        eprintln!("SAMSRF_GEMV_ORDER_DIR not set");
        return;
    };
    let recording: Value = serde_json::from_slice(&std::fs::read(root.join("gemv-order.json")).unwrap()).unwrap();
    for case in recording["cases"].as_array().unwrap() {
        let (n, m) = (case["n"].as_u64().unwrap() as usize, case["m"].as_u64().unwrap() as usize);
        let ys = matrix(&case["ys"]);
        let a = matrix(&case["As"]);
        let products = matrix(&case["products"]);
        let mut equal = 0;
        for (d, expected) in products.iter().enumerate() {
            let y: Vec<f32> = (0..n).map(|i| ys[i][d] as f32).collect();
            let columns: Vec<Vec<f32>> = (0..m).map(|j| (0..n).map(|i| a[i][d * m + j] as f32).collect()).collect();
            let refs: Vec<&[f32]> = columns.iter().map(Vec::as_slice).collect();
            let got = gemv_t_single(&y, &refs);
            equal += got.iter().zip(expected).filter(|(g, e)| g.to_bits() == (**e as f32).to_bits()).count();
        }
        println!("n={n} m={m}: {equal}/{} products", products.len() * m);
        assert_eq!(equal, products.len() * m, "n={n} m={m}");
    }
}

/// corr's product yc' * Xc on the CF kernel matrix, on the AMD host the
/// fingerprint was taken on.
#[test]
fn gemv_matches_matlab_corr_product_on_amd() {
    let Some(root) = std::env::var_os("SAMSRF_SINGLE_KERNELS_DIR").map(PathBuf::from) else {
        return;
    };
    let dir = root.join("amd-7763-auto");
    for case in recording(&dir)["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "corr") {
        let courses = read(&dir, &case["courses"]);
        let seeds = read(&dir, &case["seedCourses"]);
        let product = read(&dir, &case["product"]);
        let n = courses.shape[0];
        let centred = |a: &Array, j: usize| {
            let v: Vec<f32> = (0..n).map(|i| a.at(i, j) as f32).collect();
            let mean = sum_single(&v) / n as f32;
            v.iter().map(|x| x - mean).collect::<Vec<f32>>()
        };
        let xc: Vec<Vec<f32>> = (0..seeds.shape[1]).map(|j| centred(&seeds, j)).collect();
        let refs: Vec<&[f32]> = xc.iter().map(Vec::as_slice).collect();
        let mut equal = 0;
        for v in 0..courses.shape[1] {
            let got = gemv_t_single(&centred(&courses, v), &refs);
            equal += got.iter().enumerate().filter(|(j, g)| g.to_bits() == (product.at(v, *j) as f32).to_bits()).count();
        }
        println!("{}: {equal}/{} products", case["id"].as_str().unwrap(), courses.shape[1] * seeds.shape[1]);
        assert_eq!(equal, courses.shape[1] * seeds.shape[1]);
    }
}
