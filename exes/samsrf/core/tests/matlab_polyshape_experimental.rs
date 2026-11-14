//! Gates of the experimental Clipper-based polyshape model
//! (`samsrf_core::experimental`, feature `polyshape-experimental`) against real
//! MATLAB R2023b recordings: the original geometry recording
//! (SAMSRF_MATLAB_GEOMETRY_DIR), the focused grid probe
//! (SAMSRF_MATLAB_POLYSHAPE_PROBE_DIR) and the causal probe
//! (SAMSRF_MATLAB_POLYSHAPE_CAUSAL_DIR). These baselines are the experimental
//! model's own; the production model's gates and frozen outcomes are in
//! matlab_geometry.rs and matlab_polygon_snapping.json.
//!   cargo test --release --features polyshape-experimental --test matlab_polyshape_experimental
use samsrf_core::experimental::{hull_of_polygon, polyshape_vertices};
use samsrf_core::geometry::Hull;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn load(root: &Path, name: &str) -> Vec<Value> {
    let metadata: Value = serde_json::from_slice(&std::fs::read(root.join(name)).unwrap()).unwrap();
    metadata["cases"].as_array().unwrap().clone()
}

fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let bytes = std::fs::read(root.join(descriptor["file"].as_str().unwrap())).unwrap();
    let count: usize = descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).product();
    assert_eq!(bytes.len(), count * 8);
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn shape(descriptor: &Value) -> Vec<usize> {
    descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).collect()
}

/// Both hosts' recordings, which are identical array for array; each is checked.
fn geometry_hosts() -> Vec<(PathBuf, Vec<Value>)> {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_GEOMETRY_DIR").map(PathBuf::from) else { return Vec::new() };
    ["ubuntu-22.04", "ubuntu-24.04"].iter().map(|host| {
        let dir = root.join(host);
        let cases = load(&dir, "geometry.json");
        (dir, cases)
    }).collect()
}

/// A column-major MATLAB n x 2 array as points.
fn points(values: &[f64]) -> Vec<[f64; 2]> {
    assert_eq!(values.len() % 2, 0, "incomplete point row");
    let n = values.len() / 2;
    (0..n).map(|i| [values[i], values[n + i]]).collect()
}
/// A recorded family: its id, its polygons and MATLAB's column-major
/// `[centroid x, centroid y, area]` of each `polyshape(P).convhull`.
type PolygonBatch = (String, Vec<Vec<[f64; 2]>>, Vec<f64>, Vec<Vec<[f64; 2]>>);

fn polygon_batches(root: &Path, cases: &[Value]) -> Vec<PolygonBatch> {
    cases.iter().filter(|c| c["kind"] == "polygon-batch").map(|case| {
        let all = points(&array(root, &case["points"]));
        let counts = array(root, &case["counts"]);
        let mut offset = 0;
        let polygons = counts.iter().map(|&n| {
            let polygon = all[offset..offset + n as usize].to_vec();
            offset += n as usize;
            polygon
        }).collect();
        let vertices = points(&array(root, &case["hull"]));
        let mut offset = 0;
        let hulls = array(root, &case["hullCounts"]).iter().map(|&n| {
            let hull = vertices[offset..offset + n as usize].to_vec();
            offset += n as usize;
            hull
        }).collect();
        assert_eq!(offset, vertices.len());
        (case["id"].as_str().unwrap().to_string(), polygons, array(root, &case["estimate"]), hulls)
    }).collect()
}

/// A hull's vertices in a fixed order, so equal hulls compare equal bit for bit
/// whatever their winding or starting vertex.
fn sorted_vertices(vertices: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut result = vertices.to_vec();
    result.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    result
}

/// Forward-error bounds of the shoelace area and centroid evaluated on the
/// untranslated vertices, as MATLAB's `area` and `centroid` do (their hull
/// vertices are checked first, after removing roundoff-collinear points). With
/// unit roundoff u and n vertices, each cross term carries at most 2u relative
/// error and each sum n u, so |dA| <= 2 n u sum(|x_i y_j| + |x_j y_i|) / 2,
/// doubled for headroom; the centroid adds its numerator's bound and the
/// propagated area error.
fn uncentred_error_bound(vertices: &[[f64; 2]], area: f64) -> [f64; 3] {
    let n = vertices.len() as f64;
    let u = f64::EPSILON / 2.0;
    let mut cross = 0.0;
    let mut moment = [0.0; 2];
    for i in 0..vertices.len() {
        let [x0, y0] = vertices[i];
        let [x1, y1] = vertices[(i + 1) % vertices.len()];
        let term = (x0 * y1).abs() + (x1 * y0).abs();
        cross += term;
        moment[0] += ((x0).abs() + (x1).abs()) * term;
        moment[1] += ((y0).abs() + (y1).abs()) * term;
    }
    let area_bound = 4.0 * (n + 2.0) * u * cross / 2.0;
    let relative = area_bound / area;
    let centroid = |axis: usize| 4.0 * (n + 3.0) * u * moment[axis] / (6.0 * area) + relative * moment[axis] / (6.0 * area);
    [centroid(0), centroid(1), area_bound]
}

/// The 44 near-collinear clouds (kind 3 of record_geometry.m's point clouds:
/// points within 1e-6 to 1e-10 of a line, in random order) whose experimental
/// hulls still differ. Clipper's union yields every vertex MATLAB keeps, but
/// MATLAB's default polyshape returns these clouds' touching slivers differently,
/// and the model does not reproduce which near-duplicate crossings remain. Each
/// must stay a near-collinear cloud and must still differ: a fix shortens this
/// list. Its outcome is separately frozen, not treated as MATLAB ground truth.
const NEAR_COLLINEAR_SNAPPING: [usize; 44] = [77, 102, 157, 177, 377, 387, 397, 512, 532, 557, 562, 737, 797, 822, 852, 932, 1027, 1162, 1192, 1237, 1257, 1322, 1382, 1392, 1607, 1622, 1777, 1782, 1817, 1922, 1937, 1982, 2087, 2102, 2147, 2167, 2212, 2272, 2292, 2317, 2337, 2357, 2382, 2457];

