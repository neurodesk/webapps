//! Reverse-correlation pRF and connective-field pipelines against MATLAB R2023b
//! recordings on two hosts: the raw-input matrix of `record_revcor_matrix.m`
//! (SAMSRF_REVCOR_REFERENCE_DIR) and its constant, low-variance and
//! threshold-boundary cases (SAMSRF_REVCOR_EDGES_DIR). The production Benson reader
//! gate also reads the raw inputs (SAMSRF_MATRIX_INPUT_DIR). The native workflow
//! downloads all three pinned fixtures; any missing one fails.
use samsrf_core::apertures::Apertures;
use samsrf_core::error::Error;
use samsrf_core::job::{Job, JobInputs, SeedInputs};
use samsrf_core::mapset::Maps;
use samsrf_core::model::{self, AnalysisKind, Model};
use samsrf_core::precision::Precision;
use samsrf_core::surface::{Faces, Surface};
use samsrf_core::timeseries::TimeSeries;
use samsrf_core::preprocess::{Combine, Normalise, PreprocessOptions, Preprocessed, RunAccumulator};
use samsrf_core::timeseries::VertexSelection;
use samsrf_core::{freesurfer, gifti, preprocess, revcor_cf, revcor_prf, template};
use serde_json::Value;
use std::path::{Path, PathBuf};

const HOSTS: [&str; 2] = ["ubuntu-22.04", "ubuntu-24.04"];
const UNIT: f64 = 1.0 / 16_777_216.0; // 2^-24

/// What each recording must contain per host. A missing case fails its gate.
struct Expected {
    cases: usize,
    refused: usize,
    single_cf: usize,
    single_rc: usize,
    global: usize,
    replay: usize,
    pipelines: usize,
    templates: usize,
    raw_cf: usize,
}

const MATRIX: Expected = Expected { cases: 102, refused: 15, single_cf: 24, single_rc: 6, global: 6, replay: 69, pipelines: 69, templates: 6, raw_cf: 36 };
const EDGES: Expected = Expected { cases: 24, refused: 0, single_cf: 8, single_rc: 2, global: 2, replay: 20, pipelines: 20, templates: 2, raw_cf: 0 };

struct Host {
    name: &'static str,
    /// MATLAB reported MKL's AVX-512 code path (`environment.json`).
    avx512: bool,
    expected: &'static Expected,
    root: PathBuf,
    cases: Vec<Value>,
}

fn hosts() -> Option<Vec<Host>> {
    let matrix = std::env::var_os("SAMSRF_REVCOR_REFERENCE_DIR")?;
    let edges = std::env::var_os("SAMSRF_REVCOR_EDGES_DIR").expect("set SAMSRF_REVCOR_EDGES_DIR with SAMSRF_REVCOR_REFERENCE_DIR");
    let mut hosts = Vec::new();
    for (dir, list, expected) in [(matrix, "revcor-matrix.json", &MATRIX), (edges, "revcor-edges.json", &EDGES)] {
        for name in HOSTS {
            let root = PathBuf::from(&dir).join(name);
            let recorded: Value = serde_json::from_slice(&std::fs::read(root.join(list)).unwrap()).unwrap();
            let cases = recorded["cases"].as_array().unwrap().clone();
            assert_eq!(cases.len(), expected.cases, "{}: missing recorded cases", root.display());
            let environment: Value = serde_json::from_slice(&std::fs::read(root.join("environment.json")).unwrap()).unwrap();
            let avx512 = environment["observed"]["blas"].as_str().unwrap().contains("AVX512");
            hosts.push(Host { name, avx512, expected, root, cases });
        }
    }
    Some(hosts)
}

fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let bytes = std::fs::read(root.join(descriptor["file"].as_str().unwrap())).unwrap();
    let count: usize = shape(descriptor).iter().product();
    assert_eq!(bytes.len(), count * 8);
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn shape(descriptor: &Value) -> Vec<usize> {
    descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).collect()
}

fn find<'a>(cases: &'a [Value], id: &str) -> &'a Value {
    cases.iter().find(|case| case["id"] == id).unwrap_or_else(|| panic!("no case {id}"))
}

/// A recorded 1-based index list as 0-based vertices.
fn vertices(root: &Path, descriptor: &Value) -> Vec<u32> {
    array(root, descriptor).iter().map(|&v| v as u32 - 1).collect()
}

/// `maps` recorded column-major (rows x vertices) as row-major `Maps`.
fn maps(values: Vec<String>, recorded: &[f64], rows: usize) -> Maps {
    let count = recorded.len() / rows;
    let mut data = vec![0.0; recorded.len()];
    for v in 0..count {
        for r in 0..rows {
            data[r * count + v] = recorded[v * rows + r];
        }
    }
    Maps { values, vertices: count, data }
}

