//! Reverse-correlation pRF and connective-field pipelines against MATLAB R2023b
//! recordings on two hosts: the raw-input matrix of `record_revcor_matrix.m`
//! (SAMSRF_REVCOR_REFERENCE_DIR) and its constant, low-variance and
//! threshold-boundary cases (SAMSRF_REVCOR_EDGES_DIR). The production Benson reader
//! gate also reads the raw inputs (SAMSRF_MATRIX_INPUT_DIR). The native workflow
//! downloads all three pinned fixtures; any missing one fails.
use samsrf_core::apertures::Apertures;
use samsrf_core::error::Error;
use samsrf_core::geometry::{cluster_roi, unique_rows, Hull, Triangulation};
use samsrf_core::job::{Job, JobInputs, SeedInputs};
use samsrf_core::mapset::Maps;
use samsrf_core::model::{self, AnalysisKind, Model};
use samsrf_core::precision::Precision;
use samsrf_core::surface::{Faces, Surface};
use samsrf_core::timeseries::TimeSeries;
use samsrf_core::{preprocess, revcor_cf, revcor_prf, template};
use serde_json::Value;
use std::path::{Path, PathBuf};

const HOSTS: [&str; 2] = ["ubuntu-22.04", "ubuntu-24.04"];
const UNIT: f64 = 1.0 / 16_777_216.0; // 2^-24
const SIGMA_PER_FWHM: f64 = 2.0 * 1.177_410_022_515_474_6; // 2 sqrt(2 ln 2)

/// What each recording must contain per host. A missing case fails its gate.
struct Expected {
    cases: usize,
    refused: usize,
    single_cf: usize,
    single_rc: usize,
    global: usize,
    replay: usize,
    pipelines: usize,
    reader: usize,
}

const MATRIX: Expected = Expected { cases: 102, refused: 15, single_cf: 24, single_rc: 6, global: 6, replay: 69, pipelines: 69, reader: 48 };
const EDGES: Expected = Expected { cases: 24, refused: 0, single_cf: 8, single_rc: 2, global: 2, replay: 20, pipelines: 20, reader: 16 };

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

/// The spacing of single values at `value`.
fn spacing(value: f64) -> f64 {
    let v = (value as f32).abs();
    f64::from(f32::from_bits(v.to_bits() + 1) - v)
}

fn nan_max(values: &[f64]) -> f64 {
    values.iter().copied().filter(|x| !x.is_nan()).fold(f64::NAN, |m, x| if m.is_nan() || x > m { x } else { m })
}

