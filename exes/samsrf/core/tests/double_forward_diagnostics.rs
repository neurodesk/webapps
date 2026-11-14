//! Diagnostic gate, not an acceptance gate: the nine double forward (non-CSS)
//! pipelines of the 741-case reference, which `compare.mjs` does not gate,
//! classified vertex by vertex against MATLAB. Needs SAMSRF_MATLAB_REFERENCE_DIR
//! (the `reference.json` pin); SAMSRF_DOUBLE_FORWARD_REPORT writes the per-vertex
//! evidence as JSON.
//!
//! Its purpose is to keep the diagnosis exact and reviewable, not to accept the
//! differences. It requires every case, shape, map name and the HRF bits; zero
//! and NaN masks equal to MATLAB's wherever the parameters are equal; and the
//! committed vertex-to-class map below. Any change, better or worse, fails until
//! the map is reviewed and updated.
//!
//! Classes:
//! - `rounding`: x0, y0 and Sigma have MATLAB's bits and R^2 is within 1e-12
//!   (Beta, Baseline and R^2 may differ in the last bits);
//! - `plateau`: both kept a fit with different parameters and R^2 within 1e-9;
//!   the port's own objective (`prf::errfun_with_convention`) is then equal at
//!   both endpoints to 1e-10 relative;
//! - `acceptance`: one side kept a fit, the other zeroed it;
//! - `optimum`: both kept a fit, with different parameters and R^2.
use samsrf_core::{css, expr::AnonymousFunction, hrf, job, mat, model, prf, precision::Precision, timeseries::TimeSeries};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Every non-rounding vertex of each case, as of #730's plateau diagnosis
/// (zero-based fixture vertices, not cortical vertex IDs).
const EXPECTED: [(&str, usize, &[(usize, &str)]); 9] = [
    ("pipeline_double_x001_lh_average1_coarse1", 96, &[]),
    ("pipeline_double_x001_lh_average1_coarse0", 96, &[(2, "acceptance"), (4, "plateau")]),
    ("pipeline_double_thresholds", 96, &[(2, "acceptance"), (4, "plateau")]),
    ("pipeline_double_x001_lh_average0_coarse1", 96, &[]),
    ("pipeline_double_x001_lh_average0_coarse0", 96, &[(2, "plateau"), (4, "plateau"), (23, "plateau"), (81, "acceptance")]),
    ("pipeline_double_x001_rh_average1_coarse1", 76, &[]),
    ("pipeline_double_x001_rh_average1_coarse0", 76, &[(17, "plateau"), (29, "acceptance"), (46, "plateau"), (58, "acceptance"), (75, "optimum")]),
    ("pipeline_double_analyzeprf_lh_average0_coarse1", 10, &[]),
    ("pipeline_double_analyzeprf_lh_average0_coarse0", 10, &[(6, "plateau")]),
];

fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name);
    let bytes = std::fs::read(root.join(name)).unwrap();
    let count: usize = descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).product();
    assert_eq!(bytes.len(), count * 8, "{name}");
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

#[test]
fn double_forward_pipelines_keep_their_diagnosed_classes() {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_REFERENCE_DIR").map(PathBuf::from) else { return };
    let reference: Value = serde_json::from_slice(&std::fs::read(root.join("reference.json")).unwrap()).unwrap();
    let cases = reference["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 741, "the pinned reference keeps every recorded case");
    let find = |id: &str| cases.iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("missing case {id}"));
    let recorded: Vec<&str> = cases.iter()
        .filter(|c| c["id"].as_str().unwrap().starts_with("pipeline_double_") && c["analysis"] == "prf" && c["model"]["Compressive_Nonlinearity"] != true)
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    let mut expected_ids: Vec<&str> = EXPECTED.iter().map(|(id, _, _)| *id).collect();
    let mut recorded_sorted = recorded.clone();
    expected_ids.sort_unstable();
    recorded_sorted.sort_unstable();
    assert_eq!(recorded_sorted, expected_ids, "double forward non-CSS pipelines in the pin");
    let mut report = Vec::new();
    for (id, expected_vertices, expected_classes) in EXPECTED {
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
        let expected_maps = array(&root, &case["maps"]);
        let rows = values.len();
        assert_eq!(case["maps"]["shape"][0].as_u64().unwrap() as usize, rows, "{id}: map rows");
        assert_eq!(expected_maps.len(), rows * vertices, "{id}: map shape");
        assert_eq!(maps.data.len(), rows * vertices, "{id}: port map shape");
        let row = |name: &str| values.iter().position(|n| n == name).unwrap_or_else(|| panic!("{id}: no {name} map"));
        let matlab = |name: &str, v: usize| expected_maps[v * rows + row(name)];
        let port = |name: &str, v: usize| maps.data[row(name) * vertices + v];
        let function = AnonymousFunction::parse(model_json["Prf_Function"].as_str().unwrap()).unwrap();
        let xy = apertures.scaled_xy(model_json["Scaling_Factor"].as_f64().unwrap());
        let objective = |p: &[f64], y: &[f64]| prf::errfun_with_convention(&function, &apertures, &xy, &hrf::ErrfunHrf::Kernel(kernel.clone()), p, y, downsampling, false, Precision::Double, css::Convention::Samsrf).unwrap().re;
        let parameters = ["x0", "y0", "Sigma"];
        let mut found = Vec::new();
        let mut evidence = Vec::new();
        for v in 0..vertices {
            let same_parameters = parameters.iter().all(|n| port(n, v).to_bits() == matlab(n, v).to_bits());
            let kept = |f: &dyn Fn(&str, usize) -> f64| parameters.iter().any(|n| f(n, v) != 0.0);
            let (pr2, mr2) = (port("R^2", v), matlab("R^2", v));
            let identical = values.iter().all(|n| port(n, v).to_bits() == matlab(n, v).to_bits());
            let class = if identical || (same_parameters && (pr2 - mr2).abs() <= 1e-12) {
                if !identical {
                    // Same fit: every map keeps MATLAB's zero and NaN masks.
                    for n in &values {
                        let (a, e) = (port(n, v), matlab(n, v));
                        assert_eq!((a == 0.0, a.is_nan()), (e == 0.0, e.is_nan()), "{id}: vertex {v} {n} mask: {a} vs {e}");
                    }
                }
                continue;
            } else if kept(&port) != kept(&matlab) {
                "acceptance"
            } else if (pr2 - mr2).abs() <= 1e-9 {
                "plateau"
            } else {
                "optimum"
            };
            let y = &courses[v * volumes..(v + 1) * volumes];
            let pp: Vec<f64> = parameters.iter().map(|n| port(n, v)).collect();
            let mp: Vec<f64> = parameters.iter().map(|n| matlab(n, v)).collect();
            let (po, mo) = (objective(&pp, y), objective(&mp, y));
            if class == "plateau" {
                assert!((po - mo).abs() <= 1e-10 * po.abs(), "{id}: vertex {v}: port objective {po} and MATLAB's endpoint {mo} are not one plateau");
            }
            found.push((v, class));
            evidence.push(json!({
                "vertex": v, "class": class,
                "port": {"parameters": pp, "r2": pr2, "objective": po},
                "matlab": {"parameters": mp, "r2": mr2, "objectiveUnderPort": mo},
            }));
        }
        assert_eq!(found, expected_classes.to_vec(), "{id}: diagnosed vertices changed; review and update EXPECTED");
        report.push(json!({"id": id, "vertices": vertices, "evidence": evidence}));
    }
    if let Some(path) = std::env::var_os("SAMSRF_DOUBLE_FORWARD_REPORT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap() + "\n").unwrap();
    }
}
