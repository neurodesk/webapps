//! Processing stages of fastprep.py: each builds tool commands and reads back only small text results.

use crate::argv;
use crate::bids::{self, Image, axis_zooms, disagreement_mm, readout_time};
use crate::host::{Host, join};
use crate::nifti;
use crate::py;
use crate::report::{TASK_CONTRASTS, field, tsv};
use crate::run::{Ctx, TEMPLATE};
use serde_json::{Map, Value, json};
use std::f64::consts::PI;
use std::rc::Rc;

const SHORT_RUN: usize = 20; // fewer volumes: FRISGO's run-mean odd/even error is mostly noise, tSNR's fit is (near) singular
const MP2RAGE_FACTOR: i64 = 6; // -mp2rage noise multiple: best match to Siemens UNI-DEN (lambda 0.2) on motor7T, r 0.994
const ZST: Option<&str> = Some("NIFTI_ZST");
const MEICA_MIN_VOLUMES: usize = 100; // ponytail: --meica auto cutoff; maPCA is weak on short runs, not a validated boundary
type Ents = &'static [(&'static str, Option<&'static str>)];
/// meica's published tables and maps: (meica file name, suffix, extension, entities).
const MEICA_PUBLISHED: [(&str, &str, &str, Ents); 5] = [
    (
        "desc-tedana_metrics.tsv",
        "metrics",
        ".tsv",
        &[("desc", Some("tedana"))],
    ),
    (
        "desc-ICA_mixing.tsv",
        "mixing",
        ".tsv",
        &[("desc", Some("ICA"))],
    ),
    (
        "desc-ICA_status_table.tsv",
        "status_table",
        ".tsv",
        &[("desc", Some("ICA"))],
    ),
    (
        "desc-ICA_decision_tree.json",
        "decision_tree",
        ".json",
        &[("desc", Some("ICA"))],
    ),
    (
        "desc-ICA_stat-z_components.nii.gz",
        "components",
        ".nii.gz",
        &[("stat", Some("z")), ("desc", Some("ICA"))],
    ),
];

pub fn short_run() -> usize {
    SHORT_RUN
}
pub fn mp2rage_factor() -> i64 {
    MP2RAGE_FACTOR
}

fn frisgo_mode(mode: &str) -> Vec<String> {
    match mode {
        "lpass" => argv!["lpass", 20usize], // width in volumes, above typical block lengths
        m => argv![m],
    }
}

pub struct Fmap {
    pub hz: String,
    pub reference: String,
    pub jacobian: bool,
    pub kind: String,
    pub method: &'static str,
    pub dte_ms: f64,
}

