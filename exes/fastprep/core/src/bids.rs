//! BIDS discovery and the metadata-driven choices of fastprep.py: T1w, multi-echo grouping, fieldmaps.

use crate::host::{Host, file_name, join, parent};
use crate::nifti::{self, Header};
use crate::py;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::rc::Rc;

pub const ENTITY_ORDER: [&str; 20] = [
    "sub", "ses", "task", "acq", "ce", "rec", "dir", "run", "echo", "inv", "part", "space", "res",
    "label", "hemi", "from", "to", "mode", "stat", "desc",
];
const T1W_SUFFIXES: [&str; 3] = ["T1w", "T1wRMS", "UNIT1"]; // T1wRMS: echo-combined MPRAGE; UNIT1: MP2RAGE uniform
const JSON_LIMIT: usize = 16 << 20;

/// Ordered BIDS entities (file-name order, as Python dicts keep it).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Ents(pub Vec<(String, String)>);

impl Ents {
    pub fn get(&self, k: &str) -> Option<&str> {
        self.0.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }
    pub fn without(&self, drop: &[&str]) -> Ents {
        Ents(
            self.0
                .iter()
                .filter(|(k, _)| !drop.contains(&k.as_str()))
                .cloned()
                .collect(),
        )
    }
    /// Dict equality: order-insensitive.
    pub fn same(&self, o: &Ents) -> bool {
        self.0.len() == o.0.len() && self.0.iter().all(|(k, v)| o.get(k) == Some(v))
    }
    pub fn joined(&self) -> String {
        self.0
            .iter()
            .map(|(k, v)| format!("{k}-{v}"))
            .collect::<Vec<_>>()
            .join("_")
    }
}

#[derive(Clone)]
pub struct Image {
    pub path: String,
    /// Relative to the BIDS root; derivatives mirror it.
    pub rel: String,
    pub ents: Ents,
    pub suffix: String,
    pub hdr: Rc<Header>,
    /// Inherited BIDS sidecar.
    pub meta: Rc<Map<String, Value>>,
    /// Multi-echo BOLD: magnitude echoes by EchoTime, and their part-phase twins (enables MEDIC).
    pub echoes: Vec<Image>,
    pub phases: Vec<Image>,
}

impl Image {
    pub fn name(&self) -> String {
        format!("{}_{}", self.ents.joined(), self.suffix)
    }
    pub fn file_name(&self) -> &str {
        file_name(&self.path)
    }
    pub fn f64(&self, k: &str) -> Option<f64> {
        self.meta.get(k).and_then(Value::as_f64)
    }
    pub fn str(&self, k: &str) -> Option<&str> {
        self.meta.get(k).and_then(Value::as_str)
    }
}

/// fastprep.py `parse_name`: strict `key-value` pairs before the suffix.
pub fn parse_name(file: &str) -> Result<(Ents, String), String> {
    let stem = file.split('.').next().unwrap();
    let mut parts: Vec<&str> = stem.split('_').collect();
    let suffix = parts.pop().unwrap().to_string();
    let ents = parts
        .iter()
        .map(|p| {
            p.split_once('-')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| format!("{file}: not a BIDS name (entity without '-')"))?;
    Ok((Ents(ents), suffix))
}

/// pybabel `_parse_bids`: tolerant of parts without '-'.
fn loose_name(file: &str) -> (Vec<(String, String)>, String) {
    let stem = file.split_once('.').map_or(file, |(s, _)| s);
    let parts: Vec<&str> = stem.split('_').collect();
    let ents = parts[..parts.len() - 1]
        .iter()
        .filter_map(|p| {
            p.split_once('-')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect();
    (ents, parts[parts.len() - 1].to_string())
}

pub struct Subject {
    pub label: String,
    pub anat: Vec<Image>,
    pub func: Vec<Image>,
    pub fmap: Vec<Image>,
}

fn required(suffix: &str) -> &'static [&'static str] {
    match suffix {
        "bold" => &["RepetitionTime", "TaskName"],
        "phasediff" => &["EchoTime1", "EchoTime2"],
        "epi" => &["PhaseEncodingDirection"],
        _ => &[],
    }
}

struct Sidecars<'a, H: Host> {
    h: &'a H,
    root: &'a str,
    /// directory (relative) -> file names in it
    dirs: BTreeMap<String, Vec<String>>,
    cache: BTreeMap<String, Map<String, Value>>,
}

impl<H: Host> Sidecars<'_, H> {
    /// pybabel `get_metadata`: sidecars with the same suffix and a subset of the entities, from the dataset root
    /// (nearest dataset_description.json) down to the file's directory; deeper and more specific ones win.
    async fn metadata(&mut self, rel: &str) -> Result<Map<String, Value>, String> {
        let (ents, suffix) = loose_name(file_name(rel));
        let mut chain = vec![];
        let mut d = parent(rel).to_string();
        loop {
            chain.push(d.clone());
            if self
                .dirs
                .get(&d)
                .is_some_and(|fs| fs.iter().any(|f| f == "dataset_description.json"))
            {
                break;
            }
            if d.is_empty() {
                chain.truncate(1); // ponytail: no dataset root inside the BIDS dir: only the file's directory
                break;
            }
            d = parent(&d).to_string();
        }
        let mut meta = Map::new();
        for d in chain.iter().rev() {
            let mut found: Vec<(usize, String)> = vec![];
            for f in self.dirs.get(d).into_iter().flatten() {
                if !f.ends_with(".json") || f == "dataset_description.json" {
                    continue;
                }
                let (e, s) = loose_name(f);
                if s == suffix
                    && e.iter()
                        .all(|(k, v)| ents.iter().any(|(a, b)| a == k && b == v))
                {
                    found.push((e.len(), f.clone()));
                }
            }
            found.sort();
            for (_, f) in found {
                let path = join(&join(self.root, d), &f);
                if !self.cache.contains_key(&path) {
                    let text = self.h.read_text(&path, JSON_LIMIT).await?;
                    let v: Map<String, Value> =
                        serde_json::from_str(text.trim_start_matches('\u{feff}'))
                            .map_err(|e| format!("{path}: {e}"))?;
                    self.cache.insert(path.clone(), v);
                }
                meta.extend(self.cache[&path].clone());
            }
        }
        Ok(meta)
    }
}

