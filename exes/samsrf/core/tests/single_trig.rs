//! MATLAB R2023b's single `sin` and `cos` (`single-trig-reference.json`, section
//! `single-trig` of `record_numerics_probes.m`), which `samsrf_benson2srf` applies
//! to single polar angles. MATLAB evaluated every single x with |x| <= 2^7 pi/2,
//! hashed its output bits per 2^24 inputs, and listed every input where its output
//! differs from the candidate model with MATLAB's value. Two hosts each ran it in
//! two processes. The workflow supplies the recording; without it these return.
use samsrf_core::precision::{cos_single, sin_single};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The last input bits of the exhaustive range: 2^7 pi/2 in single.
const LAST: u32 = 0x4349_0f80;
/// Inputs in that range, both signs, where the port's sin and cos differ from
/// MATLAB's (run 43196169557). They may only fall.
const SIN_DIFFERING: usize = 36_350;
const COS_DIFFERING: usize = 32_406;

/// One recorded block: sign bit, first input bits, input count, sin and cos digests.
type Block = (u32, u32, u32, String, String);

struct Recording {
    host: String,
    blocks: Vec<Block>,
    sin: HashMap<u32, u32>,
    cos: HashMap<u32, u32>,
    case: Value,
    dir: PathBuf,
}

/// A count MATLAB's `jsonencode` may write as a float.
fn integer(value: &Value) -> u64 {
    let x = value.as_f64().expect("a number");
    assert!(x >= 0.0 && x.fract() == 0.0 && x < 2f64.powi(53), "{x} is not a count");
    x as u64
}

fn root() -> Option<PathBuf> {
    std::env::var_os("SAMSRF_SINGLE_TRIG_DIR").map(PathBuf::from)
}

fn words(dir: &Path, descriptor: &Value) -> Vec<u32> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name);
    assert_eq!(descriptor["class"], "uint32");
    let values: Vec<f64> = std::fs::read(dir.join(name)).unwrap().as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect();
    let expected: usize = descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).product();
    assert_eq!(values.len(), expected, "{name}");
    values.into_iter().map(|value| {
        assert!((0.0..=f64::from(u32::MAX)).contains(&value) && value.fract() == 0.0);
        value as u32
    }).collect()
}

/// Input bits to MATLAB's output bits, from an N x 2 exception table.
fn exceptions(dir: &Path, descriptor: &Value) -> HashMap<u32, u32> {
    let pairs = words(dir, descriptor);
    let rows = pairs.len() / 2;
    let map: HashMap<u32, u32> = (0..rows).map(|i| (pairs[i], pairs[rows + i])).collect();
    assert_eq!(map.len(), rows, "inputs repeat in the exception table");
    assert!(map.keys().all(|&bits| bits & 0x7fff_ffff <= LAST), "an exception lies outside the range");
    map
}

fn read(dir: &Path, host: &str) -> Recording {
    let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("numerics.json")).unwrap()).unwrap();
    let case = recording["cases"].as_array().unwrap().iter().find(|case| case["id"] == "single_trig").expect("the single_trig case").clone();
    assert_eq!(integer(&case["last"]), u64::from(LAST), "{host}: range");
    assert_eq!(integer(&case["counts"]["inputs"]), 2 * (u64::from(LAST) + 1), "{host}: inputs evaluated");
    let blocks: Vec<Block> = case["blocks"].as_array().unwrap().iter().map(|block| {
        let sign = if integer(&block["sign"]) == 1 { 0x8000_0000 } else { 0 };
        (sign, integer(&block["first"]) as u32, integer(&block["count"]) as u32, block["sin"].as_str().unwrap().to_string(), block["cos"].as_str().unwrap().to_string())
    }).collect();
    for sign in [0, 0x8000_0000] {
        let mut next = 0u64;
        for &(_, first, count, _, _) in blocks.iter().filter(|block| block.0 == sign) {
            assert_eq!(u64::from(first), next, "{host}: blocks must be contiguous");
            next += u64::from(count);
        }
        assert_eq!(next, u64::from(LAST) + 1, "{host}: blocks must end at the range's end");
    }
    let sin = exceptions(dir, &case["sinExceptions"]);
    let cos = exceptions(dir, &case["cosExceptions"]);
    assert_eq!(integer(&case["counts"]["sinCandidate"]), sin.len() as u64, "{host}: sin exception count");
    assert_eq!(integer(&case["counts"]["cosCandidate"]), cos.len() as u64, "{host}: cos exception count");
    Recording { host: host.to_string(), blocks, sin, cos, case, dir: dir.to_path_buf() }
}

/// Each host's first recording; every repeat must equal it, and the hosts each other.
fn recordings(root: &Path) -> Vec<Recording> {
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let hosts = manifest["hosts"].as_object().unwrap();
    assert_eq!(hosts.len(), 2, "two recorded hosts");
    let recordings: Vec<Recording> = hosts.iter().map(|(host, info)| {
        println!("{host}: {}", info["cpu"].as_str().unwrap());
        let first = read(&root.join(host).join("compatible"), host);
        let repeat = read(&root.join(host).join("repeat"), host);
        assert!(first.blocks == repeat.blocks && first.sin == repeat.sin && first.cos == repeat.cos, "{host}: a new MATLAB process must repeat the recording");
        first
    }).collect();
    assert!(recordings[0].blocks == recordings[1].blocks && recordings[0].sin == recordings[1].sin && recordings[0].cos == recordings[1].cos, "MATLAB's hosts must agree");
    recordings
}

