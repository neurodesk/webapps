//! The focused MATLAB probes (`focused-probes-reference.json`, recorded by
//! `record_focused_probes.m`) against the predictions fixed beforehand in
//! `packages/samsrf/validation/matlab/focused-probes-predictions.md`. Each
//! prediction is evaluated by the port itself on the same inputs.
//!
//! Data: `SAMSRF_FOCUSED_PROBES_DIR` (the recording: `manifest.json` and one
//! folder per host with `compatible` and `repeat` processes), with
//! `SAMSRF_REVCOR_REFERENCE_DIR` (the pinned single RC profiles the Hooke-Jeeves
//! section fitted), `SAMSRF_MATLAB_NUMERICS2_DIR` (the original complex courses),
//! and `SAMSRF_SINGLE_TRIG_DIR` (MATLAB's recorded sin and cos).
//! Without the first, the fixture tests return; the `refuses_*` tests always run.
//!
//! Everything read from the recording passes the checked boundary below before it
//! is indexed: the host and case inventories are the recorder's, rebuilt here from
//! its rules, and every array descriptor's class, realness, shape and byte count
//! is the one its field must have.
use num_complex::Complex64;
use samsrf_core::apertures::Apertures;
use samsrf_core::matlab_math as m;
use samsrf_core::model::{self, AnalysisKind, Model};
use samsrf_core::precision::{cos_single, sin_single, Precision};
use samsrf_core::revcor_prf;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

#[path = "support/checked.rs"]
mod checked;
use checked::{array, integer, matrix, number, read_json, text, Checked, Class, Nan};

const HOSTS: [&str; 2] = ["ubuntu-22.04", "ubuntu-24.04"];

// ---- the recorder's inventory ------------------------------------------------------

/// The Hooke-Jeeves cases: the three single RC 2D pipelines of each pin host, a
/// Nelder-Mead control and two step sets (`hooke_jeeves_cases`).
const PIPELINES: [&str; 3] = [
    "revcor_single_x001_lh_average1_rc_gaussian",
    "revcor_single_x001_lh_average0_rc_gaussian",
    "revcor_single_x001_rh_average1_rc_gaussian",
];
const ALGORITHMS: [(&str, Option<[f64; 3]>); 3] = [
    ("nelder-mead-control", None),
    ("hooke-jeeves-1", Some([0.1, 0.1, 0.1])),
    ("hooke-jeeves-2", Some([0.05, 0.05, 0.02])),
];

struct HookeJeevesSpec {
    id: String,
    pin_host: &'static str,
    pipeline: &'static str,
    algorithm: &'static str,
    steps: Option<[f64; 3]>,
}

fn hooke_jeeves_specs() -> Vec<HookeJeevesSpec> {
    let mut specs = Vec::new();
    for pin_host in HOSTS {
        for pipeline in PIPELINES {
            for (algorithm, steps) in ALGORITHMS {
                let id = format!("hj_{}_{pipeline}_{algorithm}", pin_host.replace('.', ""));
                specs.push(HookeJeevesSpec {
                    id,
                    pin_host,
                    pipeline,
                    algorithm,
                    steps,
                });
            }
        }
    }
    specs
}

/// The complex sparse courses of numerics2 longer than 800 samples, and their
/// lengths; each is probed at 256 and every multiple of 512 below its length
/// (`conv_boundary_cases`).
const CONV_SOURCES: [(&str, usize); 10] = [
    ("conv_complex_n1000_nnz244", 1000),
    ("conv_complex_n1000_nnz245", 1000),
    ("conv_complex_n1000_nnz246", 1000),
    ("conv_complex_n1000_nnz247", 1000),
    ("conv_complex_n1000_nnz248", 1000),
    ("conv_complex_n1000_nnz249", 1000),
    ("convs_sparse_complex_n1000", 1000),
    ("convs_sparse_complex_n1032", 1032),
    ("convs_sparse_complex_n1200", 1200),
    ("convs_sparse_complex_n2000", 2000),
];
const CONV_TAPS: usize = 33;

struct ConvSpec {
    id: String,
    source: &'static str,
    n: usize,
    centre: usize,
}

fn conv_specs() -> Vec<ConvSpec> {
    let mut specs = Vec::new();
    for (source, n) in CONV_SOURCES {
        for centre in std::iter::once(256).chain((512..n).step_by(512)) {
            specs.push(ConvSpec {
                id: format!("conv512_{source}_c{centre}"),
                source,
                n,
                centre,
            });
        }
    }
    specs
}

/// Every case of a recording is one of the recorder's, each exactly once, with the
/// identity fields its id implies.
fn check_inventory(cases: &[Value]) -> Checked<()> {
    let mut found = BTreeMap::new();
    for case in cases {
        let id = text(case, "id")?;
        if found.insert(id, case).is_some() {
            return Err(format!("case {id} appears twice"));
        }
    }
    let mut expected: BTreeMap<String, Value> = BTreeMap::new();
    for spec in hooke_jeeves_specs() {
        let steps = spec.steps.map_or(Value::Null, |s| json!(s));
        expected.insert(spec.id, json!({"kind": "hooke-jeeves", "host": spec.pin_host, "pipeline": spec.pipeline, "algorithm": spec.algorithm, "steps": steps}));
    }
    for spec in conv_specs() {
        expected.insert(spec.id, json!({"kind": "conv-512", "source": spec.source, "n": spec.n, "taps": CONV_TAPS, "centre": spec.centre}));
    }
    expected.insert("trig_position".into(), json!({"kind": "trig-position"}));
    expected.insert("dot_short".into(), json!({"kind": "dot-short"}));
    let (have, want): (BTreeSet<&str>, BTreeSet<&str>) = (
        found.keys().copied().collect(),
        expected.keys().map(String::as_str).collect(),
    );
    if have != want {
        return Err(format!(
            "missing cases {:?}, unexpected {:?}",
            want.difference(&have).collect::<Vec<_>>(),
            have.difference(&want).collect::<Vec<_>>()
        ));
    }
    for (id, fields) in &expected {
        for (key, value) in fields.as_object().unwrap() {
            let actual = &found[id.as_str()][key];
            let same = match (actual.as_f64(), value.as_f64()) {
                (Some(a), Some(b)) => a == b,
                _ => actual == value,
            };
            if !same {
                return Err(format!("{id}: {key} is {actual}, expected {value}"));
            }
        }
    }
    Ok(())
}

