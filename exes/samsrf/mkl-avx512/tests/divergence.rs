//! RESEARCH (branch t3/samsrf-intel-cf): where MATLAB on the recorded Intel hosts first
//! departs from the shipped port on the routes samsrf-mkl-avx512 does not cover (single and
//! complex data), measured on existing recordings. No Intel model is fitted here. Every
//! comparison runs the shipped port's own arithmetic (MKL CNR `auto`, the AMD hosts' branch),
//! and the AMD hosts of the same recordings are the control: there it reproduces every
//! compared value. The Intel counts are observations of data that earlier reports had
//! already counted in aggregate (cli_preprocess.rs, qr_kernels.rs, matlab_numerics.rs,
//! cf_single_replay.rs); they are pinned so that a change shows, not as targets.
//!
//! Fixtures (each pair fails closed when only half is set):
//! SAMSRF_CLI_REFERENCE_DIR + SAMSRF_CLI_COURSES_DIR, SAMSRF_SINGLE_KERNELS_DIR,
//! SAMSRF_QR_KERNELS_DIR + SAMSRF_QR_REFERENCE_DIR, SAMSRF_MATLAB_NUMERICS_DIR and
//! SAMSRF_MATLAB_NUMERICS2_DIR. SAMSRF_DIVERGENCE_REPORT_DIR, when set, receives one JSON
//! report per test.

use num_complex::Complex64;
use samsrf_core::gifti;
use samsrf_core::lstsq;
use samsrf_core::matlab_math;
use samsrf_core::precision::{gemv_t_single, sum_single, Precision};
use samsrf_core::preprocess::{Combine, Normalise, PreprocessOptions, RunAccumulator};
use samsrf_core::timeseries::VertexSelection;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn pair(names: [&str; 2]) -> Option<[PathBuf; 2]> {
    match (env(names[0]), env(names[1])) {
        (None, None) => None,
        (Some(a), Some(b)) => Some([a, b]),
        _ => panic!("set both {} and {}", names[0], names[1]),
    }
}

fn json_file(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn f64s(path: &Path) -> Vec<f64> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(bytes.len() % 8, 0, "{}: float64 payload", path.display());
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name, "a bare file name");
    f64s(&root.join(name))
}

fn complex_array(root: &Path, descriptor: &Value) -> Vec<Complex64> {
    let re = array(root, descriptor);
    let im = match descriptor["imaginary"].as_str().filter(|s| !s.is_empty()) {
        Some(name) => f64s(&root.join(name)),
        None => vec![0.0; re.len()],
    };
    assert_eq!(re.len(), im.len(), "real and imaginary parts");
    re.into_iter().zip(im).map(|(re, im)| Complex64::new(re, im)).collect()
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits()
}

fn same_complex(a: Complex64, b: Complex64) -> bool {
    same(a.re, b.re) && same(a.im, b.im)
}

fn report(name: &str, value: &Value) {
    println!("{name}: {}", serde_json::to_string(value).unwrap());
    if let Some(dir) = env("SAMSRF_DIVERGENCE_REPORT_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{name}.json")), serde_json::to_string_pretty(value).unwrap() + "\n").unwrap();
    }
}

#[test]
fn partial_fixture_pairs_are_rejected() {
    for names in [["SAMSRF_CLI_REFERENCE_DIR", "SAMSRF_CLI_COURSES_DIR"], ["SAMSRF_QR_KERNELS_DIR", "SAMSRF_QR_REFERENCE_DIR"]] {
        let set: Vec<_> = names.iter().filter(|name| std::env::var_os(name).is_some()).collect();
        assert!(set.len() != 1, "set both {} and {}", names[0], names[1]);
    }
}

