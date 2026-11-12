//! MATLAB R2023b's single `sin` and `cos` (`single-trig-reference.json`, section
//! `single-trig` of `record_numerics_probes.m`), which `samsrf_benson2srf` applies
//! to single polar angles. MATLAB evaluated every single x with |x| <= 2^7 pi/2 and
//! recorded a SHA-256 of its output bits per 2^24 inputs; the port must give the
//! same digests on both hosts. The workflow supplies the recording; without it
//! this returns.
use samsrf_core::precision::{cos_single, sin_single};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn root() -> Option<PathBuf> {
    std::env::var_os("SAMSRF_SINGLE_TRIG_DIR").map(PathBuf::from)
}

/// The recording of each host named in the manifest (AMD and Intel CPUs).
fn recordings(root: &Path) -> Vec<(String, PathBuf, Value)> {
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let hosts = manifest["hosts"].as_object().unwrap();
    let cpus: Vec<String> = hosts.values().map(|host| host["cpu"].as_str().unwrap().to_uppercase()).collect();
    assert!(cpus.iter().any(|cpu| cpu.starts_with("AMD EPYC")) && cpus.iter().any(|cpu| cpu.starts_with("INTEL(R) XEON")), "both CPU vendors: {cpus:?}");
    hosts.keys().map(|host| {
        let dir = root.join(host).join("compatible");
        let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("numerics.json")).unwrap()).unwrap();
        let case = recording["cases"].as_array().unwrap().iter().find(|case| case["id"] == "single_trig").expect("the single_trig case").clone();
        (host.clone(), dir, case)
    }).collect()
}

fn words(dir: &Path, descriptor: &Value) -> Vec<u32> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name);
    assert_eq!(descriptor["class"], "uint32");
    let values: Vec<f64> = std::fs::read(dir.join(name)).unwrap().as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect();
    let expected: usize = descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).product();
    assert_eq!(values.len(), expected, "{name}");
    values.into_iter().map(|value| {
        assert!(value >= 0.0 && value <= f64::from(u32::MAX) && value.fract() == 0.0);
        value as u32
    }).collect()
}

/// The port's digests of one block: inputs `sign | first .. sign | first + count`.
fn block_digests(sign: u32, first: u32, count: u32) -> (String, String) {
    let (mut sin, mut cos) = (Sha256::new(), Sha256::new());
    let mut buffer_sin = Vec::with_capacity(1 << 20);
    let mut buffer_cos = Vec::with_capacity(1 << 20);
    for bits in (first..first + count).map(|b| sign | b) {
        let x = f32::from_bits(bits);
        buffer_sin.extend_from_slice(&sin_single(x).to_le_bytes());
        buffer_cos.extend_from_slice(&cos_single(x).to_le_bytes());
        if buffer_sin.len() == 1 << 20 {
            sin.update(&buffer_sin);
            cos.update(&buffer_cos);
            buffer_sin.clear();
            buffer_cos.clear();
        }
    }
    sin.update(&buffer_sin);
    cos.update(&buffer_cos);
    let hex = |digest: Sha256| digest.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    (hex(sin), hex(cos))
}