/// The clouds the production model matches and this model does not (#732 P1).
/// The experimental model cannot replace the production one while this is not
/// empty.
const REGRESSIONS: [usize; 4] = [177, 932, 1607, 1937];

#[test]
fn experimental_exceptions_are_production_exceptions_but_four_regressions() {
    let production: Value = serde_json::from_str(include_str!("matlab_polygon_snapping.json")).unwrap();
    let production: BTreeSet<usize> = production["outcomes"].as_object().unwrap().keys().map(|id| id.parse().unwrap()).collect();
    assert_eq!(production.len(), 93, "production snapping inventory");
    let experimental: BTreeSet<usize> = NEAR_COLLINEAR_SNAPPING.into_iter().collect();
    assert_eq!(experimental.difference(&production).copied().collect::<Vec<_>>(), REGRESSIONS);
}

/// The original recording's polygon families (thin triangles, spikes, degenerate
/// inputs and unordered clouds) on the experimental model: exactly MATLAB's hull
/// vertices, then area and centroid within MATLAB's uncentred error bound,
/// except NEAR_COLLINEAR_SNAPPING, whose outcomes are frozen in
/// matlab_polygon_snapping.experimental.json.
#[test]
fn experimental_polygon_hulls_match_matlab() {
    for (root, cases) in geometry_hosts() {
        polygon_hulls_match_matlab_on(&root, &cases);
    }
}

fn polygon_hulls_match_matlab_on(root: &Path, cases: &[Value]) {
    let frozen: Value = serde_json::from_str(include_str!("matlab_polygon_snapping.experimental.json")).unwrap();
    let outcomes = frozen["outcomes"].as_object().unwrap();
    let frozen_ids: BTreeSet<usize> = outcomes.keys().map(|id| id.parse().unwrap()).collect();
    assert_eq!(frozen_ids, NEAR_COLLINEAR_SNAPPING.into_iter().collect());
    let mut checked_snapping = BTreeSet::new();
    let mut report = Vec::new();
    let mut failures = Vec::new();
    let mut families = 0;
    for (id, polygons, estimate, expected_hulls) in polygon_batches(root, cases) {
        families += 1;
        let n = polygons.len();
        let mut agreeing = 0;
        for (i, polygon) in polygons.iter().enumerate() {
            let expected = [estimate[i], estimate[n + i], estimate[2 * n + i]];
            let hull = hull_of_polygon(polygon).unwrap_or_else(|e| panic!("{id} {i}: {e}"));
            let vertices = hull.as_ref().map(|h| h.vertices.as_slice()).unwrap_or(&[]);
            let agrees = sorted_vertices(vertices) == sorted_vertices(&expected_hulls[i]) && match &hull {
                None => expected[2] == 0.0 && expected[0].is_nan() && expected[1].is_nan(),
                Some(hull) => {
                    let (centre, area) = (hull.centroid(), hull.area());
                    let bound = uncentred_error_bound(&hull.vertices, area);
                    (0..2).all(|axis| (centre[axis] - expected[axis]).abs() <= bound[axis]) && (area - expected[2]).abs() <= bound[2]
                }
            };
            let snapping = id == "polygon_point_clouds" && NEAR_COLLINEAR_SNAPPING.contains(&i);
            if snapping {
                // record_geometry.m draws cloud kind mod(i, 5) for 1-based i.
                assert!((i + 1) % 5 == 3 && line_thickness(polygon) < 1e-5, "{id} {i} is not a near-collinear cloud");
                assert!(!agrees, "{id} {i} now matches MATLAB; remove it from NEAR_COLLINEAR_SNAPPING");
                let actual = frozen_hull_outcome(hull.as_ref());
                assert_eq!(&actual, &outcomes[&i.to_string()], "{id} {i}: frozen port outcome changed");
                checked_snapping.insert(i);
            } else if agrees {
                agreeing += 1;
            } else {
                failures.push(format!("{id} {i}: MATLAB hull {:?} {expected:?}, port {vertices:?}", expected_hulls[i]));
            }
        }
        report.push(format!("{id}: {agreeing} of {n} polygons equal MATLAB's"));
    }
    println!("{}", report.join("\n"));
    assert_eq!(families, 7, "missing polygon families");
    assert_eq!(checked_snapping, frozen_ids, "missing snapping regression cases");
    assert!(failures.is_empty(), "{} polygons differ from MATLAB:\n{}", failures.len(), failures[..failures.len().min(20)].join("\n"));
}

/// The largest distance of a point from the line through the two points
/// farthest apart, relative to their distance.
fn line_thickness(points: &[[f64; 2]]) -> f64 {
    let mut ends = (points[0], points[0]);
    let mut longest = 0.0;
    for a in points {
        for b in points {
            let d = (b[0] - a[0]).hypot(b[1] - a[1]);
            if d > longest {
                longest = d;
                ends = (*a, *b);
            }
        }
    }
    let (a, b) = ends;
    points.iter().map(|p| ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])).abs() / longest).fold(0.0, f64::max) / longest
}

/// The focused polyshape probe (record_geometry.m 'polyshape-probe'), on both
/// hosts: SAMSRF_MATLAB_POLYSHAPE_PROBE_DIR.
fn probe_hosts() -> Vec<(PathBuf, Vec<Value>)> {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_POLYSHAPE_PROBE_DIR").map(PathBuf::from) else { return Vec::new() };
    ["ubuntu-22.04", "ubuntu-24.04"].iter().map(|host| {
        let dir = root.join(host);
        let cases = load(&dir, "geometry.json");
        (dir, cases)
    }).collect()
}

fn split_rows(all: &[[f64; 2]], counts: &[f64]) -> Vec<Vec<[f64; 2]>> {
    let mut offset = 0;
    let result = counts.iter().map(|&n| {
        assert!(n.is_finite() && n >= 0.0 && n.fract() == 0.0, "invalid polygon row count: {n}");
        let n = n as usize;
        let rows = all[offset..offset + n].to_vec();
        offset += n;
        rows
    }).collect();
    assert_eq!(offset, all.len(), "unconsumed polygon rows");
    result
}

