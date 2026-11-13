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

/// MATLAB solves A \ B for all right-hand sides in one ?ormqr/?unmqr and
/// ?trsm call. For every recorded 8-column solve (214 single and 190 double
/// real, 134 single and 158 double complex), the port's Q^H y must equal the
/// MEX chain's bit for bit, and its coefficients MATLAB's. MATLAB stores a
/// result whose imaginary parts are all zero as a real array (30 complex
/// solves): there the real parts must match bit for bit and every imaginary
/// part must be zero, because the recording holds no sign for it.
#[test]
fn multiple_right_hand_sides_match_matlab_on_amd() {
    let Some(hosts) = hosts() else { return; };
    let designs_root = PathBuf::from(std::env::var_os("SAMSRF_QR_REFERENCE_DIR").expect("SAMSRF_QR_REFERENCE_DIR")).join("ubuntu-24.04").join("compatible");
    let designs: Value = serde_json::from_slice(&std::fs::read(designs_root.join("qr.json")).unwrap()).unwrap();
    let (root, _) = hosts.iter().find(|(_, cpu)| cpu.contains("AMD")).unwrap();
    let metadata: Value = serde_json::from_slice(&std::fs::read(root.join("kernels.json")).unwrap()).unwrap();
    let mut visited = std::collections::BTreeSet::new();
    let mut solves = std::collections::BTreeMap::<String, usize>::new();
    let mut complex_stored_real = 0;
    let bits = |v: Complex64| [v.re.to_bits(), v.im.to_bits()];
    for item in metadata["multiple"].as_array().unwrap() {
        let design = designs["cases"].as_array().unwrap().iter().find(|c| c["id"] == item["design"]).unwrap();
        let x = complex_values(&designs_root, &design["x"]);
        let m = x.len();
        let ones = vec![Complex64::new(1.0, 0.0); m];
        let columns: [&[Complex64]; 2] = if item["order"] == "ones-first" { [&ones, &x] } else { [&x, &ones] };
        let rhs: Vec<f64> = values(root, &item["rhs"]);
        let ys: Vec<&[f64]> = rhs.chunks(m).collect();
        let precision = if item["precision"] == "single" { Precision::Single } else { Precision::Double };
        let (solved, qty) = lstsq::mldivide_many_with_qty(&columns, &ys, precision);
        let id = item["id"].as_str().unwrap();
        assert!(visited.insert(id.to_string()), "duplicate multi-RHS case {id}");
        assert_eq!(ys.len(), 8, "{id}: recorded right-hand sides");
        let production = lstsq::mldivide_many(&columns, &ys, precision);
        assert_eq!(production.rank, solved.rank, "{id}: diagnostic rank");
        assert_eq!(production.pivot, solved.pivot, "{id}: diagnostic pivot");
        assert_eq!(production.coefficients.len(), ys.len(), "{id}: production right-hand sides");
        assert_eq!(solved.coefficients.len(), ys.len(), "{id}: diagnostic right-hand sides");
        for (j, (actual, diagnostic)) in production.coefficients.iter().zip(&solved.coefficients).enumerate() {
            assert_eq!(actual.len(), columns.len(), "{id}: production coefficient shape for right-hand side {j}");
            assert_eq!(actual.iter().copied().map(bits).collect::<Vec<_>>(), diagnostic.iter().copied().map(bits).collect::<Vec<_>>(),
                "{id}: diagnostic coefficients for right-hand side {j}");
        }
        let recorded_qty = complex_values(root, &item["qty"]);
        assert_eq!(recorded_qty.len(), m * ys.len(), "{id}: recorded Q^H y shape");
        assert_eq!(qty.len(), ys.len(), "{id}: Q^H y right-hand sides");
        for (j, column) in qty.iter().enumerate() {
            assert_eq!(column.len(), m, "{id}: Q^H y rows of right-hand side {j}");
            for (i, value) in column.iter().enumerate() {
                assert_eq!(bits(*value), bits(recorded_qty[i + j * m]), "{id}: Q^H y row {i} of right-hand side {j}");
            }
        }
        let together = complex_values(root, &item["together"]);
        let stored_real = item["together"]["imaginary"].as_str().is_none_or(str::is_empty);
        assert_eq!(solved.coefficients.iter().flatten().count(), together.len(), "{id}: shape");
        for (index, value) in solved.coefficients.iter().flatten().enumerate() {
            let expected = together[index];
            if stored_real && item["complex"] == true {
                assert!(value.re.to_bits() == expected.re.to_bits() && value.im == 0.0,
                    "{id}: coefficient {index}: {value} differs from MATLAB's real {}", expected.re);
            } else {
                assert_eq!(bits(*value), bits(expected), "{id}: coefficient {index}: {value} differs from MATLAB's {expected}");
            }
        }
        let class = if item["complex"] == true { "complex " } else { "" };
        complex_stored_real += usize::from(stored_real && item["complex"] == true);
        *solves.entry(format!("{class}{}", item["precision"].as_str().unwrap())).or_default() += 1;
    }
    eprintln!("8-column solves equal to MATLAB: {solves:?}");
    assert_eq!(visited.len(), 696, "missing multi-RHS designs");
    assert_eq!(complex_stored_real, 30, "complex solves MATLAB stored as real");
    let expected = [("complex double", 158), ("complex single", 134), ("double", 190), ("single", 214)];
    assert_eq!(solves.into_iter().collect::<Vec<_>>(), expected.map(|(k, n)| (k.to_string(), n)).to_vec());
}

