//! Shared runner: resume records, command log, timings and failure cleanup. Hosts only execute.

use crate::bids::{Image, deriv_path};
use crate::host::{Host, Step, file_name, join, parent};
use crate::py;
use serde_json::{Map, Value, json};
use std::cell::RefCell;

pub const TEMPLATE: &str = "MNI152NLin2009cAsym";
const TEXT_LIMIT: usize = 64 << 20; // confounds of long runs stay far below this
/// Metal/CUDA tools and their CPU switch (`--no-gpu`).
const GPU_TOOLS: [(&str, &[&str]); 2] = [
    ("brainchop", &["-backend", "cpu"]),
    ("synthsr", &["--device", "cpu"]),
];

pub struct Templates {
    pub brain: String,
    pub t1w: String,
    pub mask: String,
}

impl Templates {
    pub fn new(dir: &str) -> Self {
        let f = |s: &str| {
            join(
                dir,
                &format!("tpl-{TEMPLATE}/tpl-{TEMPLATE}_res-01_{s}.nii.gz"),
            )
        };
        Templates {
            brain: f("desc-brain_T1w"),
            t1w: f("T1w"),
            mask: f("desc-brain_mask"),
        }
    }
}

#[derive(Default)]
struct State {
    /// (tool, first output, seconds) for the report
    times: Vec<(String, String, f64)>,
    /// timings.json: a resumed run keeps each skipped step's earlier time
    cached: Map<String, Value>,
    computed: bool,
}

pub struct Ctx<H: Host> {
    pub h: H,
    pub out: String,
    pub work: String,
    pub tpl: Templates,
    pub omp: usize,
    pub nprocs: usize,
    pub workers: usize,
    pub gpu_slots: usize,
    /// Set by a host whose threads and GPU are not the CLI's (the browser); replaces those report facts.
    pub runtime: Option<String>,
    pub wall: (f64, u64),
    st: RefCell<State>,
}

/// Argument conversion with Python `str()` semantics.
pub trait Arg {
    fn arg(&self) -> String;
}
impl Arg for str {
    fn arg(&self) -> String {
        self.to_string()
    }
}
impl Arg for String {
    fn arg(&self) -> String {
        self.clone()
    }
}
impl Arg for f64 {
    fn arg(&self) -> String {
        py::repr(*self)
    }
}
impl Arg for usize {
    fn arg(&self) -> String {
        self.to_string()
    }
}
impl Arg for i64 {
    fn arg(&self) -> String {
        self.to_string()
    }
}
impl Arg for Value {
    fn arg(&self) -> String {
        py::value(self)
    }
}
impl<T: Arg + ?Sized> Arg for &T {
    fn arg(&self) -> String {
        (**self).arg()
    }
}

/// `argv![a, b, ..xs, c]`: mixed arguments, `..xs` splices an iterable of `Arg`s.
#[macro_export]
macro_rules! argv {
    (@acc $v:ident;) => {};
    (@acc $v:ident; .. $e:expr $(, $($rest:tt)*)?) => {
        $v.extend(($e).into_iter().map(|x| $crate::run::Arg::arg(&x)));
        $crate::argv!(@acc $v; $($($rest)*)?);
    };
    (@acc $v:ident; $e:expr $(, $($rest:tt)*)?) => {
        $v.extend([$crate::run::Arg::arg(&$e)]);
        $crate::argv!(@acc $v; $($($rest)*)?);
    };
    ($($t:tt)*) => {{
        let mut v: Vec<String> = Vec::new();
        $crate::argv!(@acc v; $($t)*);
        v
    }};
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    })
}

