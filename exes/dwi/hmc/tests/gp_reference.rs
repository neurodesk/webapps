//! The GP DWI model against NiFreeze 3bcfb00's GP run on ds005577 sub-107 (the M0 reference,
//! `hmc/reference/` of the Hugging Face dataset). Data-gated: set `HMC_REFERENCE` to the
//! folder; without it the test passes and does nothing, unless `HMC_REQUIRE_REFERENCE` is set
//! (as in CI): then missing data is a failure. Run it in a release build, alone:
//!
//! ```sh
//! HMC_REFERENCE=/path/to/hmc/reference \
//!   cargo test --release -p dwi-hmc --test gp_reference -- --nocapture
//! ```
//!
//! `HMC_REFERENCE_VOLUMES=0,7,89` limits the run to some volumes (DWI indices, 0-89).
//!
//! It checks:
//! - `bzero`: the median of the 11 b0 volumes, bit for bit against `nifreeze-gp/bzero.nii.gz`.
//! - The data mask: 161668 voxels, equal to `nifreeze-gp/work/brainmask.nii.gz`, the mask that
//!   NiFreeze gave to the registrations.
//! - Each fit: a and lambda end on their lower bounds (the two ConvergenceWarnings of each fit
//!   in `nifreeze-gp/nifreeze.log`); volume 7, the dry-run volume, prints as
//!   `SphericalKriging (a=0.10000000000000002, λ=0.0010000000000000002) +
//!   WhiteKernel(noise_level=0.999)` (`compare/gp-dryrun-fit.log`).
//! - Each clipped prediction against `nifreeze-gp/work/predicted_NNNNN.nii.gz`: at least
//!   99.99 % of the data-mask voxels equal, and no voxel more than 1 from the reference.

use dwi_gradients::B0Rule;
use dwi_hmc::gp_model::{DwiSeries, GpModel, clip_prediction, read_gradients};
use flate2::read::GzDecoder;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

const MASK_VOXELS: usize = 161_668;
const DWI_VOLUMES: usize = 90;
const DRY_RUN_VOLUME: usize = 7;

/// A NIfTI-1 image: the grid, the data type code and the raw little-endian values.
struct Nifti {
    dim: Vec<usize>,
    datatype: i16,
    bytes: Vec<u8>,
}

fn read_nifti(path: &Path) -> Nifti {
    let mut raw = Vec::new();
    GzDecoder::new(std::fs::File::open(path).unwrap_or_else(|e| panic!("{path:?}: {e}")))
        .read_to_end(&mut raw)
        .unwrap();
    let i16_at = |o: usize| i16::from_le_bytes([raw[o], raw[o + 1]]);
    let f32_at = |o: usize| f32::from_le_bytes(raw[o..o + 4].try_into().unwrap());
    assert_eq!(
        i32::from_le_bytes(raw[0..4].try_into().unwrap()),
        348,
        "{path:?}: not a little-endian NIfTI-1 file"
    );
    let ndim = i16_at(40) as usize;
    let dim: Vec<usize> = (1..=ndim).map(|k| i16_at(40 + 2 * k) as usize).collect();
    let datatype = i16_at(70);
    let slope = f32_at(112);
    assert!(
        slope.is_nan() || slope == 0.0 || (slope == 1.0 && f32_at(116) == 0.0),
        "{path:?}: scaled data"
    );
    let offset = f32_at(108) as usize;
    Nifti {
        dim,
        datatype,
        bytes: raw[offset..].to_vec(),
    }
}

impl Nifti {
    fn len(&self) -> usize {
        self.dim.iter().product()
    }

    fn i16s(&self) -> Vec<i16> {
        assert_eq!(self.datatype, 4);
        self.bytes[..2 * self.len()]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect()
    }

    fn f64s(&self) -> Vec<f64> {
        let n = self.len();
        match self.datatype {
            2 => self.bytes[..n].iter().map(|&b| b as f64).collect(),
            4 => self.i16s().into_iter().map(f64::from).collect(),
            16 => self.bytes[..4 * n]
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()) as f64)
                .collect(),
            64 => self.bytes[..8 * n]
                .chunks_exact(8)
                .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
                .collect(),
            t => panic!("NIfTI data type {t} is not read here"),
        }
    }
}

