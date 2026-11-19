//! MATLAB R2023b `polyshape` area and centroid given MATLAB's own stored hull
//! vertices (`convhull(polyshape(P)).Vertices`): every hull of the four polygon
//! recordings on both hosts, bit for bit, the sign of zero included. This holds
//! `Hull::area` and `Hull::centroid` apart from the port's hull and vertex-order
//! model, which matlab_geometry.rs gates.
//!
//!   SAMSRF_MATLAB_GEOMETRY_DIR, SAMSRF_MATLAB_POLYSHAPE_PROBE_DIR,
//!   SAMSRF_MATLAB_POLYSHAPE_CAUSAL_DIR and SAMSRF_MATLAB_POLYSHAPE_REPRODUCERS_DIR:
//!   set all four or none; any other combination fails.
//!
//! The recordings are read as record_geometry.m writes them, and anything else
//! is refused: each recording's mode and polygon families, in order and once
//! each; every array a real MATLAB double named after its family, with the
//! recorded shape and byte length; whole-number counts and error indexes that
//! account for every row.
use samsrf_core::geometry::Hull;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// What record_geometry.m writes for one recording: its `mode` (absent in the
/// full geometry recording) and its `polygon_batch` families in order.
struct Recording {
    variable: &'static str,
    mode: Option<&'static str>,
    families: &'static [&'static str],
    /// Polygons MATLAB did not refuse whose hull has vertices, per host.
    hulls: usize,
}

const RECORDINGS: [Recording; 4] = [
    Recording {
        variable: "SAMSRF_MATLAB_GEOMETRY_DIR",
        mode: None,
        families: &["polygon_boundary_ulp", "polygon_boundary_relative", "polygon_random_thin", "polygon_collinear_vertex", "polygon_spikes", "polygon_degenerate", "polygon_point_clouds"],
        hulls: 16_871,
    },
    Recording {
        variable: "SAMSRF_MATLAB_POLYSHAPE_PROBE_DIR",
        mode: Some("polyshape-probe"),
        families: &["probe_grid_sweep", "probe_grid_bisection", "probe_heldout_collinear", "probe_heldout_clouds", "probe_extreme_grids", "probe_point_clouds"],
        hulls: 31_894,
    },
    Recording {
        variable: "SAMSRF_MATLAB_POLYSHAPE_CAUSAL_DIR",
        mode: Some("polyshape-causal"),
        families: &["causal_gap_sweep", "causal_gap_bisection", "causal_hole_contact", "causal_real", "causal_heldout"],
        hulls: 10_728,
    },
    Recording {
        variable: "SAMSRF_MATLAB_POLYSHAPE_REPRODUCERS_DIR",
        mode: Some("polyshape-reproducers"),
        families: &["reproducer_cases", "reproducer_round2", "reproducer_round3", "reproducer_round4", "reproducer_round5", "reproducer_round6", "reproducer_round7"],
        hulls: 27_805,
    },
];

fn configured(values: [Option<OsString>; 4]) -> Option<Vec<(PathBuf, &'static Recording)>> {
    let set = values.iter().filter(|value| value.is_some()).count();
    match set {
        0 => None,
        4 => Some(values.into_iter().zip(&RECORDINGS).map(|(value, recording)| (PathBuf::from(value.unwrap()), recording)).collect()),
        _ => panic!("set all of {:?} or none", RECORDINGS.map(|recording| recording.variable)),
    }
}

fn recordings() -> Option<Vec<(PathBuf, &'static Recording)>> {
    configured(RECORDINGS.map(|recording| std::env::var_os(recording.variable)))
}