/// Subjects in label order, each with its anat/func/fmap images; headers and sidecars read once.
pub async fn discover<H: Host>(
    h: &H,
    bids: &str,
    labels: &[String],
) -> Result<Vec<Subject>, String> {
    let mut files = h.list(bids);
    // Path order: compare component tuples, as pathlib does
    files.sort_by(|a, b| a.split('/').cmp(b.split('/')));
    let mut dirs: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for f in &files {
        dirs.entry(parent(f).to_string())
            .or_default()
            .push(file_name(f).to_string());
    }
    let mut sc = Sidecars {
        h,
        root: bids,
        dirs,
        cache: BTreeMap::new(),
    };
    let mut subjects: Vec<Subject> = vec![];
    for rel in &files {
        let Some((sub, rest)) = rel.split_once('/') else {
            continue;
        };
        if !sub.starts_with("sub-") || !file_name(rest).contains(".nii") {
            continue;
        }
        let label = &sub[4..];
        if !labels.is_empty() && !labels.iter().any(|l| l == label) {
            continue;
        }
        if subjects.last().is_none_or(|s| s.label != label) {
            subjects.push(Subject {
                label: label.into(),
                anat: vec![],
                func: vec![],
                fmap: vec![],
            });
        }
        let datatype = file_name(parent(rel));
        if !["anat", "func", "fmap"].contains(&datatype) {
            continue;
        }
        let path = join(bids, rel);
        let (ents, suffix) = parse_name(file_name(rel))?;
        let hdr = nifti::read(h, &path).await?;
        let meta = sc.metadata(rel).await?;
        if meta.is_empty() {
            return Err(format!("missing JSON sidecar: {path}"));
        }
        let missing: Vec<&str> = required(&suffix)
            .iter()
            .copied()
            .filter(|k| !meta.contains_key(*k))
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "{}: sidecar lacks {}",
                file_name(rel),
                py::list_repr(&missing)
            ));
        }
        let img = Image {
            path,
            rel: rel.clone(),
            ents,
            suffix,
            hdr: Rc::new(hdr),
            meta: Rc::new(meta),
            echoes: vec![],
            phases: vec![],
        };
        let s = subjects.last_mut().unwrap();
        match datatype {
            "anat" => s.anat.push(img),
            "func" => s.func.push(img),
            _ => s.fmap.push(img),
        }
    }
    if subjects.is_empty() {
        return Err(format!("no subjects found in {bids}"));
    }
    Ok(subjects)
}