fn real_double_values(bytes: &[u8], descriptor: &Value) -> Vec<f64> {
    assert_eq!(descriptor["class"], "double", "real double recording required");
    assert_eq!(descriptor["imaginary"], "", "complex recording is not supported");
    let count = shape(descriptor).into_iter().try_fold(1usize, |n, dimension| n.checked_mul(dimension)).unwrap();
    assert_eq!(bytes.len(), count.checked_mul(8).unwrap(), "descriptor byte length");
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn assert_reproducer_parameters(values: &[f64], items: &[Value]) {
    let roles = ["original", "minimal", "chain", "oneDeleted", "order", "scale", "reproducer", "reduction", "perturbation"];
    assert_eq!(values.len(), items.len() * 5, "reproducer parameter inventory");
    for (i, item) in items.iter().enumerate() {
        let role = roles.iter().position(|role| item["role"] == *role).expect("known reproducer role");
        let expected = [item["cloud"].as_u64().unwrap(), role as u64,
            item["reversed"].as_u64().unwrap(), item["shift"].as_u64().unwrap(), item["transform"].as_u64().unwrap()];
        for (column, value) in expected.into_iter().enumerate() {
            assert_eq!(values[i + column * items.len()].to_bits(), (value as f64).to_bits(),
                "reproducer {i}: parameter column {column} differs from spec");
        }
    }
}

#[test]
fn reproducer_descriptors_and_parameters_reject_corruption() {
    let descriptor = json!({"class": "double", "imaginary": "", "shape": [1, 5]});
    let values = [177.0f64, 6.0, 0.0, 2.0, 3.0];
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    let items = [json!({"cloud": 177, "role": "reproducer", "reversed": 0, "shift": 2, "transform": 3})];
    let decoded = real_double_values(&bytes, &descriptor);
    assert_reproducer_parameters(&decoded, &items);
    for invalid in [&bytes[..0], &bytes[..bytes.len() - 8], &bytes[..bytes.len() - 1]] {
        assert!(std::panic::catch_unwind(|| real_double_values(invalid, &descriptor)).is_err());
    }
    for (field, value) in [("class", "single"), ("imaginary", "unexpected.f64")] {
        let mut invalid = descriptor.clone();
        invalid[field] = json!(value);
        assert!(std::panic::catch_unwind(|| real_double_values(&bytes, &invalid)).is_err());
    }
    for column in 0..5 {
        let mut invalid = decoded.clone();
        invalid[column] += 1.0;
        assert!(std::panic::catch_unwind(|| assert_reproducer_parameters(&invalid, &items)).is_err());
    }
}

fn validate_causal_case(root: &Path, case: &Value, n: usize, parameter_shape: [usize; 2]) {
    for descriptor in case.as_object().unwrap().values().filter(|value| value.get("file").is_some()) {
        let bytes = std::fs::read(root.join(descriptor["file"].as_str().unwrap())).unwrap();
        real_double_values(&bytes, descriptor);
    }
    for field in ["counts", "simplifiedCounts", "collinearCounts", "hullCounts", "regions", "warning", "error", "defaultHolesCounts", "keptHolesCounts", "fromKeptCounts", "fromDefaultCounts", "viaSimplifyCounts"] {
        assert_eq!(shape(&case[field]), [n, 1], "{}: {field} inventory", case["id"]);
        assert_eq!(array(root, &case[field]).len(), n);
    }
    for field in ["estimate", "polygonEstimate"] {
        assert_eq!(shape(&case[field]), [n, 3], "{}: {field} shape", case["id"]);
        assert_eq!(array(root, &case[field]).len(), n * 3);
    }
    assert_eq!(shape(&case["parameters"]), parameter_shape, "{}: parameter inventory", case["id"]);
    for (field, counts, columns) in [
        ("points", "counts", 2), ("simplified", "simplifiedCounts", 2),
        ("collinearVertices", "collinearCounts", 2), ("hull", "hullCounts", 2),
        ("fromKept", "fromKeptCounts", 2), ("fromDefault", "fromDefaultCounts", 2),
        ("viaSimplify", "viaSimplifyCounts", 2), ("defaultHoles", "defaultHolesCounts", 1),
        ("keptHoles", "keptHolesCounts", 1),
    ] {
        let dimensions = shape(&case[field]);
        assert_eq!(dimensions.len(), 2, "{field}: matrix required");
        assert_eq!(dimensions[1], columns, "{field}: column count");
        let counts = array(root, &case[counts]);
        assert!(counts.iter().all(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0), "{field}: invalid row count");
        assert_eq!(counts.iter().sum::<f64>(), dimensions[0] as f64, "{field}: incomplete flattened rows");
        assert_eq!(array(root, &case[field]).len(), dimensions[0] * columns);
    }
}

fn unique_sorted(vertices: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut result: Vec<[f64; 2]> = vertices.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
    result.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    result.dedup();
    result
}

/// One probe polygon against MATLAB: exact hull vertices with area and centroid
/// within the uncentred error bound, and the same simplified vertex set.
struct ProbeOutcome {
    hull: bool,
    vertices: bool,
    error: bool,
    port: Option<Value>,
}

fn frozen_hull_outcome(hull: Option<&Hull>) -> Value {
    let vertices = hull.map(|h| h.vertices.as_slice()).unwrap_or(&[]);
    json!({
        "empty": hull.is_none(),
        "hull": sorted_vertices(vertices).iter().map(|p| [p[0].to_bits(), p[1].to_bits()]).collect::<Vec<_>>(),
        "centroid": hull.map(|h| h.centroid().map(f64::to_bits)),
        "area": hull.map(|h| h.area().to_bits()),
    })
}

fn probe_outcome(polygon: &[[f64; 2]], simplified: &[[f64; 2]], matlab_hull: &[[f64; 2]], expected: [f64; 3]) -> ProbeOutcome {
    match polyshape_vertices(polygon) {
        Err(_) => ProbeOutcome { hull: false, vertices: false, error: true, port: None },
        Ok((vertices, hull)) => {
            let found = hull.as_ref().map(|h| h.vertices.clone()).unwrap_or_default();
            let hull_agrees = sorted_vertices(&found) == sorted_vertices(matlab_hull) && match &hull {
                None => expected[2] == 0.0 && expected[0].is_nan() && expected[1].is_nan(),
                Some(hull) => {
                    let bound = uncentred_error_bound(&hull.vertices, hull.area());
                    let centre = hull.centroid();
                    (0..2).all(|axis| (centre[axis] - expected[axis]).abs() <= bound[axis]) && (hull.area() - expected[2]).abs() <= bound[2]
                }
            };
            ProbeOutcome { hull: hull_agrees, vertices: unique_sorted(&vertices) == unique_sorted(simplified), error: false, port: Some(frozen_hull_outcome(hull.as_ref())) }
        }
    }
}

/// The focused probe (record_geometry.m 'polyshape-probe', pinned by
/// polyshape-probe-reference.json) on both hosts:
/// - the grid decade: all 27,648 swept and bisected polygons have MATLAB's hull
///   and simplified vertex set exactly;
/// - held-out clouds: every hull agrees except the IDs listed in
///   matlab_polyshape_probe.json, which must still differ and retain their frozen
///   hull, emptiness, area and centroid bits; all but one are
///   near-collinear, and held-out cloud 1125 is a half-integer grid whose default
///   polyshape MATLAB re-traces away from its own KeepCollinearPoints rings;
/// - extreme grids: the model reports an error, not a hull, for coordinates
///   outside its grid (MATLAB: area 0 for 1e-300, empty for subnormal and
///   +-1e308 spans, xyTooLarge for 1e308..1.1e308) and agrees on the rest;
/// - the original 2,500 point clouds recorded again equal geometry-reference.json's.
#[test]
fn polyshape_probe_matches_matlab() {
    let hosts = probe_hosts();
    if hosts.is_empty() {
        return;
    }
    let listed: Value = serde_json::from_str(include_str!("matlab_polyshape_probe.json")).unwrap();
    let frozen: Value = serde_json::from_str(include_str!("matlab_polyshape_probe_outcomes.json")).unwrap();
    let frozen = frozen["outcomes"].as_object().unwrap();
    assert_eq!(frozen.keys().map(String::as_str).collect::<BTreeSet<_>>(), ["probe_heldout_collinear", "probe_heldout_clouds"].into_iter().collect());
    let originals = geometry_hosts();
    for (root, cases) in hosts {
        let ids: Vec<&str> = cases.iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["probe_grid_sweep", "probe_grid_bisection", "probe_heldout_collinear", "probe_heldout_clouds", "probe_extreme_grids", "probe_point_clouds"], "{}: probe inventory", root.display());
        for case in &cases {
            let id = case["id"].as_str().unwrap();
            let polygons = split_rows(&points(&array(&root, &case["points"])), &array(&root, &case["counts"]));
            let simplified = split_rows(&points(&array(&root, &case["simplified"])), &array(&root, &case["simplifiedCounts"]));
            let hulls = split_rows(&points(&array(&root, &case["hull"])), &array(&root, &case["hullCounts"]));
            let estimate = array(&root, &case["estimate"]);
            let failed = array(&root, &case["error"]);
            let n = polygons.len();
            let outcomes: Vec<ProbeOutcome> = (0..n).map(|i| probe_outcome(&polygons[i], &simplified[i], &hulls[i], [estimate[i], estimate[n + i], estimate[2 * n + i]])).collect();
            let at = |i: usize| format!("{} {id} {i}", root.display());
            match id {
                "probe_grid_sweep" | "probe_grid_bisection" => {
                    for (i, outcome) in outcomes.iter().enumerate() {
                        assert!(outcome.hull && outcome.vertices, "{}: differs from MATLAB (hull {}, vertices {})", at(i), outcome.hull, outcome.vertices);
                    }
                    if id == "probe_grid_sweep" {
                        assert_eq!(n, 24120);
                    } else {
                        assert_eq!(n, 3528);
                    }
                }
                "probe_heldout_collinear" | "probe_heldout_clouds" => {
                    assert_eq!(n, 1500, "{id}: held-out polygon inventory");
                    let listed_ids = listed[id].as_array().unwrap();
                    let differ: BTreeSet<usize> = listed_ids.iter().map(|v| v.as_u64().unwrap() as usize).collect();
                    assert_eq!(listed_ids.len(), differ.len(), "{id}: duplicate exception ID");
                    assert_eq!(differ.len(), if id == "probe_heldout_collinear" { 148 } else { 30 }, "{id}: exception inventory");
                    assert!(differ.iter().all(|&i| i < n), "{id}: exception outside the recording");
                    let snapshots = frozen[id].as_object().unwrap();
                    let snapshot_ids: BTreeSet<usize> = snapshots.keys().map(|i| i.parse().unwrap()).collect();
                    assert_eq!(snapshot_ids, differ, "{id}: frozen and listed exception IDs differ");
                    let mut checked = BTreeSet::new();
                    for (i, outcome) in outcomes.iter().enumerate() {
                        assert!(!outcome.error, "{}: model error", at(i));
                        if differ.contains(&i) {
                            assert!(!outcome.hull, "{} now matches MATLAB; remove its exception and frozen outcome", at(i));
                            assert_eq!(outcome.port.as_ref().unwrap(), &snapshots[&i.to_string()], "{}: frozen held-out port outcome changed", at(i));
                            assert!(checked.insert(i));
                            if (id, i) == ("probe_heldout_clouds", 1125) {
                                // MATLAB's KeepCollinearPoints rings keep the filled triangle at
                                // (1.5, 2), as Clipper does; its default output does not.
                                let kept = points(&array(&root, &case["collinearVertices"]));
                                let offset: usize = array(&root, &case["collinearCounts"])[..i].iter().map(|&c| c.max(0.0) as usize).sum();
                                let count = array(&root, &case["collinearCounts"])[i] as usize;
                                assert!(kept[offset..offset + count].contains(&[1.5, 2.0]) && !simplified[i].contains(&[1.5, 2.0]), "{}", at(i));
                            } else {
                                assert!(line_thickness(&polygons[i]) < 1e-5, "{} is not a near-collinear cloud", at(i));
                            }
                        } else {
                            assert!(outcome.hull, "{}: hull differs from MATLAB", at(i));
                        }
                    }
                    assert_eq!(checked, differ, "{id}: not every frozen exception was checked");
                }
                "probe_extreme_grids" => {
                    assert_eq!(n, 7);
                    assert_eq!(failed.iter().map(|&f| f != 0.0).collect::<Vec<_>>(), [false, false, true, false, false, false, false], "MATLAB's extreme-grid errors");
                    for (i, outcome) in outcomes.iter().enumerate() {
                        assert_eq!(outcome.error, i < 4, "{}: the model must refuse exactly the four unrepresentable grids", at(i));
                        if i >= 4 {
                            assert!(outcome.hull && outcome.vertices, "{}", at(i));
                        }
                    }
                }
                "probe_point_clouds" => {
                    assert_eq!(n, 2500);
                    let host = root.file_name().unwrap();
                    if let Some((original, original_cases)) = originals.iter().find(|(dir, _)| dir.file_name() == Some(host)) {
                        let first = original_cases.iter().find(|c| c["id"] == "polygon_point_clouds").unwrap();
                        for field in ["points", "counts", "simplified", "simplifiedCounts", "collinearCounts", "regions", "hull", "hullCounts", "estimate", "polygonEstimate"] {
                            assert_eq!(array(&root, &case[field]).iter().map(|v| v.to_bits()).collect::<Vec<_>>(), array(original, &first[field]).iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "{}: {field} differs from the pinned geometry recording", at(0));
                        }
                    }
                    let differing: BTreeSet<usize> = outcomes.iter().enumerate().filter(|(_, o)| !o.hull).map(|(i, _)| i).collect();
                    assert_eq!(differing, NEAR_COLLINEAR_SNAPPING.into_iter().collect(), "{}", at(0));
                }
                _ => unreachable!(),
            }
            let hulls = outcomes.iter().filter(|o| o.hull).count();
            let sets = outcomes.iter().filter(|o| o.vertices).count();
            println!("{} {id}: {n} polygons, {hulls} hulls and {sets} vertex sets equal MATLAB's", root.file_name().unwrap().to_string_lossy());
        }
    }
}

