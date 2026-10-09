//! The browser workflow over the FID-A port: load the dropped files, run
//! FID-A's automatic pipeline for the sequence, and hand LCModel its .RAW and
//! .H2O text. Kept free of the C ABI so it is tested natively.

use fida::io::detect::{self, Format, LoadOptions, NamedFile};
use fida::io::lcm;
use fida::ops::align::{op_align_averages, AlignTo};
use fida::ops::averaging::op_averaging;
use fida::ops::basic::op_complex_conj;
use fida::ops::editing::{classify_mega, drop_empty_transients, split_alternate, to_fida_layout, EditCheck};
use fida::ops::pipeline::{run_megapressproc_auto, run_pressproc_auto, run_specialproc_auto, MegaOptions, PressOptions, SpecialOptions};
use fida::ops::quality::{op_get_lw, op_get_snr};
use fida::Spectra;
use serde_json::{json, Value};

/// One metabolite acquisition with its water reference, as loaded.
pub struct Dataset {
    pub name: String,
    pub format: Format,
    pub water_name: Option<String>,
    pub metab: Spectra,
    pub water: Option<Spectra>,
    /// GE and Philips: whether alternate transients look like edit-ON/OFF pairs.
    pub edit: Option<EditCheck>,
}

/// Readers that store edit-ON and edit-OFF as alternate transients without
/// saying so; the app splits them (FID-A's `subspecs = 2`) when the data, or
/// the user, say the data are edited.
fn splits_editing(format: Format) -> bool {
    matches!(format, Format::GePfile | Format::PhilipsSdat)
}

/// Edit-ON/OFF classification of alternate transients, when there are pairs.
fn detect_editing(metab: &Spectra, water: Option<&Spectra>) -> Option<EditCheck> {
    if metab.dims.sub_specs != 0 || size_of(metab, metab.dims.averages) < 4 {
        return None;
    }
    classify_mega(&split_alternate(metab).ok()?, water).ok()
}

/// Sequence families that decide the pipeline and the basis set.
pub fn family(seq: &str) -> &'static str {
    let s = seq.to_ascii_lowercase();
    if s.contains("special") {
        "SPECIAL"
    } else if s.contains("slaser") || s.contains("semi") && s.contains("laser") {
        "sLASER"
    } else if s.contains("laser") {
        "LASER"
    } else if s.contains("steam") || s.contains("svs_st") {
        "STEAM"
    } else if s.contains("mega") || s.contains("edit") {
        "MEGA-PRESS"
    } else if s.contains("press") || s.contains("svs_se") || s.contains("probe") {
        "PRESS"
    } else {
        ""
    }
}

fn size_of(s: &Spectra, dim: usize) -> usize {
    if dim == 0 {
        1
    } else {
        s.size(dim)
    }
}

/// What the interface shows about a dataset and uses to pick a basis set.
pub fn header(s: &Spectra) -> Value {
    json!({
        "points": s.n(),
        "spectralWidthHz": s.spectralwidth,
        "dwellTime": s.dwelltime,
        "hzpppm": s.txfrq / 1e6,
        "fieldT": s.bo,
        "teMs": s.te,
        "trMs": s.tr,
        "sequence": s.seq,
        "family": family(&s.seq),
        "coils": size_of(s, s.dims.coils),
        "averages": size_of(s, s.dims.averages),
        "subspectra": size_of(s, s.dims.sub_specs),
    })
}

// FID-A preserves NIfTI-MRS seconds; the application and LCModel use milliseconds.
fn normalize_timing(s: &mut Spectra, format: Format) {
    if format == Format::NiftiMrs {
        s.te *= 1000.0;
        s.tr *= 1000.0;
    }
}

