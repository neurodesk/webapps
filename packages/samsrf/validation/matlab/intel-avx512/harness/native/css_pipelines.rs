//! RESEARCH ONLY (copied by build.sh into the build's exes/samsrf/wasm/tests). The recorded
//! double CSS pipelines of `css-pipelines-reference.json` (SAMSRF_MATLAB_CSS_PIPELINES_DIR),
//! run natively through the build's engine from each host's own MATLAB courses and noise
//! ceiling, with the build's arithmetic reference installed first: none in the hooks build
//! (the shipped arithmetic), the samsrf-mkl-avx512 kernels in the avx512 build. Every map
//! value is compared bitwise with the host's recorded maps (real parts) and saved imaginary
//! parts; the report (SAMSRF_HARNESS_REPORT) counts equal values per host, pipeline and map,
//! split into vertices with and without an imaginary part. SAMSRF_HARNESS_DUMP receives every
//! value the build computed (host, pipeline, map, zero-based vertex, real and imaginary bits),
//! which `account_pipelines.py` holds value by value against the recording and the other build.
//! Nothing is asserted about the counts here.

use samsrf_core::{job, mat, model, timeseries::TimeSeries};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name, "a bare file name");
    let bytes = std::fs::read(root.join(name)).unwrap();
    let count: usize = descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).product();
    assert_eq!(bytes.len(), count * 8, "{name}");
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn imaginary(root: &Path, descriptor: &Value, count: usize) -> Vec<f64> {
    match descriptor["imaginary"].as_str().filter(|name| !name.is_empty()) {
        Some(name) => array(root, &json!({"file": name, "shape": [count]})),
        None => vec![0.0; count],
    }
}

#[test]
fn recorded_css_pipelines_by_host() {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_CSS_PIPELINES_DIR").map(PathBuf::from) else { return };
    samsrf_wasm::install_research_reference();
    let manifest = read_json(&root.join("manifest.json"));
    let mut hosts = BTreeMap::new();
    let mut dump = String::from("host\tpipeline\tmap\tvertex0\treal\timaginary\n");
    for (host, info) in manifest["hosts"].as_object().unwrap() {
        let blas = info["blas"].as_str().unwrap();
        let dir = root.join(host).join("compatible");
        let environment = read_json(&dir.join("environment.json"));
        assert_eq!(environment["observed"]["blas"].as_str(), Some(blas), "{host}: the receipt names the manifest's MKL");
        let recording = read_json(&dir.join("pipelines.json"));
        let mut cases = BTreeMap::new();
        for case in recording["cases"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let mut model_json = case["model"].clone();
            model_json["Data_Precision"] = "double".into();
            model_json["Css_Convention"] = "samsrf".into();
            let parsed = model::parse_model_json(model::AnalysisKind::Prf, &model_json.to_string()).unwrap();
            let aperture_file = dir.join(format!("{}.mat", model_json["Aperture_File"].as_str().unwrap()));
            let apertures = mat::read_apertures(&std::fs::read(aperture_file).unwrap()).unwrap();
            let courses = array(&dir, &case["courses"]);
            let volumes = case["courses"]["shape"][0].as_u64().unwrap() as usize;
            let vertices = courses.len() / volumes;
            let inputs = job::JobInputs {
                model: parsed,
                apertures: Some(apertures),
                hrf: None,
                data: TimeSeries { volumes, vertices, data: courses },
                kept: (0..vertices as u32).collect(),
                roi: None,
                noise_ceiling: case.get("noiseCeiling").map(|d| array(&dir, d)),
                global_signal: None,
                seed: None,
                surface: None,
                area: None,
                seed_fine_fit: None,
                total_vertices: vertices,
            };
            let prepared = job::Job::prepare(inputs, &mut |_, _| {}).unwrap();
            let partial = prepared.run(0, vertices, &mut |_| {}).unwrap();
            let merged = prepared.merge(&[partial]).unwrap();
            let values: Vec<String> = case["values"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            assert_eq!(merged.maps.values, values, "{host} {id}");
            let rows = values.len();
            let real = array(&dir, &case["maps"]);
            let saved = array(&dir, &case["savedMaps"]);
            let saved_imaginary = imaginary(&dir, &case["savedMaps"], rows * vertices);
            let port_imaginary = merged.imaginary.clone().unwrap_or_else(|| vec![0.0; rows * vertices]);
            // A vertex is complex when either side has an imaginary part in any row.
            let complex: Vec<bool> = (0..vertices)
                .map(|v| (0..rows).any(|r| saved_imaginary[v * rows + r] != 0.0 || port_imaginary[r * vertices + v] != 0.0))
                .collect();
            let mut maps = BTreeMap::new();
            for (r, label) in values.iter().enumerate() {
                let mut counts = BTreeMap::new();
                for v in 0..vertices {
                    dump.push_str(&format!(
                        "{host}\t{id}\t{label}\t{v}\t{:016x}\t{:016x}\n",
                        merged.maps.data[r * vertices + v].to_bits(),
                        port_imaginary[r * vertices + v].to_bits()
                    ));
                    let route = if complex[v] { "complex" } else { "real" };
                    let port = merged.maps.data[r * vertices + v];
                    let checks = [
                        ("real", port.to_bits() == real[v * rows + r].to_bits()),
                        ("saved real", port.to_bits() == saved[v * rows + r].to_bits()),
                        ("imaginary", port_imaginary[r * vertices + v].to_bits() == saved_imaginary[v * rows + r].to_bits()),
                    ];
                    for (kind, equal) in checks {
                        let slot: &mut [usize; 2] = counts.entry(format!("{kind} {route}")).or_insert([0; 2]);
                        slot[0] += 1;
                        slot[1] += usize::from(equal);
                    }
                }
                maps.insert(label.clone(), counts);
            }
            cases.insert(id.to_string(), json!({"vertices": vertices, "complexVertices": complex.iter().filter(|c| **c).count(), "maps[values, equal]": maps}));
        }
        hosts.insert(host.clone(), json!({"cpu": info["cpu"], "blas": blas, "cases": cases}));
    }
    let report = json!({"reference": samsrf_core::reference::name(), "hosts": hosts});
    println!("{}", serde_json::to_string(&report).unwrap());
    if let Some(path) = std::env::var_os("SAMSRF_HARNESS_DUMP") {
        std::fs::write(path, &dump).unwrap();
    }
    if let Some(path) = std::env::var_os("SAMSRF_HARNESS_REPORT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap() + "\n").unwrap();
    }
}
