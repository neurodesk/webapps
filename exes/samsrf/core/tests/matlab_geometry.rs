//! Real MATLAB R2023b geometry: `delaunay`, `samsrf_clusterroi`, `polyshape` and
//! `samsrf_cfparam_loop` (record_geometry.m), and the convex-hull and summary
//! connective fields of the raw-input RC/CF matrix (record_revcor_matrix.m),
//! replayed from MATLAB's own profiles. The native workflow sets
//! SAMSRF_MATLAB_GEOMETRY_DIR and SAMSRF_MATLAB_REVCOR_DIR.
use samsrf_core::geometry::{cluster_roi, delaunay_triangles, unique_rows, Hull, Triangulation};
use samsrf_core::{mapset::Maps, model, revcor_cf};
use std::collections::BTreeSet;
use serde_json::{json, Value};
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

/// Bitwise equality, NaN equal to NaN; a value with a tolerance otherwise.
fn close(actual: f64, expected: f64, tolerance: f64, context: &str) {
    assert!(actual.to_bits() == expected.to_bits() || actual == expected || actual.is_nan() && expected.is_nan() || actual.is_finite() && expected.is_finite() && (actual - expected).abs() <= tolerance,
        "{context}: {actual} != {expected}, tolerance {tolerance}");
}

fn cf_model(fit: i64) -> model::CfModel {
    let model::Model::RevCorCf(model) = model::parse_model_json(model::AnalysisKind::RevCorCf, &json!({"Name":"reference","SeedRoi":"seed","Template":"template","Fit_pRF":fit,"Global_Signal_Correction":false}).to_string()).unwrap() else { unreachable!() };
    model
}

/// A `Maps` holding the template rows of `columns` vertices from a column-major
/// `rows` x `columns` MATLAB matrix.
fn template_maps(values: &[f64], rows: usize) -> Maps {
    let vertices = values.len() / rows;
    let mut maps = Maps { vertices, values: (0..rows).map(|row| format!("row{row}")).collect(), data: vec![0.0; rows * vertices] };
    for row in 0..rows {
        for vertex in 0..vertices {
            maps.data[row * vertices + vertex] = values[vertex * rows + row];
        }
    }
    maps
}

fn revcor_hosts() -> Vec<PathBuf> {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_REVCOR_DIR").map(PathBuf::from) else { return Vec::new() };
    let hosts = vec![root.join("ubuntu-22.04"), root.join("ubuntu-24.04")];
    for host in &hosts {
        assert!(host.join("reference.json").is_file(), "missing {}", host.display());
    }
    hosts
}

/// Each host's convex-hull and summary CF maps from that host's own profiles on
/// real X001 Benson coordinates of both hemispheres. Smoothing and global
/// regression only change the profiles, which come from MATLAB here. Gaussian
/// fits are optimizer, not geometry, evidence and are left to that matrix's gates.
#[test]
fn revcor_matrix_cf_maps_follow_from_matlab_profiles() {
    let hosts = revcor_hosts();
    if hosts.is_empty() {
        return;
    }
    for root in hosts {
        let cases = load(&root, "reference.json");
        let find = |id: &str| cases.iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("{id}"));
        let mut counts = std::collections::BTreeMap::new();
        for case in cases.iter().filter(|c| c["kind"] == "pipeline" && c["analysis"] == "cf" && c["precision"] == "double" && c["model"]["Fit_pRF"] != 1) {
            let id = case["id"].as_str().unwrap();
            let fit = case["model"]["Fit_pRF"].as_i64().unwrap();
            let preprocessing = find(case["preprocessing"].as_str().unwrap());
            let template = template_maps(&array(&root, &find(case["template"].as_str().unwrap())["maps"]), 5);
            let seeds: Vec<u32> = array(&root, &preprocessing["seedVertices"]).iter().map(|v| *v as u32 - 1).collect();
            let area = array(&root, &preprocessing["area"]);
            let model = cf_model(fit);
            let courses = vec![vec![0.0; 2]; seeds.len()];
            let courses: Vec<&[f64]> = courses.iter().map(Vec::as_slice).collect();
            let prepared = revcor_cf::Prepared::new(&model, &seeds, &courses, &template, &area, None).unwrap();
            let profiles = array(&root, &case["profiles"]);
            let maps = array(&root, &case["maps"]);
            let rows = shape(&case["maps"])[0];
            let labels: Vec<&str> = case["values"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            let mut replayed = 0;
            for (vertex, profile) in profiles.chunks(seeds.len()).enumerate() {
                if profile.iter().all(|v| v.is_nan()) {
                    continue;
                }
                replayed += 1;
                let actual = prepared.estimate_profile(profile).unwrap();
                for (row, value) in actual.iter().enumerate() {
                    let label = &prepared.values[row];
                    let index = labels.iter().position(|l| l == label).unwrap_or_else(|| panic!("{id}: no {label} row"));
                    let expected = maps[vertex * rows + index];
                    close(*value, expected, 1e-12 * expected.abs().max(1.0), &format!("{} {id} vertex {vertex} {label}", root.display()));
                }
            }
            assert!(replayed > 0, "{id}: no profiles");
            *counts.entry(fit).or_insert(0) += 1;
        }
        assert_eq!(counts, [(-1, 12), (0, 12)].into_iter().collect(), "missing double CF pipelines");
    }
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
    let n = values.len() / 2;
    (0..n).map(|i| [values[i], values[n + i]]).collect()
}