impl<H: Host> Ctx<H> {
    pub async fn new(
        h: H,
        out: String,
        work: String,
        tpl: Templates,
        omp: usize,
        nprocs: usize,
        gpu_slots: usize,
    ) -> Self {
        let read = |name: &str| join(&work, name);
        let load = async |p: String| -> Option<Value> {
            if !h.exists(&p) {
                return None;
            }
            h.read_text(&p, TEXT_LIMIT)
                .await
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
        };
        let cached = load(read("timings.json"))
            .await
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        let wall = load(read("wall.json")).await.map_or((0.0, 0), |v| {
            (
                v["seconds"].as_f64().unwrap_or(0.0),
                v["invocations"].as_u64().unwrap_or(0),
            )
        });
        Ctx {
            h,
            out,
            work,
            tpl,
            omp,
            nprocs,
            workers: 1, // ponytail: sequential; bounded native scheduling comes after parity
            gpu_slots,
            runtime: None,
            wall,
            st: RefCell::new(State {
                cached,
                ..Default::default()
            }),
        }
    }

    pub fn times(&self) -> Vec<(String, String, f64)> {
        self.st.borrow().times.clone()
    }
    pub fn computed(&self) -> bool {
        self.st.borrow().computed
    }

    /// Derivative path for `src` (directory created), as fastprep.py `deriv`.
    pub fn deriv(
        &self,
        src: &Image,
        suffix: &str,
        ext: &str,
        over: &[(&str, Option<&str>)],
    ) -> Result<String, String> {
        let p = deriv_path(&src.ents, &src.rel, &self.out, suffix, ext, over);
        self.h.mkdirs(parent(&p))?;
        Ok(p)
    }

    /// Per-subject work directory, as fastprep.py's `work / f'sub-{label}'`.
    pub fn sub_work(&self, img: &Image) -> String {
        join(
            &self.work,
            &format!("sub-{}", img.ents.get("sub").unwrap_or("")),
        )
    }

    pub fn dir(&self, base: &str, name: &str) -> Result<String, String> {
        let d = join(base, name);
        self.h.mkdirs(&d)?;
        Ok(d)
    }

    pub async fn text(&self, path: &str) -> Result<String, String> {
        self.h.read_text(path, TEXT_LIMIT).await
    }

    pub async fn json(&self, path: &str) -> Result<Value, String> {
        serde_json::from_str(&self.text(path).await?).map_err(|e| format!("{path}: {e}"))
    }

    /// Write a file the pipeline itself produces; true if it changed. Unchanged content keeps its timestamp, so the
    /// resume records of steps that read it stay valid.
    pub async fn put(&self, path: &str, text: &str) -> Result<bool, String> {
        if self.h.exists(path) && self.text(path).await.ok().as_deref() == Some(text) {
            return Ok(false);
        }
        self.h.write(path, text.as_bytes()).await.map(|_| true)
    }

    fn identity(&self, paths: &[&str]) -> Value {
        Value::Array(
            paths
                .iter()
                .map(|p| {
                    self.h
                        .stat(p)
                        .map_or(Value::Null, |(n, t)| json!([p, n, t.to_string()]))
                })
                .collect(),
        )
    }

