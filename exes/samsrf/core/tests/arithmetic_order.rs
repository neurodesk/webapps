//! The arithmetic-order probes (`arithmetic-order-reference.json`, recorded by
//! `record_arithmetic_order.m`) against the predictions committed beforehand in
//! `packages/samsrf/validation/matlab/arithmetic-order-predictions.md`.
//!
//! Data: `SAMSRF_ARITHMETIC_ORDER_DIR` (the recording) and
//! `SAMSRF_MATLAB_NUMERICS2_DIR` (the pinned courses the conv section starts from).
//! Without the first, the fixture tests return; the `refuses_*` tests always run.
//! Every case, array and dimension is checked against the recorder's inventory
//! before it is used (`support/checked.rs`).
use num_complex::Complex64;
use samsrf_core::css;
use samsrf_core::matlab_math as m;
use samsrf_core::precision::Precision;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[path = "support/checked.rs"]
mod checked;
use checked::{array, integer, number, read_json, text, Array, Checked, Class, Nan};

/// The pinned run's hosts: the reference (AMD, MKL CNR `auto`) and the Intel host
/// (`AVX512_E1`). GitHub assigns the CPU, so a new recording names its own.
const HOSTS: [(&str, &str, &str); 2] = [
    ("ubuntu-22.04", "AMD EPYC 9V74 80-Core Processor", "auto"),
    ("ubuntu-24.04", "Intel(R) Xeon(R) 6975P-C", "AVX512_E1"),
];
const REFERENCE: &str = "ubuntu-22.04";

const DOT_EXHAUSTIVE: std::ops::RangeInclusive<usize> = 2..=80;
const DOT_HELD_OUT: [usize; 9] = [96, 100, 127, 128, 129, 200, 250, 256, 1000];
const DOT_SAMPLED_PAIRS: usize = 300;
const DOT_DRAWS: usize = 50;
/// Draws 1-25 identify; 26-50 are held out (0-based 25..50).
const DOT_IDENTIFY: usize = 25;
const CORR_DRAWS: usize = 20;
const CORR_HELD_OUT: [usize; 4] = [96, 100, 128, 250];

/// The pinned sparse complex courses longer than 800 samples, 24 draws each.
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
/// Generated held-out courses: length and taps, 8 draws each.
const CONV_HELD_OUT: [(usize, usize); 6] = [
    (1100, 33),
    (1536, 33),
    (2048, 33),
    (2600, 33),
    (1600, 17),
    (1600, 65),
];

fn dot_lengths() -> Vec<usize> {
    DOT_EXHAUSTIVE.chain(DOT_HELD_OUT).collect()
}

fn corr_lengths() -> Vec<usize> {
    (25..=80).chain(CORR_HELD_OUT).collect()
}

/// (id, kind, n, taps, draws, source) of every recorded case.
fn expected_cases() -> Vec<(String, &'static str, usize, usize, usize, &'static str)> {
    let mut cases: Vec<_> = dot_lengths()
        .into_iter()
        .map(|n| (format!("dot_n{n}"), "dot-order", n, 0, 0, ""))
        .collect();
    cases.extend(
        corr_lengths()
            .into_iter()
            .map(|n| (format!("corr_n{n}"), "corr", n, 0, 0, "")),
    );
    cases.extend(CONV_SOURCES.iter().map(|&(source, n)| {
        (
            format!("convw_{source}"),
            "conv-weighted",
            n,
            33,
            24,
            source,
        )
    }));
    cases.extend(CONV_HELD_OUT.iter().map(|&(n, taps)| {
        (
            format!("convw_heldout_n{n}_t{taps}"),
            "conv-weighted",
            n,
            taps,
            8,
            "",
        )
    }));
    cases
}

