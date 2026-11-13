//! The focused MATLAB probes (`focused-probes-reference.json`, recorded by
//! `record_focused_probes.m`) against the predictions fixed beforehand in
//! `packages/samsrf/validation/matlab/focused-probes-predictions.md`. Each
//! prediction is evaluated by the port itself on the same inputs.
//!
//! Data: `SAMSRF_FOCUSED_PROBES_DIR` (the recording: `manifest.json` and one
//! folder per host with `compatible` and `repeat` processes), with
//! `SAMSRF_REVCOR_REFERENCE_DIR` (the pinned single RC profiles the Hooke-Jeeves
//! section fitted) and `SAMSRF_SINGLE_TRIG_DIR` (MATLAB's recorded sin and cos).
//! Without the first, these return.
use num_complex::Complex64;
use samsrf_core::apertures::Apertures;
use samsrf_core::matlab_math as m;
use samsrf_core::model::{self, AnalysisKind, Model};
use samsrf_core::precision::{cos_single, sin_single, Precision};
use samsrf_core::revcor_prf;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || a.is_nan() && b.is_nan()
}

fn doubles(dir: &Path, descriptor: &Value) -> Vec<f64> {
    let values: Vec<f64> = std::fs::read(dir.join(descriptor["file"].as_str().unwrap())).unwrap().as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect();
    let expected: usize = descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_f64().unwrap() as usize).product();
    assert_eq!(values.len(), expected, "{}", descriptor["file"]);
    values
}

fn shape(descriptor: &Value) -> Vec<usize> {
    descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_f64().unwrap() as usize).collect()
}

/// A JSON number or a one-element array of one (MATLAB's jsonencode of a scalar).
fn numbers(value: &Value) -> Vec<f64> {
    match value {
        Value::Array(items) => items.iter().flat_map(numbers).collect(),
        Value::Number(n) => vec![n.as_f64().unwrap()],
        _ => vec![],
    }
}

fn as_list(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        Value::Null => vec![],
        other => vec![other.clone()],
    }
}

/// Each recorded host: its CPU and its first process's cases.
fn recordings(root: &Path) -> Vec<(String, String, PathBuf, Vec<Value>)> {
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    manifest["hosts"].as_object().unwrap().iter().map(|(host, info)| {
        let dir = root.join(host).join("compatible");
        let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("focused.json")).unwrap()).unwrap();
        (host.clone(), info["cpu"].as_str().unwrap().to_string(), dir, as_list(&recording["cases"]))
    }).collect()
}

fn root() -> Option<PathBuf> {
    std::env::var_os("SAMSRF_FOCUSED_PROBES_DIR").map(PathBuf::from)
}

// ---- hooke-jeeves --------------------------------------------------------------