/// The CLI recording's single `Srf.Y`, from the port's single preprocessing on the recording's
/// own bundle, against both hosts: identical on each, so single preprocessing is the same on
/// both hosts here and single runs first depart in their fits. The port's double courses are
/// counted beside them (their Intel values need the samsrf-mkl-avx512 detrend, recordings.rs).
#[test]
fn single_courses_are_matlab_on_both_hosts() {
    let Some([recording, courses]) = pair(["SAMSRF_CLI_REFERENCE_DIR", "SAMSRF_CLI_COURSES_DIR"]) else { return };
    let manifest = json_file(&courses.join("manifest.json"));
    let plan = &manifest["plan"];
    assert_eq!(plan, &json_file(&recording.join("plan.json")), "the extraction's plan is the recording's");
    let mut counts = BTreeMap::new();
    for host in ["amd", "intel"] {
        let entries = manifest["hosts"][host]["runs"].as_array().unwrap();
        assert_eq!(entries.len(), 24, "{host}: run inventory");
        for entry in entries {
            let run = plan["runs"].as_array().unwrap().iter().find(|run| run["id"] == entry["id"]).unwrap();
            let model = &run["model"];
            if model["Global_Signal_Correction"] == true || model["Smoothing"].as_f64().is_some_and(|value| value != 0.0) {
                continue; // Srf.Y saved after later stages
            }
            let precision = if run["precision"] == "single" { Precision::Single } else { Precision::Double };
            let argv = run["argv"].as_array().unwrap();
            let argument = |prefix: &str| argv.iter().filter_map(Value::as_str).find_map(|v| v.strip_prefix(prefix)).map(str::to_string);
            assert_eq!(argument("-norm=").as_deref(), Some("1"));
            let combine = match argument("-aver=").as_deref() {
                Some("1") => Combine::Average { noise_ceiling: true },
                Some("0") => Combine::Concatenate,
                other => panic!("-aver={other:?}"),
            };
            let pattern = argv[2].as_str().unwrap().strip_prefix("/input/").unwrap();
            let (folder, name) = pattern.rsplit_once('/').unwrap();
            let (stem, suffix) = name.split_once('*').unwrap();
            let mut files: Vec<PathBuf> = std::fs::read_dir(recording.join("bundle").join(folder)).unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    let file = path.file_name().unwrap().to_str().unwrap();
                    file.starts_with(stem) && file.ends_with(suffix)
                })
                .collect();
            files.sort();
            let raw: Vec<_> = files.iter().map(|path| gifti::read_run(&std::fs::read(path).unwrap()).unwrap()).collect();
            let roi: Vec<u32> = entry["roi"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32 - 1).collect();
            let options = PreprocessOptions { normalise: Normalise::DetrendZscore, combine, global_signal: false, precision };
            let mut accumulator = RunAccumulator::new(raw[0].vertices, VertexSelection::from_indices(roi.clone()), options);
            for run_data in &raw {
                accumulator.push_run(run_data).unwrap();
            }
            let preprocessed = accumulator.finish().unwrap();
            let port: Vec<f64> = (0..roi.len())
                .flat_map(|position| preprocessed.data.course(position).to_vec())
                .map(|value| if precision == Precision::Single { f64::from(value as f32) } else { value })
                .collect();
            let matlab = f64s(&courses.join(host).join(entry["file"].as_str().unwrap()));
            assert_eq!(port.len(), matlab.len(), "{host} {}: values", entry["id"]);
            let equal = port.iter().zip(&matlab).filter(|(a, b)| same(**a, **b)).count();
            let slot: &mut [usize; 3] = counts.entry(format!("{host} {}", run["precision"].as_str().unwrap())).or_insert([0; 3]);
            slot[0] += 1;
            slot[1] += matlab.len();
            slot[2] += equal;
        }
    }
    report("courses", &json!(counts));
    // [runs, values, equal to MATLAB]
    assert_eq!(counts["amd double"], [11, 84_000, 84_000]);
    assert_eq!(counts["amd single"], [11, 84_000, 84_000]);
    assert_eq!(counts["intel single"], [11, 84_000, 84_000], "single preprocessing is the same on both hosts");
    // Observed: the shipped double detrend on the Intel host's courses.
    assert_eq!(counts["intel double"], [11, 84_000, 4_033]);
}

