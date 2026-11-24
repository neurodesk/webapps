//! Pre-registered and held-out recording gates for:
//! - #730: Intel MKL AVX512_E1 x87 80-bit `dnrm2` / `dznrm2` (168 real + 48 complex near-midpoint
//!   vectors + 8 extreme-scale vectors) and nonnegative-clipped CSS (`evals` + full `fminsearch`
//!   fits on both Intel Xeon 6975P-C and AMD EPYC 7763).
//! - #731: Intel MKL AVX512_E1 single-precision `sdot`, `sgemv_t`, `corr`, CF profile, and real &
//!   complex two-column QR on Xeon 6975P-C (`SAMSRF_INTEL_NORM_SINGLE_CSS_DIR`), held-out
//!   Xeon 8573C (`SAMSRF_SINGLE_KERNELS_DIR`), and held-out Xeon 8370C (`SAMSRF_QR_KERNELS_DIR` +
//!   `SAMSRF_QR_REFERENCE_DIR`).
//!
//! Each test returns when its recording variable is unset; paired variables fail closed if set
//! halfway.

use base64::Engine as _;
use num_complex::{Complex32 as C32, Complex64};
use samsrf_core::arithmetic::ArithmeticReference;
use samsrf_core::css;
use samsrf_core::expr::AnonymousFunction;
use samsrf_core::hrf::ErrfunHrf;
use samsrf_core::lstsq;
use samsrf_core::mat;
use samsrf_core::optim::{self, FminsearchOptions};
use samsrf_core::precision::{self, Precision};
use samsrf_core::prf;
use samsrf_mkl_avx512::{self as intel, single};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn fixture_pair(names: [&str; 2]) -> Option<[PathBuf; 2]> {
    match (env(names[0]), env(names[1])) {
        (None, None) => None,
        (Some(a), Some(b)) => Some([a, b]),
        _ => panic!("set both {} and {}", names[0], names[1]),
    }
}

fn json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn f64_file(path: &Path) -> Vec<f64> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(bytes.len() % 8, 0, "{}: f64 byte count", path.display());
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn f32_file(path: &Path) -> Vec<f32> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(bytes.len() % 4, 0, "{}: f32 byte count", path.display());
    bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect()
}

fn array_f64(root: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name, "bare file name");
    let values = f64_file(&root.join(name));
    if let Some(shape) = descriptor["shape"].as_array() {
        let count: u64 = shape.iter().map(|d| d.as_u64().unwrap()).product();
        assert_eq!(values.len() as u64, count, "{name}: shape");
    }
    values
}

fn array_f32_from_desc(root: &Path, descriptor: &Value) -> Vec<f32> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name, "bare file name");
    let values = if name.ends_with(".f32") {
        f32_file(&root.join(name))
    } else {
        f64_file(&root.join(name)).into_iter().map(|v| v as f32).collect()
    };
    if let Some(shape) = descriptor["shape"].as_array() {
        let count: u64 = shape.iter().map(|d| d.as_u64().unwrap()).product();
        assert_eq!(values.len() as u64, count, "{name}: shape");
    }
    values
}

fn complex_array_f64(root: &Path, descriptor: &Value) -> Vec<Complex64> {
    let re = array_f64(root, descriptor);
    let im = match descriptor["imaginary"].as_str().filter(|s| !s.is_empty()) {
        Some(name) => f64_file(&root.join(name)),
        None => vec![0.0; re.len()],
    };
    assert_eq!(re.len(), im.len(), "real and imaginary parts");
    re.into_iter().zip(im).map(|(re, im)| Complex64::new(re, im)).collect()
}

fn decode_b64_f64(text: &str) -> Vec<f64> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(text).unwrap();
    assert_eq!(bytes.len() % 8, 0, "base64 f64 byte count");
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