/// The pinned pipeline case a Hooke-Jeeves probe fitted, from the revcor recording.
fn pinned_case(revcor: &Path, host: &str, id: &str) -> (PathBuf, Value) {
    let root = revcor.join(host);
    let matrix: Value = serde_json::from_slice(&std::fs::read(root.join("revcor-matrix.json")).unwrap()).unwrap();
    let case = matrix["cases"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap().clone();
    (root, case)
}

/// The port's prepared RC fit for the case, single precision, with the probe's
/// algorithm: built test-only, since the parser refuses single 2D fits.
fn port_fit(root: &Path, case: &Value, steps: Option<&[f64]>) -> revcor_prf::Prepared {
    let mut json = case["mapReplayModel"].clone();
    json["Data_Precision"] = Value::from("double");
    if let Some(steps) = steps {
        json["Hooke_Jeeves_Steps"] = Value::from(steps.to_vec());
    }
    let Model::RevCorPrf(mut rc) = model::parse_model_json(AnalysisKind::RevCorPrf, &json.to_string()).unwrap() else { unreachable!() };
    rc.data_precision = Precision::Single;
    let [rows, cols, frames] = shape(&case["apertures"])[..] else { unreachable!() };
    let apertures = Apertures::from_dense(rows, cols, frames, &doubles(root, &case["apertures"]), None).unwrap();
    let resolved = samsrf_core::hrf::resolve(&rc.hrf, rc.tr).unwrap();
    let volumes = shape(&case["savedCourses"])[0];
    revcor_prf::Prepared::new(&rc, &apertures, &resolved, volumes).unwrap()
}

/// Each Hooke-Jeeves probe starts from the loop's double raw rows. The control
/// reproduces the pinned maps, and the port's Hooke-Jeeves path reproduces every
/// fitted parameter and R² (the amended predictions; the first run's section is void).
#[test]
fn hooke_jeeves_probes() {
    let Some(root) = root() else { return };
    let revcor = PathBuf::from(std::env::var_os("SAMSRF_REVCOR_REFERENCE_DIR").expect("set SAMSRF_REVCOR_REFERENCE_DIR"));
    for (recording_host, cpu, dir, cases) in recordings(&root) {
        let (mut checked, mut traces) = (0, 0);
        for case in cases.iter().filter(|c| c["kind"] == "hooke-jeeves") {
            let (profile_host, pipeline) = (case["host"].as_str().unwrap(), case["pipeline"].as_str().unwrap());
            let (pinned_root, pinned) = pinned_case(&revcor, profile_host, pipeline);
            let vertices: Vec<usize> = numbers(&case["vertices"]).iter().map(|v| *v as usize - 1).collect();
            let parameters = doubles(&dir, &case["parameters"]);
            let r2 = doubles(&dir, &case["r2"]);
            let loop_raw = doubles(&dir, &case["loopRaw"]);
            let rows = parameters.len() / vertices.len().max(1);
            let classes: Vec<String> = as_list(&case["classes"]).iter().map(|c| c.as_str().unwrap().to_string()).collect();
            let steps = numbers(&case["steps"]);
            let control = case["algorithm"] == "nelder-mead-control";
            let profiles = doubles(&pinned_root, &pinned["profiles"]);
            let pixels = shape(&pinned["profiles"])[0];
            let raw = doubles(&pinned_root, &pinned["rawMaps"]);
            let saved = doubles(&pinned_root, &pinned["savedMaps"]);
            let saved_rows = shape(&pinned["savedMaps"])[0];
            let scaling = pinned["mapReplayModel"]["Scaling_Factor"].as_f64().unwrap();
            let prepared = port_fit(&pinned_root, &pinned, if control { None } else { Some(&steps) });
            let (mut against_saved, mut port_differs, mut fitted) = (0, 0, 0);
            for (g, &v) in vertices.iter().enumerate() {
                let matlab: Vec<f64> = (0..rows).map(|r| parameters[g * rows + r]).collect();
                let keep = matlab[..rows - 2].iter().all(|p| p.abs() <= scaling * 1.5);
                let kept: Vec<f64> = if keep { std::iter::once(r2[g]).chain(matlab.iter().copied()).collect() } else { vec![f64::NAN; rows + 1] };
                if control {
                    against_saved += usize::from((0..rows + 1).any(|r| !same(f64::from(kept[r] as f32), saved[v * saved_rows + r])));
                }
                // The loop's double raw row, which rounds to the pinned single one.
                let raw_row: [f64; 5] = std::array::from_fn(|r| loop_raw[g * 5 + r]);
                assert!((0..5).all(|r| same(f64::from(raw_row[r] as f32), raw[v * 5 + r])), "{} vertex {v}", case["id"]);
                let port = prepared.fit_model(&raw_row, &profiles[v * pixels..(v + 1) * pixels]).unwrap();
                fitted += usize::from(keep);
                port_differs += usize::from((0..rows + 1).any(|r| !same(f64::from(port[r] as f32), f64::from(kept[r] as f32))));
            }
            println!(
                "{recording_host} ({cpu}) {} {}: {} vertices, {fitted} kept; classes {:?}; {}port differs on {port_differs}",
                profile_host,
                case["id"].as_str().unwrap(),
                vertices.len(),
                classes.iter().collect::<std::collections::BTreeSet<_>>(),
                if control { format!("control differs from the pinned maps on {against_saved}; ") } else { String::new() }
            );
            // Control and H2' (amendment): MATLAB's Nelder-Mead gives the pinned maps,
            // and the port's Hooke-Jeeves path gives MATLAB's parameters and R².
            assert_eq!(against_saved, 0, "{recording_host} {}", case["id"]);
            assert_eq!(port_differs, 0, "{recording_host} {}", case["id"]);
            // H1': double parameters and seeds, single R² (classes of fP, fR, seeds).
            assert!(classes.iter().all(|c| c == "double,single,double"), "{recording_host} {}", case["id"]);
            checked += 1;
            for trace in as_list(&case["traces"]) {
                let evaluations = as_list(&trace["evaluations"]);
                println!("    trace: {} evaluations, parameters {}, errors {}, equals samsrf_fit2dprf {}", evaluations.len(), trace["parameterClass"], trace["errorClass"], trace["equalsFit2dprf"]);
                // The logged search is samsrf_fit2dprf's; each error is a single value
                // (the last column is isa(R, 'single')) that the search keeps in a double.
                assert_eq!((trace["parameterClass"].as_str(), trace["errorClass"].as_str()), (Some("double"), Some("double")));
                assert_eq!(trace["equalsFit2dprf"], true);
                assert!(!evaluations.is_empty() && evaluations.iter().all(|row| numbers(row).last() == Some(&1.0)));
                traces += 1;
            }
        }
        // Three pipelines from each pin host, a control and two step sets each.
        assert_eq!((checked, traces), (18, 24), "{recording_host}");
    }
}

// ---- conv-512 ------------------------------------------------------------------

/// Each pair probe's counts against the port's `convolve_complex` on the same course
/// (H-seq), per region; the control region (centre 256) must agree everywhere.
#[test]
fn conv_512_probes() {
    let Some(root) = root() else { return };
    for (host, cpu, dir, cases) in recordings(&root) {
        let (mut regions, mut control_differs) = (0, 0);
        for case in cases.iter().filter(|c| c["kind"] == "conv-512") {
            regions += 1;
            let n = case["n"].as_f64().unwrap() as usize;
            let taps = case["taps"].as_f64().unwrap() as usize;
            let centre = case["centre"].as_f64().unwrap() as usize;
            let outputs: Vec<usize> = numbers(&case["outputs"]).iter().map(|k| *k as usize).collect();
            let nonzero: Vec<usize> = doubles(&dir, &case["nonzero"]).iter().map(|i| *i as usize).collect();
            let pairs = doubles(&dir, &case["pairs"]);
            let count = pairs.len() / 2;
            let (re, im) = (doubles(&dir, &case["real"]), doubles(&dir, &case["imaginary"]));
            let big = 2f64.powi(60);
            let mut differing = 0;
            for p in 0..count {
                let (a, b) = (pairs[p] as usize, pairs[count + p] as usize);
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
                    let port = m::convolve_complex(&y, &vec![1.0; taps], 1);
                    for (o, &k) in outputs.iter().enumerate() {
                        let matlab = if part == 0 { re[o * count + p] } else { im[o * count + p] };
                        let ours = if part == 0 { port[k].re } else { port[k].im };
                        if !same(ours, matlab) {
                            differing += 1;
                        }
                    }
                }
            }
            if centre == 256 {
                control_differs += differing;
            }
            println!("{host} ({cpu}) {}: {count} pairs, {differing} counts differ from H-seq", case["id"].as_str().unwrap());
            // H-seq holds in every region: H-split and H-tile are rejected.
            assert_eq!(differing, 0, "{host} {}", case["id"]);
        }
        println!("{host}: {regions} regions; the control regions differ on {control_differs}");
        assert_eq!(regions, 24, "{host}");
    }
}

