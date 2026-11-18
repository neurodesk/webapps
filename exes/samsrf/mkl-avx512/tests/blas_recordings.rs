//! The research kernels of `samsrf_mkl_avx512::blas` (MATLAB's `x' * y`, `y' * A`, `corr`
//! and double CF profiles on MKL's AVX512_E1 branch) against the pinned recordings. Hosts
//! are chosen by the MKL branch their receipts report; every gate also runs the shipped AMD
//! kernels as control on the AMD host and requires each branch to fail on the other host.
//! Record and disclosures: packages/samsrf/validation/matlab/intel-avx512/prereg-dot-gemv.md
//! (research branch). Each test returns when its recording is not configured.
use samsrf_mkl_avx512::blas;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// A float64 array, checked against its descriptor's shape and class.
fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name, "array names are plain file names");
    assert_eq!(descriptor["class"], "double", "{name}: class");
    let bytes = std::fs::read(root.join(name)).unwrap();
    let values: Vec<f64> = bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect();
    let count: u64 = descriptor["shape"].as_array().unwrap().iter().map(|d| d.as_u64().unwrap()).product();
    assert_eq!(values.len() as u64, count, "{name}: shape");
    values
}

/// A `y' * A` kernel: one value per column.
type Gemv<'a> = &'a dyn Fn(&[f64], &[&[f64]]) -> Vec<f64>;
/// One recorded `corr` length: n, the 20 x and y courses (column-major) and MATLAB's r values.
type CorrCase = (usize, Vec<f64>, Vec<f64>, Vec<f64>);

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits()
}

/// The AVX512_E1 directory and the AMD `auto` directory among `dirs`, from each one's
/// receipt; anything else fails.
fn hosts(dirs: Vec<PathBuf>, receipt: impl Fn(&Path) -> String) -> (PathBuf, PathBuf) {
    let (mut intel, mut amd) = (None, None);
    for dir in dirs {
        let text = receipt(&dir);
        if text.contains("CNR branch AVX512_E1") {
            assert!(intel.replace(dir).is_none(), "two AVX512_E1 hosts");
        } else if text.contains("CNR branch auto") && text.contains("AMD EPYC") {
            assert!(amd.replace(dir).is_none(), "two AMD hosts");
        } else {
            panic!("{}: neither an AVX512_E1 nor an AMD auto host", dir.display());
        }
    }
    (intel.expect("an AVX512_E1 host"), amd.expect("an AMD host"))
}

fn arithmetic_order_hosts(root: &Path) -> (PathBuf, PathBuf) {
    hosts(["ubuntu-22.04", "ubuntu-24.04"].map(|h| root.join(h).join("compatible")).to_vec(), |dir| json(&dir.join("arithmetic-order.json"))["environment"].to_string())
}

/// MATLAB's `corr` with the shipped AMD kernels (`samsrf_core::css`'s order).
fn amd_correlation(x: &[f64], y: &[f64]) -> f64 {
    let centre = |v: &[f64]| { let m = blas::matlab_mean(v); v.iter().map(|t| t - m).collect::<Vec<_>>() };
    let (xc, yc) = (centre(x), centre(y));
    let norm = |v: &[f64]| samsrf_core::matlab_math::nrm2(v.iter().copied());
    let r = samsrf_core::matlab_math::ddot(&xc, &yc) / norm(&xc) / norm(&yc);
    if r.abs() > 1.0 { r / r.abs() } else { r }
}

struct DotLength {
    n: usize,
    pairs: Vec<(usize, usize)>,
    counts: Vec<f64>,
    x: Vec<f64>,
    y: Vec<f64>,
    dots: Vec<f64>,
}

fn dot_lengths(dir: &Path) -> Vec<DotLength> {
    let recording = json(&dir.join("arithmetic-order.json"));
    let mut lengths: Vec<DotLength> = recording["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "dot-order").map(|c| {
        let n = c["n"].as_u64().unwrap() as usize;
        let pairs = array(dir, &c["pairs"]);
        let p = pairs.len() / 2;
        DotLength {
            n,
            pairs: (0..p).map(|k| (pairs[k] as usize - 1, pairs[p + k] as usize - 1)).collect(),
            counts: array(dir, &c["counts"]),
            x: array(dir, &c["x"]),
            y: array(dir, &c["y"]),
            dots: array(dir, &c["dots"]),
        }
    }).collect();
    lengths.sort_by_key(|l| l.n);
    lengths
}

