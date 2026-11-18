//! The Intel AVX512_E1 reference (`samsrf_mkl_avx512`) against every pinned Intel
//! recording of MATLAB's real double least squares. Each test returns when its recording is
//! not configured; the environment variables are the ones the AMD gates use.
//!
//! Identification and freezes: packages/samsrf/validation/matlab/intel-avx512/README.md.
//! The kernel recording (SAMSRF_QR_KERNELS_DIR) and the numerics norms were the discovery
//! set; the direct detrend cases (SAMSRF_CGG_DIR) and the global regression
//! (SAMSRF_REVCOR_REFERENCE_DIR) were held out and frozen before they were read; the
//! 134,257-134,260-vertex pipeline runs, the revcor raw-file preprocessing and the
//! SamSrfAnalysis preprocessing were compared after the freeze, with no change to the model.
use samsrf_core::gifti;
use samsrf_mkl_avx512::{self as mkl_avx512, Design, Detrender};
use samsrf_core::preprocess;
use samsrf_core::timeseries::{RawRun, TimeSeries};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// A float64 array of a recording (`.f64`), checked against its descriptor's shape.
fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name, "array names are plain file names");
    let bytes = std::fs::read(root.join(name)).unwrap();
    let values: Vec<f64> = bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect();
    if let Some(shape) = descriptor["shape"].as_array() {
        let count: u64 = shape.iter().map(|d| d.as_u64().unwrap()).product();
        assert_eq!(values.len() as u64, count, "{name}: shape");
    }
    values
}

fn real(root: &Path, descriptor: &Value) -> Vec<f64> {
    if let Some(imaginary) = descriptor["imaginary"].as_str().filter(|name| !name.is_empty()) {
        let parts = array(root, &serde_json::json!({ "file": imaginary }));
        assert!(parts.iter().all(|&v| v == 0.0), "{}: a real chain has no imaginary part", descriptor["file"]);
    }
    array(root, descriptor)
}

fn bits(values: &[f64]) -> Vec<u64> {
    values.iter().map(|v| v.to_bits()).collect()
}

fn identical(a: &[f64], b: &[f64]) -> usize {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).filter(|(x, y)| x.to_bits() == y.to_bits()).count()
}

fn f32_hash(values: &[f32]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.to_le_bytes());
    }
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `samsrf_gii2srf`'s detrend, z-score and `nanmean(., 3)` of the `kept` vertices'
/// courses, with this branch's detrend: each vertex is right-hand side `vertex` of the
/// run's vertices. Averaging sums the runs in order (as `preprocess::RunAccumulator`).
fn preprocess_on_avx512(runs: &[RawRun], kept: &[usize], average: bool) -> Vec<Vec<f64>> {
    let volumes = runs[0].volumes;
    let detrender = Detrender::new(volumes, runs[0].vertices);
    kept.iter()
        .map(|&vertex| {
            let per_run: Vec<Vec<f64>> = runs
                .iter()
                .map(|run| {
                    let mut course: Vec<f64> = run.course(vertex).iter().map(|&v| f64::from(v)).collect();
                    detrender.apply(&mut course, vertex);
                    preprocess::zscore(&mut course);
                    course
                })
                .collect();
            if !average {
                return per_run.concat();
            }
            (0..volumes)
                .map(|t| {
                    let (mut sum, mut count) = (0.0, 0u16);
                    for course in &per_run {
                        if !course[t].is_nan() {
                            sum += course[t];
                            count += 1;
                        }
                    }
                    sum / f64::from(count)
                })
                .collect()
        })
        .collect()
}

