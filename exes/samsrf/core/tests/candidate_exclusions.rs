//! Candidate exclusions for MATLAB R2023b's single `sin`, `cos` and `exp`, and the
//! localisation of the sparse complex `conv` residual. Each test evaluates
//! reconstructed variants, written here from published constants and masks, and
//! counts where they differ from MATLAB. They reject candidates; they do not
//! identify MATLAB's implementation. No upstream code is executed or imported.
//!
//! Upstream revisions whose constants or masks are transcribed (freebsd/freebsd-src):
//! - `lib/msun/src/k_cosf.c` at 11cba99f6727d9f0c35de9c9b10ca53e11c893cd: x/4 & 0xfffffff8;
//! - `lib/msun/src/k_sinf.c` at 11dc241777bb051234271168d8e2b7c71837db51 and
//!   6e10a447f8aea9fe3d893c5da92f415c943fc50d: degree-9 minimax S1-S4;
//! - `lib/msun/src/e_expf.c` at 908801933a06250bf6e569c8df9e1e00e3403588: ln2HI 0x3f317200,
//!   ln2LO 0x35bfbe8e; at 47227ef0ef663b7abb81ab5a60a450da9a93d24b (5.0): 0x3f317180, 0x3717f7d1.
//!
//! Data (each pinned in `packages/samsrf/validation/matlab/`), one variable per test:
//! - `SAMSRF_SINGLE_TRIG_DIR` (`single-trig-reference.json`): MATLAB's sin and cos
//!   output for an input is the port's output except at the recorded exception
//!   inputs, where it is the recorded value. The trig test rebuilds MATLAB's output
//!   that way for every recorded input and requires each block's recorded SHA-256,
//!   so the reconstruction is checked, not assumed. It reads only the AMD EPYC 9V45
//!   host's first process; `single_trig.rs` requires the other three recordings to
//!   be identical. It takes minutes, so it is `#[ignore]`d:
//!   `SAMSRF_SINGLE_TRIG_DIR=... cargo test --release -p samsrf-core --test candidate_exclusions -- --ignored`.
//! - `SAMSRF_SINGLE_KERNELS_DIR` (`single-kernels-reference.json`): MATLAB's own
//!   `exp` outputs, on both hosts.
//! - `SAMSRF_MATLAB_NUMERICS2_DIR` (`numerics2-reference.json`): MATLAB's own `conv`
//!   outputs on the AMD host.
use num_complex::Complex64;
use samsrf_core::matlab_math as m;
use samsrf_core::precision::{cos_single, exp_single, sin_single};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn f(bits: u32) -> f32 {
    f32::from_bits(bits)
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || a.is_nan() && b.is_nan()
}