/// One array as `array_file` describes it: a real MATLAB double, `[rows, columns]`,
/// in `<family>_<suffix>.f64`, column-major float64.
fn array(root: &Path, case: &Value, field: &str, suffix: &str, columns: u64) -> (usize, Vec<f64>) {
    let id = case["id"].as_str().unwrap();
    let descriptor = case[field].as_object().unwrap_or_else(|| panic!("{id}: no {field}"));
    let mut keys: Vec<&str> = descriptor.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["class", "file", "imaginary", "shape"], "{id} {field}: descriptor");
    assert_eq!(descriptor["class"], "double", "{id} {field}: class");
    assert_eq!(descriptor["imaginary"], "", "{id} {field}: imaginary part");
    let file = format!("{id}_{suffix}.f64");
    assert_eq!(descriptor["file"], file.as_str(), "{id} {field}: file");
    let shape: Vec<u64> = descriptor["shape"].as_array().unwrap_or_else(|| panic!("{id} {field}: shape")).iter().map(|n| n.as_u64().unwrap_or_else(|| panic!("{id} {field}: shape {n}"))).collect();
    assert!(shape.len() == 2 && shape[1] == columns, "{id} {field}: shape {shape:?}, expected [rows, {columns}]");
    let count = usize::try_from(shape[0] * columns).unwrap();
    let bytes = std::fs::read(root.join(&file)).unwrap_or_else(|error| panic!("{}: {error}", root.join(&file).display()));
    assert_eq!(bytes.len(), count * 8, "{file}: bytes");
    (shape[0] as usize, bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect())
}

/// A count or index MATLAB stored as a double.
fn whole(value: f64, what: &str) -> usize {
    assert!(value >= 0.0 && value.fract() == 0.0 && value < 2f64.powi(53), "{what}: {value} is not a whole number");
    value as usize
}

struct StoredHull {
    id: String,
    vertices: Vec<[f64; 2]>,
    matlab: [f64; 3],
}

/// One host's hulls with vertices: MATLAB's stored order and its
/// `[centroid x, centroid y, area]`. Refused polygons must have no hull, and empty
/// hulls MATLAB's empty-shape estimate `[NaN, NaN, 0]`.
fn stored_hulls(host: &Path, recording: &Recording) -> Vec<StoredHull> {
    let listing: Value = serde_json::from_slice(&std::fs::read(host.join("geometry.json")).unwrap()).unwrap();
    assert_eq!(listing.get("mode").map(|mode| mode.as_str().unwrap()), recording.mode, "{}: mode", host.display());
    let cases = listing["cases"].as_array().unwrap();
    let mut ids: Vec<&str> = cases.iter().map(|case| case["id"].as_str().unwrap()).collect();
    let families: Vec<&str> = cases.iter().filter(|case| case["kind"] == "polygon-batch").map(|case| case["id"].as_str().unwrap()).collect();
    assert_eq!(families, recording.families, "{}: polygon families", host.display());
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), cases.len(), "{}: case ids repeat", host.display());
    let mut hulls = Vec::new();
    for case in cases.iter().filter(|case| case["kind"] == "polygon-batch") {
        let id = case["id"].as_str().unwrap();
        let n = usize::try_from(case["cases"].as_u64().unwrap_or_else(|| panic!("{id}: cases"))).unwrap();
        let (rows, vertices) = array(host, case, "hull", "hull", 2);
        let (count_rows, counts) = array(host, case, "hullCounts", "hull_counts", 1);
        let (estimate_rows, estimate) = array(host, case, "estimate", "estimate", 3);
        let (error_rows, error) = array(host, case, "error", "error", 1);
        assert_eq!([count_rows, estimate_rows, error_rows], [n; 3], "{id}: rows per polygon");
        let errors = case["errors"].as_array().unwrap_or_else(|| panic!("{id}: errors")).len();
        let mut offset = 0;
        for i in 0..n {
            let count = whole(counts[i], &format!("{id} hull count {i}"));
            let failed = whole(error[i], &format!("{id} error {i}"));
            assert!(failed <= errors, "{id} {i}: error {failed} of {errors}");
            assert!(offset + count <= rows, "{id}: hull rows");
            let hull: Vec<[f64; 2]> = (offset..offset + count).map(|r| [vertices[r], vertices[rows + r]]).collect();
            offset += count;
            let matlab = [estimate[i], estimate[n + i], estimate[2 * n + i]];
            match (failed, count) {
                (0, 0) => assert_eq!(bits(matlab), bits([f64::NAN, f64::NAN, 0.0]), "{id} {i}: empty hull"),
                (0, 1..=2) => panic!("{id} {i}: a hull of {count} vertices"),
                (0, _) => hulls.push(StoredHull { id: format!("{} {id} {i}", host.display()), vertices: hull, matlab }),
                _ => assert_eq!(count, 0, "{id} {i}: refused polygon with a hull"),
            }
        }
        assert_eq!(offset, rows, "{id}: hull rows");
    }
    hulls
}