/// Every step of the Intel host's 95 real double chains (pivot, packed factor, tau, Q'y,
/// coefficients) and Q'Y and coefficients of its 190 real double eight-column solves.
#[test]
fn every_real_double_chain_matches_mkl_on_the_intel_host() {
    let (Some(kernels), Some(designs_root)) = (env("SAMSRF_QR_KERNELS_DIR"), env("SAMSRF_QR_REFERENCE_DIR")) else { return };
    let designs_root = designs_root.join("ubuntu-24.04").join("compatible");
    let designs = json(&designs_root.join("qr.json"));
    let hosts = json(&kernels.join("hosts.json"));
    let intel: Vec<&String> = hosts.as_object().unwrap().iter().filter(|(_, host)| host["cpu"].as_str().unwrap().contains("Intel")).map(|(name, _)| name).collect();
    assert_eq!(intel.len(), 1, "one Intel kernel recording");
    let root = kernels.join(intel[0]);
    let metadata = json(&root.join("kernels.json"));
    assert!(metadata["environment"]["blas"].as_str().unwrap().contains("CNR branch AVX512_E1"), "the Intel recording ran MKL's AVX512_E1 branch");
    let design_of = |id: &Value| designs["cases"].as_array().unwrap().iter().find(|c| &c["id"] == id).unwrap();
    let columns_of = |design: &Value, order: &Value| {
        let x = array(&designs_root, &design["x"]);
        let ones = vec![1.0; x.len()];
        if order == "ones-first" { vec![ones, x] } else { vec![x, ones] }
    };
    let mut chains = 0;
    for case in metadata["cases"].as_array().unwrap() {
        let design = design_of(&case["id"]);
        if case["precision"] != "double" || !design["x"]["imaginary"].as_str().unwrap().is_empty() {
            continue;
        }
        let id = case["id"].as_str().unwrap();
        let columns = columns_of(design, &design["order"]);
        let refs: Vec<&[f64]> = columns.iter().map(Vec::as_slice).collect();
        let solved = Design::new(&refs);
        let chain = case["chains"].as_array().unwrap().iter().find(|c| c["variant"] == "real").unwrap();
        let pivot: Vec<usize> = array(&root, &chain["pivot"]).iter().map(|&p| p as usize - 1).collect();
        assert_eq!(pivot, solved.pivot(), "{id}: pivot");
        let factor = real(&root, &chain["factor"]);
        let m = columns[0].len();
        for (j, column) in solved.packed().iter().enumerate() {
            assert_eq!(bits(&factor[j * m..(j + 1) * m]), bits(column), "{id}: factor column {j}");
        }
        assert_eq!(bits(&real(&root, &chain["tau"])), bits(solved.taus()), "{id}: tau");
        let (coefficients, qty) = solved.solve_with_qty(&array(&designs_root, &design["y"]), 1, 0);
        assert_eq!(bits(&real(&root, &chain["qty"])), bits(&qty), "{id}: Q'y");
        assert_eq!(bits(&real(&root, &chain["beta"])), bits(&coefficients), "{id}: coefficients");
        chains += 1;
    }
    let mut solves = 0;
    for item in metadata["multiple"].as_array().unwrap() {
        let design = design_of(&item["design"]);
        if item["precision"] != "double" || item["complex"] == true || !design["x"]["imaginary"].as_str().unwrap().is_empty() {
            continue;
        }
        let id = item["id"].as_str().unwrap();
        let columns = columns_of(design, &item["order"]);
        let refs: Vec<&[f64]> = columns.iter().map(Vec::as_slice).collect();
        let solved = Design::new(&refs);
        let m = columns[0].len();
        let rhs = array(&root, &item["rhs"]);
        let qty = real(&root, &item["qty"]);
        let together = array(&root, &item["together"]);
        for (j, y) in rhs.chunks(m).enumerate() {
            let (coefficients, q) = solved.solve_with_qty(y, 8, j);
            assert_eq!(bits(&qty[j * m..(j + 1) * m]), bits(&q), "{id}: Q'y of right-hand side {j}");
            assert_eq!(bits(&together[2 * j..2 * j + 2]), bits(&coefficients), "{id}: coefficients of right-hand side {j}");
        }
        solves += 1;
    }
    assert_eq!((chains, solves), (95, 190), "real double chains and eight-column solves");
}

