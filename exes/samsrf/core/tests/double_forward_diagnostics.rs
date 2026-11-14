//! Gate for the nine double forward (non-CSS) pipelines of the 741-case
//! reference, which `compare.mjs` does not compare. Needs
//! SAMSRF_MATLAB_REFERENCE_DIR (the `reference.json` pin);
//! SAMSRF_DOUBLE_FORWARD_REPORT writes per-case and per-vertex evidence as JSON.
//!
//! Until the double non-CSS objective followed MATLAB's `conv` and `corr`
//! operation orders, 14 case/vertex entries of these fine fits differed (8 on
//! near-flat plateaus, 5 kept on one side and rejected on the other, 1 at another
//! optimum; `HISTORICAL` below, validation/matlab/README.md#double-forward-fine-fits-730).
//! This gate now requires, at every vertex of every case:
//! - x0, y0, Sigma and the noise ceiling with MATLAB's bits, so every keep/reject
//!   decision is MATLAB's; with fine fits also R^2 and nR^2 (`exact`);
//! - every map's zero and NaN masks equal to MATLAB's;
//! - every other finite map within 1e-12 * max(1, abs(MATLAB value)): Beta and
//!   Baseline, which the export still computes with plain sums, and the coarse
//!   fit's R^2 and nR^2. This is a ceiling for these recordings, not a general
//!   error bound.
//!
//! It does not count differing vertices: a map is either exact everywhere or held
//! to the ceiling everywhere.
use samsrf_core::{css, expr::AnonymousFunction, hrf, job, mat, model, prf, precision::Precision, timeseries::TimeSeries};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The nine pipelines and their vertex counts.
const CASES: [(&str, usize); 9] = [
    ("pipeline_double_x001_lh_average1_coarse1", 96),
    ("pipeline_double_x001_lh_average1_coarse0", 96),
    ("pipeline_double_thresholds", 96),
    ("pipeline_double_x001_lh_average0_coarse1", 96),
    ("pipeline_double_x001_lh_average0_coarse0", 96),
    ("pipeline_double_x001_rh_average1_coarse1", 76),
    ("pipeline_double_x001_rh_average1_coarse0", 76),
    ("pipeline_double_analyzeprf_lh_average0_coarse1", 10),
    ("pipeline_double_analyzeprf_lh_average0_coarse0", 10),
];

/// Whether every value of a map has MATLAB's bits: the parameters and the noise
/// ceiling always, and R^2 and nR^2 when the fine fit computes them (1 - its
/// objective).
fn exact(name: &str, fine: bool) -> bool {
    matches!(name, "x0" | "y0" | "Sigma" | "Noise Ceiling") || (fine && matches!(name, "R^2" | "nR^2"))
}

/// The (case, zero-based fixture vertex, class) entries that differed before the
/// objective followed MATLAB's operation order. Each must now be exact.
const HISTORICAL: [(&str, usize, &str); 14] = [
    ("pipeline_double_x001_lh_average1_coarse0", 2, "acceptance"),
    ("pipeline_double_x001_lh_average1_coarse0", 4, "plateau"),
    ("pipeline_double_thresholds", 2, "acceptance"),
    ("pipeline_double_thresholds", 4, "plateau"),
    ("pipeline_double_x001_lh_average0_coarse0", 2, "plateau"),
    ("pipeline_double_x001_lh_average0_coarse0", 4, "plateau"),
    ("pipeline_double_x001_lh_average0_coarse0", 23, "plateau"),
    ("pipeline_double_x001_lh_average0_coarse0", 81, "acceptance"),
    ("pipeline_double_x001_rh_average1_coarse0", 17, "plateau"),
    ("pipeline_double_x001_rh_average1_coarse0", 29, "acceptance"),
    ("pipeline_double_x001_rh_average1_coarse0", 46, "plateau"),
    ("pipeline_double_x001_rh_average1_coarse0", 58, "acceptance"),
    ("pipeline_double_x001_rh_average1_coarse0", 75, "optimum"),
    ("pipeline_double_analyzeprf_lh_average0_coarse0", 6, "plateau"),
];

fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name);
    let bytes = std::fs::read(root.join(name)).unwrap();
    let count: usize = descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).product();
    assert_eq!(bytes.len(), count * 8, "{name}");
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

/// One map value against MATLAB's: bit equality for exact maps, else the same
/// zero and NaN masks and the rounding ceiling.
fn assert_map(exact: bool, actual: f64, expected: f64, context: &str) {
    if exact {
        assert_eq!(actual.to_bits(), expected.to_bits(), "{context}: {actual} is not MATLAB's {expected}");
        return;
    }
    assert_eq!((actual == 0.0, actual.is_nan()), (expected == 0.0, expected.is_nan()), "{context}: zero/NaN mask");
    if expected.is_nan() {
        return;
    }
    assert!(actual.is_finite() && expected.is_finite(), "{context}: nonfinite map");
    let limit = 1e-12 * expected.abs().max(1.0);
    assert!((actual - expected).abs() <= limit, "{context}: map differs beyond rounding ceiling: {actual} vs {expected}, limit {limit}");
}