/// Phase-difference fieldmap in Hz plus a brain-extracted reference to register it to each boldref.
/// PEPOLAR groups never reach this: `fieldmap_problem` reports them as deferred.
pub async fn fieldmap<H: Host>(c: &Ctx<H>, key: &str, fmaps: &[Image]) -> Result<Fmap, String> {
    let safe: String = key
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || "-_.".contains(ch) {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let w = c.dir(&c.sub_work(&fmaps[0]), &format!("fmap_{safe}"))?;
    let by = |s: &str| fmaps.iter().rev().find(|f| f.suffix == s);
    let hz = c.deriv(
        &fmaps[0],
        "fieldmap",
        ".nii.gz",
        &[("desc", Some("preproc")), ("dir", None)],
    )?;
    let reference = join(&w, "fmapref_brain.nii.gz");
    let pd = by("phasediff").ok_or("only phasediff fieldmaps are supported")?;
    let dte_ms = 1000.0 * (pd.f64("EchoTime2").unwrap() - pd.f64("EchoTime1").unwrap());
    // shorter-TE magnitude (more signal) by its EchoTime, not its label: old dcm2niix swapped them (ds001796)
    let mag = ["magnitude1", "magnitude2"]
        .iter()
        .filter_map(|k| by(k))
        .min_by(|a, b| {
            (a.f64("EchoTime").unwrap_or(0.0), &a.suffix)
                .partial_cmp(&(b.f64("EchoTime").unwrap_or(0.0), &b.suffix))
                .unwrap()
        })
        .unwrap();
    c.run(
        argv![
            "brainchop-mindgrab",
            "-o",
            reference,
            "--mask",
            join(&w, "mask.nii.gz"),
            mag.path
        ],
        &[reference.clone()],
        None,
        None,
    )
    .await?;
    // ponytail: dilall + 3 mm blur stands in for sdcflows' B-spline fit/extrapolation
    c.run(
        argv![
            "niimath",
            pd.path,
            "-p",
            c.omp,
            "-fmapprep",
            reference,
            dte_ms,
            "-dilall",
            "-s",
            3usize,
            "-div",
            2.0 * PI,
            hz
        ],
        &[hz.clone()],
        None,
        None,
    )
    .await?;
    Ok(Fmap {
        hz,
        reference,
        jacobian: false,
        kind: format!("phasediff fieldmap ({} mask)", mag.suffix),
        method: "phasediff",
        dte_ms,
    })
}

pub struct Anat {
    pub preproc: String,
    pub surf_ref: String,
    pub brain: String,
    pub mask: String,
    /// GM, WM, CSF probability maps
    pub pve: [String; 3],
    /// aCompCor masks: CSF, WM, CSF+WM
    pub acc: [String; 3],
    pub aff: String,
    pub warp: String,
    pub robustfov: bool,
    pub inversions: Vec<Image>,
    pub denoised: bool,
    pub synthetic: Vec<String>,
    /// TopoFit surfaces were reconstructed.
    pub surfaces: bool,
}

/// [MP2RAGE denoise] [robustfov] N4 -> brain mask, tissue PVE, surfaces -> MNI normalisation.
pub async fn anat<H: Host>(
    c: &Ctx<H>,
    t1: &Image,
    robustfov: bool,
    inversions: Vec<Image>,
    topofit: bool,
) -> Result<Anat, String> {
    let d = |s: &str, ext: &str, over: &[(&str, Option<&str>)]| c.deriv(t1, s, ext, over);
    let w = c.dir(&c.sub_work(t1), "anat")?;
    let space = ("space", Some(TEMPLATE));
    let preproc = d("T1w", ".nii.gz", &[("desc", Some("preproc"))])?;
    let mask = d("mask", ".nii.gz", &[("desc", Some("brain"))])?;
    let brain = join(&w, "t1_brain.nii.gz");
    let pve = ["GM", "WM", "CSF"].map(|l| d("probseg", ".nii.gz", &[("label", Some(l))]));
    let pve = [pve[0].clone()?, pve[1].clone()?, pve[2].clone()?];
    let xfm = |desc: &'static str, ext: &str| {
        d(
            "xfm",
            ext,
            &[
                ("from", Some("T1w")),
                ("to", Some(TEMPLATE)),
                ("mode", Some("image")),
                ("desc", Some(desc)),
            ],
        )
    };
    let (xfm_aff, xfm_warp) = (xfm("affine", ".mat")?, xfm("warp", ".nii.gz")?);
    let surf = join(
        &c.out,
        &format!("sub-{}/surf", t1.ents.get("sub").unwrap_or("")),
    );
    let acc = ["csf", "wm", "csfwm"].map(|n| join(&w, &format!("acc_{n}.nii.zst")));

    let denoised = !inversions.is_empty() && t1.ents.get("rec") != Some("denoised");
    let mut src = t1.path.clone();
    if denoised {
        // raw MP2RAGE UNI: amplified background noise; rebuild it as the vendor's UNI-DEN would
        src = join(&w, "unit1_denoised.nii.gz");
        let invs: Vec<&str> = inversions.iter().map(|i| i.path.as_str()).collect();
        c.run(
            argv![
                "niimath",
                t1.path,
                "-p",
                c.omp,
                "-mp2rage",
                ..invs,
                MP2RAGE_FACTOR,
                src
            ],
            &[src.clone()],
            None,
            None,
        )
        .await?;
    }
    if robustfov {
        // drop neck/shoulders before everything (FSL robustfov); world coordinates are kept
        let crop = join(&w, "t1_robustfov.nii.gz");
        c.run(
            argv!["niimath", src, "-robustfov", crop],
            &[crop.clone()],
            None,
            None,
        )
        .await?;
        src = crop;
    }
    c.run(
        argv!["niimath", src, "-p", c.omp, "-n4", preproc],
        &[preproc.clone()],
        None,
        None,
    )
    .await?;

    // strip and normalise. SyN moves a neck-cropped whole head with NMI scored only inside the template brain mask
    // (greedy -gm), as fMRIPrep/ANTs do: two skull-stripped images make greedy chase the masks' differing brainstem
    // cut-offs. Transforms are world-mm, so they apply to preproc.
    c.run(
        argv!["brainchop-mindgrab", "-o", brain, "--mask", mask, preproc],
        &[brain.clone(), mask.clone()],
        None,
        None,
    )
    .await?;
    let fov = if robustfov {
        preproc.clone()
    } else {
        join(&w, "t1_fov.nii.gz")
    };
    if !robustfov {
        c.run(
            argv!["niimath", preproc, "-robustfov", fov],
            &[fov.clone()],
            None,
            None,
        )
        .await?;
    }
    let greedy = argv![
        "greedy-rs",
        "-d",
        3usize,
        "-threads",
        c.omp,
        "-V",
        0usize,
        "-m",
        "NMI",
        "-n",
        "100x50x10"
    ];
    // affine brain-to-brain: whole-head NMI let the scalp/neck win on ds001796 (mask Dice 0.69 vs 0.96)
    c.run(
        argv![
            ..greedy.clone(),
            "-i",
            c.tpl.brain,
            brain,
            "-a",
            "-ia-image-centers",
            "-o",
            xfm_aff
        ],
        &[xfm_aff.clone()],
        None,
        None,
    )
    .await?;
    c.run(
        argv![
            ..greedy,
            "-i",
            c.tpl.t1w,
            fov,
            "-gm",
            c.tpl.mask,
            "-it",
            xfm_aff,
            "-sv",
            "-o",
            xfm_warp
        ],
        &[xfm_warp.clone()],
        None,
        None,
    )
    .await?;
    for (s, dst, interp) in [
        (
            &preproc,
            d("T1w", ".nii.gz", &[("desc", Some("preproc")), space])?,
            vec![],
        ),
        (
            &mask,
            d("mask", ".nii.gz", &[("desc", Some("brain")), space])?,
            argv!["-ri", "NN"],
        ),
    ] {
        c.run(
            argv![
                "greedy-rs",
                "-d",
                3usize,
                "-threads",
                c.omp,
                "-rf",
                c.tpl.brain,
                ..interp,
                "-rm",
                s,
                dst,
                "-r",
                xfm_warp,
                xfm_aff
            ],
            &[dst.clone()],
            None,
            None,
        )
        .await?;
    }

    // segment
    let tmp = ["gm", "wm", "csf"].map(|n| join(&w, &format!("pve_{n}.nii.gz")));
    // the work copies stay so the step's resume record sees new inputs; a rerun refreshes the derivatives
    let ran = c
        .run(
            argv![
                "brainchop-mindmap",
                "--pve",
                "-o",
                join(&w, "pve.nii.gz"),
                preproc
            ],
            &tmp,
            None,
            None,
        )
        .await?;
    for (t, p) in tmp.iter().zip(&pve) {
        if ran || !c.h.exists(p) {
            c.h.copy(t, p)?;
        }
    }
    // fMRIPrep acompcor_masks: GM > 0.05 dilated by ball(3) is excluded from WM and CSF+WM; the Gaussian blur
    // (sigma = T1w voxel) stands in for ANTs' Gaussian interpolation to BOLD.
    let vox = t1.hdr.zooms.iter().take(3).sum::<f64>() / 3.0;
    let notgm = join(&w, "notgm.nii.zst");
    c.run(
        argv![
            "niimath",
            pve[0],
            "-thr",
            0.05,
            "-bin",
            "-kernel",
            "sphere",
            3.0 * vox,
            "-dilF",
            "-binv",
            "-save",
            join(&w, "notgm"),
            "-restart",
            pve[1],
            "-mas",
            notgm,
            "-s",
            vox,
            "-save",
            acc[1],
            "-restart",
            pve[2],
            "-s",
            vox,
            "-save",
            acc[0],
            "-restart",
            pve[2],
            "-add",
            pve[1],
            "-mas",
            notgm,
            "-s",
            vox,
            acc[2]
        ],
        // notgm is saved then re-read by this command, so it is an output: a rerun must not see the old one
        &[
            acc[0].clone(),
            acc[1].clone(),
            acc[2].clone(),
            notgm.clone(),
        ],
        ZST,
        None,
    )
    .await?;

    // surfaces. topofit's memory guard rejects big T1s; it conforms to 1 mm 256^3 anyway, so do that first
    let big = t1.hdr.shape.iter().take(3).product::<usize>() > 256usize.pow(3);
    let surf_ref = if big {
        join(&w, "t1_conform.nii.gz")
    } else {
        preproc.clone()
    };
    if topofit {
        let names: Vec<String> = ["lh", "rh"]
            .iter()
            .flat_map(|h| ["white", "pial"].map(|s| join(&surf, &format!("{h}.{s}"))))
            .collect();
        if big {
            c.run(
                argv!["niimath", preproc, "-conform", surf_ref],
                &[surf_ref.clone()],
                None,
                None,
            )
            .await?;
        }
        // ponytail: onnxruntime-node can abort in exit teardown under load (recursive_mutex); outputs are complete
        // once 'files in' prints, so accept that crash until upstream exits cleanly
        c.run(
            argv!["topofit", surf_ref, "-o", surf, "--threads", c.omp],
            &names,
            None,
            Some("files in"),
        )
        .await?;
    }
    let synthetic = t1
        .meta
        .get("SynthesizedFrom")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(py::value).collect())
        .unwrap_or_default();
    Ok(Anat {
        preproc,
        surf_ref,
        brain,
        mask,
        pve,
        acc,
        aff: xfm_aff,
        warp: xfm_warp,
        robustfov,
        inversions,
        denoised,
        synthetic,
        surfaces: topofit,
    })
}