fn causal_hosts() -> Vec<(PathBuf, Vec<Value>)> {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_POLYSHAPE_CAUSAL_DIR").map(PathBuf::from) else { return Vec::new() };
    ["ubuntu-22.04", "ubuntu-24.04"].iter().map(|host| {
        let dir = root.join(host);
        let cases = load(&dir, "geometry.json");
        (dir, cases)
    }).collect()
}

/// One polygon's port outcome, IEEE bits, as the frozen snapshots store it.
fn outcome_bits(polygon: &[[f64; 2]]) -> Value {
    let hull = hull_of_polygon(polygon).unwrap();
    let vertices = hull.as_ref().map(|h| h.vertices.clone()).unwrap_or_default();
    json!({
        "empty": hull.is_none(),
        "hull": sorted_vertices(&vertices).iter().map(|p| [p[0].to_bits(), p[1].to_bits()]).collect::<Vec<_>>(),
        "centroid": hull.as_ref().map(|h| h.centroid().map(f64::to_bits)),
        "area": hull.as_ref().map(|h| h.area().to_bits()),
    })
}

/// The causal probe (record_geometry.m 'polyshape-causal', pinned by
/// polyshape-causal-reference.json) on both hosts: thin strips around an unfilled
/// sliver (swept, bisected and held out), holes at and near one contact, and
/// transforms of real clouds. Every strip and hole hull equals MATLAB's; their
/// vertex sets too, except the IDs listed in matlab_polyshape_causal.json. The
/// listed real-cloud transforms (of clouds 177, 932, 1607, 1937 and held-out
/// 1125) must still differ, with their port outcomes frozen; every other
/// transform (of clouds 7 and 1090, and 1125 at scale 1e-2) must match in hull.
/// Simplified vertex-set equality is not asserted for real-cloud transforms.
#[test]
fn polyshape_causal_matches_matlab() {
    let hosts = causal_hosts();
    if hosts.is_empty() {
        return;
    }
    let listed: Value = serde_json::from_str(include_str!("matlab_polyshape_causal.json")).unwrap();
    let ids_of = |key: &str| -> BTreeSet<usize> { listed[key].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect() };
    let frozen = listed["realOutcomes"].as_object().unwrap();
    for (root, cases) in hosts {
        let ids: Vec<&str> = cases.iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["causal_gap_sweep", "causal_gap_bisection", "causal_hole_contact", "causal_real", "causal_heldout"], "{}: causal inventory", root.display());
        for (case, (expected_n, parameter_shape)) in cases.iter().zip([
            (8424, [8424, 6]), (1152, [36, 8]), (170, [170, 3]),
            (403, [403, 5]), (600, [600, 6]),
        ]) {
            validate_causal_case(&root, case, expected_n, parameter_shape);
            let id = case["id"].as_str().unwrap();
            let polygons = split_rows(&points(&array(&root, &case["points"])), &array(&root, &case["counts"]));
            let simplified = split_rows(&points(&array(&root, &case["simplified"])), &array(&root, &case["simplifiedCounts"]));
            let hulls = split_rows(&points(&array(&root, &case["hull"])), &array(&root, &case["hullCounts"]));
            let estimate = array(&root, &case["estimate"]);
            let parameters = array(&root, &case["parameters"]);
            let n = polygons.len();
            assert_eq!(n, expected_n, "{id}: polygon inventory");
            assert_eq!(simplified.len(), n);
            assert_eq!(hulls.len(), n);
            let at = |i: usize| format!("{} {id} {i}", root.display());
            let vertex_exceptions = ids_of(&format!("{id}Vertices"));
            let mut visited = BTreeSet::new();
            for i in 0..n {
                let outcome = probe_outcome(&polygons[i], &simplified[i], &hulls[i], [estimate[i], estimate[n + i], estimate[2 * n + i]]);
                assert!(!outcome.error, "{}: model error", at(i));
                if id == "causal_real" {
                    let rows = parameters.len() / 5;
                    let source = parameters[i] as usize;
                    let transform = parameters[4 * rows + i] as usize;
                    if frozen.contains_key(&i.to_string()) {
                        assert!(!outcome.hull, "{} now matches MATLAB; remove it from matlab_polyshape_causal.json", at(i));
                        assert!([2, 3, 4, 5, 7].contains(&source), "{}: only the four regressions and held-out 1125 may differ", at(i));
                        assert_eq!(&outcome_bits(&polygons[i]), &frozen[&i.to_string()], "{}: frozen port outcome changed", at(i));
                        visited.insert(i);
                    } else {
                        assert!(outcome.hull, "{}: hull differs from MATLAB (source {source}, transform {transform})", at(i));
                    }
                } else {
                    assert!(outcome.hull, "{}: hull differs from MATLAB", at(i));
                    if vertex_exceptions.contains(&i) {
                        assert!(!outcome.vertices, "{} now has MATLAB's vertices; remove it from matlab_polyshape_causal.json", at(i));
                        visited.insert(i);
                    } else {
                        assert!(outcome.vertices, "{}: vertex set differs from MATLAB", at(i));
                    }
                }
            }
            let expected: BTreeSet<usize> = if id == "causal_real" { frozen.keys().map(|k| k.parse().unwrap()).collect() } else { vertex_exceptions };
            assert_eq!(visited, expected, "{}: listed exceptions not all visited", at(0));
            println!("{} {id}: {n} polygons, {} listed exceptions", root.file_name().unwrap().to_string_lossy(), visited.len());
        }
    }
}


