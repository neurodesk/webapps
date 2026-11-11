//! Real MATLAB R2023b references. The native workflow downloads the immutable
//! fixture and sets SAMSRF_MATLAB_REFERENCE_DIR before running this target.
use samsrf_core::{css, expr::AnonymousFunction, geometry::Hull, hrf, mapset::Maps, mat, model, optim, precision::Precision, prf, revcor_cf};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn reference() -> Option<(PathBuf, Vec<Value>)> {
    let root = std::env::var_os("SAMSRF_MATLAB_REFERENCE_DIR").map(PathBuf::from)?;
    let metadata: Value = serde_json::from_slice(&std::fs::read(root.join("reference.json")).unwrap()).unwrap();
    let cases = metadata["cases"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 741, "missing recorded MATLAB cases");
    Some((root, cases))
}

fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let bytes = std::fs::read(root.join(descriptor["file"].as_str().unwrap())).unwrap();
    let count: usize = descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).product();
    assert_eq!(bytes.len(), count * 8);
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn close(actual: f64, expected: f64, tolerance: f64, context: &str) {
    assert!(actual == expected || actual.is_nan() && expected.is_nan() || actual.is_finite() && expected.is_finite() && (actual - expected).abs() <= tolerance,
        "{context}: {actual} != {expected}, tolerance {tolerance}");
}

#[test]
fn regression_rank_and_coefficients_match_matlab_across_scales() {
    let Some((root, cases)) = reference() else { return; };
    let mut count = 0;
    for case in cases.iter().filter(|c| c["kind"] == "glm") {
        count += 1;
        let real = array(&root, &case["prediction"]);
        let imaginary = match case["prediction"]["imaginary"].as_str() {
            Some(file) if !file.is_empty() => array(&root, &json!({"file":file,"shape":case["prediction"]["shape"]})),
            _ => vec![0.0; real.len()],
        };
        let prediction: Vec<_> = real.into_iter().zip(imaginary).map(|(re, im)| num_complex::Complex64::new(re, im)).collect();
        let observations = array(&root, &case["observations"]);
        let expected = array(&root, &case["beta"]);
        let precision = if case["precision"] == "single" { Precision::Single } else { Precision::Double };
        let (beta, baseline) = css::fit_betas(&prediction, &observations, precision);
        assert_eq!(expected.len(), 2);
        for (index, actual) in [baseline, beta].into_iter().enumerate() {
            // These synthetic observations have a nonzero intercept. A zero
            // coefficient identifies the column MATLAB rejected as deficient.
            assert_eq!(actual == 0.0, expected[index] == 0.0, "{} coefficient {index}: rank decision", case["id"]);
            // The pivoted Householder solve in the design's class (lstsq).
            // Measured maxima: 3.33 eps (single) and 3.15 eps (double)
            // relative; the previous double solve reached 6.7 and 7.5 eps.
            // qr_reference.rs gates imaginary parts and 348 designs.
            let relative = if precision == Precision::Single { 4.0 * f64::from(f32::EPSILON) } else { 4.0 * f64::EPSILON };
            close(actual, expected[index], relative * expected[index].abs(), &format!("{} coefficient {index}", case["id"]));
        }
    }
    assert_eq!(count, 146, "missing regression scale/precision cases");
}

#[test]
fn css_and_hrf_optimizer_parameters_match_matlab() {
    let Some((root, cases)) = reference() else { return; };
    let original = mat::read_apertures(&std::fs::read(root.join("fit-apertures.mat")).unwrap()).unwrap();
    let function = AnonymousFunction::parse("@(P,XY)prf_gaussian_rf(P(1),P(2),P(3),XY)").unwrap();
    let mut case_count = 0;
    for case in cases.iter().filter(|c| c["kind"] == "fit") {
        case_count += 1;
        let mut apertures = original.clone();
        if case["nonnegativeApertures"] == true {
            for frame in &mut apertures.frames {
                for value in &mut frame.values { *value = value.max(0.0); }
            }
        }
        let xy = apertures.scaled_xy(9.5);
        let precision = if case["precision"] == "single" { Precision::Single } else { Precision::Double };
        let seeds = array(&root, &case["seeds"]);
        let parameters = case["seeds"]["shape"][0].as_u64().unwrap() as usize;
        let observations = array(&root, &case["observations"]);
        let volumes = case["observations"]["shape"][0].as_u64().unwrap() as usize;
        let kernel = array(&root, &case["hrf"]);
        let hrf = if kernel.len() == 1 { hrf::ErrfunHrf::Fit { tr: 1.0 } } else { hrf::ErrfunHrf::Kernel(kernel) };
        let expected = array(&root, &case["parameters"]);
        let objectives = array(&root, &case["objective"]);
        let imaginary = match case["objective"]["imaginary"].as_str() {
            Some(file) if !file.is_empty() => array(&root, &json!({"file":file,"shape":case["objective"]["shape"]})),
            _ => vec![0.0; objectives.len()],
        };
        for (vertex, seed) in seeds.chunks(parameters).enumerate() {
            let y = &observations[vertex * volumes..(vertex + 1) * volumes];
            let result = optim::fminsearch(|p| prf::errfun_with_convention(&function, &apertures, &xy, &hrf, p, y, 1, case["css"] == true, precision, css::Convention::Samsrf).unwrap(), seed, &optim::FminsearchOptions::default());
            for (parameter, &actual) in result.x.iter().enumerate() {
                close(actual, expected[vertex * parameters + parameter], if precision == Precision::Single { 0.0 } else { 1e-12 }, &format!("{} vertex {vertex} parameter {parameter}", case["id"]));
            }
            let tolerance = if precision == Precision::Single { 0.0 } else { 1e-9 };
            close(result.fval.re, objectives[vertex], tolerance, &format!("{} vertex {vertex} objective real", case["id"]));
            close(result.fval.im, imaginary[vertex], tolerance, &format!("{} vertex {vertex} objective imaginary", case["id"]));
        }
    }
    assert_eq!(case_count, 14, "missing optimizer families");
}