/// No anatomical scan: SynthSR on the mean of every run's (distortion-corrected) motion-correction reference, each
/// rigidly aligned to the first. It keeps the EPI's distortion, so SynthSR SDC must not use it.
pub async fn synth_t1w<H: Host>(
    c: &Ctx<H>,
    label: &str,
    refs: &[String],
    bolds: &[Image],
) -> Result<Image, String> {
    let w = c.dir(&join(&c.work, &format!("sub-{label}")), "anat")?;
    let mut aligned = vec![refs[0].clone()];
    for (i, r) in refs.iter().enumerate().skip(1) {
        let (img, mat) = (
            join(&w, &format!("synth_src_{i}.nii.zst")),
            join(&w, &format!("synth_src_{i}.json")),
        );
        c.run(
            argv![
                "niimath",
                r,
                "-p",
                c.omp,
                "-allineate",
                refs[0],
                "-warp",
                "shr",
                "-savemat",
                mat,
                img
            ],
            &[mat.clone()],
            ZST,
            None,
        )
        .await?;
        aligned.push(img);
    }
    let mean = join(&w, "synth_src_mean.nii.gz");
    let adds: Vec<String> = aligned[1..]
        .iter()
        .flat_map(|a| ["-add".to_string(), a.clone()])
        .collect();
    c.run(
        argv!["niimath", aligned[0], ..adds, "-div", aligned.len(), mean],
        &[mean.clone()],
        None,
        None,
    )
    .await?;
    let rel = format!("sub-{label}/anat/sub-{label}_rec-synthsr_T1w.nii.gz");
    let t1 = join(&c.out, &rel);
    c.h.mkdirs(crate::host::parent(&t1))?;
    c.run(
        argv![
            "synthsr",
            mean,
            t1,
            "--force",
            "--quiet",
            "--threads",
            c.omp
        ],
        &[t1.clone()],
        None,
        None,
    )
    .await?;
    // sidecar: provenance, plus the scanner fields methods() reads from a T1w
    let m = &bolds[0].meta;
    let mut side = Map::new();
    for k in [
        "Manufacturer",
        "ManufacturersModelName",
        "MagneticFieldStrength",
        "ReceiveCoilName",
    ] {
        if let Some(v) = m.get(k) {
            side.insert(k.into(), v.clone());
        }
    }
    side.insert(
        "SynthesizedFrom".into(),
        json!(bolds.iter().map(Image::name).collect::<Vec<_>>()),
    );
    c.put(
        &t1.replace(".nii.gz", ".json"),
        &serde_json::to_string_pretty(&side).unwrap(),
    )
    .await?;
    let (ents, suffix) = bids::parse_name(crate::host::file_name(&rel))?;
    Ok(Image {
        hdr: Rc::new(nifti::read(&c.h, &t1).await?),
        path: t1,
        rel,
        ents,
        suffix,
        meta: Rc::new(side),
        echoes: vec![],
        phases: vec![],
    })
}

pub struct Fit {
    pub series: String,
    pub reference: String,
    pub coreg_ref: String,
    pub nss: String,
    pub hmc: String,
    pub mask: String,
    pub coreg: String,
    pub sdc: Vec<String>,
    pub sdc_name: String,
    pub sdc_methods: Vec<&'static str>,
    pub frisgo: Option<String>,
    pub frisgo_args: Vec<String>,
    pub openrecon: bool,
    pub fmap: Option<Rc<Fmap>>,
    pub fmap_unusable: Option<String>,
    pub coreg_cost: String,
    pub ref_t1: String,
}

pub enum Fitted {
    /// No anatomy yet: the corrected motion-correction reference, for `synth_t1w`.
    Reference(String),
    Full(Box<Fit>),
}

fn inverse_json(x: &Value) -> String {
    let mut m = x.as_object().cloned().unwrap_or_default();
    let (f2m, m2f) = (
        m.get("fixed_to_moving").cloned(),
        m.get("moving_to_fixed").cloned(),
    );
    m.insert("fixed_to_moving".into(), m2f.unwrap_or(Value::Null));
    m.insert("moving_to_fixed".into(), f2m.unwrap_or(Value::Null));
    serde_json::to_string(&m).unwrap()
}

/// allineate -savemat JSON with its direction swapped (-mat pulls grid world -> input world).
pub async fn invert_xfm<H: Host>(c: &Ctx<H>, src: &str, dst: &str) -> Result<String, String> {
    c.put(dst, &inverse_json(&c.json(src).await?)).await?;
    Ok(dst.to_string())
}

fn matrix(v: &Value) -> Result<Vec<Vec<f64>>, String> {
    v.as_array()
        .and_then(|rows| {
            rows.iter()
                .map(|r| r.as_array()?.iter().map(Value::as_f64).collect())
                .collect()
        })
        .ok_or_else(|| "transform JSON lacks a numeric fixed_to_moving matrix".to_string())
}

