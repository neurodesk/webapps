//! HTML report: subject page with niimath -bitmap figures, methods text and the task-analysis page.

use crate::argv;
use crate::bids::{ENTITY_ORDER, Image, PEPOLAR_DEFERRED, axis_zooms, pe_words, slice_order};
use crate::host::{Host, file_name, join, parent};
use crate::py::{self, escape as esc, g};
use crate::run::{Ctx, TEMPLATE};
use crate::stages::{Anat, Fit, invert_xfm, mp2rage_factor, short_run, tsnr_paths};
use serde_json::Value;
use std::cell::Cell;

mod refs {
    include!("assets/refs.rs");
}
const REPORT_CSS: &str = include_str!("assets/report.css");
const MOTION_CSS: &str = include_str!("assets/motion.css");
const SDC_JS: &str = include_str!("assets/sdc.js");
const THEME_TOGGLE: &str = include_str!("assets/theme-toggle.html");
const NUMBER_WORDS: [&str; 11] = [
    "No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
];
/// Keys and order match glm's task contrasts.
const TASK_CONTRASTS: [(&str, &str); 4] = [
    ("leftGreaterRight", "left > right [1 -1]"),
    ("rightGreaterLeft", "right > left [-1 1]"),
    ("leftActive", "left > baseline [1 0]"),
    ("rightActive", "right > baseline [0 1]"),
];
const BLOCK_FILL: [(&str, &str); 2] = [("left", "#8e44ad"), ("right", "#e67e22")];
const AXIS_STROKE: [&str; 3] = ["#d62728", "#2ca02c", "#1f77b4"]; // x y z as R G B

fn ms(x: f64) -> String {
    g(py::round(1000.0 * x, 2))
}

/// Python truthiness of an optional sidecar value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

/// Rows of a tab-separated file with a header line.
pub fn tsv(text: &str) -> Vec<Vec<(String, String)>> {
    let mut lines = text.lines().map(|l| l.trim_end_matches('\r'));
    let head: Vec<String> = lines
        .next()
        .unwrap_or("")
        .split('\t')
        .map(String::from)
        .collect();
    lines
        .filter(|l| !l.is_empty())
        .map(|l| {
            head.iter()
                .cloned()
                .zip(l.split('\t').map(String::from))
                .collect()
        })
        .collect()
}

fn field<'a>(row: &'a [(String, String)], k: &str) -> &'a str {
    row.iter()
        .find(|(a, _)| a == k)
        .map_or("", |(_, v)| v.as_str())
}

pub struct Run<'a> {
    pub bold: &'a Image,
    pub fit: &'a Fit,
}