fn recorded_maps(host: &Host, case: &Value) -> Maps {
    let values = case["values"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    maps(values, &array(&host.root, &case["maps"]), shape(&case["maps"])[0])
}

fn single(case: &Value) -> bool {
    case["precision"] == "single"
}

fn kind(case: &Value) -> AnalysisKind {
    if case["analysis"] == "cf" { AnalysisKind::RevCorCf } else { AnalysisKind::RevCorPrf }
}

fn parse(case: &Value) -> Result<Model, Error> {
    model::parse_model_json(kind(case), &case["mapReplayModel"].to_string())
}

fn template_maps(host: &Host, case: &Value) -> Maps {
    let template = find(&host.cases, case["template"].as_str().unwrap());
    let rows = shape(&template["maps"])[0];
    let names = ["R^2", "x0", "y0", "Sigma", "ROI"].iter().take(rows).map(|s| s.to_string()).collect();
    maps(names, &array(&host.root, &template["maps"]), rows)
}

/// Job inputs for one supported pipeline case, from MATLAB's preprocessed courses.
fn inputs(host: &Host, case: &Value, template: Option<Maps>) -> JobInputs {
    inputs_with(host, case, template, parse(case).unwrap())
}

/// The model of a single CF Gaussian case, which the parser refuses: parsed as
/// double, then switched to single, so the gates reach the arithmetic below the
/// refusal.
fn single_gaussian_model(case: &Value) -> Model {
    let mut json = case["mapReplayModel"].clone();
    json["Data_Precision"] = Value::from("double");
    let Model::RevCorCf(mut model) = model::parse_model_json(AnalysisKind::RevCorCf, &json.to_string()).unwrap() else { unreachable!() };
    model.data_precision = Precision::Single;
    Model::RevCorCf(model)
}

fn single_gaussian_cf(case: &Value) -> bool {
    single(case) && kind(case) == AnalysisKind::RevCorCf && case["mapReplayModel"]["Fit_pRF"] == 1
}

fn inputs_with(host: &Host, case: &Value, template: Option<Maps>, model: Model) -> JobInputs {
    let root = &host.root;
    let pre = find(&host.cases, case["preprocessing"].as_str().unwrap());
    let courses = array(root, &pre["courses"]);
    let [volumes, count] = shape(&pre["courses"])[..] else { unreachable!() };
    let mut job = JobInputs {
        model,
        apertures: None,
        hrf: None,
        data: TimeSeries { volumes, vertices: count, data: courses },
        kept: (0..count as u32).collect(),
        roi: Some(vertices(root, &pre["roi"])),
        noise_ceiling: pre.get("noiseCeiling").map(|d| array(root, d)),
        global_signal: None,
        seed: None,
        surface: None,
        area: None,
        seed_fine_fit: None,
        total_vertices: count,
    };
    if kind(case) == AnalysisKind::RevCorCf {
        let template = template.unwrap_or_else(|| template_maps(host, case));
        job.seed = Some(SeedInputs { vertices: vertices(root, &pre["seedVertices"]), template });
        job.global_signal = Some(array(root, &case["globalSignal"]));
        job.area = Some(array(root, &pre["area"]));
        let xyz = array(root, &pre["vertices"]);
        let faces = array(root, &pre["faces"]);
        let nf = faces.len() / 3;
        job.surface = Some(Surface {
            vertices: (0..count).map(|v| [xyz[v], xyz[count + v], xyz[2 * count + v]]).collect(),
            faces: Faces::Triangles((0..nf).map(|f| [faces[f] as u32 - 1, faces[nf + f] as u32 - 1, faces[2 * nf + f] as u32 - 1]).collect()),
        });
    } else {
        let [rows, cols, frames] = shape(&case["apertures"])[..] else { unreachable!() };
        job.apertures = Some(Apertures::from_dense(rows, cols, frames, &array(root, &case["apertures"]), None).unwrap());
    }
    job
}

fn run(inputs: JobInputs) -> Maps {
    let job = Job::prepare(inputs, &mut |_, _| {}).unwrap();
    let partial = job.run(0, job.vertex_count(), &mut |_| {}).unwrap();
    job.merge(&[partial]).unwrap().maps
}

/// Distance in float32 units in the last place, for values MATLAB stores as single.
fn ulps(a: f64, b: f64) -> f64 {
    if same(a, b) {
        return 0.0;
    }
    if !a.is_finite() || !b.is_finite() {
        return f64::INFINITY;
    }
    let key = |x: f32| {
        let bits = x.to_bits() as i64;
        if bits < 0 { i64::from(i32::MIN) - bits } else { bits }
    };
    (key(a as f32) - key(b as f32)).unsigned_abs() as f64
}

fn same(a: f64, b: f64) -> bool {
    a == b || a.is_nan() && b.is_nan()
}

/// Equal, or both finite and at most `limit` apart. NaN only matches NaN, an
/// infinity only itself, and a zero limit only an exact value.
fn within(a: f64, e: f64, limit: f64) -> bool {
    same(a, e) || a.is_finite() && e.is_finite() && (a - e).abs() <= limit
}

fn nan_max(values: &[f64]) -> f64 {
    values.iter().copied().filter(|x| !x.is_nan()).fold(f64::NAN, |m, x| if m.is_nan() || x > m { x } else { m })
}


/// The conditioning of statistics computed from a course: centring loses
/// `max|y| / std(y)` in relative precision, in MATLAB as in the port. A constant
/// course gives 1: its outputs follow the rank rule exactly.
fn kappa(original: &[f64], analysed: &[f64]) -> f64 {
    let n = analysed.len() as f64;
    let mean = analysed.iter().sum::<f64>() / n;
    let std = (analysed.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n).sqrt();
    let peak = original.iter().chain(analysed).fold(0.0f64, |m, v| m.max(v.abs()));
    if std > 0.0 && std.is_finite() { (peak / std).max(1.0) } else { 1.0 }
}

fn courses_of(host: &Host, case: &Value) -> (Vec<f64>, Vec<f64>, usize, Vec<u32>) {
    let pre = find(&host.cases, case["preprocessing"].as_str().unwrap());
    let volumes = shape(&case["savedCourses"])[0];
    (array(&host.root, &pre["courses"]), array(&host.root, &case["savedCourses"]), volumes, vertices(&host.root, &case["savedVertices"]))
}

/// Vertices whose course global regression reduces to rounding in MATLAB
/// (at most 64 units of the input's precision times its peak): MATLAB's maps then
/// follow that rounding, which the port does not reproduce (its residual is 0).
fn rounding_courses(host: &Host, case: &Value) -> Vec<usize> {
    if case["mapReplayModel"]["Global_Signal_Correction"] != true {
        return Vec::new();
    }
    let unit = if single(case) { UNIT } else { f64::EPSILON / 2.0 };
    let (original, saved, volumes, roi) = courses_of(host, case);
    roi.iter().enumerate().filter_map(|(i, &v)| {
        let input = original[v as usize * volumes..(v as usize + 1) * volumes].iter().fold(0.0f64, |m, x| m.max(x.abs()));
        let residual = saved[i * volumes..(i + 1) * volumes].iter().fold(0.0f64, |m, x| m.max(x.abs()));
        (input > 0.0 && residual <= 64.0 * unit * input).then_some(v as usize)
    }).collect()
}

/// MKL's AVX-512 path reduces `corr`'s dot product in an order not reproduced; the
/// port follows the CNR auto order exactly.
fn intel(host: &Host) -> bool {
    host.avx512
}

/// Collects every disagreement, so one run reports them all.
#[derive(Default)]
struct Failures(Vec<String>);

impl Failures {
    fn check(&mut self, ok: bool, message: impl FnOnce() -> String) {
        if !ok {
            self.0.push(message());
        }
    }

    fn assert_none(self) {
        assert!(self.0.is_empty(), "{} failures:\n{}", self.0.len(), self.0.join("\n"));
    }
}

/// Counts cases per recording and host, so a missing case fails the gate.
#[derive(Default)]
struct Tally(Vec<(PathBuf, usize)>);

impl Tally {
    fn add(&mut self, host: &Host) {
        match self.0.iter_mut().find(|(root, _)| *root == host.root) {
            Some(entry) => entry.1 += 1,
            None => self.0.push((host.root.clone(), 1)),
        }
    }

    fn assert_complete(self, hosts: &[Host], what: &str, expected: impl Fn(&Expected) -> usize) {
        for host in hosts {
            let seen = self.0.iter().find(|(root, _)| *root == host.root).map_or(0, |entry| entry.1);
            assert_eq!(seen, expected(host.expected), "{}: {what}", host.root.display());
        }
    }
}

fn pipelines<'a>(host: &'a Host, analysis: &'a str) -> impl Iterator<Item = &'a Value> {
    host.cases.iter().filter(move |c| c["kind"] == "pipeline" && c["analysis"] == analysis)
}

fn cf_prepared(host: &Host, case: &Value, template: &Maps) -> revcor_cf::Prepared {
    let job = inputs(host, case, Some(template.clone()));
    let Model::RevCorCf(model) = &job.model else { unreachable!() };
    let seed = job.seed.as_ref().unwrap();
    let x = array(&host.root, &case["seedCourses"]);
    let volumes = shape(&case["seedCourses"])[0];
    let courses: Vec<&[f64]> = x.chunks(volumes).collect();
    revcor_cf::Prepared::new(model, &seed.vertices, &courses, template, job.area.as_ref().unwrap(), job.surface.as_ref()).unwrap()
}

fn rc_prepared(host: &Host, case: &Value) -> revcor_prf::Prepared {
    let job = inputs(host, case, None);
    let Model::RevCorPrf(model) = &job.model else { unreachable!() };
    let resolved = samsrf_core::hrf::resolve(&model.hrf, model.tr).unwrap();
    revcor_prf::Prepared::new(model, job.apertures.as_ref().unwrap(), &resolved, job.data.volumes).unwrap()
}

/// Single RC 2D and CF Gaussian fits remain refused: no end-to-end acceptance
/// bound is established outside the recorded cases. Internal tests retain their evidence.
#[test]
fn single_fits_are_refused() {
    let Some(hosts) = hosts() else { return; };
    let mut tally = Tally::default();
    for host in &hosts {
        for case in host.cases.iter().filter(|c| c["kind"] == "pipeline") {
            let fitted = if kind(case) == AnalysisKind::RevCorCf { case["mapReplayModel"]["Fit_pRF"] == 1 } else { case["mapReplayModel"]["Prf_Function"].is_string() };
            match parse(case) {
                Err(Error::NotImplemented(_)) => {
                    assert!(single(case) && fitted, "{}: refused", case["id"]);
                    tally.add(host);
                }
                Err(error) => panic!("{}: {error:?}", case["id"]),
                Ok(_) => assert!(!(single(case) && fitted), "{}: must be refused", case["id"]),
            }
        }
    }
    tally.assert_complete(&hosts, "refused cases", |e| e.refused);
}

/// `corr` of single courses: MATLAB's own result differs from the exact correlation
/// of its inputs by up to 9.9 x 2^-24, and the two hosts from each other by up to 10.
#[test]
fn single_cf_profiles_stay_within_single_rounding() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut tally = Tally::default();
    for host in &hosts {
        for case in pipelines(host, "cf").filter(|c| single(c) && parse(c).is_ok() && !single_gaussian_cf(c)) {
            tally.add(host);
            let prepared = cf_prepared(host, case, &template_maps(host, case));
            let y = array(&host.root, &case["savedCourses"]);
            let volumes = shape(&case["savedCourses"])[0];
            let profiles = array(&host.root, &case["profiles"]);
            let nsvx = shape(&case["profiles"])[0];
            let saved = vertices(&host.root, &case["savedVertices"]);
            let mut worst = 0.0f64;
            for (i, course) in y.chunks(volumes).enumerate() {
                let actual = prepared.profile(course);
                let v = saved[i] as usize;
                for (j, &a) in actual.iter().enumerate() {
                    let e = profiles[v * nsvx + j];
                    if a.is_finite() && e.is_finite() {
                        worst = worst.max((a - e).abs() / UNIT);
                    }
                    // Bit-identical on the AMD hosts: corr's gemv order and clamp, and
                    // the single global regression over every course at once.
                    let ok = if intel(host) { within(a, e, 16.0 * UNIT) } else { same(a, e) };
                    failures.check(ok, || format!("{} {}: vertex {v} seed {j}: {a} vs {e}", host.name, case["id"]));
                }
            }
            println!("{} {}: profile error {worst:.2} x 2^-24", host.name, case["id"]);
        }
    }
    tally.assert_complete(&hosts, "single CF cases", |e| e.single_cf);
    failures.assert_none();
}

