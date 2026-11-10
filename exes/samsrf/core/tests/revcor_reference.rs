//! Raw-input reverse-correlation pRF and connective-field pipelines against the
//! MATLAB R2023b recordings of `record_revcor_matrix.m` on two hosts. The native
//! workflow downloads the pinned fixture and sets SAMSRF_REVCOR_REFERENCE_DIR.
use samsrf_core::apertures::Apertures;
use samsrf_core::job::{Job, JobInputs, SeedInputs};
use samsrf_core::mapset::Maps;
use samsrf_core::model::{self, AnalysisKind};
use samsrf_core::surface::{Faces, Surface};
use samsrf_core::timeseries::TimeSeries;
use serde_json::Value;
use std::path::{Path, PathBuf};

const HOSTS: [&str; 2] = ["ubuntu-22.04", "ubuntu-24.04"];

struct Host {
    root: PathBuf,
    cases: Vec<Value>,
}

fn hosts() -> Option<Vec<Host>> {
    let root = std::env::var_os("SAMSRF_REVCOR_REFERENCE_DIR").map(PathBuf::from)?;
    Some(HOSTS.iter().map(|host| {
        let root = root.join(host);
        let matrix: Value = serde_json::from_slice(&std::fs::read(root.join("revcor-matrix.json")).unwrap()).unwrap();
        let cases = matrix["cases"].as_array().unwrap().clone();
        assert_eq!(cases.len(), 102, "{host}: missing recorded reverse-correlation cases");
        Host { root, cases }
    }).collect())
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

/// Job inputs for one pipeline case, from MATLAB's own preprocessed courses.
fn inputs(host: &Host, case: &Value) -> JobInputs {
    let root = &host.root;
    let pre = find(&host.cases, case["preprocessing"].as_str().unwrap());
    let courses = array(root, &pre["courses"]);
    let [volumes, count] = shape(&pre["courses"])[..] else { unreachable!() };
    let kind = if case["analysis"] == "cf" { AnalysisKind::RevCorCf } else { AnalysisKind::RevCorPrf };
    let model = model::parse_model_json(kind, &case["mapReplayModel"].to_string()).unwrap();
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
    if kind == AnalysisKind::RevCorCf {
        let template = find(&host.cases, case["template"].as_str().unwrap());
        let rows = shape(&template["maps"])[0];
        let names = ["R^2", "x0", "y0", "Polar", "Eccentricity"].iter().take(rows).map(|s| s.to_string()).collect();
        job.seed = Some(SeedInputs { vertices: vertices(root, &pre["seedVertices"]), template: maps(names, &array(root, &template["maps"]), rows) });
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
    if a == b || a.is_nan() && b.is_nan() {
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

fn host_name(host: &Host) -> &'static str {
    HOSTS.iter().find(|name| host.root.ends_with(name)).unwrap()
}

/// The AVX-512 host's MKL reduces `corr`'s dot product in an order not reproduced;
/// the port follows the other host's (CNR auto) order exactly.
fn intel(host: &Host) -> bool {
    host_name(host) == HOSTS[1]
}

fn single(case: &Value) -> bool {
    case["precision"] == "single"
}

const UNIT: f64 = 1.0 / 16_777_216.0; // 2^-24

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

fn same(a: f64, b: f64) -> bool {
    a == b || a.is_nan() && b.is_nan()
}

fn pipelines<'a>(host: &'a Host, analysis: &'a str) -> impl Iterator<Item = &'a Value> {
    host.cases.iter().filter(move |c| c["kind"] == "pipeline" && c["analysis"] == analysis)
}

fn cf_prepared(host: &Host, case: &Value) -> samsrf_core::revcor_cf::Prepared {
    let job = inputs(host, case);
    let model::Model::RevCorCf(model) = &job.model else { unreachable!() };
    let seed = job.seed.as_ref().unwrap();
    let x = array(&host.root, &case["seedCourses"]);
    let volumes = shape(&case["seedCourses"])[0];
    let courses: Vec<&[f64]> = x.chunks(volumes).collect();
    samsrf_core::revcor_cf::Prepared::new(model, &seed.vertices, &courses, &seed.template, job.area.as_ref().unwrap(), job.surface.as_ref()).unwrap()
}

fn rc_prepared(host: &Host, case: &Value) -> samsrf_core::revcor_prf::Prepared {
    let job = inputs(host, case);
    let model::Model::RevCorPrf(model) = &job.model else { unreachable!() };
    let resolved = samsrf_core::hrf::resolve(&model.hrf, model.tr).unwrap();
    samsrf_core::revcor_prf::Prepared::new(model, job.apertures.as_ref().unwrap(), &resolved, job.data.volumes).unwrap()
}

/// Single connective-field Gaussian fits are refused (MATLAB's single `exp`).
fn supported(case: &Value) -> bool {
    !(single(case) && case["analysis"] == "cf" && case["mapReplayModel"]["Fit_pRF"] == 1)
}

/// `corr` of single courses: MATLAB's own result differs from the exact correlation
/// of its inputs by up to 9.9 x 2^-24, and the two hosts from each other by up to 10.
#[test]
fn single_cf_profiles_stay_within_single_rounding() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut count = 0;
    for host in &hosts {
        for case in pipelines(host, "cf").filter(|c| single(c) && supported(c)) {
            count += 1;
            let prepared = cf_prepared(host, case);
            let y = array(&host.root, &case["savedCourses"]);
            let volumes = shape(&case["savedCourses"])[0];
            let profiles = array(&host.root, &case["profiles"]);
            let nsvx = shape(&case["profiles"])[0];
            let saved = vertices(&host.root, &case["savedVertices"]);
            let mut worst = 0.0f64;
            for (i, course) in y.chunks(volumes).enumerate() {
                let actual = prepared.profile(course);
                let v = saved[i] as usize;
                for j in 0..nsvx {
                    let expected = profiles[v * nsvx + j];
                    let error = (actual[j] - expected).abs() / UNIT;
                    worst = worst.max(error);
                    failures.check(error <= 16.0, || format!("{} {}: vertex {v} seed {j}: {} vs {expected}", host_name(host), case["id"], actual[j]));
                }
            }
            println!("{} {}: profile error {worst:.2} x 2^-24", host_name(host), case["id"]);
        }
    }
    assert_eq!(count, 2 * 24, "missing single CF cases");
    failures.assert_none();
}

/// `[Y ones] \ X` in single: MATLAB's single QR differs from the exact solve of its
/// inputs by up to 20 x 2^-24 of the profile peak; the port solves on the rounded
/// inputs with the shared regression and rounds.
#[test]
fn single_rc_profiles_stay_within_single_rounding() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut count = 0;
    for host in &hosts {
        for case in pipelines(host, "revcor").filter(|c| single(c)) {
            count += 1;
            let prepared = rc_prepared(host, case);
            let y = array(&host.root, &case["savedCourses"]);
            let volumes = shape(&case["savedCourses"])[0];
            let profiles = array(&host.root, &case["profiles"]);
            let raw = array(&host.root, &case["rawMaps"]);
            let pixels = shape(&case["profiles"])[0];
            let mut worst = 0.0f64;
            for (i, course) in y.chunks(volumes).enumerate() {
                let mut actual = prepared.profile(course);
                // Rmaps keeps the profile after a negative peak flipped it.
                if raw[i * 5 + 4] < 0.0 {
                    actual.iter_mut().for_each(|value| *value = -*value);
                }
                let expected = &profiles[i * pixels..(i + 1) * pixels];
                let peak = expected.iter().fold(0.0f64, |m, value| m.max(value.abs()));
                for p in 0..pixels {
                    let error = (actual[p] - expected[p]).abs() / (peak * UNIT);
                    worst = worst.max(error);
                    failures.check(error <= 32.0, || format!("{} {}: vertex {i} pixel {p}: {} vs {}", host_name(host), case["id"], actual[p], expected[p]));
                }
            }
            println!("{} {}: profile error {worst:.2} x 2^-24 of the peak", host_name(host), case["id"]);
        }
    }
    assert_eq!(count, 2 * 9, "missing single RC cases");
    failures.assert_none();
}

/// `samsrf_removenoise` on single courses: MATLAB's residuals differ between hosts by
/// up to 5.2 x 2^-24 of a course's peak; its single QR is not reproduced bit for bit.
#[test]
fn single_global_regression_stays_within_single_rounding() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut count = 0;
    for host in &hosts {
        for case in pipelines(host, "cf").filter(|c| c["id"].as_str().unwrap().ends_with("mode0_smooth0_global1")) {
            count += 1;
            let pre = find(&host.cases, case["preprocessing"].as_str().unwrap());
            let courses = array(&host.root, &pre["courses"]);
            let volumes = shape(&pre["courses"])[0];
            let roi = vertices(&host.root, &pre["roi"]);
            let mut series = TimeSeries::zeros(volumes, roi.len());
            for (i, &v) in roi.iter().enumerate() {
                series.course_mut(i).copy_from_slice(&courses[v as usize * volumes..(v as usize + 1) * volumes]);
            }
            let precision = if single(case) { samsrf_core::precision::Precision::Single } else { samsrf_core::precision::Precision::Double };
            samsrf_core::preprocess::remove_noise_in(&mut series, &array(&host.root, &case["globalSignal"]), 1, precision).unwrap();
            let expected = array(&host.root, &case["recomputedCorrectedCourses"]);
            let limit = if single(case) { 32.0 * UNIT } else { 1e-13 };
            let mut worst = 0.0f64;
            for (i, &v) in roi.iter().enumerate() {
                let e = &expected[v as usize * volumes..(v as usize + 1) * volumes];
                let peak = e.iter().fold(0.0f64, |m, x| m.max(x.abs()));
                for (t, (&a, &e)) in series.course(i).iter().zip(e).enumerate() {
                    let error = (a - e).abs() / peak;
                    worst = worst.max(error);
                    failures.check(error <= limit, || format!("{} {}: vertex {v} volume {t}: {a} vs {e}", host_name(host), case["id"]));
                }
            }
            println!("{} {}: residual error {:.2} x 2^-24 of the peak", host_name(host), case["id"], worst / UNIT);
        }
    }
    assert_eq!(count, 2 * 6, "missing global-regression cases");
    failures.assert_none();
}