fn tag(b: &Image) -> String {
    b.ents
        .0
        .iter()
        .filter(|(k, _)| !["sub", "ses", "part", "echo"].contains(&k.as_str()))
        .map(|(k, v)| format!("{k}-{v}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn names(bs: &[&Image]) -> String {
    let head: Vec<String> = bs[..bs.len() - 1].iter().map(|b| tag(b)).collect();
    format!(
        "{}{}{}",
        head.join(", "),
        if bs.len() > 1 { " and " } else { "" },
        tag(bs[bs.len() - 1])
    )
}

fn count(n: usize, noun: &str) -> String {
    if n < NUMBER_WORDS.len() {
        format!("{} {noun}", NUMBER_WORDS[n])
    } else {
        format!("{n} {noun}")
    }
}

/// Methods section (acquisition + processing) with numbered references, from sidecars and what ran.
pub fn methods(t1: &Image, runs: &[Run], anat: &Anat) -> String {
    let order: std::cell::RefCell<Vec<&str>> = Default::default();
    let cite = |keys: &[&'static str]| {
        let mut o = order.borrow_mut();
        for k in keys {
            if !o.contains(k) {
                o.push(k);
            }
        }
        format!(
            "[{}]",
            keys.iter()
                .map(|k| (o.iter().position(|x| x == k).unwrap() + 1).to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let m = &t1.meta;
    let has = |k: &str| m.contains_key(k);
    let scanner: Vec<String> = ["Manufacturer", "ManufacturersModelName"]
        .iter()
        .filter(|k| truthy(m.get(**k)))
        .map(|k| py::value(&m[*k]))
        .collect();
    let scanner = scanner.join(" ");
    let mut acq = vec![if has("MagneticFieldStrength") {
        format!(
            "Imaging data were acquired on a {scanner} {} T scanner",
            g(num(&m["MagneticFieldStrength"]))
        )
    } else {
        format!(
            "Imaging data were acquired on a {} scanner",
            if scanner.is_empty() { "MRI" } else { &scanner }
        )
    }];
    acq[0] += &if truthy(m.get("ReceiveCoilName")) {
        format!(" (receive coil: {}).", py::value(&m["ReceiveCoilName"]))
    } else {
        ".".into()
    };
    let vox = axis_zooms(&crate::bids::affine_rows(&t1.hdr.affine));
    let shape: Vec<String> = t1.hdr.shape.iter().take(3).map(|n| n.to_string()).collect();
    let mut t1p = vec![
        format!(
            "{} mm voxels",
            vox.iter()
                .map(|v| g(py::round(*v, 2)))
                .collect::<Vec<_>>()
                .join("×")
        ),
        format!("a {} matrix", shape.join("×")),
    ];
    for (k, f) in [
        ("repetition time (TR)", "RepetitionTime"),
        ("echo time (TE)", "EchoTime"),
        ("inversion time (TI)", "InversionTime"),
    ] {
        if has(f) {
            t1p.push(format!("{k} {} ms", ms(num(&m[f]))));
        }
    }
    if has("FlipAngle") {
        t1p.push(format!("flip angle {}°", g(num(&m["FlipAngle"]))));
    }
    let accel = m
        .get("ParallelReductionFactorInPlane")
        .and_then(Value::as_f64)
        .unwrap_or(1.0)
        > 1.0;
    if accel {
        t1p.push(format!(
            "×{} in-plane acceleration",
            g(num(&m["ParallelReductionFactorInPlane"]))
        ));
    }
    if !anat.synthetic.is_empty() {
        acq.push("No anatomical image was acquired.".into());
    } else if !anat.inversions.is_empty() {
        // MP2RAGE: TR, TIs and flip angles live in the inversion sidecars
        let (i1, i2) = (&anat.inversions[0].meta, &anat.inversions[1].meta);
        let tr = i1
            .get("RepetitionTimePreparation")
            .or(i1.get("RepetitionTime"));
        let mut mp = vec![];
        if truthy(tr) {
            mp.push(format!("TR {} ms", ms(num(tr.unwrap()))));
        }
        if i1.contains_key("EchoTime") {
            mp.push(format!("TE {} ms", ms(num(&i1["EchoTime"]))));
        }
        if i1.contains_key("InversionTime") && i2.contains_key("InversionTime") {
            mp.push(format!(
                "TI1/TI2 {}/{} ms",
                ms(num(&i1["InversionTime"])),
                ms(num(&i2["InversionTime"]))
            ));
        }
        if i1.contains_key("FlipAngle") && i2.contains_key("FlipAngle") {
            mp.push(format!(
                "flip angles {}°/{}°",
                g(num(&i1["FlipAngle"])),
                g(num(&i2["FlipAngle"]))
            ));
        }
        let mut p = t1p[..2].to_vec();
        p.extend(mp);
        if accel {
            p.push(t1p.last().unwrap().clone());
        }
        acq.push(format!(
            "A 3D MP2RAGE {} was acquired with {}.",
            cite(&["marques"]),
            p.join(", ")
        ));
    } else {
        let kind = m.get("MRAcquisitionType").map_or("3D".into(), py::value);
        let pst = if truthy(m.get("PulseSequenceType")) {
            format!(" ({})", py::value(&m["PulseSequenceType"]))
        } else {
            String::new()
        };
        acq.push(format!(
            "A {kind} T1-weighted anatomical image{pst} was acquired with {}.",
            t1p.join(", ")
        ));
    }
    let mut groups: Vec<((String, String), Vec<&Image>)> = vec![];
    for r in runs {
        let (b, mb) = (r.bold, &r.bold.meta);
        let n_te: Vec<f64> = if b.echoes.is_empty() {
            mb.get("EchoTime").map(num).into_iter().collect()
        } else {
            b.echoes
                .iter()
                .map(|e| e.f64("EchoTime").unwrap())
                .collect()
        };
        let st: Option<Vec<f64>> =
            crate::bids::slice_timing(mb).map(|a| a.iter().map(num).collect());
        let (so, mbf) = st.as_deref().map_or((None, 1.0), |s| {
            let (o, f) = slice_order(s);
            (Some(o), f as f64)
        });
        let mbf = mb.get("MultibandAccelerationFactor").map_or(mbf, num); // the sidecar wins over the slice-timing estimate
        let vox = axis_zooms(&crate::bids::affine_rows(&b.hdr.affine));
        let shape = &b.hdr.shape;
        let three_d = mb.get("MRAcquisitionType").and_then(Value::as_str) == Some("3D");
        let ss = match mb.get("ScanningSequence") {
            Some(Value::Array(a)) => py::list_repr(&a.iter().map(py::value).collect::<Vec<_>>()),
            Some(v) => py::value(v),
            None => String::new(),
        };
        let seq = format!(
            "{}{} EPI",
            if three_d { "3D " } else { "" },
            if ss.contains("SE") {
                "spin-echo"
            } else {
                "gradient-echo"
            }
        );
        let mut parts = vec![format!("TR {} s", g(num(&mb["RepetitionTime"])))];
        if n_te.len() > 1 {
            parts.push(format!(
                "TEs {} ms",
                n_te.iter().map(|t| ms(*t)).collect::<Vec<_>>().join(", ")
            ));
        } else if let Some(t) = n_te.first() {
            parts.push(format!("TE {} ms", ms(*t)));
        }
        if mb.contains_key("FlipAngle") {
            parts.push(format!("flip angle {}°", g(num(&mb["FlipAngle"]))));
        }
        parts.push(format!("{}×{} matrix", shape[0], shape[1]));
        parts.push(format!(
            "{}×{} mm field of view",
            g(py::round(shape[0] as f64 * vox[0], 0)),
            g(py::round(shape[1] as f64 * vox[1], 0))
        ));
        let thick = mb.get("SliceThickness").map_or(vox[2], num);
        let gap = mb.get("SpacingBetweenSlices").map_or(vox[2], num) - thick;
        parts.push(if three_d {
            format!("{} {}-mm partitions", shape[2], g(py::round(thick, 2)))
        } else {
            format!(
                "{} {}{}-mm-thick slices{}",
                shape[2],
                so.map_or(String::new(), |s| format!("{s} ")),
                g(py::round(thick, 2)),
                if gap > 0.01 {
                    format!(" with a {}% gap", g(py::round(100.0 * gap / thick, 0)))
                } else {
                    String::new()
                }
            )
        });
        if mb
            .get("ParallelReductionFactorInPlane")
            .and_then(Value::as_f64)
            .unwrap_or(1.0)
            > 1.0
        {
            parts.push(format!(
                "×{} in-plane acceleration",
                g(num(&mb["ParallelReductionFactorInPlane"]))
            ));
        }
        if mbf > 1.0 {
            parts.push(format!("×{} multiband", g(mbf)));
        }
        if let Some(pe) = mb
            .get("PhaseEncodingDirection")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
        {
            parts.push(format!("{} phase encoding", pe_words(&b.hdr.affine, pe)));
        }
        parts.push(format!("{} volumes", shape.get(3).copied().unwrap_or(1)));
        let echoes = if n_te.len() > 1 {
            format!(
                " ({} echoes{})",
                n_te.len(),
                if b.phases.is_empty() {
                    ""
                } else {
                    ", magnitude and phase"
                }
            )
        } else {
            String::new()
        };
        let key = (
            format!("{}{seq}{echoes}", if mbf > 1.0 { "multiband " } else { "" }),
            parts.join("; "),
        );
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) => v.push(b),
            None => groups.push((key, vec![b])),
        }
    }
    for ((seq, parts), bs) in &groups {
        acq.push(format!(
            "{} ({}) {} acquired with a {seq} sequence: {parts}.",
            count(bs.len(), "fMRI series"),
            names(bs),
            if bs.len() > 1 { "were" } else { "was" }
        ));
    }
    let multi = runs.iter().any(|r| !r.bold.echoes.is_empty());
    let mut ripple: Vec<&str> = runs
        .iter()
        .filter(|r| !r.fit.openrecon)
        .filter_map(|r| r.fit.frisgo.as_deref())
        .collect();
    ripple.sort();
    ripple.dedup();
    let openrecon: Vec<&Image> = runs
        .iter()
        .filter(|r| r.fit.openrecon)
        .map(|r| r.bold)
        .collect();
    let how = |k: &str| match k {
        "runwise" => {
            "removing each voxel's mean alternation between odd and even volumes, which leaves volume timing unchanged"
        }
        "lpass" => {
            "removing each voxel's slowly varying odd/even alternation (Gaussian over 20 volumes), which leaves volume timing unchanged"
        }
        "spline" => {
            "cubic interpolation midway between consecutive volumes, which moves each volume half a TR earlier (recorded as StartTime)"
        }
        _ => "a [1/4, 1/2, 1/4] temporal filter across neighbouring volumes",
    };
    let stc = runs.iter().any(|r| crate::bids::stc_applies(&r.bold.meta));
    let mut p0 = format!(
        "Data were preprocessed with fastprep, which follows the fMRIPrep workflow {} using permissively licensed tools, with voxel-wise operations in niimath {}. ",
        cite(&["fmriprep"]),
        cite(&["niimath"])
    );
    if !anat.inversions.is_empty() {
        p0 += &if anat.denoised {
            format!(
                "The MP2RAGE uniform image, denoised with niimath's implementation of the robust combination {} (regularisation {}× the background INV2 level), served as the T1-weighted image. ",
                cite(&["obrien"]),
                mp2rage_factor()
            )
        } else {
            "The vendor-denoised MP2RAGE uniform image (UNI-DEN) served as the T1-weighted image. "
                .into()
        };
    }
    if !anat.synthetic.is_empty() {
        p0 += &format!(
            "With no anatomical scan, a synthetic T1-weighted image was made from the fMRI: each run's (distortion-corrected) motion-correction reference was rigidly aligned to the first run's with niimath's implementation of AFNI's 3dAllineate {}, the {} references were averaged, and SynthSR {} converted the mean into a 1 mm T1-weighted image. It keeps the EPI's geometric distortion, so residual distortion is absorbed by the nonlinear template normalisation, \"T1w space\" below denotes this EPI-derived space, and no cortical surfaces were reconstructed. ",
            cite(&["afni"]),
            anat.synthetic.len(),
            cite(&["synthsr"])
        );
    }
    p0 += &if anat.robustfov {
        format!(
            "The T1-weighted image was cropped to a robust field of view excluding the neck (niimath implementation of FSL's robustfov {}), corrected ",
            cite(&["fsl"])
        )
    } else {
        "The T1-weighted image was corrected ".into()
    };
    p0 += &format!(
        "for intensity non-uniformity with niimath's implementation of N4 {}, ",
        cite(&["n4"])
    );
    p0 += &format!(
        "brain-extracted with MindGrab {}, and segmented into grey matter, white matter and cerebrospinal fluid partial-volume maps with the brainchop MindMap model {}",
        cite(&["mindgrab"]),
        cite(&["brainchop"])
    );
    if anat.surfaces {
        p0 += &format!(
            "; cortical surfaces were reconstructed with TopoFit {}",
            cite(&["topofit"])
        );
    }
    p0 += &format!(
        ". It was normalised to the {TEMPLATE} template {} with Greedy {}: an affine brain-to-brain registration followed by a diffeomorphic (stationary velocity field) registration, both maximising normalised mutual information.",
        cite(&["mni"]),
        cite(&["greedy"])
    );
    let mut p1 = "For each fMRI run, non-steady-state volumes were detected and a reference volume was computed as in fMRIPrep, and head motion was estimated by six-parameter rigid-body registration of every volume to that reference".to_string();
    if multi {
        p1 += &format!(
            "; multi-echo runs were first combined by T2*-weighted optimal combination {}",
            cite(&["posse"])
        );
    }
    if !ripple.is_empty() {
        p1 += &format!(
            ". Runs acquired with alternating (dual) read polarity were first corrected for fuzzy ripple artefacts {} with niimath's implementation of LayNii's LN2_FRISGO {}, ",
            cite(&["ripple"]),
            cite(&["laynii"])
        );
        p1 += &ripple.iter().map(|k| how(k)).collect::<Vec<_>>().join("; ");
    }
    if !openrecon.is_empty() {
        p1 += &format!(
            ". {} had been corrected for fuzzy ripple on the scanner (Siemens OpenRecon FRISGO, identified by its ImageType tag), equivalent to the cubic interpolation midway between consecutive volumes, which moves each volume half a TR earlier (recorded as StartTime); fastprep applied no further correction",
            names(&openrecon)
        );
    }
    p1 += &format!(
        ". Susceptibility distortion was handled per run (below). The corrected reference was brain-extracted with MindGrab and registered to the T1-weighted image with niimath's implementation of AFNI's 3dAllineate {}, using the local Pearson correlation cost {} and a 12-parameter affine transform",
        cite(&["afni"]),
        cite(&["lpc"])
    );
    // the per-run choice (stages::bold_fit): a rigid fast-cost fit replaces an implausible lpc fit
    let rigid: Vec<&Image> = runs
        .iter()
        .filter(|r| !r.fit.coreg_cost.starts_with("lpc"))
        .map(|r| r.bold)
        .collect();
    if !rigid.is_empty() {
        p1 += &format!(
            "; for {}, that fit was implausible against a rigid fast-cost fit (zooms or a displacement beyond tolerance), so the rigid fit was used",
            names(&rigid)
        );
    }
    p1 += ".";
    if stc {
        p1 += " Slice-timing correction (Fourier phase shift to the middle of each volume's acquisition) was applied to runs with slice-timing information; that reference time is recorded as StartTime in each output sidecar.";
    }
    p1 += &format!(
        " Head-motion correction, distortion correction, coregistration and normalisation were composed into a single cubic B-spline interpolation, giving data in T1w space (at the functional resolution) and in {TEMPLATE} space. Confounds were computed as in fMRIPrep, including framewise displacement and DVARS {} and anatomical and temporal CompCor components {}. Temporal SNR{} was the mean divided by the residual standard deviation after regressing polynomial trends and the six motion parameters. No spatial smoothing or {}temporal filtering was applied.",
        cite(&["power"]),
        cite(&["compcor"]),
        // stages::bold_apply skips tSNR for short runs; the ripple corrections above are temporal operations
        if runs
            .iter()
            .any(|r| r.bold.hdr.shape.get(3).copied().unwrap_or(1) < short_run())
        {
            format!(" (runs of at least {} volumes)", short_run())
        } else {
            String::new()
        },
        if ripple.is_empty() && openrecon.is_empty() {
            ""
        } else {
            "other "
        }
    );
    let mut pre = vec![p0, p1];
    let mut sdc_text: Vec<(String, Vec<&Image>)> = vec![];
    for r in runs {
        let fit = r.fit;
        let ms_ = &fit.sdc_methods;
        let mut t = if ms_.contains(&"medic") {
            format!(
                "frame-wise field maps were estimated from the multi-echo phase with MEDIC {} (niimath implementation) and applied as per-volume voxel shifts along the phase-encoding direction",
                cite(&["medic"])
            )
        } else if ms_.contains(&"phasediff") {
            format!(
                "a phase-difference field map (ΔTE {} ms) was unwrapped with ROMEO {}, converted to a field map as FSL's fsl_prepare_fieldmap {} (niimath implementations), registered to the reference and applied as a voxel-shift map along the phase-encoding direction {}",
                g(py::round(fit.fmap.as_ref().unwrap().dte_ms, 2)),
                cite(&["romeo"]),
                cite(&["fsl"]),
                cite(&["jezzard"])
            )
        } else {
            String::new()
        };
        let unusable = fit
            .fmap_unusable
            .as_deref()
            .map(|u| u.split_once(": ").map_or(u, |(_, b)| b).to_string());
        if ms_.contains(&"synthsr") {
            let how = format!(
                "the reference was converted to a synthetic T1-weighted image with SynthSR {}, and a diffeomorphic Greedy {} registration of the subject's brain-extracted T1-weighted image to it (both brain-extracted with MindGrab) gave a 3D displacement field applied after coregistration",
                cite(&["synthsr"]),
                cite(&["greedy"])
            );
            t = if !t.is_empty() {
                format!("{t}, followed by a residual correction: {how}")
            } else {
                let lead = match &unusable {
                    Some(u) if u == PEPOLAR_DEFERRED => {
                        "an opposite-phase-encoding (PEPOLAR) field map was acquired but is not supported by this version, so ".into()
                    }
                    Some(u) => format!("the acquired field map failed validation ({u}), so "),
                    None => "with no field map, ".into(),
                };
                format!("{lead}a field-map-less correction was used: {how}")
            };
        }
        if t.is_empty() {
            t = format!(
                "no distortion correction was applied{}",
                unusable.map_or(String::new(), |u| if u == PEPOLAR_DEFERRED {
                    " (an opposite-phase-encoding field map was acquired but is not supported by this version)".into()
                } else {
                    format!(" (field map failed validation: {u})")
                })
            );
        }
        match sdc_text.iter_mut().find(|(k, _)| *k == t) {
            Some((_, v)) => v.push(r.bold),
            None => sdc_text.push((t, vec![r.bold])),
        }
    }
    for (t, bs) in &sdc_text {
        pre.push(format!("Distortion correction for {}: {t}.", names(bs)));
    }
    let refs: String = order
        .borrow()
        .iter()
        .map(|k| {
            format!(
                "<li>{}</li>",
                esc(refs::REFS.iter().find(|(r, _)| r == k).unwrap().1)
            )
        })
        .collect();
    format!(
        "<h3>Imaging procedure</h3><p>{}</p><h3>Preprocessing</h3>{}<h3>References</h3><ol class=\"refs\">{refs}</ol>",
        esc(&acq.join(" ")),
        pre.iter()
            .map(|x| format!("<p>{}</p>", esc(x)))
            .collect::<String>()
    )
}

/// Inline-SVG traces of the 6 rigid-body parameters over the task blocks: no plotting library, no script.
pub fn motion_plot(conf: &str, events: &str, tr: f64) -> String {
    let (rows, blocks) = (tsv(conf), tsv(events));
    let (dur, w, h) = (rows.len() as f64 * tr, 1000.0, 100.0);
    let mut shade = String::new();
    for b in &blocks {
        if let Some((_, fill)) = BLOCK_FILL
            .iter()
            .find(|(t, _)| *t == field(b, "trial_type"))
        {
            let f = |k: &str| field(b, k).parse::<f64>().unwrap_or(0.0);
            shade += &format!(
                "<rect x=\"{:.1}\" width=\"{:.1}\" height=\"{h}\" fill=\"{fill}\" opacity=\".15\"/>",
                f("onset") / dur * w,
                f("duration") / dur * w
            );
        }
    }
    let mut out = String::new();
    type Set<'a> = (&'a str, &'a str, f64, [(&'a str, &'a str); 3]);
    let sets: [Set; 2] = [
        (
            "Translation",
            "mm",
            1.0,
            [("trans_x", "x"), ("trans_y", "y"), ("trans_z", "z")],
        ),
        // fMRIPrep-style confounds store radians
        (
            "Rotation",
            "°",
            180.0 / std::f64::consts::PI,
            [
                ("rot_x", "pitch (x)"),
                ("rot_y", "roll (y)"),
                ("rot_z", "yaw (z)"),
            ],
        ),
    ];
    for (title, unit, scale, cols) in sets {
        let ys: Vec<Vec<f64>> = cols
            .iter()
            .map(|(c, _)| {
                rows.iter()
                    .map(|r| match field(r, c) {
                        "" | "n/a" => 0.0,
                        v => v.parse::<f64>().unwrap_or(f64::NAN) * scale,
                    })
                    .collect()
            })
            .collect();
        let lo = ys.iter().flatten().copied().fold(f64::INFINITY, f64::min);
        let hi = ys
            .iter()
            .flatten()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        let span = if hi - lo != 0.0 { hi - lo } else { 1.0 };
        let mut lines = String::new();
        for (y, color) in ys.iter().zip(AXIS_STROKE) {
            let pts: Vec<String> = y
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    format!(
                        "{:.1},{:.1}",
                        (i as f64 + 0.5) * tr / dur * w,
                        h - 4.0 - (v - lo) / span * (h - 8.0)
                    )
                })
                .collect();
            lines += &format!(
                "<polyline fill=\"none\" stroke=\"{color}\" stroke-width=\"1.5\" vector-effect=\"non-scaling-stroke\" points=\"{}\"/>",
                pts.join(" ")
            );
        }
        let key: String = cols
            .iter()
            .zip(AXIS_STROKE)
            .map(|((_, n), c)| format!("<span><i style=\"background:{c}\"></i>{n}</span>"))
            .collect();
        out += &format!(
            "<h3>{title} ({unit}; range {lo:.2} to {hi:.2})</h3><div class=\"plot\"><svg viewBox=\"0 0 {w} {h}\" preserveAspectRatio=\"none\" role=\"img\" aria-label=\"{title} parameters over time\">{shade}{lines}</svg></div><div class=\"key\">{key}<span>0–{dur:.0} s</span></div>"
        );
    }
    let blocks_key: String = BLOCK_FILL
        .iter()
        .map(|(t, c)| {
            format!("<span><i style=\"background:{c};opacity:.4;height:10px\"></i>{t} block</span>")
        })
        .collect();
    format!("{out}<div class=\"key\">{blocks_key}</div>")
}

struct Figures<'a, H: Host> {
    c: &'a Ctx<H>,
    dir: String,
    n: Cell<usize>,
}