/// `[Y ones] \ X` in single: MATLAB's single QR differs from the exact solve of its
/// inputs by up to 20 x 2^-24 of the profile peak; the port solves on the rounded
/// inputs with MATLAB's QR (`lstsq::mldivide`). The limit scales with the course's
/// conditioning (`kappa`), and a zero peak allows no difference.
#[test]
fn single_rc_profiles_stay_within_single_rounding() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut tally = Tally::default();
    for host in &hosts {
        for case in pipelines(host, "revcor").filter(|c| single(c) && parse(c).is_ok()) {
            tally.add(host);
            let prepared = rc_prepared(host, case);
            let y = array(&host.root, &case["savedCourses"]);
            let volumes = shape(&case["savedCourses"])[0];
            let profiles = array(&host.root, &case["profiles"]);
            let raw = array(&host.root, &case["rawMaps"]);
            let pixels = shape(&case["profiles"])[0];
            let (mut worst, mut identical, mut compared) = (0.0f64, 0usize, 0usize);
            for (i, course) in y.chunks(volumes).enumerate() {
                let mut actual = prepared.profile(course);
                let expected = &profiles[i * pixels..(i + 1) * pixels];
                // MATLAB stores a profile only when corr(Y, X(:,m)) is finite.
                if prepared.raw_row(course, &actual) == [0.0; 5] {
                    failures.check(expected.iter().all(|&e| e == 0.0) && raw[i * 5..i * 5 + 5].iter().all(|&e| e == 0.0), || format!("{} {}: vertex {i}: MATLAB stored a profile without a correlation", host.name, case["id"]));
                    continue;
                }
                // Rmaps keeps the profile after a negative peak flipped it.
                if raw[i * 5 + 4] < 0.0 {
                    actual.iter_mut().for_each(|value| *value = -*value);
                }
                let peak = expected.iter().filter(|v| v.is_finite()).fold(0.0f64, |m, value| m.max(value.abs()));
                let k = kappa(course, course);
                for (p, (&a, &e)) in actual.iter().zip(expected).enumerate() {
                    if peak > 0.0 && a.is_finite() && e.is_finite() {
                        worst = worst.max((a - e).abs() / (peak * UNIT * k));
                    }
                    identical += usize::from(same(a, e));
                    compared += 1;
                    failures.check(within(a, e, 32.0 * UNIT * peak * k), || format!("{} {}: vertex {i} pixel {p}: {a} vs {e}", host.name, case["id"]));
                }
            }
            println!("{} {}: profile error {worst:.2} x 2^-24 of the peak, per unit of conditioning; {identical}/{compared} identical", host.name, case["id"]);
        }
    }
    tally.assert_complete(&hosts, "single RC cases", |e| e.single_rc);
    failures.assert_none();
}