/// Magnitude BOLD runs; a multi-echo run is its first echo (echo entity dropped) carrying all echoes.
pub fn bold_runs(func: &[Image]) -> Result<Vec<Image>, String> {
    let mut groups: Vec<(Ents, Vec<&Image>)> = vec![];
    for i in func.iter().filter(|i| i.suffix == "bold") {
        let key = i.ents.without(&["echo", "part"]);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, g)) => g.push(i),
            None => groups.push((key, vec![i])),
        }
    }
    let mut runs = vec![];
    for (_, imgs) in groups {
        let by_te = |part: &str| {
            let mut v: Vec<&Image> = imgs
                .iter()
                .copied()
                .filter(|i| i.ents.get("part").unwrap_or("mag") == part)
                .collect();
            v.sort_by(|a, b| {
                a.f64("EchoTime")
                    .unwrap_or(0.0)
                    .total_cmp(&b.f64("EchoTime").unwrap_or(0.0))
            });
            v
        };
        let (mags, mut phases) = (by_te("mag"), by_te("phase"));
        if mags.len() < 2 {
            runs.extend(mags.into_iter().cloned());
            continue;
        }
        if mags.iter().any(|m| m.f64("EchoTime").is_none()) {
            return Err(format!(
                "{}: multi-echo BOLD needs EchoTime in every sidecar",
                mags[0].name()
            ));
        }
        let te = |v: &[&Image]| v.iter().map(|i| i.f64("EchoTime")).collect::<Vec<_>>();
        if te(&phases) != te(&mags) {
            phases.clear(); // ponytail: phase only used when every echo has it
        }
        let mut run = mags[0].clone();
        run.ents = run.ents.without(&["echo"]);
        run.echoes = mags.into_iter().cloned().collect();
        run.phases = phases.into_iter().cloned().collect();
        runs.push(run);
    }
    Ok(runs)
}

/// `--t1w` file-name glob if given; else gradient-corrected first, then denoised MP2RAGE UNI, T1wRMS, an echo-free
/// T1w, the first echo, raw UNI.
pub fn pick_t1w<'a>(anat: &'a [Image], pattern: Option<&str>) -> Result<Option<&'a Image>, String> {
    if let Some(p) = pattern {
        let hits: Vec<&Image> = anat
            .iter()
            .filter(|i| py::fnmatch(i.file_name(), file_name(p)))
            .collect();
        if hits.len() != 1 {
            return Err(format!("--t1w {p}: matched {} images", hits.len()));
        }
        return Ok(Some(hits[0]));
    }
    let key = |i: &Image| {
        let rank = match i.suffix.as_str() {
            "UNIT1" if i.ents.get("rec") == Some("denoised") => 0,
            "UNIT1" => 3,
            "T1wRMS" => 1,
            _ => 2,
        };
        (
            i.meta.get("NonlinearGradientCorrection") == Some(&Value::Bool(false)),
            rank,
            i.ents.get("echo").is_some(),
            i.ents.get("part").unwrap_or("mag") != "mag",
            i.ents
                .get("echo")
                .map_or(1, |e| e.parse::<i64>().unwrap_or(i64::MAX)),
            i.file_name().to_string(),
        )
    };
    Ok(anat
        .iter()
        .filter(|i| T1W_SUFFIXES.contains(&i.suffix.as_str()))
        .min_by_key(|i| key(i)))
}

/// (inv-1, inv-2) MP2RAGE images of a UNIT1 with the same entities, else empty.
pub fn mp2rage_inversions(t1: &Image, anat: &[Image]) -> Vec<Image> {
    if t1.suffix != "UNIT1" {
        return vec![];
    }
    let base = t1.ents.without(&["rec"]);
    let mut inv: BTreeMap<Option<String>, &Image> = BTreeMap::new();
    for i in anat
        .iter()
        .filter(|i| i.suffix == "MP2RAGE" && i.ents.without(&["inv"]).same(&base))
    {
        inv.insert(i.ents.get("inv").map(String::from), i);
    }
    match (inv.get(&Some("1".into())), inv.get(&Some("2".into()))) {
        (Some(a), Some(b)) => vec![(*a).clone(), (*b).clone()],
        _ => vec![],
    }
}

/// Fieldmap groups in first-seen order: B0FieldIdentifier, else the fieldmap's entities without dir.
pub fn fieldmap_groups(fmaps: &[Image]) -> Vec<(String, Vec<Image>)> {
    let mut groups: Vec<(String, Vec<Image>)> = vec![];
    for f in fmaps {
        let key = match f.str("B0FieldIdentifier") {
            Some(k) if !k.is_empty() => k.to_string(),
            _ => f.ents.without(&["dir"]).joined(),
        };
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, g)) => g.push(f.clone()),
            None => groups.push((key, vec![f.clone()])),
        }
    }
    groups
}

