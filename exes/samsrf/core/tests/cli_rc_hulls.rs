//! The SamSrfAnalysis reverse-correlation hull runs of the pinned recording
//! (`cli-reference.json`, 100 x 100 apertures), rebuilt from MATLAB's own
//! preprocessed courses. `SAMSRF_CLI_REFERENCE_DIR` is the extracted recording,
//! `SAMSRF_CLI_COURSES_DIR` the output of `extract_cli_courses.py` on it and
//! `SAMSRF_CLI_RC_HULLS_DIR` the output of `extract_cli_rc_hulls.py`; set all three
//! or none.
//!
//! Production (`HullOrder::Anchored`) and `HullOrder::Stored` now both use
//! MATLAB's symmetric pixel grid (`symmetric_linspace`), stored Delaunay
//! boundary centroid (`Hull::of_delaunay_boundary`) and `convexHull` area
//! (`delaunay_convex_hull_area`). On both hosts the pixel grid equals the `xc`
//! and `yc` MATLAB saved at every pixel, and on the AMD host, where the
//! profiles are MATLAB's, the peak, hull centroid and `Fwhm` match MATLAB's
//! bits at every ROI vertex of both runs.
use samsrf_core::hrf::{self, ResolvedHrf};
use samsrf_core::model::{parse_model_json, AnalysisKind, Model};
use samsrf_core::geometry::{delaunay_convex_hull_area, HullOrder};
use samsrf_core::{mat, revcor_prf};
use serde_json::Value;
use std::path::{Path, PathBuf};