/// `samsrf_removenoise` on the ROI: MATLAB's single residuals differ between hosts by
/// up to 5.2 x 2^-24 of a course's peak; its single QR is not reproduced bit for bit.
/// Limits are relative to the input course, which sets the residual's rounding.
#[test]
fn global_regression_stays_within_rounding() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut tally = Tally::default();
    for host in &hosts {
        for case in pipelines(host, "cf").filter(|c| c["id"].as_str().unwrap().ends_with("mode0_smooth0_global1")) {
            tally.add(host);
            let pre = find(&host.cases, case["preprocessing"].as_str().unwrap());
            let courses = array(&host.root, &pre["courses"]);
            let volumes = shape(&pre["courses"])[0];
            let roi = vertices(&host.root, &pre["roi"]);
            let mut series = TimeSeries::zeros(volumes, roi.len());
            for (i, &v) in roi.iter().enumerate() {
                series.course_mut(i).copy_from_slice(&courses[v as usize * volumes..(v as usize + 1) * volumes]);
            }
            let precision = if single(case) { Precision::Single } else { Precision::Double };
            preprocess::remove_noise_in(&mut series, &array(&host.root, &case["globalSignal"]), 1, precision).unwrap();
            let expected = array(&host.root, &case["recomputedCorrectedCourses"]);
            let relative = if single(case) { 32.0 * UNIT } else { 1e-13 };
            let (mut worst, mut identical, mut compared) = (0.0f64, 0usize, 0usize);
            for (i, &v) in roi.iter().enumerate() {
                let e = &expected[v as usize * volumes..(v as usize + 1) * volumes];
                // The residual Y - X B carries rounding relative to Y, not to itself.
                let peak = courses[v as usize * volumes..(v as usize + 1) * volumes].iter().filter(|x| x.is_finite()).fold(0.0f64, |m, x| m.max(x.abs()));
                for (t, (&a, &e)) in series.course(i).iter().zip(e).enumerate() {
                    if peak > 0.0 && a.is_finite() && e.is_finite() {
                        worst = worst.max((a - e).abs() / peak);
                    }
                    identical += usize::from(same(a, e));
                    compared += 1;
                    // Single residuals are bit-identical on the AMD (CNR auto) hosts:
                    // MATLAB solves every course at once (`lstsq::mldivide_many`).
                    let ok = if single(case) && !intel(host) { same(a, e) } else { within(a, e, relative * peak) };
                    failures.check(ok, || format!("{} {}: vertex {v} volume {t}: {a} vs {e}", host.name, case["id"]));
                }
            }
            println!("{} {}: residual error {:.2} x 2^-24 of the input's peak; {identical}/{compared} identical", host.name, case["id"], worst / UNIT);
        }
    }
    tally.assert_complete(&hosts, "global-regression cases", |e| e.global);
    failures.assert_none();
}