/// The reproducer recording (record_geometry.m 'polyshape-reproducers', pinned by
/// polyshape-reproducers-reference.json): SAMSRF_MATLAB_POLYSHAPE_REPRODUCERS_DIR.
fn reproducer_hosts() -> Vec<(PathBuf, Vec<Value>)> {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_POLYSHAPE_REPRODUCERS_DIR").map(PathBuf::from) else { return Vec::new() };
    ["ubuntu-22.04", "ubuntu-24.04"].iter().map(|host| {
        let dir = root.join(host);
        let cases = load(&dir, "geometry.json");
        (dir, cases)
    }).collect()
}

/// A model's hull as polyshape_reduce.py's `prediction` writes it: sorted IEEE
/// bits of the vertices, area and centroid, or `{"empty": true}`.
fn predicted_bits(hull: Option<&Hull>) -> Value {
    match hull {
        None => json!({"empty": true}),
        Some(hull) => {
            let mut vertices: Vec<[u64; 2]> = hull.vertices.iter().map(|p| [p[0].to_bits(), p[1].to_bits()]).collect();
            vertices.sort();
            json!({"hull": vertices, "area": hull.area().to_bits(), "centroid": hull.centroid().map(f64::to_bits)})
        }
    }
}

/// record_geometry.m's transforms of a reproducer (polyshape_reduce.py's
/// `transformed`): flipud, circshift by -shift, then +[0.37 -1.21], *1e-2 or *1e2.
fn transformed(points: &[[f64; 2]], reversed: bool, shift: usize, transform: u64) -> Vec<[f64; 2]> {
    let mut q = points.to_vec();
    if reversed {
        q.reverse();
    }
    let len = q.len().max(1);
    q.rotate_left(shift % len);
    q.iter().map(|&[x, y]| match transform {
        0 => [x, y],
        1 => [x + 0.37, y + -1.21],
        2 => [x * 1e-2, y * 1e-2],
        3 => [x * 1e2, y * 1e2],
        _ => unreachable!(),
    }).collect()
}