/// Detect and load every dataset among `files`. Returns the datasets and a
/// JSON summary (including per-file problems) for the interface.
pub fn load(files: &[(String, &[u8])]) -> (Vec<Dataset>, Value) {
    let named: Vec<NamedFile> = files.iter().map(|(n, b)| NamedFile { name: n.as_str(), bytes: b }).collect();
    let (det, loaded) = detect::load_all(&named, &LoadOptions::default());
    let mut datasets = Vec::new();
    let mut summary = Vec::new();
    let mut errors = Vec::new();
    for (pair, (metab, water)) in det.pairs.iter().zip(loaded) {
        let mut metab = match metab {
            Ok(m) => m,
            Err(e) => {
                errors.push(json!({ "file": pair.metabolite.name, "error": e }));
                continue;
            }
        };
        normalize_timing(&mut metab.out, pair.metabolite.format);
        let mut water_name = pair.water.as_ref().map(|w| w.name.clone());
        let water = match water {
            Some(Ok(mut w)) => {
                if let Some(source) = &pair.water {
                    normalize_timing(&mut w.out, source.format);
                }
                Some(w.out)
            }
            Some(Err(e)) => {
                errors.push(json!({ "file": water_name.clone().unwrap_or_default(), "error": e }));
                water_name = None;
                None
            }
            None => None,
        };
        // A water reference stored in the metabolite file (twix, GE frames, Bruker).
        let (water, water_name) = match (water, metab.embedded_water) {
            (Some(w), _) => (Some(w), water_name),
            (None, Some(w)) if w.n() > 0 => (Some(w), Some(format!("{} (water frames)", pair.metabolite.name))),
            _ => (None, None),
        };
        let format = pair.metabolite.format;
        let voxel = metab.voxel;
        let (metab, water) = if splits_editing(format) {
            (drop_empty_transients(&metab.out), water.as_ref().map(drop_empty_transients))
        } else {
            (metab.out, water)
        };
        let edit = if splits_editing(format) { detect_editing(&metab, water.as_ref()) } else { None };
        let mut h = header(&metab);
        // The water scan's timing, for relaxation-corrected water scaling.
        if let Some(w) = &water {
            h["waterTeMs"] = json!(w.te);
            h["waterTrMs"] = json!(w.tr);
        }
        // Where the voxel sits (RAS mm affine), when the format records it.
        if let Some(v) = &voxel {
            h["voxel"] = v.to_json();
        }
        // GE and Philips do not record editing; the interface shows what the
        // data say and lets the user override it (Options::edited).
        if let Some(e) = &edit {
            h["editing"] = json!({ "detected": e.edited(), "contrast": e.contrast, "offFirst": e.off_first });
        }
        // The primary files as named on input (with their folder, for a
        // directory drop), so the interface can tell subjects apart.
        let path_of = |d: &detect::Dataset| d.files.first().map(|&i| files[i].0.clone());
        summary.push(json!({
            "index": datasets.len(),
            "name": pair.metabolite.name,
            "path": path_of(&pair.metabolite),
            "waterPath": water_name.as_ref().and(pair.water.as_ref()).and_then(path_of),
            "format": format.label(),
            "water": water_name,
            "header": h,
        }));
        datasets.push(Dataset { name: pair.metabolite.name.clone(), format, water_name, metab, water, edit });
    }
    let ignored: Vec<Value> = det.ignored.iter().map(|(n, why)| json!({ "file": n, "reason": why })).collect();
    let unpaired: Vec<Value> = det.unpaired_water.iter().map(|d| json!(d.name)).collect();
    (datasets, json!({ "datasets": summary, "errors": errors, "ignored": ignored, "unpairedWater": unpaired }))
}

/// Preprocessing choices from the interface (FID-A defaults when absent).
#[derive(Clone, Debug)]
pub struct Options {
    pub remove_bad_averages: bool,
    pub bad_average_sd: Option<f64>,
    pub drift_correction: bool,
    pub phase_and_reference: bool,
    /// GE and Philips: treat alternate transients as edit-OFF/ON pairs
    /// (`Some(true)`), as unedited (`Some(false)`), or as detected (`None`).
    pub edited: Option<bool>,
}