impl<H: Host> Figures<'_, H> {
    /// Render one PNG; return its `<figure>` and image link (empty if the overlay is missing).
    async fn figure(
        &self,
        title: &str,
        caption: &str,
        base: &str,
        overlay: &str,
        opts: Vec<String>,
    ) -> Result<(String, String), String> {
        let png = join(&self.dir, &format!("{:02}.png", self.n.get()));
        self.n.set(self.n.get() + 1);
        if !self.c.h.exists(overlay) {
            return Ok((String::new(), String::new()));
        }
        let view = if opts
            .iter()
            .any(|o| ["-x", "-y", "-z"].contains(&o.as_str()))
        {
            vec![]
        } else {
            argv!["-m"]
        }; // default: mosaic
        self.c
            .run(
                argv!["niimath", base, "-bitmap", overlay, ..opts, ..view, png],
                &[png.clone()],
                None,
                None,
            )
            .await?;
        let src = esc(png
            .strip_prefix(&format!("{}/", self.c.out))
            .unwrap_or(&png));
        Ok((
            format!(
                "<h3>{}</h3><figure><a href=\"{src}\"><img src=\"{src}\" alt=\"{}\" loading=\"lazy\"></a><figcaption>{caption}</figcaption></figure>",
                esc(title),
                esc(title)
            ),
            src,
        ))
    }
}

