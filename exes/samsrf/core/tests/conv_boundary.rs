//! MATLAB's sparse `conv` near block boundaries: the two recordings pre-registered in
//! `packages/samsrf/validation/matlab/conv-boundary-predictions.md`
//! (`conv-boundary-reference.json`, recorded by `record_conv_boundary.m`, and
//! `conv-blocks-reference.json`, by `record_conv_blocks.m`), each with a discovery
//! file and a held-out file.
//!
//! Data: `SAMSRF_CONV_BOUNDARY_DIR` and `SAMSRF_CONV_BLOCKS_DIR`. Without them the
//! fixture tests return; the `refuses_*` tests always run. Every course, array and
//! dimension is checked against the recorder's tables before it is used.
use num_complex::Complex64;
use samsrf_core::matlab_math as m;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[path = "support/checked.rs"]
mod checked;
use checked::{array, integer, number, read_json, text, Checked, Class, Nan};

const DRAWS: usize = 12;

/// One course of a recorder table: length, taps and kind.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Complex,
    Real,
    Dense,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Complex => "complex",
            Kind::Real => "real",
            Kind::Dense => "dense",
        }
    }
}

/// A recording: its hosts (folder, CPU, MKL branch) and its two files with their
/// course tables, as the recorder writes them.
struct Spec {
    hosts: [(&'static str, &'static str, &'static str); 2],
    files: [(&'static str, &'static str, Table); 2],
}

/// Courses as (length, taps, kind), in recorder order.
type Table = Vec<(usize, usize, Kind)>;

fn boundary_spec() -> Spec {
    use Kind::*;
    let mut discovery = Vec::new();
    for n in [820, 850, 880, 900, 925, 950, 970, 980, 990, 995, 1000, 1010] {
        discovery.push((n, 17, Complex));
        discovery.push((n, 33, Complex));
    }
    discovery.extend([
        (1100, 9, Complex),
        (1100, 11, Complex),
        (1100, 12, Complex),
        (1100, 15, Complex),
        (1020, 33, Complex),
        (1530, 33, Complex),
        (2048, 33, Real),
        (1100, 33, Dense),
    ]);
    let held_out = vec![
        (845, 13, Complex),
        (915, 25, Complex),
        (960, 13, Complex),
        (1005, 25, Complex),
        (1015, 13, Complex),
        (1300, 13, Complex),
        (1536, 21, Complex),
        (2100, 49, Complex),
        (2600, 41, Complex),
        (3100, 97, Complex),
        (4096, 129, Complex),
        (3072, 33, Complex),
        (2560, 10, Complex),
        (1700, 16, Complex),
    ];
    Spec {
        hosts: [
            ("ubuntu-22.04", "AMD EPYC 9V74 80-Core Processor", "auto"),
            ("ubuntu-24.04", "Intel(R) Xeon(R) 6975P-C", "AVX512_E1"),
        ],
        files: [
            ("conv-boundary-discovery.json", "d", discovery),
            ("conv-boundary-heldout.json", "h", held_out),
        ],
    }
}

fn blocks_spec() -> Spec {
    use Kind::*;
    let mut discovery: Vec<(usize, usize, Kind)> =
        (120..=131).map(|t| (4096, t, Complex)).collect();
    discovery.extend([65, 97, 105, 113, 145, 193, 255, 256, 257, 258].map(|t| (4096, t, Complex)));
    discovery.extend([
        (1900, 129, Complex),
        (1920, 129, Complex),
        (2000, 129, Complex),
    ]);
    discovery.extend([17, 33, 65, 129, 257].map(|t| (4096, t, Real)));
    discovery.extend([(2010, 33, Real), (2016, 33, Real), (2040, 33, Real)]);
    discovery.extend([
        (1100, 3, Complex),
        (1100, 5, Complex),
        (1100, 8, Complex),
        (2100, 3, Real),
        (2100, 5, Real),
        (2100, 8, Real),
    ]);
    let held_out = vec![
        (3000, 100, Complex),
        (5000, 140, Complex),
        (4500, 200, Complex),
        (6000, 300, Complex),
        (2600, 129, Complex),
        (6000, 25, Complex),
        (900, 13, Complex),
        (3000, 21, Real),
        (4100, 49, Real),
        (5000, 97, Real),
        (6000, 140, Real),
        (1500, 13, Real),
    ];
    Spec {
        hosts: [
            (
                "ubuntu-22.04",
                "INTEL(R) XEON(R) PLATINUM 8573C",
                "AVX512_E1",
            ),
            ("ubuntu-24.04", "Intel(R) Xeon(R) 6975P-C", "AVX512_E1"),
        ],
        files: [
            ("conv-blocks-discovery.json", "d2", discovery),
            ("conv-blocks-heldout.json", "h2", held_out),
        ],
    }
}

fn case_id(prefix: &str, (n, taps, kind): (usize, usize, Kind)) -> String {
    format!("{prefix}_{}_n{n}_t{taps}", kind.name())
}

/// MATLAB's `round(x * n)` for the recorder's densities.
fn nonzero_count(n: usize, kind: Kind) -> usize {
    let density = if kind == Kind::Dense { 0.6 } else { 0.24 };
    (density * n as f64).round() as usize
}

/// Every case of a file is in the table, once, with its fields.
fn check_cases(cases: &[Value], prefix: &str, table: &[(usize, usize, Kind)]) -> Checked<()> {
    let mut found = BTreeMap::new();
    for case in cases {
        let id = text(case, "id")?;
        if found.insert(id.to_string(), case).is_some() {
            return Err(format!("case {id} appears twice"));
        }
    }
    let want: BTreeSet<String> = table.iter().map(|&row| case_id(prefix, row)).collect();
    let have: BTreeSet<String> = found.keys().cloned().collect();
    if have != want || want.len() != table.len() {
        return Err(format!(
            "missing cases {:?}, unexpected {:?}",
            want.difference(&have).collect::<Vec<_>>(),
            have.difference(&want).collect::<Vec<_>>()
        ));
    }
    for &(n, taps, kind) in table {
        let id = case_id(prefix, (n, taps, kind));
        let case = found[&id];
        let fields = (
            text(case, "kind")?,
            integer(number(&case["n"])?, 1, 1 << 20)?,
            integer(number(&case["taps"])?, 1, 1 << 12)?,
            integer(number(&case["draws"])?, 0, 1 << 10)?,
        );
        if fields != (kind.name(), n, taps, DRAWS) {
            return Err(format!("{id}: fields {fields:?}"));
        }
    }
    Ok(())
}

/// One host of one recording: its folder and the cases of both files by id.
#[derive(Debug)]
struct Host {
    host: &'static str,
    dir: PathBuf,
    cases: BTreeMap<String, Value>,
}

fn load(root: &Path, spec: &Spec) -> Checked<Vec<Host>> {
    let manifest = read_json(&root.join("manifest.json"))?;
    let hosts = manifest["hosts"]
        .as_object()
        .ok_or("manifest: hosts is not an object")?;
    let names: BTreeSet<&str> = hosts.keys().map(String::as_str).collect();
    if names != spec.hosts.iter().map(|h| h.0).collect() {
        return Err(format!("manifest hosts {names:?}"));
    }
    for (host, cpu, branch) in spec.hosts {
        if text(&hosts[host], "cpu")? != cpu
            || !text(&hosts[host], "blas")?.contains(&format!("CNR branch {branch})"))
        {
            return Err(format!(
                "{host}: CPU or MKL branch differs from the pinned run"
            ));
        }
    }
    let mut out = Vec::new();
    for (host, ..) in spec.hosts {
        let dir = root.join(host).join("compatible");
        let mut cases = BTreeMap::new();
        for (file, prefix, table) in &spec.files {
            let recording = read_json(&dir.join(file))?;
            let list = recording["cases"]
                .as_array()
                .ok_or_else(|| format!("{host} {file}: cases is not a list"))?;
            check_cases(list, prefix, table).map_err(|e| format!("{host} {file}: {e}"))?;
            for case in list {
                cases.insert(case["id"].as_str().unwrap().to_string(), case.clone());
            }
        }
        out.push(Host { host, dir, cases });
    }
    Ok(out)
}

fn fixture(variable: &str, spec: &Spec) -> Option<Vec<Host>> {
    std::env::var_os(variable).map(|root| load(Path::new(&root), spec).unwrap())
}

/// One course with every draw: values on its nonzero positions and MATLAB's kept
/// outputs (the first n of n + taps - 1, real and imaginary).
#[derive(Debug)]
struct Course {
    n: usize,
    kind: Kind,
    kernel: Vec<f64>,
    nonzero: Vec<usize>,
    values: Vec<Vec<Complex64>>,
    outputs: Vec<Vec<Complex64>>,
}

fn course(dir: &Path, case: &Value, (n, taps, kind): (usize, usize, Kind)) -> Checked<Course> {
    let m = nonzero_count(n, kind);
    let total = n + taps - 1;
    let get = |key: &str, shape: &[Option<usize>]| {
        array(dir, &case[key], Class::Double, shape, Nan::Refused).map(|a| a.values)
    };
    let kernel = get("kernel", &[Some(taps), Some(1)])?;
    let nonzero = get("nonzero", &[Some(m), Some(1)])?
        .into_iter()
        .map(|i| integer(i, 0, n - 1))
        .collect::<Checked<Vec<_>>>()?;
    if !nonzero.windows(2).all(|w| w[0] < w[1]) {
        return Err("nonzero positions are not increasing".into());
    }
    let (vr, vi) = (
        get("valuesReal", &[Some(m), Some(DRAWS)])?,
        get("valuesImaginary", &[Some(m), Some(DRAWS)])?,
    );
    let (re, im) = (
        get("real", &[Some(total), Some(DRAWS)])?,
        get("imaginary", &[Some(total), Some(DRAWS)])?,
    );
    if kind == Kind::Real && (vi.iter().any(|&v| v != 0.0) || im.iter().any(|&v| v != 0.0)) {
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
        kind,
        kernel,
        nonzero,
        values,
        outputs,
    })
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits()
}

/// A model of the sparse sum: `unfused(i, k)` says which products are rounded and
/// then added; every other product is fused.
fn sparse_sum(
    values: &[f64],
    nonzero: &[usize],
    kernel: &[f64],
    k: usize,
    unfused: &dyn Fn(usize, usize) -> bool,
) -> f64 {
    let mut sum = 0.0f64;
    for (&i, &v) in nonzero.iter().zip(values) {
        if i > k || i + kernel.len() <= k {
            continue;
        }
        let t = kernel[k - i];
        sum = if unfused(i, k) {
            sum + v * t
        } else {
            v.mul_add(t, sum)
        };
    }
    sum
}

/// Parts of a course a model misses, and how many it was compared on.
fn misses(c: &Course, model: Option<&dyn Fn(usize, usize) -> bool>) -> (usize, usize) {
    let (mut missed, mut compared) = (0, 0);
    for (values, outputs) in c.values.iter().zip(&c.outputs) {
        let ours: Vec<Complex64> = match model {
            None => {
                let mut y = vec![Complex64::new(0.0, 0.0); c.n];
                for (&i, &v) in c.nonzero.iter().zip(values) {
                    y[i] = v;
                }
                if c.kind == Kind::Real {
                    let re: Vec<f64> = y.iter().map(|v| v.re).collect();
                    m::convolve_real(&re, &c.kernel, 1)
                        .into_iter()
                        .map(|v| Complex64::new(v, 0.0))
                        .collect()
                } else {
                    m::convolve_complex(&y, &c.kernel, 1)
                }
            }
            Some(unfused) => {
                let (re, im): (Vec<f64>, Vec<f64>) = values.iter().map(|v| (v.re, v.im)).unzip();
                (0..c.n)
                    .map(|k| {
                        Complex64::new(
                            sparse_sum(&re, &c.nonzero, &c.kernel, k, unfused),
                            sparse_sum(&im, &c.nonzero, &c.kernel, k, unfused),
                        )
                    })
                    .collect()
            }
        };
        assert_eq!(ours.len(), c.n);
        for k in 0..c.n {
            missed += usize::from(!same(ours[k].re, outputs[k].re))
                + usize::from(!same(ours[k].im, outputs[k].im));
            compared += 2;
        }
    }
    (missed, compared)
}

/// The previous port: every product of the sparse sum fused.
fn all_fused(_: usize, _: usize) -> bool {
    false
}

/// The rule frozen from the first discovery file and rejected by its held-out
/// 4,096-sample, 129-tap course: the same windows with a fixed 512-element block.
fn first_rule(n: usize, taps: usize) -> impl Fn(usize, usize) -> bool {
    move |i, k| {
        if taps <= 16 {
            return true;
        }
        if (n + taps - 1) * 16 <= 16 * 1024 {
            return false;
        }
        if k % 512 >= 496 {
            return i + 16 >= (k / 512 + 1) * 512;
        }
        let b = k / 512 * 512;
        k >= 512 && (b..b + 16).contains(&(i + taps - 1))
    }
}

/// Every course of both recordings on every host. Production equals MATLAB at every
/// kept part of every sparse course with at least 9 taps, discovery and held out;
/// the previous fused model misses the frozen counts. The 3-, 5- and 8-tap courses,
/// discovery for the short-kernel rule held out in `conv_gaps.rs`, are equal since
/// it (every product unfused; the previous path missed 13,851 parts); the dense
/// control matches the dense path.
#[test]
fn sparse_conv_follows_the_block_rule() {
    let recordings = [
        ("SAMSRF_CONV_BOUNDARY_DIR", boundary_spec()),
        ("SAMSRF_CONV_BLOCKS_DIR", blocks_spec()),
    ];
    for (variable, spec) in &recordings {
        let Some(hosts) = fixture(variable, spec) else {
            continue;
        };
        let mut per_host = Vec::new();
        for Host { host, dir, cases } in &hosts {
            // Per file: parts compared, previous model's misses, outside-rule misses.
            let mut tally: BTreeMap<&str, (usize, usize, usize)> = BTreeMap::new();
            for (file, prefix, table) in &spec.files {
                for &row in table {
                    let id = case_id(prefix, row);
                    let c = course(dir, &cases[&id], row)
                        .unwrap_or_else(|e| panic!("{host} {id}: {e}"));
                    let (n, taps, kind) = row;
                    let entry = tally.entry(file).or_default();
                    let (production, compared) = misses(&c, None);
                    if kind == Kind::Dense || taps < 9 {
                        entry.2 += production;
                        if taps < 9 {
                            assert_eq!(
                                misses(&c, Some(&|_, _| true)).0,
                                0,
                                "{host} {id}: not every product unfused"
                            );
                            assert_eq!(production, 0, "{host} {id}");
                        }
                        continue;
                    }
                    assert_eq!(
                        production, 0,
                        "{host} {id}: production misses {production} of {compared} parts"
                    );
                    let (previous, _) = misses(&c, Some(&all_fused));
                    entry.0 += compared;
                    entry.1 += previous;
                    if id == "h_complex_n4096_t129" {
                        let rule = first_rule(n, taps);
                        assert_eq!(misses(&c, Some(&rule)).0, 398, "{host} {id}");
                    }
                    if taps < 17 && kind != Kind::Dense {
                        assert!(previous > 0, "{host} {id}: short kernels are where the previous model fails everywhere");
                    }
                }
            }
            println!("{host}: per file (parts compared, previous model's misses, outside-rule production misses): {tally:?}");
            per_host.push(tally);
        }
        let expected: BTreeMap<&str, (usize, usize, usize)> =
            if *variable == "SAMSRF_CONV_BOUNDARY_DIR" {
                BTreeMap::from([
                    (
                        "conv-boundary-discovery.json",
                        (756_912, 30_399, DENSE_CONTROL),
                    ),
                    ("conv-boundary-heldout.json", (643_296, 63_460, 0)),
                ])
            } else {
                BTreeMap::from([
                    (
                        "conv-blocks-discovery.json",
                        (2_939_472, 12_023, SHORT_KERNELS),
                    ),
                    ("conv-blocks-heldout.json", (1_142_400, 15_552, 0)),
                ])
            };
        for tally in &per_host {
            assert_eq!(tally, &expected, "{variable}");
        }
    }
}

/// Parts the port's dense path misses on the dense control (reported, no rule).
const DENSE_CONTROL: usize = 0;
/// Parts production misses on the 3-, 5- and 8-tap courses (13,851 before the
/// short-kernel rule).
const SHORT_KERNELS: usize = 0;

/// The two hosts of each recording hold identical arrays (one AMD and one Intel host
/// in the first, two Intel hosts in the second).
#[test]
fn hosts_recorded_identical_arrays() {
    for (variable, spec) in [
        ("SAMSRF_CONV_BOUNDARY_DIR", boundary_spec()),
        ("SAMSRF_CONV_BLOCKS_DIR", blocks_spec()),
    ] {
        let Some(hosts) = fixture(variable, &spec) else {
            continue;
        };
        let names = |dir: &Path| -> BTreeSet<String> {
            std::fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .filter(|n| n.ends_with(".f64"))
                .collect()
        };
        let (a, b) = (names(&hosts[0].dir), names(&hosts[1].dir));
        assert_eq!(a, b, "{variable}");
        let per_course = 6;
        let courses: usize = spec.files.iter().map(|f| f.2.len()).sum();
        assert_eq!(
            a.len(),
            per_course * courses,
            "{variable}: every course has six arrays and nothing else"
        );
        for name in &a {
            assert_eq!(
                std::fs::read(hosts[0].dir.join(name)).unwrap(),
                std::fs::read(hosts[1].dir.join(name)).unwrap(),
                "{variable} {name}"
            );
        }
    }
}

// ---- the boundary refuses malformed recordings -------------------------------------

fn skeleton(prefix: &str, table: &[(usize, usize, Kind)]) -> Vec<Value> {
    table.iter().map(|&(n, taps, kind)| json!({"id": case_id(prefix, (n, taps, kind)), "kind": kind.name(), "n": n, "taps": taps, "draws": DRAWS})).collect()
}

#[test]
fn refuses_missing_families_duplicates_and_misidentified_courses() {
    for spec in [boundary_spec(), blocks_spec()] {
        for (_, prefix, table) in &spec.files {
            let cases = skeleton(prefix, table);
            check_cases(&cases, prefix, table).unwrap();
            assert!(check_cases(&[], prefix, table).is_err());
            // A whole family missing: every real course, or every course of one kernel length.
            let without_real: Vec<Value> = cases
                .iter()
                .filter(|c| c["kind"] != "real")
                .cloned()
                .collect();
            if without_real.len() < cases.len() {
                assert!(check_cases(&without_real, prefix, table)
                    .unwrap_err()
                    .contains("missing"));
            }
            let taps = table[0].1;
            let without_taps: Vec<Value> = cases
                .iter()
                .filter(|c| c["taps"] != taps)
                .cloned()
                .collect();
            assert!(check_cases(&without_taps, prefix, table).is_err());
            let mut doubled = cases.clone();
            doubled.push(cases[0].clone());
            assert!(check_cases(&doubled, prefix, table)
                .unwrap_err()
                .contains("twice"));
            for (key, value) in [
                ("draws", json!(11)),
                ("kind", json!("dense")),
                ("n", json!(1)),
            ] {
                let mut changed = cases.clone();
                changed[0][key] = value;
                assert!(check_cases(&changed, prefix, table).is_err(), "{key}");
            }
            // The other file's courses do not pass for this one.
            let other = if *prefix == spec.files[0].1 {
                &spec.files[1]
            } else {
                &spec.files[0]
            };
            assert!(check_cases(&skeleton(other.1, &other.2), prefix, table).is_err());
        }
    }
}

#[test]
fn refuses_other_hosts_and_missing_files() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("conv-boundary")
        .join("hosts");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let spec = blocks_spec();
    let write =
        |manifest: Value| std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    write(json!({"hosts": {}}));
    assert!(load(&dir, &spec).unwrap_err().contains("manifest hosts"));
    let hosts = |first: &str| {
        json!({"hosts": {
        "ubuntu-22.04": {"cpu": first, "blas": "MKL (CNR branch AVX512_E1)"},
        "ubuntu-24.04": {"cpu": spec.hosts[1].1, "blas": "MKL (CNR branch AVX512_E1)"}}})
    };
    write(hosts("AMD EPYC 7763 64-Core Processor"));
    assert!(load(&dir, &spec)
        .unwrap_err()
        .contains("differs from the pinned run"));
    write(hosts(spec.hosts[0].1));
    assert!(load(&dir, &spec)
        .unwrap_err()
        .contains("conv-blocks-discovery.json"));
    for (host, ..) in spec.hosts {
        let folder = dir.join(host).join("compatible");
        std::fs::create_dir_all(&folder).unwrap();
        let (file, prefix, table) = &spec.files[0];
        std::fs::write(
            folder.join(file),
            json!({"cases": skeleton(prefix, table)}).to_string(),
        )
        .unwrap();
    }
    // The held-out file is missing.
    assert!(load(&dir, &spec)
        .unwrap_err()
        .contains("conv-blocks-heldout.json"));
    for (host, ..) in spec.hosts {
        let (file, prefix, table) = &spec.files[1];
        std::fs::write(
            dir.join(host).join("compatible").join(file),
            json!({"cases": skeleton(prefix, table)}).to_string(),
        )
        .unwrap();
    }
    assert_eq!(load(&dir, &spec).unwrap().len(), 2);
}