impl Options {
    pub fn from_json(v: &Value) -> Options {
        Options {
            remove_bad_averages: v["removeBadAverages"].as_bool().unwrap_or(true),
            bad_average_sd: v["badAverageSd"].as_f64(),
            drift_correction: v["driftCorrection"].as_bool().unwrap_or(true),
            phase_and_reference: v["phaseAndReference"].as_bool().unwrap_or(true),
            edited: v["edited"].as_bool(),
        }
    }
}

pub struct Processed {
    /// The spectrum LCModel fits: the difference spectrum for MEGA-PRESS.
    pub metab: Spectra,
    pub water: Option<Spectra>,
    pub unprocessed: Spectra,
    pub report: Value,
    /// MEGA-PRESS only: FID-A's edit-OFF subspectrum.
    pub edit_off: Option<Spectra>,
}

/// Run FID-A's pipeline for the dataset's sequence.
pub fn process(ds: &Dataset, opts: &Options, progress: &mut dyn FnMut(&str, f32), cancelled: &dyn Fn() -> bool) -> Result<Processed, String> {
    // run_pressproc_GEauto conjugates GE data after reading (GE files are
    // small; other data are used in place, since twix data can be ~300 MB).
    let conj = ds.format == Format::GePfile;
    let conj_metab;
    let conj_water;
    let (metab, water): (&Spectra, Option<&Spectra>) = if conj {
        conj_metab = op_complex_conj(&ds.metab);
        conj_water = ds.water.as_ref().map(op_complex_conj);
        (&conj_metab, conj_water.as_ref())
    } else {
        (&ds.metab, ds.water.as_ref())
    };
    let fam = family(&ds.metab.seq);
    let split;
    let mut edit_warnings = Vec::new();
    let mut edit_check = Value::Null;
    let metab = if splits_editing(ds.format) && opts.edited.unwrap_or(ds.edit.as_ref().is_some_and(EditCheck::edited)) {
        let pairs = split_alternate(metab)?;
        let check = classify_mega(&pairs, water)?;
        if !check.edited() {
            edit_warnings.push(format!(
                "Edit-ON and edit-OFF look alike (NAA/Cr differs by {:.0} %): editing may have been averaged on the scanner, or the data are not edited.",
                (check.contrast - 1.0) * 100.0
            ));
        }
        edit_check = json!({ "contrast": check.contrast, "offFirst": check.off_first, "inverted": check.inverted });
        split = to_fida_layout(&pairs, &check);
        &split
    } else {
        metab
    };
    let has_coils = metab.dims.coils > 0 && metab.size(metab.dims.coils) > 1;
    let edited = fam == "MEGA-PRESS" || (metab.dims.sub_specs > 0 && fam != "SPECIAL");
    if !has_coils && !edited {
        return process_combined(metab, water, opts, progress);
    }
    if edited {
        if metab.dims.sub_specs == 0 || metab.size(metab.dims.sub_specs) != 2 {
            return Err("Edited MEGA-PRESS data need two subspectra (edit-ON and edit-OFF); these have none.".into());
        }
        let mut o = MegaOptions::default();
        o.rm_bad_averages.enabled = opts.remove_bad_averages;
        if let Some(sd) = opts.bad_average_sd {
            o.rm_bad_averages.nsd = sd;
        }
        o.drift.enabled = opts.drift_correction;
        o.autophase = opts.phase_and_reference;
        o.ppmref = opts.phase_and_reference;
        let out = run_megapressproc_auto(metab, water, &o, progress, cancelled)?;
        let mut report = out.report.to_json();
        report["conjugated"] = json!(conj);
        report["edited"] = json!(true);
        if !edit_check.is_null() {
            report["editClassification"] = edit_check;
            if let Some(w) = report["warnings"].as_array_mut() {
                w.extend(edit_warnings.into_iter().map(Value::from));
            }
        }
        return Ok(Processed { metab: out.diff, water: out.outw, unprocessed: out.diff_noproc, report, edit_off: Some(out.sub1) });
    }
    let out = if fam == "SPECIAL" {
        let mut o = SpecialOptions::default();
        o.rm_bad_averages.enabled = opts.remove_bad_averages;
        if let Some(sd) = opts.bad_average_sd {
            o.rm_bad_averages.nsd = sd;
        }
        o.drift.enabled = opts.drift_correction;
        apply_phase_ref_special(&mut o, opts.phase_and_reference);
        run_specialproc_auto(metab, water, &o, progress, cancelled)?
    } else {
        let mut o = PressOptions::default();
        o.rm_bad_averages.enabled = opts.remove_bad_averages;
        if let Some(sd) = opts.bad_average_sd {
            o.rm_bad_averages.nsd = sd;
        }
        o.drift.enabled = opts.drift_correction;
        o.autophase = opts.phase_and_reference;
        o.ppmref = opts.phase_and_reference;
        // FID-A's GE script phases on the residual water (run_pressproc_GEauto).
        o.ge_phasing = conj;
        run_pressproc_auto(metab, water, &o, progress, cancelled)?
    };
    let mut report = out.report.to_json();
    report["conjugated"] = json!(conj);
    Ok(Processed { metab: out.out, water: out.outw, unprocessed: out.out_noproc, report, edit_off: None })
}