/// One BOLD read -> dummy scans, boldref, head-motion parameters; [SDC]; then boldref -> T1w.
#[allow(clippy::too_many_arguments)]
pub async fn bold_fit<H: Host>(
    c: &Ctx<H>,
    bold: &Image,
    anat: Option<&Anat>,
    fm: Option<Rc<Fmap>>,
    fmap_unusable: Option<String>,
    synthsr: &str,
    frisgo: &str,
) -> Result<Fitted, String> {
    let d = |s: &str, ext: &str, over: &[(&str, Option<&str>)]| c.deriv(bold, s, ext, over);
    let w = c.dir(&c.sub_work(bold), &bold.name())?;
    let reference = d("boldref", ".nii.gz", &[("desc", Some("hmc"))])?;
    let nss = join(&w, "nss.json");
    let hmc = d(
        "xfm",
        ".1D",
        &[
            ("from", Some("orig")),
            ("to", Some("boldref")),
            ("mode", Some("image")),
            ("desc", Some("hmc")),
        ],
    )?;
    let mask = d("mask", ".nii.gz", &[("desc", Some("brain"))])?;
    let ref_brain = join(&w, "boldref_brain.nii.gz");
    let coreg = d(
        "xfm",
        ".json",
        &[
            ("from", Some("boldref")),
            ("to", Some("T1w")),
            ("mode", Some("image")),
            ("desc", Some("coreg")),
        ],
    )?;

    let mut series = bold.path.clone();
    let tes: String = bold
        .echoes
        .iter()
        .map(|e| py::g(1000.0 * e.f64("EchoTime").unwrap()))
        .collect::<Vec<_>>()
        .join(",");
    if !bold.echoes.is_empty() {
        // echoes share each frame's motion and distortion, so combine once, before everything
        series = join(&w, "optcom.nii.zst");
        let rest: Vec<&str> = bold.echoes[1..].iter().map(|e| e.path.as_str()).collect();
        c.run(
            argv![
                "niimath",
                bold.echoes[0].path,
                "-p",
                c.omp,
                "-optcom",
                tes,
                ..rest,
                series
            ],
            &[series.clone()],
            ZST,
            None,
        )
        .await?;
    }
    // dual read polarity alternates a fuzzy ripple every volume (motor7T: 2-3% odd/even); remove it before motion
    // estimation, as it can zigzag the read-axis translation. Siemens OpenRecon FRISGO appends its own tag; its
    // output equals niimath -frisgo spline, so it is labelled spline.
    let openrecon = bold
        .meta
        .get("ImageTypeText")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().skip(4).any(|v| v.as_str() == Some("FRISGO")));
    let polarity = bold
        .meta
        .get("ReadPolarity")
        .map(py::value)
        .unwrap_or_default()
        .to_lowercase();
    let dual = polarity.starts_with("dual")
        && frisgo != "off"
        && bold.hdr.shape.get(3).copied().unwrap_or(1) >= SHORT_RUN
        && !openrecon;
    let frisgo_args = if dual {
        argv!["-frisgo", ..frisgo_mode(frisgo)]
    } else {
        vec![]
    };
    c.run(
        argv![
            "niimath",
            series,
            "-p",
            c.omp,
            ..frisgo_args.clone(),
            "-boldref",
            reference,
            nss,
            "-moco",
            "-ref",
            reference,
            "-estimate",
            hmc
        ],
        &[reference.clone(), nss.clone(), hmc.clone()],
        None,
        None,
    )
    .await?;
    let mut coreg_ref = reference.clone();
    let mut sdc: Vec<String> = vec![];
    let pe = bold.str("PhaseEncodingDirection").filter(|p| !p.is_empty());
    let tro = readout_time(bold).filter(|&t| t != 0.0);
    if (!bold.phases.is_empty() || fm.is_some()) && (pe.is_none() || tro.is_none()) {
        return Err(format!(
            "{}: SDC needs PhaseEncodingDirection and TotalReadoutTime (or EffectiveEchoSpacing)",
            bold.name()
        ));
    }
    // fMRIPrep: vsm (voxels) = Hz * readout, negated for a '-' phase-encoding direction
    let vsm = join(&w, "vsm.nii.zst");
    let mut vsm_ref = vsm.clone();
    let (mut sdc_name, mut sdc_methods) = ("none".to_string(), vec![]);
    let shift = match (pe, tro) {
        (Some(p), Some(t)) => t * if p.ends_with('-') { -1.0 } else { 1.0 },
        _ => 0.0,
    };
    let axis = pe.and_then(|p| p.get(..1)).unwrap_or_default().to_string();
    if !bold.phases.is_empty() {
        // MEDIC: one field map per frame, in that frame's native position
        let hz = join(&w, "medic_fieldmaps_native.nii.zst");
        let mags: Vec<&str> = bold.echoes.iter().map(|e| e.path.as_str()).collect();
        let phases: Vec<&str> = bold.phases.iter().map(|e| e.path.as_str()).collect();
        c.run(
            argv![
                "niimath",
                "--medic",
                "--magnitude",
                ..mags,
                "--phase",
                ..phases,
                "--te-ms",
                tes,
                "--total-readout-time",
                tro.unwrap(),
                "--phase-encoding-direction",
                pe.unwrap(),
                "--out-prefix",
                join(&w, "medic"),
                "--n-cpus",
                c.omp
            ],
            &[hz.clone()],
            ZST,
            None,
        )
        .await?;
        for unused in ["medic_fieldmaps.nii.zst", "medic_displacementmaps.nii.zst"] {
            c.h.remove(&join(&w, unused)); // only the native maps are used
        }
        vsm_ref = join(&w, "vsm_mean.nii.zst"); // boldref correction: the run's mean field
        c.run(
            argv![
                "niimath",
                hz,
                "-p",
                c.omp,
                "-mul",
                shift,
                "-save",
                join(&w, "vsm"),
                "-Tmean",
                join(&w, "vsm_mean")
            ],
            &[vsm.clone(), vsm_ref.clone()],
            ZST,
            None,
        )
        .await?;
        sdc = argv!["-vsm", vsm, axis];
        sdc_name = format!("MEDIC ({}-echo phase, per frame)", bold.echoes.len());
        sdc_methods = vec!["medic"];
    } else if let Some(f) = &fm {
        sdc_name = f.kind.clone();
        sdc_methods = vec![f.method];
        let (raw_brain, f2r) = (
            join(&w, "boldref_raw_brain.nii.gz"),
            join(&w, "fmap2boldref.json"),
        );
        sdc = argv!["-vsm", vsm, axis];
        if f.jacobian {
            sdc.push("-jacobian".into());
        }
        c.run(
            argv!["brainchop-mindgrab", "-o", raw_brain, reference],
            &[raw_brain.clone()],
            None,
            None,
        )
        .await?;
        c.run(
            argv![
                "niimath",
                f.reference,
                "-p",
                c.omp,
                "-allineate",
                raw_brain,
                "-warp",
                "shr",
                "-savemat",
                f2r,
                join(&w, "fmapref_on_boldref.nii.zst")
            ],
            &[f2r.clone()],
            ZST,
            None,
        )
        .await?;
        c.run(
            argv![
                "niimath",
                f.hz,
                "-p",
                c.omp,
                "-mul",
                shift,
                "-resample",
                reference,
                "-mat",
                f2r,
                vsm
            ],
            &[vsm.clone()],
            ZST,
            None,
        )
        .await?;
    }
    let synth = synthsr == "all" || (synthsr == "auto" && sdc.is_empty());
    let ref_vsm: Vec<String> = if sdc.is_empty() {
        vec![]
    } else {
        argv!["-vsm", vsm_ref, ..&sdc[2..]]
    };
    if !sdc.is_empty() {
        coreg_ref = if synth {
            join(&w, "boldref_fmap_sdc.nii.gz")
        } else {
            d("boldref", ".nii.gz", &[("desc", Some("coreg"))])?
        };
        c.run(
            argv![
                "niimath",
                reference,
                "-p",
                c.omp,
                "-resample",
                reference,
                ..ref_vsm.clone(),
                coreg_ref
            ],
            &[coreg_ref.clone()],
            None,
            None,
        )
        .await?;
    }
    let (mask_arg, mask_out) = if synth {
        (vec![], vec![])
    } else {
        (argv!["--mask", mask], vec![mask.clone()])
    };
    let mut outs = vec![ref_brain.clone()];
    outs.extend(mask_out);
    c.run(
        argv!["brainchop-mindgrab", "-o", ref_brain, ..mask_arg, coreg_ref],
        &outs,
        None,
        None,
    )
    .await?;
    let Some(anat) = anat else {
        return Ok(Fitted::Reference(coreg_ref));
    };

    // lpc 12-DOF (local inverse-contrast pattern) is the fit; a rigid fast-cost fit is the sanity check. The fast
    // engine's 12-DOF costs reward brain-mask coverage over anatomy (uncorrected motor3T run-1: 1.21x AP zoom).
    let mut ref_t1 = join(&w, "boldref_space-T1w.nii.zst"); // QC images: read only by niimath
    let trial = |k: &str| {
        (
            join(&w, &format!("coreg_{k}.json")),
            join(&w, &format!("boldref_space-T1w_{k}.nii.zst")),
        )
    };
    let (lpc, rigid) = (trial("lpc"), trial("rigid"));
    let lpc_ran = c
        .run(
            argv![
                "niimath",
                ref_brain,
                "-p",
                c.omp,
                "-allineate",
                anat.brain,
                "-cost",
                "lpc",
                "-savemat",
                lpc.0,
                lpc.1
            ],
            &[lpc.0.clone()],
            ZST,
            None,
        )
        .await?;
    let rigid_ran = c
        .run(
            argv![
                "niimath",
                ref_brain,
                "-p",
                c.omp,
                "-allineate",
                anat.brain,
                "-warp",
                "shr",
                "-savemat",
                rigid.0,
                rigid.1
            ],
            &[rigid.0.clone()],
            ZST,
            None,
        )
        .await?;
    let xl = matrix(&c.json(&lpc.0).await?["fixed_to_moving"])?;
    let xr = matrix(&c.json(&rigid.0).await?["fixed_to_moving"])?;
    let (stray, zooms) = (disagreement_mm(&xl, &xr, 80.0), axis_zooms(&xl));
    // same-subject EPI->T1: accepted fits zoom <3% and sit 1-11 mm from the rigid fit; failures 17-25% / 22-190 mm
    let is_lpc = stray < 20.0 && zooms.iter().all(|&z| 0.9 < z && z < 1.1);
    let (pick, pick_ran) = if is_lpc {
        (&lpc, lpc_ran)
    } else {
        (&rigid, rigid_ran)
    };
    // Rewritten only when the chosen fit changes (new inputs on resume), keeping the timestamp downstream resume
    // records depend on; a rerun candidate's QC image is refreshed regardless.
    let changed = c.put(&coreg, &c.text(&pick.0).await?).await?;
    if changed && !is_lpc {
        let z: Vec<String> = zooms.iter().map(|z| format!("{z:.2}")).collect();
        c.h.log(&format!(
            "  warning: {}: lpc coreg implausible ({stray:.0} mm from rigid, zooms {}); using the rigid fit",
            bold.name(),
            z.join(", ")
        ));
    }
    if changed || pick_ran || !c.h.exists(&ref_t1) {
        c.h.copy(&pick.1, &ref_t1)?;
    }
    let coreg_cost = if is_lpc {
        "lpc, 12 DOF"
    } else {
        "rigid fast cost (lpc implausible)"
    }
    .to_string();
    if synth {
        // SynthSR makes a T1w-like image that keeps the EPI's (residual) distortion; greedy warps the subject's T1w
        // brain, placed in BOLD space by the coreg, onto it. The full 3D field follows the coreg in the pull chain
        // (-bwarp), so coreg + warp stay consistent without a refit.
        let (ssr, ssr_brain) = (join(&w, "synthsr.nii.gz"), join(&w, "synthsr_brain.nii.gz"));
        let (t1_on, bwarp) = (
            join(&w, "t1brain_on_synthsr.nii.gz"),
            join(&w, "synthsr_warp.nii.gz"),
        );
        let fin = d("boldref", ".nii.gz", &[("desc", Some("coreg"))])?;
        c.run(
            argv![
                "synthsr",
                coreg_ref,
                ssr,
                "--force",
                "--quiet",
                "--threads",
                c.omp
            ],
            &[ssr.clone()],
            None,
            None,
        )
        .await?;
        c.run(
            argv!["brainchop-mindgrab", "-o", ssr_brain, ssr],
            &[ssr_brain.clone()],
            None,
            None,
        )
        .await?;
        let inv = invert_xfm(c, &coreg, &join(&w, "coreg_inverse.json")).await?;
        let both = join(&w, "synthsr_metric_mask.nii.gz");
        c.run(
            argv![
                "niimath",
                anat.brain,
                "-resample",
                ssr_brain,
                "-mat",
                inv,
                t1_on
            ],
            &[t1_on.clone()],
            None,
            None,
        )
        .await?;
        // score NMI only where both brains exist and >= 10 mm (SynthSR's 1 mm voxels) inside the EPI FOV: matching
        // tissue the FOV clips let greedy drag the T1w 33-42 mm along z, out of the FOV (black dome)
        let t1_mask_on = join(&w, "t1mask_on_synthsr.nii.gz");
        let e = 10usize;
        c.run(
            argv![
                "niimath",
                anat.mask,
                "-resample",
                ssr_brain,
                "-mat",
                inv,
                t1_mask_on
            ],
            &[t1_mask_on.clone()],
            None,
            None,
        )
        .await?; // -resample can't chain
        let shape = nifti::read(&c.h, &ssr).await?.shape;
        let roi: Vec<usize> = shape
            .iter()
            .take(3)
            .flat_map(|&n| [e.min(n / 4), n - 2 * e.min(n / 4)])
            .collect(); // thin slabs
        c.run(
            argv![
                "niimath",
                t1_mask_on,
                "-thr",
                0.5,
                "-bin",
                "-mas",
                ssr_brain,
                "-ero",
                "-roi",
                ..roi,
                0usize,
                1usize,
                both
            ],
            &[both.clone()],
            None,
            None,
        )
        .await?;
        c.run(
            argv![
                "greedy-rs",
                "-d",
                3usize,
                "-m",
                "NMI",
                "-i",
                t1_on,
                ssr_brain,
                "-gm",
                both,
                "-o",
                bwarp,
                "-sv",
                "-n",
                "100x50x10",
                "-threads",
                c.omp
            ],
            &[bwarp.clone()],
            None,
            None,
        )
        .await?;
        sdc.extend(argv!["-bwarp", bwarp]);
        sdc_methods.push("synthsr");
        sdc_name = if ref_vsm.is_empty() {
            "SynthSR + greedy 3D warp (fieldmap-less)".into()
        } else {
            format!("{sdc_name} + SynthSR residual warp")
        };
        c.run(
            argv![
                "niimath",
                reference,
                "-p",
                c.omp,
                "-resample",
                reference,
                ..ref_vsm.clone(),
                "-bwarp",
                bwarp,
                fin
            ],
            &[fin.clone()],
            None,
            None,
        )
        .await?;
        c.run(
            argv![
                "brainchop-mindgrab",
                "-o",
                join(&w, "boldref_sdc_brain.nii.gz"),
                "--mask",
                mask,
                fin
            ],
            &[mask.clone()],
            None,
            None,
        )
        .await?;
        coreg_ref = fin;
        ref_t1 = join(&w, "boldref_space-T1w_synthsr.nii.zst");
        c.run(
            argv![
                "niimath",
                reference,
                "-p",
                c.omp,
                "-resample",
                anat.brain,
                "-mat",
                coreg,
                ..ref_vsm,
                "-bwarp",
                bwarp,
                ref_t1
            ],
            &[ref_t1.clone()],
            ZST,
            None,
        )
        .await?;
    }
    Ok(Fitted::Full(Box::new(Fit {
        series,
        reference,
        coreg_ref,
        nss,
        hmc,
        mask,
        coreg,
        sdc,
        sdc_name,
        sdc_methods,
        frisgo: if openrecon {
            Some("spline".into())
        } else if dual {
            Some(frisgo.into())
        } else {
            None
        },
        frisgo_args,
        openrecon,
        fmap: fm,
        fmap_unusable,
        coreg_cost,
        ref_t1,
    })))
}