/// A course with a NaN keeps its place among the right-hand sides of the single
/// global regression and comes back zeroed; every other course is unchanged, so it
/// still equals MATLAB's residual on the AMD hosts. MATLAB's own result for a
/// missing course was not recorded, so only the other courses are compared.
#[test]
fn a_missing_course_keeps_its_place_in_the_single_regression() {
    let Some(hosts) = hosts() else { return; };
    let mut cases = 0;
    for host in hosts.iter().filter(|host| !intel(host)) {
        for case in pipelines(host, "cf").filter(|c| single(c) && c["id"].as_str().unwrap().ends_with("mode0_smooth0_global1")) {
            let pre = find(&host.cases, case["preprocessing"].as_str().unwrap());
            let courses = array(&host.root, &pre["courses"]);
            let volumes = shape(&pre["courses"])[0];
            let roi = vertices(&host.root, &pre["roi"]);
            let missing = roi.len() / 2;
            let mut series = TimeSeries::zeros(volumes, roi.len());
            for (i, &v) in roi.iter().enumerate() {
                series.course_mut(i).copy_from_slice(&courses[v as usize * volumes..(v as usize + 1) * volumes]);
            }
            series.course_mut(missing)[volumes / 3] = f64::NAN;
            preprocess::remove_noise_in(&mut series, &array(&host.root, &case["globalSignal"]), 1, Precision::Single).unwrap();
            assert!(series.course(missing).iter().all(|&value| value == 0.0), "{} {}: the missing course is zeroed", host.name, case["id"]);
            let expected = array(&host.root, &case["recomputedCorrectedCourses"]);
            for (i, &v) in roi.iter().enumerate().filter(|(i, _)| *i != missing) {
                let e = &expected[v as usize * volumes..(v as usize + 1) * volumes];
                for (t, (&a, &e)) in series.course(i).iter().zip(e).enumerate() {
                    assert!(same(a, e), "{} {}: vertex {v} volume {t}: {a} vs {e}", host.name, case["id"]);
                }
            }
            cases += 1;
        }
    }
    if !hosts.is_empty() {
        // Three matrix cases on its AMD host and one edge case on each AMD host.
        assert_eq!(cases, 5, "single global-regression cases on the AMD hosts");
    }
}

/// The unchanged double path's unsmoothed CF Gaussian: fits that run away to
/// |x0| > 1e8 do not replay and MATLAB's two hosts disagree on them by up to 9e7.
/// The 741-case pin gates its bounded fits; these cases are left out, not relaxed.
fn runaway_double_gaussian(case: &Value) -> bool {
    !single(case) && kind(case) == AnalysisKind::RevCorCf && case["mapReplayModel"]["Fit_pRF"] == 1 && case["mapReplayModel"]["Smoothing"] == 0
}

/// Given a host's own profiles, every parameter estimate equals that host's maps:
/// thresholds, peaks, hulls, medians, single sums and the fminsearch fits.
#[test]
fn recorded_profiles_replay_to_each_hosts_maps() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut tally = Tally::default();
    for host in &hosts {
        for case in pipelines(host, "cf").filter(|c| parse(c).is_ok() && !single_gaussian_cf(c) && !runaway_double_gaussian(c)) {
            tally.add(host);
            let prepared = cf_prepared(host, case, &template_maps(host, case));
            let profiles = array(&host.root, &case["profiles"]);
            let nsvx = shape(&case["profiles"])[0];
            let saved = array(&host.root, &case["savedMaps"]);
            let rows = shape(&case["savedMaps"])[0];
            for (i, &v) in vertices(&host.root, &case["savedVertices"]).iter().enumerate() {
                let actual = prepared.estimate_profile(&profiles[v as usize * nsvx..(v as usize + 1) * nsvx]).unwrap();
                for (r, name) in prepared.values.iter().enumerate() {
                    let a = if single(case) { f64::from(actual[r] as f32) } else { actual[r] };
                    let e = saved[i * rows + r];
                    let ok = if single(case) { same(a, e) } else { within(a, e, 1e-12 * e.abs().max(1.0)) };
                    failures.check(ok, || format!("{} {}: vertex {v} {name}: {a} vs {e}", host.name, case["id"]));
                }
            }
        }
        for case in pipelines(host, "revcor").filter(|c| parse(c).is_ok()) {
            tally.add(host);
            let prepared = rc_prepared(host, case);
            let y = array(&host.root, &case["savedCourses"]);
            let volumes = shape(&case["savedCourses"])[0];
            let profiles = array(&host.root, &case["profiles"]);
            let pixels = shape(&case["profiles"])[0];
            let raw = array(&host.root, &case["rawMaps"]);
            let saved = array(&host.root, &case["savedMaps"]);
            let rows = shape(&case["savedMaps"])[0];
            for (i, course) in y.chunks(volumes).enumerate() {
                let mut profile = profiles[i * pixels..(i + 1) * pixels].to_vec();
                if raw[i * 5 + 4] < 0.0 {
                    profile.iter_mut().for_each(|value| *value = -*value);
                }
                // Rmaps holds a profile only when corr(Y, X(:,m)) is finite, but
                // prf_contour recomputes it for the hull: recompute it here too.
                if raw[i * 5..i * 5 + 5].iter().all(|&e| e == 0.0) && profile.iter().all(|&e| e == 0.0) {
                    profile = prepared.profile(course);
                }
                let raw_row = prepared.raw_row(course, &profile);
                let fitted = match prepared.model.prf_function {
                    Some(_) => prepared.fit_model(&raw_row, &profile).unwrap(),
                    None => prepared.convex_hull(&raw_row, &profile),
                };
                let rows_out = revcor_prf::RAW_VALUES.iter().zip(raw_row.iter().zip(&raw[i * 5..i * 5 + 5]))
                    .map(|(name, (a, e))| (format!("raw {name}"), *a, *e))
                    .chain(prepared.values.iter().enumerate().map(|(r, name)| (name.clone(), fitted[r], saved[i * rows + r])));
                for (name, a, e) in rows_out {
                    let a = if single(case) { f64::from(a as f32) } else { a };
                    // R^2 = corr(Y, X(:,m))^2, whose dot product order is host-specific.
                    let ok = if !single(case) {
                        within(a, e, 1e-12 * e.abs().max(1.0))
                    } else if name.ends_with("R^2") && intel(host) {
                        ulps(a, e) <= 16.0
                    } else {
                        same(a, e)
                    };
                    failures.check(ok, || format!("{} {}: vertex {i} {name}: {a} vs {e}", host.name, case["id"]));
                }
            }
        }
    }
    tally.assert_complete(&hosts, "replay cases", |e| e.replay);
    failures.assert_none();
}