/// BIDS TotalReadoutTime, else EffectiveEchoSpacing * (PE voxels - 1).
pub fn readout_time(img: &Image) -> Option<f64> {
    if let Some(t) = img.f64("TotalReadoutTime") {
        return Some(t);
    }
    let pe = img
        .str("PhaseEncodingDirection")
        .filter(|p| !p.is_empty())?;
    let ees = img.f64("EffectiveEchoSpacing")?;
    let axis = "ijk".find(pe.get(..1)?)?;
    let n = img
        .f64("ReconMatrixPE")
        .filter(|&n| n != 0.0)
        .unwrap_or(*img.hdr.shape.get(axis)? as f64);
    Some(ees * (n - 1.0))
}

pub const FMAP_FORMS: &str = "supported fieldmaps: phasediff + magnitude1/2 (BIDS case 1, as FSL fsl_prepare_fieldmap/FUGUE), \
or an opposite-PE epi pair (case 4); see https://fsl.fmrib.ox.ac.uk/fsl/docs/registration/fugue.html";
pub const PEPOLAR_DEFERRED: &str =
    "opposite-PE epi (PEPOLAR) correction is not supported in this version";

/// Why a fieldmap group can't be used (None if fine). Only forms seen in test data pass, so unusual preparations
/// fail loudly instead of silently mis-correcting. A valid PEPOLAR pair is reported as deferred.
pub fn fieldmap_problem(fmaps: &[Image]) -> Option<String> {
    let by = |s: &str| fmaps.iter().rev().find(|f| f.suffix == s);
    if let Some(pd) = by("phasediff") {
        let dte = 1000.0
            * (pd.f64("EchoTime2").unwrap_or(f64::NAN) - pd.f64("EchoTime1").unwrap_or(f64::NAN));
        if !(0.5..=10.0).contains(&dte) {
            return Some(format!(
                "EchoTime2 - EchoTime1 = {dte:.2} ms; expected 0.5-10 ms (e.g. 2.46 ms on Siemens 3T)"
            ));
        }
        if pd.hdr.ndim() != 3 {
            return Some(format!(
                "{} is {}D; expected one 3D wrapped phase difference",
                pd.file_name(),
                pd.hdr.ndim()
            ));
        }
        let mags: Vec<&Image> = ["magnitude1", "magnitude2"]
            .iter()
            .filter_map(|k| by(k))
            .collect();
        if mags.is_empty() {
            return Some("phasediff without magnitude1 (it supplies the brain mask)".into());
        }
        let same = |a: &[[f64; 4]; 3], b: &[[f64; 4]; 3]| {
            a.iter()
                .flatten()
                .zip(b.iter().flatten())
                .all(|(x, y)| (x - y).abs() < 1e-3)
        };
        for m in mags {
            let s3 = |i: &Image| i.hdr.shape.iter().take(3).copied().collect::<Vec<_>>();
            if s3(m) != s3(pd) || !same(&m.hdr.affine, &pd.hdr.affine) {
                return Some(format!("{} is not on the phasediff grid", m.file_name()));
            }
        }
        return None;
    }
    if by("phase1").is_some() || by("phase2").is_some() {
        return Some("phase1/phase2 pair (BIDS case 2) is not supported yet".into());
    }
    if let Some(f) = by("fieldmap") {
        let units = f.str("Units").map_or("None".into(), |u| format!("'{u}'"));
        return Some(format!(
            "direct fieldmap (BIDS case 3, Units {units}) is not supported yet"
        ));
    }
    let mut pes: Vec<&str> = fmaps
        .iter()
        .filter(|f| f.suffix == "epi")
        .filter_map(|f| f.str("PhaseEncodingDirection"))
        .collect();
    pes.sort();
    if pes.len() != 2 || pes[0].get(..1) != pes[1].get(..1) || pes[0] == pes[1] {
        let got = if pes.is_empty() {
            let mut seen: Vec<&str> = vec![];
            for f in fmaps {
                if !seen.contains(&f.suffix.as_str()) {
                    seen.push(&f.suffix);
                }
            }
            py::list_repr(&seen)
        } else {
            py::list_repr(&pes)
        };
        return Some(format!(
            "epi fieldmaps need one image per polarity on one axis (got {got})"
        ));
    }
    let mut tros: Vec<Option<f64>> = vec![];
    for t in fmaps.iter().map(readout_time) {
        if !tros.contains(&t) {
            tros.push(t);
        }
    }
    if tros.contains(&None) || tros.len() != 1 {
        let set: Vec<String> = tros
            .iter()
            .map(|t| t.map_or("None".into(), py::repr))
            .collect();
        return Some(format!(
            "epi pair needs one TotalReadoutTime (or EffectiveEchoSpacing); got {{{}}}",
            set.join(", ")
        ));
    }
    Some(PEPOLAR_DEFERRED.into())
}