/// Left/right block GLM (glm) on the T1w-space BOLD, written as its own page; returns the link.
async fn task_page<H: Host>(
    f: &Figures<'_, H>,
    bold: &Image,
    fit: &Fit,
    anat: &Anat,
    label: &str,
) -> Result<String, String> {
    let c = f.c;
    // events belong to the run, not to an echo or part: drop those entities from the BOLD name
    let name: String = file_name(&bold.path)
        .split('_')
        .filter(|p| !(p.starts_with("echo-") || p.starts_with("part-")))
        .collect::<Vec<_>>()
        .join("_");
    // BIDS allows .nii as well as .nii.gz
    let events = name
        .strip_suffix(".gz")
        .unwrap_or(&name)
        .strip_suffix("_bold.nii")
        .map(|stem| join(parent(&bold.path), &format!("{stem}_events.tsv")));
    let Some(events) = events.filter(|e| c.h.exists(e)) else {
        return Ok(String::new());
    };
    let ev = c.text(&events).await?;
    let types: Vec<String> = tsv(&ev)
        .iter()
        .map(|r| field(r, "trial_type").to_string())
        .collect();
    if !["left", "right"]
        .iter()
        .all(|t| types.iter().any(|x| x == t))
    {
        return Ok(String::new());
    }
    let mut maps = vec![];
    for (k, _) in TASK_CONTRASTS {
        maps.push(c.deriv(
            bold,
            "boldmap",
            ".nii.gz",
            &[
                ("space", Some("T1w")),
                ("stat", Some("t")),
                ("desc", Some(k)),
            ],
        )?);
    }
    let summary = join(parent(&fit.nss), "task_glm.json");
    let preproc = c.deriv(
        bold,
        "bold",
        ".nii.gz",
        &[("space", Some("T1w")), ("desc", Some("preproc"))],
    )?;
    let conf = c.deriv(bold, "timeseries", ".tsv", &[("desc", Some("confounds"))])?;
    let mut outs = maps.clone();
    outs.push(summary.clone());
    c.run(
        argv![
            "glm",
            "--task-analysis",
            preproc,
            conf,
            events,
            ..maps.clone(),
            "--summary",
            summary,
            "--fwhm",
            5usize
        ],
        &outs,
        None,
        None,
    )
    .await?;
    let st = c.json(&summary).await?;
    let thr = num(&st["t_display"]);
    let meta = &bold.meta;
    let nss = c.json(&fit.nss).await?["dummy_scans"].as_i64().unwrap_or(0);
    let tr = num(&meta["RepetitionTime"]);
    let mut data = if !bold.echoes.is_empty() {
        let tes: Vec<String> = bold
            .echoes
            .iter()
            .map(|e| g(1000.0 * e.f64("EchoTime").unwrap()))
            .collect();
        format!(
            "This run has {} echoes (TE {} ms). They were combined voxelwise into one series by T2*-weighted optimal combination (Posse et al., 1999) before any other step; motion correction, distortion correction and the GLM all operate on that combined series, and the echoes are not modelled separately.{}",
            bold.echoes.len(),
            tes.join(", "),
            if bold.phases.is_empty() {
                ""
            } else {
                " The echoes' phase gave a per-frame field map (MEDIC; Van et al., 2023) used for distortion correction."
            }
        )
    } else {
        "Single-echo run.".into()
    };
    data += &format!(" Distortion correction: {}.", fit.sdc_name);
    if let Some(fr) = &fit.frisgo {
        data += &format!(
            " Fuzzy ripple correction: {fr}{}.",
            if fit.openrecon {
                " (OpenRecon, on the scanner; volumes shifted −TR/2)"
            } else {
                ""
            }
        );
    }
    data += " Motion correction, distortion correction and the BOLD→T1w registration were applied in one interpolation.";
    let (mut rows, mut figs) = (String::new(), String::new());
    for ((key, title), map) in TASK_CONTRASTS.iter().zip(&maps) {
        let s = &st[*key];
        let link = esc(map.strip_prefix(&format!("{}/", c.out)).unwrap_or(map));
        let peak: Vec<String> = s["peak_mm"]
            .as_array()
            .map_or(vec![], |a| a.iter().map(py::value).collect());
        let peak_t = num(&s["peak_t"]);
        rows += &format!(
            "<tr><td>{}</td><td class=\"n\">{peak_t:.2}</td><td>{}</td><td class=\"n\">{}</td><td class=\"n\">{:.2}</td><td><a href=\"{link}\">t map</a></td></tr>",
            esc(title),
            peak.join(", "),
            py::value(&s["voxels_above_display"]),
            num(&s["median_rho"])
        );
        if peak_t > thr {
            // maps are on the BOLD-resolution T1w grid; -bitmap needs the base's grid
            let on_t1 = join(parent(&fit.nss), &format!("tstat_{key}_on_t1w.nii.zst"));
            c.run(
                argv!["niimath", map, "-resample", anat.preproc, on_t1],
                &[on_t1.clone()],
                Some("NIFTI_ZST"),
                None,
            )
            .await?;
            let cap = format!(
                "t ≥ {thr:.2} (p &lt; {} uncorrected, df {}).",
                py::value(&st["p_display"]),
                py::value(&st["df"])
            );
            figs += &f
                .figure(
                    title,
                    &cap,
                    &anat.preproc,
                    &on_t1,
                    argv!["-T", thr, peak_t, "-C", "redyellow", 1usize, "-s", 2usize],
                )
                .await?
                .0;
        }
    }
    let stem: Vec<String> = ENTITY_ORDER[..ENTITY_ORDER.iter().position(|k| *k == "echo").unwrap()]
        .iter()
        .filter_map(|k| {
            bold.ents
                .get(k)
                .filter(|v| !v.is_empty())
                .map(|v| format!("{k}-{v}"))
        })
        .collect();
    let page = format!("{}.html", stem.join("_"));
    let title = format!(
        "{} run-{} task analysis",
        bold.ents.get("task").unwrap_or("task"),
        bold.ents.get("run").unwrap_or("")
    );
    let conf_text = c.text(&conf).await?;
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{t}</title><style>{REPORT_CSS}{MOTION_CSS}</style></head><body><header>{THEME_TOGGLE}<h1>{t}</h1><p class=\"mut\"><a href=\"sub-{l}.html\">← subject report</a>. Prototype first-level GLM (glm.py).</p></header><main><h2>Methods</h2><p>{data}</p><p>The preprocessed series in T1w space ({vols} volumes, TR {trg} s) was smoothed with a 5 mm FWHM Gaussian. {nss} non-steady-state volume{was} dropped from the model. Design matrix: left and right block regressors (onsets and durations from the events file) convolved with a double-gamma HRF (SPM canonical: gamma shapes 6 and 16 s, undershoot ratio 1:6) and sampled at each volume's StartTime (slice-timing or FRISGO-spline reference; mid-TR if absent); an intercept; a discrete cosine basis with a 128 s high-pass cutoff; and the 6 rigid-body motion parameters (3 translations, 3 rotations) from head-motion estimation, without derivatives or squares. Other confounds (global, white-matter and CSF signals, CompCor, framewise displacement, DVARS) are in the confounds file but were not used. Serial correlation: lag-1 autocorrelation of the OLS residuals, spatially smoothed (5 mm), then a Prais-Winsten AR(1) refit per voxel. Contrasts: [1 −1], [−1 1], [1 0], [0 1]; df {df}, stored in each t map's NIfTI intent. Figures show t ≥ {thr:.2} (p &lt; {p}, one-sided, uncorrected for multiple comparisons).</p><h2>Head motion</h2><p class=\"mut\">Large or block-locked motion here can masquerade as activation.</p>{motion}<h2>Results</h2><div class=\"wrap\"><table><tr><th>Contrast</th><th class=\"n\">Peak t</th><th>Peak (mm)</th><th class=\"n\">Voxels shown</th><th class=\"n\">Median AR(1)</th><th>Map</th></tr>{rows}</table></div>{figs}</main></body></html>",
        t = esc(&title),
        l = esc(label),
        data = esc(&data),
        vols = bold.hdr.shape.get(3).copied().unwrap_or(1),
        trg = g(tr),
        was = if nss == 1 { " was" } else { "s were" },
        df = py::value(&st["df"]),
        p = py::value(&st["p_display"]),
        motion = motion_plot(&conf_text, &ev, tr),
    );
    c.h.write(&join(&c.out, &page), html.as_bytes()).await?;
    Ok(format!(
        "<p><a href=\"{}\">Task analysis: left/right contrasts →</a></p>",
        esc(&page)
    ))
}