    /// Run one tool step unless a completion record proves it already ran with the same argv, settings, inputs
    /// and outputs. On failure its declared outputs are removed and the error carries the tool's output tail.
    pub async fn run(
        &self,
        mut argv: Vec<String>,
        outputs: &[String],
        fsl_out: Option<&'static str>,
        done_marker: Option<&str>,
    ) -> Result<bool, String> {
        let tool = argv[0].clone();
        let cpu = GPU_TOOLS
            .iter()
            .find(|(t, _)| tool.starts_with(t))
            .map(|(_, f)| *f);
        if let (Some(flags), 0) = (cpu, self.gpu_slots) {
            argv.splice(1..1, flags.iter().map(|f| f.to_string()));
        }
        let first = outputs[0].as_str();
        let outs: Vec<&str> = outputs.iter().map(String::as_str).collect();
        // GLM reads the BOLD sidecar implicitly in both its native and browser drivers.
        let glm_sidecar = if file_name(&tool) == "glm" {
            argv[1..]
                .iter()
                .filter(|p| !outs.contains(&p.as_str()))
                .find_map(|p| p.strip_suffix(".gz").unwrap_or(p).strip_suffix(".nii"))
                .map(|stem| format!("{stem}.json"))
        } else {
            None
        };
        // existing files named on the command line (including undeclared side outputs), so a rerun upstream
        // invalidates this step without hashing image payloads
        let inputs = || -> Vec<&str> {
            argv[1..]
                .iter()
                .map(|a| a.strip_prefix('@').unwrap_or(a))
                .chain(glm_sidecar.as_deref())
                .filter(|a| !outs.contains(a) && self.h.stat(a).is_some())
                .collect()
        };
        let record_dir = join(&self.work, "steps");
        let record_path = join(&record_dir, &format!("{:016x}.json", fnv(first)));
        let record = |ins: &[&str]| json!({"argv": argv, "fsl_out": fsl_out, "outputs": self.identity(&outs), "inputs": self.identity(ins)});
        if outs.iter().all(|o| self.h.exists(o))
            && self.h.exists(&record_path)
            && self.json(&record_path).await.ok() == Some(record(&inputs()))
        {
            self.h.log(&format!("  skip  {}", file_name(first)));
            let mut st = self.st.borrow_mut();
            if let Some([tool, dt]) = st
                .cached
                .get(first)
                .and_then(Value::as_array)
                .cloned()
                .as_deref()
            {
                st.times.push((
                    py::value(tool),
                    file_name(first).into(),
                    dt.as_f64().unwrap_or(0.0),
                ));
            }
            return Ok(false);
        }
        let log = join(&self.work, "commands.sh");
        let env = fsl_out.map_or(String::new(), |f| format!("FSLOUTPUTTYPE={f} "));
        let line = argv
            .iter()
            .map(|a| py::quote(a))
            .collect::<Vec<_>>()
            .join(" ");
        self.h
            .append(&log, format!("{env}{line}\n").as_bytes())
            .await?;
        self.h.remove(&record_path);
        // a command that re-reads its own -save output (notgm) got the previous run's file from niimath, not the
        // new one; clearing declared outputs first makes a rerun match a clean run
        for o in &outs {
            self.h.remove(o);
        }
        let t0 = self.h.now();
        let step = Step {
            argv: argv.clone(),
            fsl_out,
            gpu: cpu.is_some() && self.gpu_slots > 0,
        };
        let exit = self.h.run(&step).await?;
        let missing: Vec<&str> = outs.iter().copied().filter(|o| !self.h.exists(o)).collect();
        let name = file_name(&tool).to_string();
        if exit.code != 0
            && missing.is_empty()
            && done_marker.is_some_and(|m| exit.stdout.contains(m))
        {
            self.h.log(&format!(
                "  warning: {name} crashed after finishing (rc {}); outputs kept",
                exit.code
            ));
        } else if exit.code != 0 || !missing.is_empty() {
            for o in &outs {
                self.h.remove(o);
            }
            // last n characters, as Python's s[-n:]
            let tail = |s: &str, n: usize| {
                s[s.char_indices().rev().nth(n - 1).map_or(0, |(i, _)| i)..].to_string()
            };
            let missing: Vec<&str> = missing.iter().map(|m| file_name(m)).collect();
            return Err(format!(
                "FAILED ({}, missing {}): {}\n{}{}",
                exit.code,
                py::list_repr(&missing),
                argv.join(" "),
                tail(&exit.stderr, 3000),
                tail(&exit.stdout, 1000)
            ));
        }
        let dt = self.h.now() - t0;
        {
            let mut st = self.st.borrow_mut();
            st.times.push((name.clone(), file_name(first).into(), dt));
            st.computed |= !first.ends_with(".png");
            st.cached.insert(first.into(), json!([name, dt]));
        }
        let cached = serde_json::to_string(&self.st.borrow().cached).unwrap();
        self.h
            .write(&join(&self.work, "timings.json"), cached.as_bytes())
            .await?;
        self.h.mkdirs(&record_dir)?;
        let tmp = format!("{record_path}.partial");
        self.h
            .write(&tmp, record(&inputs()).to_string().as_bytes())
            .await?;
        self.h.rename(&tmp, &record_path)?;
        self.h
            .log(&format!("  {dt:5.1}s {name} -> {}", file_name(first)));
        Ok(true)
    }
}