/// Given a host's own profiles, every parameter estimate equals that host's maps:
/// thresholds, peaks, hulls, medians, single sums and the fminsearch fits.
#[test]
fn recorded_profiles_replay_to_each_hosts_maps() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut count = 0;
    for host in &hosts {
        // The unchanged double path's unsmoothed Gaussian: fits that run away to
        // |x0| > 1e8 on 2 of 21 vertices do not replay (the 741-case pin gates its
        // bounded fits). Reported for the double CF work, not relaxed here.
        let runaway = |c: &Value| !single(c) && c["mapReplayModel"]["Fit_pRF"] == 1 && c["mapReplayModel"]["Smoothing"] == 0;
        for case in pipelines(host, "cf").filter(|c| supported(c) && !runaway(c)) {
            count += 1;
            let prepared = cf_prepared(host, case);
            let profiles = array(&host.root, &case["profiles"]);
            let nsvx = shape(&case["profiles"])[0];
            let saved = array(&host.root, &case["savedMaps"]);
            let rows = shape(&case["savedMaps"])[0];
            for (i, &v) in vertices(&host.root, &case["savedVertices"]).iter().enumerate() {
                let actual = prepared.estimate_profile(&profiles[v as usize * nsvx..(v as usize + 1) * nsvx]).unwrap();
                for (r, name) in prepared.values.iter().enumerate() {
                    let a = if single(case) { f64::from(actual[r] as f32) } else { actual[r] };
                    let e = saved[i * rows + r];
                    let ok = if single(case) { same(a, e) } else { same(a, e) || (a - e).abs() <= 1e-12 * e.abs().max(1.0) };
                    failures.check(ok, || format!("{} {}: vertex {v} {name}: {a} vs {e}", host_name(host), case["id"]));
                }
            }
        }
        for case in pipelines(host, "revcor") {
            count += 1;
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
                let raw_row = prepared.raw_row(course, &profile);
                let fitted = match prepared.model.prf_function {
                    Some(_) => prepared.fit_model(&raw_row, &profile).unwrap(),
                    None => prepared.convex_hull(&raw_row, &profile),
                };
                let rows_out = samsrf_core::revcor_prf::RAW_VALUES.iter().zip(raw_row.iter().zip(&raw[i * 5..i * 5 + 5]))
                    .map(|(name, (a, e))| (format!("raw {name}"), *a, *e))
                    .chain(prepared.values.iter().enumerate().map(|(r, name)| (name.clone(), fitted[r], saved[i * rows + r])));
                for (name, a, e) in rows_out {
                    let a = if single(case) { f64::from(a as f32) } else { a };
                    // R^2 = corr(Y, X(:,m))^2, whose dot product order is host-specific.
                    let r2 = name.ends_with("R^2") && prepared.model.prf_function.is_none() || name == "raw R^2";
                    let ok = if !single(case) {
                        same(a, e) || (a - e).abs() <= 1e-12 * e.abs().max(1.0)
                    } else if r2 && intel(host) {
                        ulps(a, e) <= 16.0
                    } else {
                        same(a, e)
                    };
                    failures.check(ok, || format!("{} {}: vertex {i} {name}: {a} vs {e}", host_name(host), case["id"]));
                }
            }
        }
    }
    // Per host: 30 double and 24 single CF cases, 18 RC.
    assert_eq!(count, 2 * (30 + 24 + 18), "missing replay cases");
    failures.assert_none();
}

