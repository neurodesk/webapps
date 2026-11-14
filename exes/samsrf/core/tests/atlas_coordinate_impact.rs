//! How much the remaining single `sin`/`cos` differences change connective-field
//! maps on real data. MATLAB's template coordinates are known exactly without a new
//! recording: at the inputs listed in the pinned exception tables
//! (`single-trig-reference.json`) MATLAB's `sin`/`cos` output is the recorded value,
//! and everywhere else it equals the port's (`single_trig.rs`). So the test builds
//! MATLAB's whole-hemisphere template from the port's reader plus those tables, and
//! runs the same single-precision CF job on both templates. Every other step is the
//! port's, so the counted differences isolate the coordinates; they are not a
//! comparison with a MATLAB run of these analyses.
//!
//! Data: the web app's example (`apps/samsrf/examples.json`, X001 lh, six runs) in
//! `SAMSRF_WEBAPP_EXAMPLE_DIR`, and the trig recording in `SAMSRF_SINGLE_TRIG_DIR`.
//! It takes minutes: `cargo test --release -p samsrf-core --test atlas_coordinate_impact -- --ignored --nocapture`.
use samsrf_core::job::{Job, JobInputs, SeedInputs};
use samsrf_core::mapset::Maps;
use samsrf_core::model::{self, AnalysisKind, Model};
use samsrf_core::precision::{cos_single, sin_single, Precision};
use samsrf_core::preprocess::{Combine, Normalise, PreprocessOptions, RunAccumulator};
use samsrf_core::timeseries::VertexSelection;
use samsrf_core::{freesurfer, gifti, template};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const VERTICES: usize = 134_260;

fn exception_table(dir: &Path, descriptor: &Value) -> HashMap<u32, u32> {
    let values: Vec<f64> = std::fs::read(dir.join(descriptor["file"].as_str().unwrap())).unwrap().as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect();
    let rows = values.len() / 2;
    (0..rows).map(|i| (values[i] as u32, values[rows + i] as u32)).collect()
}

/// `samsrf_benson2srf`'s angle in radians, as `template.rs` computes it.
fn radians(polar: f32) -> f32 {
    let angle = -polar + 90.0f32;
    let turns = (f64::from(angle) / 180.0) as f32;
    (f64::from(turns) * std::f64::consts::PI) as f32
}

/// The port's template and MATLAB's, which differs where an exception input occurs.
fn templates(example: &Path, trig: &Path) -> (Maps, Maps, Vec<usize>) {
    let bytes = std::fs::read(example.join("lh_benson.gii")).unwrap();
    let port = template::read_benson_gifti(&bytes, false).unwrap();
    let file = gifti::read(&bytes).unwrap();
    let (polar, eccentricity) = (&file.arrays[0].data, &file.arrays[1].data);
    let dir = trig.join("ubuntu-22.04").join("compatible");
    let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("numerics.json")).unwrap()).unwrap();
    let case = recording["cases"].as_array().unwrap().iter().find(|c| c["id"] == "single_trig").unwrap().clone();
    let (sin, cos) = (exception_table(&dir, &case["sinExceptions"]), exception_table(&dir, &case["cosExceptions"]));
    let n = port.vertices;
    let mut matlab = port.clone();
    let mut changed = Vec::new();
    for v in 0..n {
        let (p, e) = (polar[v] as f32, eccentricity[v] as f32);
        let r = radians(p);
        // The reconstruction with the port's functions must be the reader's.
        assert_eq!((f64::from(e * cos_single(r)), f64::from(e * sin_single(r))), (port.row(1)[v], port.row(2)[v]), "vertex {v}");
        let c = cos.get(&r.to_bits()).map_or(cos_single(r), |&b| f32::from_bits(b));
        let s = sin.get(&r.to_bits()).map_or(sin_single(r), |&b| f32::from_bits(b));
        let (x0, y0) = (f64::from(e * c), f64::from(e * s));
        if (x0, y0) != (port.row(1)[v], port.row(2)[v]) {
            changed.push(v);
            matlab.data[n + v] = x0;
            matlab.data[2 * n + v] = y0;
        }
    }
    (port, matlab, changed)
}

fn label(example: &Path, name: &str) -> Vec<u32> {
    freesurfer::read_label(&std::fs::read_to_string(example.join(name)).unwrap()).unwrap().vertices
}