fn apply_phase_ref_special(o: &mut SpecialOptions, on: bool) {
    o.autophase = on;
    o.ppmref = on;
}

/// Data that arrive coil-combined (RDA, DICOM, NIfTI-MRS, .RAW): align and
/// average transients if there are several; LCModel phases and references.
fn process_combined(metab: &Spectra, water: Option<&Spectra>, opts: &Options, progress: &mut dyn FnMut(&str, f32)) -> Result<Processed, String> {
    let mut warnings = Vec::new();
    let averages = size_of(&metab, metab.dims.averages);
    let unprocessed = op_averaging(metab);
    let mut drift = Value::Null;
    let aligned = if averages > 1 && opts.drift_correction {
        progress("Aligning averages", 0.3);
        let a = op_align_averages(metab, Some(0.25), AlignTo::Best)?;
        drift = json!({ "frequencyHz": a.fs, "phaseDeg": a.phs });
        a.out
    } else {
        metab.clone()
    };
    progress("Averaging", 0.8);
    let out = op_averaging(&aligned);
    let water = water.map(op_averaging);
    if averages <= 1 {
        warnings.push("The data are already coil-combined and averaged; they are fitted as they are.".to_string());
    } else {
        warnings.push("The data are already coil-combined; averages were aligned and averaged.".to_string());
    }
    let report = json!({
        "pipeline": "combined",
        "averagesRaw": averages,
        "drift": drift,
        "snr": op_get_snr(&out, 1.8, 2.2, -2.0, 0.0).ok().map(|s| s.snr),
        "linewidthHz": op_get_lw(&out, 1.8, 2.2, 8.0).ok(),
        "waterLinewidthHz": water.as_ref().and_then(|w| op_get_lw(w, 4.4, 5.0, 8.0).ok()),
        "warnings": warnings,
        "conjugated": false,
    });
    Ok(Processed { metab: out, water, unprocessed, report, edit_off: None })
}

/// The real part of a spectrum between `lo` and `hi` ppm, for plotting.
pub fn spectrum_trace(s: &Spectra, lo: f64, hi: f64) -> Value {
    let spec = fida::spectra::spec_of(s.fid(0));
    let mut ppm = Vec::new();
    let mut re = Vec::new();
    for (k, p) in s.ppm.iter().enumerate() {
        if *p >= lo && *p <= hi {
            ppm.push((*p * 1e4).round() / 1e4);
            re.push(spec[k].re);
        }
    }
    json!({ "ppm": ppm, "real": re })
}