/// The single CF `corr(y, X)` of the single-kernels recording, stage by stage, with the port's
/// single arithmetic on each host's own recorded courses: `mean`, `sum` and `vecnorm` (MATLAB's
/// own code) and the `y' * X` product (MKL `sgemv`), then `corr`. The product is computed from
/// the port's centred courses, which equal MATLAB's means.
#[test]
fn single_cf_correlation_stages_by_host() {
    let Some(root) = env("SAMSRF_SINGLE_KERNELS_DIR") else { return };
    let mut by_host = BTreeMap::new();
    for host in ["amd-7763-auto", "intel-8573c-avx512"] {
        let dir = root.join(host);
        let recording = json_file(&dir.join("kernels.json"));
        let mut stages: BTreeMap<&str, [usize; 2]> = BTreeMap::new();
        let mut tally = |stage: &'static str, port: f32, matlab: f64| {
            let slot = stages.entry(stage).or_insert([0; 2]);
            slot[0] += 1;
            slot[1] += usize::from(port.to_bits() == (matlab as f32).to_bits() && f64::from(matlab as f32).to_bits() == matlab.to_bits());
        };
        let cases: Vec<&Value> = recording["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "corr").collect();
        assert_eq!(cases.len(), 2, "{host}: corr cases");
        for case in cases {
            let column = |name: &str| -> (Vec<usize>, Vec<f64>) {
                let d = &case[name];
                (d["shape"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect(), array(&dir, d))
            };
            let ((shape, courses), (seed_shape, seeds)) = (column("courses"), column("seedCourses"));
            let (n, vertices, seed_count) = (shape[0], shape[1], seed_shape[1]);
            let course = |data: &[f64], j: usize| -> Vec<f32> { data[j * n..(j + 1) * n].iter().map(|&v| v as f32).collect() };
            let centre = |v: &[f32]| -> (f32, f32, Vec<f32>) {
                let sum = sum_single(v);
                let mean = sum / n as f32;
                (sum, mean, v.iter().map(|x| x - mean).collect())
            };
            let norm = |v: &[f32]| v.iter().map(|&x| f64::from(x).powi(2)).sum::<f64>().sqrt() as f32;
            let (_, mean_seed) = column("meanSeed");
            let (_, sum_seed) = column("sumSeed");
            let (_, norm_seed) = column("normSeed");
            let (_, mean_course) = column("meanCourse");
            let (_, norm_course) = column("normCourse");
            let (_, product) = column("product");
            let (_, corr) = column("corr");
            let mut centred_seeds = Vec::new();
            let mut seed_norms = Vec::new();
            for j in 0..seed_count {
                let (sum, mean, centred) = centre(&course(&seeds, j));
                tally("sum seed", sum, sum_seed[j]);
                tally("mean seed", mean, mean_seed[j]);
                let nx = norm(&centred);
                tally("vecnorm seed", nx, norm_seed[j]);
                centred_seeds.push(centred);
                seed_norms.push(nx);
            }
            let columns: Vec<&[f32]> = centred_seeds.iter().map(Vec::as_slice).collect();
            for v in 0..vertices {
                let (_, mean, centred) = centre(&course(&courses, v));
                tally("mean course", mean, mean_course[v]);
                let ny = norm(&centred);
                tally("vecnorm course", ny, norm_course[v]);
                for (j, p) in gemv_t_single(&centred, &columns).into_iter().enumerate() {
                    // Recorded [vertices x seeds], column-major.
                    tally("y'X (sgemv)", p, product[v + j * vertices]);
                    let r = (p / ny) / seed_norms[j];
                    let r = if r.abs() > 1.0 { r / r.abs() } else { r };
                    tally("corr", r, corr[v + j * vertices]);
                }
            }
        }
        by_host.insert(host, stages);
    }
    report("single-cf-corr", &json!(by_host));
    let amd = &by_host["amd-7763-auto"];
    assert!(amd.values().all(|[n, equal]| n == equal), "AMD control: {amd:?}");
    let intel = &by_host["intel-8573c-avx512"];
    // Observed: MATLAB's own sum, mean and vecnorm are the same on the Intel host; sgemv is not.
    for stage in ["sum seed", "mean seed", "vecnorm seed", "mean course", "vecnorm course"] {
        assert_eq!(intel[stage][0], intel[stage][1], "Intel {stage}");
    }
    assert_eq!(intel["y'X (sgemv)"], [378, 110]);
    assert_eq!(intel["corr"], [378, 121]);
}

const STEPS: [&str; 12] = ["pivot", "R11", "v1", "tau1", "R12", "R22", "v2", "tau2", "qty1", "qty2", "qtyRest", "beta"];

/// Every recorded two-column chain of the qr-kernels recording on each of its six hosts, solved
/// by the port's `lstsq::mldivide` in the class MATLAB solves it, and the first step that differs:
/// `?geqp3` (pivot, R(1,1) from the norm, reflector 1, tau 1, R(1,2) from the `?gemv` update,
/// R(2,2), reflector 2, tau 2), `?ormqr`'s Q^H y (rows 1, 2 and the rest) and `?trsv`'s
/// coefficients. Then the 8-column solves: Q^H Y and coefficients per right-hand side.
#[test]
fn least_squares_first_departure_by_class_and_host() {
    let Some([kernels, designs_root]) = pair(["SAMSRF_QR_KERNELS_DIR", "SAMSRF_QR_REFERENCE_DIR"]) else { return };
    let designs_root = designs_root.join("ubuntu-24.04").join("compatible");
    let designs = json_file(&designs_root.join("qr.json"));
    let hosts = json_file(&kernels.join("hosts.json"));
    let hosts = hosts.as_object().unwrap();
    assert_eq!(hosts.len(), 6, "kernel recordings");
    let mut results = BTreeMap::new();
    for (name, host) in hosts {
        let cpu = host["cpu"].as_str().unwrap();
        let avx512 = host["blas"].as_str().unwrap().contains("CNR branch AVX512_E1");
        assert_eq!(avx512, cpu.contains("Intel"), "{name}: branch by receipt");
        let root = kernels.join(name);
        let metadata = json_file(&root.join("kernels.json"));
        let mut first: BTreeMap<String, BTreeMap<&str, usize>> = BTreeMap::new();
        let mut unchained = 0;
        for case in metadata["cases"].as_array().unwrap() {
            let design = designs["cases"].as_array().unwrap().iter().find(|c| c["id"] == case["id"]).unwrap();
            let x = complex_array(&designs_root, &design["x"]);
            let y = array(&designs_root, &design["y"]);
            let ones = vec![Complex64::new(1.0, 0.0); x.len()];
            let columns: [&[Complex64]; 2] = if design["order"] == "ones-first" { [&ones, &x] } else { [&x, &ones] };
            let precision = if case["precision"] == "single" { Precision::Single } else { Precision::Double };
            let port = lstsq::mldivide(&columns, &y, precision);
            let variant = if port.packed.iter().flatten().any(|v| v.im != 0.0) { "complex" } else { "real" };
            let chains = match &case["chains"] { Value::Array(list) => list.clone(), one => vec![one.clone()] };
            let Some(chain) = chains.iter().find(|c| c["variant"] == variant) else {
                unchained += 1;
                continue;
            };
            let m = x.len();
            let factor = complex_array(&root, &chain["factor"]);
            let tau = complex_array(&root, &chain["tau"]);
            let qty = complex_array(&root, &chain["qty"]);
            let beta = complex_array(&root, &chain["beta"]);
            let pivot: Vec<usize> = array(&root, &chain["pivot"]).iter().map(|&p| p as usize - 1).collect();
            let all = |a: &[Complex64], b: &[Complex64]| a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_complex(*a, *b));
            let (f0, f1) = (&factor[..m], &factor[m..2 * m]);
            let (p0, p1) = (&port.packed[0], &port.packed[1]);
            let equal = [
                pivot == port.pivot,
                same_complex(f0[0], p0[0]),
                all(&f0[1..], &p0[1..]),
                same_complex(tau[0], port.tau[0]),
                same_complex(f1[0], p1[0]),
                m < 2 || same_complex(f1[1], p1[1]),
                m < 3 || all(&f1[2..], &p1[2..]),
                tau.len() < 2 || same_complex(tau[1], port.tau[1]),
                same_complex(qty[0], port.qty[0]),
                m < 2 || same_complex(qty[1], port.qty[1]),
                m < 3 || all(&qty[2..], &port.qty[2..]),
                all(&beta, &port.coefficients),
            ];
            let step = equal.iter().position(|e| !e).map_or("none", |i| STEPS[i]);
            let class = format!("{} {variant}", case["precision"].as_str().unwrap());
            *first.entry(class).or_default().entry(step).or_default() += 1;
        }
        let mut multiple: BTreeMap<String, [usize; 3]> = BTreeMap::new();
        for item in metadata["multiple"].as_array().unwrap() {
            let design = designs["cases"].as_array().unwrap().iter().find(|c| c["id"] == item["design"]).unwrap();
            let x = complex_array(&designs_root, &design["x"]);
            let m = x.len();
            let ones = vec![Complex64::new(1.0, 0.0); m];
            let columns: [&[Complex64]; 2] = if item["order"] == "ones-first" { [&ones, &x] } else { [&x, &ones] };
            let rhs = array(&root, &item["rhs"]);
            let ys: Vec<&[f64]> = rhs.chunks(m).collect();
            assert_eq!(ys.len(), 8, "{}: right-hand sides", item["id"]);
            let precision = if item["precision"] == "single" { Precision::Single } else { Precision::Double };
            let (solved, qty) = lstsq::mldivide_many_with_qty(&columns, &ys, precision);
            let recorded_qty = complex_array(&root, &item["qty"]);
            let together = complex_array(&root, &item["together"]);
            let stored_real = item["together"]["imaginary"].as_str().is_none_or(str::is_empty);
            let class = format!("{} {}", item["precision"].as_str().unwrap(), if item["complex"] == true { "complex" } else { "real" });
            let slot = multiple.entry(class).or_insert([0; 3]);
            for (j, column) in qty.iter().enumerate() {
                slot[0] += 1;
                slot[1] += usize::from(column.iter().enumerate().all(|(i, v)| same_complex(*v, recorded_qty[i + j * m])));
                let coefficients = &solved.coefficients[j];
                slot[2] += usize::from(coefficients.iter().enumerate().all(|(k, v)| {
                    let expected = together[j * coefficients.len() + k];
                    if stored_real && item["complex"] == true { same(v.re, expected.re) && v.im == 0.0 } else { same_complex(*v, expected) }
                }));
            }
        }
        results.insert(name.clone(), json!({"cpu": cpu, "avx512": avx512, "unchained": unchained,
            "chainsFirstDifferingStep": first, "eightColumnSolves[rhs, QHy equal, coefficients equal]": multiple}));
        if !avx512 {
            for (class, steps) in &first {
                assert_eq!(steps.keys().copied().collect::<Vec<_>>(), vec!["none"], "{name} ({cpu}) {class}: AMD control");
            }
            for (class, [n, q, c]) in &multiple {
                assert!(n == q && n == c, "{name} ({cpu}) {class}: AMD control");
            }
        }
    }
    report("least-squares", &json!(results));
    // Observed on the Intel Xeon 8370C (AVX512_E1). Real double chains are the discovery
    // data of the samsrf-mkl-avx512 chain (recordings.rs reproduces all of them).
    assert_eq!(results["ubuntu-22.04-3"], json!({"cpu": "Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz", "avx512": true, "unchained": 3,
        "chainsFirstDifferingStep": {
            "double complex": {"R11": 23, "R12": 49, "v1": 7},
            "double real": {"R11": 25, "R12": 54, "R22": 9, "qty1": 1, "v2": 6},
            "single complex": {"R12": 41, "v1": 21, "v2": 2},
            "single real": {"R12": 87, "R22": 4, "qty1": 2, "qty2": 1, "v2": 13}},
        "eightColumnSolves[rhs, QHy equal, coefficients equal]": {
            "double complex": [1264, 0, 4], "double real": [1520, 0, 124],
            "single complex": [1072, 0, 56], "single real": [1712, 0, 334]}}));
}