/// Every case is the recorder's, once, with its identity fields.
fn check_inventory(cases: &[Value]) -> Checked<()> {
    let mut found = BTreeMap::new();
    for case in cases {
        let id = text(case, "id")?;
        if found.insert(id.to_string(), case).is_some() {
            return Err(format!("case {id} appears twice"));
        }
    }
    let expected = expected_cases();
    let want: BTreeSet<&str> = expected.iter().map(|c| c.0.as_str()).collect();
    let have: BTreeSet<&str> = found.keys().map(String::as_str).collect();
    if have != want {
        return Err(format!(
            "missing cases {:?}, unexpected {:?}",
            want.difference(&have).collect::<Vec<_>>(),
            have.difference(&want).collect::<Vec<_>>()
        ));
    }
    for (id, kind, n, taps, draws, source) in &expected {
        let case = found[id];
        if text(case, "kind")? != *kind || integer(number(&case["n"])?, 1, 1 << 20)? != *n {
            return Err(format!("{id}: kind or n differs"));
        }
        if *kind == "dot-order" && case["exhaustive"] != json!(*n <= 80) {
            return Err(format!("{id}: exhaustive is {}", case["exhaustive"]));
        }
        if *kind == "conv-weighted" {
            let fields = (
                integer(number(&case["taps"])?, 1, 1 << 10)?,
                integer(number(&case["draws"])?, 0, 1 << 10)?,
                text(case, "source")?,
            );
            if fields != (*taps, *draws, *source) {
                return Err(format!("{id}: taps, draws or source {fields:?}"));
            }
        }
    }
    Ok(())
}

#[derive(Debug)]
struct Recording {
    host: &'static str,
    cpu: &'static str,
    dir: PathBuf,
    cases: BTreeMap<String, Value>,
}

fn recordings(root: &Path) -> Checked<Vec<Recording>> {
    let manifest = read_json(&root.join("manifest.json"))?;
    let hosts = manifest["hosts"]
        .as_object()
        .ok_or("manifest: hosts is not an object")?;
    let names: BTreeSet<&str> = hosts.keys().map(String::as_str).collect();
    if names != HOSTS.iter().map(|h| h.0).collect() {
        return Err(format!("manifest hosts {names:?}"));
    }
    for (host, cpu, branch) in HOSTS {
        if text(&hosts[host], "cpu")? != cpu
            || !text(&hosts[host], "blas")?.contains(&format!("CNR branch {branch})"))
        {
            return Err(format!(
                "{host}: CPU or MKL branch differs from the pinned run"
            ));
        }
    }
    let mut out = Vec::new();
    for (host, cpu, _) in HOSTS {
        let dir = root.join(host).join("compatible");
        let recording = read_json(&dir.join("arithmetic-order.json"))?;
        let list = recording["cases"]
            .as_array()
            .ok_or_else(|| format!("{host}: cases is not a list"))?;
        check_inventory(list).map_err(|e| format!("{host}: {e}"))?;
        let cases = list
            .iter()
            .map(|c| (c["id"].as_str().unwrap().to_string(), c.clone()))
            .collect();
        out.push(Recording {
            host,
            cpu,
            dir,
            cases,
        });
    }
    Ok(out)
}

fn fixture() -> Option<Vec<Recording>> {
    std::env::var_os("SAMSRF_ARITHMETIC_ORDER_DIR")
        .map(|root| recordings(Path::new(&root)).unwrap())
}

fn doubles(dir: &Path, case: &Value, key: &str, shape: &[Option<usize>]) -> Array {
    array(dir, &case[key], Class::Double, shape, Nan::Refused)
        .unwrap_or_else(|e| panic!("{}: {e}", case["id"]))
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits()
}

// ---- dot-order -----------------------------------------------------------------

/// One length: its pairs (1-based, nchoosek order when exhaustive), their counts,
/// and the draws as columns of x and y.
#[derive(Debug)]
struct DotLength {
    n: usize,
    pairs: Vec<(usize, usize)>,
    counts: Vec<f64>,
    x: Vec<f64>,
    y: Vec<f64>,
    dots: Vec<f64>,
}