/// SHA-256 of one block's outputs, with `matlab` replacing the port's value at the
/// listed inputs; also how many listed inputs the port gets wrong.
fn reconstructed(sign: u32, first: u32, count: u32, function: fn(f32) -> f32, matlab: &HashMap<u32, u32>) -> (String, usize) {
    let mut digest = Sha256::new();
    let mut buffer = Vec::with_capacity(1 << 20);
    let mut differing = 0;
    for bits in (first..first + count).map(|b| sign | b) {
        let port = function(f32::from_bits(bits)).to_bits();
        let value = match matlab.get(&bits) {
            Some(&value) => {
                differing += usize::from(value != port);
                value
            }
            None => port,
        };
        buffer.extend_from_slice(&value.to_le_bytes());
        if buffer.len() == 1 << 20 {
            digest.update(&buffer);
            buffer.clear();
        }
    }
    digest.update(&buffer);
    (digest.finalize().iter().map(|b| format!("{b:02x}")).collect(), differing)
}

/// Every single x with |x| <= 2^7 pi/2, both signs: the port's outputs, with MATLAB's
/// values at the recorded exception inputs, hash to MATLAB's digests in every block.
/// So the port equals MATLAB on every other input, and differs on at most the
/// frozen number of inputs (36,350 sin and 32,406 cos of 2,257,723,138).
#[test]
fn sin_and_cos_equal_matlab_outside_the_recorded_exceptions() {
    let Some(root) = root() else { return };
    let recordings = recordings(&root);
    let recording = &recordings[0];
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let next = std::sync::atomic::AtomicUsize::new(0);
    let failures = std::sync::Mutex::new(Vec::new());
    let differing = std::sync::Mutex::new((0, 0));
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some((sign, first, count, sin, cos)) = recording.blocks.get(i) else { break };
                let (sin_digest, sin_differing) = reconstructed(*sign, *first, *count, sin_single, &recording.sin);
                let (cos_digest, cos_differing) = reconstructed(*sign, *first, *count, cos_single, &recording.cos);
                if &sin_digest != sin || &cos_digest != cos {
                    failures.lock().unwrap().push(format!("block sign {sign:#x} first {first:#x}: sin {} cos {}", &sin_digest == sin, &cos_digest == cos));
                }
                let mut total = differing.lock().unwrap();
                total.0 += sin_differing;
                total.1 += cos_differing;
            });
        }
    });
    let failures = failures.into_inner().unwrap();
    assert!(failures.is_empty(), "{} of {} blocks differ from MATLAB outside the exceptions: {failures:?}", failures.len(), recording.blocks.len());
    let (sin, cos) = differing.into_inner().unwrap();
    println!("{} blocks: the port equals MATLAB on every input but {sin} (sin) and {cos} (cos)", recording.blocks.len());
    assert!(sin <= SIN_DIFFERING && cos <= COS_DIFFERING, "the port differs from MATLAB on more inputs than recorded: sin {sin}, cos {cos}");
    let benson = |map: &HashMap<u32, u32>, function: fn(f32) -> f32| {
        map.iter().filter(|(&bits, &value)| bits & 0x7fff_ffff <= std::f32::consts::FRAC_PI_2.to_bits() && function(f32::from_bits(bits)).to_bits() != value).count()
    };
    println!("|x| <= single(pi/2), the Benson range: sin differs on {} and cos on {} inputs", benson(&recording.sin, sin_single), benson(&recording.cos, cos_single));
}

/// Above 2^7 pi/2 fdlibm needs `__kernel_rem_pio2f`, which is not identified; the
/// port rounds the double result there. Specials must still match, and the share
/// of the random sample that matches is reported, not gated.
#[test]
fn outside_the_exhaustive_range_specials_match_and_the_sample_is_reported() {
    let Some(root) = root() else { return };
    for recording in recordings(&root) {
        let (host, dir, case) = (&recording.host, &recording.dir, &recording.case);
        let input = words(dir, &case["largeInput"]);
        let sin = words(dir, &case["largeSin"]);
        let cos = words(dir, &case["largeCos"]);
        let mut matched = (0, 0);
        for (i, &bits) in input.iter().enumerate() {
            let x = f32::from_bits(bits);
            let (s, c) = (sin_single(x), cos_single(x));
            if !x.is_finite() {
                assert!(s.is_nan() && f32::from_bits(sin[i]).is_nan() && c.is_nan() && f32::from_bits(cos[i]).is_nan(), "{host}: {bits:#x}");
                continue;
            }
            assert!(bits & 0x7fff_ffff > LAST, "{host}: {bits:#x} is inside the exhaustive range");
            matched.0 += usize::from(s.to_bits() == sin[i]);
            matched.1 += usize::from(c.to_bits() == cos[i]);
        }
        println!("{host}: |x| > 2^7 pi/2: sin matches {} and cos {} of {} sampled inputs", matched.0, matched.1, input.len() - 3);
    }
}
