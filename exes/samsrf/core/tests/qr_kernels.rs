//! MKL's summation orders inside MATLAB R2023b's least-squares solve, as
//! record_qr_kernels.m measured them (FPRev probes: +M and -M among ones, so
//! every result counts the ones a partial sum kept). The native workflow
//! downloads packages/samsrf/validation/matlab/qr-kernels-reference.json and
//! sets SAMSRF_QR_KERNELS_DIR. On every AMD host the port's kernels must give
//! MKL's result for every probe; the Intel AVX-512 host is reported only.
use num_complex::Complex64;
use samsrf_core::{lstsq, precision::Precision};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn hosts() -> Option<Vec<(PathBuf, String)>> {
    let root = PathBuf::from(std::env::var_os("SAMSRF_QR_KERNELS_DIR")?);
    let hosts: Value = serde_json::from_slice(&std::fs::read(root.join("hosts.json")).unwrap()).unwrap();
    let hosts: Vec<_> = hosts.as_object().unwrap().iter().map(|(name, host)| (root.join(name), host["cpu"].as_str().unwrap().to_string())).collect();
    assert_eq!(hosts.len(), 6, "missing kernel recordings");
    assert_eq!(hosts.iter().filter(|(_, cpu)| cpu.contains("AMD")).count(), 5);
    Some(hosts)
}

fn values(root: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name);
    let bytes = std::fs::read(root.join(name)).unwrap();
    // FPRev counts are int16 (.i16); every other array is float64 whatever its class.
    if name.ends_with(".i16") {
        bytes.as_chunks::<2>().0.iter().map(|b| f64::from(i16::from_le_bytes(*b))).collect()
    } else {
        bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
    }
}

/// Compare one probe; returns (pairs, mismatches).
fn check(kernel: lstsq::ProbedKernel, probe: &Value, recorded: &[f64], conjugated: bool) -> (usize, usize) {
    let m = probe["length"].as_u64().unwrap() as usize;
    let big = probe["big"].as_f64().unwrap();
    let part = probe["part"].as_u64().unwrap();
    let class = probe["class"].as_str().unwrap();
    let complex = class.starts_with('c');
    let precision = if class.ends_with("single") { Precision::Single } else { Precision::Double };
    let (mut pairs, mut mismatches) = (0, 0);
    let mut column = vec![Complex64::new(0.0, 0.0); m];
    for i in 0..m {
        for j in i + 1..m {
            for (t, slot) in column.iter_mut().enumerate() {
                let value = if t == i { big } else if t == j { -big } else { 1.0 };
                *slot = if part == 1 { Complex64::new(0.0, value) } else { Complex64::new(value, 0.0) };
            }
            let w = lstsq::probe_sum(kernel, precision, complex, &column);
            let mut got = if part == 1 { w.im } else { w.re };
            if conjugated && part == 1 {
                got = -got;
            }
            pairs += 1;
            if got != recorded[i + j * m] {
                mismatches += 1;
            }
        }
    }
    (pairs, mismatches)
}

/// The probe and chain arrays of a recording (not its JSON or MEX build).
fn arrays(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = std::fs::read_dir(root).unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".i16") || name.ends_with(".f64"))
        .collect();
    files.sort();
    files.into_iter().map(|name| { let bytes = std::fs::read(root.join(&name)).unwrap(); (name, bytes) }).collect()
}

#[test]
fn port_kernels_reproduce_every_amd_gemv_and_ormqr_probe() {
    let Some(hosts) = hosts() else { return; };
    let amd: Vec<_> = hosts.iter().filter(|(_, cpu)| cpu.contains("AMD")).collect();
    // Every AMD host recorded the same bits; the Intel AVX-512 branch did not.
    let first = arrays(&amd[0].0);
    for (root, cpu) in &hosts {
        let other = arrays(root);
        let differing = other.iter().zip(&first).filter(|(a, b)| a != b).count();
        if cpu.contains("AMD") {
            assert_eq!(other.len(), first.len(), "{cpu}: array inventory");
            assert_eq!(differing, 0, "{cpu}: AMD recordings differ");
        } else {
            eprintln!("{cpu}: {differing} of {} arrays differ from AMD", first.len());
        }
    }
    let (root, cpu) = amd[0];
    let metadata: Value = serde_json::from_slice(&std::fs::read(root.join("kernels.json")).unwrap()).unwrap();
    assert_eq!(metadata["environment"]["interpreter"], "MATLAB", "Octave is not a numerical reference");
    let (mut probes, mut pairs) = (0, 0);
    for probe in metadata["probes"].as_array().unwrap() {
        let recorded = values(root, &probe["results"]);
        let (n, bad) = check(lstsq::ProbedKernel::Column, probe, &recorded, true);
        probes += 1;
        pairs += n;
        assert_eq!(bad, 0, "{cpu}: {} differs from MKL in {bad} of {n} sums", probe["id"]);
    }
    for probe in metadata["ormqr"].as_array().unwrap() {
        let m = probe["length"].as_u64().unwrap() as usize;
        if m < 3 {
            continue; // No row is left to read w from.
        }
        let recorded = values(root, &probe["results"]);
        let count = probe["columns"].as_u64().unwrap() as usize;
        let columns: Vec<usize> = match &probe["recordedColumns"] {
            Value::Array(list) => list.iter().map(|c| c.as_u64().unwrap() as usize).collect(),
            single => vec![single.as_u64().unwrap() as usize],
        };
        for (slot, &index) in columns.iter().enumerate() {
            let plane = &recorded[slot * m * m..(slot + 1) * m * m];
            let (n, bad) = check(lstsq::ProbedKernel::RightHandSide { count, index }, probe, plane, false);
            probes += 1;
            pairs += n;
            assert_eq!(bad, 0, "{cpu}: {} column {index} differs from MKL in {bad} of {n} sums", probe["id"]);
        }
    }
    assert_eq!(probes, 8640, "missing kernel probes");
    eprintln!("{cpu}: all {probes} probes ({pairs} sums) equal MKL's");
}