/// (fingerprint misses, draw misses) of a `x' * y` kernel at one length.
fn dot_misses(length: &DotLength, kernel: fn(&[f64], &[f64]) -> f64) -> (usize, usize) {
    let n = length.n;
    let big = 2f64.powi(60);
    let fingerprints = length.pairs.iter().zip(&length.counts).filter(|&(&(a, b), &count)| {
        let mut y = vec![1.0; n];
        y[a] = big;
        y[b] = -big;
        !same(kernel(&vec![1.0; n], &y), count)
    }).count();
    let draws = (0..50).filter(|&d| !same(kernel(&length.x[d * n..(d + 1) * n], &length.y[d * n..(d + 1) * n]), length.dots[d])).count();
    (fingerprints, draws)
}

/// MATLAB's `x' * y` at all 88 recorded lengths (2-80 every fingerprint pair, 96-1,000 300
/// sampled pairs; 50 draws each): the research kernel reproduces every value on the
/// AVX512_E1 host, the shipped `ddot` every value on the AMD host, and from 51 elements
/// each fails on the other host.
#[test]
fn dot_products_equal_matlab_on_each_host() {
    let Some(root) = env("SAMSRF_ARITHMETIC_ORDER_DIR") else { return };
    let (intel, amd) = arithmetic_order_hosts(&root);
    let (intel_lengths, amd_lengths) = (dot_lengths(&intel), dot_lengths(&amd));
    let expected: Vec<usize> = (2..=80).chain([96, 100, 127, 128, 129, 200, 250, 256, 1000]).collect();
    assert_eq!(intel_lengths.iter().map(|l| l.n).collect::<Vec<_>>(), expected, "Intel lengths");
    assert_eq!(amd_lengths.iter().map(|l| l.n).collect::<Vec<_>>(), expected, "AMD lengths");
    let (mut fingerprints, mut draws) = (0, 0);
    for (i, a) in intel_lengths.iter().zip(&amd_lengths) {
        assert_eq!(dot_misses(i, blas::ddot), (0, 0), "AVX512_E1 host, n = {}", i.n);
        assert_eq!(dot_misses(a, samsrf_core::matlab_math::ddot), (0, 0), "AMD host, n = {}", a.n);
        if i.n >= blas::DDOT_MKL_MIN_LENGTH {
            assert_ne!(dot_misses(i, samsrf_core::matlab_math::ddot), (0, 0), "the AMD kernel must fail on the Intel host, n = {}", i.n);
            assert_ne!(dot_misses(a, blas::ddot), (0, 0), "the Intel kernel must fail on the AMD host, n = {}", a.n);
        }
        fingerprints += i.pairs.len();
        draws += 50;
    }
    assert_eq!((fingerprints, draws), ((2..=80).map(|n| n * (n - 1) / 2).sum::<usize>() + 9 * 300, 88 * 50), "inventory");
}

/// MATLAB's double `y' * A` on the 9 recorded shapes (every column's fingerprints with
/// 2^70 probes, 100 draws): the research kernel reproduces every value on the AVX512_E1
/// host, `samsrf_core::lstsq::gemv_t_double` every value on the AMD host, and each fails
/// on the other host.
#[test]
fn matrix_vector_products_equal_matlab_on_each_host() {
    let Some(root) = env("SAMSRF_CGG_DIR") else { return };
    let (intel, amd) = hosts(["ubuntu-22.04", "ubuntu-24.04"].map(|h| root.join(h)).to_vec(), |dir| json(&dir.join("gemv.json"))["environment"].to_string());
    let shapes = [(250, 5), (250, 6), (250, 7), (250, 3), (250, 8), (61, 7), (128, 6), (97, 5), (17, 3)];
    let big = 2f64.powi(70);
    let misses = |dir: &Path, kernel: Gemv| -> usize {
        let cases = json(&dir.join("gemv.json"))["cases"].as_array().unwrap().clone();
        assert_eq!(cases.iter().map(|c| (c["n"].as_u64().unwrap() as usize, c["m"].as_u64().unwrap() as usize)).collect::<Vec<_>>(), shapes, "shapes");
        let mut misses = 0;
        for c in &cases {
            let (n, m) = (c["n"].as_u64().unwrap() as usize, c["m"].as_u64().unwrap() as usize);
            let pairs: Vec<(usize, usize)> = (0..n).flat_map(|i| (i + 1..n).map(move |k| (i, k))).collect();
            let recorded_pairs = array(dir, &c["pairs"]);
            assert!(pairs.iter().enumerate().all(|(p, &(i, k))| recorded_pairs[p] == (i + 1) as f64 && recorded_pairs[pairs.len() + p] == (k + 1) as f64), "{}: pair order", c["id"]);
            let counts = array(dir, &c["counts"]);
            let y = vec![1.0; n];
            for (p, &(i, k)) in pairs.iter().enumerate() {
                let mut a = vec![1.0; n];
                a[i] = big;
                a[k] = -big;
                let columns: Vec<&[f64]> = (0..m).map(|_| a.as_slice()).collect();
                for (j, v) in kernel(&y, &columns).into_iter().enumerate() {
                    misses += usize::from(!same(v, counts[j * pairs.len() + p]));
                }
            }
            let (ys, a_s, products) = (array(dir, &c["ys"]), array(dir, &c["As"]), array(dir, &c["products"]));
            for d in 0..100 {
                let columns: Vec<&[f64]> = (0..m).map(|j| &a_s[(d * m + j) * n..(d * m + j + 1) * n]).collect();
                for (j, v) in kernel(&ys[d * n..(d + 1) * n], &columns).into_iter().enumerate() {
                    misses += usize::from(!same(v, products[j * 100 + d]));
                }
            }
        }
        misses
    };
    assert_eq!(misses(&intel, &blas::gemv_t), 0, "AVX512_E1 host");
    assert_eq!(misses(&amd, &samsrf_core::lstsq::gemv_t_double), 0, "AMD host");
    assert!(misses(&intel, &samsrf_core::lstsq::gemv_t_double) > 0, "the AMD kernel must fail on the Intel host");
    assert!(misses(&amd, &blas::gemv_t) > 0, "the Intel kernel must fail on the AMD host");
}