fn dot_length(dir: &Path, case: &Value) -> Checked<DotLength> {
    let n = integer(number(&case["n"])?, 2, 1000)?;
    let k = if n <= 80 {
        n * (n - 1) / 2
    } else {
        DOT_SAMPLED_PAIRS
    };
    let pairs = array(
        dir,
        &case["pairs"],
        Class::Double,
        &[Some(k), Some(2)],
        Nan::Refused,
    )?;
    let pairs = (0..k)
        .map(|p| {
            Ok((
                integer(pairs.values[p], 1, n)?,
                integer(pairs.values[k + p], 1, n)?,
            ))
        })
        .collect::<Checked<Vec<_>>>()?;
    if n <= 80 {
        let all: Vec<(usize, usize)> = (1..=n)
            .flat_map(|a| (a + 1..=n).map(move |b| (a, b)))
            .collect();
        if pairs != all {
            return Err(format!("n = {n}: the pairs are not nchoosek(1:{n}, 2)"));
        }
    } else if !pairs.windows(2).all(|w| w[0] < w[1]) || pairs.iter().any(|(a, b)| a >= b) {
        return Err(format!(
            "n = {n}: the sampled pairs are not distinct, ordered pairs"
        ));
    }
    let counts = array(
        dir,
        &case["counts"],
        Class::Double,
        &[Some(k), Some(1)],
        Nan::Refused,
    )?
    .values;
    let x = array(
        dir,
        &case["x"],
        Class::Double,
        &[Some(n), Some(DOT_DRAWS)],
        Nan::Refused,
    )?
    .values;
    let y = array(
        dir,
        &case["y"],
        Class::Double,
        &[Some(n), Some(DOT_DRAWS)],
        Nan::Refused,
    )?
    .values;
    let dots = array(
        dir,
        &case["dots"],
        Class::Double,
        &[Some(DOT_DRAWS), Some(1)],
        Nan::Refused,
    )?
    .values;
    Ok(DotLength {
        n,
        pairs,
        counts,
        x,
        y,
        dots,
    })
}

impl DotLength {
    fn probe(&self, (a, b): (usize, usize)) -> (Vec<f64>, Vec<f64>) {
        let big = 2f64.powi(60);
        let mut y = vec![1.0; self.n];
        y[a - 1] = big;
        y[b - 1] = -big;
        (vec![1.0; self.n], y)
    }

    /// Fingerprints and draws (identification, held out) a kernel gets wrong.
    fn misses(&self, kernel: fn(&[f64], &[f64]) -> f64) -> (usize, usize, usize) {
        let fingerprints = self.pairs.iter().zip(&self.counts).filter(|(&p, &count)| {
            let (x, y) = self.probe(p);
            !same(kernel(&x, &y), count)
        });
        let column = |values: &[f64], d: usize| values[d * self.n..(d + 1) * self.n].to_vec();
        let draws: Vec<bool> = (0..DOT_DRAWS)
            .map(|d| {
                !same(
                    kernel(&column(&self.x, d), &column(&self.y, d)),
                    self.dots[d],
                )
            })
            .collect();
        (
            fingerprints.count(),
            draws[..DOT_IDENTIFY].iter().filter(|&&b| b).count(),
            draws[DOT_IDENTIFY..].iter().filter(|&&b| b).count(),
        )
    }
}

/// H-switch with T = 51: MATLAB's pair tree below 51 elements on both hosts, MKL's
/// `ddot` from 51 on the AMD host, at every fingerprint, identification draw,
/// held-out draw and held-out length. The previous port (`ddot_mkl` everywhere)
/// fails every length 3-50; the pair tree fails every length from 51.
#[test]
fn dot_order_switches_to_mkl_at_51_elements() {
    let Some(recordings) = fixture() else { return };
    for Recording {
        host,
        cpu,
        dir,
        cases,
    } in &recordings
    {
        let mut intel_lengths = Vec::new();
        for n in dot_lengths() {
            let length = dot_length(dir, &cases[&format!("dot_n{n}")])
                .unwrap_or_else(|e| panic!("{host}: {e}"));
            let (new, pairs, mkl) = (
                length.misses(m::ddot),
                length.misses(m::ddot_pairs),
                length.misses(m::ddot_mkl),
            );
            println!("{host} ({cpu}) n = {n}: ddot misses {new:?}, pair tree {pairs:?}, MKL model {mkl:?} (fingerprints, identification draws, held-out draws)");
            if n < m::DDOT_MKL_MIN_LENGTH {
                assert_eq!(new, (0, 0, 0), "{host} n = {n}");
                if n >= 3 {
                    assert!(mkl.0 > 0, "{host} n = {n}: the previous ddot would pass");
                }
            } else if *host == REFERENCE {
                assert_eq!(new, (0, 0, 0), "{host} n = {n}");
                assert!(pairs.0 > 0, "{host} n = {n}: the pair tree would pass");
            } else if new != (0, 0, 0) {
                intel_lengths.push(n);
            }
        }
        if *host != REFERENCE {
            // MKL's AVX-512 branch sums in another tree at every length from 51.
            let expected: Vec<usize> = dot_lengths()
                .into_iter()
                .filter(|&n| n >= m::DDOT_MKL_MIN_LENGTH)
                .collect();
            assert_eq!(intel_lengths, expected, "{host}");
        }
    }
}