/// tSNR map (BIDS parametric map on the boldref grid) and the work-dir JSON with its brain median.
pub fn tsnr_paths<H: Host>(
    c: &Ctx<H>,
    bold: &Image,
    fit: &Fit,
) -> Result<(String, String), String> {
    Ok((
        c.deriv(bold, "boldmap", ".nii.gz", &[("stat", Some("tsnr"))])?,
        join(crate::host::parent(&fit.ref_t1), "tsnr.json"),
    ))
}

/// FRISGO and slice-timing arguments for every read of this run's raw series: (args, STC reference time or None).
/// Slice timing applies along k only, reversed for k-.
async fn series_args<H: Host>(
    c: &Ctx<H>,
    bold: &Image,
    fit: &Fit,
    w: &str,
) -> Result<(Vec<String>, Option<f64>), String> {
    let mut args = fit.frisgo_args.clone();
    let meta = &bold.meta;
    let Some(st) = bids::slice_timing(meta).filter(|_| bids::stc_applies(meta)) else {
        return Ok((args, None));
    };
    let st: Vec<Value> = if bids::slice_encoding(meta) == "k-" {
        st.iter().rev().cloned().collect()
    } else {
        st.clone()
    };
    // fMRIPrep: slice-time ref 0.5 = midpoint of the slice acquisition range
    let t: Vec<f64> = st.iter().filter_map(Value::as_f64).collect();
    let (lo, hi) = (
        t.iter().copied().fold(f64::INFINITY, f64::min),
        t.iter().copied().fold(f64::NEG_INFINITY, f64::max),
    );
    let tz = py::round(lo + 0.5 * (hi - lo), 3);
    let txt = join(w, "slicetiming.txt");
    c.put(
        &txt,
        &st.iter().map(py::value).collect::<Vec<_>>().join(","),
    )
    .await?;
    args.extend(argv![
        "-stc",
        "--slicetiming",
        format!("@{txt}"),
        "-tzero",
        tz
    ]);
    Ok((args, Some(tz)))
}

