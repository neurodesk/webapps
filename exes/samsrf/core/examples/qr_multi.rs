//! Solve the multi-RHS designs of a record_qr_kernels.m recording with
//! lstsq::mldivide_many and write the coefficients, for comparison with
//! MATLAB's A \ B (qr-multi.py).
//!
//! cargo run --release -p samsrf-core --example qr_multi -- QR_RECORDING KERNELS_DIR OUTPUT_JSON
use num_complex::Complex64;
use samsrf_core::{lstsq, precision::Precision};
use serde_json::{json, Value};
use std::path::Path;

fn read(root: &Path, descriptor: &Value) -> Vec<Complex64> {
    let file = |name: &str| -> Vec<f64> {
        assert_eq!(Path::new(name).file_name().unwrap(), name);
        std::fs::read(root.join(name)).unwrap().as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
    };
    let re = file(descriptor["file"].as_str().unwrap());
    let im = match descriptor["imaginary"].as_str().filter(|s| !s.is_empty()) {
        Some(name) => file(name),
        None => vec![0.0; re.len()],
    };
    re.into_iter().zip(im).map(|(re, im)| Complex64::new(re, im)).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 3, "usage: qr_multi QR_RECORDING KERNELS_DIR OUTPUT_JSON");
    let (designs, kernels) = (Path::new(&args[0]), Path::new(&args[1]));
    let pinned: Value = serde_json::from_slice(&std::fs::read(designs.join("qr.json")).unwrap()).unwrap();
    let metadata: Value = serde_json::from_slice(&std::fs::read(kernels.join("kernels.json")).unwrap()).unwrap();
    let mut rows = Vec::new();
    for item in metadata["multiple"].as_array().unwrap() {
        let design = pinned["cases"].as_array().unwrap().iter().find(|c| c["id"] == item["design"]).unwrap();
        let x = read(designs, &design["x"]);
        let ones = vec![Complex64::new(1.0, 0.0); x.len()];
        let columns: [&[Complex64]; 2] = if item["order"] == "ones-first" { [&ones, &x] } else { [&x, &ones] };
        let rhs: Vec<f64> = read(kernels, &item["rhs"]).iter().map(|v| v.re).collect();
        let m = x.len();
        let ys: Vec<&[f64]> = rhs.chunks(m).collect();
        let precision = if item["precision"] == "single" { Precision::Single } else { Precision::Double };
        let solved = lstsq::mldivide_many(&columns, &ys, precision);
        rows.push(json!({
            "id": item["id"],
            "coefficients": solved.coefficients.iter().map(|c| c.iter().map(|v| [v.re, v.im]).collect::<Vec<_>>()).collect::<Vec<_>>(),
        }));
    }
    std::fs::write(&args[2], serde_json::to_string(&rows).unwrap()).unwrap();
}