fn peak_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// scikit-learn's kernel repr prints a float with `'{0:.3g}'`; for these values that is
/// three significant digits with no trailing zeros.
fn g3(v: f64) -> String {
    let digits = 2 - v.abs().log10().floor() as i32;
    let s = format!("{:.*}", digits.max(0) as usize, v);
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

#[test]
fn gp_model_matches_nifreeze_on_ds005577() {
    let Ok(root) = std::env::var("HMC_REFERENCE") else {
        if std::env::var_os("HMC_REQUIRE_REFERENCE").is_some() {
            panic!("HMC_REFERENCE is not set, but HMC_REQUIRE_REFERENCE is set");
        }
        eprintln!("HMC_REFERENCE is not set; the NiFreeze GP reference check does not run");
        return;
    };
    let root = PathBuf::from(root);
    let volumes: Vec<usize> = match std::env::var("HMC_REFERENCE_VOLUMES") {
        Ok(list) => list.split(',').map(|v| v.trim().parse().unwrap()).collect(),
        Err(_) => (0..DWI_VOLUMES).collect(),
    };
    let start = Instant::now();

    let input = read_nifti(&root.join("input/sub-107_dir-AP_dwi.nii.gz"));
    assert_eq!(input.dim, vec![120, 120, 75, 101]);
    let shape = [input.dim[0], input.dim[1], input.dim[2]];
    let data = input.i16s();
    drop(input);
    let bval = std::fs::read_to_string(root.join("input/sub-107_dir-AP_dwi.bval")).unwrap();
    let bvec = std::fs::read_to_string(root.join("input/sub-107_dir-AP_dwi.bvec")).unwrap();
    let (bvals, bvecs) = read_gradients(&bval, &bvec).unwrap();
    let gradients = B0Rule::NiFreeze.read(bvals, bvecs).unwrap();
    let series = DwiSeries::split(&data, shape, &gradients).unwrap();
    drop(data);
    assert_eq!(series.len(), DWI_VOLUMES);
    assert_eq!(series.b0_volumes, (0..=100).step_by(10).collect::<Vec<_>>());

    // bzero, bit for bit.
    let bzero_ref = read_nifti(&root.join("nifreeze-gp/bzero.nii.gz"));
    assert_eq!(bzero_ref.datatype, 64);
    let bzero_ref = bzero_ref.f64s();
    let bzero = series.bzero.as_ref().unwrap();
    let bzero_diff = bzero
        .iter()
        .zip(&bzero_ref)
        .filter(|(a, b)| a.to_bits() != b.to_bits())
        .count();
    assert_eq!(bzero_diff, 0, "bzero differs in {bzero_diff} voxels");

    // The data mask, and the registration mask that NiFreeze wrote.
    let brain: Vec<bool> = read_nifti(&root.join("mask/sub-107_dir-AP_desc-mindgrab_mask.nii.gz"))
        .f64s()
        .iter()
        .map(|&v| v != 0.0)
        .collect();
    assert_eq!(brain.iter().filter(|&&m| m).count(), 161_679);
    let model = GpModel::new(&series, Some(&brain)).unwrap();
    assert_eq!(model.voxel_count(), MASK_VOXELS);
    let written: Vec<bool> = read_nifti(&root.join("nifreeze-gp/work/brainmask.nii.gz"))
        .f64s()
        .iter()
        .map(|&v| v != 0.0)
        .collect();
    assert_eq!(model.data_mask(), written.as_slice());
    let setup = start.elapsed().as_secs_f64();
    eprintln!(
        "setup {setup:.1} s: bzero equal in all voxels, data mask {} voxels",
        model.voxel_count()
    );

    let (mut fit_s, mut clip_s) = (0.0f64, 0.0f64);
    let (mut in_equal, mut in_total, mut in_off1, mut out_diff) = (0usize, 0usize, 0usize, 0usize);
    let mut max_diff = 0.0f64;
    let mut sigma2 = (f64::INFINITY, f64::NEG_INFINITY);
    let mut worst = (0usize, 1.0f64);
    for &i in &volumes {
        let t = Instant::now();
        let mut p = model.fit_predict(i).unwrap();
        fit_s += t.elapsed().as_secs_f64();
        let f = &p.fit;
        assert!(
            f.at_lower_bound(0) && f.at_lower_bound(1),
            "volume {i}: theta {:?} is not on the lower bounds of a and lambda",
            f.theta
        );
        assert!(!f.at_lower_bound(2), "volume {i}: sigma2 on its bound");
        sigma2 = (sigma2.0.min(f.params.sigma2), sigma2.1.max(f.params.sigma2));
        let kernel = format!(
            "SphericalKriging (a={}, \u{3bb}={}) + WhiteKernel(noise_level={})",
            f.params.a,
            f.params.lambda,
            g3(f.params.sigma2)
        );
        if i == DRY_RUN_VOLUME {
            assert_eq!(
                kernel,
                "SphericalKriging (a=0.10000000000000002, \u{3bb}=0.0010000000000000002) + \
                 WhiteKernel(noise_level=0.999)"
            );
        }

        let t = Instant::now();
        let report = clip_prediction(&mut p.volume, shape).unwrap();
        clip_s += t.elapsed().as_secs_f64();
        assert!(report.mutated);

        let reference = read_nifti(&root.join(format!("nifreeze-gp/work/predicted_{i:05}.nii.gz")));
        assert_eq!(reference.dim, vec![120, 120, 75]);
        let reference = reference.f64s();
        let (mut eq, mut off1) = (0usize, 0usize);
        for (v, (&a, &b)) in p.volume.iter().zip(&reference).enumerate() {
            let d = (a - b).abs();
            max_diff = max_diff.max(d);
            if model.data_mask()[v] {
                in_total += 1;
                if d == 0.0 {
                    eq += 1;
                } else if d <= 1.0 {
                    off1 += 1;
                }
            } else if d != 0.0 {
                out_diff += 1;
            }
        }
        in_equal += eq;
        in_off1 += off1;
        let frac = eq as f64 / MASK_VOXELS as f64;
        if frac < worst.1 {
            worst = (i, frac);
        }
        eprintln!(
            "volume {i:2}: {kernel}, lml {:.6e}, nit {}, nfev {}, clip [{}, {}], \
             mask voxels equal {eq} ({:.4} %), off by 1: {off1}",
            f.lml,
            f.result.nit,
            f.result.nfev,
            report.a_min,
            report.a_max,
            100.0 * frac
        );
    }
    // scikit-learn warned once for a and once for lambda in each of NiFreeze's 90 fits, and in
    // no fit for sigma2; every fit here stopped on the same two bounds (asserted above).
    let log = std::fs::read_to_string(root.join("nifreeze-gp/nifreeze.log")).unwrap();
    let warned = |p: &str| {
        log.matches(&format!(
            "ConvergenceWarning: The optimal value found for dimension 0 of parameter {p} \
             is close to the specified lower bound"
        ))
        .count()
    };
    assert_eq!(
        (
            warned("k1__beta_a"),
            warned("k1__beta_l"),
            warned("k2__noise_level")
        ),
        (DWI_VOLUMES, DWI_VOLUMES, 0)
    );
    assert_eq!(log.matches("ConvergenceWarning").count(), 2 * DWI_VOLUMES);

    let total = start.elapsed().as_secs_f64();
    let pct = 100.0 * in_equal as f64 / in_total as f64;
    eprintln!(
        "{} volumes: mask voxels equal {in_equal} of {in_total} ({pct:.5} %), off by 1: {in_off1}, \
         differing voxels outside the mask: {out_diff}, max |difference| {max_diff}; \
         worst volume {} ({:.4} %); sigma2 in [{}, {}]",
        volumes.len(),
        worst.0,
        100.0 * worst.1,
        sigma2.0,
        sigma2.1
    );
    eprintln!(
        "time: setup {setup:.1} s, fit and predict {fit_s:.1} s, clip {clip_s:.1} s, \
         total {total:.1} s; peak resident {} MiB",
        peak_kib().map_or("unknown".into(), |k| (k / 1024).to_string())
    );
    assert!(max_diff <= 1.0, "a voxel differs by {max_diff}");
    assert!(pct >= 99.99, "only {pct} % of the mask voxels are equal");
}