fn complex_values(root: &Path, descriptor: &Value) -> Vec<Complex64> {
    let re = values(root, descriptor);
    let im = match descriptor["imaginary"].as_str().filter(|s| !s.is_empty()) {
        Some(name) => values(root, &serde_json::json!({"file": name})),
        None => vec![0.0; re.len()],
    };
    re.into_iter().zip(im).map(|(re, im)| Complex64::new(re, im)).collect()
}

/// MATLAB solves A \ B for all right-hand sides in one ?ormqr and ?trsm call.
/// The port's multi-column solve must equal MATLAB's in every real design it
/// reproduced when this gate was written: all 214 single and 184 of 190 double
/// recorded 8-column solves (complex multi-column solves are not modelled).
#[test]
fn multiple_right_hand_sides_match_matlab_on_amd() {
    let Some(hosts) = hosts() else { return; };
    let designs_root = PathBuf::from(std::env::var_os("SAMSRF_QR_REFERENCE_DIR").expect("SAMSRF_QR_REFERENCE_DIR")).join("ubuntu-24.04").join("compatible");
    let designs: Value = serde_json::from_slice(&std::fs::read(designs_root.join("qr.json")).unwrap()).unwrap();
    let (root, _) = hosts.iter().find(|(_, cpu)| cpu.contains("AMD")).unwrap();
    let metadata: Value = serde_json::from_slice(&std::fs::read(root.join("kernels.json")).unwrap()).unwrap();
    // Current nonmatching outputs are regression metadata, not MATLAB truth.
    // Every formerly exact case must remain exact; each other coefficient may
    // stay unchanged or improve to MATLAB, never spend another case's gain.
    let frozen: std::collections::BTreeMap<String, Vec<[u64; 2]>> =
        serde_json::from_str(include_str!("data/qr-multi-outcomes.json")).unwrap();
    let mut visited = std::collections::BTreeSet::new();
    let mut exact = std::collections::BTreeMap::<String, usize>::new();
    for item in metadata["multiple"].as_array().unwrap() {
        if item["complex"] == true {
            continue;
        }
        let design = designs["cases"].as_array().unwrap().iter().find(|c| c["id"] == item["design"]).unwrap();
        let x = complex_values(&designs_root, &design["x"]);
        let ones = vec![Complex64::new(1.0, 0.0); x.len()];
        let columns: [&[Complex64]; 2] = if item["order"] == "ones-first" { [&ones, &x] } else { [&x, &ones] };
        let rhs: Vec<f64> = values(root, &item["rhs"]);
        let ys: Vec<&[f64]> = rhs.chunks(x.len()).collect();
        let precision = if item["precision"] == "single" { Precision::Single } else { Precision::Double };
        let solved = lstsq::mldivide_many(&columns, &ys, precision);
        let together = complex_values(root, &item["together"]);
        let same = solved.coefficients.iter().enumerate().all(|(j, c)| c.iter().enumerate().all(|(i, v)| *v == together[i + j * 2]));
        let id = item["id"].as_str().unwrap();
        assert!(visited.insert(id.to_string()), "duplicate multi-RHS case {id}");
        let previous = frozen.get(id);
        if let Some(bits) = previous {
            assert_eq!(bits.len(), together.len(), "{id}: snapshot shape");
        }
        for (index, value) in solved.coefficients.iter().flatten().enumerate() {
            assert!(multi_coefficient_matches(*value, together[index], previous.map(|bits| bits[index])),
                "{id}: coefficient {index}: {value} differs from MATLAB and the frozen result");
        }
        *exact.entry(item["precision"].as_str().unwrap().to_string()).or_default() += usize::from(same);
    }
    eprintln!("bit-identical 8-column solves: {exact:?}");
    assert_eq!(visited.len(), 404, "missing real multi-RHS designs");
    assert_eq!(exact.get("single"), Some(&214), "bit-identical single 8-column solves");
    assert_eq!(exact.get("double"), Some(&184), "bit-identical double 8-column solves");
    assert_eq!(frozen.len(), 6);
    assert!(frozen.keys().all(|id| visited.contains(id)), "unvisited frozen design");
}

fn multi_coefficient_matches(actual: Complex64, expected: Complex64, previous: Option<[u64; 2]>) -> bool {
    actual == expected || previous == Some([actual.re.to_bits(), actual.im.to_bits()])
}

#[test]
fn multi_rhs_regressions_cannot_replace_improvements() {
    let expected = Complex64::new(1.0, 0.0);
    let previous = Complex64::new(f64::from_bits(1.0f64.to_bits() + 1), 0.0);
    let bits = Some([previous.re.to_bits(), previous.im.to_bits()]);
    assert!(multi_coefficient_matches(previous, expected, bits));
    assert!(multi_coefficient_matches(expected, expected, bits));
    assert!(!multi_coefficient_matches(Complex64::new(2.0, 0.0), expected, bits));
    assert!(!multi_coefficient_matches(previous, expected, None));
    assert!(!multi_coefficient_matches(Complex64::new(f64::NAN, 0.0), expected, bits));
}