fn bits(values: [f64; 3]) -> [u64; 3] {
    values.map(|value| if value.is_nan() { f64::NAN.to_bits() } else { value.to_bits() })
}

fn port(vertices: &[[f64; 2]]) -> [f64; 3] {
    let hull = Hull { vertices: vertices.to_vec() };
    let [x, y] = hull.centroid();
    [x, y, hull.area()]
}

fn differing(hulls: &[StoredHull]) -> Vec<String> {
    hulls.iter().filter(|hull| bits(port(&hull.vertices)) != bits(hull.matlab)).map(|hull| format!("{}: port {:?}, MATLAB {:?}", hull.id, port(&hull.vertices), hull.matlab)).collect()
}

#[test]
fn stored_hulls_have_matlabs_area_and_centroid_bits() {
    let Some(recordings) = recordings() else { return; };
    for (root, recording) in recordings {
        for host in ["ubuntu-22.04", "ubuntu-24.04"] {
            let hulls = stored_hulls(&root.join(host), recording);
            assert_eq!(hulls.len(), recording.hulls, "{}/{host}: recorded hulls", root.display());
            let differing = differing(&hulls);
            assert!(differing.is_empty(), "{} of {} hulls differ:\n{}", differing.len(), recording.hulls, differing[..differing.len().min(10)].join("\n"));
        }
    }
}

/// The gate sees the vertex order: starting the geometry recording's hulls one
/// vertex later changes the bits of 1,024 of its 16,871.
#[test]
fn another_starting_vertex_rounds_differently() {
    let Some(recordings) = recordings() else { return; };
    let (root, recording) = &recordings[0];
    let hulls = stored_hulls(&root.join("ubuntu-22.04"), recording);
    let rotated = hulls.iter().filter(|hull| {
        let mut shifted = hull.vertices.clone();
        shifted.rotate_left(1);
        bits(port(&shifted)) != bits(hull.matlab)
    }).count();
    assert_eq!(rotated, 1_024, "hulls that change when started one vertex later, of {}", hulls.len());
}

#[test]
fn partial_fixture_configuration_is_refused() {
    assert!(configured([None, None, None, None]).is_none());
    let all = configured(["g", "p", "c", "r"].map(|dir| Some(OsString::from(dir)))).unwrap();
    assert_eq!(all.iter().map(|(dir, _)| dir.to_str().unwrap()).collect::<Vec<_>>(), ["g", "p", "c", "r"]);
    for missing in 0..4 {
        let mut values = ["g", "p", "c", "r"].map(|dir| Some(OsString::from(dir)));
        values[missing] = None;
        assert!(std::panic::catch_unwind(|| configured(values)).is_err(), "recording {missing} missing");
    }
}

const SYNTHETIC: Recording = Recording { variable: "", mode: Some("polyshape-probe"), families: &["probe_one"], hulls: 1 };