fn edges(triangles: impl IntoIterator<Item = [usize; 3]>) -> BTreeSet<(usize, usize)> {
    triangles.into_iter().flat_map(|t| (0..3).map(move |i| (t[i].min(t[(i + 1) % 3]), t[i].max(t[(i + 1) % 3])))).collect()
}

/// MATLAB's 1-based column-major k x 3 triangles, 0-based.
fn matlab_triangles(values: &[f64]) -> Vec<[usize; 3]> {
    let k = values.len() / 3;
    (0..k).map(|i| [values[i] as usize - 1, values[k + i] as usize - 1, values[2 * k + i] as usize - 1]).collect()
}

/// `delaunay` on grids, cocircular rings, regular polygons, perturbed and
/// shuffled ties, duplicates, collinear inputs and real Benson V1 coordinates:
/// the port's triangulation has exactly MATLAB's edges. Where MATLAB errors,
/// the port has no triangles and SamSrf's cluster is the peak alone.
#[test]
fn delaunay_edges_match_matlab() {
    for (root, cases) in geometry_hosts() {
        delaunay_edges_match_matlab_on(&root, &cases);
    }
}

fn delaunay_edges_match_matlab_on(root: &Path, cases: &[Value]) {
    let mut count = 0;
    for case in cases.iter().filter(|c| c["kind"] == "delaunay") {
        count += 1;
        let id = case["id"].as_str().unwrap();
        let points = points(&array(root, &case["points"]));
        let ours = delaunay_triangles(&points);
        if !case["error"].as_str().unwrap().is_empty() {
            assert!(ours.is_empty(), "{id}: MATLAB errors ({}), the port triangulated", case["error"]);
            continue;
        }
        let expected = edges(matlab_triangles(&array(root, &case["triangles"])));
        let actual = edges(ours.iter().copied());
        assert_eq!(actual, expected, "{id}: edges differ (only port {:?}, only MATLAB {:?})", actual.difference(&expected).collect::<Vec<_>>(), expected.difference(&actual).collect::<Vec<_>>());
    }
    assert_eq!(count, 168, "missing delaunay cases");
}

/// `samsrf_clusterroi` over the port's triangulation selects MATLAB's vertices
/// in MATLAB's order, ties in the statistic included.
#[test]
fn cluster_selection_matches_matlab() {
    for (root, cases) in geometry_hosts() {
        cluster_selection_matches_matlab_on(&root, &cases);
    }
}

fn cluster_selection_matches_matlab_on(root: &Path, cases: &[Value]) {
    let mut count = 0;
    for case in cases.iter().filter(|c| c["kind"] == "cluster") {
        count += 1;
        let id = case["id"].as_str().unwrap();
        let triangulation = Triangulation::delaunay(&points(&array(root, &case["points"])));
        let statistic = array(root, &case["statistic"]);
        let seed = case["seed"].as_u64().unwrap() as usize - 1;
        let selected: Vec<usize> = cluster_roi(seed, &statistic, case["threshold"].as_f64().unwrap(), &triangulation).iter().map(|v| v + 1).collect();
        let expected: Vec<usize> = array(root, &case["selected"]).iter().map(|v| *v as usize).collect();
        assert_eq!(selected, expected, "{id}");
    }
    assert_eq!(count, 72, "missing cluster cases");
}