/// One BOLD read -> STC -> confounds -> one-shot cubic resampling (HMC + coreg [+ MNI warp]) per space.
pub async fn bold_apply<H: Host>(
    c: &Ctx<H>,
    bold: &Image,
    fit: &Fit,
    anat: &Anat,
) -> Result<(), String> {
    let d = |s: &str, ext: &str, over: &[(&str, Option<&str>)]| c.deriv(bold, s, ext, over);
    let w = join(&c.sub_work(bold), &bold.name());
    let meta = &bold.meta;
    let long_run = bold.hdr.shape.get(3).copied().unwrap_or(1) >= SHORT_RUN;
    // ponytail: isotropic res-native; anisotropic BOLD gets the min zoom
    let res = bold
        .hdr
        .zooms
        .iter()
        .take(3)
        .copied()
        .fold(f64::INFINITY, f64::min);
    let spaces = [
        ("T1w", anat.preproc.clone(), vec![]),
        (
            TEMPLATE,
            c.tpl.brain.clone(),
            argv!["-warp", anat.warp, anat.aff],
        ),
    ];
    let mut outs = vec![];
    for (sp, _, _) in &spaces {
        outs.push(d(
            "bold",
            ".nii.gz",
            &[("space", Some(sp)), ("desc", Some("preproc"))],
        )?);
    }
    let sed = bids::slice_encoding(meta);
    if bids::slice_timing(meta).is_some() && !bids::stc_applies(meta) {
        c.h.log(&format!(
            "  warning: {}: SliceEncodingDirection {sed}; slice timing not corrected",
            bold.name()
        ));
    }
    let (pre, tzero) = series_args(c, bold, fit, &w).await?;
    let mut cmd = argv!["niimath", fit.series, "-p", c.omp, ..pre];
    let confounds = d("timeseries", ".tsv", &[("desc", Some("confounds"))])?;
    let dummy = c.json(&fit.nss).await?["dummy_scans"].clone();
    let (tsnr_map, tsnr_json) = tsnr_paths(c, bold, fit)?;
    let tsnr = if long_run {
        argv!["-tsnr", tsnr_map, tsnr_json]
    } else {
        vec![]
    }; // mean / SD after trends + motion
    cmd.extend(argv![
        "-confounds",
        confounds,
        "-tr",
        meta["RepetitionTime"],
        "-dummy",
        dummy,
        "-hmc",
        fit.hmc,
        "-ref",
        fit.reference,
        "-brain",
        fit.mask,
        "-anat",
        ..anat.acc.clone(),
        anat.mask,
        fit.coreg,
        ..fit.sdc.clone(),
        ..tsnr
    ]);
    for ((_, grid, extra), o) in spaces.iter().zip(&outs) {
        cmd.extend(argv![
            "-resample",
            grid,
            "-res",
            res,
            "-hmc",
            fit.hmc,
            "-mat",
            fit.coreg,
            ..extra.clone(),
            ..fit.sdc.clone(),
            o
        ]);
    }
    let mut declared = vec![confounds];
    if long_run {
        declared.extend([tsnr_map, tsnr_json]);
    }
    declared.extend(outs.iter().cloned());
    c.run(cmd, &declared, None, None).await?;
    let mut side = Map::new();
    side.insert("RepetitionTime".into(), meta["RepetitionTime"].clone());
    side.insert("SkullStripped".into(), json!(false));
    side.insert(
        "SusceptibilityDistortionCorrected".into(),
        json!(!fit.sdc.is_empty()),
    );
    side.insert("SliceTimingCorrected".into(), json!(tzero.is_some()));
    if let Some(tz) = tzero {
        side.insert("StartTime".into(), json!(tz));
    }
    if let Some(u) = &fit.fmap_unusable {
        side.insert("FieldmapUnusable".into(), json!(u));
    }
    if let Some(f) = &fit.frisgo {
        side.insert(
            "FuzzyRippleCorrection".into(),
            json!(format!(
                "{f}{}",
                if fit.openrecon {
                    " (OpenRecon, on the scanner)"
                } else {
                    ""
                }
            )),
        );
    }
    if fit.frisgo.as_deref() == Some("spline") {
        // volumes now sit midway between acquisitions: reference time - TR/2
        let tr = meta["RepetitionTime"].as_f64().unwrap_or(0.0);
        let mid = tzero.unwrap_or_else(|| {
            meta.get("AcquisitionDuration")
                .and_then(Value::as_f64)
                .unwrap_or(tr)
                / 2.0
        });
        side.insert("StartTime".into(), json!(py::round(mid - tr / 2.0, 3)));
    }
    let text = serde_json::to_string_pretty(&side).unwrap();
    for o in &outs {
        c.put(&o.replace(".nii.gz", ".json"), &text).await?;
    }
    Ok(())
}