/// The recorder's `edited(kind, n, donor)` (constants_gemv.rs), in single arithmetic.
fn edited(kind: usize, n: usize, donor: &[f32]) -> Vec<f32> {
    let constant = |c: f32| vec![c; n];
    match kind {
        1 => constant(0.0),
        2 => constant(3.0),
        3 => constant(0.25),
        4 => constant(-7.5),
        5 => constant(100.0),
        6 => constant(852.0),
        7 => constant(1234.5),
        8 => constant(10000.0),
        9 => (0..n).map(|i| (2.0 * i as f64 - 100.0) as f32).collect(),
        10 => (0..n).map(|i| (0.5 * i as f64 + 3.0) as f32).collect(),
        11 => {
            let mut course = constant(852.0);
            course[(n / 2).max(1) - 1] = 853.0;
            course
        }
        12 => {
            let mut course = constant(1000.0);
            course[0] = (1000.0 + 2f64.powi(-14)) as f32;
            course
        }
        13 => {
            let mut course = constant(852.0);
            course[n - 1] = (852.0 - 2f64.powi(-14)) as f32;
            course
        }
        14 => donor[..n].iter().map(|&d| 4382.0f32 + (d - 4382.0f32) / 65536.0f32).collect(),
        15 => constant(4382.0),
        _ => unreachable!("kind {kind}"),
    }
}

const FILL: [usize; 12] = [6378, 6355, 7141, 6356, 49922, 6377, 6335, 4953, 10018, 10879, 24935, 54069];
const DONOR: usize = 6378;

/// The constants-gamma-gemv host that ran MKL's AVX512_E1 branch.
fn cgg_intel_host(root: &Path) -> PathBuf {
    let hosts: Vec<PathBuf> = ["ubuntu-22.04", "ubuntu-24.04"]
        .iter()
        .map(|host| root.join(host))
        .filter(|dir| json(&dir.join("constants-direct.json"))["environment"]["observed"]["blas"].as_str().unwrap().contains("CNR branch AVX512_E1"))
        .collect();
    assert_eq!(hosts.len(), 1, "one AVX512_E1 host in the constants-gamma-gemv recording");
    hosts[0].clone()
}

/// `D = detrend(X)` and `zscore(D)` of all 1,485 direct cases on the Intel host, from the
/// regenerated inputs (held out, frozen before reading).
#[test]
fn detrend_equals_matlab_on_the_intel_host() {
    let (Some(root), Some(runs_dir)) = (env("SAMSRF_CGG_DIR"), env("SAMSRF_CGG_RUNS_DIR")) else { return };
    let dir = cgg_intel_host(&root);
    let recorded = json(&dir.join("constants-direct.json"));
    let recorded = recorded["cases"].as_array().unwrap();
    let run: RawRun = gifti::read_run(&std::fs::read(runs_dir.join("lh_uBars1.gii")).unwrap()).unwrap();
    let donor = run.course(DONOR);
    let (mut index, mut values) = (0, 0);
    for (n, widths) in [(250usize, &[1usize, 2, 3, 5, 6, 7, 9, 10, 11, 12][..]), (3, &[5, 8]), (37, &[5, 8]), (2, &[1, 5]), (1, &[1])] {
        for kind in 1..=15 {
            for &v in widths {
                for j in 0..v {
                    let mut columns: Vec<Vec<f32>> = FILL[..v].iter().map(|&f| run.course(f)[..n].to_vec()).collect();
                    columns[j] = edited(kind, n, donor);
                    let case = &recorded[index];
                    let id = format!("direct_n{n}_k{kind:02}_V{v:02}_j{:02}", j + 1);
                    assert_eq!(case["id"], id.as_str());
                    assert_eq!(case["input"], f32_hash(&columns.concat()).as_str(), "{id}: regenerated input");
                    let mut d: Vec<f64> = columns[j].iter().map(|&value| f64::from(value)).collect();
                    if n < 2 { preprocess::detrend(&mut d) } else { Detrender::new(n, v).apply(&mut d, j) }
                    assert_eq!(bits(&array(&dir, &case["detrend"])), bits(&d), "{id}: detrend");
                    let mut z = d.clone();
                    preprocess::zscore(&mut z);
                    assert_eq!(bits(&array(&dir, &case["zscore"])), bits(&z), "{id}: zscore");
                    index += 1;
                    values += n;
                }
            }
        }
    }
    assert_eq!((index, values), (recorded.len(), 255_495), "direct cases");
}