/// LCModel inputs for a processed dataset: .RAW text, .H2O text and the
/// acquisition numbers the control file needs.
pub fn lcmodel_inputs(p: &Processed) -> Result<Value, String> {
    let (raw, mut warnings) = lcm::lcm_text_with_warnings(&p.metab, p.metab.te)?;
    let h2o = match &p.water {
        Some(w) => {
            let (t, w2) = lcm::lcm_text_with_warnings(w, w.te)?;
            warnings.extend(w2);
            if w.n() != p.metab.n() || (w.dwelltime - p.metab.dwelltime).abs() > 1e-12 {
                warnings.push("The water reference has a different length or dwell time; it is not used.".into());
                Value::Null
            } else {
                json!(t)
            }
        }
        None => Value::Null,
    };
    Ok(json!({
        "raw": raw,
        "h2o": h2o,
        "nunfil": p.metab.n(),
        "deltat": p.metab.dwelltime,
        "hzpppm": p.metab.txfrq / 1e6,
        "teMs": p.metab.te,
        "edited": p.edit_off.is_some(),
        "editOff": match &p.edit_off {
            Some(off) => json!(lcm::lcm_text(off, off.te)?),
            None => Value::Null,
        },
        "warnings": warnings,
    }))
}

#[cfg(test)]
mod test_data {
    //! Example data and basis sets for the tests below, fetched by
    //! exes/fida/validation/fetch_reference.py. Without them a test passes
    //! with a notice, unless FIDA_REQUIRE_REFERENCE is set (as in CI).

    pub fn skip(why: &str) {
        if std::env::var_os("FIDA_REQUIRE_REFERENCE").is_some() {
            panic!("{why}: FIDA_REQUIRE_REFERENCE is set (fetch the data with exes/fida/validation/fetch_reference.py)");
        }
        eprintln!("skipping: {why}");
    }

    fn read(path: String) -> Option<Vec<u8>> {
        let b = std::fs::read(&path).ok();
        if b.is_none() {
            skip(&format!("{path} not found"));
        }
        b
    }

    /// A file of FID-A's example data (`$FIDA_EXAMPLES`).
    pub fn example(rel: &str) -> Option<Vec<u8>> {
        let root = std::env::var("FIDA_EXAMPLES").unwrap_or_else(|_| "/home/ubuntu/src/mrs/FID-A/exampleData".into());
        read(format!("{root}/{rel}"))
    }

    /// An LCModel basis set (`$LCMODEL_BASIS_DIR`, default `$TMPDIR/basis-out`).
    pub fn basis(name: &str) -> Option<Vec<u8>> {
        let dir = std::env::var("LCMODEL_BASIS_DIR").unwrap_or_else(|_| format!("{}/basis-out", std::env::temp_dir().display()));
        read(format!("{dir}/{name}.basis"))
    }

    /// Osprey's Philips MEGA-PRESS example (`$PHILIPS_MEGA`).
    pub fn philips_mega(name: &str) -> Option<Vec<u8>> {
        let dir = std::env::var("PHILIPS_MEGA").unwrap_or_else(|_| format!("{}/mega-vendors/philips", std::env::temp_dir().display()));
        read(format!("{dir}/{name}"))
    }
}

#[cfg(test)]
mod tests {
    use super::test_data::*;
    use super::*;

    #[test]
    fn ge_press_example_runs_through_fida_and_lcmodel() {
        let Some(bytes) = example("GE/sample01_press/press/P17920.7") else { return };
        let files = vec![("P17920.7".to_string(), bytes.as_slice())];
        let (ds, summary) = load(&files);
        assert_eq!(ds.len(), 1, "{summary}");
        assert!(ds[0].water.is_some(), "GE water frames: {summary}");
        let p = process(&ds[0], &Options::from_json(&json!({"phaseAndReference": std::env::var("NOREF").is_err()})), &mut |_, _| {}, &|| false).unwrap();
        let inputs = lcmodel_inputs(&p).unwrap();
        assert!(inputs["h2o"].is_string());
        let Some(basis) = basis("press-3t-te35") else { return };
        let control = format!(
            " $LCMODL\n key=210387309\n lps=0\n nunfil={}\n deltat={:e}\n hzpppm={}\n filbas='b.basis'\n filraw='m.raw'\n filh2o='w.h2o'\n dows=T\n doecc=T\n lcoord=9\n filcoo='out.coord'\n ltable=7\n filtab='out.table'\n $END\n",
            inputs["nunfil"], inputs["deltat"].as_f64().unwrap(), inputs["hzpppm"]
        );
        let raw = inputs["raw"].as_str().unwrap().as_bytes().to_vec();
        let h2o = inputs["h2o"].as_str().unwrap().as_bytes().to_vec();
        let r = lcmodel::run_lcmodel(&control, &[("b.basis", &basis), ("m.raw", &raw), ("w.h2o", &h2o)], "");
        assert!(r.error.is_none(), "{:?}", r.error);
        let table = &r.outputs["out.table"];
        eprintln!("{table}");
        assert!(table.contains("NAA"));
    }
}