/// A compact round's cases (polyshape_reduce.py `expand`): one bitmask of 1-based
/// indices into cloud `spec["cloud"]` per case, untransformed.
fn expand_compact(spec: &Value) -> Vec<Value> {
    spec["masks"].as_array().unwrap().iter().map(|mask| {
        let mask = mask.as_u64().unwrap();
        assert!(mask > 0 && mask < 1 << 53, "invalid reduction mask");
        let indices: Vec<u64> = (0..53).filter(|k| mask >> k & 1 == 1).map(|k| k + 1).collect();
        json!({"cloud": spec["cloud"], "role": spec["role"], "indices": indices, "reversed": 0, "shift": 0, "transform": 0})
    }).collect()
}

/// A perturbation round's cases (polyshape_perturbation.py `cases_of`): the
/// reproducer `spec["indices"]` with one coordinate replaced by an exact double,
/// then transformed.
fn expand_perturbations(spec: &Value) -> Vec<Value> {
    spec["perturbations"].as_array().unwrap().iter().map(|item| {
        let value = u64::from_str_radix(item["value"].as_str().unwrap(), 16).unwrap();
        json!({"cloud": spec["cloud"], "role": spec["role"], "indices": spec["indices"], "reversed": 0, "shift": 0,
            "transform": item["transform"], "perturb": {"point": item["point"], "axis": item["axis"], "value": value}})
    }).collect()
}

/// polyshape_reduce.py's `prediction_bytes`: 0 for an empty hull, else 1, the
/// sorted vertex bits, the area bits and the centroid bits, little-endian u64.
fn prediction_bytes(hull: Option<&Hull>) -> Vec<u8> {
    let Some(hull) = hull else { return vec![0] };
    let mut vertices: Vec<[u64; 2]> = hull.vertices.iter().map(|p| [p[0].to_bits(), p[1].to_bits()]).collect();
    vertices.sort();
    let mut bytes = vec![1];
    for [x, y] in vertices {
        bytes.extend(x.to_le_bytes());
        bytes.extend(y.to_le_bytes());
    }
    bytes.extend(hull.area().to_bits().to_le_bytes());
    for value in hull.centroid() {
        bytes.extend(value.to_bits().to_le_bytes());
    }
    bytes
}

/// A frozen verdict: `[equals shipped, equals experimental]`, stored as a pair or,
/// for compact rounds, as one digit `2 * shipped + experimental` per case.
fn frozen_verdicts(value: &Value, n: usize, id: &str) -> Vec<[bool; 2]> {
    let verdicts: Vec<[bool; 2]> = match value {
        Value::String(digits) => digits.chars().map(|d| {
            let d = d.to_digit(10).filter(|d| *d < 4).unwrap_or_else(|| panic!("{id}: invalid verdict digit"));
            [d >> 1 == 1, d & 1 == 1]
        }).collect(),
        Value::Array(pairs) => pairs.iter().map(|pair| [pair[0].as_bool().unwrap(), pair[1].as_bool().unwrap()]).collect(),
        _ => panic!("{id}: missing frozen verdicts"),
    };
    assert_eq!(verdicts.len(), n, "{id}: frozen verdict inventory");
    verdicts
}

