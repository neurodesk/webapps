//! Write the port's least-squares intermediates (packed factorisation, tau,
//! Q^H y, coefficients) for every design of a pinned qr-reference recording,
//! for packages/samsrf/validation/matlab/qr-steps.py to compare with MKL's
//! chain from record_qr_kernels.m.
//!
//! cargo run --release -p samsrf-core --example qr_steps -- RECORDING OUTPUT_JSON
use num_complex::Complex64;
use samsrf_core::{lstsq, precision::Precision};
use serde_json::{json, Value};
use std::path::Path;

fn array(root: &Path, descriptor: &Value) -> Vec<Complex64> {
    let read = |name: &str| -> Vec<f64> {
        assert_eq!(Path::new(name).file_name().unwrap(), name);
        std::fs::read(root.join(name)).unwrap().as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
    };
    let re = read(descriptor["file"].as_str().unwrap());
    let im = match descriptor["imaginary"].as_str().filter(|s| !s.is_empty()) {
        Some(name) => read(name),
        None => vec![0.0; re.len()],
    };
    re.into_iter().zip(im).map(|(re, im)| Complex64::new(re, im)).collect()
}

fn pairs(values: &[Complex64]) -> Vec<[f64; 2]> {
    values.iter().map(|v| [v.re, v.im]).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 2, "usage: qr_steps RECORDING OUTPUT_JSON");
    let root = Path::new(&args[0]);
    let metadata: Value = serde_json::from_slice(&std::fs::read(root.join("qr.json")).unwrap()).unwrap();
    let mut rows = Vec::new();
    for case in metadata["cases"].as_array().unwrap() {
        let x = array(root, &case["x"]);
        let y: Vec<f64> = array(root, &case["y"]).iter().map(|v| v.re).collect();
        let ones = vec![Complex64::new(1.0, 0.0); x.len()];
        let columns: [&[Complex64]; 2] = if case["order"] == "ones-first" { [&ones, &x] } else { [&x, &ones] };
        let precision = if case["precision"] == "single" { Precision::Single } else { Precision::Double };
        let solution = lstsq::mldivide(&columns, &y, precision);
        rows.push(json!({
            "id": case["id"],
            "rank": solution.rank,
            "pivot": solution.pivot,
            "complex": solution.packed.iter().flatten().any(|v| v.im != 0.0),
            "packed": solution.packed.iter().map(|c| pairs(c)).collect::<Vec<_>>(),
            "tau": pairs(&solution.tau),
            "qty": pairs(&solution.qty),
            "coefficients": pairs(&solution.coefficients),
        }));
    }
    std::fs::write(&args[1], serde_json::to_string(&rows).unwrap()).unwrap();
}
