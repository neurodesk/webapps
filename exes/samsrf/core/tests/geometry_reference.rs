//! The mesh neighbourhood (`samsrf_georoi`) and the convex-hull cluster path of
//! `samsrf_cfparam_loop` against the cases the Octave harness records in
//! `<SAMSRF_REFERENCE_DIR>/analyses/georoi.json` and `convexhull_cases.json`.
//!
//!   SAMSRF_REFERENCE_DIR=/storage/scratch/samsrf-work/reference \
//!   SAMSRF_WEBAPP_EXAMPLE_DIR=/storage/scratch/samsrf-work/example \
//!     cargo test --release --test geometry_reference -- --ignored

use samsrf_core::freesurfer;
use samsrf_core::geometry::{cluster_roi, unique_rows, Hull, Triangulation};
use samsrf_core::mesh::Adjacency;
use serde_json::Value;

fn reference(name: &str) -> Value {
    let dir = std::env::var("SAMSRF_REFERENCE_DIR").expect("SAMSRF_REFERENCE_DIR");
    let text = std::fs::read_to_string(format!("{dir}/analyses/{name}")).unwrap_or_else(|_| panic!("{dir}/analyses/{name}"));
    serde_json::from_str(&text).expect("valid JSON")
}

fn numbers(value: &Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect()
}

fn indices(value: &Value) -> Vec<usize> {
    value.as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect()
}

#[test]
#[ignore = "needs the Octave reference and the example surface"]
fn georoi_matches_samsrf() {
    let dir = std::env::var("SAMSRF_WEBAPP_EXAMPLE_DIR").expect("SAMSRF_WEBAPP_EXAMPLE_DIR");
    let white = freesurfer::read_surface(&std::fs::read(format!("{dir}/lh.white")).unwrap()).unwrap();
    let adjacency = Adjacency::new(white.vertices.len(), &white.faces);
    for case in reference("georoi.json")["cases"].as_array().unwrap() {
        let vertex = case["vertex"].as_u64().unwrap() as u32;
        let steps = case["steps"].as_u64().unwrap() as usize;
        let (vertices, distances) = adjacency.geo_roi(vertex, steps);
        let expected_vertices: Vec<u32> = indices(&case["vs"]).into_iter().map(|v| v as u32).collect();
        assert_eq!(vertices, expected_vertices, "vertex set of {vertex}");
        assert_eq!(distances, numbers(&case["ds"]), "distances of {vertex}");
    }
}

#[test]
#[ignore = "needs the Octave reference"]
fn convex_hull_clusters_match_samsrf() {
    for case in reference("convexhull_cases.json")["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let points: Vec<[f64; 2]> = case["points"].as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]).collect();
        let statistic = numbers(&case["statistic"]);
        let (unique, first) = unique_rows(&points);
        let expected_unique: Vec<[f64; 2]> = case["unique_points"].as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]).collect();
        assert_eq!(unique, expected_unique, "{name}: unique rows");
        assert_eq!(first, indices(&case["unique_order"]), "{name}: unique order");
        let unique_statistic: Vec<f64> = first.iter().map(|&i| statistic[i]).collect();
        assert_eq!(unique_statistic, numbers(&case["unique_statistic"]), "{name}: unique statistic");
        let threshold = case["threshold"].as_f64().unwrap();
        let peak = unique_statistic.iter().position(|&v| v == unique_statistic.iter().cloned().fold(f64::NAN, f64::max)).unwrap();
        let triangulation = Triangulation::delaunay(&unique);
        let mut cluster = cluster_roi(peak, &unique_statistic, threshold, &triangulation);
        cluster.sort_unstable();
        let mut expected_cluster = indices(&case["pos"]);
        expected_cluster.sort_unstable();
        assert_eq!(cluster, expected_cluster, "{name}: cluster");
        let hull_points: Vec<[f64; 2]> = cluster.iter().map(|&i| unique[i]).collect();
        let expected_area = case["area"].as_f64().unwrap();
        let expected_centroid = numbers(&case["centroid"]);
        match Hull::of(&hull_points) {
            Some(hull) => {
                assert!((hull.area() - expected_area).abs() < 1e-12, "{name}: area {} vs {expected_area}", hull.area());
                let [cx, cy] = hull.centroid();
                assert!((cx - expected_centroid[0]).abs() < 1e-12 && (cy - expected_centroid[1]).abs() < 1e-12, "{name}: centroid {cx} {cy} vs {expected_centroid:?}");
            }
            None => {
                assert_eq!(expected_area, 0.0, "{name}: degenerate hull");
                assert!(expected_centroid.iter().all(|v| v.is_nan()), "{name}: degenerate centroid");
            }
        }
    }
}