fn doubles(path: &Path) -> Vec<f64> {
    std::fs::read(path).unwrap().as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn count(value: &Value) -> u64 {
    let x = value.as_f64().expect("a number");
    assert!(x >= 0.0 && x.fract() == 0.0);
    x as u64
}

// ---- Reconstructed single sin and cos -------------------------------------------

/// The sine kernel's coefficients S1..S6 (fdlibm, as the port) or a minimax S1..S4.
#[derive(Clone, Copy)]
enum SineKernel {
    Fdlibm([f32; 6]),
    Minimax([f32; 4]),
}

const FDLIBM_S: [u32; 6] = [0xbe2a_aaab, 0x3c08_8889, 0xb950_0d01, 0x3638_ef1b, 0xb2d7_2f34, 0x2f2e_c9d3];
const FDLIBM_C: [u32; 6] = [0x3d2a_aaab, 0xbab6_0b61, 0x37d0_0d01, 0xb493_f27c, 0x310f_74f6, 0xad47_d74e];

/// A reconstructed variant: the port's structure (`precision::sin_single`), with the
/// x/4 mask of `__kernel_cosf` and the sine kernel as parameters. Range reduction is
/// the port's for |x| < 3 pi/4 and is shared by every variant.
#[derive(Clone, Copy)]
struct Trig {
    mask: u32,
    sine: SineKernel,
}

const FDLIBM_SINE: [f32; 6] = [
    f32::from_bits(FDLIBM_S[0]),
    f32::from_bits(FDLIBM_S[1]),
    f32::from_bits(FDLIBM_S[2]),
    f32::from_bits(FDLIBM_S[3]),
    f32::from_bits(FDLIBM_S[4]),
    f32::from_bits(FDLIBM_S[5]),
];
const PORT: Trig = Trig { mask: 0xffff_f000, sine: SineKernel::Fdlibm(FDLIBM_SINE) };

impl Trig {
    fn kernel_sin(&self, x: f32, y: f32, tail: bool) -> f32 {
        if x.to_bits() & 0x7fff_ffff < 0x3200_0000 {
            return x;
        }
        let z = x * x;
        let v = z * x;
        let (s1, r) = match self.sine {
            SineKernel::Fdlibm(s) => (s[0], s[1] + z * (s[2] + z * (s[3] + z * (s[4] + z * s[5])))),
            SineKernel::Minimax(s) => (s[0], s[1] + z * (s[2] + z * s[3])),
        };
        if tail {
            x - ((z * (0.5 * y - v * r) - y) - v * s1)
        } else {
            x + v * (s1 + z * r)
        }
    }

    fn kernel_cos(&self, x: f32, y: f32) -> f32 {
        let c = FDLIBM_C.map(f);
        let ix = x.to_bits() & 0x7fff_ffff;
        if ix < 0x3200_0000 {
            return 1.0;
        }
        let z = x * x;
        let r = z * (c[0] + z * (c[1] + z * (c[2] + z * (c[3] + z * (c[4] + z * c[5])))));
        if ix < 0x3e99_999a {
            return 1.0 - (0.5 * z - (z * r - x * y));
        }
        let quarter = if ix > 0x3f48_0000 { 0.28125 } else { f((ix - 0x0100_0000) & self.mask) };
        (1.0 - quarter) - ((0.5 * z - quarter) - (z * r - x * y))
    }

    /// `__ieee754_rem_pio2f` for pi/4 < |x| < 3 pi/4 (n = +-1).
    fn reduce(x: f32) -> (i32, f32, f32) {
        let ix = x.to_bits() & 0x7fff_ffff;
        let sign = if x < 0.0 { -1.0f32 } else { 1.0 };
        let mut z = x - sign * f(0x3fc9_0f80);
        let tail = if ix & 0xffff_fff0 == 0x3fc9_0fd0 {
            z -= sign * f(0x3735_4400);
            f(0x2e85_a308)
        } else {
            f(0x3735_4443)
        };
        let y0 = z - sign * tail;
        (sign as i32, y0, (z - y0) - sign * tail)
    }

    fn sin(&self, x: f32) -> f32 {
        if x.to_bits() & 0x7fff_ffff <= 0x3f49_0fd8 {
            return self.kernel_sin(x, 0.0, false);
        }
        let (n, y0, y1) = Self::reduce(x);
        if n == 1 { self.kernel_cos(y0, y1) } else { -self.kernel_cos(y0, y1) }
    }

    fn cos(&self, x: f32) -> f32 {
        if x.to_bits() & 0x7fff_ffff <= 0x3f49_0fd8 {
            return self.kernel_cos(x, 0.0);
        }
        let (n, y0, y1) = Self::reduce(x);
        if n == 1 { -self.kernel_sin(y0, y1, true) } else { self.kernel_sin(y0, y1, true) }
    }
}

/// End (exclusive) of the evaluated range: |x| < 3 pi/4, where reduction gives n = +-1.
const TRIG_END: u32 = 0x4016_cbe4;
/// The direct sine kernel's range for the sine-kernel candidates: 2^-12 <= |x| <= pi/4.
const SINE_RANGE: (u32, u32) = (0x3980_0000, 0x3f49_0fd8);

fn mask_variant(mask: u32) -> Trig {
    Trig { mask, ..PORT }
}

fn minimax(bits: [(u32, i32); 4]) -> Trig {
    let s = bits.map(|(mantissa, exponent)| (mantissa & 0x7fff_ffff) as f32 * 2f32.powi(exponent) * if mantissa >> 31 == 1 { -1.0 } else { 1.0 });
    Trig { sine: SineKernel::Minimax(s), ..PORT }
}

/// The candidates, each with its frozen (sin, cos) differences from MATLAB over
/// |x| < 3 pi/4; sine-kernel candidates count `sin` over `SINE_RANGE` only.
fn trig_candidates() -> Vec<(&'static str, Trig, bool, (u64, u64))> {
    // Each fdlibm coefficient rounded toward zero instead of to nearest.
    let truncated = [0xbe2a_aaaa, 0x3c08_8888, 0xb950_0d00, 0x3638_ef1a, 0xb2d7_2f34, 0x2f2e_c9d2].map(f);
    truncated_check(&truncated, &FDLIBM_S);
    vec![
        ("port: x/4 keeps 11 fraction bits (& 0xfffff000)", PORT, false, (12_610, 12_392)),
        ("x/4 keeps 20 bits (& 0xfffffff8), k_cosf.c 11cba99f", mask_variant(0xffff_fff8), false, (12_878, 12_630)),
        ("x/4 keeps 19 bits (& 0xfffffff0)", mask_variant(0xffff_fff0), false, (12_878, 12_630)),
        ("x/4 keeps 15 bits (& 0xffffff00)", mask_variant(0xffff_ff00), false, (12_862, 12_614)),
        ("x/4 keeps 12 bits (& 0xfffff800)", mask_variant(0xffff_f800), false, (12_738, 12_512)),
        ("x/4 keeps 10 bits (& 0xffffe000)", mask_variant(0xffff_e000), false, (12_842, 12_634)),
        ("x/4 keeps 7 bits (& 0xffff0000)", mask_variant(0xffff_0000), false, (15_902, 16_274)),
        ("minimax sine kernel, k_sinf.c 11dc2417", minimax([(0x80aa_aaab, -26), (0x0088_88ba, -30), (0x80d0_2cb0, -36), (0x00be_18ff, -42)]), true, (404_344, 0)),
        ("minimax sine kernel, k_sinf.c 6e10a447", minimax([(0x80aa_aaab, -26), (0x0088_88bb, -30), (0x80d0_2de1, -36), (0x00be_6dbe, -42)]), true, (405_880, 0)),
        ("fdlibm sine coefficients truncated toward zero", Trig { sine: SineKernel::Fdlibm(truncated), ..PORT }, true, (1_335_986, 0)),
    ]
}

/// The rounded coefficients are fdlibm's double ones to nearest; the truncated ones
/// are the largest singles not above them in magnitude.
// fdlibm k_sin.c's coefficients, digit for digit as published.
#[allow(clippy::excessive_precision)]
fn truncated_check(truncated: &[f32; 6], rounded: &[u32; 6]) {
    let doubles = [-1.66666666666666324348e-01, 8.33333333332248946124e-03, -1.98412698298579493134e-04, 2.75573137070700676789e-06, -2.50507602534068634195e-08, 1.58969099521155010221e-10f64];
    for ((t, r), d) in truncated.iter().zip(rounded).zip(doubles) {
        assert_eq!(f(*r), d as f32);
        assert!(f64::from(t.abs()) <= d.abs() && f64::from(f32::from_bits(t.to_bits() + 1).abs()) > d.abs());
    }
}

fn exception_table(dir: &Path, descriptor: &Value) -> HashMap<u32, u32> {
    let values = doubles(&dir.join(descriptor["file"].as_str().unwrap()));
    let rows = values.len() / 2;
    (0..rows).map(|i| (values[i] as u32, values[rows + i] as u32)).collect()
}

/// Rebuilds MATLAB's sin and cos on every recorded input from the port and the
/// exception tables, checks each block's digest, and counts each candidate's
/// differences from MATLAB in its range.
#[test]
#[ignore = "minutes; run with --ignored and SAMSRF_SINGLE_TRIG_DIR"]
fn trig_candidates_differ_from_matlab_as_recorded() {
    let root = PathBuf::from(std::env::var_os("SAMSRF_SINGLE_TRIG_DIR").expect("set SAMSRF_SINGLE_TRIG_DIR"));
    let dir = root.join("ubuntu-22.04").join("compatible");
    let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("numerics.json")).unwrap()).unwrap();
    let case = recording["cases"].as_array().unwrap().iter().find(|c| c["id"] == "single_trig").unwrap().clone();
    let sin_exceptions = exception_table(&dir, &case["sinExceptions"]);
    let cos_exceptions = exception_table(&dir, &case["cosExceptions"]);
    let blocks: Vec<(u32, u32, u32, String, String)> = case["blocks"].as_array().unwrap().iter().map(|b| {
        (if count(&b["sign"]) == 1 { 0x8000_0000 } else { 0 }, count(&b["first"]) as u32, count(&b["count"]) as u32, b["sin"].as_str().unwrap().to_string(), b["cos"].as_str().unwrap().to_string())
    }).collect();
    assert_eq!(blocks.len(), 136);
    let candidates = trig_candidates();
    let n = candidates.len();
    // Per candidate: (sin differs, cos differs); plus the port-vs-FreeBSD-mask comparison.
    let totals = std::sync::Mutex::new((vec![(0u64, 0u64); n], [0u64; 4], 0u64));
    let next = std::sync::atomic::AtomicUsize::new(0);
    let failures = std::sync::Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some((sign, first, length, sin_hex, cos_hex)) = blocks.get(i) else { break };
                let (mut sin_hash, mut cos_hash) = (Sha256::new(), Sha256::new());
                let mut local = vec![(0u64, 0u64); n];
                let mut freebsd = [0u64; 4];
                let mut evaluated = 0u64;
                for b in *first..*first + *length {
                    let bits = sign | b;
                    let x = f(bits);
                    let (port_sin, port_cos) = (sin_single(x).to_bits(), cos_single(x).to_bits());
                    let matlab_sin = sin_exceptions.get(&bits).copied().unwrap_or(port_sin);
                    let matlab_cos = cos_exceptions.get(&bits).copied().unwrap_or(port_cos);
                    sin_hash.update(matlab_sin.to_le_bytes());
                    cos_hash.update(matlab_cos.to_le_bytes());
                    if b >= TRIG_END {
                        continue;
                    }
                    evaluated += 1;
                    for (c, (_, trig, sine_only, _)) in candidates.iter().enumerate() {
                        if *sine_only {
                            if (SINE_RANGE.0..=SINE_RANGE.1).contains(&b) {
                                local[c].0 += u64::from(trig.sin(x).to_bits() != matlab_sin);
                            }
                            continue;
                        }
                        let (s, co) = (trig.sin(x).to_bits(), trig.cos(x).to_bits());
                        if c == 0 {
                            // The reconstructed port must be the production port.
                            assert!(s == port_sin && co == port_cos, "reconstruction differs from production at {bits:#x}");
                        }
                        if c == 1 {
                            // Inputs where FreeBSD's mask and the port's differ, and how many agree with MATLAB.
                            if s != port_sin {
                                freebsd[0] += 1;
                                freebsd[1] += u64::from(port_sin == matlab_sin);
                            }
                            if co != port_cos {
                                freebsd[2] += 1;
                                freebsd[3] += u64::from(port_cos == matlab_cos);
                            }
                        }
                        local[c].0 += u64::from(s != matlab_sin);
                        local[c].1 += u64::from(co != matlab_cos);
                    }
                }
                let hex = |d: Sha256| d.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
                if &hex(sin_hash) != sin_hex || &hex(cos_hash) != cos_hex {
                    failures.lock().unwrap().push(format!("block {sign:#x} {first:#x}"));
                }
                let mut totals = totals.lock().unwrap();
                for (t, l) in totals.0.iter_mut().zip(&local) {
                    t.0 += l.0;
                    t.1 += l.1;
                }
                for (t, l) in totals.1.iter_mut().zip(freebsd) {
                    *t += l;
                }
                totals.2 += evaluated;
            });
        }
    });
    let failures = failures.into_inner().unwrap();
    assert!(failures.is_empty(), "the reconstructed MATLAB output fails its recorded digest: {failures:?}");
    let (counts, freebsd, evaluated) = totals.into_inner().unwrap();
    assert_eq!(evaluated, 2 * u64::from(TRIG_END), "every input with |x| < 3 pi/4");
    for ((name, _, _, expected), actual) in candidates.iter().zip(&counts) {
        println!("{name}: sin {}, cos {}", actual.0, actual.1);
        assert_eq!(*actual, *expected, "{name}");
    }
    println!("FreeBSD's mask differs from the port on {} sin and {} cos inputs; MATLAB agrees with the port on {} and {}", freebsd[0], freebsd[2], freebsd[1], freebsd[3]);
    assert_eq!(freebsd, [268, 268, 238, 238]);
}