/// `samsrf_cfparam_loop` on real X001 Benson V1 coordinates (LH 2917 and RH
/// 3389 seed vertices) from MATLAB's own profiles. Convex-hull clusters and
/// polygons are compared before the maps so a difference names its operation.
#[test]
fn real_template_cf_maps_match_matlab() {
    for (root, cases) in geometry_hosts() {
        real_template_cf_maps_match_matlab_on(&root, &cases);
    }
}

fn real_template_cf_maps_match_matlab_on(root: &Path, cases: &[Value]) {
    let mut count = 0;
    for case in cases.iter().filter(|c| c["kind"] == "template-cf") {
        count += 1;
        let id = case["id"].as_str().unwrap();
        let mode = case["mode"].as_str().unwrap();
        let single = case["precision"] == "single";
        let hull_case = cases.iter().find(|c| c["id"] == id.replace(mode, "hull")).unwrap();
        let all_seeds = array(root, &hull_case["seedVertices"]);
        let seeds = array(root, &case["seedVertices"]);
        // SamSrf's Vx is the index into the template columns, SeedVx.
        let seed_vx: Vec<u32> = seeds.iter().map(|v| all_seeds.iter().position(|s| s == v).unwrap() as u32).collect();
        let template = array(root, &case["template"]);
        let columns = *seed_vx.iter().max().unwrap() as usize + 1;
        let mut full = vec![f64::NAN; 5 * columns];
        for (j, &column) in seed_vx.iter().enumerate() {
            full[column as usize * 5..column as usize * 5 + 5].copy_from_slice(&template[j * 5..j * 5 + 5]);
        }
        let fit = match mode { "hull" => 0, "summary" => -1, _ => 1 };
        let courses = vec![vec![0.0; 2]; seeds.len()];
        let courses: Vec<&[f64]> = courses.iter().map(Vec::as_slice).collect();
        let prepared = revcor_cf::Prepared::new(&cf_model(fit), &seed_vx, &courses, &template_maps(&full, 5), &vec![1.0; columns], None).unwrap();
        let profiles = array(root, &case["profiles"]);
        let maps = array(root, &case["maps"]);
        let rows = shape(&case["maps"])[0];
        let order: &[usize] = match fit { 0 => &[4, 1, 2, 5, 6, 7, 8, 3, 0], -1 => &[4, 1, 2, 5, 3, 0], _ => &[4, 1, 2, 5, 6, 7, 3, 0] };
        if fit == 0 {
            hull_intermediates(root, case, &prepared, &profiles);
        }
        for (vertex, profile) in profiles.chunks(seeds.len()).enumerate() {
            let actual = prepared.estimate_profile(profile).unwrap();
            for (row, &index) in order.iter().enumerate() {
                let label = &prepared.values[row];
                // Single-precision squares, medians and fits are MATLAB single
                // arithmetic, which this f64 port does not reproduce (#729).
                if single && (label == "R^2" || fit != 0 && label != "Fwhm" && label != "Vx") {
                    continue;
                }
                let expected = maps[vertex * rows + index];
                close(actual[row], expected, 1e-12 * expected.abs().max(1.0), &format!("{id} vertex {vertex} {label}"));
            }
        }
    }
    assert_eq!(count, 12, "missing real-template CF cases");
}