fn nan_min(values: &[f64]) -> f64 {
    values.iter().copied().filter(|x| !x.is_nan()).fold(f64::NAN, |m, x| if m.is_nan() || x < m { x } else { m })
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

/// Single 2D fits are refused: CF because MATLAB's single `exp` decides them, RC
/// because no bound on their end-to-end parameters has been established.
#[test]
fn single_fitted_models_are_refused() {
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
        for case in pipelines(host, "cf").filter(|c| single(c) && parse(c).is_ok()) {
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
        for case in pipelines(host, "cf").filter(|c| parse(c).is_ok() && !runaway_double_gaussian(c)) {
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
        for case in host.cases.iter().filter(|c| c["kind"] == "pipeline" && parse(c).is_ok() && !runaway_double_gaussian(c)) {
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

fn perimeter(hull: &Hull) -> f64 {
    let n = hull.vertices.len();
    (0..n).map(|i| {
        let (a, b) = (hull.vertices[i], hull.vertices[(i + 1) % n]);
        (b[0] - a[0]).hypot(b[1] - a[1])
    }).sum()
}

/// Bounds on a convex hull's centroid and `sqrt(area) / (2 sqrt(2 ln 2))` when every
/// point moves by at most `epsilon` and the hull keeps its vertex set. The regions
/// are then within Hausdorff distance `epsilon`: the area changes by at most
/// `P e + pi e^2`, the symmetric difference is at most `2 P e + pi e^2`, and each of
/// its points lies within `R + e` of the centroid (`P` the perimeter, `R` the
/// farthest vertex), which bounds the centroid's move by that moment over the area.
fn hull_bounds(hull: &Hull, epsilon: f64) -> Option<(f64, f64)> {
    let area = hull.area();
    let p = perimeter(hull);
    let c = hull.centroid();
    let reach = hull.vertices.iter().map(|v| (v[0] - c[0]).hypot(v[1] - c[1])).fold(0.0, f64::max);
    let change = p * epsilon + std::f64::consts::PI * epsilon * epsilon;
    if change >= area {
        return None;
    }
    let centroid = (2.0 * p * epsilon + std::f64::consts::PI * epsilon * epsilon) * (reach + epsilon) / (area - change);
    let width = change / ((area.sqrt() + (area - change).sqrt()) * SIGMA_PER_FWHM);
    Some((centroid, width))
}

/// The hull's vertices as indices into `points`, sorted.
fn hull_indices(points: &[[f64; 2]]) -> Option<Vec<usize>> {
    let hull = Hull::of_polygon(points).unwrap()?;
    let mut indices: Vec<usize> = hull.vertices.iter().map(|v| points.iter().position(|p| p == v).unwrap()).collect();
    indices.sort_unstable();
    Some(indices)
}

/// Bounds on each position and width when the template coordinates move by at most
/// `delta`, or `None` for a vertex without an estimate. Fails on any discrete change.
fn template_bounds(prepared: &revcor_cf::Prepared, r: &[f64], theirs: &[[f64; 2]], ours: &[[f64; 2]], delta: f64, failures: &mut Failures, at: &str) -> Vec<(&'static str, f64)> {
    let max = nan_max(r);
    if max.is_nan() || max <= 0.0 {
        return Vec::new();
    }
    if prepared.model.fit_prf == samsrf_core::model::CfParameterEstimate::SummaryStatistics {
        // Order statistics move by at most delta; absolute deviations by 2 delta.
        let above = |xy: &[[f64; 2]]| unique_rows(&r.iter().zip(xy).filter(|(x, _)| **x > max / 2.0).map(|(_, p)| *p).collect::<Vec<_>>()).1;
        failures.check(above(theirs) == above(ours), || format!("{at}: the reader merges different suprathreshold coordinates"));
        return vec![("x0", delta), ("y0", delta), ("Sigma", std::f64::consts::SQRT_2 * 2.0 * delta)];
    }
    let epsilon = std::f64::consts::SQRT_2 * delta;
    let (unique_theirs, first) = unique_rows(theirs);
    let (unique_ours, first_ours) = unique_rows(ours);
    failures.check(first == first_ours, || format!("{at}: the reader merges different seed coordinates"));
    let unique_r: Vec<f64> = first.iter().map(|&j| r[j]).collect();
    let max_u = nan_max(&unique_r);
    let Some(peak) = unique_r.iter().position(|x| *x == max_u) else { return Vec::new() };
    let cluster = cluster_roi(peak, &unique_r, max_u / 2.0, &Triangulation::delaunay(&unique_theirs));
    let cluster_ours = cluster_roi(peak, &unique_r, max_u / 2.0, &Triangulation::delaunay(&unique_ours));
    failures.check(cluster == cluster_ours, || format!("{at}: the reader changes the cluster"));
    let min_u = nan_min(&unique_r);
    let negative: Vec<usize> = (0..unique_r.len()).filter(|&k| unique_r[k] < min_u / 2.0).collect();
    let mut bounds = Vec::new();
    for (label, members, rows) in [("centre", cluster, &["x0", "y0", "Centre"][..]), ("surround", negative, &["Surround"][..])] {
        let pick = |set: &[[f64; 2]]| members.iter().map(|&k| set[k]).collect::<Vec<_>>();
        let (points, points_ours) = (pick(&unique_theirs), pick(&unique_ours));
        failures.check(hull_indices(&points) == hull_indices(&points_ours), || format!("{at}: the reader changes the {label} hull"));
        match Hull::of_polygon(&points).unwrap() {
            None => {}
            Some(hull) => match hull_bounds(&hull, epsilon) {
                Some((centroid, width)) => bounds.extend(rows.iter().map(|&name| (name, if name == "x0" || name == "y0" { centroid } else { width }))),
                None => failures.check(false, || format!("{at}: the {label} hull is too thin for a bound")),
            },
        }
    }
    bounds
}

/// The production reader's Benson template instead of MATLAB's, through the job.
/// Its x0 and y0 differ from MATLAB's by up to 2e-6 (`compare.mjs` gates the reader).
/// Discrete decisions must not change: unique seed coordinates, clusters and hull
/// vertex sets. Values that do not depend on the coordinates must equal the
/// MATLAB-template run; positions and widths may differ from MATLAB only by the
/// geometric bound for the measured coordinate error, plus two single spacings of
/// output rounding. Gaussian fits are not covered (single ones are refused).
#[test]
fn production_template_reader_moves_positions_within_bounds() {
    let Some(hosts) = hosts() else { return; };
    let input = PathBuf::from(std::env::var_os("SAMSRF_MATRIX_INPUT_DIR").expect("set SAMSRF_MATRIX_INPUT_DIR with SAMSRF_REVCOR_REFERENCE_DIR"));
    let mut failures = Failures::default();
    let mut tally = Tally::default();
    for host in &hosts {
        for case in pipelines(host, "cf").filter(|c| c["mapReplayModel"]["Fit_pRF"] != 1) {
            tally.add(host);
            let id = case["id"].as_str().unwrap();
            let pre = find(&host.cases, case["preprocessing"].as_str().unwrap());
            let dataset = pre["dataset"].as_str().unwrap();
            let right = dataset.ends_with("_rh");
            let file = input.join(dataset).join(if right { "rh_benson.gii" } else { "lh_benson.gii" });
            let reader = template::read_benson_gifti(&std::fs::read(file).unwrap(), right).unwrap();
            let recorded = template_maps(host, case);
            let mut production_template = recorded.clone();
            production_template.data.copy_from_slice(&reader.data[..recorded.data.len()]);
            let seeds = vertices(&host.root, &pre["seedVertices"]);
            let xy = |maps: &Maps| -> Vec<[f64; 2]> { seeds.iter().map(|&v| [maps.row(1)[v as usize], maps.row(2)[v as usize]]).collect() };
            let (theirs, ours) = (xy(&recorded), xy(&production_template));
            let delta = theirs.iter().zip(&ours).map(|(a, b)| (a[0] - b[0]).abs().max((a[1] - b[1]).abs())).fold(0.0, f64::max);
            let expected = recorded_maps(host, case);
            let matlab_template = run(inputs(host, case, Some(recorded.clone())));
            let production = run(inputs(host, case, Some(production_template)));
            let prepared = cf_prepared(host, case, &recorded);
            let y = array(&host.root, &case["savedCourses"]);
            let volumes = shape(&case["savedCourses"])[0];
            let roi = vertices(&host.root, &case["savedVertices"]);
            let mut worst = 0.0f64;
            let rounding = rounding_courses(host, case);
            for (i, course) in y.chunks(volumes).enumerate() {
                let v = roi[i] as usize;
                let at = format!("{} {id}: vertex {v}", host.name);
                if rounding.contains(&v) {
                    let empty = production.values.iter().enumerate().all(|(row, name)| name == "Noise Ceiling" || production.row(row)[v] == 0.0);
                    failures.check(empty, || format!("{at}: a rounding-only course must give no estimate"));
                    continue;
                }
                let bounds = template_bounds(&prepared, &prepared.profile(course), &theirs, &ours, delta, &mut failures, &at);
                for (row, name) in production.values.iter().enumerate() {
                    let (a, e) = (production.row(row)[v], expected.row(row)[v]);
                    let ok = match bounds.iter().find(|(n, _)| n == name) {
                        Some(&(_, bound)) => {
                            if bound > 0.0 && a.is_finite() && e.is_finite() {
                                worst = worst.max((a - e).abs() / bound);
                            }
                            let rounding = if single(case) { 2.0 * spacing(e.abs().max(a.abs())) } else { 1e-12 * e.abs().max(1.0) };
                            within(a, e, bound + rounding)
                        }
                        None => same(a, matlab_template.row(row)[v]),
                    };
                    failures.check(ok, || format!("{at} {name}: {a} vs {e}, delta {delta:e}, bounds {bounds:?}"));
                }
            }
            println!("{} {id}: template delta {delta:.3e}, worst fraction of the bound {worst:.3}", host.name);
        }
    }
    tally.assert_complete(&hosts, "template-reader cases", |e| e.reader);
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

/// Single CF Gaussian fits below the parser's refusal, on MATLAB's template and
/// preprocessed courses: corr (MKL's `y' * A` order and its clamp), smoothing, the
/// threshold, single `exp`, the mixed-precision objective and `fminsearch`. Every
/// map value of every vertex equals MATLAB's on the AMD (CNR `auto`) host, with and
/// without global-signal correction (the single regression solves every course at
/// once), and the fits replay exactly from each host's recorded profiles. The
/// AVX-512 host's corr and regression orders are not reproduced, so there only the
/// rows the fit does not produce, without global-signal correction, are compared.
#[test]
fn single_gaussian_cf_below_the_refusal_equals_the_amd_host() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut gated = 0;
    for host in hosts.iter().filter(|host| host.expected.refused > 0) {
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
                    // With global-signal correction (refused for its regression too),
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
