//! MATLAB R2023b `polyshape` area and centroid given MATLAB's own stored hull
//! vertices (`convhull(polyshape(P)).Vertices`): every hull of the four polygon
//! recordings on both hosts, bit for bit, the sign of zero included. This holds
//! `Hull::area` and `Hull::centroid` apart from the port's hull and vertex-order
//! model, which matlab_geometry.rs gates.
//!
//!   SAMSRF_MATLAB_GEOMETRY_DIR, SAMSRF_MATLAB_POLYSHAPE_PROBE_DIR,
//!   SAMSRF_MATLAB_POLYSHAPE_CAUSAL_DIR and SAMSRF_MATLAB_POLYSHAPE_REPRODUCERS_DIR:
//!   set all four or none; any other combination fails.
use samsrf_core::geometry::Hull;
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Each recording's variable and its hulls per host (polygons MATLAB did not
/// refuse whose hull has at least three vertices).
const RECORDINGS: [(&str, usize); 4] = [
    ("SAMSRF_MATLAB_GEOMETRY_DIR", 16_871),
    ("SAMSRF_MATLAB_POLYSHAPE_PROBE_DIR", 31_894),
    ("SAMSRF_MATLAB_POLYSHAPE_CAUSAL_DIR", 10_728),
    ("SAMSRF_MATLAB_POLYSHAPE_REPRODUCERS_DIR", 27_805),
];

fn configured(values: [Option<OsString>; 4]) -> Option<Vec<(PathBuf, usize)>> {
    let set = values.iter().filter(|value| value.is_some()).count();
    match set {
        0 => None,
        4 => Some(values.into_iter().zip(RECORDINGS).map(|(value, (_, hulls))| (PathBuf::from(value.unwrap()), hulls)).collect()),
        _ => panic!("set all of {:?} or none", RECORDINGS.map(|(name, _)| name)),
    }
}

fn recordings() -> Option<Vec<(PathBuf, usize)>> {
    configured(RECORDINGS.map(|(name, _)| std::env::var_os(name)))
}

fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let bytes = std::fs::read(root.join(descriptor["file"].as_str().unwrap())).unwrap();
    let count: usize = descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).product();
    assert_eq!(bytes.len(), count * 8, "{}", descriptor["file"]);
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

/// Every recorded hull with three or more vertices: its vertices in MATLAB's
/// stored order and MATLAB's `[centroid x, centroid y, area]`.
fn stored_hulls(host: &Path) -> Vec<(String, Vec<[f64; 2]>, [f64; 3])> {
    let listing: Value = serde_json::from_slice(&std::fs::read(host.join("geometry.json")).unwrap()).unwrap();
    let mut hulls = Vec::new();
    for case in listing["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "polygon-batch") {
        let vertices = array(host, &case["hull"]);
        let rows = vertices.len() / 2;
        let counts = array(host, &case["hullCounts"]);
        let estimate = array(host, &case["estimate"]);
        let error = array(host, &case["error"]);
        let n = counts.len();
        assert_eq!(estimate.len(), 3 * n);
        let mut offset = 0;
        for i in 0..n {
            let count = counts[i] as usize;
            let hull: Vec<[f64; 2]> = (offset..offset + count).map(|r| [vertices[r], vertices[rows + r]]).collect();
            offset += count;
            if error[i] == 0.0 && count >= 3 {
                hulls.push((format!("{} {} {i}", host.display(), case["id"].as_str().unwrap()), hull, [estimate[i], estimate[n + i], estimate[2 * n + i]]));
            }
        }
        assert_eq!(offset, rows, "{}: hull rows", case["id"]);
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

#[test]
fn stored_hulls_have_matlabs_area_and_centroid_bits() {
    let Some(recordings) = recordings() else { return; };
    for (root, expected) in recordings {
        for host in ["ubuntu-22.04", "ubuntu-24.04"] {
            let hulls = stored_hulls(&root.join(host));
            assert_eq!(hulls.len(), expected, "{}/{host}: recorded hulls", root.display());
            let differing: Vec<String> = hulls.iter().filter(|(_, vertices, matlab)| bits(port(vertices)) != bits(*matlab)).map(|(id, vertices, matlab)| format!("{id}: port {:?}, MATLAB {matlab:?}", port(vertices))).collect();
            assert!(differing.is_empty(), "{} of {expected} hulls differ:\n{}", differing.len(), differing[..differing.len().min(10)].join("\n"));
        }
    }
}

/// The gate sees the vertex order: starting the geometry recording's hulls one
/// vertex later changes the bits of 1,024 of its 16,871.
#[test]
fn another_starting_vertex_rounds_differently() {
    let Some(recordings) = recordings() else { return; };
    let (root, _) = &recordings[0];
    let hulls = stored_hulls(&root.join("ubuntu-22.04"));
    let rotated = hulls.iter().filter(|(_, vertices, matlab)| {
        let mut shifted = vertices.clone();
        shifted.rotate_left(1);
        bits(port(&shifted)) != bits(*matlab)
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
