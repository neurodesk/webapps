//! The remaining sparse `conv` questions, pre-registered in
//! `packages/samsrf/validation/matlab/conv-gaps-predictions.md` and recorded by
//! `record_conv_gaps.m` (`conv-gaps-reference.json`) on two AMD hosts:
//! A, the conv-blocks held-out courses replayed; B, the complex threshold and the
//! block length at exactly 8 blocks; C, held-out courses for kernels of 2-8 taps.
//!
//! Data: `SAMSRF_CONV_GAPS_DIR`, and `SAMSRF_CONV_BLOCKS_DIR` for the replay
//! comparison. Without them the fixture tests return; the `refuses_*` tests always
//! run. Inputs of B and C are regenerated here from the recorder's Park-Miller stream
//! and must equal the recorded ones.
use num_complex::Complex64;
use samsrf_core::matlab_math as m;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[path = "support/checked.rs"]
mod checked;
use checked::{array, integer, read_json, text, Checked, Class, Nan};

const DRAWS: usize = 12;
/// The pinned run's hosts: both must be AMD with MKL's `auto` branch, the receipt the
/// replay's AMD confirmation rests on.
const HOSTS: [(&str, &str); 2] = [
    ("ubuntu-22.04", "AMD EPYC 7763 64-Core Processor"),
    ("ubuntu-24.04", "AMD EPYC 9V74 80-Core Processor"),
];
const FILES: [&str; 3] = [
    "conv-gaps-replay.json",
    "conv-gaps-boundary.json",
    "conv-gaps-short.json",
];

/// A generated course: section, n, taps, complex, density, seed.
type Row = (&'static str, usize, usize, bool, f64, u64);

fn boundary_rows() -> Vec<Row> {
    let mut rows: Vec<Row> = (990..=994)
        .map(|n| ("threshold-decide", n, 33, true, 0.20, 1000 + n as u64))
        .collect();
    rows.extend((1006..=1010).map(|n| ("threshold-confirm", n, 17, true, 0.20, 2000 + n as u64)));
    rows.extend([2016, 2017].map(|n| ("threshold-real", n, 33, false, 0.20, 3000 + n as u64)));
    rows.extend((4063..=4065).map(|n| ("blocks-decide", n, 33, true, 0.20, 4000 + n as u64)));
    rows.extend((4031..=4033).map(|n| ("blocks-confirm", n, 65, true, 0.20, 5000 + n as u64)));
    rows.extend((8159..=8161).map(|n| ("blocks-confirm", n, 33, false, 0.20, 6000 + n as u64)));
    rows.extend([
        ("control", 2048, 33, true, 0.20, 7001),
        ("control", 4096, 17, false, 0.20, 7002),
    ]);
    rows
}

fn short_rows() -> Vec<Row> {
    let mut rows: Vec<Row> = [2, 4, 6, 7]
        .map(|t| ("short-heldout", 1300, t, true, 0.20, 8000 + t as u64))
        .to_vec();
    rows.extend([2, 4, 6, 7].map(|t| ("short-heldout", 2500, t, false, 0.20, 8100 + t as u64)));
    rows.extend([
        ("short-heldout", 300, 6, true, 0.20, 8201),
        ("short-heldout", 250, 7, false, 0.20, 8202),
        ("short-heldout", 400, 5, false, 0.20, 8203),
        ("short-heldout", 40, 4, false, 0.15, 8204),
        ("short-dense", 1100, 4, true, 0.60, 8301),
        ("short-dense", 900, 7, false, 0.60, 8302),
    ]);
    rows
}

/// The conv-blocks held-out table (n, taps, complex), replayed under its own ids.
const REPLAY: [(usize, usize, bool); 12] = [
    (3000, 100, true),
    (5000, 140, true),
    (4500, 200, true),
    (6000, 300, true),
    (2600, 129, true),
    (6000, 25, true),
    (900, 13, true),
    (3000, 21, false),
    (4100, 49, false),
    (5000, 97, false),
    (6000, 140, false),
    (1500, 13, false),
];

fn kind(complex: bool) -> &'static str {
    if complex {
        "complex"
    } else {
        "real"
    }
}