fn find<'a>(cases: &'a [Value], id: &str) -> &'a Value {
    cases
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("case {id}"))
}

#[derive(Debug)]
struct Recording {
    host: String,
    cpu: String,
    dir: PathBuf,
    cases: Vec<Value>,
}

/// Both recording hosts, each with its CPU and its first process's complete cases.
fn recordings(root: &Path) -> Checked<Vec<Recording>> {
    let manifest = read_json(&root.join("manifest.json"))?;
    let hosts = manifest["hosts"]
        .as_object()
        .ok_or("manifest: hosts is not an object")?;
    let names: BTreeSet<&str> = hosts.keys().map(String::as_str).collect();
    if names != BTreeSet::from(HOSTS) {
        return Err(format!("manifest hosts {names:?}, expected {HOSTS:?}"));
    }
    let mut recordings = Vec::new();
    for host in HOSTS {
        let cpu = text(&hosts[host], "cpu")?.to_string();
        let dir = root.join(host).join("compatible");
        let recording = read_json(&dir.join("focused.json"))?;
        let cases = recording["cases"]
            .as_array()
            .ok_or_else(|| format!("{host}: cases is not a list"))?
            .clone();
        check_inventory(&cases).map_err(|e| format!("{host}: {e}"))?;
        recordings.push(Recording {
            host: host.to_string(),
            cpu,
            dir,
            cases,
        });
    }
    Ok(recordings)
}

fn root() -> Option<PathBuf> {
    std::env::var_os("SAMSRF_FOCUSED_PROBES_DIR").map(PathBuf::from)
}

fn fixture() -> Option<Vec<Recording>> {
    root().map(|root| recordings(&root).unwrap())
}

// ---- hooke-jeeves --------------------------------------------------------------

/// The pinned pipeline case a Hooke-Jeeves probe fitted, from the revcor recording.
fn pinned_case(revcor: &Path, host: &str, id: &str) -> (PathBuf, Value) {
    let root = revcor.join(host);
    let matrix = read_json(&root.join("revcor-matrix.json")).unwrap();
    let cases = matrix["cases"].as_array().expect("revcor cases");
    let found: Vec<&Value> = cases.iter().filter(|c| c["id"] == id).collect();
    assert_eq!(found.len(), 1, "{host} {id}");
    (root, found[0].clone())
}

/// The port's prepared RC fit for the case, single precision, with the probe's
/// algorithm: built test-only, since the parser refuses single 2D fits.
fn port_fit(
    root: &Path,
    case: &Value,
    steps: Option<[f64; 3]>,
    frames: usize,
) -> revcor_prf::Prepared {
    let mut json = case["mapReplayModel"].clone();
    json["Data_Precision"] = Value::from("double");
    if let Some(steps) = steps {
        json["Hooke_Jeeves_Steps"] = Value::from(steps.to_vec());
    }
    let Model::RevCorPrf(mut rc) =
        model::parse_model_json(AnalysisKind::RevCorPrf, &json.to_string()).unwrap()
    else {
        unreachable!()
    };
    rc.data_precision = Precision::Single;
    let apertures = array(
        root,
        &case["apertures"],
        Class::Double,
        &[None, None, Some(frames)],
        Nan::Refused,
    )
    .unwrap();
    let [rows, cols, frames] = apertures.shape[..] else {
        unreachable!()
    };
    let apertures = Apertures::from_dense(rows, cols, frames, &apertures.values, None).unwrap();
    let resolved = samsrf_core::hrf::resolve(&rc.hrf, rc.tr).unwrap();
    revcor_prf::Prepared::new(&rc, &apertures, &resolved, frames).unwrap()
}

/// One fit's outcome against MATLAB's recorded `samsrf_fit2dprf` result, bit for
/// bit at the recorded double precision. `port` is `fit_model`'s row, `[R², params]`,
/// or all NaN when the keep rule rejected the fit. For a fit MATLAB's keep rule
/// rejects, only the rejection is compared: `fit_model` does not return the
/// parameters it rejected.
fn compare_fit(matlab: &[f64], r2: f64, keep: bool, port: &[f64]) -> Checked<()> {
    if port.len() != matlab.len() + 1 {
        return Err(format!(
            "the port returned {} values for {} parameters",
            port.len(),
            matlab.len()
        ));
    }
    let port_rejects = port.iter().all(|x| x.is_nan());
    if !keep {
        return if port_rejects {
            Ok(())
        } else {
            Err("MATLAB's keep rule rejects the fit; the port keeps it".into())
        };
    }
    for (row, (expected, actual)) in std::iter::once(r2)
        .chain(matlab.iter().copied())
        .zip(port)
        .enumerate()
    {
        if expected.to_bits() != actual.to_bits() {
            return Err(format!("row {row}: MATLAB {expected:e}, port {actual:e}"));
        }
    }
    Ok(())
}