/// Every single x with |x| <= 2^7 pi/2, both signs and both hosts: the port's
/// outputs hash to MATLAB's, block by block. The blocks must tile the range.
#[test]
fn sin_and_cos_equal_matlab_on_every_single_up_to_2_pow_7_pi_over_2() {
    let Some(root) = root() else { return };
    let recordings = recordings(&root);
    let last = 0x4349_0f80u32;
    let mut reference: Option<Vec<(u32, u32, u32, String, String)>> = None;
    for (host, _, case) in &recordings {
        assert_eq!(case["last"].as_u64(), Some(u64::from(last)), "{host}: range");
        let blocks: Vec<(u32, u32, u32, String, String)> = case["blocks"].as_array().unwrap().iter().map(|block| {
            let sign = if block["sign"].as_u64().unwrap() == 1 { 0x8000_0000 } else { 0 };
            (sign, block["first"].as_u64().unwrap() as u32, block["count"].as_u64().unwrap() as u32, block["sin"].as_str().unwrap().to_string(), block["cos"].as_str().unwrap().to_string())
        }).collect();
        for sign in [0, 0x8000_0000] {
            let mut next = 0u64;
            for &(_, first, count, _, _) in blocks.iter().filter(|block| block.0 == sign) {
                assert_eq!(u64::from(first), next, "{host}: blocks must be contiguous");
                next += u64::from(count);
            }
            assert_eq!(next, u64::from(last) + 1, "{host}: blocks must end at the range's end");
        }
        assert_eq!(case["counts"]["inputs"].as_u64(), Some(2 * (u64::from(last) + 1)), "{host}: inputs evaluated");
        match &reference {
            None => reference = Some(blocks),
            Some(first_host) => assert_eq!(first_host, &blocks, "{host}: MATLAB's hosts must agree"),
        }
    }
    let blocks = reference.unwrap();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let next = std::sync::atomic::AtomicUsize::new(0);
    let failures = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some((sign, first, count, sin, cos)) = blocks.get(i) else { break };
                let (port_sin, port_cos) = block_digests(*sign, *first, *count);
                if &port_sin != sin || &port_cos != cos {
                    failures.lock().unwrap().push(format!("block sign {sign:#x} first {first:#x}: sin {} cos {}", &port_sin == sin, &port_cos == cos));
                }
            });
        }
    });
    let failures = failures.into_inner().unwrap();
    assert!(failures.is_empty(), "{} of {} blocks differ: {failures:?}", failures.len(), blocks.len());
    println!("{} blocks, {} inputs per function: every digest equals MATLAB's", blocks.len(), 2 * (u64::from(last) + 1));
}

/// Where MATLAB differs from its own transcription of the candidate, the port must
/// still give MATLAB's value (the digests already require it; this names the inputs).
#[test]
fn recorded_candidate_exceptions_hold_matlabs_values() {
    let Some(root) = root() else { return };
    for (host, dir, case) in recordings(&root) {
        for (name, function) in [("sinExceptions", sin_single as fn(f32) -> f32), ("cosExceptions", cos_single)] {
            let pairs = words(&dir, &case[name]);
            let rows = pairs.len() / 2;
            let differing = (0..rows).filter(|&i| function(f32::from_bits(pairs[i])).to_bits() != pairs[rows + i]).count();
            println!("{host}: {name}: {rows} inputs where MATLAB's transcription differs from MATLAB, {differing} where the port does");
            assert_eq!(differing, 0, "{host}: {name}");
        }
    }
}

/// Above 2^7 pi/2 fdlibm needs `__kernel_rem_pio2f`, which is not identified; the
/// port rounds the double result there. Specials must still match, and the share
/// of the random sample that matches is reported, not gated.
#[test]
fn outside_the_identified_range_specials_match_and_the_sample_is_reported() {
    let Some(root) = root() else { return };
    for (host, dir, case) in recordings(&root) {
        let input = words(&dir, &case["largeInput"]);
        let sin = words(&dir, &case["largeSin"]);
        let cos = words(&dir, &case["largeCos"]);
        let mut matched = (0, 0);
        for (i, &bits) in input.iter().enumerate() {
            let x = f32::from_bits(bits);
            let (s, c) = (sin_single(x), cos_single(x));
            if !x.is_finite() {
                assert!(s.is_nan() && f32::from_bits(sin[i]).is_nan() && c.is_nan() && f32::from_bits(cos[i]).is_nan(), "{host}: {bits:#x}");
                continue;
            }
            matched.0 += usize::from(s.to_bits() == sin[i]);
            matched.1 += usize::from(c.to_bits() == cos[i]);
        }
        println!("{host}: |x| > 2^7 pi/2: sin matches {} and cos {} of {} sampled inputs", matched.0, matched.1, input.len() - 3);
    }
}