const RUNS: [&str; 2] = ["rc_hull_lh_double", "rc_custom_hrf_lh_double"];

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
    assert_eq!(hull_manifest.as_object().unwrap().keys().collect::<Vec<_>>(), ["amd", "intel"], "extracted hosts");
    for (host, bundle) in [("amd", recording.join("bundle")), ("intel", recording.join("ubuntu-24.04").join("bundle"))] {
        let extracted = hull_manifest[host].as_array().unwrap();
        assert_eq!(extracted.iter().map(|run| run["id"].as_str().unwrap()).collect::<Vec<_>>(), RUNS, "{host}: extracted runs");
        for entry in extracted {
            let run = entry["id"].as_str().unwrap();
            let course = course_manifest["hosts"][host]["runs"].as_array().unwrap().iter().find(|r| r["id"] == run).unwrap_or_else(|| panic!("{host} {run}: no courses"));
            let volumes = course["volumes"].as_u64().unwrap() as usize;
            let roi = vertex_numbers(&entry["roi"], &format!("{host} {run} maps"));
            assert_eq!(roi, vertex_numbers(&course["roi"], &format!("{host} {run} courses")), "{host} {run}: ROI of courses and maps");
            let production = prepared(&bundle, run, volumes);
            let stored = production.clone().with_hull_order(HullOrder::Stored);
            let pixels = entry["rows"].as_u64().unwrap() as usize * entry["columns"].as_u64().unwrap() as usize;
            assert_eq!(pixels, production.pixels, "{host} {run}: aperture size");
            let xc = float64(&hulls.join(host).join(format!("{run}.xc.f64")), pixels);
            let yc = float64(&hulls.join(host).join(format!("{run}.yc.f64")), pixels);
            let grid = |port: &[f64], matlab: &[f64]| port.iter().zip(matlab).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
            assert_eq!((grid(&production.xc, &xc), grid(&production.yc, &yc)), (0, 0), "{host} {run}: production pixels off MATLAB's grid");
            assert_eq!((grid(&stored.xc, &xc), grid(&stored.yc, &yc)), (0, 0), "{host} {run}: stored pixels off MATLAB's grid");
            let ys = float64(&courses.join(host).join(course["file"].as_str().unwrap()), roi.len() * volumes);
            let values: Vec<&str> = entry["values"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            for name in ["x0", "y0", "Fwhm"] {
                assert_eq!(values.iter().filter(|v| **v == name).count(), 1, "{run}: map {name}");
            }
            let data = float64(&hulls.join(host).join(format!("{run}.data.f64")), roi.len() * values.len());
            let raw = float64(&hulls.join(host).join(format!("{run}.raw.f64")), roi.len() * 5);
            for (position, y) in ys.chunks(volumes).enumerate() {
                let (production_row, production_profile) = production.reverse_correlate(y);
                let production_hull = production.convex_hull(&production_row, &production_profile);
                let (stored_row, stored_profile) = stored.reverse_correlate(y);
                let stored_hull = stored.convex_hull(&stored_row, &stored_profile);
                assert_eq!(
                    production_hull.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                    stored_hull.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                    "{host} {run} vertex {position}: production and stored RC hull differ"
                );
                if host != "amd" {
                    continue;
                }
                assert_eq!(production_row.map(f64::to_bits), [0, 1, 2, 3, 4].map(|r| raw[position * 5 + r].to_bits()), "{run} vertex {position}: peak row");
                let matlab = |name: &str| data[position * values.len() + values.iter().position(|v| *v == name).unwrap()];
                for (r, name) in ["x0", "y0", "Fwhm"].iter().enumerate() {
                    assert_eq!(production_hull[r + 1].to_bits(), matlab(name).to_bits(), "{run} vertex {position} {name}: {} vs {}", production_hull[r + 1], matlab(name));
                }
            }
        }
    }
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

/// Every `convexHull(delaunayTriangulation(P))` area `AV` and corner-hull area
/// `cornersArea` in round hull-area-1 (424 point sets on both AMD and Intel hosts).
#[test]
fn delaunay_convex_hull_area_matches_round_hull_area_1() {
    let Some(root) = std::env::var_os("SAMSRF_HULL_AREA_DIR").map(PathBuf::from) else { return };
    for host in ["ubuntu-22.04", "ubuntu-24.04"] {
        let dir = root.join(host);
        let recording = json(&dir.join("geometry.json"));
        let mut checked = 0usize;
        for case in recording["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "hull-area") {
            let id = case["id"].as_str().unwrap();
            let shape = case["dtPoints"]["shape"].as_array().unwrap();
            let rows = shape[0].as_u64().unwrap() as usize;
            assert_eq!(shape[1].as_u64().unwrap(), 2, "{host} {id}: point width");
            let raw_pts = float64(&dir.join(case["dtPoints"]["file"].as_str().unwrap()), rows * 2);
            let pts: Vec<[f64; 2]> = (0..rows).map(|i| [raw_pts[i], raw_pts[rows + i]]).collect();
            let expected_av = float64(&dir.join(case["area"]["file"].as_str().unwrap()), 1)[0];
            let actual_av = delaunay_convex_hull_area(&pts).unwrap_or_else(|| panic!("{host} {id}: empty hull"));
            assert_eq!(actual_av.to_bits(), expected_av.to_bits(), "{host} {id}: AV {actual_av} vs {expected_av}");
            let k_len = case["hull"]["shape"][0].as_u64().unwrap() as usize;
            let k_vals = float64(&dir.join(case["hull"]["file"].as_str().unwrap()), k_len);
            let corner_pts: Vec<[f64; 2]> = k_vals[..k_len - 1].iter().map(|&idx| pts[idx as usize - 1]).collect();
            let expected_cav = float64(&dir.join(case["cornersArea"]["file"].as_str().unwrap()), 1)[0];
            let actual_cav = delaunay_convex_hull_area(&corner_pts).unwrap_or_else(|| panic!("{host} {id}: empty corner hull"));
            assert_eq!(actual_cav.to_bits(), expected_cav.to_bits(), "{host} {id}: cornersArea {actual_cav} vs {expected_cav}");
            checked += 1;
        }
        assert_eq!(checked, 424, "{host}: hull-area-1 inventory");
    }
}