// ---- corr ------------------------------------------------------------------------

/// The port's double CSS objective, `1 - corr(x, y)^2` for a real prediction,
/// against MATLAB's at 25-80, 96, 100, 128 and 250 elements.
#[test]
fn corr_objective_matches_the_reference_host() {
    let Some(recordings) = fixture() else { return };
    for Recording {
        host,
        cpu,
        dir,
        cases,
    } in &recordings
    {
        let (mut differs, mut checked) = (0, 0);
        for n in corr_lengths() {
            let case = &cases[&format!("corr_n{n}")];
            let x = doubles(dir, case, "x", &[Some(n), Some(CORR_DRAWS)]).values;
            let y = doubles(dir, case, "y", &[Some(n), Some(CORR_DRAWS)]).values;
            doubles(dir, case, "r", &[Some(CORR_DRAWS), Some(1)]);
            let objective = doubles(dir, case, "objective", &[Some(CORR_DRAWS), Some(1)]).values;
            for d in 0..CORR_DRAWS {
                let predicted: Vec<Complex64> = x[d * n..(d + 1) * n]
                    .iter()
                    .map(|&v| Complex64::new(v, 0.0))
                    .collect();
                let port = css::objective(&predicted, &y[d * n..(d + 1) * n], Precision::Double);
                checked += 1;
                let equal = same(port.re, objective[d]) && port.im == 0.0;
                differs += usize::from(!equal);
                if *host == REFERENCE {
                    assert!(
                        equal,
                        "{host} n = {n} draw {d}: port {:e}, MATLAB {:e}",
                        port.re, objective[d]
                    );
                }
            }
        }
        println!("{host} ({cpu}): the objective differs from MATLAB's on {differs} of {checked}");
        assert_eq!(checked, corr_lengths().len() * CORR_DRAWS);
    }
}

// ---- conv-weighted -----------------------------------------------------------------

/// A pinned course of numerics2: its nonzero positions, values and kernel.
struct Source {
    nonzero: Vec<usize>,
    values: Vec<Complex64>,
    kernel: Vec<f64>,
}