/// Group key for a BOLD run: its B0FieldSource, else the group whose IntendedFor names it, else (older datasets)
/// an opposite-PE epi pair on the BOLD's PE axis with its readout time.
pub fn fieldmap_for(bold: &Image, groups: &[(String, Vec<Image>)]) -> Option<String> {
    let has = |k: &str| groups.iter().any(|(g, _)| g == k);
    match bold.meta.get("B0FieldSource") {
        Some(Value::String(s)) if has(s) => return Some(s.clone()),
        Some(Value::Array(a)) => {
            if let Some(k) = a.iter().filter_map(Value::as_str).find(|k| has(k)) {
                return Some(k.to_string());
            }
        }
        _ => {}
    }
    let sub_rel = bold.rel.split_once('/').map_or("", |(_, r)| r); // IntendedFor is relative to the subject dir
    for (key, fs) in groups {
        for f in fs {
            let targets: Vec<&str> = match f.meta.get("IntendedFor") {
                Some(Value::String(s)) => vec![s.as_str()],
                Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
                _ => vec![],
            };
            if targets.iter().any(|t| {
                let t = t.strip_prefix("bids::").unwrap_or(t);
                t == sub_rel || t == bold.rel
            }) {
                return Some(key.clone());
            }
        }
    }
    let (pe, tro) = (
        bold.str("PhaseEncodingDirection")
            .filter(|p| !p.is_empty())?,
        readout_time(bold),
    );
    for (key, fs) in groups {
        let epis: Vec<&Image> = fs.iter().filter(|f| f.suffix == "epi").collect();
        let mut dirs: Vec<&str> = epis
            .iter()
            .filter_map(|f| f.str("PhaseEncodingDirection"))
            .collect();
        dirs.sort();
        dirs.dedup();
        if dirs.len() == 2
            && epis.iter().all(|f| {
                f.str("PhaseEncodingDirection").and_then(|p| p.get(..1)) == pe.get(..1)
                    && readout_time(f) == tro
                    && f.ents.get("ses") == bold.ents.get("ses")
            })
        {
            return Some(key.clone());
        }
    }
    None
}

/// Derivative path mirroring `rel`'s directory, entities overridden (None removes one).
pub fn deriv_path(
    ents: &Ents,
    rel: &str,
    out: &str,
    suffix: &str,
    ext: &str,
    over: &[(&str, Option<&str>)],
) -> String {
    let get = |k: &str| match over.iter().find(|(o, _)| *o == k) {
        Some((_, v)) => *v,
        None => ents.get(k),
    };
    let name: Vec<String> = ENTITY_ORDER
        .iter()
        .filter_map(|k| get(k).filter(|v| !v.is_empty()).map(|v| format!("{k}-{v}")))
        .collect();
    join(
        &join(out, parent(rel)),
        &format!("{}_{suffix}{ext}", name.join("_")),
    )
}

/// Largest gap between two world transforms over the corners of a brain-sized box (+-r mm).
pub fn disagreement_mm(a: &[Vec<f64>], b: &[Vec<f64>], r: f64) -> f64 {
    let mv = |m: &[Vec<f64>], p: [f64; 3]| -> [f64; 3] {
        std::array::from_fn(|i| (0..3).map(|j| m[i][j] * p[j]).sum::<f64>() + m[i][3])
    };
    let mut worst = 0f64;
    for x in [-r, r] {
        for y in [-r, r] {
            for z in [-r, r] {
                let (p, q) = (mv(a, [x, y, z]), mv(b, [x, y, z]));
                worst = worst.max(
                    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt(),
                );
            }
        }
    }
    worst
}

/// Per-axis scale of a world transform: column norms of its linear part.
pub fn axis_zooms(m: &[Vec<f64>]) -> [f64; 3] {
    std::array::from_fn(|j| (m[0][j].powi(2) + m[1][j].powi(2) + m[2][j].powi(2)).sqrt())
}

pub fn affine_rows(a: &[[f64; 4]; 3]) -> Vec<Vec<f64>> {
    a.iter().map(|r| r.to_vec()).collect()
}