pub fn sidecar_of(p: &str) -> String {
    p.replace(".nii.gz", ".json")
}

/// ME-ICA derivatives: published tables/maps (meica name, path), denoised series (space, path), denoised t maps.
pub struct MeicaPaths {
    pub published: Vec<(&'static str, String)>,
    pub denoised: Vec<(&'static str, String)>,
    pub tmaps: Vec<String>,
}

pub fn meica_paths<H: Host>(c: &Ctx<H>, bold: &Image) -> Result<MeicaPaths, String> {
    let mut p = MeicaPaths {
        published: vec![],
        denoised: vec![],
        tmaps: vec![],
    };
    for (m, suffix, ext, ents) in MEICA_PUBLISHED {
        p.published.push((m, c.deriv(bold, suffix, ext, ents)?));
    }
    for sp in ["T1w", TEMPLATE] {
        let o = c.deriv(
            bold,
            "bold",
            ".nii.gz",
            &[("space", Some(sp)), ("desc", Some("denoised"))],
        )?;
        p.denoised.push((sp, o));
    }
    for (k, _) in TASK_CONTRASTS {
        let desc = format!("{k}Denoised");
        p.tmaps.push(c.deriv(
            bold,
            "boldmap",
            ".nii.gz",
            &[
                ("space", Some("T1w")),
                ("stat", Some("t")),
                ("desc", Some(&desc)),
            ],
        )?);
    }
    Ok(p)
}

/// Whether a meica tree (bundled name or JSON file) decides with external regressors (`--external`).
async fn tree_takes_regressors<H: Host>(c: &Ctx<H>, tree: &str) -> Result<bool, String> {
    if matches!(tree, "motion_f" | "motion_aroma") || tree.starts_with("demo_external") {
        return Ok(true);
    }
    if !c.h.exists(tree) {
        return Ok(false);
    }
    // meica's own rule: the key is present and not null
    Ok(c.json(tree)
        .await?
        .get("external_regressor_config")
        .is_some_and(|v| !v.is_null()))
}

/// ME-ICA (meica: tedana's workflow in Rust) after bold_apply, for runs with >= 3 echoes. Components are classified
/// on the echoes resampled onto the boldref grid with the preproc series' own FRISGO, STC, HMC and SDC; the rejected
/// ones are then regressed from each space's preproc series (tedana's non-aggressive denoising), so the outputs keep
/// their single interpolation. Unless `mode` is "on", a failure leaves preproc alone and is reported.
pub async fn bold_meica<H: Host>(
    c: &Ctx<H>,
    bold: &Image,
    fit: &Fit,
    mode: &str,
    tree: &str,
) -> Result<(), String> {
    let w = join(&c.sub_work(bold), &bold.name());
    let status_file = join(&w, "meica.json");
    if bold.echoes.is_empty() && !c.h.exists(&status_file) {
        return Ok(());
    }
    let old = if c.h.exists(&status_file) {
        c.json(&status_file).await?
    } else {
        json!({})
    };
    let p = meica_paths(c, bold)?;
    let mut made: Vec<String> = p.published.iter().map(|(_, x)| x.clone()).collect();
    made.extend(p.denoised.iter().map(|(_, x)| x.clone()));
    made.extend(p.denoised.iter().map(|(_, x)| sidecar_of(x)));
    made.extend(p.tmaps.iter().cloned());
    made.push(join(&w, "task_glm_denoised.json"));
    made.push(join(&w, "meica_qc.json"));
    made.extend(
        TASK_CONTRASTS
            .iter()
            .map(|(k, _)| join(&w, &format!("tstat_{k}_denoised_on_t1w.nii.zst"))),
    );
    if bold.echoes.is_empty() {
        // an earlier multi-echo run of this name: its ME-ICA files no longer apply
        for f in made.iter().chain([&status_file]) {
            c.h.remove(f);
        }
        return Ok(());
    }
    let n = bold.hdr.shape.get(3).copied().unwrap_or(1);
    let nss = c.json(&fit.nss).await?["dummy_scans"].clone();
    let usable = n.saturating_sub(nss.as_u64().unwrap_or(0) as usize);
    let skip = if mode == "off" {
        Some("turned off (--meica off)".to_string())
    } else if bold.echoes.len() < 3 {
        Some(format!(
            "{} echoes; ME-ICA needs 3 or more",
            bold.echoes.len()
        ))
    } else if mode == "auto" && usable < MEICA_MIN_VOLUMES {
        Some(format!(
            "{usable} usable volumes, under the {MEICA_MIN_VOLUMES} --meica auto requires (--meica on overrides)"
        ))
    } else {
        None
    };
    // nothing from another tree, or from a run that no longer gets ME-ICA, survives
    if skip.is_some() || old.get("tree").and_then(Value::as_str) != Some(tree) {
        for f in &made {
            c.h.remove(f);
        }
    }
    if let Some(reason) = skip {
        let status = json!({"status": "skipped", "reason": reason});
        return c.put(&status_file, &status.to_string()).await.map(|_| ());
    }
    // ponytail: one folder per tree name; a JSON tree edited in place under the same name needs work/ cleared
    let mut slug = String::new();
    for ch in tree.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.ends_with('_') {
            slug.push('_');
        }
    }
    let dir = format!("meica_{slug}");
    let md = join(&w, &dir);
    let mut preproc = vec![];
    for (sp, _) in &p.denoised {
        preproc.push(c.deriv(
            bold,
            "bold",
            ".nii.gz",
            &[("space", Some(sp)), ("desc", Some("preproc"))],
        )?);
    }
    let conf = c.deriv(bold, "timeseries", ".tsv", &[("desc", Some("confounds"))])?;
    let (metrics, mixing) = (
        join(&md, "desc-tedana_metrics.tsv"),
        join(&md, "desc-ICA_mixing.tsv"),
    );
    let rel = |x: &str| {
        x.strip_prefix(&format!("{}/", c.out))
            .unwrap_or(x)
            .to_string()
    };
    let result: Result<Value, String> = async {
        let (pre, _) = series_args(c, bold, fit, &w).await?;
        let mut echoes = vec![];
        for (i, e) in bold.echoes.iter().enumerate() {
            // classification input only; gzip because meica reads no .nii.zst
            let o = join(&w, &format!("echo-{}_space-boldref_bold.nii.gz", i + 1));
            c.run(
                argv![
                    "niimath",
                    e.path,
                    "-p",
                    c.omp,
                    ..pre.clone(),
                    "-resample",
                    fit.reference,
                    "-hmc",
                    fit.hmc,
                    ..fit.sdc.clone(),
                    o
                ],
                std::slice::from_ref(&o),
                None,
                None,
            )
            .await?;
            echoes.push(o);
        }
        let tes: Vec<String> = bold
            .echoes
            .iter()
            .map(|e| py::g(1000.0 * e.f64("EchoTime").unwrap_or(f64::NAN)))
            .collect();
        let ext = if tree_takes_regressors(c, tree).await? {
            argv!["--external", conf]
        } else {
            vec![]
        };
        let mut outs = vec![join(&md, "desc-ICACrossComponent_metrics.json")];
        outs.extend(MEICA_PUBLISHED.iter().map(|(m, ..)| join(&md, m)));
        // ponytail: the mask shares the echoes' boldref grid by construction (meica checks only the dimensions)
        c.run(
            argv![
                "meica",
                "-d",
                ..echoes,
                "-e",
                ..tes,
                "--mask",
                fit.mask,
                "--dummy-scans",
                nss,
                "--tree",
                tree,
                ..ext,
                "--n-threads",
                c.omp,
                "--quiet",
                "--out-dir",
                md
            ],
            &outs,
            None,
            None,
        )
        .await?;
        for (m, x) in &p.published {
            c.h.copy(&join(&md, m), x)?;
        }
        let classes: Vec<String> = tsv(&c.text(&metrics).await?)
            .iter()
            .map(|r| field(r, "classification").to_string())
            .collect();
        let count = |k: &str| classes.iter().filter(|c| *c == k).count();
        let version = c.json(&join(&md, "dataset_description.json")).await?["GeneratedBy"][0]
            ["Version"]
            .clone();
        let info = json!({"Tree": tree, "Components": classes.len(), "Accepted": count("accepted"), "Rejected": count("rejected"), "Version": version});
        let published = |m: &str| p.published.iter().find(|(x, _)| *x == m).unwrap().1.as_str();
        for ((_, o), pp) in p.denoised.iter().zip(&preproc) {
            c.run(
                argv![
                    "meica",
                    "--denoise",
                    pp,
                    "--mixing",
                    mixing,
                    "--metrics",
                    metrics,
                    "--dummy-scans",
                    nss,
                    "-o",
                    o
                ],
                std::slice::from_ref(o),
                None,
                None,
            )
            .await?;
            let mut side = c
                .json(&sidecar_of(pp))
                .await?
                .as_object()
                .cloned()
                .unwrap_or_default();
            side.insert(
                "Sources".into(),
                json!([
                    rel(pp),
                    rel(published("desc-ICA_mixing.tsv")),
                    rel(published("desc-tedana_metrics.tsv"))
                ]),
            );
            side.insert("MEICA".into(), info.clone());
            c.put(&sidecar_of(o), &serde_json::to_string_pretty(&side).unwrap())
                .await?;
        }
        let qc = join(&w, "meica_qc.json");
        let events = bids::run_events(bold)
            .filter(|e| c.h.exists(e))
            .unwrap_or_default();
        c.run(
            argv![
                "glm",
                "--meica-qc",
                mixing,
                metrics,
                conf,
                events,
                sidecar_of(&preproc[0]),
                qc
            ],
            std::slice::from_ref(&qc),
            None,
            None,
        )
        .await?;
        let mut status = json!({"status": "ran", "tree": tree, "dir": dir});
        status
            .as_object_mut()
            .unwrap()
            .extend(info.as_object().unwrap().clone());
        Ok(status)
    }
    .await;
    let status = match result {
        Ok(s) => s,
        Err(e) => {
            for f in &made {
                c.h.remove(f);
            }
            if mode == "on" {
                c.h.remove(&status_file);
                return Err(e);
            }
            // the failing tool's last line (its error), not the command line before it
            let reason: String = e
                .trim()
                .lines()
                .last()
                .unwrap_or("")
                .chars()
                .take(300)
                .collect();
            c.h.log(&format!(
                "  warning: ME-ICA failed for {}; preproc kept: {reason}",
                bold.name()
            ));
            json!({"status": "failed", "tree": tree, "reason": reason})
        }
    };
    c.put(&status_file, &status.to_string()).await.map(|_| ())
}