fn numerics2_source(id: &str, n: usize) -> Source {
    let root = PathBuf::from(
        std::env::var_os("SAMSRF_MATLAB_NUMERICS2_DIR").expect("set SAMSRF_MATLAB_NUMERICS2_DIR"),
    );
    let dir = root.join("ubuntu-22.04").join("compatible");
    let recording = read_json(&dir.join("numerics.json")).unwrap();
    let found: Vec<&Value> = recording["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["id"] == id)
        .collect();
    assert_eq!(found.len(), 1, "{id}");
    let case = found[0];
    assert_eq!(
        (&case["kind"], &case["isreal"]),
        (&json!("conv"), &json!(false)),
        "{id}"
    );
    let mut real = case["y"].clone();
    let imaginary_file = text(&real, "imaginary").unwrap().to_string();
    real["imaginary"] = json!("");
    let mut imaginary = real.clone();
    imaginary["file"] = json!(imaginary_file);
    let re = array(
        &dir,
        &real,
        Class::Double,
        &[Some(n), Some(1)],
        Nan::Refused,
    )
    .unwrap()
    .values;
    let im = array(
        &dir,
        &imaginary,
        Class::Double,
        &[Some(n), Some(1)],
        Nan::Refused,
    )
    .unwrap()
    .values;
    let kernel = array(
        &dir,
        &case["kernel"],
        Class::Double,
        &[Some(33), Some(1)],
        Nan::Refused,
    )
    .unwrap()
    .values;
    let nonzero: Vec<usize> = (0..n).filter(|&i| re[i] != 0.0 || im[i] != 0.0).collect();
    let values = nonzero
        .iter()
        .map(|&i| Complex64::new(re[i], im[i]))
        .collect();
    Source {
        nonzero,
        values,
        kernel,
    }
}

/// One recorded course: its nonzero positions, kernel, the values of every draw
/// and MATLAB's full outputs.
struct ConvCase {
    n: usize,
    taps: usize,
    nonzero: Vec<usize>,
    kernel: Vec<f64>,
    values: Vec<Vec<Complex64>>,
    outputs: Vec<Vec<Complex64>>,
}

fn conv_case(dir: &Path, case: &Value) -> ConvCase {
    let (n, taps, draws) = (
        case["n"].as_u64().unwrap() as usize,
        case["taps"].as_u64().unwrap() as usize,
        case["draws"].as_u64().unwrap() as usize,
    );
    let kernel = doubles(dir, case, "kernel", &[Some(taps), Some(1)]).values;
    let nonzero: Vec<usize> = doubles(dir, case, "nonzero", &[None, Some(1)])
        .values
        .iter()
        .map(|&i| integer(i, 0, n - 1).unwrap())
        .collect();
    let m = nonzero.len();
    assert!(
        m > 0 && 4 * m < n && nonzero.windows(2).all(|w| w[0] < w[1]),
        "{}",
        case["id"]
    );
    let (vr, vi) = (
        doubles(dir, case, "valuesReal", &[Some(m), Some(draws + 1)]).values,
        doubles(dir, case, "valuesImaginary", &[Some(m), Some(draws + 1)]).values,
    );
    let total = n + taps - 1;
    let (re, im) = (
        doubles(dir, case, "real", &[Some(total), Some(draws + 1)]).values,
        doubles(dir, case, "imaginary", &[Some(total), Some(draws + 1)]).values,
    );
    let values = (0..=draws)
        .map(|d| {
            (0..m)
                .map(|j| Complex64::new(vr[d * m + j], vi[d * m + j]))
                .collect()
        })
        .collect();
    let outputs = (0..=draws)
        .map(|d| {
            (0..total)
                .map(|k| Complex64::new(re[d * total + k], im[d * total + k]))
                .collect()
        })
        .collect();
    ConvCase {
        n,
        taps,
        nonzero,
        kernel,
        values,
        outputs,
    }
}

/// The rule the 33-tap courses fit (amendment of the predictions; not in
/// production): products of the last 16 inputs before a multiple B of 512 are
/// rounded and then added for outputs in [B - 16, B), and products of inputs
/// before B - 16 for outputs from B on; every other product is fused.
fn tile_rule(values: &[f64], nonzero: &[usize], kernel: &[f64], k: usize) -> f64 {
    let mut sum = 0.0f64;
    for (&i, &v) in nonzero.iter().zip(values) {
        if i > k || i + kernel.len() <= k {
            continue;
        }
        let unfused = if k % 512 >= 496 {
            i >= (k / 512 + 1) * 512 - 16
        } else {
            k >= 512 && i < k / 512 * 512 - 16
        };
        let t = kernel[k - i];
        sum = if unfused {
            sum + v * t
        } else {
            v.mul_add(t, sum)
        };
    }
    sum
}

/// The port's sparse path against every kept output of every draw: the counts of
/// differing parts are frozen, all within 16 below to 14 above a multiple of 512
/// or within 16 of a course end at a multiple of 512. The 33-tap rule fits every
/// 33-tap course (identification, held-out draws and held-out courses) and fails
/// on the 17- and 65-tap courses, so it is not adopted. Both hosts are identical.
#[test]
fn weighted_conv_residual_is_documented() {
    let Some(recordings) = fixture() else { return };
    let mut by_host = Vec::new();
    for Recording {
        host,
        cpu,
        dir,
        cases,
    } in &recordings
    {
        let mut port_parts = BTreeMap::new();
        let mut rule_parts = BTreeMap::new();
        let ids: Vec<String> = expected_cases()
            .into_iter()
            .filter(|c| c.1 == "conv-weighted")
            .map(|c| c.0)
            .collect();
        for id in &ids {
            let case = &cases[id];
            let c = conv_case(dir, case);
            let source = text(case, "source").unwrap();
            if !source.is_empty() {
                // The section starts from the pinned course: its pattern, values and kernel.
                let original = numerics2_source(source, c.n);
                assert_eq!(
                    (&c.nonzero, &c.values[0]),
                    (&original.nonzero, &original.values),
                    "{id}"
                );
                assert!(
                    c.kernel
                        .iter()
                        .zip(&original.kernel)
                        .all(|(a, b)| same(*a, *b)),
                    "{id}"
                );
            }
            let (mut port, mut rule, mut outside) = (0, 0, Vec::new());
            for (values, outputs) in c.values.iter().zip(&c.outputs) {
                let mut course = vec![Complex64::new(0.0, 0.0); c.n];
                for (&i, &v) in c.nonzero.iter().zip(values) {
                    course[i] = v;
                }
                let ours = m::convolve_complex(&course, &c.kernel, 1);
                let (re, im): (Vec<f64>, Vec<f64>) = values.iter().map(|v| (v.re, v.im)).unzip();
                for k in 0..c.n {
                    for (ours, theirs, values) in [
                        (ours[k].re, outputs[k].re, &re),
                        (ours[k].im, outputs[k].im, &im),
                    ] {
                        if !same(ours, theirs) {
                            port += 1;
                            let near = (k + 16 >= 512 && (k + 16) % 512 <= 30)
                                || (c.n.is_multiple_of(512) && k + 16 >= c.n);
                            if !near {
                                outside.push(k);
                            }
                        }
                        rule +=
                            usize::from(!same(tile_rule(values, &c.nonzero, &c.kernel, k), theirs));
                    }
                }
            }
            assert!(
                outside.is_empty(),
                "{host} {id}: differences away from 512 at {outside:?}"
            );
            assert!(c.taps == 33 || rule > 0, "{host} {id}");
            if c.taps == 33 {
                assert_eq!(rule, 0, "{host} {id}: the 33-tap rule misses {rule}");
            }
            port_parts.insert(id.clone(), port);
            rule_parts.insert(id.clone(), rule);
        }
        let (port, rule): (usize, usize) = (port_parts.values().sum(), rule_parts.values().sum());
        println!("{host} ({cpu}): the port differs on {port} parts, the 33-tap rule on {rule} ({rule_parts:?})");
        assert_eq!((port, rule), (4993, 257), "{host}");
        by_host.push((port_parts, rule_parts));
    }
    assert!(by_host.windows(2).all(|w| w[0] == w[1]), "the hosts differ");
}

// ---- the boundary refuses malformed recordings -------------------------------------

fn skeleton() -> Vec<Value> {
    expected_cases()
        .into_iter()
        .map(|(id, kind, n, taps, draws, source)| match kind {
            "dot-order" => json!({"id": id, "kind": kind, "n": n, "exhaustive": n <= 80}),
            "conv-weighted" => json!({"id": id, "kind": kind, "n": n, "taps": taps, "draws": draws, "source": source}),
            _ => json!({"id": id, "kind": kind, "n": n}),
        })
        .collect()
}

#[test]
fn refuses_incomplete_duplicated_or_misidentified_cases() {
    let cases = skeleton();
    assert_eq!(cases.len(), 88 + 60 + 16);
    check_inventory(&cases).unwrap();
    assert!(check_inventory(&[]).is_err());
    assert!(check_inventory(&cases[1..])
        .unwrap_err()
        .contains("missing"));
    let mut doubled = cases.clone();
    doubled.push(cases[3].clone());
    assert!(check_inventory(&doubled).unwrap_err().contains("twice"));
    for (index, key, value) in [
        (0, "n", json!(3)),
        (85, "exhaustive", json!(true)),
        (100, "kind", json!("dot-order")),
        (150, "taps", json!(17)),
        (160, "draws", json!(24)),
        (149, "source", json!("")),
    ] {
        let mut changed = cases.clone();
        changed[index][key] = value;
        assert!(check_inventory(&changed).is_err(), "{index} {key}");
    }
}

#[test]
fn refuses_empty_or_missing_hosts_and_other_runs() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("arithmetic-order")
        .join("hosts");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let write =
        |manifest: Value| std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    write(json!({"hosts": {}}));
    assert!(recordings(&dir).unwrap_err().contains("manifest hosts"));
    let hosts = |intel: &str| {
        json!({"hosts": {
        "ubuntu-22.04": {"cpu": HOSTS[0].1, "blas": "MKL (CNR branch auto)"},
        "ubuntu-24.04": {"cpu": intel, "blas": "MKL (CNR branch AVX512_E1)"}}})
    };
    write(hosts("Intel(R) Xeon(R) Platinum 8573C"));
    assert!(recordings(&dir)
        .unwrap_err()
        .contains("differs from the pinned run"));
    write(hosts(HOSTS[1].1));
    assert!(recordings(&dir)
        .unwrap_err()
        .contains("arithmetic-order.json"));
    for (host, ..) in HOSTS {
        std::fs::create_dir_all(dir.join(host).join("compatible")).unwrap();
        std::fs::write(
            dir.join(host)
                .join("compatible")
                .join("arithmetic-order.json"),
            json!({"cases": skeleton()}).to_string(),
        )
        .unwrap();
    }
    assert_eq!(recordings(&dir).unwrap().len(), 2);
}