// ---- Reconstructed single exp -------------------------------------------------

/// `precision::exp_single` with the ln 2 split as a parameter (`lo` None: single(ln2 - hi)).
fn exp_variant(x: f32, hi_bits: u32, lo_bits: Option<u32>) -> f32 {
    let ln2_hi = f(hi_bits);
    let inv_ln2 = f(0x3fb8_aa3b);
    let p = [0x3e2a_aaab, 0xbb36_0b61, 0x388a_b355, 0xb5dd_ea0e, 0x3331_bb4c].map(f);
    let ln2_lo = lo_bits.map_or((std::f64::consts::LN_2 - f64::from(ln2_hi)) as f32, f);
    if x.is_nan() {
        return x;
    }
    if x > f(0x42b1_7217) {
        return f32::INFINITY;
    }
    if x < (-149.0 * std::f64::consts::LN_2) as f32 {
        return 0.0;
    }
    let magnitude = x.to_bits() & 0x7fff_ffff;
    let negative = x < 0.0;
    let (mut k, mut hi, mut lo, mut r) = (0i32, x, 0.0f32, x);
    if magnitude > 0x3eb1_7218 {
        k = if magnitude < 0x3f85_1592 { if negative { -1 } else { 1 } } else { (inv_ln2 * x + if negative { -0.5 } else { 0.5 }) as i32 };
        hi = x - k as f32 * ln2_hi;
        lo = k as f32 * ln2_lo;
        r = hi - lo;
    } else if magnitude < 0x3180_0000 {
        return 1.0 + x;
    }
    let t = r * r;
    let mut q = p[4];
    for &c in p[..4].iter().rev() {
        q = c + t * q;
    }
    let c = r - t * q;
    let rc = r * c;
    if k == 0 {
        return 1.0 - (rc / (c - 2.0) - r);
    }
    let y = 1.0 - ((lo - rc / (2.0 - c)) - hi);
    if k >= -125 {
        (f64::from(y) * 2f64.powi(k)) as f32
    } else {
        (f64::from(y) * 2f64.powi(k + 100) * 2f64.powi(-100)) as f32
    }
}

