//! fastprep.py `main` after argument parsing: discovery, per-subject stages, reports.

use crate::bids::{self, FMAP_FORMS, Image};
use crate::host::{Host, join};
use crate::report::{self, Run};
use crate::run::Ctx;
use crate::stages::{self, Fitted};
use serde_json::json;
use std::rc::Rc;

pub struct Options {
    pub bids: String,
    pub labels: Vec<String>,
    pub synthsr: String,
    pub frisgo: String,
    pub robustfov: bool,
    pub t1w: Option<String>,
    /// TopoFit cortical surfaces (off where TopoFit is unavailable, e.g. the browser).
    pub surfaces: bool,
    /// Refuse runs whose float32 BOLD (all echoes) exceeds this many bytes, before any processing.
    pub max_bold_bytes: Option<u64>,
    /// ME-ICA for runs with >= 3 echoes: auto, on or off; and the meica decision tree.
    pub meica: String,
    pub meica_tree: String,
}

/// Decoded float32 size of a run, summed over its magnitude and phase echoes.
fn bold_bytes(b: &Image) -> Option<u64> {
    let vox = b
        .hdr
        .shape
        .iter()
        .try_fold(1u64, |a, &n| a.checked_mul(n as u64))?;
    vox.checked_mul(4)?
        .checked_mul((b.echoes.len() + b.phases.len()).max(1) as u64) // MEDIC holds phase echoes too
}

struct Subject {
    label: String,
    t1: Image,
    anat: stages::Anat,
    runs: Vec<(Image, stages::Fit)>,
}