/// Runs 1 and 2 truncated to `count` vertices with the recorder's edits (constants_gemv.rs).
fn edited_runs(runs: &[RawRun], count: usize, tail: &[usize]) -> Vec<RawRun> {
    let volumes = runs[0].volumes;
    let positions = (1999..2059).chain(count - tail.len()..count);
    let kinds: Vec<usize> = (0..60).map(|q| q / 4 + 1).chain(tail.iter().copied()).collect();
    runs.iter()
        .map(|run| {
            let donor = run.course(DONOR).to_vec();
            let mut data = run.data[..count * volumes].to_vec();
            for (vertex, &kind) in positions.clone().zip(&kinds) {
                data[vertex * volumes..(vertex + 1) * volumes].copy_from_slice(&edited(kind, volumes, &donor));
            }
            RawRun { volumes, vertices: count, data }
        })
        .collect()
}

/// `samsrf_gii2srf` on the two edited 134,257-134,260-vertex runs, double: every recorded
/// course on the Intel host (compared after the freeze).
#[test]
fn pipeline_courses_equal_matlab_on_the_intel_host() {
    let (Some(root), Some(runs_dir)) = (env("SAMSRF_CGG_DIR"), env("SAMSRF_CGG_RUNS_DIR")) else { return };
    let dir = cgg_intel_host(&root);
    let runs: Vec<RawRun> = (1..=2).map(|r| gifti::read_run(&std::fs::read(runs_dir.join(format!("lh_uBars{r}.gii"))).unwrap()).unwrap()).collect();
    let recorded = json(&dir.join("constants-pipeline.json"));
    let tails: [(usize, &[usize]); 4] = [(134_260, &[6, 2, 15, 9]), (134_257, &[6]), (134_258, &[2, 15]), (134_259, &[1, 12, 14])];
    let mut values = 0;
    for (count, tail) in tails {
        let case = recorded["cases"].as_array().unwrap().iter().find(|c| c["id"] == format!("pipeline_V{count}_double").as_str()).unwrap();
        let edited = edited_runs(&runs, count, tail);
        let inputs: Vec<String> = edited.iter().map(|run| f32_hash(&run.data)).collect();
        assert_eq!(case["inputs"], serde_json::json!(inputs), "V{count}: regenerated runs");
        let positions: Vec<usize> = case["positions"].as_array().unwrap().iter().map(|p| p.as_u64().unwrap() as usize - 1).collect();
        let courses = array(&dir, &case["courses"]);
        for (i, course) in preprocess_on_avx512(&edited, &positions, true).iter().enumerate() {
            assert_eq!(bits(&courses[i * 250..(i + 1) * 250]), bits(course), "V{count}: course of vertex {}", positions[i] + 1);
            values += 250;
        }
    }
    assert_eq!(values, 4 * 250 * (60 + 8) + 250 * (4 + 1 + 2 + 3), "pipeline course values");
}

/// The reverse-correlation recording's AVX512_E1 host.
fn revcor_intel_host(root: &Path) -> PathBuf {
    let hosts: Vec<PathBuf> = ["ubuntu-22.04", "ubuntu-24.04"]
        .iter()
        .map(|host| root.join(host))
        .filter(|dir| json(&dir.join("environment.json"))["observed"]["blas"].as_str().unwrap().contains("CNR branch AVX512_E1"))
        .collect();
    assert_eq!(hosts.len(), 1, "one AVX512_E1 host in the reverse-correlation recording");
    hosts[0].clone()
}