#[test]
fn map_checks_reject_wrong_values_and_masks() {
    assert!(exact("x0", false) && exact("Noise Ceiling", false) && exact("R^2", true) && exact("nR^2", true));
    assert!(!exact("R^2", false) && !exact("Beta", true) && !exact("Baseline", true));
    assert_map(false, 1.0 + f64::EPSILON, 1.0, "Beta");
    assert_map(false, f64::NAN, f64::NAN, "rejected");
    assert_map(true, 0.25, 0.25, "x0");
    assert_map(true, f64::NAN, f64::NAN, "x0");
    for (exact, actual, expected) in [
        (false, 1.0, 1e6),
        (false, 2.0, 3.0),
        (false, 0.0, 1e-15),
        (false, f64::NAN, 1.0),
        (false, f64::INFINITY, f64::INFINITY),
        (true, 1.0 + f64::EPSILON, 1.0),
        (true, 0.0, -0.0),
        (true, 0.5, f64::NAN),
    ] {
        assert!(std::panic::catch_unwind(|| assert_map(exact, actual, expected, "mutated map")).is_err(), "{exact} {actual} {expected}");
    }
}

/// Largest absolute and relative difference of two equally long vectors.
fn max_difference(a: &[f64], b: &[f64]) -> (f64, f64) {
    a.iter().zip(b).fold((0.0f64, 0.0f64), |(abs, rel), (x, y)| {
        let d = (x - y).abs();
        (abs.max(d), rel.max(d / y.abs().max(f64::MIN_POSITIVE)))
    })
}

