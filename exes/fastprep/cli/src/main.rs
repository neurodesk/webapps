//! fastprep native CLI: OS processes, real files, Unix GPU-slot locks.

use fastprep_core::host::Host;
use fastprep_core::host::native::{Native, tool_path};
use fastprep_core::pipeline::{self, Options};
use fastprep_core::run::{Ctx, Templates};
use std::fs;
use std::path::{Path, PathBuf};

const USAGE: &str = "usage: fastprep bids_dir output_dir participant [--participant-label L ...] [--nprocs N]
       [--omp-nthreads N] [-w WORK_DIR] [--no-gpu] [--gpu-slots N] [--gpu-lock-dir DIR]
       [--synthsr auto|all|off] [--frisgo runwise|lpass|spline|simple|off] [--no-robustfov] [--t1w GLOB]
       [--meica auto|on|off] [--meica-tree TREE]

fastprep: lean fMRIPrep-style preprocessing. Tools are found in <home>/bin, then PATH;
templates in <home>/templates (home: $FASTPREP_HOME, else the executable's directory).

  --participant-label   subject labels (without sub-)
  --nprocs              total threads (default: all cores)
  --omp-nthreads        per-tool threads (0 = nprocs)
  -w, --work-dir        work directory (default: work)
  --no-gpu              run brainchop and synthsr on CPU (3-4x slower, ~3x the RAM)
  --gpu-slots           max concurrent GPU jobs across ALL fastprep instances on this machine (default 1)
  --gpu-lock-dir        shared dir for the GPU slot locks (default /tmp)
  --synthsr             SynthSR + greedy SDC: all (default) = every run, as a residual after fieldmap/MEDIC SDC;
                        auto = only runs without a usable fieldmap/MEDIC; off
  --frisgo              fuzzy-ripple correction of dual-polarity 3D EPI (default runwise)
  --no-robustfov        keep the full T1w field of view
  --t1w                 anatomical file-name glob (default: best T1w)
  --meica               ME-ICA denoising of runs with >= 3 echoes (auto: from 100 usable volumes, a failure
                        warns; on: any length, a failure stops fastprep; off: never)
  --meica-tree          meica decision tree: tedana_orig (default), motion_f, motion_aroma, ... or a JSON file";

struct Args {
    bids: PathBuf,
    out: PathBuf,
    work: PathBuf,
    labels: Vec<String>,
    nprocs: usize,
    omp: usize,
    no_gpu: bool,
    gpu_slots: usize,
    gpu_lock_dir: PathBuf,
    synthsr: String,
    frisgo: String,
    robustfov: bool,
    t1w: Option<String>,
    meica: String,
    meica_tree: String,
}

fn parse(argv: Vec<String>) -> Result<Args, String> {
    let mut pos = vec![];
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    let mut a = Args {
        bids: PathBuf::new(),
        out: PathBuf::new(),
        work: "work".into(),
        labels: vec![],
        nprocs: cores,
        omp: 0,
        no_gpu: false,
        gpu_slots: 1,
        gpu_lock_dir: "/tmp".into(),
        synthsr: "all".into(),
        frisgo: "runwise".into(),
        robustfov: true,
        t1w: None,
        meica: "auto".into(),
        meica_tree: "tedana_orig".into(),
    };
    let mut it = argv
        .into_iter()
        .flat_map(|s| match s.split_once('=') {
            Some((k, v)) if k.starts_with("--") => vec![k.to_string(), v.to_string()],
            _ => vec![s],
        })
        .peekable();
    let num = |v: Option<String>, k: &str| {
        v.and_then(|v| v.parse::<usize>().ok())
            .ok_or(format!("{k}: expected a number"))
    };
    let choice = |v: Option<String>, k: &str, ok: &[&str]| match v {
        Some(v) if ok.contains(&v.as_str()) => Ok(v),
        _ => Err(format!("{k}: choose from {}", ok.join(", "))),
    };
    while let Some(k) = it.next() {
        match k.as_str() {
            "-h" | "--help" => return Err(USAGE.into()),
            "--participant-label" => {
                while let Some(v) = it.next_if(|v| !v.starts_with('-')) {
                    a.labels.push(v.trim_start_matches("sub-").to_string());
                }
            }
            "--nprocs" => a.nprocs = num(it.next(), &k)?,
            "--omp-nthreads" => a.omp = num(it.next(), &k)?,
            "-w" | "--work-dir" => a.work = it.next().ok_or("-w: expected a path")?.into(),
            "--no-gpu" => a.no_gpu = true,
            "--gpu-slots" => a.gpu_slots = num(it.next(), &k)?,
            "--gpu-lock-dir" => {
                a.gpu_lock_dir = it.next().ok_or("--gpu-lock-dir: expected a path")?.into()
            }
            "--synthsr" => a.synthsr = choice(it.next(), &k, &["auto", "all", "off"])?,
            "--frisgo" => {
                a.frisgo = choice(
                    it.next(),
                    &k,
                    &["runwise", "lpass", "spline", "simple", "off"],
                )?
            }
            "--no-robustfov" => a.robustfov = false,
            "--t1w" => a.t1w = Some(it.next().ok_or("--t1w: expected a glob")?),
            "--meica" => a.meica = choice(it.next(), &k, &["auto", "on", "off"])?,
            "--meica-tree" => a.meica_tree = it.next().ok_or("--meica-tree: expected a tree")?,
            s if s.starts_with('-') => return Err(format!("unknown option {s}\n{USAGE}")),
            _ => pos.push(k),
        }
    }
    if pos.len() != 3 || pos[2] != "participant" {
        return Err(USAGE.into());
    }
    a.bids = pos[0].clone().into();
    a.out = pos[1].clone().into();
    Ok(a)
}

fn main() {
    let a = match parse(std::env::args().skip(1).collect()) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = start(a) {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn start(a: Args) -> Result<(), String> {
    let home = std::env::var_os("FASTPREP_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(Path::to_path_buf))
                .unwrap_or_default()
        });
    let bin = home.join("bin");
    let abs = |p: &Path| -> Result<String, String> {
        fs::create_dir_all(p).map_err(|e| format!("{}: {e}", p.display()))?;
        Ok(fs::canonicalize(p)
            .map_err(|e| format!("{}: {e}", p.display()))?
            .to_string_lossy()
            .into_owned())
    };
    let bids = fs::canonicalize(&a.bids)
        .map_err(|e| format!("{}: {e}", a.bids.display()))?
        .to_string_lossy()
        .into_owned();
    let (out, work) = (abs(&a.out)?, abs(&a.work)?);
    let missing: Vec<&str> = [
        "niimath",
        "brainchop-mindgrab",
        "brainchop-mindmap",
        "greedy-rs",
    ]
    .into_iter()
    .filter(|t| tool_path(t, &bin).is_none())
    .collect();
    if !missing.is_empty() {
        return Err(format!(
            "tools not found: {} (add to PATH or {})",
            missing.join(", "),
            bin.display()
        ));
    }
    let omp = if a.omp == 0 { a.nprocs } else { a.omp };
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let env: Vec<(String, String)> = [
        ("OMP_NUM_THREADS", omp.to_string()),
        ("BC_NUM_THREADS", omp.to_string()),
        // niimath .nii.gz via pigz with -p threads at nibabel's level 1: 20 s -> 0.8 s per BOLD
        ("FSLOUTPUTTYPE", "NIFTI_GZ".into()),
        ("AFNI_COMPRESSOR", "PIGZ".into()),
        ("NIIMATH_GZ_LEVEL", "1".into()),
        ("PATH", path),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    let gpu_slots = if a.no_gpu { 0 } else { a.gpu_slots.max(1) };
    // replay header: the environment every following command ran with
    let exports: Vec<String> = env
        .iter()
        .map(|(k, v)| format!("{k}={}", fastprep_core::py::quote(v)))
        .collect();
    let header = format!("export {}\n", exports.join(" "));
    let host = Native {
        bin,
        env,
        gpu_slots,
        gpu_lock_dir: a.gpu_lock_dir,
    };
    fastprep_core::block_on(async {
        host.append(&format!("{work}/commands.sh"), header.as_bytes())
            .await?;
        let tpl = Templates::new(&home.join("templates").to_string_lossy());
        let ctx = Ctx::new(host, out, work, tpl, omp, a.nprocs, gpu_slots).await;
        let o = Options {
            bids,
            labels: a.labels,
            synthsr: a.synthsr,
            frisgo: a.frisgo,
            robustfov: a.robustfov,
            t1w: a.t1w,
            surfaces: true,
            max_bold_bytes: None,
            meica: a.meica,
            meica_tree: a.meica_tree,
        };
        pipeline::run(&ctx, &o).await
    })
}

#[cfg(test)]
mod regressions;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments() {
        let a = parse(
            "bids out participant --participant-label sub-01 02 --synthsr=auto --no-gpu"
                .split(' ')
                .map(String::from)
                .collect(),
        )
        .unwrap();
        assert_eq!(a.labels, ["01", "02"]);
        assert_eq!(a.synthsr, "auto");
        assert!(a.no_gpu && a.robustfov);
        assert!(parse(vec!["bids".into()]).is_err());
        assert!(
            parse(
                "b o participant --frisgo bad"
                    .split(' ')
                    .map(String::from)
                    .collect()
            )
            .is_err()
        );
    }
}