/// ('ascending'|'descending'|'interleaved', multiband factor) from BIDS SliceTiming.
/// A sidecar's SliceTiming, if it is a non-empty list of numbers; anything malformed counts as absent.
pub fn slice_timing(meta: &Map<String, Value>) -> Option<&Vec<Value>> {
    meta.get("SliceTiming")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty() && a.iter().all(Value::is_number))
}

/// niimath's -stc indexes SliceTiming along voxel k; BIDS entries follow SliceEncodingDirection (default k).
pub fn slice_encoding(meta: &Map<String, Value>) -> &str {
    meta.get("SliceEncodingDirection")
        .and_then(Value::as_str)
        .unwrap_or("k")
}

/// Whether slice-timing correction runs: usable SliceTiming along a k slice axis.
pub fn stc_applies(meta: &Map<String, Value>) -> bool {
    slice_timing(meta).is_some() && slice_encoding(meta).starts_with('k')
}

pub fn slice_order(st: &[f64]) -> (&'static str, usize) {
    let mut times = st.to_vec();
    times.sort_by(f64::total_cmp);
    times.dedup();
    let first: Vec<usize> = times
        .iter()
        .map(|t| st.iter().position(|s| s == t).unwrap())
        .collect();
    let mut sorted = first.clone();
    sorted.sort();
    let rev: Vec<usize> = sorted.iter().rev().copied().collect();
    let order = if first == sorted {
        "ascending"
    } else if first == rev {
        "descending"
    } else {
        "interleaved"
    };
    (order, st.len() / times.len())
}