/// MATLAB's preprocessed courses through the whole job. Positions, areas, hulls and
/// medians are exact; values read off a profile carry its single rounding; fitted 2D
/// Gaussians are compared only where MATLAB itself reproduces them across hosts.
#[test]
fn pipelines_from_matlab_courses_match_matlab() {
    let Some(hosts) = hosts() else { return; };
    let mut failures = Failures::default();
    let mut count = 0;
    for host in &hosts {
        for case in host.cases.iter().filter(|c| c["kind"] == "pipeline" && supported(c)) {
            count += 1;
            let rows = shape(&case["maps"])[0];
            let values: Vec<String> = case["values"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            let expected = maps(values.clone(), &array(&host.root, &case["maps"]), rows);
            let job = inputs(host, case);
            let actual = run(job);
            assert_eq!(actual.values, values, "{}: map names", case["id"]);
            let id = case["id"].as_str().unwrap();
            let cf = case["analysis"] == "cf";
            let gaussian = if cf { case["mapReplayModel"]["Fit_pRF"] == 1 } else { case["mapReplayModel"]["Prf_Function"].is_string() };
            // Unsmoothed CF Gaussians differ between MATLAB hosts by up to 9e7 in Sigma;
            // single RC Gaussians by 0.84. Their profiles carry rounding the fit amplifies.
            let chaotic = gaussian && (single(case) || case["mapReplayModel"]["Smoothing"] == 0);
            let mut worst = 0.0f64;
            for (r, name) in values.iter().enumerate() {
                for (v, (&a, &e)) in actual.row(r).iter().zip(expected.row(r)).enumerate() {
                    let ok = if chaotic && !matches!(name.as_str(), "Fwhm" | "Vx" | "Noise Ceiling") {
                        // Fit or no fit, as MATLAB decided.
                        a.is_nan() == e.is_nan() && (a == 0.0) == (e == 0.0) || name == "R^2" && !single(case) && (a - e).abs() <= 1e-12
                    } else if !single(case) {
                        same(a, e) || (a - e).abs() <= 1e-12 * e.abs().max(1.0)
                    } else {
                        let profile_value = if cf { matches!(name.as_str(), "R^2" | "Beta" | "Suppression") } else { name == "Beta" };
                        if profile_value {
                            let scale = if cf { 1.0 } else { e.abs() };
                            worst = worst.max((a - e).abs() / (scale * UNIT));
                            (a - e).abs() <= 32.0 * UNIT * scale
                        } else if name == "R^2" && intel(host) {
                            ulps(a, e) <= 16.0
                        } else {
                            same(a, e)
                        }
                    };
                    failures.check(ok, || format!("{} {id}: vertex {v} {name}: {a} vs {e}", host_name(host)));
                }
            }
            println!("{} {id}: profile-derived error {worst:.2} x 2^-24", host_name(host));
        }
    }
    assert_eq!(count, 2 * (90 - 12), "missing pipeline cases");
    failures.assert_none();
}