/// Per pin host: Hooke-Jeeves fits, how many MATLAB's keep rule keeps and rejects,
/// the distinct (pipeline, vertex) pairs kept, and the control's kept fits.
#[derive(Default)]
struct Tally {
    fits: usize,
    kept: usize,
    rejected: usize,
    kept_vertices: BTreeSet<(&'static str, usize)>,
    control_kept: usize,
}

/// Each Hooke-Jeeves probe starts from the loop's double raw rows. The control
/// reproduces the pinned maps; for every fit MATLAB keeps, the port gives its
/// parameters and R² bit for bit, and it rejects every fit MATLAB rejects (the
/// amended predictions; the first run's section is void).
#[test]
fn hooke_jeeves_probes() {
    let Some(recordings) = fixture() else { return };
    let revcor = PathBuf::from(
        std::env::var_os("SAMSRF_REVCOR_REFERENCE_DIR").expect("set SAMSRF_REVCOR_REFERENCE_DIR"),
    );
    for Recording {
        host,
        cpu,
        dir,
        cases,
    } in &recordings
    {
        let mut tally: BTreeMap<&str, Tally> = BTreeMap::new();
        let mut traces = 0;
        for spec in hooke_jeeves_specs() {
            let case = find(cases, &spec.id);
            let (pinned_root, pinned) = pinned_case(&revcor, spec.pin_host, spec.pipeline);
            let model_json = &pinned["mapReplayModel"];
            let names = model_json["Param_Names"]
                .as_array()
                .expect("Param_Names")
                .len();
            let scaled: Vec<bool> = matrix(&model_json["Scaled_Param"], 1, names)
                .unwrap()
                .iter()
                .map(|&s| integer(s, 0, 1).unwrap() == 1)
                .collect();
            let scaling = number(&model_json["Scaling_Factor"]).unwrap();
            let threshold = number(&model_json["R2_Threshold"]).unwrap();
            let rows = names + 2;
            let raw = array(
                &pinned_root,
                &pinned["rawMaps"],
                Class::Single,
                &[Some(5), None],
                Nan::Allowed,
            )
            .unwrap();
            let columns = raw.shape[1];
            let profiles = array(
                &pinned_root,
                &pinned["profiles"],
                Class::Single,
                &[None, Some(columns)],
                Nan::Refused,
            )
            .unwrap();
            let pixels = profiles.shape[0];
            let saved = array(
                &pinned_root,
                &pinned["savedMaps"],
                Class::Single,
                &[None, Some(columns)],
                Nan::Allowed,
            )
            .unwrap();
            let saved_rows = saved.shape[0];
            assert!(saved_rows > rows, "{}", spec.id);
            let frames = array(
                &pinned_root,
                &pinned["savedCourses"],
                Class::Single,
                &[None, Some(columns)],
                Nan::Allowed,
            )
            .unwrap()
            .shape[0];

            // The fitted vertices are the recorder's rule on the pinned raw maps.
            let fitted: Vec<usize> = (0..columns)
                .filter(|&v| raw.values[v * 5] > threshold)
                .collect();
            let vertices: Vec<usize> = matrix(&case["vertices"], 1, fitted.len())
                .unwrap()
                .iter()
                .map(|&v| integer(v, 1, columns).unwrap() - 1)
                .collect();
            assert_eq!(vertices, fitted, "{}", spec.id);
            let g = vertices.len();
            let parameters = array(
                dir,
                &case["parameters"],
                Class::Double,
                &[Some(rows), Some(g)],
                Nan::Refused,
            )
            .unwrap();
            let r2 = array(
                dir,
                &case["r2"],
                Class::Double,
                &[Some(1), Some(g)],
                Nan::Refused,
            )
            .unwrap();
            let loop_raw = array(
                dir,
                &case["loopRaw"],
                Class::Double,
                &[Some(5), Some(g)],
                Nan::Refused,
            )
            .unwrap();
            let classes = case["classes"].as_array().expect("classes");
            assert_eq!(classes.len(), g, "{}", spec.id);
            // H1': double parameters and seeds, single R² (classes of fP, fR, seeds).
            assert!(
                classes.iter().all(|c| c == "double,single,double"),
                "{}",
                spec.id
            );

            let prepared = port_fit(&pinned_root, &pinned, spec.steps, frames);
            let entry = tally.entry(spec.pin_host).or_default();
            for (i, &v) in vertices.iter().enumerate() {
                let matlab = &parameters.values[i * rows..(i + 1) * rows];
                assert!(
                    Class::Single.holds(r2.values[i]),
                    "{} vertex {v}: R² is not a single",
                    spec.id
                );
                let keep = (0..names).all(|p| !scaled[p] || matlab[p].abs() <= scaling * 1.5);
                // The loop's double raw row rounds to the pinned single one.
                let raw_row: [f64; 5] = std::array::from_fn(|r| loop_raw.values[i * 5 + r]);
                assert!(
                    (0..5).all(|r| f64::from(raw_row[r] as f32).to_bits()
                        == raw.values[v * 5 + r].to_bits()),
                    "{} vertex {v}",
                    spec.id
                );
                let port = prepared
                    .fit_model(&raw_row, &profiles.values[v * pixels..(v + 1) * pixels])
                    .unwrap();
                // H2' (and the port on the control): at the recorded double precision.
                compare_fit(matlab, r2.values[i], keep, &port)
                    .unwrap_or_else(|e| panic!("{host} {} vertex {v}: {e}", spec.id));
                if spec.steps.is_none() {
                    // Control: MATLAB's Nelder-Mead gives the pinned saved maps (single).
                    let expected: Vec<f64> = if keep {
                        std::iter::once(r2.values[i])
                            .chain(matlab.iter().copied())
                            .map(|x| f64::from(x as f32))
                            .collect()
                    } else {
                        vec![f64::NAN; rows + 1]
                    };
                    for (r, e) in expected.iter().enumerate() {
                        let s = saved.values[v * saved_rows + r];
                        assert!(
                            e.to_bits() == s.to_bits() || e.is_nan() && s.is_nan(),
                            "{} vertex {v} row {r}: {e:e} vs pinned {s:e}",
                            spec.id
                        );
                    }
                    entry.control_kept += usize::from(keep);
                    continue;
                }
                entry.fits += 1;
                if keep {
                    entry.kept += 1;
                    entry.kept_vertices.insert((spec.pipeline, v));
                } else {
                    entry.rejected += 1;
                }
            }
            for trace in case["traces"].as_array().expect("traces") {
                let evaluations = trace["evaluations"].as_array().expect("evaluations");
                // The logged search is samsrf_fit2dprf's; each error is a single value
                // (the last column is isa(R, 'single')) that the search keeps in a double.
                assert_eq!(
                    (text(trace, "parameterClass"), text(trace, "errorClass")),
                    (Ok("double"), Ok("double"))
                );
                assert_eq!(trace["equalsFit2dprf"], true);
                let width = rows + 2;
                let log = matrix(&trace["evaluations"], evaluations.len(), width).unwrap();
                assert!(!log.is_empty() && log.chunks(width).all(|row| Class::Single.holds(row[width - 2]) && row[width - 1] == 1.0), "{}", spec.id);
                traces += 1;
            }
            if spec.steps.is_some() {
                assert_eq!(
                    case["traces"].as_array().unwrap().len(),
                    2.min(g),
                    "{}",
                    spec.id
                );
            }
        }
        for (pin_host, t) in &tally {
            let distinct = t.kept_vertices.len();
            println!("{host} ({cpu}) profiles of {pin_host}: {} Hooke-Jeeves fits, {} kept, {} rejected, {distinct} distinct kept vertices; control keeps {}", t.fits, t.kept, t.rejected, t.control_kept);
            assert_eq!(
                (t.fits, t.kept, t.rejected, distinct, t.control_kept),
                (78, 43, 35, 30, 13),
                "{host} {pin_host}"
            );
        }
        assert_eq!((tally.len(), traces), (2, 24), "{host}");
    }
}

// ---- conv-512 ------------------------------------------------------------------

/// The pairs `conv_boundary_cases` probes: nonzero positions within the window
/// of the region's outputs, no further apart than the kernel.
fn conv_pairs(nonzero: &[usize], first: usize, last: usize) -> Vec<(usize, usize)> {
    let positions: Vec<usize> = nonzero
        .iter()
        .copied()
        .filter(|&p| p + CONV_TAPS > first && p <= last)
        .collect();
    let mut pairs = Vec::new();
    for (a, &pa) in positions.iter().enumerate() {
        for &pb in &positions[a + 1..] {
            if pb - pa < CONV_TAPS {
                pairs.push((pa, pb));
            }
        }
    }
    pairs
}

/// Recover the recorder's nonzero pattern from the separately pinned original
/// complex course, rather than allowing the probe to define its own coverage.
fn conv_source_pattern(dir: &Path, source: &Value, n: usize) -> Vec<usize> {
    assert_eq!(source["kind"], "conv");
    assert_eq!(source["isreal"], false);
    let mut real = source["y"].clone();
    let imaginary_file = text(&real, "imaginary").unwrap().to_string();
    assert!(!imaginary_file.is_empty());
    real["imaginary"] = json!("");
    let mut imaginary = real.clone();
    imaginary["file"] = json!(imaginary_file);
    let re = array(dir, &real, Class::Double, &[Some(n), Some(1)], Nan::Refused).unwrap();
    let im = array(
        dir,
        &imaginary,
        Class::Double,
        &[Some(n), Some(1)],
        Nan::Refused,
    )
    .unwrap();
    array(
        dir,
        &source["kernel"],
        Class::Double,
        &[Some(CONV_TAPS), Some(1)],
        Nan::Refused,
    )
    .unwrap();
    (0..n)
        .filter(|&i| re.values[i] != 0.0 || im.values[i] != 0.0)
        .collect()
}

/// Every pair probe's counts equal the port's `convolve_complex` on the same course
/// (H-seq), in every region; the control regions (centre 256) included.
#[test]
fn conv_512_probes() {
    let Some(recordings) = fixture() else { return };
    let big = 2f64.powi(60);
    let source_dir = PathBuf::from(
        std::env::var_os("SAMSRF_MATLAB_NUMERICS2_DIR").expect("set SAMSRF_MATLAB_NUMERICS2_DIR"),
    )
    .join("ubuntu-22.04")
    .join("compatible");
    let source_recording = read_json(&source_dir.join("numerics.json")).unwrap();
    let source_cases = source_recording["cases"].as_array().expect("source cases");
    for Recording {
        host,
        cpu,
        dir,
        cases,
    } in &recordings
    {
        let mut probed = 0;
        for spec in conv_specs() {
            let case = find(cases, &spec.id);
            let (n, first, last) = (spec.n, spec.centre - 15, (spec.centre + 14).min(spec.n - 1));
            let outputs: Vec<usize> = (first..=last).collect();
            let recorded: Vec<usize> = matrix(&case["outputs"], 1, outputs.len())
                .unwrap()
                .iter()
                .map(|&k| integer(k, 0, n - 1).unwrap())
                .collect();
            assert_eq!(recorded, outputs, "{}", spec.id);
            let sources: Vec<&Value> = source_cases
                .iter()
                .filter(|c| c["id"] == spec.source)
                .collect();
            assert_eq!(sources.len(), 1, "{} source inventory", spec.id);
            let source_pattern = conv_source_pattern(&source_dir, sources[0], n);
            let nonzero = array(
                dir,
                &case["nonzero"],
                Class::Double,
                &[Some(source_pattern.len()), Some(1)],
                Nan::Refused,
            )
            .unwrap();
            let nonzero: Vec<usize> = nonzero
                .values
                .iter()
                .map(|&i| integer(i, 0, n - 1).unwrap())
                .collect();
            assert!(
                nonzero.windows(2).all(|w| w[0] < w[1]) && 4 * nonzero.len() < n,
                "{}",
                spec.id
            );
            assert_eq!(
                nonzero, source_pattern,
                "{} original source pattern",
                spec.id
            );
            let expected = conv_pairs(&source_pattern, first, last);
            let count = expected.len();
            let pairs = array(
                dir,
                &case["pairs"],
                Class::Double,
                &[Some(count), Some(2)],
                Nan::Refused,
            )
            .unwrap();
            let pairs: Vec<(usize, usize)> = (0..count)
                .map(|p| {
                    (
                        integer(pairs.values[p], 0, n - 1).unwrap(),
                        integer(pairs.values[count + p], 0, n - 1).unwrap(),
                    )
                })
                .collect();
            assert_eq!(pairs, expected, "{}", spec.id);
            let re = array(
                dir,
                &case["real"],
                Class::Double,
                &[Some(count), Some(outputs.len())],
                Nan::Refused,
            )
            .unwrap();
            let im = array(
                dir,
                &case["imaginary"],
                Class::Double,
                &[Some(count), Some(outputs.len())],
                Nan::Refused,
            )
            .unwrap();
            let mut differing = 0;
            for (p, &(a, b)) in pairs.iter().enumerate() {
                for part in 0..2 {
                    let mut y = vec![Complex64::new(0.0, 0.0); n];
                    for &i in &nonzero {
                        y[i] = Complex64::new(1.0, 1.0);
                    }
                    if part == 0 {
                        y[a] = Complex64::new(big, 1.0);
                        y[b] = Complex64::new(-big, 1.0);
                    } else {
                        y[a] = Complex64::new(1.0, big);
                        y[b] = Complex64::new(1.0, -big);
                    }
                    let port = m::convolve_complex(&y, &[1.0; CONV_TAPS], 1);
                    for (o, &k) in outputs.iter().enumerate() {
                        let (matlab, ours) = if part == 0 {
                            (re.values[o * count + p], port[k].re)
                        } else {
                            (im.values[o * count + p], port[k].im)
                        };
                        differing += usize::from(ours.to_bits() != matlab.to_bits());
                    }
                }
            }
            println!(
                "{host} ({cpu}) {}: {count} pairs, {differing} counts differ from H-seq",
                spec.id
            );
            // H-seq holds in every region: H-split and H-tile are rejected.
            assert_eq!(differing, 0, "{host} {}", spec.id);
            probed += count;
        }
        assert!(probed > 0, "{host}");
    }
}

// ---- trig-position ---------------------------------------------------------------

/// `round(linspace(1, rows, 256))` in the recorder, converted to zero-based
/// indices. The denominator is odd, so no midpoint tie needs a rounding rule.
fn selected_exceptions(inputs: &[u32]) -> Vec<u32> {
    assert!(inputs.len() >= 256);
    (0..256)
        .map(|i| inputs[(i * (inputs.len() - 1) + 127) / 255])
        .collect()
}

fn check_trig_inputs(input: &[u32], sin: &[u32], cos: &[u32]) -> Checked<()> {
    if input.len() != 768
        || input[..256] != selected_exceptions(sin)
        || input[256..512] != selected_exceptions(cos)
    {
        return Err(
            "trig inputs differ from the recorder's deterministic exception selections".into(),
        );
    }
    let controls = &input[512..];
    if controls.iter().copied().collect::<BTreeSet<_>>().len() != 256
        || controls.iter().any(|b| sin.contains(b) || cos.contains(b))
    {
        return Err("trig controls must be distinct non-exception inputs".into());
    }
    // Frozen input inventory from rng(7291, 'twister') and randi in the recorder,
    // not an output/parity expectation. Verified on both processes of both hosts.
    let mut digest = Sha256::new();
    for b in controls {
        digest.update(b.to_le_bytes());
    }
    if format!("{:x}", digest.finalize())
        != "fdde1b91e7338c3e48cc1e983972166bfeca8b0ca2ece42e15aa21c63f59d24a"
    {
        return Err("trig random-control inventory changed".into());
    }
    Ok(())
}

#[test]
fn trig_position_probe() {
    let Some(recordings) = fixture() else { return };
    let trig = PathBuf::from(
        std::env::var_os("SAMSRF_SINGLE_TRIG_DIR").expect("set SAMSRF_SINGLE_TRIG_DIR"),
    );
    let trig_dir = trig.join("ubuntu-22.04").join("compatible");
    let recording = read_json(&trig_dir.join("numerics.json")).unwrap();
    let single = recording["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "single_trig")
        .expect("single_trig")
        .clone();
    let table = |key: &str, expected_rows: usize| -> (Vec<u32>, HashMap<u32, u32>) {
        let words = array(
            &trig_dir,
            &single[key],
            Class::Uint32,
            &[Some(expected_rows), Some(2)],
            Nan::Refused,
        )
        .unwrap();
        let rows = words.shape[0];
        let words = words.words();
        let table: HashMap<u32, u32> = (0..rows).map(|i| (words[i], words[rows + i])).collect();
        assert_eq!(table.len(), rows, "{key}: repeated input");
        (words[..rows].to_vec(), table)
    };
    let (sin_inputs, sin_table) = table("sinExceptions", 36_350);
    let (cos_inputs, cos_table) = table("cosExceptions", 32_406);
    const GROUP: usize = 256;
    const OFFSETS: usize = 33;
    for Recording {
        host,
        cpu,
        dir,
        cases,
    } in &recordings
    {
        let case = find(cases, "trig_position");
        let groups = &case["groups"];
        assert_eq!(
            ["sinExceptions", "cosExceptions", "controls"].map(|g| number(&groups[g]).ok()),
            [Some(GROUP as f64); 3],
            "{host}"
        );
        let n = 3 * GROUP;
        let words = |key: &str, cols: usize| {
            array(
                dir,
                &case[key],
                Class::Uint32,
                &[Some(n), Some(cols)],
                Nan::Refused,
            )
            .unwrap()
            .words()
        };
        let input = words("input", 1);
        check_trig_inputs(&input, &sin_inputs, &cos_inputs).unwrap();
        let (scalar_sin, scalar_cos, array_sin, array_cos) = (
            words("scalarSin", 1),
            words("scalarCos", 1),
            words("arraySin", 1),
            words("arrayCos", 1),
        );
        let (offset_sin, offset_cos) = (words("offsetSin", OFFSETS), words("offsetCos", OFFSETS));
        let mut summary = BTreeMap::<&str, usize>::new();
        for i in 0..n {
            let x = f32::from_bits(input[i]);
            let recorded_sin = sin_table
                .get(&input[i])
                .copied()
                .unwrap_or(sin_single(x).to_bits());
            let recorded_cos = cos_table
                .get(&input[i])
                .copied()
                .unwrap_or(cos_single(x).to_bits());
            let mut tally = |name: &'static str, value: u32, recorded: u32| {
                *summary.entry(name).or_default() += usize::from(value != recorded)
            };
            tally("scalar sin", scalar_sin[i], recorded_sin);
            tally("scalar cos", scalar_cos[i], recorded_cos);
            tally("array sin", array_sin[i], recorded_sin);
            tally("array cos", array_cos[i], recorded_cos);
            for o in 0..OFFSETS {
                tally("offset sin", offset_sin[o * n + i], recorded_sin);
                tally("offset cos", offset_cos[o * n + i], recorded_cos);
            }
        }
        println!("{host} ({cpu}): {n} inputs, {OFFSETS} offsets, differences from the recorded value: {summary:?}");
        // H0 on these inputs and call shapes: the value is the recorded one.
        assert!(
            summary.len() == 6 && summary.values().all(|&count| count == 0),
            "{host}: {summary:?}"
        );
    }
}

// ---- dot-short -------------------------------------------------------------------

/// The tree the fingerprints give for 2-24 elements: adjacent products summed in
/// pairs from the end, the pair sums added in index order after the first element
/// when the count is odd; products and sums rounded separately, no fused step.
fn pairs_then_sequential(x: &[f64], y: &[f64]) -> f64 {
    pair_tree(x, y, Fused::No)
}

/// Whether a pair's sum fuses one of its products (`fma`), for the control below.
#[derive(Clone, Copy)]
enum Fused {
    No,
    First,
    Second,
}

fn pair_tree(x: &[f64], y: &[f64], fused: Fused) -> f64 {
    let n = x.len();
    let (mut total, start) = if n % 2 == 1 {
        (Some(x[0] * y[0]), 1)
    } else {
        (None, 0)
    };
    for i in (start..n).step_by(2) {
        let pair = match fused {
            Fused::No => x[i] * y[i] + x[i + 1] * y[i + 1],
            Fused::First => x[i].mul_add(y[i], x[i + 1] * y[i + 1]),
            Fused::Second => x[i + 1].mul_add(y[i + 1], x[i] * y[i]),
        };
        total = Some(total.map_or(pair, |t| t + pair));
    }
    total.unwrap_or(0.0)
}

const DOT_LENGTHS: std::ops::RangeInclusive<usize> = 2..=24;
const DOT_DRAWS: usize = 50;

/// One length of `dot_short_case`: every pair (nchoosek order) with its count, and
/// the held-out products, column `d` of x and y in row-major `[i * DRAWS + d]`.
#[derive(Debug)]
struct DotLength {
    n: usize,
    pairs: Vec<(usize, usize)>,
    counts: Vec<f64>,
    x: Vec<f64>,
    y: Vec<f64>,
    dots: Vec<f64>,
}

/// The dot case, complete: lengths 2-24 in order, each fingerprint's pairs all of
/// nchoosek(1:n, 2) and one count each, held-out n x 50 matrices of the same n.
fn dot_lengths(case: &Value) -> Checked<Vec<DotLength>> {
    let fingerprints = case["fingerprints"]
        .as_array()
        .ok_or("fingerprints is not a list")?;
    let held = case["heldOut"].as_array().ok_or("heldOut is not a list")?;
    if fingerprints.len() != DOT_LENGTHS.count() || held.len() != DOT_LENGTHS.count() {
        return Err(format!(
            "{} fingerprints and {} held-out sets for lengths {DOT_LENGTHS:?}",
            fingerprints.len(),
            held.len()
        ));
    }
    let mut lengths = Vec::new();
    for ((n, fingerprint), held) in DOT_LENGTHS.zip(fingerprints).zip(held) {
        for part in [fingerprint, held] {
            if integer(number(&part["n"])?, 0, usize::MAX)? != n {
                return Err(format!("expected length {n}, found {}", part["n"]));
            }
        }
        let expected: Vec<(usize, usize)> = (1..=n)
            .flat_map(|a| (a + 1..=n).map(move |b| (a, b)))
            .collect();
        let k = expected.len();
        let flat = matrix(&fingerprint["pairs"], k, 2)?;
        let pairs = flat
            .chunks(2)
            .map(|p| Ok((integer(p[0], 1, n)?, integer(p[1], 1, n)?)))
            .collect::<Checked<Vec<_>>>()?;
        if pairs != expected {
            return Err(format!("n = {n}: the pairs are not nchoosek(1:{n}, 2)"));
        }
        let counts = matrix(&fingerprint["counts"], k, 1)?;
        let (x, y) = (
            matrix(&held["x"], n, DOT_DRAWS)?,
            matrix(&held["y"], n, DOT_DRAWS)?,
        );
        let dots = matrix(&held["dots"], DOT_DRAWS, 1)?;
        lengths.push(DotLength {
            n,
            pairs,
            counts,
            x,
            y,
            dots,
        });
    }
    Ok(lengths)
}

#[test]
fn dot_short_probe() {
    let Some(recordings) = fixture() else { return };
    let big = 2f64.powi(60);
    for Recording {
        host, cpu, cases, ..
    } in &recordings
    {
        // Held-out products a fused pair would get wrong: the tree's sums are unfused.
        let mut fused_differs = [0usize; 2];
        for DotLength {
            n,
            pairs,
            counts,
            x,
            y,
            dots,
        } in dot_lengths(find(cases, "dot_short")).unwrap()
        {
            let (mut mkl, mut sequential, mut tree) = (0, 0, 0);
            for (&(a, b), &count) in pairs.iter().zip(&counts) {
                let ones = vec![1.0; n];
                let mut probe = vec![1.0; n];
                probe[a - 1] = big;
                probe[b - 1] = -big;
                let same = |value: f64| value.to_bits() == count.to_bits();
                mkl += usize::from(!same(m::ddot_mkl(&ones, &probe)));
                sequential += usize::from(!same(
                    ones.iter().zip(&probe).fold(0.0, |s, (a, b)| s + a * b),
                ));
                tree += usize::from(!same(pairs_then_sequential(&ones, &probe)));
            }
            let column = |values: &[f64], d: usize| -> Vec<f64> {
                (0..n).map(|i| values[i * DOT_DRAWS + d]).collect()
            };
            let held_mkl = (0..DOT_DRAWS)
                .filter(|&d| {
                    m::ddot_mkl(&column(&x, d), &column(&y, d)).to_bits() != dots[d].to_bits()
                })
                .count();
            let held_tree = (0..DOT_DRAWS)
                .filter(|&d| {
                    pairs_then_sequential(&column(&x, d), &column(&y, d)).to_bits()
                        != dots[d].to_bits()
                })
                .count();
            println!("{host} ({cpu}) n = {n}: {} pairs; H-mkl differs on {mkl}, H-seq on {sequential}, the pair tree on {tree}; held-out: ddot differs on {held_mkl}, the pair tree on {held_tree} of {DOT_DRAWS}", pairs.len());
            // The tree read from the counts reproduces every count and every held-out
            // product; neither prediction holds from 8 elements on.
            assert_eq!((tree, held_tree), (0, 0), "{host} n = {n}");
            if n >= 8 {
                assert!(mkl > 0 && sequential > 0, "{host} n = {n}");
            }
            for (slot, fused) in [Fused::First, Fused::Second].into_iter().enumerate() {
                fused_differs[slot] += (0..DOT_DRAWS)
                    .filter(|&d| {
                        pair_tree(&column(&x, d), &column(&y, d), fused).to_bits()
                            != dots[d].to_bits()
                    })
                    .count();
            }
        }
        println!("{host}: a pair fusing its first or second product differs on {fused_differs:?} held-out products");
        assert!(fused_differs.iter().all(|&count| count > 0), "{host}");
    }
}

// ---- the boundary refuses malformed recordings -------------------------------------

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("focused-probes")
        .join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A minimal recording whose cases carry exactly the identity fields.
fn skeleton() -> Vec<Value> {
    let mut cases: Vec<Value> = hooke_jeeves_specs()
        .into_iter()
        .map(|s| json!({"id": s.id, "kind": "hooke-jeeves", "host": s.pin_host, "pipeline": s.pipeline, "algorithm": s.algorithm, "steps": s.steps.map_or(Value::Null, |s| json!(s))}))
        .collect();
    cases.extend(conv_specs().into_iter().map(|s| json!({"id": s.id, "kind": "conv-512", "source": s.source, "n": s.n, "taps": CONV_TAPS, "centre": s.centre})));
    cases.push(json!({"id": "trig_position", "kind": "trig-position"}));
    cases.push(json!({"id": "dot_short", "kind": "dot-short"}));
    cases
}

#[test]
fn refuses_empty_or_missing_hosts() {
    let dir = scratch("hosts");
    let write =
        |manifest: Value| std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    write(json!({"hosts": {}}));
    assert!(recordings(&dir).unwrap_err().contains("manifest hosts"));
    write(json!({"hosts": {"ubuntu-22.04": {"cpu": "x"}}}));
    assert!(recordings(&dir).is_err());
    write(json!({"hosts": {"ubuntu-22.04": {"cpu": "x"}, "ubuntu-24.04": {"cpu": "y"}}}));
    // The hosts are right but their recordings are missing.
    assert!(recordings(&dir).unwrap_err().contains("focused.json"));
    for host in HOSTS {
        std::fs::create_dir_all(dir.join(host).join("compatible")).unwrap();
        std::fs::write(
            dir.join(host).join("compatible").join("focused.json"),
            json!({"cases": []}).to_string(),
        )
        .unwrap();
    }
    assert!(recordings(&dir).unwrap_err().contains("missing cases"));
    for host in HOSTS {
        std::fs::write(
            dir.join(host).join("compatible").join("focused.json"),
            json!({"cases": skeleton()}).to_string(),
        )
        .unwrap();
    }
    assert_eq!(recordings(&dir).unwrap().len(), 2);
}

#[test]
fn refuses_incomplete_duplicated_or_misidentified_cases() {
    let cases = skeleton();
    assert_eq!(cases.len(), 18 + 24 + 2);
    check_inventory(&cases).unwrap();
    assert!(check_inventory(&[]).is_err());
    assert!(check_inventory(&cases[1..])
        .unwrap_err()
        .contains("missing cases"));
    let mut doubled = cases.clone();
    doubled.push(cases[0].clone());
    assert!(check_inventory(&doubled).unwrap_err().contains("twice"));
    let mut extra = cases.clone();
    extra.push(json!({"id": "conv512_conv_complex_n1000_nnz244_c768", "kind": "conv-512"}));
    assert!(check_inventory(&extra).unwrap_err().contains("unexpected"));
    for (index, key, value) in [
        (1, "steps", json!([0.05, 0.05, 0.02])),
        (0, "steps", json!([0.1, 0.1, 0.1])),
        (2, "pipeline", json!(PIPELINES[1])),
        (3, "host", json!("ubuntu-24.04")),
        (20, "taps", json!(32)),
        (40, "centre", json!(1536)),
        (43, "kind", json!("trig-position")),
    ] {
        let mut changed = cases.clone();
        changed[index][key] = value;
        assert!(check_inventory(&changed).is_err(), "{index} {key}");
    }
}

#[test]
fn refuses_malformed_arrays() {
    let dir = scratch("arrays");
    let write = |name: &str, values: &[f64], extra: &[u8]| {
        let mut bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        bytes.extend_from_slice(extra);
        std::fs::write(dir.join(name), bytes).unwrap();
    };
    let descriptor = |file: &str, shape: Value, class: &str| json!({"file": file, "shape": shape, "class": class, "imaginary": ""});
    write("ok.f64", &[1.0, 2.0, 3.0], &[]);
    let ok = descriptor("ok.f64", json!([3, 1]), "double");
    assert_eq!(
        array(&dir, &ok, Class::Double, &[Some(3), Some(1)], Nan::Refused)
            .unwrap()
            .values,
        [1.0, 2.0, 3.0]
    );
    // A missing full element, and a trailing partial one.
    assert!(array(
        &dir,
        &descriptor("ok.f64", json!([4, 1]), "double"),
        Class::Double,
        &[None, Some(1)],
        Nan::Refused
    )
    .unwrap_err()
    .contains("bytes"));
    write("trailing.f64", &[1.0, 2.0, 3.0], &[0]);
    assert!(array(
        &dir,
        &descriptor("trailing.f64", json!([3, 1]), "double"),
        Class::Double,
        &[None, Some(1)],
        Nan::Refused
    )
    .unwrap_err()
    .contains("bytes"));
    // The class the field must have, and values the class can hold.
    assert!(
        array(&dir, &ok, Class::Single, &[None, Some(1)], Nan::Refused)
            .unwrap_err()
            .contains("class double")
    );
    write("tenth.f64", &[0.1], &[]);
    assert!(array(
        &dir,
        &descriptor("tenth.f64", json!([1, 1]), "single"),
        Class::Single,
        &[None, None],
        Nan::Refused
    )
    .is_err());
    write("word.f64", &[4_294_967_296.0], &[]);
    assert!(array(
        &dir,
        &descriptor("word.f64", json!([1, 1]), "uint32"),
        Class::Uint32,
        &[None, None],
        Nan::Refused
    )
    .is_err());
    write("half.f64", &[0.5], &[]);
    assert!(array(
        &dir,
        &descriptor("half.f64", json!([1, 1]), "uint32"),
        Class::Uint32,
        &[None, None],
        Nan::Refused
    )
    .is_err());
    // Complex, a nonintegral or negative dimension, the wrong shape, extra keys.
    let mut complex = ok.clone();
    complex["imaginary"] = json!("ok_imag.f64");
    assert!(array(
        &dir,
        &complex,
        Class::Double,
        &[None, Some(1)],
        Nan::Refused
    )
    .unwrap_err()
    .contains("complex"));
    assert!(array(
        &dir,
        &descriptor("ok.f64", json!([1.5, 2]), "double"),
        Class::Double,
        &[None, None],
        Nan::Refused
    )
    .is_err());
    assert!(array(
        &dir,
        &descriptor("ok.f64", json!([-3, -1]), "double"),
        Class::Double,
        &[None, None],
        Nan::Refused
    )
    .is_err());
    assert!(
        array(&dir, &ok, Class::Double, &[Some(1), Some(3)], Nan::Refused)
            .unwrap_err()
            .contains("shape")
    );
    assert!(array(&dir, &ok, Class::Double, &[Some(3)], Nan::Refused)
        .unwrap_err()
        .contains("shape"));
    let mut extra = ok.clone();
    extra["unit"] = json!("deg");
    assert!(array(&dir, &extra, Class::Double, &[None, Some(1)], Nan::Refused).is_err());
    assert!(array(
        &dir,
        &descriptor("../ok.f64", json!([3, 1]), "double"),
        Class::Double,
        &[None, Some(1)],
        Nan::Refused
    )
    .is_err());
    // NaN only where the field allows it, infinity nowhere.
    write("nan.f64", &[f64::NAN], &[]);
    let nan = descriptor("nan.f64", json!([1, 1]), "single");
    assert!(array(&dir, &nan, Class::Single, &[None, None], Nan::Refused).is_err());
    assert!(array(&dir, &nan, Class::Single, &[None, None], Nan::Allowed).is_ok());
    write("inf.f64", &[f64::INFINITY], &[]);
    assert!(array(
        &dir,
        &descriptor("inf.f64", json!([1, 1]), "double"),
        Class::Double,
        &[None, None],
        Nan::Allowed
    )
    .is_err());
}

#[test]
fn refuses_nonintegral_indices_and_short_or_nonnumeric_matrices() {
    assert_eq!(integer(3.0, 1, 3), Ok(3));
    assert!(
        integer(1.5, 1, 3).is_err()
            && integer(0.0, 1, 3).is_err()
            && integer(4.0, 1, 3).is_err()
            && integer(f64::NAN, 0, 3).is_err()
    );
    assert_eq!(
        matrix(&json!([[1, 2], [3, 4]]), 2, 2).unwrap(),
        [1.0, 2.0, 3.0, 4.0]
    );
    assert_eq!(matrix(&json!(5), 1, 1).unwrap(), [5.0]);
    assert!(matrix(&json!([1, "2"]), 1, 2).is_err());
    assert!(matrix(&json!([1, null]), 2, 1).is_err());
    assert!(matrix(&json!([1, 2, 3]), 1, 2).is_err());
    assert!(matrix(&json!([[1, 2], [3]]), 2, 2).is_err());
    assert!(matrix(&json!([[1, 2]]), 2, 2).is_err());
    assert!(matrix(&json!([1]), 1, 1).is_err());
}

/// A complete synthetic dot case, then each way it can be incomplete.
#[test]
fn refuses_incomplete_dot_cases() {
    let length = |n: usize| {
        let pairs: Vec<[usize; 2]> = (1..=n)
            .flat_map(|a| (a + 1..=n).map(move |b| [a, b]))
            .collect();
        let k = pairs.len();
        let pairs = if k == 1 {
            json!(pairs[0])
        } else {
            json!(pairs)
        };
        let counts = if k == 1 { json!(0) } else { json!(vec![0; k]) };
        let fingerprint = json!({"n": n, "pairs": pairs, "counts": counts});
        let held = json!({"n": n, "x": vec![vec![0.0; DOT_DRAWS]; n], "y": vec![vec![0.0; DOT_DRAWS]; n], "dots": vec![0.0; DOT_DRAWS]});
        (fingerprint, held)
    };
    let (fingerprints, held): (Vec<Value>, Vec<Value>) = DOT_LENGTHS.map(length).unzip();
    let case = json!({"fingerprints": fingerprints, "heldOut": held});
    assert_eq!(dot_lengths(&case).unwrap().len(), 23);
    let mut short = case.clone();
    short["fingerprints"].as_array_mut().unwrap().pop();
    assert!(dot_lengths(&short).is_err());
    let mut renumbered = case.clone();
    renumbered["heldOut"][5]["n"] = json!(8);
    assert!(dot_lengths(&renumbered).unwrap_err().contains("length"));
    let mut missing_pair = case.clone();
    missing_pair["fingerprints"][3]["pairs"]
        .as_array_mut()
        .unwrap()
        .pop();
    assert!(dot_lengths(&missing_pair).is_err());
    let mut reordered = case.clone();
    reordered["fingerprints"][3]["pairs"][0] = json!([2, 1]);
    assert!(dot_lengths(&reordered).is_err());
    let mut fewer_counts = case.clone();
    fewer_counts["fingerprints"][4]["counts"]
        .as_array_mut()
        .unwrap()
        .pop();
    assert!(dot_lengths(&fewer_counts).is_err());
    let mut fewer_draws = case.clone();
    fewer_draws["heldOut"][6]["x"][0]
        .as_array_mut()
        .unwrap()
        .pop();
    assert!(dot_lengths(&fewer_draws).is_err());
    let mut fewer_dots = case;
    fewer_dots["heldOut"][7]["dots"]
        .as_array_mut()
        .unwrap()
        .pop();
    assert!(dot_lengths(&fewer_dots).is_err());
}

/// A one-ULP double difference that rounding to single would hide still fails, and
/// the keep rule's outcome must agree.
#[test]
fn refuses_parameter_differences_hidden_by_single_rounding() {
    let matlab = [1.0, -2.0, 0.5, 3.0, 0.25];
    let port: Vec<f64> = [0.75].into_iter().chain(matlab).collect();
    compare_fit(&matlab, 0.75, true, &port).unwrap();
    let mut nudged = port.clone();
    nudged[2] = (-2.0f64).next_up();
    assert_eq!(nudged[2] as f32, -2.0f32);
    assert!(compare_fit(&matlab, 0.75, true, &nudged)
        .unwrap_err()
        .contains("row 2"));
    let rejected = vec![f64::NAN; port.len()];
    assert!(compare_fit(&matlab, 0.75, true, &rejected).is_err());
    assert!(compare_fit(&matlab, 0.75, false, &port)
        .unwrap_err()
        .contains("keeps"));
    compare_fit(&matlab, 0.75, false, &rejected).unwrap();
    assert!(compare_fit(&matlab, 0.75, true, &port[1..]).is_err());
}