// These are the selected smallest recorded 1-minimal certificates, not all
// certified subsets or a claim of global minimality. Keep their identities fixed
// so dropping or duplicating a certificate cannot weaken the deletion checks.
fn assert_minimal_certificate_inventory(actual: &Value) {
    let expected = json!({
        "177": [[1, 2, 3, 4, 5, 6]],
        "932": [
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 17],
            [1, 2, 3, 4, 5, 6, 8, 10, 11, 12, 17],
            [1, 2, 3, 4, 5, 6, 10, 11, 13, 14, 17],
            [1, 2, 3, 4, 5, 6, 10, 13, 14, 15, 16],
            [1, 2, 4, 5, 7, 8, 9, 10, 12, 15, 16],
            [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 17],
            [2, 3, 4, 5, 6, 8, 10, 11, 13, 14, 18],
            [3, 4, 5, 6, 9, 11, 12, 14, 15, 17, 18]
        ],
        "1607": [[3, 4, 5, 13, 15, 17, 19, 20]],
        "1937": [[2, 3, 13, 14, 15, 16, 17, 18]]
    });
    assert_eq!(actual, &expected, "complete nonempty 1-minimal certificate inventory");
}

#[test]
fn minimal_certificate_inventory_rejects_missing_and_duplicate_certificates() {
    let frozen: Value = serde_json::from_str(include_str!("matlab_polyshape_reproducers.json")).unwrap();
    let inventory = &frozen["oneMinimal"];
    assert_minimal_certificate_inventory(inventory);
    let mut empty = inventory.clone();
    empty["932"] = json!([]);
    let mut missing = inventory.clone();
    missing["932"].as_array_mut().unwrap().pop();
    let mut duplicate = inventory.clone();
    duplicate["932"][1] = duplicate["932"][0].clone();
    for invalid in [empty, missing, duplicate] {
        assert!(std::panic::catch_unwind(|| assert_minimal_certificate_inventory(&invalid)).is_err());
    }
}