/// A recording as record_geometry.m writes it: one family of three polygons, a
/// triangle MATLAB recorded (geometry.rs's unit test), an empty hull and a
/// refused polygon. `change` edits the listing and the arrays before they are written.
fn synthetic(directory: &Path, change: impl FnOnce(&mut Value, &mut Vec<(String, Vec<f64>)>)) {
    let describe = |suffix: &str, rows: usize, columns: usize| json!({"file": format!("probe_one_{suffix}.f64"), "shape": [rows, columns], "class": "double", "imaginary": ""});
    let mut listing = json!({"mode": "polyshape-probe", "cases": [{
        "id": "probe_one", "kind": "polygon-batch", "cases": 3,
        "hull": describe("hull", 3, 2), "hullCounts": describe("hull_counts", 3, 1),
        "estimate": describe("estimate", 3, 3), "error": describe("error", 3, 1),
        "errors": ["MATLAB:polyshape:refused: refused"],
    }]});
    let nan = f64::NAN;
    let mut arrays = vec![
        ("probe_one_hull.f64".to_string(), vec![0.0, 1.0, 1.0, 0.0, 1.0, 0.0]),
        ("probe_one_hull_counts.f64".to_string(), vec![3.0, 0.0, 0.0]),
        ("probe_one_estimate.f64".to_string(), vec![0.6666666666666666, nan, nan, 0.33333333333333337, nan, nan, 0.5, 0.0, nan]),
        ("probe_one_error.f64".to_string(), vec![0.0, 0.0, 1.0]),
    ];
    change(&mut listing, &mut arrays);
    std::fs::create_dir_all(directory).unwrap();
    std::fs::write(directory.join("geometry.json"), serde_json::to_vec(&listing).unwrap()).unwrap();
    for (file, values) in arrays {
        std::fs::write(directory.join(file), values.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    }
}

#[test]
fn malformed_recordings_are_refused() {
    let root = std::env::temp_dir().join(format!("samsrf-polyshape-arithmetic-{}", std::process::id()));
    let accepted = root.join("accepted");
    synthetic(&accepted, |_, _| {});
    let hulls = stored_hulls(&accepted, &SYNTHETIC);
    assert_eq!((hulls.len(), differing(&hulls).len()), (1, 0));
    type Change = fn(&mut Value, &mut Vec<(String, Vec<f64>)>);
    let changes: [(&str, &str, Change); 17] = [
        ("single class", "hull: class", |l, _| l["cases"][0]["hull"]["class"] = json!("single")),
        ("imaginary part", "imaginary part", |l, _| l["cases"][0]["hull"]["imaginary"] = json!("probe_one_hull_imaginary.f64")),
        ("descriptor key", "hull: descriptor", |l, _| l["cases"][0]["hull"]["extra"] = json!(1)),
        ("transposed hull", "expected [rows, 2]", |l, _| l["cases"][0]["hull"]["shape"] = json!([2, 3])),
        ("fractional shape", "hull: shape 3.0", |l, _| l["cases"][0]["hull"]["shape"] = json!([3.0, 2])),
        ("swapped files", "estimate: file", |l, _| l["cases"][0]["estimate"]["file"] = json!("probe_one_hull.f64")),
        ("renamed family", "polygon families", |l, _| l["cases"][0]["id"] = json!("probe_two")),
        ("extra family", "polygon families", |l, _| {
            let copy = l["cases"][0].clone();
            l["cases"].as_array_mut().unwrap().push(copy);
        }),
        ("other mode", ": mode", |l, _| l["mode"] = json!("polyshape-causal")),
        ("polygon count", "rows per polygon", |l, _| l["cases"][0]["cases"] = json!(2)),
        ("fractional count", "is not a whole number", |_, a| a[1].1[0] += 0.25),
        ("two-vertex hull", "a hull of 2 vertices", |_, a| a[1].1 = vec![2.0, 1.0, 0.0]),
        ("unconsumed rows", "probe_one: hull rows", |l, a| {
            l["cases"][0]["hull"]["shape"] = json!([4, 2]);
            a[0].1 = vec![0.0, 1.0, 1.0, 5.0, 0.0, 1.0, 0.0, 5.0];
        }),
        ("unknown error", "error 2 of 1", |_, a| a[3].1[2] = 2.0),
        ("refused with a hull", "refused polygon with a hull", |l, a| {
            l["cases"][0]["hull"]["shape"] = json!([6, 2]);
            a[0].1 = vec![0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0];
            a[1].1 = vec![3.0, 0.0, 3.0];
        }),
        ("empty hull estimate", "empty hull", |_, a| a[2].1[1] = 0.5),
        ("short file", "probe_one_hull.f64: bytes", |_, a| {
            a[0].1.pop();
        }),
    ];
    for (name, reason, change) in changes {
        let directory = root.join(name.replace(' ', "-"));
        synthetic(&directory, change);
        let refusal = std::panic::catch_unwind(|| stored_hulls(&directory, &SYNTHETIC)).err().unwrap_or_else(|| panic!("{name} accepted"));
        let message = refusal.downcast_ref::<String>().cloned().or_else(|| refusal.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
        assert!(message.contains(reason), "{name} refused for another reason: {message}");
    }
    let flipped = root.join("estimate-bit");
    synthetic(&flipped, |_, a| a[2].1[0] = f64::from_bits(a[2].1[0].to_bits() ^ 1));
    assert_eq!(differing(&stored_hulls(&flipped, &SYNTHETIC)).len(), 1, "a changed estimate bit");
    std::fs::remove_dir_all(&root).unwrap();
}