/// 'anterior-to-posterior' etc. for a BIDS PhaseEncodingDirection, from the image orientation.
pub fn pe_words(affine: &[[f64; 4]; 3], pe: &str) -> String {
    let c = pe.get(..1).and_then(|p| "ijk".find(p)).unwrap_or(0);
    let col: Vec<f64> = (0..3).map(|r| affine[r][c]).collect();
    let axis = (0..3).fold(0, |b, r| if col[r].abs() > col[b].abs() { r } else { b });
    let toward = if (col[axis] > 0.0) != pe.ends_with('-') {
        b"RAS"[axis]
    } else {
        b"LPI"[axis]
    } as char;
    let opposite = |c: char| "LPIRAS".chars().nth("RASLPI".find(c).unwrap()).unwrap();
    let name = |c: char| match c {
        'R' => "right",
        'L' => "left",
        'A' => "anterior",
        'P' => "posterior",
        'S' => "superior",
        _ => "inferior",
    };
    format!("{}-to-{}", name(opposite(toward)), name(toward))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hdr(shape: &[usize], affine: [[f64; 4]; 3]) -> Rc<Header> {
        Rc::new(Header {
            shape: shape.to_vec(),
            zooms: vec![1.0; shape.len()],
            affine,
        })
    }
    const GRID: [[f64; 4]; 3] = [
        [2.0, 0.0, 0.0, 0.0],
        [0.0, 2.0, 0.0, 0.0],
        [0.0, 0.0, 3.0, 0.0],
    ];

    fn img(rel: &str, meta: Value) -> Image {
        img_on(rel, &[90, 90, 38], meta)
    }
    fn img_on(rel: &str, shape: &[usize], meta: Value) -> Image {
        let (ents, suffix) = parse_name(file_name(rel)).unwrap();
        Image {
            path: rel.into(),
            rel: rel.into(),
            ents,
            suffix,
            hdr: hdr(shape, GRID),
            meta: Rc::new(meta.as_object().unwrap().clone()),
            echoes: vec![],
            phases: vec![],
        }
    }

    #[test]
    fn naming() {
        let rel = "sub-cr/ses-1/anat/sub-cr_ses-1_acq-mprage_T1w.nii.gz";
        let (ents, suffix) = parse_name(file_name(rel)).unwrap();
        assert_eq!(ents.joined(), "sub-cr_ses-1_acq-mprage");
        assert_eq!(suffix, "T1w");
        let over = [
            ("desc", Some("affine")),
            ("space", None),
            ("from", Some("T1w")),
            ("to", Some("MNI")),
        ];
        assert_eq!(
            deriv_path(&ents, rel, "/tmp/out", "xfm", ".mat", &over),
            "/tmp/out/sub-cr/ses-1/anat/sub-cr_ses-1_acq-mprage_from-T1w_to-MNI_desc-affine_xfm.mat"
        );
        assert!(parse_name("sub-x_bad_T1w.nii").is_err());
    }

    #[test]
    fn multiecho_grouping() {
        let stem = |e: u32, part: &str| {
            format!("sub-fm/func/sub-fm_task-r_run-02_echo-{e}_part-{part}_bold.nii.gz")
        };
        let mut func = vec![];
        for (e, te) in [(2, 0.03), (1, 0.014), (3, 0.046)] {
            for part in ["phase", "mag"] {
                func.push(img(&stem(e, part), json!({"EchoTime": te})));
            }
        }
        func.push(img(
            "sub-fm/func/sub-fm_task-s_bold.nii.gz",
            json!({"EchoTime": 0.03}),
        ));
        let mut runs = bold_runs(&func).unwrap();
        runs.sort_by_key(|b| std::cmp::Reverse(b.echoes.len()));
        let (me, se) = (&runs[0], &runs[1]);
        assert_eq!(me.name(), "sub-fm_task-r_run-02_part-mag_bold");
        let echo = |v: &[Image]| {
            v.iter()
                .map(|i| i.ents.get("echo").unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(echo(&me.echoes), ["1", "2", "3"]);
        assert_eq!(echo(&me.phases), ["1", "2", "3"]);
        assert!(se.name() == "sub-fm_task-s_bold" && se.echoes.is_empty());
    }

    #[test]
    fn t1w_and_fieldmap_fallback() {
        let mut anat: Vec<Image> = [(1, "mag"), (1, "phase"), (2, "mag"), (2, "phase")]
            .iter()
            .map(|(e, p)| {
                img(
                    &format!("sub-x/sub-x_acq-mpr_echo-{e}_part-{p}_T1w.nii.gz"),
                    json!({}),
                )
            })
            .collect();
        assert_eq!(
            pick_t1w(&anat, None).unwrap().unwrap().name(),
            "sub-x_acq-mpr_echo-1_part-mag_T1w"
        );
        anat.push(img("sub-x/sub-x_acq-mpr_T1wRMS.nii.gz", json!({})));
        assert_eq!(
            pick_t1w(&anat, None).unwrap().unwrap().name(),
            "sub-x_acq-mpr_T1wRMS"
        );
        let hit = pick_t1w(
            &anat,
            Some("/data/sub-x_acq-mpr_echo-2_part-mag_T1w.nii.gz"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(hit.ents.get("echo"), Some("2"));
        let mut mp = vec![];
        for a in ["g", "gND"] {
            for s in [
                "UNIT1",
                "rec-denoised_UNIT1",
                "inv-1_MP2RAGE",
                "inv-2_MP2RAGE",
            ] {
                mp.push(img(
                    &format!("sub-x/sub-x_acq-{a}_{s}.nii.gz"),
                    json!({"NonlinearGradientCorrection": a == "g"}),
                ));
            }
        }
        assert_eq!(
            pick_t1w(&mp, None).unwrap().unwrap().name(),
            "sub-x_acq-g_rec-denoised_UNIT1"
        );
        let raw_pool: Vec<Image> = mp
            .iter()
            .filter(|i| i.ents.get("rec") != Some("denoised"))
            .cloned()
            .collect();
        let raw = pick_t1w(&raw_pool, None).unwrap().unwrap();
        assert_eq!(raw.name(), "sub-x_acq-g_UNIT1");
        let names: Vec<String> = mp2rage_inversions(raw, &mp)
            .iter()
            .map(Image::name)
            .collect();
        assert_eq!(
            names,
            ["sub-x_acq-g_inv-1_MP2RAGE", "sub-x_acq-g_inv-2_MP2RAGE"]
        );
        assert!(mp2rage_inversions(anat.last().unwrap(), &mp).is_empty());
        let pe = |d: &str| json!({"PhaseEncodingDirection": d, "TotalReadoutTime": 0.06});
        let fmaps = vec![
            img(
                "sub-x/sub-x_acq-gre_phasediff.nii.gz",
                json!({"EchoTime1": 0.005, "EchoTime2": 0.007}),
            ),
            img("sub-x/sub-x_acq-se_dir-AP_epi.nii.gz", pe("j-")),
            img("sub-x/sub-x_acq-se_dir-PA_epi.nii.gz", pe("j")),
        ];
        let groups = fieldmap_groups(&fmaps);
        assert_eq!(
            fieldmap_for(&img("sub-x/sub-x_task-rest_bold.nii.gz", pe("j-")), &groups).as_deref(),
            Some("sub-x_acq-se")
        );
        assert_eq!(
            fieldmap_for(&img("sub-x/sub-x_task-rest_bold.nii.gz", pe("i")), &groups),
            None
        );
    }

    #[test]
    fn fieldmap_validation() {
        let pd = img(
            "sub-x/fmap/sub-x_phasediff.nii.gz",
            json!({"EchoTime1": 0.00492, "EchoTime2": 0.00738}),
        );
        let m1 = img("sub-x/fmap/sub-x_magnitude1.nii.gz", json!({}));
        assert_eq!(
            fieldmap_problem(&[
                pd.clone(),
                m1.clone(),
                img("sub-x/fmap/sub-x_magnitude2.nii.gz", json!({}))
            ]),
            None
        );
        assert!(
            fieldmap_problem(&[pd.clone()])
                .unwrap()
                .contains("without magnitude1")
        );
        let small = img_on(
            "sub-x/fmap/sub-x_magnitude1.nii.gz",
            &[64, 64, 38],
            json!({}),
        );
        assert!(
            fieldmap_problem(&[pd, small])
                .unwrap()
                .contains("not on the phasediff grid")
        );
        let swapped = img(
            "sub-x/fmap/sub-x_phasediff.nii.gz",
            json!({"EchoTime1": 0.007, "EchoTime2": 0.005}),
        );
        assert!(
            fieldmap_problem(&[swapped, m1.clone()])
                .unwrap()
                .contains("ms")
        );
        let p = |n: &str| {
            img(
                &format!("sub-x/fmap/sub-x_{n}.nii.gz"),
                json!({"Units": "Hz"}),
            )
        };
        assert!(
            fieldmap_problem(&[p("phase1"), p("phase2"), m1])
                .unwrap()
                .contains("case 2")
        );
        assert!(
            fieldmap_problem(&[p("fieldmap"), p("magnitude")])
                .unwrap()
                .contains("case 3")
        );
        let epi = |d: &str, pe: &str| {
            img(
                &format!("sub-x/fmap/sub-x_dir-{d}_epi.nii.gz"),
                json!({"PhaseEncodingDirection": pe, "TotalReadoutTime": 0.04}),
            )
        };
        assert_eq!(
            fieldmap_problem(&[epi("AP", "j-"), epi("PA", "j")]).as_deref(),
            Some(PEPOLAR_DEFERRED)
        );
        assert!(
            fieldmap_problem(&[epi("AP", "j"), epi("PA", "j")])
                .unwrap()
                .contains("one image per polarity")
        );
        let bold = img_on(
            "sub-x/func/sub-x_bold.nii.gz",
            &[90, 90, 68, 300],
            json!({"PhaseEncodingDirection": "j", "EffectiveEchoSpacing": 0.0005}),
        );
        assert!((readout_time(&bold).unwrap() - 0.0005 * 89.0).abs() < 1e-12);
    }

    #[test]
    fn geometry() {
        let m = |r: [[f64; 4]; 3]| affine_rows(&r);
        let eye = m([
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
        ]);
        let shift = m([
            [1.0, 0.0, 0.0, 3.0],
            [0.0, 1.0, 0.0, 4.0],
            [0.0, 0.0, 1.0, 0.0],
        ]);
        assert!((disagreement_mm(&eye, &shift, 80.0) - 5.0).abs() < 1e-9);
        let rot = m([
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, -1.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
        ]);
        assert!(disagreement_mm(&eye, &rot, 80.0) > 100.0);
        let fast = m([
            [0.891, 0.017, 0.01, 0.0],
            [-0.012, 0.828, -0.032, 0.0],
            [0.0, 0.031, 0.944, 0.0],
        ]);
        assert_eq!(
            axis_zooms(&fast).map(|z| py::round(z, 3)),
            [0.891, 0.829, 0.945]
        );
        assert_eq!(axis_zooms(&rot), [1.0, 1.0, 1.0]);
    }

    #[test]
    fn methods_helpers() {
        assert_eq!(slice_order(&[0.0, 1.0, 2.0, 3.0]), ("ascending", 1));
        assert_eq!(slice_order(&[0.0, 2.0, 1.0, 3.0]), ("interleaved", 1));
        assert_eq!(slice_order(&[3.0, 2.0, 1.0, 0.0]), ("descending", 1));
        assert_eq!(slice_order(&[0.0, 1.0, 0.0, 1.0]), ("ascending", 2));
        let las = [
            [-2.0, 0.0, 0.0, 0.0],
            [0.0, 2.0, 0.0, 0.0],
            [0.0, 0.0, 2.0, 0.0],
        ];
        assert_eq!(pe_words(&las, "j-"), "anterior-to-posterior");
        assert_eq!(pe_words(&las, "j"), "posterior-to-anterior");
        assert_eq!(pe_words(&las, "i"), "right-to-left");
    }
}