/// Every step of MKL's recorded chain (`?geqp3`'s pivot, packed factor and
/// reflector scalars, `?ormqr`/`?unmqr`'s Q^H y, `?trsv`'s coefficients)
/// equals the port's bit for bit on every recorded design, in the class
/// MATLAB solves it. Three single designs whose imaginary parts are subnormal
/// have no chain in the class the port uses and are counted, not compared.
#[test]
fn every_recorded_chain_step_matches_mkl_on_amd() {
    let Some(hosts) = hosts() else { return; };
    let designs_root = PathBuf::from(std::env::var_os("SAMSRF_QR_REFERENCE_DIR").expect("SAMSRF_QR_REFERENCE_DIR")).join("ubuntu-24.04").join("compatible");
    let designs: Value = serde_json::from_slice(&std::fs::read(designs_root.join("qr.json")).unwrap()).unwrap();
    let (root, _) = hosts.iter().find(|(_, cpu)| cpu.contains("AMD")).unwrap();
    let metadata: Value = serde_json::from_slice(&std::fs::read(root.join("kernels.json")).unwrap()).unwrap();
    let bits = |values: &[Complex64]| values.iter().map(|v| [v.re.to_bits(), v.im.to_bits()]).collect::<Vec<_>>();
    let (mut compared, mut unchained) = (0, 0);
    for case in metadata["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let design = designs["cases"].as_array().unwrap().iter().find(|c| c["id"] == case["id"]).unwrap();
        let x = complex_values(&designs_root, &design["x"]);
        let y: Vec<f64> = values(&designs_root, &design["y"]);
        let ones = vec![Complex64::new(1.0, 0.0); x.len()];
        let columns: [&[Complex64]; 2] = if design["order"] == "ones-first" { [&ones, &x] } else { [&x, &ones] };
        let precision = if case["precision"] == "single" { Precision::Single } else { Precision::Double };
        let port = lstsq::mldivide(&columns, &y, precision);
        let variant = if port.packed.iter().flatten().any(|v| v.im != 0.0) { "complex" } else { "real" };
        let chains = match &case["chains"] { Value::Array(list) => list.clone(), single => vec![single.clone()] };
        let Some(chain) = chains.iter().find(|c| c["variant"] == variant) else {
            unchained += 1;
            continue;
        };
        let pivot: Vec<usize> = values(root, &chain["pivot"]).iter().map(|&p| p as usize - 1).collect();
        assert_eq!(pivot, port.pivot, "{id}: pivot");
        let factor = complex_values(root, &chain["factor"]);
        let m = x.len();
        for (j, column) in port.packed.iter().enumerate() {
            assert_eq!(bits(&factor[j * m..(j + 1) * m]), bits(column), "{id}: factor column {j}");
        }
        assert_eq!(bits(&complex_values(root, &chain["tau"])), bits(&port.tau), "{id}: tau");
        assert_eq!(bits(&complex_values(root, &chain["qty"])), bits(&port.qty), "{id}: Q^H y");
        assert_eq!(bits(&complex_values(root, &chain["beta"])), bits(&port.coefficients), "{id}: coefficients");
        compared += 1;
    }
    eprintln!("{compared} recorded chains equal MKL's at every step; {unchained} without a chain in the port's class");
    assert_eq!((compared, unchained), (345, 3));
}