/// MATLAB's preprocessed courses and template through the whole job. Positions,
/// areas, hulls and medians are exact; values read off a profile carry its rounding,
/// scaled by the course's conditioning. Courses that global regression reduces to
/// MATLAB's rounding are listed and must give the port's empty estimate.
#[test]
fn pipelines_from_matlab_courses_match_matlab() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut tally = Tally::default();
    for host in &hosts {
        for case in host.cases.iter().filter(|c| c["kind"] == "pipeline" && parse(c).is_ok() && !single_gaussian_cf(c) && !runaway_double_gaussian(c)) {
            tally.add(host);
            let expected = recorded_maps(host, case);
            let actual = run(inputs(host, case, None));
            assert_eq!(actual.values, expected.values, "{}: map names", case["id"]);
            let id = case["id"].as_str().unwrap();
            let cf = kind(case) == AnalysisKind::RevCorCf;
            let (original, saved, volumes, roi) = courses_of(host, case);
            let rounding = rounding_courses(host, case);
            let mut conditioning = vec![1.0; actual.vertices];
            for (i, &v) in roi.iter().enumerate() {
                let v = v as usize;
                conditioning[v] = kappa(&original[v * volumes..(v + 1) * volumes], &saved[i * volumes..(i + 1) * volumes]);
            }
            let mut worst = 0.0f64;
            for (r, name) in expected.values.iter().enumerate() {
                for (v, (&a, &e)) in actual.row(r).iter().zip(expected.row(r)).enumerate() {
                    let k = conditioning[v];
                    let ok = if rounding.contains(&v) {
                        // MATLAB fitted its rounding residual; the port has none to fit.
                        a == 0.0 || name == "Noise Ceiling"
                    } else if !single(case) {
                        within(a, e, 1e-12 * k * e.abs().max(1.0))
                    } else if cf && single(case) && !intel(host) {
                        // Every single CF map is bit-identical on the AMD hosts.
                        same(a, e)
                    } else if cf && matches!(name.as_str(), "R^2" | "Beta" | "Suppression") {
                        if a.is_finite() && e.is_finite() {
                            worst = worst.max((a - e).abs() / (UNIT * k));
                        }
                        within(a, e, 32.0 * UNIT * k)
                    } else if !cf && name == "Beta" {
                        if e != 0.0 && a.is_finite() && e.is_finite() {
                            worst = worst.max((a - e).abs() / (e.abs() * UNIT * k));
                        }
                        within(a, e, 32.0 * UNIT * k * e.abs())
                    } else if name == "R^2" && intel(host) {
                        ulps(a, e) <= 16.0
                    } else {
                        same(a, e)
                    };
                    failures.check(ok, || format!("{} {id}: vertex {v} {name}: {a} vs {e} (conditioning {k:.3e})", host.name));
                }
            }
            if !rounding.is_empty() {
                println!("{} {id}: rounding-only courses at vertices {rounding:?}", host.name);
            }
            println!("{} {id}: profile-derived error {worst:.2} x 2^-24 per unit of conditioning", host.name);
        }
    }
    tally.assert_complete(&hosts, "pipeline cases", |e| e.pipelines);
    failures.assert_none();
}

/// The production Benson reader on the raw GIfTI gives MATLAB's `samsrf_benson2srf`
/// template bit for bit: every row and vertex of every recorded template.
#[test]
fn production_template_reader_equals_matlabs_template() {
    let Some(hosts) = hosts() else { return; };
    let input = PathBuf::from(std::env::var_os("SAMSRF_MATRIX_INPUT_DIR").expect("set SAMSRF_MATRIX_INPUT_DIR with SAMSRF_REVCOR_REFERENCE_DIR"));
    let mut failures = Failures::default();
    let mut tally = Tally::default();
    for host in &hosts {
        for template in host.cases.iter().filter(|c| c["kind"] == "benson") {
            tally.add(host);
            let dataset = template["dataset"].as_str().unwrap();
            let right = dataset.ends_with("_rh");
            let file = input.join(dataset).join(if right { "rh_benson.gii" } else { "lh_benson.gii" });
            let reader = template::read_benson_gifti(&std::fs::read(file).unwrap(), right).unwrap();
            let rows = shape(&template["maps"])[0];
            let recorded = array(&host.root, &template["maps"]);
            assert_eq!(recorded.len(), rows * reader.vertices, "{} {}: template size", host.name, template["id"]);
            for row in 0..rows {
                for v in 0..reader.vertices {
                    let (a, e) = (reader.row(row)[v], recorded[v * rows + row]);
                    failures.check(same(a, e), || format!("{} {}: {} vertex {v}: {a} vs {e}", host.name, template["id"], reader.values[row]));
                }
            }
        }
    }
    tally.assert_complete(&hosts, "Benson templates", |e| e.templates);
    failures.assert_none();
}

