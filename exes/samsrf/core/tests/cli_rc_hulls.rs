//! The SamSrfAnalysis reverse-correlation hull runs of the pinned recording
//! (`cli-reference.json`, 100 x 100 apertures), rebuilt from MATLAB's own
//! preprocessed courses. `SAMSRF_CLI_REFERENCE_DIR` is the extracted recording,
//! `SAMSRF_CLI_COURSES_DIR` the output of `extract_cli_courses.py` on it and
//! `SAMSRF_CLI_RC_HULLS_DIR` the output of `extract_cli_rc_hulls.py`; set all three
//! or none.
//!
//! Production output bits are frozen against base 3f90ac124 on both hosts.
//! This also gates the diagnostic `HullOrder::Stored` evaluation, which the convex-hull
//! analysis does not take in production (`revcor_prf::pixel_grid`). With it, on
//! both hosts the pixel grid equals the `xc` and `yc` MATLAB saved, at every
//! pixel. On the AMD host, where the profiles are MATLAB's, the peak, the hull
//! centroid and, but for the listed vertices, `Fwhm` are MATLAB's bits.
use samsrf_core::hrf::{self, ResolvedHrf};
use samsrf_core::model::{parse_model_json, AnalysisKind, Model};
use samsrf_core::geometry::HullOrder;
use samsrf_core::{mat, revcor_prf};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const RUNS: [&str; 2] = ["rc_hull_lh_double", "rc_custom_hrf_lh_double"];

/// AMD vertices (positions in `Srf.Roi`) whose `Fwhm` differs: MATLAB takes it
/// from `convexHull` of the Delaunay triangulation, whose area arithmetic is not
/// identified (`ListedHull::of`, `hull-area-predictions.md`). Each must still
/// differ, by at most 2 ULP.
const FWHM_DIFFERS: [(&str, usize); 15] = [
    ("rc_hull_lh_double", 6),
    ("rc_hull_lh_double", 12),
    ("rc_hull_lh_double", 14),
    ("rc_hull_lh_double", 17),
    ("rc_hull_lh_double", 20),
    ("rc_custom_hrf_lh_double", 2),
    ("rc_custom_hrf_lh_double", 3),
    ("rc_custom_hrf_lh_double", 4),
    ("rc_custom_hrf_lh_double", 8),
    ("rc_custom_hrf_lh_double", 10),
    ("rc_custom_hrf_lh_double", 11),
    ("rc_custom_hrf_lh_double", 12),
    ("rc_custom_hrf_lh_double", 15),
    ("rc_custom_hrf_lh_double", 18),
    ("rc_custom_hrf_lh_double", 19),
];

fn configured(values: [Option<PathBuf>; 3]) -> Option<[PathBuf; 3]> {
    match values {
        [None, None, None] => None,
        [Some(recording), Some(courses), Some(hulls)] => Some([recording, courses, hulls]),
        _ => panic!("set all of SAMSRF_CLI_REFERENCE_DIR, SAMSRF_CLI_COURSES_DIR and SAMSRF_CLI_RC_HULLS_DIR or none"),
    }
}

fn roots() -> Option<[PathBuf; 3]> {
    configured(["SAMSRF_CLI_REFERENCE_DIR", "SAMSRF_CLI_COURSES_DIR", "SAMSRF_CLI_RC_HULLS_DIR"].map(|name| std::env::var_os(name).map(PathBuf::from)))
}

fn json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap()
}