/// sub-<label>.html: one self-contained page (inline CSS, one small script) of figures and provenance.
pub async fn report<H: Host>(
    c: &Ctx<H>,
    label: &str,
    t1: &Image,
    anat: &Anat,
    runs: &[Run<'_>],
    t0: f64,
) -> Result<(), String> {
    let dir = join(&c.out, &format!("sub-{label}/figures"));
    // figures are numbered by position: a rerun with other runs/options must not reuse them
    for f in c.h.list(&dir) {
        let stem = f.strip_suffix(".png").unwrap_or("");
        if !f.contains('/') && !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()) {
            c.h.remove(&join(&dir, &f));
        }
    }
    c.h.mkdirs(&dir)?;
    let figs = Figures {
        c,
        dir,
        n: Cell::new(0),
    };
    let space_t1 = c.deriv(
        t1,
        "T1w",
        ".nii.gz",
        &[("space", Some(TEMPLATE)), ("desc", Some("preproc"))],
    )?;
    let qc = join(&c.out, &format!("sub-{label}/surf/topofit_qc.nii"));
    // -E: exact one-voxel mask outline; -e (Otsu + DoG zero-crossings) is for intensity images
    let mut anat_html = String::new();
    anat_html += &figs.figure("Brain mask", "Red: mindgrab brain-mask outline. It should hug the brain, excluding skull and dura, and keep the cerebellum.", &anat.preproc, &anat.mask, argv!["-C", "red", 1usize, "-E"]).await?.0;
    anat_html += &figs.figure("Grey matter", "Red: mindmap grey-matter probability. It should follow the cortical ribbon and deep grey nuclei.", &anat.preproc, &anat.pve[0], argv!["-C", "red", 0.5]).await?.0;
    // sagittal tiles are wider: two per row; the midline shows few features
    anat_html += &figs
        .figure(
            &format!("Normalisation to {TEMPLATE}"),
            "T1w warped to the template; red: template brain edges. They should sit on the warped brain boundary and ventricles.",
            &space_t1,
            &c.tpl.brain,
            argv!["-C", "red", 1usize, "-e", "-x", 0.2, 0.4, "-r", "-x", 0.6, 0.8, "-r", "-y", 0.25, 0.5, 0.75, "-r", "-z", 0.25, 0.5, 0.75],
        )
        .await?
        .0;
    // topofit_qc burns pial in at 3500 and white at 4095
    if anat.surfaces {
        anat_html += &figs.figure("Cortical surfaces", "TopoFit white (yellow) and pial (red) surfaces. White should trace the grey/white boundary, pial the outer cortex.", &anat.surf_ref, &qc, argv!["-T", 3499usize, 4095usize, "-C", "redyellow", 1usize]).await?.0;
    }
    let mut sections = vec![("anat".to_string(), "Anatomical".to_string(), anat_html)];
    // from a BIDS input: a synthetic T1w lives in the output folder
    let src = runs.first().map_or(t1, |r| r.bold);
    let root = &src.path[..src.path.len() - src.rel.len()];
    let mut facts: Vec<(String, String)> = vec![
        ("Subject".into(), format!("sub-{}", esc(label))),
        ("Dataset".into(), format!("<code>{}</code>", esc(root))),
        ("Generated".into(), c.h.local_time()),
        (
            "Anatomical".into(),
            format!("<code>{}</code>", esc(t1.file_name())),
        ),
        ("Template".into(), TEMPLATE.into()),
    ];
    for (i, r) in runs.iter().enumerate() {
        let (bold, fit) = (r.bold, r.fit);
        let (name, meta) = (bold.name(), &bold.meta);
        let mut body = String::new();
        if let Some(u) = &fit.fmap_unusable {
            body += &format!(
                "<p class=\"warn\"><b>Fieldmap not used:</b> {}. Distortion correction: {}.</p>",
                esc(u),
                esc(&fit.sdc_name)
            );
        }
        body += &figs
            .figure(
                "Reference and brain mask",
                "BOLD reference (distortion-corrected when SDC ran) with its brain-mask outline.",
                &fit.coreg_ref,
                &fit.mask,
                argv!["-C", "red", 1usize, "-E"],
            )
            .await?
            .0;
        body += &figs
            .figure(
                "Coregistration to T1w",
                &format!("BOLD reference on the T1w grid; red: T1w edges. Sulci and ventricles should line up. Cost: {}.", esc(&fit.coreg_cost)),
                &fit.ref_t1,
                &anat.preproc,
                argv!["-C", "red", 1usize, "-e"],
            )
            .await?
            .0;
        let (tsnr_map, tsnr_json) = tsnr_paths(c, bold, fit)?;
        let tsnr = if c.h.exists(&tsnr_json) {
            c.json(&tsnr_json).await?["tsnr_median_brain"].as_f64()
        } else {
            None
        };
        if let Some(t) = tsnr {
            let cap = format!(
                "tSNR = mean / residual SD over time, after removing polynomial trends and the 6 motion parameters (dummy scans dropped). Median in brain {t:.1}; colour scale 0 to {:.0}.",
                2.0 * t
            );
            body += &figs
                .figure(
                    "Temporal SNR",
                    &cap,
                    &fit.reference,
                    &tsnr_map,
                    argv![
                        "-T",
                        1usize,
                        py::round(2.0 * t, 0) as i64,
                        "-C",
                        "viridis",
                        1usize,
                        "-s",
                        2usize
                    ],
                )
                .await?
                .0;
        }
        if !fit.sdc.is_empty() {
            // An independent reference, as fMRIPrep: T1w white matter pulled onto the boldref grid by the inverse coreg
            // (the BOLD's own mask would follow the correction and hide it). Zoomed: shifts are 1-3 voxels.
            let w = parent(&fit.ref_t1);
            let inv = invert_xfm(c, &fit.coreg, &join(w, "coreg_inverse.json")).await?;
            let wm = join(w, "wm_on_boldref.nii.zst");
            let prob = join(w, "wm_prob.nii.zst");
            c.run(
                argv![
                    "niimath",
                    anat.pve[1],
                    "-resample",
                    fit.reference,
                    "-mat",
                    inv,
                    join(w, "wm_prob")
                ],
                &[prob.clone()],
                Some("NIFTI_ZST"),
                None,
            )
            .await?;
            c.run(
                argv!["niimath", prob, "-thr", 0.5, "-bin", wm],
                &[wm.clone()],
                Some("NIFTI_ZST"),
                None,
            )
            .await?;
            let view = argv!["-C", "red", 1usize, "-E", "-s", 2usize];
            let before = figs
                .figure("before", "", &fit.reference, &wm, view.clone())
                .await?
                .1;
            let after = figs.figure("after", "", &fit.coreg_ref, &wm, view).await?.1;
            if !before.is_empty() && !after.is_empty() {
                // stacked: 'after' shows, hover or tap reveals 'before'
                body += &format!(
                    "<div class=\"sdc\"><h3>Distortion correction<button class=\"view\" type=\"button\" aria-pressed=\"false\" title=\"Press to latch the original (uncorrected) image\"><span class=\"corr\">Corrected</span><span class=\"orig\">Original</span></button></h3><figure><div class=\"flip\"><img src=\"{after}\" alt=\"after SDC\" loading=\"lazy\"><img class=\"before\" src=\"{before}\" alt=\"before SDC\" loading=\"lazy\"></div><figcaption><b>After</b> correction; <b>hover or tap</b> the image to see it before (1 s), or press the button to hold the original. Red: T1w white matter mapped into BOLD space, an outline independent of the correction. Frontal and temporal edges should fit better after.</figcaption></figure></div>"
                );
            }
        }
        body += &task_page(&figs, bold, fit, anat, label).await?;
        let task = meta.get("TaskName").map_or(name.clone(), py::value);
        sections.push((
            format!("run{i}"),
            format!("Run {}: {}", i + 1, esc(&task)),
            body,
        ));
        let nss = c.json(&fit.nss).await?["dummy_scans"].as_i64().unwrap_or(0);
        let mut fact = format!(
            "<code>{}</code><br>{} vols × TR {} s",
            esc(&name),
            bold.hdr.shape.get(3).copied().unwrap_or(1),
            esc(&py::value(&meta["RepetitionTime"]))
        );
        if !bold.echoes.is_empty() {
            fact += &format!(", {} echoes (T2*-combined)", bold.echoes.len());
        }
        fact += &format!("; {nss} dummy scan{}", if nss == 1 { "" } else { "s" });
        if let Some(t) = tsnr {
            fact += &format!("; tSNR {t:.1} (median in brain)");
        }
        fact += &format!(
            "; SDC: {}; coreg: {}",
            esc(&fit.sdc_name),
            esc(&fit.coreg_cost)
        );
        if let Some(fr) = &fit.frisgo {
            fact += &format!(
                "; fuzzy ripple: {fr}{}",
                if fit.openrecon { " (OpenRecon)" } else { "" }
            );
        } else if meta
            .get("ReadPolarity")
            .map(py::value)
            .unwrap_or_default()
            .to_lowercase()
            .starts_with("dual")
        {
            let vols = bold.hdr.shape.get(3).copied().unwrap_or(1);
            fact += &if vols < short_run() {
                format!(
                    "; fuzzy ripple: not corrected (dual polarity, but under {} volumes)",
                    short_run()
                )
            } else {
                "; fuzzy ripple: not corrected (dual polarity; <code>--frisgo off</code>)".into()
            };
        }
        facts.push((format!("Run {}", i + 1), fact));
    }
    let times = c.times();
    let mut steps: Vec<(String, String, f64)> = times
        .iter()
        .filter(|x| !x.1.ends_with(".png"))
        .cloned()
        .collect();
    let pngs: Vec<f64> = times
        .iter()
        .filter(|x| x.1.ends_with(".png"))
        .map(|x| x.2)
        .collect();
    if !pngs.is_empty() {
        // the many quick -bitmap calls as one row
        steps.push((
            "niimath".into(),
            format!("{} report figures (-bitmap)", pngs.len()),
            pngs.iter().sum(),
        ));
    }
    // after the figures, so the total covers this whole invocation; a resumed run adds to the earlier invocations, a
    // report-only rerun (nothing recomputed) keeps their total
    let (prev, mut n) = c.wall;
    let fresh = c.computed() || n == 0;
    let elapsed = if fresh { prev + c.h.now() - t0 } else { prev };
    n += fresh as u64;
    let resumed = if n > 1 {
        format!(" (summed over {n} resumed invocations)")
    } else {
        String::new()
    };
    facts.splice(
        3..3,
        [
            ("End-to-end time".to_string(), format!("{elapsed:.1} s{resumed}; stage times under Processing steps")),
            ("Peak RAM".to_string(), "not measured (aggregate process-tree memory is not sampled)".to_string()),
        ]
        .into_iter()
        .chain(match &c.runtime {
            Some(r) => vec![("Runtime".to_string(), esc(r))],
            None => vec![
            (
                "Threads".to_string(),
                format!(
                    "{} total (<code>--nprocs</code>), {} per tool (<code>--omp-nthreads</code>), up to {} step{} in parallel",
                    c.nprocs,
                    c.omp,
                    c.workers,
                    if c.workers == 1 { "" } else { "s" }
                ),
            ),
            (
                "GPU".to_string(),
                if c.gpu_slots > 0 {
                    format!(
                        "on: at most {} GPU job{} at a time across all fastprep instances on this machine",
                        c.gpu_slots,
                        if c.gpu_slots > 1 { "s" } else { "" }
                    )
                } else {
                    "off (<code>--no-gpu</code>): CPU only".into()
                },
            ),
            ],
        }),
    );
    let mut rows: String = steps
        .iter()
        .map(|(t, o, s)| {
            format!(
                "<tr><td>{t}</td><td><code>{}</code></td><td class=\"n\">{s:.1}</td><td class=\"b\"><i style=\"width:{:.1}%\"></i></td></tr>",
                esc(o),
                100.0 * s / elapsed.max(1e-9)
            )
        })
        .collect();
    rows += &format!(
        "<tr class=\"tot\"><td>Total</td><td>end to end</td><td class=\"n\">{elapsed:.1}</td><td></td></tr>"
    );
    sections.push(("methods".into(), "Methods".into(), methods(t1, runs, anat)));
    sections.push((
        "steps".into(),
        format!("Processing steps ({elapsed:.1} s end to end)"),
        format!("<p class=\"mut\">Commands: <code>work/commands.sh</code>; bars: share of wall time (steps overlap).</p><table><tr><th>tool</th><th>output</th><th class=\"n\">s</th><th></th></tr>{rows}</table>"),
    ));
    let dl: String = facts
        .iter()
        .map(|(k, v)| format!("<dt>{k}</dt><dd>{v}</dd>"))
        .collect();
    let nav: String = sections
        .iter()
        .map(|(a, t, _)| format!("<a href=\"#{a}\">{}</a>", t.split(" (").next().unwrap()))
        .collect();
    let main: String = sections
        .iter()
        .map(|(a, t, b)| {
            format!(
                "<details id=\"{a}\"{}><summary>{t}</summary>{b}</details>",
                if a == "steps" { "" } else { " open" }
            )
        })
        .collect();
    let page = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>fastprep sub-{l}</title><style>{REPORT_CSS}</style></head><body><header>{THEME_TOGGLE}<h1>fastprep: sub-{l}</h1><p class=\"mut\">Preprocessing report. Confounds: each run's <code>desc-confounds_timeseries.tsv</code>.</p><dl>{dl}</dl><nav>{nav}</nav></header><main>{main}</main><script>{SDC_JS}</script></body></html>",
        l = esc(label)
    );
    c.h.write(&join(&c.out, &format!("sub-{label}.html")), page.as_bytes())
        .await
}