/// On MATLAB's own recorded `exp` outputs (both hosts): the reconstruction with the
/// port's split equals production everywhere, and FreeBSD's published splits differ
/// from MATLAB on more inputs than the port's.
#[test]
fn exp_ln2_splits_differ_from_matlab_as_recorded() {
    let Some(root) = std::env::var_os("SAMSRF_SINGLE_KERNELS_DIR").map(PathBuf::from) else { return };
    for host in ["amd-7763-auto", "intel-8573c-avx512"] {
        let dir = root.join(host);
        let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("kernels.json")).unwrap()).unwrap();
        let case = &recording["cases"][0];
        let input = doubles(&dir.join(case["input"]["file"].as_str().unwrap()));
        let whole = doubles(&dir.join(case["whole"]["file"].as_str().unwrap()));
        assert_eq!(input.len(), 711_307);
        for (&x, _) in input.iter().zip(&whole) {
            assert_eq!(exp_variant(x as f32, 0x3f31_7000, None).to_bits(), exp_single(x as f32).to_bits(), "reconstruction at {x}");
        }
        for (name, hi, lo, expected) in [
            ("port: hi 0x3f317000, lo single(ln2 - hi)", 0x3f31_7000u32, None, 18usize),
            ("e_expf.c 5.0: 0x3f317180, 0x3717f7d1", 0x3f31_7180, Some(0x3717_f7d1u32), 465),
            ("e_expf.c 90880193: 0x3f317200, 0x35bfbe8e", 0x3f31_7200, Some(0x35bf_be8e), 601),
        ] {
            let differing = input.iter().zip(&whole).filter(|(x, e)| exp_variant(**x as f32, hi, lo).to_bits() != (**e as f32).to_bits()).count();
            println!("{host}: {name}: {differing} of {} differ", input.len());
            assert_eq!(differing, expected, "{host} {name}");
        }
    }
}