fn replay_id((n, taps, complex): (usize, usize, bool)) -> String {
    format!("h2_{}_n{n}_t{taps}", kind(complex))
}

fn generated_id(prefix: &str, (section, n, taps, complex, ..): Row) -> String {
    format!("{prefix}_{section}_{}_n{n}_t{taps}", kind(complex))
}

/// The recorder's Park-Miller stream and course: positions where the next value is
/// below the density, kernel taps (1 + u/2)/t, then per draw and position the real
/// value 2u - 1 and, for complex courses, the imaginary one.
struct Generated {
    nonzero: Vec<usize>,
    kernel: Vec<f64>,
    values: Vec<Vec<Complex64>>,
}

fn generate(n: usize, taps: usize, complex: bool, density: f64, seed: u64) -> Generated {
    let mut state = seed;
    let mut next = || {
        state = state * 48271 % 2_147_483_647;
        state as f64 / 2_147_483_647.0
    };
    let nonzero: Vec<usize> = (0..n).filter(|_| next() < density).collect();
    let kernel = (1..=taps)
        .map(|t| (1.0 + 0.5 * next()) / t as f64)
        .collect();
    let values = (0..DRAWS)
        .map(|_| {
            nonzero
                .iter()
                .map(|_| {
                    let re = 2.0 * next() - 1.0;
                    let im = if complex { 2.0 * next() - 1.0 } else { 0.0 };
                    Complex64::new(re, im)
                })
                .collect()
        })
        .collect();
    Generated {
        nonzero,
        kernel,
        values,
    }
}