// ---- trig-position ---------------------------------------------------------------

#[test]
fn trig_position_probe() {
    let Some(root) = root() else { return };
    let trig = PathBuf::from(std::env::var_os("SAMSRF_SINGLE_TRIG_DIR").expect("set SAMSRF_SINGLE_TRIG_DIR"));
    let trig_dir = trig.join("ubuntu-22.04").join("compatible");
    let recording: Value = serde_json::from_slice(&std::fs::read(trig_dir.join("numerics.json")).unwrap()).unwrap();
    let single = recording["cases"].as_array().unwrap().iter().find(|c| c["id"] == "single_trig").unwrap().clone();
    let table = |key: &str| -> HashMap<u32, u32> {
        let values = doubles(&trig_dir, &single[key]);
        let rows = values.len() / 2;
        (0..rows).map(|i| (values[i] as u32, values[rows + i] as u32)).collect()
    };
    let (sin_table, cos_table) = (table("sinExceptions"), table("cosExceptions"));
    for (host, cpu, dir, cases) in recordings(&root) {
        let case = cases.iter().find(|c| c["kind"] == "trig-position").unwrap();
        let input: Vec<u32> = doubles(&dir, &case["input"]).iter().map(|b| *b as u32).collect();
        let n = input.len();
        let words = |key: &str| -> Vec<u32> { doubles(&dir, &case[key]).iter().map(|b| *b as u32).collect() };
        let (scalar_sin, scalar_cos, offset_sin, offset_cos, array_sin, array_cos) =
            (words("scalarSin"), words("scalarCos"), words("offsetSin"), words("offsetCos"), words("arraySin"), words("arrayCos"));
        let offsets = offset_sin.len() / n;
        let mut summary = std::collections::BTreeMap::<String, usize>::new();
        for i in 0..n {
            let x = f32::from_bits(input[i]);
            let recorded_sin = sin_table.get(&input[i]).copied().unwrap_or(sin_single(x).to_bits());
            let recorded_cos = cos_table.get(&input[i]).copied().unwrap_or(cos_single(x).to_bits());
            let mut tally = |name: &str, value: u32, recorded: u32| {
                *summary.entry(format!("{name} differs from the recorded value")).or_default() += usize::from(value != recorded);
            };
            tally("scalar sin", scalar_sin[i], recorded_sin);
            tally("scalar cos", scalar_cos[i], recorded_cos);
            tally("array sin", array_sin[i], recorded_sin);
            tally("array cos", array_cos[i], recorded_cos);
            for o in 0..offsets {
                tally("offset sin", offset_sin[o * n + i], recorded_sin);
                tally("offset cos", offset_cos[o * n + i], recorded_cos);
            }
        }
        println!("{host} ({cpu}): {n} inputs, {offsets} offsets: {summary:?}");
        // H0: the value does not depend on the call shape or the element's position.
        assert_eq!((n, offsets), (768, 33), "{host}");
        assert!(summary.values().all(|&count| count == 0), "{host}: {summary:?}");
    }
}