/// `samsrf_removenoise` of the double global-regression cases on the Intel host, from that
/// host's own courses and global signal (held out, frozen before reading).
#[test]
fn global_regression_equals_matlab_on_the_intel_host() {
    let Some(root) = env("SAMSRF_REVCOR_REFERENCE_DIR") else { return };
    let dir = revcor_intel_host(&root);
    let matrix = json(&dir.join("revcor-matrix.json"));
    let cases = matrix["cases"].as_array().unwrap();
    let (mut compared, mut values) = (0, 0);
    for case in cases.iter().filter(|c| c["kind"] == "pipeline" && c["analysis"] == "cf" && c["precision"] == "double" && c["id"].as_str().unwrap().ends_with("mode0_smooth0_global1")) {
        let id = case["id"].as_str().unwrap();
        let pre = cases.iter().find(|c| c["id"] == case["preprocessing"]).unwrap();
        let courses = array(&dir, &pre["courses"]);
        let volumes = pre["courses"]["shape"][0].as_u64().unwrap() as usize;
        let roi: Vec<usize> = array(&dir, &pre["roi"]).iter().map(|&v| v as usize - 1).collect();
        let mut series = TimeSeries::zeros(volumes, roi.len());
        for (i, &v) in roi.iter().enumerate() {
            series.course_mut(i).copy_from_slice(&courses[v * volumes..(v + 1) * volumes]);
        }
        mkl_avx512::remove_noise(&mut series, &array(&dir, &case["globalSignal"])).unwrap();
        let expected = array(&dir, &case["recomputedCorrectedCourses"]);
        for (i, &v) in roi.iter().enumerate() {
            assert_eq!(bits(&expected[v * volumes..(v + 1) * volumes]), bits(series.course(i)), "{id}: vertex {v}");
            values += volumes;
        }
        compared += 1;
    }
    assert_eq!((compared, values), (3, 42_000), "double global-regression cases");
}

/// The reverse-correlation matrix's double preprocessing from the raw runs on the Intel
/// host (compared after the freeze): every recorded course.
#[test]
fn raw_preprocessing_equals_matlab_on_the_intel_host() {
    let (Some(root), Some(input)) = (env("SAMSRF_REVCOR_REFERENCE_DIR"), env("SAMSRF_MATRIX_INPUT_DIR")) else { return };
    let dir = revcor_intel_host(&root);
    let matrix = json(&dir.join("revcor-matrix.json"));
    let manifest = json(&input.join("manifest.json"));
    let mut values = 0;
    let mut cases = 0;
    for pre in matrix["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "preprocess" && c["precision"] == "double") {
        let dataset = pre["dataset"].as_str().unwrap();
        let entry = manifest["datasets"].as_array().unwrap().iter().find(|d| d["id"] == dataset).unwrap();
        let runs: Vec<RawRun> = entry["runs"].as_array().unwrap().iter().map(|run| gifti::read_run(&std::fs::read(input.join(dataset).join(run.as_str().unwrap())).unwrap()).unwrap()).collect();
        let vertices: Vec<usize> = (0..runs[0].vertices).collect();
        let courses = array(&dir, &pre["courses"]);
        let preprocessed = preprocess_on_avx512(&runs, &vertices, pre["average"] == true);
        for (v, course) in preprocessed.iter().enumerate() {
            let length = course.len();
            assert_eq!(bits(&courses[v * length..(v + 1) * length]), bits(course), "{}: vertex {v}", pre["id"]);
            values += length;
        }
        // `nanmean(Srf.Data, 2)` vertex by vertex, as `preprocess` sums it, against the
        // global signal MATLAB regressed.
        let length = preprocessed[0].len();
        let (mut sum, mut count) = (vec![0.0f64; length], vec![0u32; length]);
        for course in &preprocessed {
            for (t, &value) in course.iter().enumerate().filter(|(_, value)| !value.is_nan()) {
                sum[t] += value;
                count[t] += 1;
            }
        }
        let global: Vec<f64> = sum.iter().zip(&count).map(|(s, c)| s / f64::from(*c)).collect();
        let regression = matrix["cases"].as_array().unwrap().iter().find(|c| c["preprocessing"] == pre["id"] && c["id"].as_str().unwrap().ends_with("mode0_smooth0_global1")).unwrap();
        assert_eq!(bits(&array(&dir, &regression["globalSignal"])), bits(&global), "{}: global signal", pre["id"]);
        cases += 1;
    }
    assert_eq!(cases, 3, "double preprocessing cases");
    println!("raw preprocessing on the Intel host: {values} values equal MATLAB's");
}