// ---- Sparse complex conv near multiples of 512 --------------------------------

/// One output of the port's complex conv paths (`matlab_math::convolve_complex`):
/// the sparse sum over nonzero samples, or the dense two-lane, eight-block sum.
fn conv_output(signal: &[f64], taps: &[f64], nonzero: &[bool], k: usize, dense: bool, split: Option<usize>) -> f64 {
    let first = k + 1 - taps.len().min(k + 1);
    if let Some(s) = split {
        let (mut a, mut b) = (0.0f64, 0.0f64);
        for i in (first..=k).filter(|&i| nonzero[i]) {
            if i < s { a = signal[i].mul_add(taps[k - i], a) } else { b = signal[i].mul_add(taps[k - i], b) }
        }
        return a + b;
    }
    if !dense {
        return (first..=k).filter(|&i| nonzero[i]).fold(0.0, |s, i| signal[i].mul_add(taps[k - i], s));
    }
    let (lanes, block) = (2, 8);
    let length = signal.len();
    let vectored = if length.is_multiple_of(block) { length } else { length / block * block + length % block / (2 * lanes) * (2 * lanes) };
    let mut sum = 0.0f64;
    for start in (first / block * block..=k).step_by(block) {
        let low = start.max(first);
        let high = (start + block - 1).min(k);
        if low < vectored {
            let grouped = high.min(vectored - 1);
            for lane in 0..lanes {
                for j in (k - grouped..=k - low).filter(|j| j % lanes == lane) {
                    sum = signal[k - j].mul_add(taps[j], sum);
                }
            }
        }
        for i in low.max(vectored)..=high {
            sum = signal[i].mul_add(taps[k - i], sum);
        }
    }
    sum
}