fn float64(path: &Path, values: usize) -> Vec<f64> {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    assert_eq!(bytes.len(), values.checked_mul(8).unwrap(), "{}: float64 payload byte count", path.display());
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

/// `Srf.Roi` as extract_cli_rc_hulls.py writes it: distinct one-based vertex numbers.
fn vertex_numbers(roi: &Value, what: &str) -> Vec<u64> {
    let roi: Vec<u64> = roi.as_array().unwrap_or_else(|| panic!("{what}: no ROI")).iter().map(|v| v.as_u64().filter(|&v| v >= 1).unwrap_or_else(|| panic!("{what}: ROI entry {v}"))).collect();
    let mut distinct = roi.clone();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(distinct.len(), roi.len(), "{what}: repeated ROI vertices");
    roi
}

fn ulps(a: f64, b: f64) -> u64 {
    let key = |x: f64| { let i = x.to_bits() as i64; if i < 0 { i64::MIN - i } else { i } };
    key(a).abs_diff(key(b))
}

/// The run's analysis set up from the host's bundle, as the engine sets it up.
fn prepared(bundle: &Path, run: &str, volumes: usize) -> revcor_prf::Prepared {
    let mut model: Value = json(&bundle.join("models").join(format!("{run}.json")));
    model["Data_Precision"] = Value::from("double");
    let aperture = model["Aperture_File"].as_str().unwrap().rsplit('/').next().unwrap().to_string();
    let Model::RevCorPrf(model) = parse_model_json(AnalysisKind::RevCorPrf, &model.to_string()).unwrap() else { panic!("{run}: not reverse correlation") };
    let apertures = mat::read_apertures(&std::fs::read(bundle.join("apertures").join(format!("{aperture}.mat"))).unwrap()).unwrap();
    let kernel = match hrf::resolve(&model.hrf, model.tr) {
        Ok(kernel) => kernel,
        Err(_) => ResolvedHrf::Kernel(hrf::old_school(model.tr, mat::read_old_school_hrf(&std::fs::read(bundle.join("hrf_custom.mat")).unwrap()).unwrap())),
    };
    revcor_prf::Prepared::new(&model, &apertures, &kernel, volumes).unwrap()
}

#[test]
fn reverse_correlation_hulls_equal_matlab() {
    let Some([recording, courses, hulls]) = roots() else { return; };
    let course_manifest = json(&courses.join("manifest.json"));
    let hull_manifest = json(&hulls.join("manifest.json"));
    let mut differing = std::collections::BTreeSet::new();
    assert_eq!(hull_manifest.as_object().unwrap().keys().collect::<Vec<_>>(), ["amd", "intel"], "extracted hosts");
    for (host, bundle) in [("amd", recording.join("bundle")), ("intel", recording.join("ubuntu-24.04").join("bundle"))] {
        let mut production_bits = Sha256::new();
        let extracted = hull_manifest[host].as_array().unwrap();
        assert_eq!(extracted.iter().map(|run| run["id"].as_str().unwrap()).collect::<Vec<_>>(), RUNS, "{host}: extracted runs");
        for entry in extracted {
            let run = entry["id"].as_str().unwrap();
            let course = course_manifest["hosts"][host]["runs"].as_array().unwrap().iter().find(|r| r["id"] == run).unwrap_or_else(|| panic!("{host} {run}: no courses"));
            let volumes = course["volumes"].as_u64().unwrap() as usize;
            let roi = vertex_numbers(&entry["roi"], &format!("{host} {run} maps"));
            assert_eq!(roi, vertex_numbers(&course["roi"], &format!("{host} {run} courses")), "{host} {run}: ROI of courses and maps");
            let production = prepared(&bundle, run, volumes);
            let prepared = production.clone().with_hull_order(HullOrder::Stored);
            let pixels = entry["rows"].as_u64().unwrap() as usize * entry["columns"].as_u64().unwrap() as usize;
            assert_eq!(pixels, prepared.pixels, "{host} {run}: aperture size");
            let xc = float64(&hulls.join(host).join(format!("{run}.xc.f64")), pixels);
            let yc = float64(&hulls.join(host).join(format!("{run}.yc.f64")), pixels);
            let grid = |port: &[f64], matlab: &[f64]| port.iter().zip(matlab).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
            assert_eq!((grid(&prepared.xc, &xc), grid(&prepared.yc, &yc)), (0, 0), "{host} {run}: pixels off MATLAB's grid");
            let ys = float64(&courses.join(host).join(course["file"].as_str().unwrap()), roi.len() * volumes);
            let values: Vec<&str> = entry["values"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            for name in ["x0", "y0", "Fwhm"] {
                assert_eq!(values.iter().filter(|v| **v == name).count(), 1, "{run}: map {name}");
            }
            let data = float64(&hulls.join(host).join(format!("{run}.data.f64")), roi.len() * values.len());
            let raw = float64(&hulls.join(host).join(format!("{run}.raw.f64")), roi.len() * 5);
            for (position, y) in ys.chunks(volumes).enumerate() {
                let (production_row, production_profile) = production.reverse_correlate(y);
                for value in production.convex_hull(&production_row, &production_profile) {
                    production_bits.update(value.to_le_bytes());
                }
                if host != "amd" {
                    continue;
                }
                let (row, profile) = prepared.reverse_correlate(y);
                assert_eq!(row.map(f64::to_bits), [0, 1, 2, 3, 4].map(|r| raw[position * 5 + r].to_bits()), "{run} vertex {position}: peak row");
                let hull = prepared.convex_hull(&row, &profile);
                let matlab = |name: &str| data[position * values.len() + values.iter().position(|v| *v == name).unwrap()];
                for (r, name) in ["x0", "y0"].iter().enumerate() {
                    assert_eq!(hull[r + 1].to_bits(), matlab(name).to_bits(), "{run} vertex {position} {name}: {} vs {}", hull[r + 1], matlab(name));
                }
                let (fwhm, expected) = (hull[3], matlab("Fwhm"));
                if FWHM_DIFFERS.contains(&(run, position)) {
                    assert!(fwhm.to_bits() != expected.to_bits() && ulps(fwhm, expected) <= 2, "{run} vertex {position} Fwhm: {fwhm} vs {expected}; update FWHM_DIFFERS");
                    differing.insert((run, position));
                } else {
                    assert_eq!(fwhm.to_bits(), expected.to_bits(), "{run} vertex {position} Fwhm: {fwhm} vs {expected}");
                }
            }
        }
        // Base 3f90ac124, all five output rows at every ROI vertex of both runs.
        let expected = if host == "amd" { "3e1e6c3d5022541150ad7c0000e5b21708336d1cc12211257662bf8b16ee3e1f" } else { "bbca770519d3403f398d817f53c0830d2f4b0d20a19e456135815e668e9b0a42" };
        assert_eq!(format!("{:x}", production_bits.finalize()), expected, "{host}: production RC hull bits changed");
    }
    assert_eq!(differing.len(), FWHM_DIFFERS.len(), "unvisited FWHM_DIFFERS entries");
}

#[test]
fn partial_fixture_configuration_is_refused() {
    assert!(configured([None, None, None]).is_none());
    assert!(configured([Some("r".into()), Some("c".into()), Some("h".into())]).is_some());
    for missing in 0..3 {
        let mut values = [Some(PathBuf::from("r")), Some(PathBuf::from("c")), Some(PathBuf::from("h"))];
        values[missing] = None;
        assert!(std::panic::catch_unwind(|| configured(values)).is_err(), "variable {missing} missing");
    }
}