/// MATLAB's `x' * y`, `z' * y`, `norm(x)` and `norm(z)` of the numerics recordings' 24 vectors on
/// each host, against the shipped kernels (AMD branch) and, for the real double ones, the
/// samsrf-mkl-avx512 kernels; the complex norm is also compared with the correctly rounded
/// candidate over interleaved parts (discovery data only, as recordings.rs says).
#[test]
fn blas_kernels_by_host() {
    let mut results = BTreeMap::new();
    for variable in ["SAMSRF_MATLAB_NUMERICS_DIR", "SAMSRF_MATLAB_NUMERICS2_DIR"] {
        let Some(root) = env(variable) else { continue };
        let manifest = json_file(&root.join("manifest.json"));
        for (host, entry) in manifest["hosts"].as_object().unwrap() {
            let avx512 = entry["blas"].as_str().unwrap().contains("CNR branch AVX512_E1");
            let dir = root.join(host).join("compatible");
            let recording = json_file(&dir.join("numerics.json"));
            let mut counts: BTreeMap<&str, [usize; 2]> = BTreeMap::new();
            let mut tally = |kernel: &'static str, equal: bool| {
                let slot = counts.entry(kernel).or_insert([0; 2]);
                slot[0] += 1;
                slot[1] += usize::from(equal);
            };
            let cases: Vec<&Value> = recording["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "blas").collect();
            assert_eq!(cases.len(), 24, "{variable} {host}: vectors");
            for case in cases {
                let (x, y, z) = (array(&dir, &case["x"]), array(&dir, &case["y"]), complex_array(&dir, &case["z"]));
                let dot = array(&dir, &case["dot"])[0];
                let complex_dot = complex_array(&dir, &case["complexDot"])[0];
                let norm = array(&dir, &case["norm"])[0];
                let complex_norm = array(&dir, &case["complexNorm"])[0];
                let parts: Vec<f64> = z.iter().flat_map(|v| [v.re, v.im]).collect();
                tally("x'y shipped", same(matlab_math::ddot(&x, &y), dot));
                tally("x'y avx512", same(samsrf_mkl_avx512::blas::ddot(&x, &y), dot));
                tally("norm(x) shipped", same(matlab_math::nrm2(x.iter().copied()), norm));
                tally("norm(x) correctly rounded", same(samsrf_mkl_avx512::nrm2(&x), norm));
                tally("z'y shipped", same_complex(matlab_math::zdotc_real(&z, &y), complex_dot));
                tally("norm(z) shipped", same(matlab_math::nrm2(parts.iter().copied()), complex_norm));
                tally("norm(z) correctly rounded", same(samsrf_mkl_avx512::nrm2(&parts), complex_norm));
            }
            let key = format!("{variable} {host}");
            results.insert(key.clone(), json!({"cpu": entry["cpu"], "avx512": avx512, "kernels[vectors, equal]": counts}));
            if avx512 {
                // Observed on both Intel models: the samsrf-mkl-avx512 `x' * y` and the correctly
                // rounded norm candidates on every vector; the shipped `z' * y` on 5.
                let expected = [("x'y shipped", 22), ("x'y avx512", 24), ("norm(x) shipped", 14), ("norm(x) correctly rounded", 24),
                    ("z'y shipped", 5), ("norm(z) shipped", 11), ("norm(z) correctly rounded", 24)];
                assert_eq!(counts.iter().map(|(k, v)| (*k, v[1])).collect::<BTreeMap<_, _>>(), expected.into_iter().collect(), "{key}");
            } else {
                for kernel in ["x'y shipped", "norm(x) shipped", "z'y shipped", "norm(z) shipped"] {
                    assert_eq!(counts[kernel][0], counts[kernel][1], "{key}: AMD control {kernel}");
                }
            }
        }
    }
    if !results.is_empty() {
        report("blas", &json!(results));
        assert_eq!(results.values().filter(|host| host["avx512"] == true).count(), results.len() / 2, "one Intel host per recording");
    }
}
