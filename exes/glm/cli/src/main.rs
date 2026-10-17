//! glm: block-design first-level GLM t maps (Rust port of glm.py).
//!
//!   glm bold.nii.gz confounds.tsv events.tsv condition out.nii.gz [--fwhm 0] [--ols]
//!   glm --task-analysis bold.nii.gz confounds.tsv events.tsv l>r r>l l r --summary s.json [--fwhm 5]

use glm_core::io::{single, task_analysis};
use std::fs;

const USAGE: &str = "usage: glm bold.nii.gz confounds.tsv events.tsv condition out.nii.gz [--fwhm 0] [--ols]
       glm --task-analysis bold.nii.gz confounds.tsv events.tsv OUT_LGR OUT_RGL OUT_L OUT_R --summary S.json [--fwhm 5]

Model: condition boxcar(s) * double-gamma HRF, intercept, DCT drift (128 s), 6 motion parameters; non-steady-state
volumes (confounds non_steady_state_*) dropped. Noise: AR(1) prewhitening (lag-1 autocorrelation of the OLS
residuals, smoothed 5 mm, quantised to 0.01, Prais-Winsten refit). --task-analysis writes the four left/right
contrasts (NIfTI t-test intent, p1 = df) and a JSON summary.";

fn read(path: &str) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("{path}: {e}"))
}

fn text(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
}

fn write(path: &str, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| format!("{path}: {e}"))
}

fn run(args: Vec<String>) -> Result<(), String> {
    let task = args.first().is_some_and(|a| a == "--task-analysis");
    let mut pos = vec![];
    let (mut fwhm, mut ols, mut summary) = (if task { 5.0 } else { 0.0 }, false, None);
    let mut it = args.into_iter().skip(task as usize);
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => return Err(USAGE.into()),
            "--fwhm" => {
                fwhm = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or("--fwhm: expected a number")?
            }
            "--ols" if !task => ols = true,
            "--summary" if task => summary = Some(it.next().ok_or("--summary: expected a path")?),
            s if s.starts_with("--") => return Err(format!("unknown option {s}\n{USAGE}")),
            _ => pos.push(a),
        }
    }
    if pos.len() != if task { 7 } else { 5 } || (task && summary.is_none()) {
        return Err(USAGE.into());
    }
    let bold = read(&pos[0]).and_then(|b| {
        if b.is_empty() {
            Err(format!("{}: empty file", pos[0]))
        } else {
            Ok(b)
        }
    })?;
    let stem = pos[0].strip_suffix(".gz").unwrap_or(&pos[0]);
    let side = text(&format!(
        "{}.json",
        stem.strip_suffix(".nii").unwrap_or(stem)
    ))?;
    let (conf, ev) = (text(&pos[1])?, text(&pos[2])?);
    let at = |e: String| format!("{}: {e}", pos[0]);
    if task {
        let (maps, summary_json) = task_analysis(&bold, &side, &conf, &ev, fwhm).map_err(at)?;
        for (map, out) in maps.iter().zip(&pos[3..7]) {
            write(out, &nifti_for(out, map))?;
        }
        write(&summary.unwrap(), summary_json.as_bytes())
    } else {
        let (map, line) = single(&bold, &side, &conf, &ev, &pos[3], fwhm, ols).map_err(at)?;
        write(&pos[4], &nifti_for(&pos[4], &map))?;
        println!("{}: {line}", pos[4]);
        Ok(())
    }
}

fn nifti_for(path: &str, raw: &[u8]) -> Vec<u8> {
    if path.ends_with(".gz") {
        glm_core::io::gzip(raw)
    } else {
        raw.to_vec()
    }
}

fn main() {
    if let Err(e) = run(std::env::args().skip(1).collect()) {
        eprintln!("{e}");
        std::process::exit(if e == USAGE { 2 } else { 1 });
    }
}
