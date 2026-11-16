//! Held-out probes pre-registered in
//! `packages/samsrf/validation/matlab/constants-gamma-gemv-predictions.md` and
//! recorded by `record_constants_gamma_gemv.m`: (A) constant, linear and
//! near-constant courses through MATLAB's `detrend`/`zscore` and `samsrf_gii2srf`;
//! (C) the summation order of double `y' * A`. Section B (gampdf) is in
//! `src/held_out_gamma.rs`, beside the private functions its candidate uses.
//!
//! `SAMSRF_CGG_RUNS_DIR` holds the pinned `lh_uBars1.gii` and `lh_uBars2.gii`
//! (`apps/samsrf/examples.json`). With `SAMSRF_CGG_PREDICT` set, the models'
//! predictions for section A and the FPRev counts for section C are written there
//! before any recording exists. With `SAMSRF_CGG_DIR` (the recording, one folder per
//! host), every regenerated input must equal MATLAB's and each model is compared.
use samsrf_core::gifti;
use samsrf_core::matlab_math as m;
use samsrf_core::precision::Precision;
use samsrf_core::preprocess::{self, Combine, Detrender, Normalise, PreprocessOptions, RunAccumulator};
use samsrf_core::timeseries::{RawRun, VertexSelection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const HOSTS: [&str; 2] = ["ubuntu-22.04", "ubuntu-24.04"];
/// 0-based twins of the recorder's 1-based `fill` vertices.
const FILL: [usize; 12] = [6378, 6355, 7141, 6356, 49922, 6377, 6335, 4953, 10018, 10879, 24935, 54069];
const DONOR: usize = 6378;
const KINDS: usize = 15;
const MODELS: [&str; 3] = ["M1 port", "M0 main", "M2 constants zero"];

fn env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn sha(bytes: impl IntoIterator<Item = u8>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes.into_iter().collect::<Vec<u8>>());
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn f32_hash(values: &[f32]) -> String {
    sha(values.iter().flat_map(|v| v.to_le_bytes()))
}

fn f64_hash(values: &[f64]) -> String {
    sha(values.iter().flat_map(|v| v.to_le_bytes()))
}

/// The recorder's `edited(kind, n, donor)`, in single arithmetic.
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

fn is_constant(course: &[f32]) -> bool {
    course.iter().all(|&v| v == course[0])
}

/// `main`'s detrend before #868: the normal equations on centred time.
fn detrend_main(x: &mut [f64]) {
    let n = x.len();
    let intercept = x.iter().sum::<f64>() / n as f64;
    let centre = (n as f64 + 1.0) / 2.0;
    let (mut cross, mut squares) = (0.0, 0.0);
    for (i, &value) in x.iter().enumerate() {
        let tc = (i + 1) as f64 - centre;
        cross += tc * value;
        squares += tc * tc;
    }
    let slope = if n > 1 { cross / squares } else { 0.0 };
    for (i, value) in x.iter_mut().enumerate() {
        *value -= intercept + slope * ((i + 1) as f64 - centre);
    }
}

fn zscore_main(x: &mut [f64]) {
    let n = x.len();
    let mu = x.iter().sum::<f64>() / n as f64;
    let squares: f64 = x.iter().map(|v| (v - mu) * (v - mu)).sum();
    let sigma = if n > 1 { (squares / (n - 1) as f64).sqrt() } else { 0.0 };
    let sigma = if sigma == 0.0 { 1.0 } else { sigma };
    for v in x.iter_mut() {
        *v = (*v - mu) / sigma;
    }
}

fn correlation_main(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len() as f64;
    let (mx, my) = (x.iter().sum::<f64>() / n, y.iter().sum::<f64>() / n);
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for (&a, &b) in x.iter().zip(y) {
        sxy += (a - mx) * (b - my);
        sxx += (a - mx) * (a - mx);
        syy += (b - my) * (b - my);
    }
    sxy / (sxx * syy).sqrt()
}

/// One course detrended (`D`) and z-scored (`Z`) by `model`, as vertex `index` of
/// `count` in a `\` over the whole run.
fn normalised(model: usize, raw: &[f32], count: usize, index: usize) -> (Vec<f64>, Vec<f64>) {
    let mut d: Vec<f64> = raw.iter().map(|&v| f64::from(v)).collect();
    match model {
        1 => detrend_main(&mut d),
        2 if is_constant(raw) => d.fill(0.0),
        _ if d.len() < 2 => preprocess::detrend(&mut d),
        _ => Detrender::new(d.len(), count).apply(&mut d, index),
    }
    let mut z = d.clone();
    if model == 1 { zscore_main(&mut z) } else { preprocess::zscore(&mut z) }
    (d, z)
}

fn read_runs(dir: &Path) -> Vec<RawRun> {
    (1..=2).map(|r| gifti::read_run(&std::fs::read(dir.join(format!("lh_uBars{r}.gii"))).unwrap()).unwrap()).collect()
}

/// Runs 1 and 2 truncated to `count` vertices with the recorder's edits.
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

struct Direct {
    id: String,
    kind: usize,
    input: String,
    /// Per model: the detrended then the z-scored course.
    models: Vec<(Vec<f64>, Vec<f64>)>,
}

fn direct_cases(run: &RawRun) -> Vec<Direct> {
    let donor = run.course(DONOR);
    let mut cases = Vec::new();
    for (n, widths) in [(250, &[1, 2, 3, 5, 6, 7, 9, 10, 11, 12][..]), (3, &[5, 8]), (37, &[5, 8]), (2, &[1, 5]), (1, &[1])] {
        for kind in 1..=KINDS {
            for &v in widths {
                for j in 0..v {
                    let mut columns: Vec<Vec<f32>> = FILL[..v].iter().map(|&f| run.course(f)[..n].to_vec()).collect();
                    columns[j] = edited(kind, n, donor);
                    let input = f32_hash(&columns.concat());
                    let models = (0..MODELS.len()).map(|model| normalised(model, &columns[j], v, j)).collect();
                    cases.push(Direct { id: format!("direct_n{n}_k{kind:02}_V{v:02}_j{:02}", j + 1), kind, input, models });
                }
            }
        }
    }
    cases
}

const COUNTS: [usize; 4] = [134_260, 134_257, 134_258, 134_259];
const TAILS: [&[usize]; 4] = [&[6, 2, 15, 9], &[6], &[2, 15], &[1, 12, 14]];

struct Pipeline {
    id: String,
    vertices: usize,
    single: bool,
    positions: Vec<usize>,
    kinds: Vec<usize>,
    inputs: Vec<String>,
    /// Per model: courses (volumes x positions, column-major) and noise ceilings.
    models: Vec<(Vec<f64>, Vec<f64>)>,
    global: Vec<f64>,
}

fn pipeline_cases(runs: &[RawRun]) -> Vec<Pipeline> {
    let grouped: Vec<usize> = (1999..2059).collect();
    let controls = [6378, 6355, 0, 1, 2, 3, 2060, 2061];
    let mut cases = Vec::new();
    for (&count, &tail) in COUNTS.iter().zip(&TAILS) {
        let last: Vec<usize> = (count - tail.len()..count).collect();
        let kinds: Vec<usize> = (0..60).map(|q| q / 4 + 1).chain(tail.iter().copied()).collect();
        let positions: Vec<usize> = grouped.iter().chain(&last).chain(&controls).copied().collect();
        let edited_runs = edited_runs(runs, count, tail);
        let inputs = edited_runs.iter().map(|run| f32_hash(&run.data)).collect::<Vec<_>>();
        for single in [false, true] {
            let precision = if single { Precision::Single } else { Precision::Double };
            let round = |v: f64| if single { f64::from(v as f32) } else { v };
            let options = PreprocessOptions {
                normalise: Normalise::DetrendZscore,
                combine: Combine::Average { noise_ceiling: true },
                global_signal: true,
                precision,
            };
            let mut accumulator = RunAccumulator::new(count, VertexSelection::from_indices(positions.iter().map(|&p| p as u32).collect()), options);
            for run in &edited_runs {
                accumulator.push_run(run).unwrap();
            }
            let port = accumulator.finish().unwrap();
            let mut sorted = positions.clone();
            sorted.sort_unstable();
            let slot = |p: usize| sorted.binary_search(&p).unwrap();
            let ceiling = port.noise_ceiling.as_ref().unwrap();
            let mut models = vec![(
                positions.iter().flat_map(|&p| port.data.course(slot(p)).iter().map(|&v| round(v)).collect::<Vec<_>>()).collect::<Vec<_>>(),
                positions.iter().map(|&p| round(ceiling[slot(p)])).collect::<Vec<_>>(),
            )];
            for model in 1..MODELS.len() {
                let mut courses = Vec::new();
                let mut ceilings = Vec::new();
                for &p in &positions {
                    let per_run: Vec<Vec<f64>> = edited_runs.iter().map(|run| normalised(model, run.course(p), count, p).1).collect();
                    courses.extend(per_run[0].iter().zip(&per_run[1]).map(|(a, b)| round((a + b) / 2.0)));
                    let rho = if model == 1 { correlation_main(&per_run[0], &per_run[1]) } else { f64::NAN };
                    ceilings.push(round(if model == 1 {
                        (2.0 * rho) / (1.0 + rho)
                    } else {
                        preprocess::noise_ceiling(&per_run[0], &per_run[1])
                    }));
                }
                models.push((courses, ceilings));
            }
            let global = port.global_signal.unwrap().into_iter().map(round).collect();
            cases.push(Pipeline {
                id: format!("pipeline_V{count}_{}", if single { "single" } else { "double" }),
                vertices: count,
                single,
                positions: positions.iter().map(|p| p + 1).collect(),
                kinds: kinds.clone(),
                inputs: inputs.clone(),
                models,
                global,
            });
        }
    }
    cases
}

// ---- section C: double y' * A -------------------------------------------------------

/// A per-column summation of `y' * A`, given the column index and column count.
type Gemv = fn(&[f64], &[f64], usize, usize) -> f64;

/// Lane 0 starts at element 0, elements `1..=lanes * k` go to lane `(i - 1) % lanes`,
/// eight lanes fold to four, four reduce as `(L0 + L2) + (L1 + L3)`, two as `L0 + L1`,
/// then the remaining elements in order (the single model's form).
fn lanes(y: &[f64], a: &[f64], lanes: usize, fold: bool) -> f64 {
    let n = y.len();
    let mut lane = [0.0f64; 8];
    lane[0] = y[0] * a[0];
    let body = (n - 1) / lanes * lanes;
    for i in 1..=body {
        lane[(i - 1) % lanes] += y[i] * a[i];
    }
    let mut sum = match lanes {
        8 if fold => {
            for l in 0..4 {
                lane[l] += lane[l + 4];
            }
            (lane[0] + lane[2]) + (lane[1] + lane[3])
        }
        8 => lane.iter().skip(1).fold(lane[0], |s, v| s + v),
        4 => (lane[0] + lane[2]) + (lane[1] + lane[3]),
        2 => lane[0] + lane[1],
        _ => lane[0],
    };
    for i in body + 1..n {
        sum += y[i] * a[i];
    }
    sum
}

/// Production's double `y' * A` (`lstsq::gemv_t_double`), one column of `m`: the
/// model read from this recording's n = 250 fingerprints (an amendment after run
/// 43882331042), gated on the held-out shapes and products.
fn production(y: &[f64], a: &[f64], j: usize, m: usize) -> f64 {
    let zero = vec![0.0; y.len()];
    let columns: Vec<&[f64]> = (0..m).map(|k| if k == j { a } else { &zero[..] }).collect();
    samsrf_core::lstsq::gemv_t_double(y, &columns)[j]
}

fn full_block(y: &[f64], a: &[f64]) -> f64 {
    lanes(y, a, 2, false)
}

/// The frozen models: full blocks of four columns use two lanes (identified on the
/// pinned double CF profiles, 1,728 + 304 values); the remaining columns use one of
/// the listed alternatives. `port` is production's double CF dot today.
const GEMV_MODELS: [(&str, Gemv); 10] = [
    ("production lstsq::gemv_t_double", production),
    ("leftover in order", |y, a, j, m| if j < m / 4 * 4 { full_block(y, a) } else { lanes(y, a, 1, false) }),
    ("leftover 2 lanes", |y, a, j, m| if j < m / 4 * 4 { full_block(y, a) } else { lanes(y, a, 2, false) }),
    ("leftover 4 lanes", |y, a, j, m| if j < m / 4 * 4 { full_block(y, a) } else { lanes(y, a, 4, false) }),
    ("leftover 8 lanes folded", |y, a, j, m| if j < m / 4 * 4 { full_block(y, a) } else { lanes(y, a, 8, true) }),
    ("leftover 8 lanes in order", |y, a, j, m| if j < m / 4 * 4 { full_block(y, a) } else { lanes(y, a, 8, false) }),
    ("leftover ddot_mkl", |y, a, j, m| if j < m / 4 * 4 { full_block(y, a) } else { m::ddot_mkl(y, a) }),
    ("leftover ddot_pairs", |y, a, j, m| if j < m / 4 * 4 { full_block(y, a) } else { m::ddot_pairs(y, a) }),
    ("leftover ddot", |y, a, j, m| if j < m / 4 * 4 { full_block(y, a) } else { m::ddot(y, a) }),
    ("every column ddot", |y, a, _, _| m::ddot(y, a)),
];

const GEMV_SHAPES: [(usize, usize); 9] = [(250, 5), (250, 6), (250, 7), (250, 3), (250, 8), (61, 7), (128, 6), (97, 5), (17, 3)];
const BIG: f64 = 1_180_591_620_717_411_303_424.0; // 2^70

/// `nchoosek(1:n, 2)` order, 0-based.
fn pairs(n: usize) -> Vec<(usize, usize)> {
    (0..n).flat_map(|i| (i + 1..n).map(move |k| (i, k))).collect()
}

fn fprev_counts(model: Gemv, n: usize, m: usize) -> Vec<f64> {
    let y = vec![1.0; n];
    let pairs = pairs(n);
    let mut counts = vec![0.0; pairs.len() * m];
    for (p, &(i, k)) in pairs.iter().enumerate() {
        let mut a = vec![1.0; n];
        a[i] = BIG;
        a[k] = -BIG;
        for j in 0..m {
            counts[j * pairs.len() + p] = model(&y, &a, j, m);
        }
    }
    counts
}

#[test]
fn predictions_are_written_before_the_recording() {
    let (Some(out), Some(runs_dir)) = (env("SAMSRF_CGG_PREDICT"), env("SAMSRF_CGG_RUNS_DIR")) else { return };
    std::fs::create_dir_all(&out).unwrap();
    let runs = read_runs(&runs_dir);
    let mut summary = BTreeMap::new();
    let direct = direct_cases(&runs[0]);
    let mut disagreements = BTreeMap::<String, [usize; 3]>::new();
    for case in &direct {
        let model = |i: usize| [case.models[i].0.clone(), case.models[i].1.clone()].concat();
        let reference = model(0);
        for (i, name) in MODELS.iter().enumerate().skip(1) {
            let differ = model(i).iter().zip(&reference).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
            let entry = disagreements.entry(format!("{name} vs {}", MODELS[0])).or_default();
            entry[0] += usize::from(differ > 0);
            entry[1] += differ;
            entry[2] += reference.len();
        }
    }
    summary.insert("direct", json!({
        "cases": direct.len(),
        "modelHashes": MODELS.iter().enumerate().map(|(i, name)| (name.to_string(), f64_hash(&direct.iter().flat_map(|c| [c.models[i].0.clone(), c.models[i].1.clone()].concat()).collect::<Vec<_>>()))).collect::<BTreeMap<_, _>>(),
        "inputHash": sha(direct.iter().flat_map(|c| c.input.bytes().collect::<Vec<_>>())),
        "disagreements (cases, values, of values)": disagreements,
    }));
    let pipeline = pipeline_cases(&runs);
    summary.insert("pipeline", json!(pipeline.iter().map(|case| json!({
        "id": case.id,
        "inputs": case.inputs,
        "globalSignal": f64_hash(&case.global),
        "models": MODELS.iter().enumerate().map(|(i, name)| (name.to_string(), json!({
            "courses": f64_hash(&case.models[i].0),
            "noiseCeiling": f64_hash(&case.models[i].1),
            "differFromM1 (courses, ceilings)": [
                case.models[i].0.iter().zip(&case.models[0].0).filter(|(a, b)| a.to_bits() != b.to_bits()).count(),
                case.models[i].1.iter().zip(&case.models[0].1).filter(|(a, b)| a.to_bits() != b.to_bits()).count(),
            ],
        }))).collect::<BTreeMap<_, _>>(),
    })).collect::<Vec<_>>()));
    summary.insert("gemv", json!(GEMV_SHAPES.iter().map(|&(n, m)| json!({
        "id": format!("gemv_n{n}_m{m}"),
        "models": GEMV_MODELS.iter().map(|(name, f)| (name.to_string(), f64_hash(&fprev_counts(*f, n, m)))).collect::<BTreeMap<_, _>>(),
    })).collect::<Vec<_>>()));
    std::fs::write(out.join("predictions.json"), serde_json::to_string_pretty(&summary).unwrap()).unwrap();
}

// ---- gate -----------------------------------------------------------------------------

fn recorded(dir: &Path, descriptor: &Value, shape: &[usize]) -> Vec<f64> {
    let found: Vec<usize> = descriptor["shape"].as_array().unwrap().iter().map(|d| d.as_u64().unwrap() as usize).collect();
    assert_eq!(found, shape, "{}", descriptor["file"]);
    assert_eq!(descriptor["imaginary"], "", "{}", descriptor["file"]);
    let bytes = std::fs::read(dir.join(descriptor["file"].as_str().unwrap())).unwrap();
    assert_eq!(bytes.len(), 8 * shape.iter().product::<usize>(), "{}", descriptor["file"]);
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn same(a: &[f64], b: &[f64]) -> usize {
    a.iter().zip(b).filter(|(x, y)| x.to_bits() == y.to_bits()).count()
}

fn cases(dir: &Path, file: &str) -> Vec<Value> {
    let value: Value = serde_json::from_slice(&std::fs::read(dir.join(file)).unwrap()).unwrap();
    value["cases"].as_array().unwrap().clone()
}

fn fixture_roots(recording: Option<PathBuf>, runs: Option<PathBuf>) -> Option<(PathBuf, PathBuf)> {
    match (recording, runs) {
        (None, None) => None,
        (Some(recording), Some(runs)) => Some((recording, runs)),
        _ => panic!("set both SAMSRF_CGG_DIR and SAMSRF_CGG_RUNS_DIR"),
    }
}

#[test]
fn refuses_partial_fixture_configuration() {
    assert_eq!(fixture_roots(None, None), None);
    assert_eq!(fixture_roots(Some("recording".into()), Some("runs".into())), Some(("recording".into(), "runs".into())));
    assert!(std::panic::catch_unwind(|| fixture_roots(Some("recording".into()), None)).is_err());
    assert!(std::panic::catch_unwind(|| fixture_roots(None, Some("runs".into()))).is_err());
}

#[test]
fn constants_and_gemv_against_the_recording() {
    let Some((root, runs_dir)) = fixture_roots(env("SAMSRF_CGG_DIR"), env("SAMSRF_CGG_RUNS_DIR")) else { return };
    let runs = read_runs(&runs_dir);
    let direct = direct_cases(&runs[0]);
    let pipeline = pipeline_cases(&runs);
    let mut report = BTreeMap::new();
    let mut amd_hosts = 0;
    for host in HOSTS {
        let dir = root.join(host);
        let environment: Value = serde_json::from_slice(&std::fs::read(dir.join("constants-direct.json")).unwrap()).unwrap();
        let cpu = environment["environment"]["cpu"].as_str().unwrap().lines().find(|l| l.trim_start().starts_with("Model name")).unwrap_or("").trim().to_string();
        let mut tallies = BTreeMap::<String, [usize; 2]>::new();
        let mut global_error = BTreeMap::<String, f64>::new();
        let recorded_direct = cases(&dir, "constants-direct.json");
        assert_eq!(recorded_direct.len(), direct.len(), "{host}: direct inventory");
        for (case, port) in recorded_direct.iter().zip(&direct) {
            assert_eq!(case["id"], port.id.as_str(), "{host}: direct order");
            assert_eq!(case["input"], port.input.as_str(), "{host} {}: input", port.id);
            let n = case["n"].as_u64().unwrap() as usize;
            let d = recorded(&dir, &case["detrend"], &[n, 1]);
            let z = recorded(&dir, &case["zscore"], &[n, 1]);
            let constant = (1..=8).contains(&port.kind) || port.kind == 15;
            for (i, name) in MODELS.iter().enumerate() {
                for (stage, mine, theirs) in [("detrend", &port.models[i].0, &d), ("zscore", &port.models[i].1, &z)] {
                    let group = format!("direct {stage} {} {name}", if constant { "constant" } else { "other" });
                    let entry = tallies.entry(group).or_default();
                    entry[0] += same(mine, theirs);
                    entry[1] += n;
                }
            }
        }
        let recorded_pipeline = cases(&dir, "constants-pipeline.json");
        assert_eq!(recorded_pipeline.len(), pipeline.len(), "{host}: pipeline inventory");
        for (case, port) in recorded_pipeline.iter().zip(&pipeline) {
            assert_eq!(case["id"], port.id.as_str(), "{host}: pipeline order");
            assert_eq!(case["vertices"], port.vertices, "{host} {}", port.id);
            assert_eq!(case["precision"], if port.single { "single" } else { "double" });
            assert_eq!(case["inputs"], json!(port.inputs), "{host} {}: inputs", port.id);
            assert_eq!(case["positions"], json!(port.positions), "{host} {}: positions", port.id);
            assert_eq!(case["kinds"], json!(port.kinds), "{host} {}: kinds", port.id);
            let count = port.positions.len();
            let courses = recorded(&dir, &case["courses"], &[250, count]);
            let ceiling = recorded(&dir, &case["noiseCeiling"], &[1, count]);
            let global = recorded(&dir, &case["globalSignal"], &[250, 1]);
            for (i, name) in MODELS.iter().enumerate() {
                for (part, mine, theirs) in [("courses", &port.models[i].0, &courses), ("noise ceiling", &port.models[i].1, &ceiling)] {
                    let entry = tallies.entry(format!("pipeline {part} {name}")).or_default();
                    entry[0] += same(mine, theirs);
                    entry[1] += mine.len();
                }
            }
            let entry = tallies.entry("pipeline global signal M1 port".into()).or_default();
            entry[0] += same(&port.global, &global);
            entry[1] += 250;
            let relative = port.global.iter().zip(&global).map(|(a, b)| ((a - b) / b).abs()).fold(0.0, f64::max);
            global_error.insert(port.id.clone(), relative);
        }
        let recorded_gemv = cases(&dir, "gemv.json");
        assert_eq!(recorded_gemv.len(), GEMV_SHAPES.len(), "{host}: gemv inventory");
        for (case, &(n, mm)) in recorded_gemv.iter().zip(&GEMV_SHAPES) {
            assert_eq!(case["id"], format!("gemv_n{n}_m{mm}").as_str());
            let p = pairs(n).len();
            let counts = recorded(&dir, &case["counts"], &[p, mm]);
            let ys = recorded(&dir, &case["ys"], &[n, 100]);
            let a_s = recorded(&dir, &case["As"], &[n, mm * 100]);
            let products = recorded(&dir, &case["products"], &[100, mm]);
            let recorded_pairs = recorded(&dir, &case["pairs"], &[p, 2]);
            assert!(pairs(n).iter().enumerate().all(|(i, &(a, b))| recorded_pairs[i] == (a + 1) as f64 && recorded_pairs[p + i] == (b + 1) as f64));
            for (name, f) in GEMV_MODELS {
                let fprev = fprev_counts(f, n, mm);
                for j in 0..mm {
                    let leftover = j >= mm / 4 * 4;
                    let column = |v: &[f64]| v[j * p..(j + 1) * p].to_vec();
                    let entry = tallies.entry(format!("gemv fprev {} {name}", if leftover { "leftover" } else { "full" })).or_default();
                    entry[0] += usize::from(column(&fprev) == column(&counts));
                    entry[1] += 1;
                    for d in 0..100 {
                        let y = &ys[d * n..(d + 1) * n];
                        let a = &a_s[(d * mm + j) * n..(d * mm + j + 1) * n];
                        let half = if d < 50 { "discovery" } else { "held-out" };
                        let entry = tallies.entry(format!("gemv random {half} {} {name}", if leftover { "leftover" } else { "full" })).or_default();
                        entry[0] += usize::from(f(y, a, j, mm).to_bits() == products[j * 100 + d].to_bits());
                        entry[1] += 1;
                    }
                }
            }
        }
        let blas = environment["environment"]["observed"]["blas"].as_str().unwrap_or("");
        if cpu.contains("AMD") && blas.contains("CNR branch auto") {
            amd_hosts += 1;
            require_amd_outcome(host, &tallies);
        }
        report.insert(host, json!({ "cpu": cpu, "blas": blas, "tallies": tallies, "globalSignalMaxRelativeError": global_error }));
    }
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    if let Some(out) = env("SAMSRF_CGG_REPORT") {
        std::fs::write(out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    }
    // Run 43882331042: an AMD EPYC 9V74 (CNR auto) and an Intel Xeon 6975P-C
    // (AVX512_E1, reported only: its MKL solves double `\` and `y' * A` in other orders).
    assert_eq!(amd_hosts, 1, "the pinned recording has one AMD host with MKL's auto branch");
}

/// The outcome on an AMD host, decided by the pre-registered rules.
fn require_amd_outcome(host: &str, tallies: &BTreeMap<String, [usize; 2]>) {
    let count = |key: &str| tallies.get(key).copied().unwrap_or_else(|| panic!("{host}: no tally {key}"));
    let exact = |key: &str| {
        let [same, total] = count(key);
        assert!(total > 0 && same == total, "{host}: {key} {same}/{total}");
    };
    let misses = |key: &str| {
        let [same, total] = count(key);
        assert!(same < total, "{host}: {key} should not reproduce the recording ({same}/{total})");
    };
    // A: #868's port is MATLAB's, constants and single samples included; the
    // alternatives are not.
    for stage in ["detrend", "zscore"] {
        for group in ["constant", "other"] {
            exact(&format!("direct {stage} {group} M1 port"));
        }
        misses(&format!("direct {stage} constant M0 main"));
        misses(&format!("direct {stage} constant M2 constants zero"));
    }
    for part in ["courses", "noise ceiling"] {
        exact(&format!("pipeline {part} M1 port"));
        misses(&format!("pipeline {part} M0 main"));
        misses(&format!("pipeline {part} M2 constants zero"));
    }
    assert_eq!(count("direct detrend constant M1 port")[1] + count("direct detrend other M1 port")[1], 255_495);
    assert_eq!(count("pipeline courses M1 port"), [141_000, 141_000]);
    assert_eq!(count("pipeline noise ceiling M1 port"), [564, 564]);
    // The across-vertex nanmean is not MATLAB's order (README: global signal).
    assert_eq!(count("pipeline global signal M1 port"), [15, 2_000], "{host}: global signal");
    // C: production's y' * A is MATLAB's on every fingerprint and random product;
    // no frozen alternative reproduces the remaining columns.
    for part in ["fprev full", "fprev leftover", "random discovery full", "random discovery leftover", "random held-out full", "random held-out leftover"] {
        exact(&format!("gemv {part} production lstsq::gemv_t_double"));
    }
    for (name, _) in GEMV_MODELS.iter().skip(1) {
        misses(&format!("gemv fprev leftover {name}"));
    }
}