fn hull_intermediates(root: &Path, case: &Value, prepared: &revcor_cf::Prepared, profiles: &[f64]) {
    let id = case["id"].as_str().unwrap();
    let clusters = &case["clusters"];
    let nsvx = prepared.seed_vertices.len();
    let (unique, first) = unique_rows(&prepared.seed_xy);
    let expected_first: Vec<usize> = array(root, &clusters["unique"]).iter().map(|v| *v as usize - 1).collect();
    assert_eq!(first, expected_first, "{id}: unique rows");
    let triangulation = Triangulation::delaunay(&unique);
    let ours = edges(delaunay_triangles(&unique));
    assert_eq!(ours, edges(matlab_triangles(&array(root, &clusters["triangles"]))), "{id}: template triangulation");
    let selected = array(root, &clusters["selected"]);
    let counts = array(root, &clusters["selectedCounts"]);
    let mut offset = 0;
    for (vertex, profile) in profiles.chunks(nsvx).enumerate() {
        let count = counts[vertex] as usize;
        let expected: Vec<usize> = selected[offset..offset + count].iter().map(|v| *v as usize - 1).collect();
        offset += count;
        let peak = profile.iter().copied().fold(f64::NAN, f64::max);
        if peak.is_nan() || peak <= 0.0 {
            assert_eq!(count, 0);
            continue;
        }
        let r: Vec<f64> = first.iter().map(|&j| profile[j]).collect();
        let max = r.iter().copied().fold(f64::NAN, f64::max);
        let seed = r.iter().position(|&v| v == max).unwrap();
        assert_eq!(cluster_roi(seed, &r, max / 2.0, &triangulation), expected, "{id} vertex {vertex}: cluster");
    }
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

/// Compare hulls independently of winding, starting vertex and redundant
/// collinear vertices. Only roundoff in a two-product determinant is allowed
/// when removing a vertex; retained coordinates must agree exactly.
fn canonical_hull(vertices: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut result = vertices.to_vec();
    while result.len() > 3 {
        let n = result.len();
        let redundant = (0..n).find(|&i| {
            let a = result[(i + n - 1) % n];
            let b = result[i];
            let c = result[(i + 1) % n];
            let left = (b[0] - a[0]) * (c[1] - a[1]);
            let right = (b[1] - a[1]) * (c[0] - a[0]);
            let roundoff = 4.0 * f64::EPSILON * (left.abs() + right.abs());
            (left - right).abs() <= roundoff
                && (0..2).all(|axis| b[axis] >= a[axis].min(c[axis]) && b[axis] <= a[axis].max(c[axis]))
        });
        match redundant {
            Some(i) => { result.remove(i); }
            None => break,
        }
    }
    result.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    result
}

// Frozen at ef9cdedcb against geometry-r2023b-44a5e92.zip (SHA-256
// f54f4bfbc908595356ca28a9e16a18f88f9944411e27c036d4018e1dd033ddc0).
// A deterministic FNV-1a snapshot of every port output in a known discrepancy.
// This is a regression checksum, not an authenticity or security check. The
// pinned MATLAB archive provides the independent reference; these snapshots
// only prevent a documented exception from absorbing a changed port result.
fn outcome_fingerprint(vertices: &[[f64; 2]], centre: [f64; 2], area: f64) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for value in [vertices.len() as f64, centre[0], centre[1], area].into_iter().chain(vertices.iter().flatten().copied()) {
        let bits = if value.is_nan() { f64::NAN.to_bits() } else { value.to_bits() };
        for byte in bits.to_le_bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
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

/// Altitude over the longest side, relative to the bounding-box span: the
/// thinness `Hull::of_polygon` compares with 1e-8 for a triangle.
fn thinness(triangle: &[[f64; 2]]) -> f64 {
    let [a, b, c] = [triangle[0], triangle[1], triangle[2]];
    let cross = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs();
    let longest = [(a, b), (b, c), (c, a)].iter().map(|(p, q)| (q[0] - p[0]).hypot(q[1] - p[1])).fold(0.0, f64::max);
    let span = (0..2).map(|axis| {
        let values = triangle.iter().map(|p| p[axis]);
        values.clone().fold(f64::NEG_INFINITY, f64::max) - values.fold(f64::INFINITY, f64::min)
    }).fold(0.0, f64::max);
    cross / longest / span
}

/// MATLAB decides thin triangles on its own fixed-point copy of the vertices
/// (simplified vertices come back on a 13-digit decimal grid), so exact
/// copies scaled by a power of two can differ. Every recorded disagreement
/// lies in [1e-8, 1.000009e-8]; this is that measured band, not a fit.
const BOUNDARY_BAND: (f64, f64) = (1e-8 * (1.0 - 1e-12), 1.00001e-8);

/// `polyshape` simplification, then `convhull`, `area` and `centroid`, on thin
/// triangles one ULP apart across the cutoff, random thin triangles, near-collinear
/// vertices, spikes, degenerate inputs and unordered clouds as SamSrf passes them.
/// Emptiness must agree and area and centroid stay within the error bound of
/// MATLAB's uncentred evaluation, except in three measured classes that are
/// frozen by identity and by every port output in matlab_polygon_exceptions.json,
/// then counted and printed: triangles in `BOUNDARY_BAND`,
/// clouds with duplicate points (SamSrf removes duplicates before `polyshape`)
/// and clouds within 1e-5 of the span of a line, whose near-parallel edges
/// MATLAB resolves into slivers the port does not reproduce.
#[test]
fn polygon_hulls_match_matlab() {
    for (root, cases) in geometry_hosts() {
        polygon_hulls_match_matlab_on(&root, &cases);
    }
}

fn polygon_hulls_match_matlab_on(root: &Path, cases: &[Value]) {
    let baseline: Value = serde_json::from_str(include_str!("matlab_polygon_exceptions.json")).unwrap();
    let mut report = Vec::new();
    let mut failures = Vec::new();
    let mut families = 0;
    for (id, polygons, estimate, expected_hulls) in polygon_batches(root, cases) {
        families += 1;
        let n = polygons.len();
        let mut residual = [0usize; 3];
        let mut known = Vec::new();
        for (i, polygon) in polygons.iter().enumerate() {
            let expected = [estimate[i], estimate[n + i], estimate[2 * n + i]];
            let hull = Hull::of_polygon(polygon);
            let (centre, area) = match &hull {
                Some(hull) => (hull.centroid(), hull.area()),
                None => ([f64::NAN; 2], 0.0),
            };
            let vertices = hull.as_ref().map(|h| h.vertices.as_slice()).unwrap_or(&[]);
            let geometry_agrees = canonical_hull(vertices) == canonical_hull(&expected_hulls[i]);
            let agrees = if !geometry_agrees || (area == 0.0) != (expected[2] == 0.0) {
                false
            } else {
                match &hull {
                    None => true,
                    Some(hull) => {
                        let bound = uncentred_error_bound(&hull.vertices, area);
                        (0..2).all(|axis| (centre[axis] - expected[axis]).abs() <= bound[axis]) && (area - expected[2]).abs() <= bound[2]
                    }
                }
            };
            if agrees {
                continue;
            }
            // record_geometry.m's point_clouds draws kind mod(i, 5) for 1-based i.
            let class = if polygon.len() == 3 && (BOUNDARY_BAND.0..=BOUNDARY_BAND.1).contains(&thinness(polygon)) {
                Some(0)
            } else if id == "polygon_point_clouds" && (i + 1) % 5 == 1 && unique_rows(polygon).0.len() < polygon.len() {
                Some(1)
            } else if id == "polygon_point_clouds" && (i + 1) % 5 == 3 && line_thickness(polygon) < 1e-5 {
                Some(2)
            } else {
                None
            };
            match class {
                Some(class) => {
                    residual[class] += 1;
                    known.push(json!([i, outcome_fingerprint(vertices, centre, area)]));
                },
                None => failures.push(format!("{id} {i}: MATLAB {expected:?}, port {centre:?} {area}")),
            }
        }
        assert_eq!(Value::Array(known), baseline[&id], "{id}: known discrepancy identities or port outcomes changed; inspect against the pinned MATLAB recording before updating the snapshot");
        report.push(format!("{id}: {n} polygons; boundary band {}, duplicate clouds {}, near-collinear clouds {}", residual[0], residual[1], residual[2]));
    }
    println!("{}", report.join("\n"));
    assert_eq!(families, 7, "missing polygon families");
    assert!(failures.is_empty(), "{} unexplained polygon differences:\n{}", failures.len(), failures[..failures.len().min(20)].join("\n"));
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

#[test]
fn hull_comparison_checks_geometry_before_numerical_bounds() {
    let expected = [[0.3, 0.3], [0.5, 0.3], [0.5, 0.7], [0.3, 0.5]];
    // A retained point on an edge differs from exact collinearity only by the
    // rounding of 0.4 + 0.2; MATLAB removes it from six recorded grid hulls.
    let redundant = [[0.3, 0.5], [0.4, 0.4 + 0.2], [0.5, 0.7], [0.5, 0.3], [0.3, 0.3]];
    assert_eq!(canonical_hull(&redundant), canonical_hull(&expected));
    let mut different = redundant;
    different[1][1] += 1e-12;
    assert_ne!(canonical_hull(&different), canonical_hull(&expected));
    let translated = expected.map(|[x, y]| [x + 1e10, y + 1e10]);
    let mut changed = translated;
    changed[0][0] += 1e-4;
    assert_ne!(canonical_hull(&changed), canonical_hull(&translated));
    assert_ne!(canonical_hull(&[]), canonical_hull(&expected));
}

#[test]
fn known_discrepancy_snapshots_cover_geometry_and_values() {
    let vertices = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]];
    let centre = [1.0 / 3.0; 2];
    let baseline = outcome_fingerprint(&vertices, centre, 0.5);
    assert_ne!(baseline, outcome_fingerprint(&vertices, centre, 1e30));
    assert_ne!(baseline, outcome_fingerprint(&vertices, [f64::NAN; 2], 0.5));
    assert_ne!(baseline, outcome_fingerprint(&[], centre, 0.5));
    let mut different = vertices;
    different[1][0] = 2.0;
    assert_ne!(baseline, outcome_fingerprint(&different, centre, 0.5));
}