// ---- dot-short -------------------------------------------------------------------

/// The tree the fingerprints give for 2-24 elements: adjacent products summed in
/// pairs from the end, the pair sums added in index order after the first element
/// when the count is odd; products and sums rounded separately, no fused step.
fn pairs_then_sequential(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len();
    let (mut total, start) = if n % 2 == 1 { (Some(x[0] * y[0]), 1) } else { (None, 0) };
    for i in (start..n).step_by(2) {
        let pair = x[i] * y[i] + x[i + 1] * y[i + 1];
        total = Some(total.map_or(pair, |t| t + pair));
    }
    total.unwrap_or(0.0)
}

#[test]
fn dot_short_probe() {
    let Some(root) = root() else { return };
    let big = 2f64.powi(60);
    for (host, cpu, _, cases) in recordings(&root) {
        let case = cases.iter().find(|c| c["kind"] == "dot-short").unwrap();
        for (fingerprint, held) in as_list(&case["fingerprints"]).iter().zip(as_list(&case["heldOut"])) {
            let n = fingerprint["n"].as_f64().unwrap() as usize;
            // jsonencode writes a k x 2 matrix as k rows, and a 1 x 2 one as a flat pair.
            let pairs: Vec<Vec<f64>> = numbers(&fingerprint["pairs"]).chunks(2).map(<[f64]>::to_vec).collect();
            let counts = numbers(&fingerprint["counts"]);
            let (mut mkl, mut sequential, mut tree) = (0, 0, 0);
            for (pair, &count) in pairs.iter().zip(&counts) {
                let x = vec![1.0; n];
                let mut y = vec![1.0; n];
                y[pair[0] as usize - 1] = big;
                y[pair[1] as usize - 1] = -big;
                mkl += usize::from(!same(m::ddot(&x, &y), count));
                tree += usize::from(!same(pairs_then_sequential(&x, &y), count));
                sequential += usize::from(!same(x.iter().zip(&y).fold(0.0, |s, (a, b)| a.mul_add(*b, s)), count) && !same(x.iter().zip(&y).fold(0.0, |s, (a, b)| s + a * b), count));
            }
            let dots = numbers(&held["dots"]);
            let draws = dots.len();
            // jsonencode writes an n x draws matrix as n rows of draws: row-major.
            let (x, y) = (numbers(&held["x"]), numbers(&held["y"]));
            assert_eq!((x.len(), y.len()), (n * draws, n * draws));
            let column = |values: &[f64], d: usize| -> Vec<f64> { (0..n).map(|i| values[i * draws + d]).collect() };
            let held_mkl = (0..draws).filter(|&d| !same(m::ddot(&column(&x, d), &column(&y, d)), dots[d])).count();
            let held_tree = (0..draws).filter(|&d| !same(pairs_then_sequential(&column(&x, d), &column(&y, d)), dots[d])).count();
            println!("{host} ({cpu}) n = {n}: {} pairs; H-mkl differs on {mkl}, H-seq on {sequential}, the pair tree on {tree}; held-out: ddot differs on {held_mkl}, the pair tree on {held_tree} of {draws}", pairs.len());
            assert_eq!((pairs.len(), draws), (n * (n - 1) / 2, 50), "{host} n = {n}");
            // Neither prediction holds from 8 elements on; the tree read from the
            // counts reproduces every count and every held-out product.
            assert_eq!((tree, held_tree), (0, 0), "{host} n = {n}");
            if n >= 8 {
                assert!(mkl > 0 && sequential > 0, "{host} n = {n}");
            }
        }
    }
}