/// The single-precision CF model, built test-only for `Fit_pRF = 1`, which the parser refuses.
fn cf_model(fit: i32, smoothing: f64) -> Model {
    let json = format!(r#"{{"Name":"CF","SeedRoi":"seed","Template":"template","Fit_pRF":{fit},"Smoothing":{smoothing},"Data_Precision":"double"}}"#);
    let Model::RevCorCf(mut cf) = model::parse_model_json(AnalysisKind::RevCorCf, &json).unwrap() else { unreachable!() };
    cf.data_precision = Precision::Single;
    Model::RevCorCf(cf)
}

#[test]
#[ignore = "minutes; needs SAMSRF_WEBAPP_EXAMPLE_DIR and SAMSRF_SINGLE_TRIG_DIR"]
fn atlas_coordinate_differences_change_cf_maps() {
    let example = PathBuf::from(std::env::var_os("SAMSRF_WEBAPP_EXAMPLE_DIR").expect("set SAMSRF_WEBAPP_EXAMPLE_DIR"));
    let trig = PathBuf::from(std::env::var_os("SAMSRF_SINGLE_TRIG_DIR").expect("set SAMSRF_SINGLE_TRIG_DIR"));
    let (port, matlab, changed) = templates(&example, &trig);
    println!("MATLAB's template differs from the port's at vertices {changed:?}");
    assert_eq!(changed, [352, 6865, 6866, 15281, 27720, 31139, 32332, 35618, 36706, 41604]);

    let bytes = std::fs::read(example.join("lh_benson.gii")).unwrap();
    let rois = gifti::read(&bytes).unwrap().arrays[2].data.clone();
    let area_label = |a: f64| -> Vec<u32> { (0..VERTICES as u32).filter(|&v| rois[v as usize].abs() == a).collect() };
    let example_seed = label(&example, "lh.V1_seed.label");
    let roi_label = label(&example, "lh.V123.label");
    // The example's seed holds none of them, so its CF maps cannot change.
    assert!(changed.iter().all(|v| !example_seed.contains(&(*v as u32))));

    // Targets changed per (seed, mode), frozen from the first run.
    let expected: [(&str, &str, usize); 6] = [
        ("Benson V1", "hull", 1),
        ("Benson V1", "summary", 0),
        ("Benson V1", "Gaussian, smoothed", 1),
        ("Benson V2", "hull", 0),
        ("Benson V2", "summary", 0),
        ("Benson V2", "Gaussian, smoothed", 1),
    ];
    let mut observed = Vec::new();
    // Held-out targets: every 40th vertex of the V1-V3 label outside the seed region.
    for (seed_name, seed) in [("Benson V1", area_label(1.0)), ("Benson V2", area_label(2.0))] {
        let inside = changed.iter().filter(|v| seed.contains(&(**v as u32))).count();
        let targets: Vec<u32> = roi_label.iter().copied().filter(|v| !seed.contains(v)).step_by(40).collect();
        let mut kept: Vec<u32> = targets.iter().chain(&seed).copied().collect();
        kept.sort_unstable();
        kept.dedup();
        let options = PreprocessOptions { normalise: Normalise::DetrendZscore, combine: Combine::Average { noise_ceiling: true }, global_signal: true, precision: Precision::Single };
        let mut accumulator = RunAccumulator::new(VERTICES, VertexSelection::Indices(kept.clone()), options);
        for run in 1..=6 {
            accumulator.push_run(&gifti::read_run(&std::fs::read(example.join(format!("lh_uBars{run}.gii"))).unwrap()).unwrap()).unwrap();
        }
        let data = accumulator.finish().unwrap();
        let area = freesurfer::read_curv(&std::fs::read(example.join("lh.area")).unwrap()).unwrap();
        let surface = freesurfer::read_surface(&std::fs::read(example.join("lh.white")).unwrap()).unwrap();
        for (mode, fit, smoothing) in [("hull", 0, 0.0), ("summary", -1, 0.0), ("Gaussian, smoothed", 1, 3.0)] {
            let run = |template: &Maps| -> Maps {
                let inputs = JobInputs {
                    model: cf_model(fit, smoothing),
                    apertures: None,
                    hrf: None,
                    data: data.data.clone(),
                    kept: kept.clone(),
                    roi: Some(targets.clone()),
                    noise_ceiling: data.noise_ceiling.clone(),
                    global_signal: data.global_signal.clone(),
                    seed: Some(SeedInputs { vertices: seed.clone(), template: template.clone() }),
                    surface: Some(surface.clone()),
                    area: Some(area.clone()),
                    seed_fine_fit: None,
                    total_vertices: VERTICES,
                };
                let job = Job::prepare(inputs, &mut |_, _| {}).unwrap();
                let part = job.run(0, job.vertex_count(), &mut |_| {}).unwrap();
                job.merge(&[part]).unwrap().maps
            };
            let (a, b) = (run(&port), run(&matlab));
            let mut differing = std::collections::BTreeSet::new();
            let mut rows = std::collections::BTreeMap::<String, f64>::new();
            for (r, name) in a.values.iter().enumerate() {
                for &v in &targets {
                    let (x, y) = (a.row(r)[v as usize], b.row(r)[v as usize]);
                    if x.to_bits() != y.to_bits() && !(x.is_nan() && y.is_nan()) {
                        differing.insert(v);
                        let change = rows.entry(name.clone()).or_default();
                        *change = change.max((x - y).abs());
                    }
                }
            }
            println!("{seed_name} seed ({} vertices, {inside} with a differing coordinate), {mode}: {} of {} targets change; largest change per map {rows:?}", seed.len(), differing.len(), targets.len());
            observed.push((seed_name, mode, differing.len()));
        }
    }
    assert_eq!(observed, expected);
}