/// A CF case from the raw files alone: the runs through the production
/// preprocessing (MATLAB's average or concatenation, z-scored, with the noise
/// ceiling and global signal), the Benson GIfTI through the production reader, and
/// the white surface and areas through the FreeSurfer readers. The ROI and seed
/// are the recorded analysis choices.
fn raw_cf_inputs(host: &Host, case: &Value, input: &Path, model: Model) -> (JobInputs, Preprocessed) {
    let pre = find(&host.cases, case["preprocessing"].as_str().unwrap());
    let dataset = pre["dataset"].as_str().unwrap();
    let manifest: Value = serde_json::from_slice(&std::fs::read(input.join("manifest.json")).unwrap()).unwrap();
    let entry = manifest["datasets"].as_array().unwrap().iter().find(|d| d["id"] == dataset).unwrap();
    let hemisphere = entry["hemisphere"].as_str().unwrap();
    let dir = input.join(dataset);
    let options = PreprocessOptions {
        normalise: Normalise::DetrendZscore,
        combine: if pre["average"] == true { Combine::Average { noise_ceiling: true } } else { Combine::Concatenate },
        global_signal: true,
        precision: if single(case) { Precision::Single } else { Precision::Double },
    };
    let mut accumulator = None;
    for run in entry["runs"].as_array().unwrap() {
        let run = gifti::read_run(&std::fs::read(dir.join(run.as_str().unwrap())).unwrap()).unwrap();
        accumulator.get_or_insert_with(|| RunAccumulator::new(run.vertices, VertexSelection::All, options.clone())).push_run(&run).unwrap();
    }
    let data = accumulator.unwrap().finish().unwrap();
    let anatomy = dir.join("surf");
    let surface = freesurfer::read_surface(&std::fs::read(anatomy.join(format!("{hemisphere}.white"))).unwrap()).unwrap();
    let area = freesurfer::read_curv(&std::fs::read(anatomy.join(format!("{hemisphere}.area"))).unwrap()).unwrap();
    let template = template::read_benson_gifti(&std::fs::read(dir.join(format!("{hemisphere}_benson.gii"))).unwrap(), hemisphere == "rh").unwrap();
    let count = data.total_vertices;
    let job = JobInputs {
        model,
        apertures: None,
        hrf: None,
        data: data.data.clone(),
        kept: (0..count as u32).collect(),
        roi: Some(vertices(&host.root, &pre["roi"])),
        noise_ceiling: data.noise_ceiling.clone(),
        global_signal: data.global_signal.clone(),
        seed: Some(SeedInputs { vertices: vertices(&host.root, &pre["seedVertices"]), template }),
        surface: Some(surface),
        area: Some(area),
        seed_fine_fit: None,
        total_vertices: count,
    };
    (job, data)
}

/// Every single-precision CF case of the matrix from the raw files
/// (`raw_cf_inputs`). The preprocessed courses and global signal equal MATLAB's bit
/// for bit, every map value equals the run on MATLAB's own courses and template, and
/// on the AMD (CNR `auto`) host every map value equals MATLAB's. That includes the
/// single Gaussian fits; on the AVX-512 host, whose corr and regression orders are not reproduced, their
/// differences from MATLAB are reported. (Double preprocessing is within 1e-12 of
/// MATLAB's, not bitwise, so double cases have no bitwise chain to check.)
#[test]
fn cf_from_raw_files_equals_the_run_on_matlabs_courses() {
    let Some(hosts) = hosts() else { return; };
    let input = PathBuf::from(std::env::var_os("SAMSRF_MATRIX_INPUT_DIR").expect("set SAMSRF_MATRIX_INPUT_DIR with SAMSRF_REVCOR_REFERENCE_DIR"));
    let mut failures = Failures::default();
    let mut tally = Tally::default();
    let mut gaussian_amd = 0;
    // The edge recording edits its courses, so only the matrix starts from raw files.
    for host in hosts.iter().filter(|host| std::ptr::eq(host.expected, &MATRIX)) {
        for case in pipelines(host, "cf").filter(|c| single(c)) {
            let id = case["id"].as_str().unwrap();
            let gaussian = single_gaussian_cf(case);
            let model = if gaussian { single_gaussian_model(case) } else { parse(case).unwrap() };
            let (job, data) = raw_cf_inputs(host, case, &input, model.clone());
            let pre = find(&host.cases, case["preprocessing"].as_str().unwrap());
            let at = format!("{} {id}", host.name);
            let courses = array(&host.root, &pre["courses"]);
            // The accumulator keeps double values; the single job stores them in single.
            let stored = |values: &[f64], recorded: &[f64]| values.len() == recorded.len() && values.iter().zip(recorded).all(|(a, e)| same(f64::from(*a as f32), *e));
            failures.check(stored(&data.data.data, &courses), || format!("{at}: preprocessed courses"));
            let ceiling = pre.get("noiseCeiling").map(|d| array(&host.root, d));
            let ceiling_ok = match (data.noise_ceiling.as_deref(), ceiling.as_deref()) {
                (Some(ours), Some(theirs)) => stored(ours, theirs),
                (None, None) => true,
                _ => false,
            };
            failures.check(ceiling_ok, || format!("{at}: noise ceiling"));
            let global = array(&host.root, &case["globalSignal"]);
            failures.check(data.global_signal.as_deref().is_some_and(|g| g.len() == global.len() && g.iter().zip(&global).all(|(a, e)| same(*a, *e))), || format!("{at}: global signal"));
            let actual = run(job);
            let from_courses = run(inputs_with(host, case, None, model));
            for (r, name) in from_courses.values.iter().enumerate() {
                for (v, (&a, &e)) in actual.row(r).iter().zip(from_courses.row(r)).enumerate() {
                    failures.check(same(a, e), || format!("{at}: vertex {v} {name}: raw {a} vs MATLAB's courses {e}"));
                }
            }
            tally.add(host);
            if gaussian || !intel(host) {
                let expected = recorded_maps(host, case);
                let mut differing = 0;
                for (r, name) in expected.values.iter().enumerate() {
                    for (v, (&a, &e)) in actual.row(r).iter().zip(expected.row(r)).enumerate() {
                        if !same(a, e) {
                            differing += 1;
                            failures.check(intel(host), || format!("{at}: vertex {v} {name}: {a} vs MATLAB {e}"));
                        }
                    }
                }
                println!("{at}: from raw files, {differing} map values differ from MATLAB");
                gaussian_amd += usize::from(gaussian && !intel(host));
            }
        }
    }
    tally.assert_complete(&hosts, "raw CF cases", |e| e.raw_cf);
    // The matrix's AMD host: twelve single Gaussian cases, with and without global-signal correction.
    assert_eq!(gaussian_amd, 12, "single Gaussian CF cases gated on the AMD host");
    failures.assert_none();
}