/// The SamSrfAnalysis recording's double `Srf.Y` on its Intel host (compared after the
/// freeze), with this branch's detrend: every run whose `Srf.Y` is the preprocessing output.
#[test]
fn preprocessed_courses_equal_matlab_on_the_intel_host() {
    let (Some(recording), Some(courses)) = (env("SAMSRF_CLI_REFERENCE_DIR"), env("SAMSRF_CLI_COURSES_DIR")) else { return };
    let manifest = json(&courses.join("manifest.json"));
    let plan = &manifest["plan"];
    let host = &manifest["hosts"]["intel"];
    assert!(host["cpu"].as_str().unwrap().to_uppercase().starts_with("INTEL"), "{}", host["cpu"]);
    let argument = |argv: &[Value], prefix: &str| argv.iter().filter_map(Value::as_str).find_map(|value| value.strip_prefix(prefix)).map(str::to_string);
    let (mut compared, mut runs_compared) = (0, 0);
    for entry in host["runs"].as_array().unwrap() {
        let run = plan["runs"].as_array().unwrap().iter().find(|run| run["id"] == entry["id"]).unwrap();
        let model = &run["model"];
        let later = model["Global_Signal_Correction"] == true || model["Smoothing"].as_f64().is_some_and(|value| value != 0.0);
        if later || run["precision"] != "double" {
            continue;
        }
        let id = run["id"].as_str().unwrap();
        let argv = run["argv"].as_array().unwrap();
        assert_eq!(argument(argv, "-norm=").as_deref(), Some("1"), "{id}: detrend and z-score");
        let average = match argument(argv, "-aver=").as_deref() {
            Some("1") => true,
            Some("0") => false,
            other => panic!("{id}: -aver={other:?}"),
        };
        let pattern = argv[2].as_str().unwrap().strip_prefix("/input/").unwrap();
        let (folder, name) = pattern.rsplit_once('/').unwrap();
        let (stem, suffix) = name.split_once('*').unwrap();
        let folder = recording.join("bundle").join(folder);
        let mut files: Vec<PathBuf> = std::fs::read_dir(&folder).unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                let file = path.file_name().unwrap().to_str().unwrap();
                file.starts_with(stem) && file.ends_with(suffix)
            })
            .collect();
        files.sort();
        let runs: Vec<RawRun> = files.iter().map(|path| gifti::read_run(&std::fs::read(path).unwrap()).unwrap()).collect();
        let roi: Vec<usize> = entry["roi"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize - 1).collect();
        let volumes = entry["volumes"].as_u64().unwrap() as usize;
        let bytes = std::fs::read(courses.join("intel").join(entry["file"].as_str().unwrap())).unwrap();
        let matlab: Vec<f64> = bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect();
        assert_eq!(matlab.len(), roi.len() * volumes, "{id}: values");
        let port: Vec<f64> = preprocess_on_avx512(&runs, &roi, average).concat();
        let same = identical(&port, &matlab);
        let first = port.iter().zip(&matlab).position(|(a, b)| a.to_bits() != b.to_bits());
        assert_eq!(same, matlab.len(), "{id}: first difference at {first:?}");
        compared += matlab.len();
        runs_compared += 1;
    }
    println!("SamSrfAnalysis double preprocessing on the Intel host: {runs_compared} runs, {compared} values equal MATLAB's");
    assert!(runs_compared > 0, "no double runs compared");
}

/// `norm(x)` (`dnrm2`) and `norm(z)` (`dznrm2`, over interleaved parts) of the 24 BLAS
/// vectors on both Intel hosts of the numerics recordings: each is the correctly rounded
/// norm (24 of 24 per host, where MKL's AMD order is correctly rounded for 14 real and 11
/// complex vectors). Discovery data for `nrm2`; no complex held-out set exists.
#[test]
fn numerics_norms_are_correctly_rounded_on_the_intel_hosts() {
    let mut hosts = 0;
    for variable in ["SAMSRF_MATLAB_NUMERICS_DIR", "SAMSRF_MATLAB_NUMERICS2_DIR"] {
        let Some(root) = env(variable) else { continue };
        for host in ["ubuntu-22.04", "ubuntu-24.04"] {
            let dir = root.join(host).join("compatible");
            let recording = json(&dir.join("numerics.json"));
            if !recording["environment"].to_string().contains("CNR branch AVX512_E1") {
                continue;
            }
            let mut cases = 0;
            for case in recording["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "blas") {
                let id = case["id"].as_str().unwrap();
                let x = array(&dir, &case["x"]);
                assert_eq!(array(&dir, &case["norm"])[0].to_bits(), mkl_avx512::nrm2(&x).to_bits(), "{variable} {host} {id}: norm(x)");
                let re = array(&dir, &case["z"]);
                let im = array(&dir, &serde_json::json!({ "file": case["z"]["imaginary"] }));
                let parts: Vec<f64> = re.iter().zip(&im).flat_map(|(&a, &b)| [a, b]).collect();
                assert_eq!(array(&dir, &case["complexNorm"])[0].to_bits(), mkl_avx512::nrm2(&parts).to_bits(), "{variable} {host} {id}: norm(z)");
                cases += 1;
            }
            assert_eq!(cases, 24, "{variable} {host}: BLAS cases");
            hosts += 1;
        }
    }
    if hosts > 0 {
        assert_eq!(hosts, 2, "one AVX512_E1 host per numerics recording");
    }
}