fn decompose(value: f64) -> (u64, i64) {
    let bits = value.abs().to_bits();
    let (exponent, fraction) = ((bits >> 52) as i64, bits & ((1 << 52) - 1));
    if exponent == 0 { (fraction, -1074) } else { (fraction | (1 << 52), exponent - 1075) }
}

/// Whether the exact norm of `values` lies above the rounding midpoint just below
/// `rounded`, closer to it than `1 / denominator` ULP (integer arithmetic).
fn just_above_lower_midpoint(values: &[f64], rounded: f64, denominator: u64) -> bool {
    use num_bigint::BigUint;
    let mut n = BigUint::default();
    for &value in values.iter().filter(|v| **v != 0.0) {
        let (m, k) = decompose(value);
        n += (BigUint::from(m) * BigUint::from(m)) << ((2 * k + 2148) as usize);
    }
    let (m, u) = decompose(rounded);
    let k = BigUint::from(1u8) << ((2 * u - 2 + 2148) as usize);
    let odd = BigUint::from(2 * m - 1);
    let midpoint_squared = &odd * &odd * &k;
    n > midpoint_squared && (&n - &midpoint_squared) * BigUint::from(denominator) < BigUint::from(4u8) * odd * k
}

/// MATLAB's `corr` at all 60 recorded lengths (25-80, 96, 100, 128, 250; 20 pairs each):
/// the research kernels reproduce 1,198 of the 1,200 values on the AVX512_E1 host. The two
/// misses (n = 36 pair 6, n = 75 pair 16) are pinned: in each the exact norm of the centred
/// y lies less than 1e-3 ULP above a rounding midpoint, MATLAB's value equals the result
/// with that norm one ULP below the correctly rounded one, and the x norm is not near a tie.
/// MKL's rounding near ties is not identified. The shipped kernels give all 1,200 values on
/// the AMD host and differ on the Intel one.
#[test]
fn correlations_equal_matlab_except_two_near_tie_norms() {
    let Some(root) = env("SAMSRF_ARITHMETIC_ORDER_DIR") else { return };
    let (intel, amd) = arithmetic_order_hosts(&root);
    let cases = |dir: &Path| -> Vec<CorrCase> {
        let recording = json(&dir.join("arithmetic-order.json"));
        let mut cases: Vec<_> = recording["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "corr")
            .map(|c| (c["n"].as_u64().unwrap() as usize, array(dir, &c["x"]), array(dir, &c["y"]), array(dir, &c["r"])))
            .collect();
        cases.sort_by_key(|c| c.0);
        assert_eq!(cases.iter().map(|c| c.0).collect::<Vec<_>>(), (25..=80).chain([96, 100, 128, 250]).collect::<Vec<_>>(), "corr lengths");
        cases
    };
    let misses = |dir: &Path, kernel: fn(&[f64], &[f64]) -> f64| -> Vec<(usize, usize)> {
        let mut misses = Vec::new();
        for (n, x, y, r) in cases(dir) {
            for j in 0..20 {
                if !same(kernel(&x[j * n..(j + 1) * n], &y[j * n..(j + 1) * n]), r[j]) {
                    misses.push((n, j));
                }
            }
        }
        misses
    };
    let pinned = vec![(36, 6), (75, 16)];
    assert_eq!(misses(&intel, blas::correlation), pinned, "AVX512_E1 host");
    for (n, x, y, r) in cases(&intel).into_iter().filter(|c| pinned.iter().any(|p| p.0 == c.0)) {
        let j = pinned.iter().find(|p| p.0 == n).unwrap().1;
        let (x, y) = (&x[j * n..(j + 1) * n], &y[j * n..(j + 1) * n]);
        let centre = |v: &[f64]| { let m = blas::matlab_mean(v); v.iter().map(|t| t - m).collect::<Vec<_>>() };
        let (xc, yc) = (centre(x), centre(y));
        let ny = samsrf_mkl_avx512::nrm2(&yc);
        let lower = blas::ddot(&xc, &yc) / samsrf_mkl_avx512::nrm2(&xc) / ny.next_down();
        assert!(same(lower, r[j]), "n = {n} pair {j}: MATLAB needs the y norm one ULP lower");
        assert!(just_above_lower_midpoint(&yc, ny, 1000), "n = {n} pair {j}: the exact y norm is within 1e-3 ULP above a midpoint");
        assert!(!just_above_lower_midpoint(&xc, samsrf_mkl_avx512::nrm2(&xc), 1000), "n = {n} pair {j}: the x norm is not near a tie");
    }
    assert!(misses(&amd, amd_correlation).is_empty(), "AMD host, shipped kernels");
    assert!(misses(&intel, amd_correlation).len() > 100, "the shipped kernels must differ on the Intel host");
}

/// The double unsmoothed CF profiles of the reverse-correlation recording (`corr(y, X)` over
/// the recorded seed courses, every saved vertex): the research kernels reproduce every value
/// on the AVX512_E1 host (Xeon 8370C), the shipped kernels every value on the AMD host, and
/// each differs on the other host.
#[test]
fn cf_profiles_equal_matlab_on_each_host() {
    let Some(root) = env("SAMSRF_REVCOR_REFERENCE_DIR") else { return };
    let (intel, amd) = hosts(["ubuntu-22.04", "ubuntu-24.04"].map(|h| root.join(h)).to_vec(), |dir| {
        let environment = json(&dir.join("environment.json"));
        environment["observed"]["blas"].as_str().unwrap().to_string() + environment["cpu"].as_str().unwrap()
    });
    let amd_profile = |y: &[f64], seeds: &[&[f64]]| -> Vec<f64> {
        let centre = |v: &[f64]| { let m = blas::matlab_mean(v); v.iter().map(|t| t - m).collect::<Vec<_>>() };
        let norm = |v: &[f64]| samsrf_core::matlab_math::nrm2(v.iter().copied());
        let yc = centre(y);
        let centred: Vec<Vec<f64>> = seeds.iter().map(|s| centre(s)).collect();
        let columns: Vec<&[f64]> = centred.iter().map(Vec::as_slice).collect();
        samsrf_core::lstsq::gemv_t_double(&yc, &columns).into_iter().zip(&centred).map(|(p, s)| {
            let r = (p / norm(&yc)) / norm(s);
            if r.abs() > 1.0 { r / r.abs() } else { r }
        }).collect()
    };
    let compare = |dir: &Path, kernel: Gemv| -> (usize, usize) {
        let matrix = json(&dir.join("revcor-matrix.json"));
        let (mut compared, mut misses) = (0, 0);
        for c in matrix["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "pipeline" && c["analysis"] == "cf" && c["precision"] == "double" && c["mapReplayModel"]["Smoothing"] == 0) {
            let shape: Vec<usize> = c["seedCourses"]["shape"].as_array().unwrap().iter().map(|d| d.as_u64().unwrap() as usize).collect();
            let (volumes, nsvx) = (shape[0], shape[1]);
            let x = array(dir, &c["seedCourses"]);
            let seeds: Vec<&[f64]> = x.chunks(volumes).collect();
            let saved = array(dir, &c["savedVertices"]);
            let y = array(dir, &c["savedCourses"]);
            let profiles = array(dir, &c["profiles"]);
            assert_eq!(c["profiles"]["shape"][0].as_u64().unwrap() as usize, nsvx, "{}: profile rows", c["id"]);
            for (i, course) in y.chunks(volumes).enumerate() {
                let v = saved[i] as usize - 1;
                for (j, r) in kernel(course, &seeds).into_iter().enumerate() {
                    misses += usize::from(!same(r, profiles[v * nsvx + j]));
                    compared += 1;
                }
            }
        }
        (compared, misses)
    };
    assert_eq!(compare(&intel, &blas::cf_profile), (3402, 0), "AVX512_E1 host");
    assert_eq!(compare(&amd, &amd_profile), (3402, 0), "AMD host");
    assert!(compare(&intel, &amd_profile).1 > 0, "the shipped kernels must differ on the Intel host");
    assert!(compare(&amd, &blas::cf_profile).1 > 0, "the research kernels must differ on the AMD host");
}