/// The reduced reproducers of the four regressions, on both hosts. Every recorded
/// polygon is the spec's (indices into the full clouds the first batch records as
/// controls, then the transform). Both models still give the hulls predicted
/// before the recording: per case in polyshape-reproducers{,-2,-3}.json, and by
/// the committed `predictionsSha256` of each compact round (-4, -5). MATLAB's
/// verdicts per case (hull equals the shipped model's, the experimental model's)
/// equal the frozen matlab_polyshape_reproducers.json. The smallest measured
/// reproducers still reproduce, and each listed 1-minimal reproducer reproduces
/// while every one of its one-point deletions is recorded and does not. A fix of
/// the experimental model changes the predictions and fails here: re-derive the
/// predictions and verdicts from the pinned recording, never from the model under
/// test.
#[test]
fn polyshape_reproducers_match_recording() {
    let hosts = reproducer_hosts();
    if hosts.is_empty() {
        return;
    }
    let specs: [(&str, Value); 6] = [
        ("reproducer_cases", serde_json::from_str(include_str!("../../../../packages/samsrf/validation/matlab/polyshape-reproducers.json")).unwrap()),
        ("reproducer_round2", serde_json::from_str(include_str!("../../../../packages/samsrf/validation/matlab/polyshape-reproducers-2.json")).unwrap()),
        ("reproducer_round3", serde_json::from_str(include_str!("../../../../packages/samsrf/validation/matlab/polyshape-reproducers-3.json")).unwrap()),
        ("reproducer_round4", serde_json::from_str(include_str!("../../../../packages/samsrf/validation/matlab/polyshape-reproducers-4.json")).unwrap()),
        ("reproducer_round5", serde_json::from_str(include_str!("../../../../packages/samsrf/validation/matlab/polyshape-reproducers-5.json")).unwrap()),
        ("reproducer_round6", serde_json::from_str(include_str!("../../../../packages/samsrf/validation/matlab/polyshape-reproducers-6.json")).unwrap()),
    ];
    let rounds: Vec<(&str, Vec<Value>, bool)> = specs.iter().map(|(id, spec)| {
        if spec.get("perturbations").is_some() {
            (*id, expand_perturbations(spec), true)
        } else if spec.get("masks").is_some() {
            (*id, expand_compact(spec), true)
        } else {
            (*id, spec["cases"].as_array().unwrap().clone(), false)
        }
    }).collect();
    let frozen: Value = serde_json::from_str(include_str!("matlab_polyshape_reproducers.json")).unwrap();
    let verdicts: std::collections::BTreeMap<&str, Vec<[bool; 2]>> = rounds.iter().map(|(id, items, _)| (*id, frozen_verdicts(&frozen["verdicts"][*id], items.len(), id))).collect();
    for (root, cases) in hosts {
        assert_eq!(cases.iter().map(|c| c["id"].as_str().unwrap()).collect::<Vec<_>>(), rounds.iter().map(|r| r.0).collect::<Vec<_>>(), "{}: reproducer inventory", root.display());
        let mut clouds: std::collections::BTreeMap<u64, Vec<[f64; 2]>> = Default::default();
        for (case, ((id, items, compact), (_, spec))) in cases.iter().zip(rounds.iter().zip(&specs)) {
            let n = items.len();
            assert!(n > 0, "{id}: empty round");
            validate_causal_case(&root, case, n, [n, 5]);
            assert_reproducer_parameters(&array(&root, &case["parameters"]), items);
            let polygons = split_rows(&points(&array(&root, &case["points"])), &array(&root, &case["counts"]));
            let hulls = split_rows(&points(&array(&root, &case["hull"])), &array(&root, &case["hullCounts"]));
            assert_eq!((polygons.len(), hulls.len()), (n, n), "{id}: polygon inventory");
            let mut digest = <sha2::Sha256 as sha2::Digest>::new();
            for (i, item) in items.iter().enumerate() {
                let at = format!("{} {id} {i}", root.display());
                let cloud = item["cloud"].as_u64().unwrap();
                if item["role"] == "original" {
                    clouds.insert(cloud, polygons[i].clone());
                }
                let full = &clouds[&cloud];
                let indices: Vec<usize> = item["indices"].as_array().unwrap().iter().map(|k| k.as_u64().unwrap() as usize - 1).collect();
                let mut base: Vec<[f64; 2]> = indices.iter().map(|&k| full[k]).collect();
                if let Some(perturb) = item.get("perturb") {
                    let point = perturb["point"].as_u64().unwrap() as usize - 1;
                    let axis = perturb["axis"].as_u64().unwrap() as usize;
                    assert!(point < base.len() && axis < 2, "{at}: perturbation outside the reproducer");
                    base[point][axis] = f64::from_bits(perturb["value"].as_u64().unwrap());
                }
                let expected = transformed(&base, item["reversed"].as_u64() == Some(1), item["shift"].as_u64().unwrap() as usize, item["transform"].as_u64().unwrap());
                assert_eq!(polygons[i].iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>(), expected.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>(), "{at}: polygon differs from the spec");
                let shipped = Hull::of_polygon(&polygons[i]);
                let experimental = hull_of_polygon(&polygons[i]).unwrap_or_else(|e| panic!("{at}: {e}"));
                if *compact {
                    sha2::Digest::update(&mut digest, prediction_bytes(shipped.as_ref()));
                    sha2::Digest::update(&mut digest, prediction_bytes(experimental.as_ref()));
                } else {
                    assert_eq!(predicted_bits(shipped.as_ref()), item["predicted"]["shipped"], "{at}: shipped model changed since the prediction");
                    assert_eq!(predicted_bits(experimental.as_ref()), item["predicted"]["experimental"], "{at}: experimental model changed since the prediction");
                }
                let matlab = sorted_vertices(&hulls[i]);
                let same = |hull: &Option<Hull>| sorted_vertices(hull.as_ref().map(|h| h.vertices.as_slice()).unwrap_or(&[])) == matlab;
                assert_eq!([same(&shipped), same(&experimental)], verdicts[id][i], "{at}: MATLAB verdict differs from the frozen one");
            }
            if let Some(predicted) = spec.get("predictSurvival") {
                // Round 6: whether input point 4 (as perturbed) is a vertex of MATLAB's
                // default polyshape equals start-independent cleaning (H_I) on every
                // case and differs from the experimental model (H_X) on exactly 405.
                let defaults = split_rows(&points(&array(&root, &case["simplified"])), &array(&root, &case["simplifiedCounts"]));
                assert_eq!(defaults.len(), n, "{id}: default inventory");
                let (h_i, h_x) = (predicted["H_I"].as_str().unwrap().as_bytes(), predicted["H_X"].as_str().unwrap().as_bytes());
                assert_eq!((h_i.len(), h_x.len()), (n, n), "{id}: survival prediction inventory");
                let mut differs_from_x = 0;
                for i in 0..n {
                    let point4 = polygons[i][3];
                    let survives = defaults[i].iter().any(|v| v[0].to_bits() == point4[0].to_bits() && v[1].to_bits() == point4[1].to_bits());
                    assert_eq!(survives, h_i[i] == b'1', "{} {id} {i}: MATLAB's survival of point 4 differs from H_I", root.display());
                    differs_from_x += usize::from(survives != (h_x[i] == b'1'));
                }
                assert_eq!(differs_from_x, 405, "{id}: H_X refutations");
            }
            if *compact {
                let hex: String = sha2::Digest::finalize(digest).iter().map(|b| format!("{b:02x}")).collect();
                assert_eq!(hex, spec["predictionsSha256"].as_str().unwrap(), "{id}: a model changed since the committed predictions");
            }
        }
        println!("{}: {} reproducer cases checked", root.file_name().unwrap().to_string_lossy(), rounds.iter().map(|r| r.1.len()).sum::<usize>());
    }
    // Look a recorded untransformed case up by cloud and indices.
    let untransformed = |cloud: &str, indices: &Value| -> Option<[bool; 2]> {
        rounds.iter().find_map(|(id, items, _)| items.iter().position(|c| c["cloud"].as_u64().unwrap().to_string() == cloud && &c["indices"] == indices
            && c["transform"] == 0 && c["reversed"] == 0 && c["shift"] == 0 && c.get("perturb").is_none()).map(|i| verdicts[id][i]))
    };
    for (cloud, smallest) in frozen["smallest"].as_object().unwrap() {
        assert_eq!(untransformed(cloud, &smallest["indices"]), Some([true, false]), "cloud {cloud}: smallest reproducer no longer reproduces");
    }
    assert_eq!(frozen["smallest"].as_object().unwrap().keys().map(|k| k.parse::<usize>().unwrap()).collect::<BTreeSet<_>>(), REGRESSIONS.into_iter().collect());
    assert_minimal_certificate_inventory(&frozen["oneMinimal"]);
    for (cloud, minimal) in frozen["oneMinimal"].as_object().unwrap() {
        for indices in minimal.as_array().unwrap() {
            assert_eq!(untransformed(cloud, indices), Some([true, false]), "cloud {cloud} {indices}: listed 1-minimal reproducer does not reproduce");
            let members = indices.as_array().unwrap();
            assert!(members.len() > 3, "cloud {cloud}: a 1-minimal reproducer needs deletions with three points");
            for j in 0..members.len() {
                let deleted: Vec<Value> = members.iter().enumerate().filter(|(k, _)| *k != j).map(|(_, v)| v.clone()).collect();
                let verdict = untransformed(cloud, &Value::Array(deleted)).unwrap_or_else(|| panic!("cloud {cloud} {indices}: deletion {j} not recorded"));
                assert_ne!(verdict, [true, false], "cloud {cloud} {indices}: deletion {j} still reproduces");
            }
        }
    }
    assert_eq!(frozen["oneMinimal"].as_object().unwrap().keys().map(|k| k.parse::<usize>().unwrap()).collect::<BTreeSet<_>>(), REGRESSIONS.into_iter().collect(), "a 1-minimal reproducer for every regression");
}