pub async fn run<H: Host>(c: &Ctx<H>, o: &Options) -> Result<(), String> {
    let t0 = c.h.now();
    c.h.mkdirs(&c.work)?;
    c.h.mkdirs(&c.out)?;
    let desc = json!({"Name": "fastprep", "BIDSVersion": "1.9.0", "DatasetType": "derivative", "GeneratedBy": [{"Name": "fastprep"}]});
    c.put(
        &join(&c.out, "dataset_description.json"),
        &serde_json::to_string_pretty(&desc).unwrap(),
    )
    .await?;
    let mut done = vec![];
    for s in bids::discover(&c.h, &o.bids, &o.labels).await? {
        let t1 = bids::pick_t1w(&s.anat, o.t1w.as_deref())?.cloned(); // v1: one T1w
        let bolds = bids::bold_runs(&s.func)?;
        if t1.is_none() && bolds.is_empty() {
            c.h.log(&format!("sub-{}: no T1w or BOLD; skipped", s.label));
            continue;
        }
        if let Some(limit) = o.max_bold_bytes {
            for b in &bolds {
                let n = bold_bytes(b).unwrap_or(u64::MAX);
                if n > limit {
                    return Err(format!(
                        "{}: {:.2} GB as float32 exceeds the {:.2} GB limit here; use the native fastprep",
                        b.name(),
                        n as f64 / 1e9,
                        limit as f64 / 1e9
                    ));
                }
            }
        }
        let me = bolds.iter().filter(|b| b.echoes.len() > 1).count();
        let inversions = t1
            .as_ref()
            .map_or(vec![], |t| bids::mp2rage_inversions(t, &s.anat));
        let from = match &t1 {
            Some(t) => {
                let den = t.suffix == "UNIT1"
                    && t.ents.get("rec") != Some("denoised")
                    && !inversions.is_empty();
                format!(
                    "{}{}",
                    t.file_name(),
                    if den { " (denoised with -mp2rage)" } else { "" }
                )
            }
            None => "SynthSR of the mean BOLD reference (no T1w)".into(),
        };
        let multi = if me > 0 {
            format!(", {me} multi-echo")
        } else {
            String::new()
        };
        c.h.log(&format!(
            "sub-{}: anat from {from}, {} BOLD run(s){multi}",
            s.label,
            bolds.len()
        ));
        let groups = bids::fieldmap_groups(&s.fmap);
        // MEDIC needs no fieldmap
        let mut fmap_of: Vec<Option<String>> = bolds
            .iter()
            .map(|b| {
                if b.phases.is_empty() {
                    bids::fieldmap_for(b, &groups)
                } else {
                    None
                }
            })
            .collect();
        let mut bad: Vec<(String, String)> = vec![];
        for k in fmap_of.iter().flatten() {
            if bad.iter().any(|(b, _)| b == k) {
                continue;
            }
            let fs = &groups.iter().find(|(g, _)| g == k).unwrap().1;
            if let Some(problem) = bids::fieldmap_problem(fs) {
                if !fs
                    .iter()
                    .any(|f| f.suffix == "phasediff" || f.suffix == "epi")
                {
                    return Err(format!("fieldmap {k}: {problem}\n{FMAP_FORMS}")); // a form never seen: stop
                }
                bad.push((k.clone(), problem));
            }
        }
        // a supported form with defective data (or a deferred PEPOLAR pair): flagged, not used
        let unusable: Vec<Option<String>> = fmap_of
            .iter()
            .map(|k| {
                let k = k.as_ref()?;
                bad.iter()
                    .find(|(b, _)| b == k)
                    .map(|(_, p)| format!("fieldmap {k} unusable: {p}"))
            })
            .collect();
        for k in fmap_of.iter_mut() {
            if k.as_ref().is_some_and(|k| bad.iter().any(|(b, _)| b == k)) {
                *k = None;
            }
        }
        let synthsr = if t1.is_some() {
            o.synthsr.as_str()
        } else {
            "off"
        }; // an EPI-derived T1w can't correct the EPI
        for ((b, k), u) in bolds.iter().zip(&fmap_of).zip(&unusable) {
            let sdc = if !b.phases.is_empty() {
                Some("MEDIC".to_string())
            } else {
                k.as_ref().map(|k| format!("fmap {k}"))
            };
            let sdc = match sdc {
                Some(s) if synthsr == "all" => format!("{s} + SynthSR"),
                Some(s) => s,
                None if synthsr != "off" => "SynthSR".into(),
                None => "none".into(),
            };
            let warn = u
                .as_ref()
                .map_or(String::new(), |u| format!(", WARNING {u}"));
            c.h.log(&format!("  {}: SDC {sdc}{warn}", b.name()));
        }
        // ponytail: sequential; anat overlapping BOLD fits (as fastprep.py) comes with bounded native scheduling
        let mut fmaps: Vec<(String, Rc<stages::Fmap>)> = vec![];
        for k in fmap_of.iter().flatten() {
            if !fmaps.iter().any(|(f, _)| f == k) {
                let fs = &groups.iter().find(|(g, _)| g == k).unwrap().1;
                fmaps.push((k.clone(), Rc::new(stages::fieldmap(c, k, fs).await?)));
            }
        }
        let fm = |k: &Option<String>| {
            k.as_ref()
                .and_then(|k| fmaps.iter().find(|(f, _)| f == k))
                .map(|(_, f)| f.clone())
        };
        let t1 = match t1 {
            Some(t) => t,
            None => {
                // ponytail: one synthetic T1w per subject (all sessions)
                let mut refs = vec![];
                for ((b, k), u) in bolds.iter().zip(&fmap_of).zip(&unusable) {
                    if let Fitted::Reference(r) =
                        stages::bold_fit(c, b, None, fm(k), u.clone(), synthsr, &o.frisgo).await?
                    {
                        refs.push(r);
                    }
                }
                stages::synth_t1w(c, &s.label, &refs, &bolds).await?
            }
        };
        let topofit = o.surfaces && !t1.meta.contains_key("SynthesizedFrom");
        let anat = stages::anat(c, &t1, o.robustfov, inversions, topofit).await?;
        let mut runs = vec![];
        for ((b, k), u) in bolds.iter().zip(&fmap_of).zip(&unusable) {
            let Fitted::Full(fit) =
                stages::bold_fit(c, b, Some(&anat), fm(k), u.clone(), synthsr, &o.frisgo).await?
            else {
                unreachable!()
            };
            stages::bold_apply(c, b, &fit, &anat).await?;
            stages::bold_meica(c, b, &fit, &o.meica, &o.meica_tree).await?;
            runs.push((b.clone(), *fit));
        }
        done.push(Subject {
            label: s.label,
            t1,
            anat,
            runs,
        });
    }
    for s in &done {
        let mut runs: Vec<Run> = vec![];
        for (bold, fit) in &s.runs {
            let p = join(crate::host::parent(&fit.nss), "meica.json");
            let meica = if c.h.exists(&p) {
                Some(c.json(&p).await?)
            } else {
                None
            };
            runs.push(Run { bold, fit, meica });
        }
        report::report(c, &s.label, &s.t1, &s.anat, &runs, t0).await?;
    }
    let (prev, n) = c.wall;
    if c.computed() || n == 0 {
        let wall = json!({"seconds": prev + c.h.now() - t0, "invocations": n + 1});
        c.h.write(&join(&c.work, "wall.json"), wall.to_string().as_bytes())
            .await?;
    }
    c.h.log(&format!("done in {:.1}s", c.h.now() - t0));
    Ok(())
}
