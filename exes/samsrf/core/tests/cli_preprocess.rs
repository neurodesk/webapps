//! MATLAB's preprocessed courses (`Srf.Y`) in the pinned SamSrfAnalysis recording
//! (`cli-reference.json`), against the port's `RunAccumulator` on the same raw GIfTI
//! runs. `SAMSRF_CLI_REFERENCE_DIR` is the extracted recording and
//! `SAMSRF_CLI_COURSES_DIR` the output of `extract_cli_courses.py` on it; without
//! them these return.
//!
//! `samsrf_gii2srf` detrends every vertex of a run with one `\` (MKL's `?ormqr`
//! rounds each vertex by its place among all of them), z-scores, then averages runs
//! in order or concatenates them. On the AMD host every double and single value of
//! every run whose `Srf.Y` is that stage's output is MATLAB's, bit for bit. The two
//! connective-field runs with global-signal correction and smoothing save `Srf.Y`
//! after those later stages and are counted, not compared, here. The Intel host's MKL
//! rounds the double solve in another order; its counts are recorded, not gated
//! (validation/matlab/README.md#double-detrend-and-z-score).
use samsrf_core::gifti;
use samsrf_core::precision::Precision;
use samsrf_core::preprocess::{Combine, Normalise, PreprocessOptions, RunAccumulator};
use samsrf_core::timeseries::VertexSelection;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn roots() -> Option<(PathBuf, PathBuf)> {
    Some((
        PathBuf::from(std::env::var_os("SAMSRF_CLI_REFERENCE_DIR")?),
        PathBuf::from(std::env::var_os("SAMSRF_CLI_COURSES_DIR")?),
    ))
}

fn read_f64(path: &Path) -> Vec<f64> {
    std::fs::read(path).unwrap().as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn argument<'a>(argv: &'a [Value], prefix: &str) -> Option<&'a str> {
    argv.iter().filter_map(Value::as_str).find_map(|value| value.strip_prefix(prefix))
}

/// The port's courses over the run's ROI, from the recording's own bundle.
fn port_courses(recording: &Path, run: &Value, roi: &[u32]) -> (usize, Vec<f64>) {
    let argv = run["argv"].as_array().unwrap();
    assert_eq!(argument(argv, "-norm="), Some("1"), "{}: detrend and z-score", run["id"]);
    let combine = match argument(argv, "-aver=") {
        Some("1") => Combine::Average { noise_ceiling: true },
        Some("0") => Combine::Concatenate,
        other => panic!("{}: -aver={other:?}", run["id"]),
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
    assert!(!files.is_empty(), "{}: no runs match {pattern}", run["id"]);
    let precision = if run["precision"] == "single" { Precision::Single } else { Precision::Double };
    let options = PreprocessOptions { normalise: Normalise::DetrendZscore, combine, global_signal: false, precision };
    let runs: Vec<_> = files.iter().map(|path| gifti::read_run(&std::fs::read(path).unwrap()).unwrap()).collect();
    let mut accumulator = RunAccumulator::new(runs[0].vertices, VertexSelection::from_indices(roi.to_vec()), options);
    for raw in &runs {
        accumulator.push_run(raw).unwrap();
    }
    let preprocessed = accumulator.finish().unwrap();
    let volumes = preprocessed.data.volumes;
    let values = (0..roi.len())
        .flat_map(|position| preprocessed.data.course(position).to_vec())
        .map(|value| if precision == Precision::Single { f64::from(value as f32) } else { value })
        .collect();
    (volumes, values)
}

/// Whether `Srf.Y` is saved after `samsrf_revcor_cf`'s regression or smoothing.
fn after_later_stages(run: &Value) -> bool {
    let model = &run["model"];
    model["Global_Signal_Correction"] == true || model["Smoothing"].as_f64().is_some_and(|value| value != 0.0)
}

#[test]
fn preprocessed_courses_equal_matlab_on_the_amd_host() {
    let Some((recording, courses)) = roots() else { return };
    let manifest: Value = serde_json::from_slice(&std::fs::read(courses.join("manifest.json")).unwrap()).unwrap();
    let plan = &manifest["plan"];
    let mut summary = Vec::new();
    for (key, expected_host) in [("amd", "AMD"), ("intel", "INTEL")] {
        let host = &manifest["hosts"][key];
        assert!(host["cpu"].as_str().unwrap().to_uppercase().starts_with(expected_host), "{key}: {}", host["cpu"]);
        let (mut compared, mut exact, mut later_runs, mut runs_seen) = (0usize, 0usize, 0usize, 0usize);
        for entry in host["runs"].as_array().unwrap() {
            let id = entry["id"].as_str().unwrap();
            let run = plan["runs"].as_array().unwrap().iter().find(|run| run["id"] == id).unwrap();
            runs_seen += 1;
            if after_later_stages(run) {
                later_runs += 1;
                continue;
            }
            let roi: Vec<u32> = entry["roi"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32 - 1).collect();
            let matlab = read_f64(&courses.join(key).join(entry["file"].as_str().unwrap()));
            let (volumes, port) = port_courses(&recording, run, &roi);
            assert_eq!(volumes, entry["volumes"].as_u64().unwrap() as usize, "{key} {id}: volumes");
            assert_eq!(port.len(), matlab.len(), "{key} {id}: values");
            let same = port.iter().zip(&matlab).filter(|(a, b)| a.to_bits() == b.to_bits()).count();
            if key == "amd" {
                let first = port.iter().zip(&matlab).position(|(a, b)| a.to_bits() != b.to_bits());
                assert_eq!(same, matlab.len(), "{key} {id}: first difference at {first:?}");
            }
            compared += matlab.len();
            exact += same;
        }
        assert_eq!((runs_seen, later_runs), (24, 2), "{key}: run inventory");
        summary.push((key, compared, exact));
    }
    println!("courses compared/identical per host: {summary:?}");
    assert_eq!(summary[0], ("amd", 168_000, 168_000));
    // Recorded, not gated as parity: the Intel host's MKL solves in another order.
    // Its single courses are all identical, its double ones mostly not.
    assert_eq!(summary[1].1, 168_000);
}