#[test]
fn refuses_courses_whose_arrays_do_not_match_their_row() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("conv-boundary")
        .join("course");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let row = (40, 9, Kind::Real);
    let m = nonzero_count(40, Kind::Real);
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
    let positions: Vec<f64> = (0..m).map(|i| (i * 4) as f64).collect();
    let mut case = json!({
        "kernel": write("kernel", &[1.0; 9], [9, 1]),
        "nonzero": write("nonzero", &positions, [m, 1]),
        "valuesReal": write("vr", &vec![1.0; m * DRAWS], [m, DRAWS]),
        "valuesImaginary": write("vi", &vec![0.0; m * DRAWS], [m, DRAWS]),
        "real": write("re", &vec![0.0; 48 * DRAWS], [48, DRAWS]),
        "imaginary": write("im", &vec![0.0; 48 * DRAWS], [48, DRAWS])});
    assert!(course(&dir, &case, row).is_ok());
    case["imaginary"] = write("im_nonzero", &vec![1.0; 48 * DRAWS], [48, DRAWS]);
    assert!(course(&dir, &case, row).unwrap_err().contains("imaginary"));
    case["imaginary"] = write("im", &vec![0.0; 48 * DRAWS], [48, DRAWS]);
    let mut shuffled = positions.clone();
    shuffled.swap(0, 1);
    case["nonzero"] = write("nonzero_shuffled", &shuffled, [m, 1]);
    assert!(course(&dir, &case, row).unwrap_err().contains("increasing"));
    case["nonzero"] = write("nonzero_short", &positions[1..], [m - 1, 1]);
    assert!(course(&dir, &case, row).is_err());
    case["nonzero"] = write("nonzero", &positions, [m, 1]);
    case["real"] = write(
        "re_one_draw_short",
        &vec![0.0; 48 * (DRAWS - 1)],
        [48, DRAWS - 1],
    );
    assert!(course(&dir, &case, row).is_err());
}