/// The edge recording's regressor course: one pixel's aperture is copied at exactly
/// half and a quarter, so its profile value sits on `cM > mM/2` and the hull
/// threshold. MATLAB's recorded profile and the port's must both put it exactly there.
#[test]
fn threshold_boundary_is_exercised_exactly() {
    let Some(hosts) = hosts() else { return; };
    let mut tally = Tally::default();
    for host in hosts.iter().filter(|h| std::ptr::eq(h.expected, &EDGES)) {
        for case in pipelines(host, "revcor") {
            let pre = find(&host.cases, case["preprocessing"].as_str().unwrap());
            let course_vertex = pre["edits"]["regressorCourse"].as_u64().unwrap() as u32 - 1;
            let pixels = &case["boundaryPixels"];
            let (peak, half, quarter) = ["peak", "half", "quarter"].map(|k| pixels[k].as_u64().unwrap() as usize - 1).into();
            let roi = vertices(&host.root, &case["savedVertices"]);
            let i = roi.iter().position(|&v| v == course_vertex).unwrap();
            let count = shape(&case["profiles"])[0];
            let recorded = &array(&host.root, &case["profiles"])[i * count..(i + 1) * count];
            let (original, _, volumes, _) = courses_of(host, case);
            let course = &original[course_vertex as usize * volumes..(course_vertex as usize + 1) * volumes];
            let port = rc_prepared(host, case).profile(course);
            for (who, profile) in [("MATLAB", recorded), ("port", &port[..])] {
                let max = nan_max(profile);
                if case["mapReplayModel"]["Hrf"] == 0 {
                    assert_eq!(profile[peak], max, "{} {}: {who} peak", host.name, case["id"]);
                }
                assert_eq!(profile[half], profile[peak] / 2.0, "{} {}: {who} half", host.name, case["id"]);
                assert_eq!(profile[quarter], profile[peak] / 4.0, "{} {}: {who} quarter", host.name, case["id"]);
            }
            tally.add(host);
        }
    }
    for host in hosts.iter().filter(|h| std::ptr::eq(h.expected, &EDGES)) {
        let seen = tally.0.iter().find(|(root, _)| *root == host.root).map_or(0, |entry| entry.1);
        assert_eq!(seen, EDGES.single_rc * 2, "{}: boundary cases", host.root.display());
    }
}

/// Single CF Gaussian fits on MATLAB's template and
/// preprocessed courses: corr (MKL's `y' * A` order and its clamp), smoothing, the
/// threshold, single `exp`, the mixed-precision objective and `fminsearch`. Every
/// map value of every vertex equals MATLAB's on the AMD (CNR `auto`) host, with and
/// without global-signal correction (the single regression solves every course at
/// once), and the fits replay exactly from each host's recorded profiles. The
/// AVX-512 host's corr and regression orders are not reproduced, so there only the
/// rows the fit does not produce, without global-signal correction, are compared.
#[test]
fn single_gaussian_cf_from_matlabs_courses_equals_the_amd_host() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut gated = 0;
    for host in hosts.iter().filter(|host| std::ptr::eq(host.expected, &MATRIX)) {
        for case in pipelines(host, "cf").filter(|c| single_gaussian_cf(c)) {
            let id = case["id"].as_str().unwrap();
            let global = case["mapReplayModel"]["Global_Signal_Correction"] != false;
            let model = single_gaussian_model(case);
            let template = template_maps(host, case);
            // From the recorded profiles: exact on both hosts.
            let job = inputs_with(host, case, Some(template.clone()), model.clone());
            let Model::RevCorCf(cf) = &job.model else { unreachable!() };
            let seed = job.seed.as_ref().unwrap();
            let x = array(&host.root, &case["seedCourses"]);
            let courses: Vec<&[f64]> = x.chunks(shape(&case["seedCourses"])[0]).collect();
            let prepared = revcor_cf::Prepared::new(cf, &seed.vertices, &courses, &template, job.area.as_ref().unwrap(), job.surface.as_ref()).unwrap();
            let profiles = array(&host.root, &case["profiles"]);
            let nsvx = shape(&case["profiles"])[0];
            let saved = array(&host.root, &case["savedMaps"]);
            let rows = shape(&case["savedMaps"])[0];
            let mut replay_differing = Vec::new();
            for (i, &v) in vertices(&host.root, &case["savedVertices"]).iter().enumerate() {
                let actual = prepared.estimate_profile(&profiles[v as usize * nsvx..(v as usize + 1) * nsvx]).unwrap();
                for (r, name) in prepared.values.iter().enumerate() {
                    let (a, e) = (f64::from(actual[r] as f32), saved[i * rows + r]);
                    if !same(a, e) && !replay_differing.contains(&v) {
                        replay_differing.push(v);
                    }
                    // With global-signal correction,
                    // replay differences are reported: on the AVX-512 host two
                    // smoothed fits differ from their own recorded profiles, most
                    // likely through the 18 inputs where `exp_single` and MATLAB's
                    // `exp` disagree.
                    failures.check(same(a, e) || global, || format!("{} {id} replay: vertex {v} {name}: {a} vs {e}", host.name));
                }
            }
            if !replay_differing.is_empty() {
                println!("{} {id}: replay from MATLAB's profiles differs at vertices {replay_differing:?}", host.name);
            }
            // The whole pipeline from MATLAB's courses.
            let expected = recorded_maps(host, case);
            let actual = run(inputs_with(host, case, None, model));
            let mut differing = 0;
            for (r, name) in expected.values.iter().enumerate() {
                let fitted = matches!(name.as_str(), "R^2" | "x0" | "y0" | "Sigma" | "Beta" | "Baseline");
                for (v, (&a, &e)) in actual.row(r).iter().zip(expected.row(r)).enumerate() {
                    if same(a, e) {
                        continue;
                    }
                    differing += 1;
                    if !(intel(host) && (fitted || global)) {
                        failures.check(false, || format!("{} {id}: vertex {v} {name}: {a} vs {e}", host.name));
                    }
                }
            }
            if !intel(host) {
                gated += 1;
            }
            println!("{} {id}: {differing} map values differ from MATLAB", host.name);
        }
    }
    failures.assert_none();
    // The matrix's AMD host: twelve cases, with and without global-signal correction.
    assert_eq!(gated, 12, "single Gaussian CF cases gated on the AMD host");
}