/// Writes the inputs `packages/samsrf/validation/matlab/intel-avx512/heldout_eval.py`
/// reads: the regenerated direct-case X matrices (n x V, column-major, double of the
/// single inputs, hash-checked against the recording) and each reverse-correlation double
/// global1 case's z-scored global signal. Runs only with SAMSRF_HELDOUT_DUMP.
#[test]
fn write_held_out_inputs() {
    let Some(out) = env("SAMSRF_HELDOUT_DUMP") else { return };
    let write = |path: &Path, values: &[f64]| std::fs::write(path, values.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    let mut index = Vec::new();
    if let (Some(root), Some(runs_dir)) = (env("SAMSRF_CGG_DIR"), env("SAMSRF_CGG_RUNS_DIR")) {
        let run: RawRun = gifti::read_run(&std::fs::read(runs_dir.join("lh_uBars1.gii")).unwrap()).unwrap();
        let recorded = json(&cgg_intel_host(&root).join("constants-direct.json"));
        let recorded = recorded["cases"].as_array().unwrap();
        let donor = run.course(DONOR);
        let dir = out.join("h3");
        std::fs::create_dir_all(&dir).unwrap();
        let mut i = 0;
        for (n, widths) in [(250usize, &[1usize, 2, 3, 5, 6, 7, 9, 10, 11, 12][..]), (3, &[5, 8]), (37, &[5, 8]), (2, &[1, 5]), (1, &[1])] {
            for kind in 1..=15 {
                for &v in widths {
                    for j in 0..v {
                        let mut columns: Vec<Vec<f32>> = FILL[..v].iter().map(|&f| run.course(f)[..n].to_vec()).collect();
                        columns[j] = edited(kind, n, donor);
                        let id = format!("direct_n{n}_k{kind:02}_V{v:02}_j{:02}", j + 1);
                        assert_eq!(recorded[i]["id"], id.as_str());
                        assert_eq!(recorded[i]["input"], f32_hash(&columns.concat()).as_str(), "{id}: regenerated input");
                        let x: Vec<f64> = columns.concat().iter().map(|&value| f64::from(value)).collect();
                        write(&dir.join(format!("{id}.f64")), &x);
                        index.push(serde_json::json!({ "set": "h3", "id": id, "n": n, "V": v, "j": j, "file": format!("h3/{id}.f64") }));
                        i += 1;
                    }
                }
            }
        }
    }
    if let Some(root) = env("SAMSRF_REVCOR_REFERENCE_DIR") {
        for host in ["ubuntu-22.04", "ubuntu-24.04"] {
            let dir = root.join(host);
            let matrix = json(&dir.join("revcor-matrix.json"));
            let target = out.join("h4").join(host);
            std::fs::create_dir_all(&target).unwrap();
            for case in matrix["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "pipeline" && c["analysis"] == "cf" && c["precision"] == "double" && c["id"].as_str().unwrap().ends_with("mode0_smooth0_global1")) {
                let mut x = array(&dir, &case["globalSignal"]);
                preprocess::zscore(&mut x);
                let id = case["id"].as_str().unwrap();
                write(&target.join(format!("{id}_x.f64")), &x);
                index.push(serde_json::json!({ "set": "h4", "host": host, "id": id, "preprocessing": case["preprocessing"], "x": format!("h4/{host}/{id}_x.f64") }));
            }
        }
    }
    std::fs::write(out.join("index.json"), serde_json::to_string_pretty(&index).unwrap()).unwrap();
}