#[cfg(test)]
mod voxel_tests {
    use super::*;

    #[test]
    fn philips_header_carries_the_voxel() {
        // Osprey's MIT example (exampledata/sdat/UnEdited/sub-01), under $OSPREY_EXAMPLES.
        let Ok(root) = std::env::var("OSPREY_EXAMPLES") else {
            eprintln!("skipping: $OSPREY_EXAMPLES not set");
            return;
        };
        let dir = format!("{root}/sdat/UnEdited/sub-01/ses-01/mrs");
        let names = [
            "sub-01_ses-01_press/sub-01_PRESS_35_act.sdat",
            "sub-01_ses-01_press/sub-01_PRESS_35_act.spar",
            "sub-01_ses-01_press-ref/sub-01_PRESS_35_ref.sdat",
            "sub-01_ses-01_press-ref/sub-01_PRESS_35_ref.spar",
        ];
        let bytes: Vec<Vec<u8>> = names.iter().map(|n| std::fs::read(format!("{dir}/{n}")).unwrap()).collect();
        let files: Vec<(String, &[u8])> = names.iter().zip(&bytes).map(|(n, b)| (n.rsplit('/').next().unwrap().to_string(), b.as_slice())).collect();
        let (ds, summary) = load(&files);
        assert_eq!(ds.len(), 1, "{summary}");
        let v = &summary["datasets"][0]["header"]["voxel"];
        assert_eq!(v["sizeMm"], json!([30.0, 30.0, 30.0]), "{v}");
        assert!((v["centerMm"][1].as_f64().unwrap() + 45.03344727).abs() < 1e-6, "{v}");
        assert_eq!(v["space"], "RAS");
    }
}

#[cfg(test)]
mod mega_tests {
    use super::test_data::*;
    use super::*;

    /// FID-A's Siemens MEGA-PRESS sample, preprocessed, or None without it.
    fn siemens_mega() -> Option<Processed> {
        let bytes = example("Siemens/sample01_megapress/megapress/megapressDLPFC.dat")?;
        let (ds, summary) = load(&[("megapressDLPFC.dat".to_string(), bytes.as_slice())]);
        assert_eq!(ds.len(), 1, "{summary}");
        assert_eq!(family(&ds[0].metab.seq), "MEGA-PRESS");
        Some(process(&ds[0], &Options::from_json(&json!({})), &mut |_, _| {}, &|| false).unwrap())
    }

    #[test]
    fn siemens_mega_press_example_fits_gaba() {
        let Some(p) = siemens_mega() else { return };
        let inputs = lcmodel_inputs(&p).unwrap();
        assert_eq!(inputs["edited"], json!(true));
        assert!(inputs["editOff"].is_string());
        // The app's "none" macromolecule model: LCModel's mega-press-3 as is
        // (4.2-1.95 ppm), where GABA is GABA+: 0.153 (9 %) of NAA+NAAG.
        let Some(table) = fit_mega(&p, "") else { return };
        eprintln!("{table}");
        let (_, sd, ratio) = row(&table, "GABA");
        assert!(sd <= 10.0, "GABA %SD {sd}");
        assert!((ratio - 0.153).abs() < 0.002, "GABA+ {ratio}");
        assert!(!table.contains("MM3co"));
    }