/// The sparse complex courses longer than 800 samples on the AMD host. Output index
/// k is 0-based into `conv(y, kernel)` (MATLAB's index k + 1); only the first
/// numel(y) outputs are compared, as `matlab_numerics2.rs` does. For each part
/// (real or imaginary) that differs from MATLAB: whether the port's dense path or
/// a two-way split of the sparse sum at some index reproduces it.
#[test]
fn sparse_complex_conv_residual_lies_near_multiples_of_512() {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_NUMERICS2_DIR").map(PathBuf::from) else { return };
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let host = manifest["hosts"].as_object().unwrap().iter().find(|(_, v)| v["cpu"].as_str().unwrap().to_uppercase().starts_with("AMD EPYC")).unwrap().0.clone();
    let dir = root.join(&host).join("compatible");
    let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("numerics.json")).unwrap()).unwrap();
    let part = |d: &Value, key: &str| -> Vec<f64> {
        match d[key].as_str().filter(|s| !s.is_empty()) {
            Some(name) => doubles(&dir.join(name)),
            None => vec![],
        }
    };
    let (mut courses, mut outputs, mut parts, mut dense_only, mut neither, mut some_split, mut no_split) = (0, 0, 0, 0, 0, 0, 0);
    let (mut lowest, mut highest) = (i64::MAX, i64::MIN);
    for case in recording["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "conv" && c["isreal"] == false) {
        let (yr, yi) = (part(&case["y"], "file"), part(&case["y"], "imaginary"));
        let kernel = part(&case["kernel"], "file");
        let (er, ei) = (part(&case["result"], "file"), part(&case["result"], "imaginary"));
        let n = yr.len();
        let nonzero: Vec<bool> = (0..n).map(|i| yr[i] != 0.0 || yi[i] != 0.0).collect();
        if !(4 * nonzero.iter().filter(|v| **v).count() < n && n > 800) {
            continue;
        }
        courses += 1;
        assert_eq!(kernel.len(), 33);
        let y: Vec<Complex64> = yr.iter().zip(&yi).map(|(&re, &im)| Complex64::new(re, im)).collect();
        let production = m::convolve_complex(&y, &kernel, 1);
        for k in 0..n {
            // The reconstruction is the production port.
            assert!(same(production[k].re, conv_output(&yr, &kernel, &nonzero, k, false, None)) && same(production[k].im, conv_output(&yi, &kernel, &nonzero, k, false, None)), "reconstruction at k = {k}");
            let mut differs = false;
            for (signal, expected) in [(&yr, er[k]), (&yi, ei[k])] {
                if same(conv_output(signal, &kernel, &nonzero, k, false, None), expected) {
                    continue;
                }
                differs = true;
                parts += 1;
                if same(conv_output(signal, &kernel, &nonzero, k, true, None), expected) { dense_only += 1 } else { neither += 1 }
                let first = k + 1 - 33.min(k + 1);
                if (first..=k + 1).any(|s| same(conv_output(signal, &kernel, &nonzero, k, false, Some(s)), expected)) { some_split += 1 } else { no_split += 1 }
            }
            if differs {
                outputs += 1;
                let offset = k as i64 - (k as i64 + 256) / 512 * 512;
                lowest = lowest.min(offset);
                highest = highest.max(offset);
            }
        }
    }
    println!("{courses} courses: {outputs} outputs and {parts} parts differ, at offsets {lowest}..{highest} from the nearest multiple of 512; {dense_only} parts match the dense path, {neither} neither; {some_split} match some two-way split of the sparse sum, {no_split} none");
    assert_eq!((courses, outputs, parts), (10, 95, 111));
    assert_eq!((lowest, highest), (-15, 14));
    assert_eq!((dense_only, neither, some_split, no_split), (DENSE, NEITHER, SPLIT, NO_SPLIT));
}

// Parts that the port's dense path reproduces, that neither path does, and that
// some (or no) two-way split of the sparse sum reproduces.
const DENSE: usize = 26;
const NEITHER: usize = 85;
const SPLIT: usize = 84;
const NO_SPLIT: usize = 27;
