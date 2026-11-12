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
/// points within 1e-6 to 1e-10 of a line, in random order) whose hulls still
/// differ. Clipper's union yields every vertex MATLAB keeps, but MATLAB cleans
/// these clouds' many touching slivers differently: it returns the filled faces
/// of the arrangement where Clipper returns an outer ring with touching holes,
/// and the port does not reproduce which near-duplicate crossings its cleaning
/// keeps. Each must stay a near-collinear cloud and must still differ: a fix
/// shortens this list. Its port outcome is separately frozen, not treated as
/// MATLAB ground truth.
const NEAR_COLLINEAR_SNAPPING: [usize; 44] = [77, 102, 157, 177, 377, 387, 397, 512, 532, 557, 562, 737, 797, 822, 852, 932, 1027, 1162, 1192, 1237, 1257, 1322, 1382, 1392, 1607, 1622, 1777, 1782, 1817, 1922, 1937, 1982, 2087, 2102, 2147, 2167, 2212, 2272, 2292, 2317, 2337, 2357, 2382, 2457];

/// `polyshape(P).convhull` on thin triangles one ULP apart across the cutoff at
/// nine scales, three offsets and rotations, a relative sweep, random thin
/// triangles, near-collinear vertices, spikes, degenerate inputs and unordered
/// clouds as SamSrf passes them. Emptiness must agree and the hull must have
/// exactly MATLAB's vertices, bit for bit, before area and centroid are held to
/// the error bound of MATLAB's uncentred evaluation.
#[test]
fn polygon_hulls_match_matlab() {
    for (root, cases) in geometry_hosts() {
        polygon_hulls_match_matlab_on(&root, &cases);
    }
}

fn polygon_hulls_match_matlab_on(root: &Path, cases: &[Value]) {
    let frozen: Value = serde_json::from_str(include_str!("matlab_polygon_snapping.json")).unwrap();
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
            let hull = Hull::of_polygon(polygon).unwrap_or_else(|e| panic!("{id} {i}: {e}"));
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
    counts.iter().map(|&n| {
        let n = n.max(0.0) as usize;
        let rows = all[offset..offset + n].to_vec();
        offset += n;
        rows
    }).collect()
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
    match samsrf_core::geometry::polyshape_vertices(polygon) {
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
    let hull = Hull::of_polygon(polygon).unwrap();
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
/// transform (of clouds 7 and 1090, and 1125 at scale 1e-2) must match.
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
        for case in &cases {
            let id = case["id"].as_str().unwrap();
            let polygons = split_rows(&points(&array(&root, &case["points"])), &array(&root, &case["counts"]));
            let simplified = split_rows(&points(&array(&root, &case["simplified"])), &array(&root, &case["simplifiedCounts"]));
            let hulls = split_rows(&points(&array(&root, &case["hull"])), &array(&root, &case["hullCounts"]));
            let estimate = array(&root, &case["estimate"]);
            let parameters = array(&root, &case["parameters"]);
            let n = polygons.len();
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