    /// The co-edited macromolecule model the app adds to a MEGA-PRESS fit
    /// (packages/lcmodel/src/lcmodel-io.js, coEditedMacromolecules), with the
    /// app's fit range for edited data.
    fn co_edited_mm(hzpppm: f64) -> String {
        let ppm = |hz: f64| format!("{:.3}", hz / hzpppm);
        format!(
            " ppmend=0.5\n nsimul=2\n chsimu(1)='MM09 @ .915 +- .02 FWHM= .085 < .1 +- .35 AMP= 3.'\n chsimu(2)='MM3co @ 3.0 +- .02 FWHM= {} < {} +- .02 AMP= 2.'\n nratio=2\n chrato(2)='MM3co/MM09 = 1. +- .2'\n ncombi=18\n chcomb(18)='GABA+MM3co'\n ppmgap(1,1)=1.95\n ppmgap(2,1)=1.2\n",
            ppm(10.5),
            ppm(14.0)
        )
    }

    /// Fit a MEGA-PRESS difference spectrum with the library's difference
    /// basis; `extra` adds namelist lines to LCModel's mega-press-3 analysis.
    fn fit_mega(p: &Processed, extra: &str) -> Option<String> {
        let basis = basis("megapress-3t-te68-diff")?;
        let inputs = lcmodel_inputs(p).unwrap();
        let control = format!(
            " $LCMODL\n key=210387309\n lps=0\n sptype='mega-press-3'\n nunfil={}\n deltat={:e}\n hzpppm={}\n filbas='b.basis'\n filraw='d.raw'\n ltable=7\n filtab='out.table'\n{extra} $END\n",
            inputs["nunfil"], inputs["deltat"].as_f64().unwrap(), inputs["hzpppm"]
        );
        let raw = inputs["raw"].as_str().unwrap().as_bytes().to_vec();
        let r = lcmodel::run_lcmodel(&control, &[("b.basis", &basis), ("d.raw", &raw)], "");
        assert!(r.error.is_none(), "{:?}", r.error);
        Some(r.outputs["out.table"].clone())
    }

    /// GABA, MM3co and GABA+ = GABA + MM3co, each relative to NAA+NAAG with
    /// its %SD, under the co-edited MM model.
    fn gaba_mm3co(p: &Processed) -> Option<[(f64, f64); 3]> {
        let hzpppm = lcmodel_inputs(p).unwrap()["hzpppm"].as_f64().unwrap();
        let table = fit_mega(p, &co_edited_mm(hzpppm))?;
        eprintln!("{table}");
        let pick = |name| {
            let (_, sd, ratio) = row(&table, name);
            (ratio, sd)
        };
        Some([pick("GABA"), pick("MM3co"), pick("GABA+MM3co")])
    }

    #[test]
    fn co_edited_mm_separates_gaba_from_mm3co_on_siemens_data() {
        let Some(p) = siemens_mega() else { return };
        let Some([gaba, mm3co, plus]) = gaba_mm3co(&p) else { return };
        // GABA 0.075 (17 %), MM3co 0.216 (11 %), GABA+ 0.291 (7 %) of NAA+NAAG:
        // GABA is 26 % of GABA+, below the ~50 % usually assumed.
        assert!((plus.0 - 0.291).abs() < 0.01, "GABA+ {plus:?}");
        assert!((gaba.0 - 0.075).abs() < 0.01 && gaba.1 <= 20.0, "GABA {gaba:?}");
        assert!((mm3co.0 - 0.216).abs() < 0.01 && mm3co.1 <= 15.0, "MM3co {mm3co:?}");
        assert!(plus.1 < gaba.1, "GABA+ is better determined than its parts");
    }

    fn row(table: &str, name: &str) -> (f64, f64, f64) {
        let l = table.lines().find(|l| l.trim_end().ends_with(&format!(" {name}"))).unwrap_or_else(|| panic!("{name} row in\n{table}"));
        let f: Vec<&str> = l.split_whitespace().collect();
        (f[0].parse().unwrap(), f[1].trim_end_matches('%').parse().unwrap(), f[2].parse().unwrap())
    }