fn f64_sha256(values: &[f64]) -> String {
    let mut hasher = Sha256::new();
    for &value in values {
        hasher.update(value.to_le_bytes());
    }
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn hosts_in(root: &Path, probe_file: &str) -> (PathBuf, PathBuf) {
    let (mut intel_dir, mut amd_dir) = (None, None);
    for host in ["ubuntu-22.04", "ubuntu-24.04"] {
        let dir = root.join(host).join("compatible");
        let text = json(&dir.join(probe_file))["environment"].to_string();
        if text.contains("CNR branch AVX512_E1") {
            assert!(intel_dir.replace(dir).is_none(), "two AVX512_E1 hosts");
        } else if text.contains("CNR branch auto") && text.contains("AMD EPYC") {
            assert!(amd_dir.replace(dir).is_none(), "two AMD hosts");
        } else {
            panic!("{}: unexpected host environment", dir.display());
        }
    }
    (intel_dir.expect("an AVX512_E1 host"), amd_dir.expect("an AMD host"))
}

fn same_f64(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits()
}

fn same_f32(a: f32, b: f32) -> bool {
    a.to_bits() == b.to_bits()
}

fn same_c64(a: Complex64, b: Complex64) -> bool {
    same_f64(a.re, b.re) && same_f64(a.im, b.im)
}

#[test]
fn partial_fixture_pairs_are_rejected() {
    for names in [
        ["SAMSRF_INTEL_NORM_SINGLE_CSS_DIR", "SAMSRF_INTEL_NONNEGATIVE_CSS_INPUT_DIR"],
        ["SAMSRF_QR_KERNELS_DIR", "SAMSRF_QR_REFERENCE_DIR"],
    ] {
        let set: Vec<_> = names.iter().filter(|name| std::env::var_os(name).is_some()).collect();
        assert!(set.len() != 1, "set both {} and {}", names[0], names[1]);
    }
}

/// #730: Pre-registered blind Intel `dnrm2` / `dznrm2` probes (168 real near-midpoint,
/// 48 complex near-midpoint, 8 extreme-scale `2^+-600`, `2^+-1000`). Asserts 100% bit-exact
/// reproduction on Intel Xeon 6975P-C, exact match to the pre-registered frozen complex and
/// extreme SHA-256 digests, and cross-host divergence against AMD CNR auto.
#[test]
fn dnrm2_probes_equal_matlab_on_intel_avx512() {
    let Some(root) = env("SAMSRF_INTEL_NORM_SINGLE_CSS_DIR") else { return };
    let (intel_dir, amd_dir) = hosts_in(&root, "dnrm2-x87.json");
    let probes_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/samsrf/validation/matlab/intel-dnrm2-probes.json");
    let probes = json(&probes_path);
    let intel_rec = json(&intel_dir.join("dnrm2-x87.json"));
    let amd_rec = json(&amd_dir.join("dnrm2-x87.json"));

    // 1. 168 near-midpoint real vectors.
    let real_probes = probes["real"].as_array().unwrap();
    assert_eq!(real_probes.len(), 168);
    let intel_real = array_f64(&intel_dir, &intel_rec["real"]["norms"]);
    let amd_real = array_f64(&amd_dir, &amd_rec["real"]["norms"]);
    let mut intel_on_amd_misses = 0usize;
    let mut amd_on_intel_misses = 0usize;
    for (i, entry) in real_probes.iter().enumerate() {
        let vec = decode_b64_f64(entry["f64Base64"].as_str().unwrap());
        let got_intel = intel::nrm2(&vec);
        let got_amd = samsrf_core::matlab_math::nrm2(vec.iter().copied());
        assert!(same_f64(got_intel, intel_real[i]), "real probe {} ({}): got {got_intel:?} want {:?}", i, entry["id"], intel_real[i]);
        assert!(same_f64(got_amd, amd_real[i]), "AMD real probe {} ({})", i, entry["id"]);
        intel_on_amd_misses += usize::from(!same_f64(got_intel, amd_real[i]));
        amd_on_intel_misses += usize::from(!same_f64(got_amd, intel_real[i]));
    }
    assert!(intel_on_amd_misses > 20 && amd_on_intel_misses > 20, "real dnrm2 probes must separate Intel and AMD");

    // 2. 48 near-midpoint complex vectors + frozen pre-registered digest.
    let complex_probes = probes["complex"].as_array().unwrap();
    assert_eq!(complex_probes.len(), 48);
    let intel_complex = array_f64(&intel_dir, &intel_rec["complex"]["norms"]);
    let amd_complex = array_f64(&amd_dir, &amd_rec["complex"]["norms"]);
    let mut computed_complex = Vec::with_capacity(48);
    for (i, entry) in complex_probes.iter().enumerate() {
        let re = decode_b64_f64(entry["reBase64"].as_str().unwrap());
        let im = decode_b64_f64(entry["imBase64"].as_str().unwrap());
        let interleaved: Vec<f64> = re.into_iter().zip(im).flat_map(|(r, i)| [r, i]).collect();
        let got_intel = intel::nrm2(&interleaved);
        let got_amd = samsrf_core::matlab_math::nrm2(interleaved.iter().copied());
        assert!(same_f64(got_intel, intel_complex[i]), "complex probe {} ({})", i, entry["id"]);
        assert!(same_f64(got_amd, amd_complex[i]), "AMD complex probe {} ({})", i, entry["id"]);
        computed_complex.push(got_intel);
    }
    assert_eq!(
        f64_sha256(&computed_complex),
        "5db3763f4a43d39ee4c343a1754fafbaf36dee8580ccdfb6b0fbeb9bd283e85d",
        "complex dznrm2 must equal the pre-registered frozen x87-4lane-stride digest"
    );

    // 3. 8 extreme-scale vectors + frozen pre-registered digest.
    let extreme_probes = probes["extreme"].as_array().unwrap();
    assert_eq!(extreme_probes.len(), 8);
    let intel_extreme = array_f64(&intel_dir, &intel_rec["extreme"]["norms"]);
    let amd_extreme = array_f64(&amd_dir, &amd_rec["extreme"]["norms"]);
    let mut computed_extreme = Vec::with_capacity(8);
    for (i, entry) in extreme_probes.iter().enumerate() {
        let vec = decode_b64_f64(entry["f64Base64"].as_str().unwrap());
        let got_intel = intel::nrm2(&vec);
        let got_amd = samsrf_core::matlab_math::nrm2(vec.iter().copied());
        assert!(same_f64(got_intel, intel_extreme[i]), "extreme probe {} ({})", i, entry["id"]);
        assert!(same_f64(got_amd, amd_extreme[i]), "AMD extreme probe {} ({})", i, entry["id"]);
        computed_extreme.push(got_intel);
    }
    assert_eq!(
        f64_sha256(&computed_extreme),
        "20add51c7c785ccd30cd34dd3669dc856ba18a9dde288952afdc53609a5c01dc",
        "extreme-scale dnrm2 must equal the pre-registered frozen x87-4lane-stride digest"
    );
}

/// #731: Single-precision `sdot` (4,400 draws), `sgemv_t` (5,500 draws), `scorr` (140 pairs),
/// real two-column `sqr` (160 1-RHS + 1,280 8-RHS), and complex two-column `sqr` (160 1-RHS +
/// 1,280 8-RHS) on Intel Xeon 6975P-C vs AMD EPYC 7763.
#[test]
fn single_blas_and_qr_equal_matlab_on_each_host() {
    let Some(root) = env("SAMSRF_INTEL_NORM_SINGLE_CSS_DIR") else { return };
    let (intel_dir, amd_dir) = hosts_in(&root, "single-blas-qr.json");
    let intel_rec = json(&intel_dir.join("single-blas-qr.json"));
    let amd_rec = json(&amd_dir.join("single-blas-qr.json"));

    // 1. sdot: 88 lengths x 50 draws = 4,400.
    let intel_sdots = intel_rec["sdot"].as_array().unwrap();
    let amd_sdots = amd_rec["sdot"].as_array().unwrap();
    assert_eq!(intel_sdots.len(), 88);
    let mut sdot_checked = 0usize;
    let mut sdot_cross_diffs = 0usize;
    for (ic, ac) in intel_sdots.iter().zip(amd_sdots) {
        let n = ic["n"].as_u64().unwrap() as usize;
        let x = array_f32_from_desc(&intel_dir, &ic["x"]);
        let y = array_f32_from_desc(&intel_dir, &ic["y"]);
        let idots = array_f32_from_desc(&intel_dir, &ic["dots"]);
        let adots = array_f32_from_desc(&amd_dir, &ac["dots"]);
        for d in 0..50 {
            let (xs, ys) = (&x[d * n..(d + 1) * n], &y[d * n..(d + 1) * n]);
            let gi = single::sdot(xs, ys);
            assert!(same_f32(gi, idots[d]), "Intel sdot n={n} d={d}: got {gi:?} want {:?}", idots[d]);
            if n >= single::SDOT_MKL_MIN_LENGTH {
                let ga = ArithmeticReference::MatlabAmd.sdot(xs, ys);
                assert!(same_f32(ga, adots[d]), "AMD sdot n={n} d={d}");
                sdot_cross_diffs += usize::from(!same_f32(gi, adots[d]));
            }
            sdot_checked += 1;
        }
    }
    assert_eq!(sdot_checked, 4_400);
    assert!(sdot_cross_diffs > 500, "sdot must separate Intel and AMD from n >= 51");

    // 2. sgemv_t: 8 shapes (5,500 draws).
    let intel_sgemvs = intel_rec["sgemv"].as_array().unwrap();
    let amd_sgemvs = amd_rec["sgemv"].as_array().unwrap();
    assert_eq!(intel_sgemvs.len(), 8);
    let mut sgemv_checked = 0usize;
    let mut sgemv_cross_diffs = 0usize;
    let mut amd_on_intel_diffs = 0usize;
    for (ic, ac) in intel_sgemvs.iter().zip(amd_sgemvs) {
        let n = ic["n"].as_u64().unwrap() as usize;
        let m = ic["m"].as_u64().unwrap() as usize;
        let ys = array_f32_from_desc(&intel_dir, &ic["ys"]);
        let a_s = array_f32_from_desc(&intel_dir, &ic["As"]);
        let iprods = array_f32_from_desc(&intel_dir, &ic["products"]);
        let aprods = array_f32_from_desc(&amd_dir, &ac["products"]);
        for d in 0..100 {
            let y = &ys[d * n..(d + 1) * n];
            let cols: Vec<&[f32]> = (0..m).map(|j| &a_s[(d * m + j) * n..(d * m + j + 1) * n]).collect();
            let gi = single::gemv_t(y, &cols);
            let ga = precision::gemv_t_single(y, &cols);
            for j in 0..m {
                let idx = j * 100 + d;
                assert!(same_f32(gi[j], iprods[idx]), "Intel sgemv {} d={d} j={j}", ic["id"]);
                sgemv_cross_diffs += usize::from(!same_f32(gi[j], aprods[idx]));
                amd_on_intel_diffs += usize::from(!same_f32(ga[j], iprods[idx]));
                sgemv_checked += 1;
            }
        }
    }
    assert_eq!(sgemv_checked, 5_500);
    assert!(sgemv_cross_diffs > 1_000 && amd_on_intel_diffs > 1_000, "sgemv_t must separate Intel and AMD");

    // 3. scorr: 7 lengths x 20 pairs = 140.
    let intel_scorrs = intel_rec["scorr"].as_array().unwrap();
    let amd_scorrs = amd_rec["scorr"].as_array().unwrap();
    assert_eq!(intel_scorrs.len(), 7);
    let mut scorr_checked = 0usize;
    let mut scorr_cross_diffs = 0usize;
    for (ic, ac) in intel_scorrs.iter().zip(amd_scorrs) {
        let n = ic["n"].as_u64().unwrap() as usize;
        let xs = array_f32_from_desc(&intel_dir, &ic["x"]);
        let ys = array_f32_from_desc(&intel_dir, &ic["y"]);
        let ir = array_f32_from_desc(&intel_dir, &ic["r"]);
        let ar = array_f32_from_desc(&amd_dir, &ac["r"]);
        for j in 0..20 {
            let gi = single::correlation_single_pair(&xs[j * n..(j + 1) * n], &ys[j * n..(j + 1) * n]);
            assert!(same_f32(gi, ir[j]), "Intel scorr n={n} j={j}");
            scorr_cross_diffs += usize::from(!same_f32(gi, ar[j]));
            scorr_checked += 1;
        }
    }
    assert_eq!(scorr_checked, 140);
    assert!(scorr_cross_diffs > 20, "scorr must separate Intel and AMD");

    // 4. Blind two-column single QR (real and complex, 1-RHS and 8-RHS, via core mldivide_many_with_reference).
    let intel_sqrs = intel_rec["sqr"].as_array().unwrap();
    let amd_sqrs = amd_rec["sqr"].as_array().unwrap();
    assert_eq!(intel_sqrs.len(), 16);
    let mut qr1_checked = 0usize;
    let mut qr8_checked = 0usize;
    let mut qr_cross_diffs = 0usize;
    for (ic, ac) in intel_sqrs.iter().zip(amd_sqrs) {
        let m = ic["m"].as_u64().unwrap() as usize;
        let draws = ic["draws"].as_u64().unwrap() as usize;
        let ones_first = ic["order"].as_str().unwrap() == "ones-first";
        let xs = complex_array_f64(&intel_dir, &ic["x"]);
        let y1 = array_f64(&intel_dir, &ic["y1"]);
        let y8 = array_f64(&intel_dir, &ic["y8"]);
        let ib1 = complex_array_f64(&intel_dir, &ic["beta1"]);
        let ib8 = complex_array_f64(&intel_dir, &ic["beta8"]);
        let ab1 = complex_array_f64(&amd_dir, &ac["beta1"]);
        let ab8 = complex_array_f64(&amd_dir, &ac["beta8"]);
        let ones = vec![Complex64::new(1.0, 0.0); m];
        for d in 0..draws {
            let col_x = &xs[d * m..(d + 1) * m];
            let cols: [&[Complex64]; 2] = if ones_first { [&ones, col_x] } else { [col_x, &ones] };
            let sol_i1 = lstsq::mldivide_many_with_reference(&cols, &[&y1[d * m..(d + 1) * m]], Precision::Single, ArithmeticReference::MatlabIntel);
            let sol_a1 = lstsq::mldivide_many_with_reference(&cols, &[&y1[d * m..(d + 1) * m]], Precision::Single, ArithmeticReference::MatlabAmd);
            for k in 0..2 {
                assert!(same_c64(sol_i1.coefficients[0][k], ib1[d * 2 + k]), "Intel 1-RHS {} d={d} k={k}", ic["id"]);
                assert!(same_c64(sol_a1.coefficients[0][k], ab1[d * 2 + k]), "AMD 1-RHS {} d={d} k={k}", ac["id"]);
                qr_cross_diffs += usize::from(!same_c64(sol_i1.coefficients[0][k], ab1[d * 2 + k]));
            }
            qr1_checked += 1;

            let ys8: Vec<&[f64]> = (0..8).map(|r| &y8[(d * 8 + r) * m..(d * 8 + r + 1) * m]).collect();
            let sol_i8 = lstsq::mldivide_many_with_reference(&cols, &ys8, Precision::Single, ArithmeticReference::MatlabIntel);
            let sol_a8 = lstsq::mldivide_many_with_reference(&cols, &ys8, Precision::Single, ArithmeticReference::MatlabAmd);
            for r in 0..8 {
                for k in 0..2 {
                    let idx = (d * 8 + r) * 2 + k;
                    assert!(same_c64(sol_i8.coefficients[r][k], ib8[idx]), "Intel 8-RHS {} d={d} r={r} k={k}", ic["id"]);
                    assert!(same_c64(sol_a8.coefficients[r][k], ab8[idx]), "AMD 8-RHS {} d={d} r={r} k={k}", ac["id"]);
                    qr_cross_diffs += usize::from(!same_c64(sol_i8.coefficients[r][k], ab8[idx]));
                }
                qr8_checked += 1;
            }
        }
    }
    assert_eq!((qr1_checked, qr8_checked), (320, 2_560));
    assert!(qr_cross_diffs > 500, "single QR must separate Intel and AMD");
}

/// #730: Nonnegative-clipped CSS double evaluations (48 cases) and full Nelder-Mead fine fits
/// (12 cases) through `prf::errfun_with_reference` + `optim::fminsearch` + `lstsq` on both Intel
/// Xeon 6975P-C (`MatlabIntel`) and AMD EPYC 7763 (`MatlabAmd`).
#[test]
fn nonnegative_css_evals_and_fits_equal_matlab_on_each_host() {
    let Some([root, input]) = fixture_pair(["SAMSRF_INTEL_NORM_SINGLE_CSS_DIR", "SAMSRF_INTEL_NONNEGATIVE_CSS_INPUT_DIR"]) else { return };
    let (intel_dir, amd_dir) = hosts_in(&root, "nonnegative-css.json");
    let manifest = json(&input.join("manifest.json"));
    let dataset = manifest["datasets"].as_array().unwrap().iter().find(|d| d["id"] == "x001_lh").unwrap();
    let ap_bytes = std::fs::read(input.join(dataset["apertures"].as_str().unwrap())).unwrap();
    let apertures = mat::read_apertures(&ap_bytes).unwrap();
    let gaussian = AnonymousFunction::parse("@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)").unwrap();

    for (label, dir, reference) in [
        ("AVX512_E1", &intel_dir, ArithmeticReference::MatlabIntel),
        ("AMD auto", &amd_dir, ArithmeticReference::MatlabAmd),
    ] {
        let rec = json(&dir.join("nonnegative-css.json"));
        let radius = rec["radius"].as_f64().unwrap();
        let downsampling = rec["downsample"].as_u64().unwrap() as usize;
        let hrf = array_f64(dir, &rec["hrf"]);
        let courses = array_f64(dir, &rec["courses"]);
        let shape = rec["courses"]["shape"].as_array().unwrap();
        let volumes = shape[0].as_u64().unwrap() as usize;
        let xy = apertures.scaled_xy(radius);
        let hrf_spec = ErrfunHrf::Kernel(hrf.clone());

        // 48 evaluations.
        let evals = rec["evals"].as_array().unwrap();
        assert_eq!(evals.len(), 48);
        for case in evals {
            let v = case["vertex"].as_u64().unwrap() as usize - 1;
            let y = &courses[v * volumes..(v + 1) * volumes];
            let params: Vec<f64> = case["params"].as_array().unwrap().iter().map(|p| p.as_f64().unwrap()).collect();
            let obj = prf::errfun_with_reference(
                &gaussian, &apertures, &xy, &hrf_spec, &params, y, downsampling,
                true, Precision::Double, css::Convention::Nonnegative, reference,
            ).unwrap();
            let scalars = array_f64(dir, &case["scalars"]);
            assert!(same_f64(obj.re, scalars[1]), "{label} eval {} objective", case["id"]);
            assert_eq!(obj.im.to_bits(), 0, "{label} eval {} must stay real", case["id"]);

            // Recompute predicted and beta through the exact same path as fit_prf.rs.
            let pred = array_f64(dir, &case["predicted"]);
            let beta = array_f64(dir, &case["beta"]);
            let x_col: Vec<Complex64> = pred.iter().map(|&val| Complex64::new(val, 0.0)).collect();
            let (amp, base) = lstsq::regress_on_ones_with_reference(&x_col, y, Precision::Double, reference);
            assert!(same_f64(base.re, beta[0]) && same_f64(amp.re, beta[1]), "{label} eval {} beta", case["id"]);
        }

        // 12 full Nelder-Mead fine fits.
        let fits = rec["fits"].as_array().unwrap();
        assert_eq!(fits.len(), 12);
        for case in fits {
            let v = case["vertex"].as_u64().unwrap() as usize - 1;
            let y = &courses[v * volumes..(v + 1) * volumes];
            let seed: Vec<f64> = case["seed"].as_array().unwrap().iter().map(|p| p.as_f64().unwrap()).collect();
            let options = FminsearchOptions { tol_x: 1e-4, stop_when_not_finite: true, ..Default::default() };
            let res = optim::fminsearch(
                |p| {
                    prf::errfun_with_reference(
                        &gaussian, &apertures, &xy, &hrf_spec, p, y, downsampling,
                        true, Precision::Double, css::Convention::Nonnegative, reference,
                    )
                    .unwrap()
                    .re
                },
                &seed,
                &options,
            );
            let want_fitted = array_f64(dir, &case["fitted"]);
            let want_scalars = array_f64(dir, &case["scalars"]);
            let want_beta = array_f64(dir, &case["beta"]);
            for (k, (&got, &want)) in res.x.iter().zip(&want_fitted).enumerate() {
                assert!(same_f64(got, want), "{label} fit {} param[{k}]: got {got:?} want {want:?}", case["id"]);
            }
            assert!(same_f64(res.fval, want_scalars[0]), "{label} fit {} fval", case["id"]);
            assert!(same_f64(1.0 - res.fval, want_scalars[1]), "{label} fit {} 1 - fval", case["id"]);
            let got_flag = match res.exit_flag {
                optim::ExitFlag::Converged => 1i64,
                optim::ExitFlag::Limit => 0,
                optim::ExitFlag::Stopped => -1,
            };
            assert_eq!(got_flag, case["exitflag"].as_i64().unwrap(), "{label} fit {} exitflag", case["id"]);
            assert_eq!(res.func_count, case["funcCount"].as_u64().unwrap() as usize, "{label} fit {} funcCount", case["id"]);
            assert_eq!(res.iterations, case["iterations"].as_u64().unwrap() as usize, "{label} fit {} iterations", case["id"]);

            // Check fitted beta and rFit^2 via prf_gaussian_rf + compress + convolve + regress_on_ones_with_reference.
            let xy_val = samsrf_core::fit_prf::xy_value(&xy);
            let rfp = gaussian.evaluate(&[samsrf_core::expr::Value::column(res.x.clone()), xy_val]).unwrap();
            let mut raw = prf::predict_timecourse(&rfp.data, &apertures);
            for val in &mut raw {
                *val = if *val > 0.0 { samsrf_core::matlab_math::pow(*val, res.x[3]) } else { 0.0 };
            }
            let pred = samsrf_core::matlab_math::convolve_real(&raw, &hrf, downsampling);
            let pred_c: Vec<Complex64> = pred.iter().map(|&val| Complex64::new(val, 0.0)).collect();
            let (amp, base) = lstsq::regress_on_ones_with_reference(&pred_c, y, Precision::Double, reference);
            assert!(same_f64(base.re, want_beta[0]) && same_f64(amp.re, want_beta[1]), "{label} fit {} beta", case["id"]);
        }
    }
}

/// #731 held-out gate on Intel Xeon 8573C (`SAMSRF_SINGLE_KERNELS_DIR`): all 756 single CF
/// `product` (`sgemv_t`), `columnProducts` (`sdot`), and `corr` (`cf_profile_single`) entries
/// across x001_lh and x001_rh on both Intel Xeon 8573C and AMD EPYC 7763.
#[test]
fn held_out_single_kernels_equal_matlab_on_intel_xeon_8573c() {
    let Some(root) = env("SAMSRF_SINGLE_KERNELS_DIR") else { return };
    let intel_dir = root.join("intel-8573c-avx512");
    let amd_dir = root.join("amd-7763-auto");
    let intel_rec = json(&intel_dir.join("kernels.json"));
    let amd_rec = json(&amd_dir.join("kernels.json"));
    let mut checked = 0usize;
    let mut cross_diffs = 0usize;
    for (ic, ac) in intel_rec["cases"].as_array().unwrap().iter().zip(amd_rec["cases"].as_array().unwrap()) {
        if ic["kind"] != "corr" {
            continue;
        }
        let c_shape = ic["courses"]["shape"].as_array().unwrap();
        let s_shape = ic["seedCourses"]["shape"].as_array().unwrap();
        let (volumes, n_courses, n_seeds) = (
            c_shape[0].as_u64().unwrap() as usize,
            c_shape[1].as_u64().unwrap() as usize,
            s_shape[1].as_u64().unwrap() as usize,
        );
        let courses = array_f32_from_desc(&intel_dir, &ic["courses"]);
        let seeds_flat = array_f32_from_desc(&intel_dir, &ic["seedCourses"]);
        let i_prod = array_f32_from_desc(&intel_dir, &ic["product"]);
        let i_col = array_f32_from_desc(&intel_dir, &ic["columnProducts"]);
        let i_corr = array_f32_from_desc(&intel_dir, &ic["corr"]);
        let a_prod = array_f32_from_desc(&amd_dir, &ac["product"]);
        let a_col = array_f32_from_desc(&amd_dir, &ac["columnProducts"]);
        let a_corr = array_f32_from_desc(&amd_dir, &ac["corr"]);

        let centre = |v: &[f32]| -> Vec<f32> {
            let m = precision::sum_single(v) / v.len() as f32;
            v.iter().map(|&t| t - m).collect()
        };
        let seeds: Vec<&[f32]> = (0..n_seeds).map(|j| &seeds_flat[j * volumes..(j + 1) * volumes]).collect();
        let seeds_c: Vec<Vec<f32>> = seeds.iter().map(|s| centre(s)).collect();
        let seed_cols: Vec<&[f32]> = seeds_c.iter().map(Vec::as_slice).collect();

        for i in 0..n_courses {
            let y = &courses[i * volumes..(i + 1) * volumes];
            let yc = centre(y);
            let gi_prod = single::gemv_t(&yc, &seed_cols);
            let ga_prod = precision::gemv_t_single(&yc, &seed_cols);
            let gi_corr = single::cf_profile_single(y, &seeds);
            for j in 0..n_seeds {
                let idx = j * n_courses + i;
                assert!(same_f32(gi_prod[j], i_prod[idx]), "Intel {} product[{i},{j}]", ic["id"]);
                assert!(same_f32(ga_prod[j], a_prod[idx]), "AMD {} product[{i},{j}]", ac["id"]);
                let gi_dot = single::sdot(&yc, seed_cols[j]);
                let ga_dot = ArithmeticReference::MatlabAmd.sdot(&yc, seed_cols[j]);
                assert!(same_f32(gi_dot, i_col[idx]), "Intel {} colProd[{i},{j}]", ic["id"]);
                assert!(same_f32(ga_dot, a_col[idx]), "AMD {} colProd[{i},{j}]", ac["id"]);
                assert!(same_f32(gi_corr[j], i_corr[idx]), "Intel {} corr[{i},{j}]", ic["id"]);
                cross_diffs += usize::from(!same_f32(gi_corr[j], a_corr[idx]));
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 378);
    assert!(cross_diffs > 100, "single CF correlations must separate Intel and AMD");
}

/// #731 held-out gate on Intel Xeon 8370C (`SAMSRF_QR_KERNELS_DIR` + `SAMSRF_QR_REFERENCE_DIR`):
/// every single real (107 chains + 214 x 8 = 1,712 multi-RHS solves) and complex (67 chains +
/// 134 x 8 = 1,072 multi-RHS solves) step (pivot, packed factor, tau, Q'y / Q^H y, coefficients)
/// matches MKL bit-for-bit.
#[test]
fn held_out_single_qr_kernels_equal_matlab_on_intel_xeon_8370c() {
    let Some([kernels, designs_root]) = fixture_pair(["SAMSRF_QR_KERNELS_DIR", "SAMSRF_QR_REFERENCE_DIR"]) else { return };
    let designs_dir = designs_root.join("ubuntu-24.04").join("compatible");
    let designs = json(&designs_dir.join("qr.json"));
    let hosts = json(&kernels.join("hosts.json"));
    let intel_hosts: Vec<&String> = hosts
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, h)| h["cpu"].as_str().unwrap().contains("Intel"))
        .map(|(name, _)| name)
        .collect();
    assert_eq!(intel_hosts.len(), 1, "one Intel kernel host");
    let root = kernels.join(intel_hosts[0]);
    let metadata = json(&root.join("kernels.json"));
    assert!(metadata["environment"]["blas"].as_str().unwrap().contains("CNR branch AVX512_E1"));

    let mut real_chains = 0usize;
    let mut complex_chains = 0usize;
    let mut real_multi = 0usize;
    let mut complex_multi = 0usize;
    let mut cross_diffs = 0usize;

    let design_map: std::collections::HashMap<String, &Value> = designs["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["id"].as_str().unwrap().to_string(), c))
        .collect();

    let columns_of = |d: &Value, order: &str| -> (Vec<Complex64>, Vec<Complex64>) {
        let x = complex_array_f64(&designs_dir, &d["x"]);
        let ones = vec![Complex64::new(1.0, 0.0); x.len()];
        if order == "ones-first" { (ones, x) } else { (x, ones) }
    };

    for case in metadata["cases"].as_array().unwrap() {
        if case["precision"] != "single" {
            continue;
        }
        let id = case["id"].as_str().unwrap();
        let d = design_map[id];
        let (col0, col1) = columns_of(d, d["order"].as_str().unwrap());
        let y_f64 = array_f64(&designs_dir, &d["y"]);
        let is_complex = col0.iter().chain(&col1).any(|z| (z.im as f32) != 0.0);
        let variant = if is_complex { "complex" } else { "real" };
        let chain = case["chains"].as_array().unwrap().iter().find(|c| c["variant"] == variant).unwrap();
        let want_pivot: Vec<usize> = array_f64(&root, &chain["pivot"]).iter().map(|&p| p as usize - 1).collect();
        let want_factor = complex_array_f64(&root, &chain["factor"]);
        let want_tau = complex_array_f64(&root, &chain["tau"]);
        let want_qty = complex_array_f64(&root, &chain["qty"]);
        let want_beta = complex_array_f64(&root, &chain["beta"]);

        let amd_sol = lstsq::mldivide(&[&col0, &col1], &y_f64, Precision::Single);
        if is_complex {
            let c0: Vec<C32> = col0.iter().map(|z| C32::new(z.re as f32, z.im as f32)).collect();
            let c1: Vec<C32> = col1.iter().map(|z| C32::new(z.re as f32, z.im as f32)).collect();
            let yf: Vec<f32> = y_f64.iter().map(|&v| v as f32).collect();
            let design = single::ComplexDesign::new(&[&c0, &c1]);
            assert_eq!(design.pivot, want_pivot, "{id}: pivot");
            let packed_flat: Vec<Complex64> = design.packed.iter().flatten().map(|z| Complex64::new(f64::from(z.re), f64::from(z.im))).collect();
            for (k, (&g, &w)) in packed_flat.iter().zip(&want_factor).enumerate() {
                assert!(same_c64(g, w), "{id}: factor[{k}]");
            }
            for (k, (&g, &w)) in design.tau.iter().zip(&want_tau).enumerate() {
                assert!(same_c64(Complex64::new(f64::from(g.re), f64::from(g.im)), w), "{id}: tau[{k}]");
            }
            let (coeff, qty) = design.solve(&yf, 1, 0);
            for (k, (&g, &w)) in qty.iter().zip(&want_qty).enumerate() {
                assert!(same_c64(g, w), "{id}: qty[{k}]");
            }
            for (k, (&g, &w)) in coeff.iter().zip(&want_beta).enumerate() {
                assert!(same_c64(g, w), "{id}: beta[{k}]");
                cross_diffs += usize::from(!same_c64(amd_sol.coefficients[k], w));
            }
            complex_chains += 1;
        } else {
            let c0: Vec<f32> = col0.iter().map(|z| z.re as f32).collect();
            let c1: Vec<f32> = col1.iter().map(|z| z.re as f32).collect();
            let yf: Vec<f32> = y_f64.iter().map(|&v| v as f32).collect();
            let design = single::RealDesign::new(&[&c0, &c1]);
            assert_eq!(design.pivot(), want_pivot.as_slice(), "{id}: pivot");
            let packed_flat: Vec<f32> = design.packed().iter().flatten().copied().collect();
            for (k, (&g, &w)) in packed_flat.iter().zip(&want_factor).enumerate() {
                assert!(same_f64(f64::from(g), w.re), "{id}: factor[{k}]");
            }
            for (k, (&g, &w)) in design.taus().iter().zip(&want_tau).enumerate() {
                assert!(same_f64(f64::from(g), w.re), "{id}: tau[{k}]");
            }
            let (coeff, qty) = design.solve_with_qty(&yf, 1, 0);
            for (k, (&g, &w)) in qty.iter().zip(&want_qty).enumerate() {
                assert!(same_f64(f64::from(g), w.re), "{id}: qty[{k}]");
            }
            for (k, (&g, &w)) in coeff.iter().zip(&want_beta).enumerate() {
                assert!(same_f64(f64::from(g), w.re), "{id}: beta[{k}]");
                cross_diffs += usize::from(!same_f64(amd_sol.coefficients[k].re, w.re));
            }
            real_chains += 1;
        }
    }

    for item in metadata["multiple"].as_array().unwrap() {
        if item["precision"] != "single" {
            continue;
        }
        let id = item["id"].as_str().unwrap();
        let d = design_map[item["design"].as_str().unwrap()];
        let (col0, col1) = columns_of(d, item["order"].as_str().unwrap());
        let is_complex = item["complex"].as_bool().unwrap() || col0.iter().chain(&col1).any(|z| (z.im as f32) != 0.0);
        let ys_flat = array_f64(&root, &item["rhs"]);
        let shape = item["rhs"]["shape"].as_array().unwrap();
        let (m, count) = (shape[0].as_u64().unwrap() as usize, shape[1].as_u64().unwrap() as usize);
        let want_qty = complex_array_f64(&root, &item["qty"]);
        let want_coeff = complex_array_f64(&root, &item["together"]);
        let stored_real = item["together"]["imaginary"].as_str().is_none_or(str::is_empty);

        if is_complex {
            let c0: Vec<C32> = col0.iter().map(|z| C32::new(z.re as f32, z.im as f32)).collect();
            let c1: Vec<C32> = col1.iter().map(|z| C32::new(z.re as f32, z.im as f32)).collect();
            let design = single::ComplexDesign::new(&[&c0, &c1]);
            for j in 0..count {
                let yf: Vec<f32> = ys_flat[j * m..(j + 1) * m].iter().map(|&v| v as f32).collect();
                let (coeff, qty) = design.solve(&yf, count, j);
                for r in 0..m {
                    assert!(same_c64(qty[r], want_qty[j * m + r]), "{id}: multi qty[{j},{r}]");
                }
                for k in 0..2 {
                    let expected = want_coeff[j * 2 + k];
                    if stored_real {
                        assert!(same_f64(coeff[k].re, expected.re) && coeff[k].im == 0.0, "{id}: multi coeff[{j},{k}]");
                    } else {
                        assert!(same_c64(coeff[k], expected), "{id}: multi coeff[{j},{k}]");
                    }
                }
                complex_multi += 1;
            }
        } else {
            let c0: Vec<f32> = col0.iter().map(|z| z.re as f32).collect();
            let c1: Vec<f32> = col1.iter().map(|z| z.re as f32).collect();
            let design = single::RealDesign::new(&[&c0, &c1]);
            for j in 0..count {
                let yf: Vec<f32> = ys_flat[j * m..(j + 1) * m].iter().map(|&v| v as f32).collect();
                let (coeff, qty) = design.solve_with_qty(&yf, count, j);
                for r in 0..m {
                    assert!(same_f64(f64::from(qty[r]), want_qty[j * m + r].re), "{id}: multi qty[{j},{r}]");
                }
                for k in 0..2 {
                    assert!(same_f64(f64::from(coeff[k]), want_coeff[j * 2 + k].re), "{id}: multi coeff[{j},{k}]");
                }
                real_multi += 1;
            }
        }
    }

    assert_eq!((real_chains, complex_chains), (107, 67));
    assert_eq!((real_multi, complex_multi), (1_712, 1_072));
    assert!(cross_diffs > 50, "AMD single QR must differ from Intel Xeon 8370C");
}