#[test]
fn refuses_incomplete_dot_arrays() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("arithmetic-order")
        .join("dot");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let n = 4;
    let write = |name: &str, values: &[f64], shape: [usize; 2]| {
        std::fs::write(
            dir.join(format!("{name}.f64")),
            values
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<u8>>(),
        )
        .unwrap();
        json!({"file": format!("{name}.f64"), "shape": shape, "class": "double", "imaginary": ""})
    };
    // nchoosek(1:4, 2), column-major.
    let pairs = [1.0, 1.0, 1.0, 2.0, 2.0, 3.0, 2.0, 3.0, 4.0, 3.0, 4.0, 4.0];
    let mut case = json!({"n": n,
        "pairs": write("pairs", &pairs, [6, 2]),
        "counts": write("counts", &[0.0; 6], [6, 1]),
        "x": write("x", &vec![1.0; n * DOT_DRAWS], [n, DOT_DRAWS]),
        "y": write("y", &vec![1.0; n * DOT_DRAWS], [n, DOT_DRAWS]),
        "dots": write("dots", &[4.0; DOT_DRAWS], [DOT_DRAWS, 1])});
    assert!(dot_length(&dir, &case).is_ok());
    let mut reordered = pairs;
    reordered.swap(0, 1);
    reordered.swap(6, 7);
    case["pairs"] = write("reordered", &reordered, [6, 2]);
    assert!(dot_length(&dir, &case).unwrap_err().contains("nchoosek"));
    case["pairs"] = write("short", &pairs[..10], [5, 2]);
    assert!(dot_length(&dir, &case).is_err());
    case["pairs"] = write("pairs", &pairs, [6, 2]);
    case["dots"] = write("dots_short", &[4.0; DOT_DRAWS - 1], [DOT_DRAWS - 1, 1]);
    assert!(dot_length(&dir, &case).is_err());
    case["dots"] = write("dots", &[4.0; DOT_DRAWS], [DOT_DRAWS, 1]);
    case["x"] = write("x_nan", &[f64::NAN; 4 * DOT_DRAWS], [n, DOT_DRAWS]);
    assert!(dot_length(&dir, &case).is_err());
}