#[test]
fn cf_geometry_and_gaussian_residual_order_match_matlab_profiles() {
    let Some((root, cases)) = reference() else { return; };
    let mut case_count = 0;
    for case in cases.iter().filter(|c| c["kind"] == "cf" && c["precision"] == "double") {
        case_count += 1;
        let x = array(&root, &case["seedCourses"]);
        let volumes = case["seedCourses"]["shape"][0].as_u64().unwrap() as usize;
        let template = array(&root, &case["template"]);
        let template_rows = case["template"]["shape"][0].as_u64().unwrap() as usize;
        let vertices = template.len() / template_rows;
        let mut maps = Maps { vertices, values: vec!["R^2".into(), "x0".into(), "y0".into()], data: vec![0.0; 3 * vertices] };
        for row in 0..3 {
            for vertex in 0..vertices { maps.data[row * vertices + vertex] = template[vertex * template_rows + row]; }
        }
        let fit = array(&root, &case["fit"]);
        let fit = if fit.is_empty() { 0 } else if fit[0].is_nan() { 1 } else { -1 };
        let model::Model::RevCorCf(model) = model::parse_model_json(model::AnalysisKind::RevCorCf, &json!({"Name":"reference","SeedRoi":"seed","Template":"template","Fit_pRF":fit,"Global_Signal_Correction":false}).to_string()).unwrap() else { unreachable!() };
        let mut prepared = revcor_cf::Prepared::new(&model, &(0..vertices as u32).collect::<Vec<_>>(), &x.chunks(volumes).collect::<Vec<_>>(), &maps, &vec![1.0; vertices], None).unwrap();
        let weights = array(&root, &case["weights"]);
        if !weights.is_empty() {
            prepared.weights = Some((0..vertices).map(|i| {
                let entries: Vec<_> = (0..vertices).map(|j| (j, weights[j * vertices + i])).collect();
                let total = entries.iter().map(|(_, weight)| weight).sum();
                (entries, total)
            }).collect());
        }
        let profiles = array(&root, &case["profiles"]);
        let expected = array(&root, &case["maps"]);
        let rows = case["maps"]["shape"][0].as_u64().unwrap() as usize;
        let order: &[usize] = match fit { 0 => &[4, 1, 2, 5, 6, 7, 8, 3, 0], 1 => &[4, 1, 2, 5, 6, 7, 3, 0], _ => &[4, 1, 2, 5, 3, 0] };
        for (vertex, profile) in profiles.chunks(vertices).enumerate() {
            let actual = prepared.estimate_profile(profile).unwrap();
            for (row, &index) in order.iter().enumerate() {
                close(actual[row], expected[vertex * rows + index], 1e-12, &format!("{} vertex {vertex} row {row}", case["id"]));
            }
        }
    }
    assert_eq!(case_count, 9, "missing CF modes");
}

#[test]
fn polygon_simplification_matches_matlab_outside_the_fixed_point_band() {
    let Some((root, cases)) = reference() else { return; };
    let (mut asserted, mut band) = (0, 0);
    for case in cases.iter().filter(|c| c["kind"] == "polygon") {
        let points = array(&root, &case["points"]);
        let n = points.len() / 2;
        let points: Vec<_> = (0..n).map(|i| [points[i], points[n + i]]).collect();
        let expected = array(&root, &case["estimate"]);
        let (centre, area) = match Hull::of_polygon(&points) {
            Some(hull) => (hull.centroid(), hull.area()),
            None => ([f64::NAN; 2], 0.0),
        };
        // MATLAB decides triangles within 1e-5 relative of the 1e-8 cutoff on
        // its own fixed-point vertices (matlab_geometry.rs BOUNDARY_BAND, from
        // 18,387 recorded boundary triangles). polygon_191 and polygon_193 are
        // the two such cases here; they are reported, not asserted.
        if n == 3 && (1e-8 * (1.0 - 1e-12)..=1.00001e-8).contains(&thinness(&points)) && (area == 0.0) != (expected[2] == 0.0) {
            band += 1;
            println!("{}: in the fixed-point band, MATLAB area {}, port {area}", case["id"], expected[2]);
            continue;
        }
        asserted += 1;
        for axis in 0..2 { close(centre[axis], expected[axis], 1e-12, case["id"].as_str().unwrap()); }
        close(area, expected[2], 1e-12 * expected[2].abs().max(1.0), case["id"].as_str().unwrap());
    }
    assert_eq!((asserted, band), (251, 2), "polygon cases");
}

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