#[test]
fn double_forward_pipelines_match_matlab() {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_REFERENCE_DIR").map(PathBuf::from) else { return };
    let reference: Value = serde_json::from_slice(&std::fs::read(root.join("reference.json")).unwrap()).unwrap();
    let cases = reference["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 741, "the pinned reference keeps every recorded case");
    let find = |id: &str| cases.iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("missing case {id}"));
    let mut recorded: Vec<&str> = cases.iter()
        .filter(|c| c["id"].as_str().unwrap().starts_with("pipeline_double_") && c["analysis"] == "prf" && c["model"]["Compressive_Nonlinearity"] != true)
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    let mut expected_ids: Vec<&str> = CASES.iter().map(|(id, _)| *id).collect();
    expected_ids.sort_unstable();
    recorded.sort_unstable();
    assert_eq!(recorded, expected_ids, "double forward non-CSS pipelines in the pin");
    let mut report = Vec::new();
    let mut historical_checked = 0;
    for (id, expected_vertices) in CASES {
        let case = find(id);
        assert_eq!(case["precision"], "double", "{id}");
        let pre = find(case["preprocessing"].as_str().unwrap());
        assert_eq!(pre["courses"]["class"], "double", "{id}: course class");
        let courses = array(&root, &pre["courses"]);
        let volumes = pre["courses"]["shape"][0].as_u64().unwrap() as usize;
        let vertices = pre["courses"]["shape"][1].as_u64().unwrap() as usize;
        assert_eq!(vertices, expected_vertices, "{id}: vertices");
        assert_eq!(courses.len(), volumes * vertices, "{id}: course shape");
        let ceiling = pre.get("noiseCeiling").filter(|d| d.is_object()).map(|d| array(&root, d));
        let mut model_json = case["model"].clone();
        model_json["Data_Precision"] = "double".into();
        let parsed = model::parse_model_json(model::AnalysisKind::Prf, &model_json.to_string()).unwrap();
        let apertures = mat::read_apertures(&std::fs::read(root.join(format!("{}.mat", model_json["Aperture_File"].as_str().unwrap()))).unwrap()).unwrap();
        let downsampling = model_json["Downsample_Predictions"].as_u64().unwrap() as usize;
        let kernel = hrf::de_haas(model_json["TR"].as_f64().unwrap());
        let recorded_hrf = array(&root, &case["hrf"]);
        assert_eq!(kernel.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), recorded_hrf.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "{id}: the port's HRF is MATLAB's");
        let inputs = job::JobInputs {
            model: parsed,
            apertures: Some(apertures.clone()),
            hrf: None,
            data: TimeSeries { volumes, vertices, data: courses.clone() },
            kept: (0..vertices as u32).collect(),
            roi: None,
            noise_ceiling: ceiling,
            global_signal: None,
            seed: None,
            surface: None,
            area: None,
            seed_fine_fit: None,
            total_vertices: vertices,
        };
        let prepared = job::Job::prepare(inputs, &mut |_, _| {}).unwrap();
        let partial = prepared.run(0, prepared.vertex_count(), &mut |_| {}).unwrap();
        let maps = prepared.merge(&[partial]).unwrap().maps;
        let values: Vec<String> = case["values"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(maps.values, values, "{id}: map names");
        let fine = model_json["Coarse_Fit_Only"] != true;
        for name in ["x0", "y0", "Sigma", "R^2"] {
            assert!(values.iter().any(|n| n == name), "{id}: no {name} map");
        }
        let expected_maps = array(&root, &case["maps"]);
        let rows = values.len();
        assert_eq!(case["maps"]["shape"][0].as_u64().unwrap() as usize, rows, "{id}: map rows");
        assert_eq!(expected_maps.len(), rows * vertices, "{id}: map shape");
        assert_eq!(maps.data.len(), rows * vertices, "{id}: port map shape");
        let row = |name: &str| values.iter().position(|n| n == name).unwrap();
        let matlab = |name: &str, v: usize| expected_maps[v * rows + row(name)];
        let port = |name: &str, v: usize| maps.data[row(name) * vertices + v];
        let function = AnonymousFunction::parse(model_json["Prf_Function"].as_str().unwrap()).unwrap();
        let xy = apertures.scaled_xy(model_json["Scaling_Factor"].as_f64().unwrap());
        let mut map_summary = serde_json::Map::new();
        for name in &values {
            let differing = (0..vertices).filter(|&v| port(name, v).to_bits() != matlab(name, v).to_bits()).count();
            let finite: Vec<usize> = (0..vertices).filter(|&v| matlab(name, v).is_finite()).collect();
            let (abs, rel) = max_difference(&finite.iter().map(|&v| port(name, v)).collect::<Vec<_>>(), &finite.iter().map(|&v| matlab(name, v)).collect::<Vec<_>>());
            let zeros = (0..vertices).filter(|&v| matlab(name, v) == 0.0).count();
            let nans = (0..vertices).filter(|&v| matlab(name, v).is_nan()).count();
            map_summary.insert(name.clone(), json!({"exact": exact(name, fine), "bitDifferent": differing, "maxAbs": abs, "maxRel": rel, "zeros": zeros, "nans": nans}));
            for v in 0..vertices {
                assert_map(exact(name, fine), port(name, v), matlab(name, v), &format!("{id}: vertex {v} {name}"));
            }
        }
        // How far MATLAB's operation order moves the prediction and the objective
        // at each kept fine fit, against the plain sums the objective used before.
        let parameters = ["x0", "y0", "Sigma"];
        let mut arithmetic = Vec::new();
        for v in 0..vertices {
            let kept = parameters.iter().any(|n| port(n, v) != 0.0);
            if !fine || !kept {
                continue;
            }
            let p: Vec<f64> = parameters.iter().map(|n| port(n, v)).collect();
            let y = &courses[v * volumes..(v + 1) * volumes];
            let profile = function.evaluate(&[samsrf_core::expr::Value::column(p.clone()), samsrf_core::expr::Value { rows: xy.len(), cols: 2, data: xy.iter().map(|q| q[0]).chain(xy.iter().map(|q| q[1])).collect() }]).unwrap();
            let raw = prf::predict_timecourse(&profile.data, &apertures);
            let plain = hrf::convolve(&raw, &kernel, downsampling);
            let ordered = samsrf_core::matlab_math::convolve_real(&raw, &kernel, downsampling);
            let (_, prediction_rel) = max_difference(&plain, &ordered);
            let r = prf::pearson(&plain, y);
            let plain_objective = 1.0 - r * r;
            let objective = prf::errfun_with_convention(&function, &apertures, &xy, &hrf::ErrfunHrf::Kernel(kernel.clone()), &p, y, downsampling, false, Precision::Double, css::Convention::Samsrf).unwrap().re;
            // samsrf_normr2 zeroes R^2 where the noise ceiling is not positive.
            let r2 = if values.iter().any(|n| n == "Noise Ceiling") && port("Noise Ceiling", v) <= 0.0 { 0.0 } else { 1.0 - objective };
            assert_eq!(r2.to_bits(), matlab("R^2", v).to_bits(), "{id}: vertex {v}: R^2 is 1 - the objective at MATLAB's parameters");
            arithmetic.push(json!({"vertex": v, "predictionMaxRel": prediction_rel, "objective": objective, "plainObjective": plain_objective, "objectiveDifference": objective - plain_objective}));
        }
        let historical: Vec<Value> = HISTORICAL.iter().filter(|(case, _, _)| *case == id).map(|&(_, v, class)| {
            historical_checked += 1;
            json!({"vertex": v, "formerClass": class, "x0": port("x0", v), "y0": port("y0", v), "Sigma": port("Sigma", v), "r2": port("R^2", v)})
        }).collect();
        report.push(json!({"id": id, "vertices": vertices, "volumes": volumes, "downsampling": downsampling, "maps": map_summary, "historical": historical, "fineFitArithmetic": arithmetic}));
    }
    assert_eq!(historical_checked, HISTORICAL.len(), "every historical vertex belongs to a gated case");
    if let Some(path) = std::env::var_os("SAMSRF_DOUBLE_FORWARD_REPORT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap() + "\n").unwrap();
    }
}
