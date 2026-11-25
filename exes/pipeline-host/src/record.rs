//! Resume records, the command log and failure cleanup for one tool step.

use crate::{Host, Step, file_name, join, quote};
use serde_json::{Map, Value, json};

const TEXT_LIMIT: usize = 64 << 20;

/// A step to run unless its completion record proves it already ran.
pub struct Recorded<'a> {
    pub step: Step,
    /// Declared outputs; the first names the record and the log line.
    pub outputs: &'a [String],
    /// Files the tool reads that its argv does not name (fastprep's GLM sidecar).
    pub extra_inputs: &'a [String],
    /// Record fields written between `argv` and `outputs` (fastprep: `fsl_out`; SYNcro: `env`). They take part in
    /// the comparison, so a changed setting reruns the step.
    pub settings: Map<String, Value>,
    /// Text on stdout that marks a finished run, so a crash on exit keeps complete outputs.
    pub done_marker: Option<&'a str>,
}

pub enum Outcome {
    Skipped,
    Ran { seconds: f64 },
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    })
}

fn identity<H: Host>(h: &H, paths: &[&str]) -> Value {
    Value::Array(
        paths
            .iter()
            .map(|p| {
                h.stat(p)
                    .map_or(Value::Null, |(n, t)| json!([p, n, t.to_string()]))
            })
            .collect(),
    )
}

/// Run one tool step in `work` unless a completion record proves it already ran with the same argv, settings,
/// inputs and outputs. On failure its declared outputs are removed and the error carries the tool's output tail.
pub async fn run<H: Host>(h: &H, work: &str, r: Recorded<'_>) -> Result<Outcome, String> {
    let argv = &r.step.argv;
    let tool = &argv[0];
    let first = r.outputs[0].as_str();
    let outs: Vec<&str> = r.outputs.iter().map(String::as_str).collect();
    // existing files named on the command line (including undeclared side outputs), so a rerun upstream
    // invalidates this step without hashing image payloads
    let inputs = || -> Vec<&str> {
        argv[1..]
            .iter()
            .map(|a| a.strip_prefix('@').unwrap_or(a))
            .chain(r.extra_inputs.iter().map(String::as_str))
            .filter(|a| !outs.contains(a) && h.stat(a).is_some())
            .collect()
    };
    let record_dir = join(work, "steps");
    let record_path = join(&record_dir, &format!("{:016x}.json", fnv(first)));
    let record = |ins: &[&str]| {
        let mut m = Map::new();
        m.insert("argv".into(), json!(argv));
        m.extend(r.settings.clone());
        m.insert("outputs".into(), identity(h, &outs));
        m.insert("inputs".into(), identity(h, ins));
        Value::Object(m)
    };
    if outs.iter().all(|o| h.exists(o))
        && h.exists(&record_path)
        && h.read_text(&record_path, TEXT_LIMIT)
            .await
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            == Some(record(&inputs()))
    {
        h.log(&format!("  skip  {}", file_name(first)));
        return Ok(Outcome::Skipped);
    }
    let env: String = r
        .step
        .env
        .iter()
        .map(|(k, v)| format!("{k}={} ", quote(v)))
        .collect();
    let line = argv.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");
    h.append(
        &join(work, "commands.sh"),
        format!("{env}{line}\n").as_bytes(),
    )
    .await?;
    h.remove(&record_path);
    // a command that re-reads its own -save output (fastprep's notgm) got the previous run's file from niimath, not
    // the new one; clearing declared outputs first makes a rerun match a clean run
    for o in &outs {
        h.remove(o);
    }
    let t0 = h.now();
    let exit = h.run(&r.step).await?;
    let missing: Vec<&str> = outs.iter().copied().filter(|o| !h.exists(o)).collect();
    let name = file_name(tool);
    if exit.code != 0
        && missing.is_empty()
        && r.done_marker.is_some_and(|m| exit.stdout.contains(m))
    {
        h.log(&format!(
            "  warning: {name} crashed after finishing (rc {}); outputs kept",
            exit.code
        ));
    } else if exit.code != 0 || !missing.is_empty() {
        for o in &outs {
            h.remove(o);
        }
        // last n characters, as Python's s[-n:]
        let tail = |s: &str, n: usize| {
            s[s.char_indices().rev().nth(n - 1).map_or(0, |(i, _)| i)..].to_string()
        };
        let missing: Vec<String> = missing
            .iter()
            .map(|m| format!("'{}'", file_name(m)))
            .collect();
        return Err(format!(
            "FAILED ({}, missing [{}]): {}\n{}{}",
            exit.code,
            missing.join(", "),
            argv.join(" "),
            tail(&exit.stderr, 3000),
            tail(&exit.stdout, 1000)
        ));
    }
    let seconds = h.now() - t0;
    h.mkdirs(&record_dir)?;
    let tmp = format!("{record_path}.partial");
    h.write(&tmp, record(&inputs()).to_string().as_bytes())
        .await?;
    h.rename(&tmp, &record_path)?;
    h.log(&format!("  {seconds:5.1}s {name} -> {}", file_name(first)));
    Ok(Outcome::Ran { seconds })
}
