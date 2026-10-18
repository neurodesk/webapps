//! fastprep native CLI: OS processes, real files, Unix GPU-slot locks.

use fastprep_core::host::{Exit, Host, Stat, Step};
use fastprep_core::pipeline::{self, Options};
use fastprep_core::run::{Ctx, Templates};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const USAGE: &str = "usage: fastprep bids_dir output_dir participant [--participant-label L ...] [--nprocs N]
       [--omp-nthreads N] [-w WORK_DIR] [--no-gpu] [--gpu-slots N] [--gpu-lock-dir DIR]
       [--synthsr auto|all|off] [--frisgo runwise|lpass|spline|simple|off] [--no-robustfov] [--t1w GLOB]

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
  --t1w                 anatomical file-name glob (default: best T1w)";

struct Native {
    bin: PathBuf,
    env: Vec<(String, String)>,
    gpu_slots: usize,
    gpu_lock_dir: PathBuf,
}

fn tool_path(name: &str, bin: &Path) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::iter::once(bin.to_path_buf())
        .chain(std::env::split_paths(&path))
        .map(|d| d.join(name))
        .find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

impl Native {
    /// One of gpu_slots flock'd files shared by every fastprep instance; waits while all are taken. The kernel drops
    /// a lock when its holder exits, so a crashed instance never leaves a stale slot.
    fn gpu_slot(&self) -> Result<File, String> {
        loop {
            for i in 0..self.gpu_slots {
                let path = self.gpu_lock_dir.join(format!("fastprep-gpu-{i}.lock"));
                // O_NOFOLLOW: a symlink planted in shared /tmp must not redirect the open or the chmod
                // an open failure is permanent (missing dir, permissions, symlink); only a held flock means wait
                let f = OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .mode(0o666)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&path)
                    .map_err(|e| format!("GPU lock {}: {e}", path.display()))?;
                // other users' instances share the slots; O_NOFOLLOW stops symlinks but not a planted hard link, so
                // only a lone file of our own is opened up
                if f.metadata().is_ok_and(|m| {
                    m.is_file() && m.nlink() == 1 && m.uid() == unsafe { libc::geteuid() }
                }) {
                    let _ = f.set_permissions(fs::Permissions::from_mode(0o666));
                }
                if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                    return Ok(f);
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

impl Host for Native {
    async fn run(&self, step: &Step) -> Result<Exit, String> {
        let name = &step.argv[0];
        let exe = tool_path(name, &self.bin).ok_or_else(|| {
            format!(
                "tool not found: {name} (add to PATH or {})",
                self.bin.display()
            )
        })?;
        let mut cmd = Command::new(exe);
        cmd.args(&step.argv[1..])
            .envs(self.env.iter().map(|(k, v)| (k, v)));
        if let Some(f) = step.fsl_out {
            cmd.env("FSLOUTPUTTYPE", f);
        }
        let _slot = step.gpu.then(|| self.gpu_slot()).transpose()?;
        let o = cmd.output().map_err(|e| format!("{name}: {e}"))?;
        Ok(Exit {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into(),
            stderr: String::from_utf8_lossy(&o.stderr).into(),
        })
    }

    async fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        let err = |e: std::io::Error| format!("{path}: {e}");
        let mut f = File::open(path).map_err(err)?;
        f.seek(SeekFrom::Start(offset)).map_err(err)?;
        let mut buf = Vec::with_capacity(len);
        f.take(len as u64).read_to_end(&mut buf).map_err(err)?;
        Ok(buf)
    }

    async fn read_text(&self, path: &str, limit: usize) -> Result<String, String> {
        let n = fs::metadata(path)
            .map_err(|e| format!("{path}: {e}"))?
            .len();
        if n > limit as u64 {
            return Err(format!(
                "{path}: {n} bytes exceeds the {limit}-byte text limit"
            ));
        }
        fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
    }

    async fn write(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        fs::write(path, bytes).map_err(|e| format!("{path}: {e}"))
    }

    async fn append(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| f.write_all(bytes))
            .map_err(|e| format!("{path}: {e}"))
    }

    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    fn stat(&self, path: &str) -> Option<Stat> {
        let m = fs::metadata(path).ok().filter(|m| m.is_file())?;
        Some((
            m.len(),
            m.modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_nanos(),
        ))
    }

    fn list(&self, dir: &str) -> Vec<String> {
        fn walk(root: &Path, rel: &str, out: &mut Vec<String>) {
            let Ok(rd) = fs::read_dir(root.join(rel)) else {
                return;
            };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let r = if rel.is_empty() {
                    name
                } else {
                    format!("{rel}/{name}")
                };
                match e.file_type() {
                    Ok(t) if t.is_dir() => walk(root, &r, out), // symlinked dirs are not followed, as pathlib.rglob
                    Ok(_) if e.path().is_file() => out.push(r),
                    _ => {}
                }
            }
        }
        let mut out = vec![];
        walk(Path::new(dir), "", &mut out);
        out
    }

    fn mkdirs(&self, dir: &str) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| format!("{dir}: {e}"))
    }

    fn remove(&self, path: &str) {
        let _ = fs::remove_file(path);
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        fs::rename(from, to).map_err(|e| format!("{from} -> {to}: {e}"))
    }

    fn copy(&self, from: &str, to: &str) -> Result<(), String> {
        fs::copy(from, to)
            .map(|_| ())
            .map_err(|e| format!("{from} -> {to}: {e}"))
    }

    fn now(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
    }

    fn local_time(&self) -> String {
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&t, &mut tm) };
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}",
            tm.tm_year + 1900,
            tm.tm_mon + 1,
            tm.tm_mday,
            tm.tm_hour,
            tm.tm_min
        )
    }

    fn log(&self, line: &str) {
        println!("{line}");
    }
}

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
    fn gpu_slot_is_shared_between_instances() {
        let d = std::env::temp_dir().join(format!("fastprep-gpu-test-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        let host = |d: &Path| Native {
            bin: PathBuf::new(),
            env: vec![],
            gpu_slots: 1,
            gpu_lock_dir: d.to_path_buf(),
        };
        let (a, b) = (host(&d), host(&d));
        let events = std::sync::Mutex::new(vec![]);
        let (acquired, ready) = std::sync::mpsc::channel();
        std::thread::scope(|s| {
            s.spawn(|| {
                let _f = a.gpu_slot().unwrap();
                events.lock().unwrap().push("a+");
                acquired.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(400));
                events.lock().unwrap().push("a-");
            });
            ready.recv().unwrap();
            let _f = b.gpu_slot().unwrap();
            events.lock().unwrap().push("b+");
        });
        assert_eq!(*events.lock().unwrap(), ["a+", "a-", "b+"]);
        fs::remove_dir_all(&d).unwrap();
        assert!(host(&d).gpu_slot().is_err()); // a missing lock dir fails instead of waiting forever
    }

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