/// Every case of a file, once, with its identity fields.
fn check_cases(cases: &[Value], expected: &BTreeMap<String, Value>) -> Checked<()> {
    let mut found = BTreeMap::new();
    for case in cases {
        let id = text(case, "id")?;
        if found.insert(id.to_string(), case).is_some() {
            return Err(format!("case {id} appears twice"));
        }
    }
    let (have, want): (BTreeSet<&String>, BTreeSet<&String>) =
        (found.keys().collect(), expected.keys().collect());
    if have != want {
        return Err(format!(
            "missing cases {:?}, unexpected {:?}",
            want.difference(&have).collect::<Vec<_>>(),
            have.difference(&want).collect::<Vec<_>>()
        ));
    }
    for (id, fields) in expected {
        for (key, value) in fields.as_object().unwrap() {
            let actual = &found[id][key];
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

fn expected_cases(file: &str) -> BTreeMap<String, Value> {
    match file {
        "conv-gaps-replay.json" => REPLAY
            .iter()
            .map(|&row| {
                (
                    replay_id(row),
                    json!({"kind": kind(row.2), "n": row.0, "taps": row.1, "draws": DRAWS}),
                )
            })
            .collect(),
        "conv-gaps-boundary.json" | "conv-gaps-short.json" => {
            let (prefix, rows) = if file == "conv-gaps-boundary.json" {
                ("b", boundary_rows())
            } else {
                ("s", short_rows())
            };
            rows.into_iter()
                .map(|row| {
                    let (section, n, taps, complex, density, seed) = row;
                    (generated_id(prefix, row), json!({"section": section, "kind": kind(complex), "n": n, "taps": taps, "density": density, "seed": seed, "draws": DRAWS}))
                })
                .collect()
        }
        _ => unreachable!(),
    }
}

#[derive(Debug)]
struct Host {
    host: &'static str,
    dir: PathBuf,
    cases: BTreeMap<String, Value>,
}

fn load(root: &Path) -> Checked<Vec<Host>> {
    let manifest = read_json(&root.join("manifest.json"))?;
    let hosts = manifest["hosts"]
        .as_object()
        .ok_or("manifest: hosts is not an object")?;
    let names: BTreeSet<&str> = hosts.keys().map(String::as_str).collect();
    if names != HOSTS.iter().map(|h| h.0).collect() {
        return Err(format!("manifest hosts {names:?}"));
    }
    for (host, cpu) in HOSTS {
        let model = text(&hosts[host], "cpu")?;
        if model != cpu
            || !model.starts_with("AMD")
            || !text(&hosts[host], "blas")?.contains("CNR branch auto)")
        {
            return Err(format!(
                "{host}: {model} is not the pinned AMD host with MKL's auto branch"
            ));
        }
    }
    let mut out = Vec::new();
    for (host, _) in HOSTS {
        let dir = root.join(host).join("compatible");
        let mut cases = BTreeMap::new();
        for file in FILES {
            let recording = read_json(&dir.join(file))?;
            let list = recording["cases"]
                .as_array()
                .ok_or_else(|| format!("{host} {file}: cases is not a list"))?;
            check_cases(list, &expected_cases(file)).map_err(|e| format!("{host} {file}: {e}"))?;
            for case in list {
                cases.insert(case["id"].as_str().unwrap().to_string(), case.clone());
            }
        }
        out.push(Host { host, dir, cases });
    }
    Ok(out)
}

fn fixture() -> Option<Vec<Host>> {
    std::env::var_os("SAMSRF_CONV_GAPS_DIR").map(|root| load(Path::new(&root)).unwrap())
}

/// One recorded course: inputs and MATLAB's kept outputs (first n of n + taps - 1).
#[derive(Debug)]
struct Course {
    n: usize,
    complex: bool,
    kernel: Vec<f64>,
    nonzero: Vec<usize>,
    values: Vec<Vec<Complex64>>,
    outputs: Vec<Vec<Complex64>>,
}

fn course(
    dir: &Path,
    case: &Value,
    n: usize,
    taps: usize,
    complex: bool,
    nonzero_count: Option<usize>,
) -> Checked<Course> {
    let total = n + taps - 1;
    let get = |key: &str, shape: &[Option<usize>]| {
        array(dir, &case[key], Class::Double, shape, Nan::Refused).map(|a| a.values)
    };
    let kernel = get("kernel", &[Some(taps), Some(1)])?;
    let nonzero = get("nonzero", &[nonzero_count, Some(1)])?
        .into_iter()
        .map(|i| integer(i, 0, n - 1))
        .collect::<Checked<Vec<_>>>()?;
    if nonzero.is_empty() || !nonzero.windows(2).all(|w| w[0] < w[1]) {
        return Err("nonzero positions are empty or not increasing".into());
    }
    let m = nonzero.len();
    let (vr, vi) = (
        get("valuesReal", &[Some(m), Some(DRAWS)])?,
        get("valuesImaginary", &[Some(m), Some(DRAWS)])?,
    );
    let (re, im) = (
        get("real", &[Some(total), Some(DRAWS)])?,
        get("imaginary", &[Some(total), Some(DRAWS)])?,
    );
    if !complex && (vi.iter().any(|&v| v != 0.0) || im.iter().any(|&v| v != 0.0)) {
        return Err("a real course has an imaginary part".into());
    }
    let values = (0..DRAWS)
        .map(|d| {
            (0..m)
                .map(|j| Complex64::new(vr[d * m + j], vi[d * m + j]))
                .collect()
        })
        .collect();
    let outputs = (0..DRAWS)
        .map(|d| {
            (0..n)
                .map(|k| Complex64::new(re[d * total + k], im[d * total + k]))
                .collect()
        })
        .collect();
    Ok(Course {
        n,
        complex,
        kernel,
        nonzero,
        values,
        outputs,
    })
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits()
}

/// Production on every draw of a course.
fn production(c: &Course) -> Vec<Vec<Complex64>> {
    c.values
        .iter()
        .map(|values| {
            let mut y = vec![Complex64::new(0.0, 0.0); c.n];
            for (&i, &v) in c.nonzero.iter().zip(values) {
                y[i] = v;
            }
            if c.complex {
                m::convolve_complex(&y, &c.kernel, 1)
            } else {
                let re: Vec<f64> = y.iter().map(|v| v.re).collect();
                m::convolve_real(&re, &c.kernel, 1)
                    .into_iter()
                    .map(|v| Complex64::new(v, 0.0))
                    .collect()
            }
        })
        .collect()
}

/// A candidate on one part (real or imaginary values of one draw) at output k.
type Model<'a> = &'a dyn Fn(&[f64], &Course, usize) -> f64;

fn parts_missed(c: &Course, ours: &[Vec<Complex64>]) -> usize {
    ours.iter()
        .zip(&c.outputs)
        .map(|(a, b)| {
            (0..c.n).filter(|&k| !same(a[k].re, b[k].re)).count()
                + (0..c.n).filter(|&k| !same(a[k].im, b[k].im)).count()
        })
        .sum()
}

fn model_missed(c: &Course, model: Model) -> usize {
    let mut missed = 0;
    for (values, outputs) in c.values.iter().zip(&c.outputs) {
        let (re, im): (Vec<f64>, Vec<f64>) = values.iter().map(|v| (v.re, v.im)).unzip();
        for (k, output) in outputs.iter().enumerate() {
            missed += usize::from(!same(model(&re, c, k), output.re))
                + usize::from(!same(model(&im, c, k), output.im));
        }
    }
    missed
}

/// The sparse sum in input order with an unfused predicate.
fn sparse_sum(values: &[f64], c: &Course, k: usize, unfused: &dyn Fn(usize) -> bool) -> f64 {
    let mut sum = 0.0f64;
    for (&i, &v) in c.nonzero.iter().zip(values) {
        if i > k || i + c.kernel.len() <= k {
            continue;
        }
        let t = c.kernel[k - i];
        sum = if unfused(i) {
            sum + v * t
        } else {
            v.mul_add(t, sum)
        };
    }
    sum
}

/// The block rule with a threshold M (full outputs of at least M elements have
/// boundaries) and the block form: L (the frozen choice, rejected) keeps P at f = 8P,
/// S/A (production since this recording) doubles it.
fn block_rule(
    values: &[f64],
    c: &Course,
    k: usize,
    threshold: usize,
    doubles_at_eight: bool,
) -> f64 {
    let (n, taps) = (c.n, c.kernel.len());
    let full = n + taps - 1;
    let mut block = if c.complex { 512 } else { 1024 };
    while if doubles_at_eight {
        full >= 8 * block
    } else {
        full > 8 * block
    } {
        block *= 2;
    }
    sparse_sum(values, c, k, &|i| {
        if taps <= 16 {
            return true;
        }
        if full < threshold {
            return false;
        }
        if k % block >= block - 16 {
            return i + 16 >= (k / block + 1) * block;
        }
        let b = k / block * block;
        k >= block && (b..b + 16).contains(&(i + taps - 1))
    })
}

/// The short-kernel path in kernel order: unfused (R-tap) or the previous port
/// (unfused up to 16 samples, fused above; R-port).
fn tap_order(values: &[f64], c: &Course, k: usize, fused: bool) -> f64 {
    let mut y = vec![0.0; c.n];
    for (&i, &v) in c.nonzero.iter().zip(values) {
        y[i] = v;
    }
    let mut sum = 0.0f64;
    for (j, &t) in c.kernel.iter().enumerate().take(k + 1) {
        sum = if fused {
            y[k - j].mul_add(t, sum)
        } else {
            sum + y[k - j] * t
        };
    }
    sum
}

/// A: on both AMD hosts every replayed array equals the conv-blocks held-out pin
/// (recorded on two Intel hosts) byte for byte, and production reproduces every
/// kept part.
#[test]
fn replay_on_amd_equals_the_intel_held_out_recording() {
    let Some(hosts) = fixture() else { return };
    let blocks = PathBuf::from(
        std::env::var_os("SAMSRF_CONV_BLOCKS_DIR").expect("set SAMSRF_CONV_BLOCKS_DIR"),
    )
    .join("ubuntu-22.04")
    .join("compatible");
    let pinned = read_json(&blocks.join("conv-blocks-heldout.json")).unwrap();
    let pinned: BTreeMap<&str, &Value> = pinned["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["id"].as_str().unwrap(), c))
        .collect();
    for Host { host, dir, cases } in &hosts {
        let mut arrays = 0;
        for row in REPLAY {
            let id = replay_id(row);
            for key in [
                "kernel",
                "nonzero",
                "valuesReal",
                "valuesImaginary",
                "real",
                "imaginary",
            ] {
                let ours =
                    std::fs::read(dir.join(text(&cases[&id][key], "file").unwrap())).unwrap();
                let theirs =
                    std::fs::read(blocks.join(text(&pinned[id.as_str()][key], "file").unwrap()))
                        .unwrap();
                assert!(ours == theirs, "{host} {id} {key}");
                arrays += 1;
            }
            let (n, taps, complex) = row;
            let c = course(
                dir,
                &cases[&id],
                n,
                taps,
                complex,
                Some((0.24 * n as f64).round() as usize),
            )
            .unwrap();
            assert_eq!(parts_missed(&c, &production(&c)), 0, "{host} {id}");
        }
        assert_eq!(arrays, 72, "{host}");
    }
}

/// Frozen counts: (course, candidate) -> parts it misses. Every other candidate
/// misses none. The frozen threshold (complex >= 1,025, real >= 2,049) with S/A, and
/// production, miss none anywhere; the frozen block form L misses the three f = 8P
/// courses.
fn boundary_misses() -> BTreeMap<(&'static str, &'static str), usize> {
    BTreeMap::from([
        (("b_threshold-decide_complex_n991_t33", ">=1023"), 119),
        (("b_threshold-decide_complex_n992_t33", ">=1023"), 129),
        (("b_threshold-decide_complex_n992_t33", ">=1024"), 129),
        (("b_threshold-decide_complex_n993_t33", ">=1026"), 82),
        (("b_threshold-confirm_complex_n1007_t17", ">=1023"), 118),
        (("b_threshold-confirm_complex_n1008_t17", ">=1023"), 90),
        (("b_threshold-confirm_complex_n1008_t17", ">=1024"), 90),
        (("b_threshold-confirm_complex_n1009_t17", ">=1026"), 164),
        (("b_threshold-real_real_n2016_t33", ">=2048"), 59),
        (("b_blocks-decide_complex_n4064_t33", "L"), 434),
        (("b_blocks-confirm_complex_n4032_t65", "L"), 411),
        (("b_blocks-confirm_real_n8160_t33", "L"), 251),
    ])
}

/// B: the frozen threshold holds on every course; the frozen block form L is rejected
/// at f = 8P on the decide course and on both confirm courses, and S/A, which they
/// all choose, reproduces every course. Each other candidate misses exactly the
/// parts the design predicted, on both hosts.
#[test]
fn threshold_and_eight_block_choices_hold() {
    let Some(hosts) = fixture() else { return };
    for Host { host, dir, cases } in &hosts {
        let mut found = BTreeMap::new();
        for row in boundary_rows() {
            let id = generated_id("b", row);
            let (_, n, taps, complex, density, seed) = row;
            let g = generate(n, taps, complex, density, seed);
            let c = course(dir, &cases[&id], n, taps, complex, Some(g.nonzero.len())).unwrap();
            assert!(4 * c.nonzero.len() < n, "{id} is not sparse");
            assert_eq!(
                (&c.nonzero, &c.kernel, &c.values),
                (&g.nonzero, &g.kernel, &g.values),
                "{host} {id}: inputs differ from the generator"
            );
            assert_eq!(parts_missed(&c, &production(&c)), 0, "{host} {id}");
            let (frozen, others): (usize, Vec<usize>) = if complex {
                (1025, vec![1023, 1024, 1026])
            } else {
                (2049, vec![2048])
            };
            assert_eq!(
                model_missed(&c, &|v, c, k| block_rule(v, c, k, frozen, true)),
                0,
                "{host} {id}"
            );
            for threshold in others {
                let missed = model_missed(&c, &|v, c, k| block_rule(v, c, k, threshold, true));
                if missed > 0 {
                    found.insert((id.clone(), format!(">={threshold}")), missed);
                }
            }
            let missed = model_missed(&c, &|v, c, k| block_rule(v, c, k, frozen, false));
            if missed > 0 {
                found.insert((id.clone(), "L".to_string()), missed);
            }
        }
        let expected: BTreeMap<(String, String), usize> = boundary_misses()
            .into_iter()
            .map(|((a, b), v)| ((a.to_string(), b.to_string()), v))
            .collect();
        assert_eq!(found, expected, "{host}");
    }
}

/// C: production (input order, every product unfused, for sparse courses) reproduces
/// every held-out short-kernel course; R-tap and the previous path miss the frozen
/// counts; the dense controls follow the previous path, which production keeps there.
#[test]
fn short_kernels_follow_input_order_unfused() {
    let Some(hosts) = fixture() else { return };
    let expected: BTreeMap<&str, (usize, usize)> = BTreeMap::from([
        ("s_short-heldout_complex_n1300_t2", (0, 420)),
        ("s_short-heldout_complex_n1300_t4", (243, 1520)),
        ("s_short-heldout_complex_n1300_t6", (721, 2548)),
        ("s_short-heldout_complex_n1300_t7", (1300, 3512)),
        ("s_short-heldout_real_n2500_t2", (0, 353)),
        ("s_short-heldout_real_n2500_t4", (195, 1348)),
        ("s_short-heldout_real_n2500_t6", (1091, 3400)),
        ("s_short-heldout_real_n2500_t7", (1393, 3766)),
        ("s_short-heldout_complex_n300_t6", (359, 926)),
        ("s_short-heldout_real_n250_t7", (127, 345)),
        ("s_short-heldout_real_n400_t5", (74, 266)),
        ("s_short-heldout_real_n40_t4", (0, 16)),
        ("s_short-dense_complex_n1100_t4", (6215, 0)),
        ("s_short-dense_real_n900_t7", (3827, 0)),
    ]);
    for Host { host, dir, cases } in &hosts {
        let mut found = BTreeMap::new();
        for row in short_rows() {
            let id = generated_id("s", row);
            let (section, n, taps, complex, density, seed) = row;
            let g = generate(n, taps, complex, density, seed);
            let c = course(dir, &cases[&id], n, taps, complex, Some(g.nonzero.len())).unwrap();
            assert_eq!(
                section == "short-heldout",
                4 * c.nonzero.len() < n,
                "{id}: sparse as designed"
            );
            assert_eq!(
                (&c.nonzero, &c.kernel, &c.values),
                (&g.nonzero, &g.kernel, &g.values),
                "{host} {id}: inputs differ from the generator"
            );
            assert_eq!(parts_missed(&c, &production(&c)), 0, "{host} {id}");
            let tap = model_missed(&c, &|v, c, k| tap_order(v, c, k, false));
            let port = model_missed(&c, &|v, c, k| tap_order(v, c, k, c.n > 16));
            if section == "short-heldout" {
                assert_eq!(
                    model_missed(&c, &|v, c, k| sparse_sum(v, c, k, &|_| true)),
                    0,
                    "{host} {id}"
                );
            }
            found.insert(id, (tap, port));
        }
        let expected: BTreeMap<String, (usize, usize)> =
            expected.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        assert_eq!(found, expected, "{host}: (R-tap, previous path) misses");
    }
}

/// Both AMD hosts recorded identical arrays, and every array belongs to a case.
#[test]
fn hosts_recorded_identical_arrays() {
    let Some(hosts) = fixture() else { return };
    let names = |dir: &Path| -> BTreeSet<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".f64"))
            .collect()
    };
    let (a, b) = (names(&hosts[0].dir), names(&hosts[1].dir));
    assert_eq!(a, b);
    assert_eq!(
        a.len(),
        6 * (REPLAY.len() + boundary_rows().len() + short_rows().len())
    );
    for name in &a {
        assert_eq!(
            std::fs::read(hosts[0].dir.join(name)).unwrap(),
            std::fs::read(hosts[1].dir.join(name)).unwrap(),
            "{name}"
        );
    }
}

// ---- the boundary refuses malformed recordings -------------------------------------

fn skeleton(file: &str) -> Vec<Value> {
    expected_cases(file)
        .into_iter()
        .map(|(id, mut fields)| {
            fields["id"] = json!(id);
            fields
        })
        .collect()
}

#[test]
fn refuses_missing_families_duplicates_and_altered_identities() {
    for file in FILES {
        let expected = expected_cases(file);
        let cases = skeleton(file);
        check_cases(&cases, &expected).unwrap();
        assert!(check_cases(&[], &expected).is_err());
        let mut doubled = cases.clone();
        doubled.push(cases[0].clone());
        assert!(check_cases(&doubled, &expected)
            .unwrap_err()
            .contains("twice"));
        // A whole family missing: every real course, then every course of one section.
        let without_real: Vec<Value> = cases
            .iter()
            .filter(|c| c["kind"] != "real")
            .cloned()
            .collect();
        assert!(check_cases(&without_real, &expected)
            .unwrap_err()
            .contains("missing"));
        if file != "conv-gaps-replay.json" {
            let section = cases[0]["section"].clone();
            let without_section: Vec<Value> = cases
                .iter()
                .filter(|c| c["section"] != section)
                .cloned()
                .collect();
            assert!(check_cases(&without_section, &expected)
                .unwrap_err()
                .contains("missing"));
            for (key, value) in [
                ("seed", json!(1)),
                ("density", json!(0.25)),
                ("section", json!("control")),
            ] {
                let mut changed = cases.clone();
                changed[0][key] = value;
                assert!(check_cases(&changed, &expected).is_err(), "{file} {key}");
            }
        }
        let mut drawn = cases.clone();
        drawn[0]["draws"] = json!(11);
        assert!(check_cases(&drawn, &expected).is_err());
        // Another file's cases do not pass for this one.
        let other = FILES.iter().find(|f| **f != file).unwrap();
        assert!(check_cases(&skeleton(other), &expected).is_err());
    }
}

#[test]
fn refuses_non_amd_hosts_and_missing_files() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("conv-gaps")
        .join("hosts");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let write =
        |manifest: Value| std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    write(json!({"hosts": {}}));
    assert!(load(&dir).unwrap_err().contains("manifest hosts"));
    let hosts = |cpu: &str, branch: &str| {
        json!({"hosts": {
        "ubuntu-22.04": {"cpu": cpu, "blas": format!("MKL (CNR branch {branch})")},
        "ubuntu-24.04": {"cpu": HOSTS[1].1, "blas": "MKL (CNR branch auto)"}}})
    };
    // An Intel host is never an AMD confirmation.
    write(hosts("INTEL(R) XEON(R) PLATINUM 8573C", "AVX512_E1"));
    assert!(load(&dir).unwrap_err().contains("not the pinned AMD host"));
    write(hosts(HOSTS[0].1, "AVX2"));
    assert!(load(&dir).unwrap_err().contains("not the pinned AMD host"));
    write(hosts(HOSTS[0].1, "auto"));
    assert!(load(&dir).unwrap_err().contains("conv-gaps-replay.json"));
    for (host, _) in HOSTS {
        let folder = dir.join(host).join("compatible");
        std::fs::create_dir_all(&folder).unwrap();
        for file in &FILES[..2] {
            std::fs::write(
                folder.join(file),
                json!({"cases": skeleton(file)}).to_string(),
            )
            .unwrap();
        }
    }
    assert!(load(&dir).unwrap_err().contains("conv-gaps-short.json"));
    for (host, _) in HOSTS {
        std::fs::write(
            dir.join(host).join("compatible").join(FILES[2]),
            json!({"cases": skeleton(FILES[2])}).to_string(),
        )
        .unwrap();
    }
    assert_eq!(load(&dir).unwrap().len(), 2);
}

#[test]
fn the_generator_reproduces_the_design() {
    // Sparse as designed, before any recording: every held-out and boundary course
    // has fewer than a quarter nonzero, the dense controls more.
    for row in boundary_rows().into_iter().chain(short_rows()) {
        let (section, n, taps, complex, density, seed) = row;
        let g = generate(n, taps, complex, density, seed);
        assert_eq!(section != "short-dense", 4 * g.nonzero.len() < n, "{row:?}");
        assert_eq!((g.kernel.len(), g.values.len()), (taps, DRAWS));
    }
    let first = generate(990, 33, true, 0.20, 1990);
    assert_eq!(first.nonzero.len(), 200);
}