    #[test]
    fn philips_mega_press_is_detected_split_and_fits_gaba() {
        // Osprey's MIT example data (exampledata/sdat/MEGA/sub-01).
        let names = ["sub-01_megapress_act.sdat", "sub-01_megapress_act.spar", "sub-01_megapress_ref.sdat", "sub-01_megapress_ref.spar"];
        let Some(bytes) = names.iter().map(|n| philips_mega(n)).collect::<Option<Vec<_>>>() else { return };
        let files: Vec<(String, &[u8])> = names.iter().zip(&bytes).map(|(n, b)| (n.to_string(), b.as_slice())).collect();
        let (ds, summary) = load(&files);
        assert_eq!(ds.len(), 1, "{summary}");
        let h = &summary["datasets"][0]["header"];
        assert_eq!(h["editing"]["detected"], json!(true), "{h}");
        assert_eq!(h["editing"]["offFirst"], json!(true));
        assert!(h["editing"]["contrast"].as_f64().unwrap() > 2.0);
        // 8 water transients in a block of 320 rows; the empty rows are dropped.
        assert_eq!(size_of(ds[0].water.as_ref().unwrap(), ds[0].water.as_ref().unwrap().dims.averages), 8);
        let p = process(&ds[0], &Options::from_json(&json!({})), &mut |_, _| {}, &|| false).unwrap();
        assert_eq!(p.report["edited"], json!(true));
        assert_eq!(p.report["editClassification"]["inverted"], json!(true));
        let Some(table) = fit_mega(&p, "") else { return };
        eprintln!("{table}");
        // Without the co-edited MM model, GABA is GABA+: 0.241 (6 %), as before.
        let (_, sd, ratio) = row(&table, "GABA");
        assert!(sd <= 7.0, "GABA %SD {sd}");
        assert!((ratio - 0.241).abs() < 0.002, "GABA+ {ratio}");
        // With the co-edited MM model: GABA 0.102 (14 %), MM3co 0.191 (9 %),
        // GABA+ 0.293 (5 %) of NAA+NAAG; GABA is 35 % of GABA+.
        let Some([gaba, mm3co, plus]) = gaba_mm3co(&p) else { return };
        assert!((plus.0 - 0.293).abs() < 0.01 && plus.1 <= 8.0, "GABA+ {plus:?}");
        assert!((gaba.0 - 0.102).abs() < 0.01 && gaba.1 <= 15.0, "GABA {gaba:?}");
        assert!((mm3co.0 - 0.191).abs() < 0.01 && mm3co.1 <= 15.0, "MM3co {mm3co:?}");
        let fraction = gaba.0 / plus.0;
        assert!(fraction > 0.3 && fraction < 0.6, "GABA/GABA+ {fraction}");
        // Forcing "not edited" fits the alternate transients as one PRESS-like average.
        let p = process(&ds[0], &Options::from_json(&json!({"edited": false})), &mut |_, _| {}, &|| false).unwrap();
        assert!(p.edit_off.is_none());
    }

    #[test]
    fn ge_mega_sample_with_averaged_transients_is_not_called_edited() {
        // FID-A's GE MEGA-PRESS sample stores 8-transient sums whose edit
        // states cancel: alternate frames agree to 0.4 % (FID-A in Octave too).
        let Some(bytes) = example("GE/sample02_megapress/megapress/P21504.7") else { return };
        let (ds, summary) = load(&[("P21504.7".to_string(), bytes.as_slice())]);
        assert_eq!(ds.len(), 1, "{summary}");
        let e = ds[0].edit.as_ref().expect("GE frames are classified");
        assert!(!e.edited() && e.contrast < 1.2, "{e:?}");
        let p = process(&ds[0], &Options::from_json(&json!({"edited": true})), &mut |_, _| {}, &|| false).unwrap();
        assert!(p.report["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("look alike")));
    }
}
