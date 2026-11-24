//! Deterministic versions of FID-A's automatic single-voxel pipelines,
//! `run_pressproc_auto` (PRESS, STEAM, sLASER: non-edited data) and
//! `run_specialproc_auto` (SPECIAL), starting from loaded structures.
//!
//! The processing is FID-A's, step for step (see `validation/pressproc_det.m`
//! and `validation/specialproc_det.m`, the same pipelines run by FID-A
//! itself). Deviations from the FID-A scripts:
//!
//! * **No random draws.** run_pressproc_auto draws, on every drift-correction
//!   iteration, `tmax = 0.25+0.03*randn`, `ppmmin = 1.6+0.1*randn` and
//!   `ppmmax` from `{3.5, 3.5, 4, 4, 4, 5.5} + 0.1*randn`; run_specialproc_auto
//!   draws `tmax = tmaxin+0.04*randn` (tmaxin = 0.2), `fmin = 1.8+0.1*randn`
//!   and `fmax` from `{2.4, 2.85, 3.35, 4.2, 4.4, 5.2}`. These use the fixed
//!   centre values `tmax = 0.25`, `ppmmin = 1.6`, `ppmmax = 4.0` (PRESS) and
//!   `tmax = 0.2`, `ppmmin = 1.8`, `ppmmax = 4.2` (SPECIAL) on every
//!   iteration, and iterate as FID-A does: until the linear trend of the
//!   frequency (< 0.001 Hz/average) and phase (< 0.01 deg/average) corrections
//!   vanishes, at most `max_iterations - 1` times. With fixed parameters the
//!   iterations re-register already aligned data, which converges quickly.
//! * **No interaction, figures or files.** FID-A's report is HTML with
//!   figures; this returns a `Report` (JSON via `Report::to_json`). Nothing is
//!   written to disk (FID-A writes LCModel files; use `io::lcm`).
//! * **Readers are not part of the pipeline.** run_pressproc_GEauto
//!   conjugates GE data (op_complexConj) after reading; do that before
//!   calling. The PRESS pipeline is run_pressproc_auto's, whatever the vendor.
//! * **SPECIAL without water.** FID-A then takes coil phases with
//!   op_getcoilcombos_specReg, which is not ported; this uses op_getcoilcombos
//!   on the ISIS-combined average instead and says so in `Report::warnings`.
//! * **Switchable steps.** Every step can be turned off (`*Options`); the
//!   defaults are the scripts'. Coil combination is not optional (every later
//!   step needs combined data) but its mode and point are.
//! * Quality measures, which the scripts do not compute, are added: op_getSNR
//!   (NAA 1.8-2.2 ppm, noise -2-0 ppm) and op_getLW of NAA (1.8-2.2 ppm) and
//!   of water (4.4-5.0 ppm).

use serde_json::{json, Value};

use super::align::{op_align_averages, op_align_averages_fd, op_align_isis, op_align_mp_subspecs, op_align_mp_subspecs_fd, AlignTo};
use super::averaging::{op_averaging, op_rmbadaverages, Domain};
use super::basic::{op_addphase, op_autophase, op_filter, op_freqshift, op_leftshift, op_ppmref, op_zeropad};
use super::coils::{op_addrcvrs, op_getcoilcombos, CoilCombos, CoilMode};
use super::quality::{op_get_lw, op_get_snr};
use super::subspecs::{op_combinesubspecs, op_takesubspec, CombineMode};
use super::util::{find_max, phase1, polyfit, spec};
use crate::spectra::Spectra;

/// The error a pipeline returns when `cancelled` reported true.
pub const CANCELLED: &str = "Cancelled";

/// Which spectral-registration function the drift correction uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriftDomain {
    /// op_alignAverages over the whole spectrum (`aaDomain = 't'`).
    Time,
    /// op_alignAverages_fd over `ppmmin..ppmmax` (`aaDomain = 'f'`, the default).
    Freq,
}

/// Coil combination settings.
#[derive(Clone, Copy, Debug)]
pub struct CoilOptions {
    /// `'w'` (default) or `'h'`.
    pub mode: CoilMode,
    /// 1-based FID point the phases are read at (PRESS 1, SPECIAL 2).
    pub point: usize,
}

/// Removal of bad averages.
#[derive(Clone, Copy, Debug)]
pub struct RmBadOptions {
    pub enabled: bool,
    /// Standard deviations above the trend (PRESS 4, SPECIAL 3).
    pub nsd: f64,
    pub domain: Domain,
}

/// Frequency and phase drift correction.
#[derive(Clone, Copy, Debug)]
pub struct DriftOptions {
    pub enabled: bool,
    pub domain: DriftDomain,
    /// Seconds of FID used.
    pub tmax: f64,
    pub ppmmin: f64,
    pub ppmmax: f64,
    /// FID-A's `iterin` (20): at most `max_iterations - 1` passes.
    pub max_iterations: usize,
}

/// Options of `run_pressproc_auto`.
#[derive(Clone, Copy, Debug)]
pub struct PressOptions {
    pub coils: CoilOptions,
    pub rm_bad_averages: RmBadOptions,
    pub drift: DriftOptions,
    /// tmax of the water reference's alignment to its best average (0.2 s).
    pub water_tmax: f64,
    pub leftshift: bool,
    /// Zero-order phase on creatine (2.9-3.1 ppm) and water (4-5.5 ppm).
    pub autophase: bool,
    /// Creatine to 3.027 ppm, water to 4.65 ppm.
    pub ppmref: bool,
    /// run_pressproc_GEauto's phasing: zero-order phase from the residual
    /// water (4-5.5 ppm) of the unfiltered, zero-filled spectrum, applied to
    /// the water reference too, and creatine referenced on that spectrum.
    pub ge_phasing: bool,
}

impl Default for PressOptions {
    fn default() -> Self {
        PressOptions {
            coils: CoilOptions { mode: CoilMode::W, point: 1 },
            rm_bad_averages: RmBadOptions { enabled: true, nsd: 4.0, domain: Domain::Time },
            drift: DriftOptions { enabled: true, domain: DriftDomain::Freq, tmax: 0.25, ppmmin: 1.6, ppmmax: 4.0, max_iterations: 20 },
            water_tmax: 0.2,
            leftshift: true,
            autophase: true,
            ppmref: true,
            ge_phasing: false,
        }
    }
}

/// Options of `run_specialproc_auto`.
#[derive(Clone, Copy, Debug)]
pub struct SpecialOptions {
    pub coils: CoilOptions,
    /// Align averages and the two ISIS subspectra (twice each) before combining.
    pub align_isis: bool,
    /// tmax of those alignments (0.4 s).
    pub isis_tmax: f64,
    pub rm_bad_averages: RmBadOptions,
    pub drift: DriftOptions,
    /// The water reference is aligned with `water_tmax_factor * tmax` (5).
    pub water_tmax_factor: f64,
    pub leftshift: bool,
    /// Zero-order phase on creatine (2.85-3.15 ppm) and water (4-5.5 ppm).
    pub autophase: bool,
    pub ppmref: bool,
}

impl Default for SpecialOptions {
    fn default() -> Self {
        SpecialOptions {
            coils: CoilOptions { mode: CoilMode::W, point: 2 },
            align_isis: true,
            isis_tmax: 0.4,
            rm_bad_averages: RmBadOptions { enabled: true, nsd: 3.0, domain: Domain::Time },
            drift: DriftOptions { enabled: true, domain: DriftDomain::Freq, tmax: 0.2, ppmmin: 1.8, ppmmax: 4.2, max_iterations: 20 },
            water_tmax_factor: 5.0,
            leftshift: true,
            autophase: true,
            ppmref: true,
        }
    }
}

/// Coil combination result.
#[derive(Clone, Debug, Default)]
pub struct CoilReport {
    /// Coil phases (degrees).
    pub phase: Vec<f64>,
    /// Coil weights as applied (unit norm).
    pub weight: Vec<f64>,
    /// Whether the phases came from the water reference.
    pub from_water: bool,
}

/// One pass of op_rmbadaverages.
#[derive(Clone, Debug, Default)]
pub struct RmBadPass {
    /// Deviation metric per remaining average.
    pub metric: Vec<f64>,
    /// Averages removed in this pass (0-based indices into this pass's input).
    pub removed: Vec<usize>,
}

/// Removal of bad averages.
#[derive(Clone, Debug, Default)]
pub struct RmBadReport {
    pub nsd: f64,
    pub passes: Vec<RmBadPass>,
    /// Removed averages as 0-based indices of the averages entering the step.
    pub removed: Vec<usize>,
    pub averages_before: usize,
    pub averages_after: usize,
}

/// Drift correction.
#[derive(Clone, Debug, Default)]
pub struct DriftReport {
    pub iterations: usize,
    /// Cumulative frequency correction per remaining average (Hz).
    pub freq: Vec<f64>,
    /// Cumulative phase correction per remaining average (degrees).
    pub phase: Vec<f64>,
    /// max - min of `freq` and `phase`.
    pub total_freq_drift: f64,
    pub total_phase_drift: f64,
}

/// What a pipeline did.
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub pipeline: String,
    pub averages_raw: usize,
    pub coils: CoilReport,
    /// SPECIAL: per-average frequency/phase from the ISIS alignment (mean of
    /// both subspectra, before removal of bad averages).
    pub isis_freq: Vec<f64>,
    pub isis_phase: Vec<f64>,
    pub rm_bad_averages: Option<RmBadReport>,
    pub drift: Option<DriftReport>,
    /// Zero-order phase added (degrees).
    pub ph0: f64,
    pub ph0_water: Option<f64>,
    /// Frequency shift applied by referencing (Hz).
    pub freq_shift: f64,
    pub freq_shift_water: Option<f64>,
    pub snr: Option<f64>,
    /// NAA linewidth (Hz).
    pub linewidth_naa: Option<f64>,
    /// Water linewidth (Hz).
    pub linewidth_water: Option<f64>,
    pub warnings: Vec<String>,
}

fn nan_to_null(v: f64) -> Value {
    if v.is_finite() {
        json!(v)
    } else {
        Value::Null
    }
}

fn vec_json(v: &[f64]) -> Value {
    Value::Array(v.iter().map(|&x| nan_to_null(x)).collect())
}

impl Report {
    /// The report as JSON (non-finite numbers become null).
    pub fn to_json(&self) -> Value {
        let opt = |v: Option<f64>| v.map(nan_to_null).unwrap_or(Value::Null);
        json!({
            "pipeline": self.pipeline,
            "averages_raw": self.averages_raw,
            "coils": {"phase": vec_json(&self.coils.phase), "weight": vec_json(&self.coils.weight), "from_water": self.coils.from_water},
            "isis": {"freq": vec_json(&self.isis_freq), "phase": vec_json(&self.isis_phase)},
            "rm_bad_averages": self.rm_bad_averages.as_ref().map(|r| json!({
                "nsd": r.nsd,
                "passes": r.passes.iter().map(|p| json!({"metric": vec_json(&p.metric), "removed": p.removed})).collect::<Vec<_>>(),
                "removed": r.removed,
                "averages_before": r.averages_before,
                "averages_after": r.averages_after,
            })),
            "drift": self.drift.as_ref().map(|d| json!({
                "iterations": d.iterations,
                "freq": vec_json(&d.freq),
                "phase": vec_json(&d.phase),
                "total_freq_drift": nan_to_null(d.total_freq_drift),
                "total_phase_drift": nan_to_null(d.total_phase_drift),
            })),
            "ph0": nan_to_null(self.ph0),
            "ph0_water": opt(self.ph0_water),
            "freq_shift": nan_to_null(self.freq_shift),
            "freq_shift_water": opt(self.freq_shift_water),
            "snr": opt(self.snr),
            "linewidth_naa": opt(self.linewidth_naa),
            "linewidth_water": opt(self.linewidth_water),
            "warnings": self.warnings,
        })
    }
}

/// Output of a pipeline.
#[derive(Clone, Debug)]
pub struct PipelineOutput {
    /// Processed water-suppressed spectrum.
    pub out: Spectra,
    /// Processed water reference.
    pub outw: Option<Spectra>,
    /// Coil-combined, averaged, phased and referenced, without removal of
    /// bad averages or drift correction.
    pub out_noproc: Spectra,
    pub outw_noproc: Option<Spectra>,
    pub report: Report,
}

struct Hooks<'a> {
    progress: &'a mut dyn FnMut(&str, f32),
    cancelled: &'a dyn Fn() -> bool,
}

impl Hooks<'_> {
    fn step(&mut self, msg: &str, frac: f32) -> Result<(), String> {
        if (self.cancelled)() {
            return Err(CANCELLED.into());
        }
        (self.progress)(msg, frac);
        Ok(())
    }
}

fn span(v: &[f64]) -> f64 {
    let mx = v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mn = v.iter().copied().fold(f64::INFINITY, f64::min);
    mx - mn
}

fn coil_report(cc: &CoilCombos, from_water: bool) -> CoilReport {
    CoilReport { phase: cc.ph.clone(), weight: cc.sig.iter().map(|z| z.re).collect(), from_water }
}

fn slope(v: &[f64]) -> f64 {
    let x: Vec<f64> = (1..=v.len()).map(|k| k as f64).collect();
    if v.len() < 2 {
        return 0.0;
    }
    polyfit(&x, v, 1)[0]
}

fn rm_bad_loop(input: &Spectra, o: &RmBadOptions, hooks: &mut Hooks, frac: f32, warnings: &mut Vec<String>) -> Result<(Spectra, RmBadReport), String> {
    let before = if input.dims.averages > 0 { input.size(input.dims.averages) } else { 1 };
    let mut rep = RmBadReport { nsd: o.nsd, averages_before: before, averages_after: before, ..Default::default() };
    let mut cur = input.clone();
    if before < 3 {
        warnings.push(format!("Skipped bad-average removal: at least 3 averages are needed (got {before})."));
        return Ok((cur, rep));
    }
    let mut left: Vec<usize> = (0..before).collect();
    loop {
        hooks.step("Removing bad averages", frac)?;
        let r = op_rmbadaverages(&cur, o.nsd, o.domain)?;
        let nbad = r.bad.len();
        for &b in &r.bad {
            rep.removed.push(left[b]);
        }
        let keep: Vec<usize> = (0..left.len()).filter(|k| !r.bad.contains(k)).collect();
        left = keep.iter().map(|&k| left[k]).collect();
        rep.passes.push(RmBadPass { metric: r.metric[..r.metric.len() / r.n_subspecs.max(1)].to_vec(), removed: r.bad.clone() });
        cur = r.out;
        if nbad == 0 {
            break;
        }
        if left.len() < 3 {
            rep.averages_after = left.len();
            return Err("Removing bad averages left fewer than three averages.".into());
        }
    }
    rep.averages_after = left.len();
    Ok((cur, rep))
}

/// `-phase(specs(index))*180/pi` at the largest magnitude between `lo` and
/// `hi` ppm of an already zero-filled spectrum (run_specialproc_auto).
fn peak_phase(s: &Spectra, lo: f64, hi: f64) -> Result<f64, String> {
    let sp = spec(&s.fids[..s.n()]);
    let idx: Vec<usize> = (0..sp.len()).filter(|&i| s.ppm[i] > lo && s.ppm[i] < hi).collect();
    if idx.is_empty() {
        return Err(format!("No spectral points between {lo} and {hi} ppm."));
    }
    let mags: Vec<f64> = idx.iter().map(|&i| sp[i].norm()).collect();
    let k = idx[find_max(&mags)[0]];
    Ok(-phase1(sp[k]) * 180.0 / std::f64::consts::PI)
}

fn leftshift_by_own(s: &Spectra) -> Result<Spectra, String> {
    op_leftshift(s, s.points_to_leftshift.max(0.0).round() as usize)
}

fn quality(report: &mut Report, out: &Spectra, outw: Option<&Spectra>) {
    match op_get_snr(out, 1.8, 2.2, -2.0, 0.0) {
        Ok(s) => report.snr = Some(s.snr),
        Err(e) => report.warnings.push(format!("SNR: {e}")),
    }
    match op_get_lw(out, 1.8, 2.2, 8.0) {
        Ok(v) => report.linewidth_naa = Some(v),
        Err(e) => report.warnings.push(format!("NAA linewidth: {e}")),
    }
    if let Some(w) = outw {
        match op_get_lw(w, 4.4, 5.0, 8.0) {
            Ok(v) => report.linewidth_water = Some(v),
            Err(e) => report.warnings.push(format!("Water linewidth: {e}")),
        }
    }
}

/// FID-A `run_pressproc_auto` on loaded data: coil combination (phases from
/// the water reference when given), removal of bad averages, drift
/// correction, averaging, left shift, zero-order phasing on creatine and
/// referencing to creatine at 3.027 ppm (water: 4.65 ppm).
pub fn run_pressproc_auto(raw: &Spectra, raww: Option<&Spectra>, opts: &PressOptions, progress: &mut dyn FnMut(&str, f32), cancelled: &dyn Fn() -> bool) -> Result<PipelineOutput, String> {
    let mut hooks = Hooks { progress, cancelled };
    let mut report = Report { pipeline: if opts.ge_phasing { "run_pressproc_GEauto" } else { "run_pressproc_auto" }.into(), ..Default::default() };
    if raw.dims.sub_specs > 0 {
        return Err("These data have subspectra; the PRESS pipeline is for non-edited data (use the SPECIAL pipeline for SPECIAL).".into());
    }
    report.averages_raw = if raw.dims.averages > 0 { raw.size(raw.dims.averages) } else { 1 };
    hooks.step("Combining receiver channels", 0.0)?;
    let co = &opts.coils;
    let (cc, outw_cc) = match raww {
        Some(w) => {
            let cc = op_getcoilcombos(w, co.point, co.mode)?;
            let r = op_addrcvrs(w, co.point, co.mode, Some(&cc), false)?;
            (cc, Some(r.out))
        }
        None => (op_getcoilcombos(&op_averaging(raw), co.point, co.mode)?, None),
    };
    let r = op_addrcvrs(raw, co.point, co.mode, Some(&cc), false)?;
    report.coils = coil_report(&r.coilcombos, raww.is_some());
    let out_cc = r.out;
    let mut out_noproc = op_averaging(&out_cc);
    let mut outw_noproc = outw_cc.as_ref().map(op_averaging);

    let out_rm = if opts.rm_bad_averages.enabled && out_cc.dims.averages > 0 {
        let (o, rep) = rm_bad_loop(&out_cc, &opts.rm_bad_averages, &mut hooks, 0.2, &mut report.warnings)?;
        report.rm_bad_averages = Some(rep);
        o
    } else {
        out_cc.clone()
    };
    drop(out_cc);

    let d = &opts.drift;
    let outw_av = if let Some(w) = outw_cc.as_ref() {
        if d.enabled && w.dims.averages > 0 && w.size(w.dims.averages) > 1 {
            hooks.step("Aligning the water reference", 0.3)?;
            let outw_aa = op_align_averages(w, Some(opts.water_tmax), AlignTo::Best)?.out;
            Some(op_averaging(&outw_aa))
        } else {
            Some(op_averaging(w))
        }
    } else {
        None
    };
    let out_av = if d.enabled && out_rm.dims.averages > 0 && out_rm.size(out_rm.dims.averages) > 1 {
        let na = out_rm.size(out_rm.dims.averages);
        let mut fscum = vec![0.0; na];
        let mut phscum = vec![0.0; na];
        let mut cur = out_rm;
        let (mut fs_poly, mut phs_poly) = (100.0f64, 1000.0f64);
        let mut iter = 1;
        let mut passes = 0;
        while (fs_poly.abs() > 0.001 || phs_poly.abs() > 0.01) && iter < d.max_iterations {
            iter += 1;
            passes += 1;
            hooks.step(&format!("Correcting frequency drift (pass {passes})"), 0.3 + 0.5 * passes as f32 / d.max_iterations as f32)?;
            let a = match d.domain {
                DriftDomain::Time => op_align_averages(&cur, Some(d.tmax), AlignTo::Median)?,
                DriftDomain::Freq => op_align_averages_fd(&cur, d.ppmmin, d.ppmmax, d.tmax, AlignTo::Median)?,
            };
            fs_poly = slope(&a.fs[..na]);
            phs_poly = slope(&a.phs[..na]);
            for k in 0..na {
                fscum[k] += a.fs[k];
                phscum[k] += a.phs[k];
            }
            cur = a.out;
        }
        if fs_poly.abs() > 0.001 || phs_poly.abs() > 0.01 {
            report.warnings.push(format!("Drift correction stopped after {passes} passes with a residual trend of {fs_poly:.4} Hz and {phs_poly:.4} deg per average."));
        }
        report.drift = Some(DriftReport { iterations: passes, total_freq_drift: span(&fscum), total_phase_drift: span(&phscum), freq: fscum, phase: phscum });
        op_averaging(&cur)
    } else {
        op_averaging(&out_rm)
    };
    drop(outw_cc);

    hooks.step("Left shift, phasing and referencing", 0.85)?;
    let (out_ls, outw_ls) = if opts.leftshift {
        (leftshift_by_own(&out_av)?, outw_av.as_ref().map(leftshift_by_own).transpose()?)
    } else {
        (out_av, outw_av)
    };
    // run_pressproc_auto filters (5 Hz) and phases on creatine; the water
    // reference gets its own phase. run_pressproc_GEauto phases on the
    // residual water without filtering and gives the water reference the
    // same phase.
    let ge = opts.ge_phasing;
    let out_zf = if ge { op_zeropad(&out_ls, 16.0) } else { op_filter(&op_zeropad(&out_ls, 16.0), 5.0) };
    let (lo, hi) = if ge { (4.0, 5.5) } else { (2.9, 3.1) };
    let (out_zf_ph, ph0) = if opts.autophase { op_autophase(&out_zf, lo, hi, 0.0, None)? } else { (out_zf, 0.0) };
    report.ph0 = ph0;
    let out_ls_ph = op_addphase(&out_ls, ph0, 0.0, 4.65);
    let mut w_zf_ph = None;
    let mut outw_ls_ph = None;
    if let Some(w) = outw_ls.as_ref() {
        let (zf_ph, ph0w) = if ge {
            (op_addphase(&op_zeropad(w, 16.0), ph0, 0.0, 4.65), ph0)
        } else {
            let zf = op_filter(&op_zeropad(w, 16.0), 5.0);
            if opts.autophase { op_autophase(&zf, 4.0, 5.5, 0.0, None)? } else { (zf, 0.0) }
        };
        report.ph0_water = Some(ph0w);
        outw_ls_ph = Some(op_addphase(w, ph0w, 0.0, 4.65));
        w_zf_ph = Some(zf_ph);
    }
    out_noproc = op_addphase(&if opts.leftshift { leftshift_by_own(&out_noproc)? } else { out_noproc }, ph0, 0.0, 4.65);
    if let Some(w) = outw_noproc.take() {
        let ls = if opts.leftshift { leftshift_by_own(&w)? } else { w };
        outw_noproc = Some(op_addphase(&ls, report.ph0_water.unwrap_or(0.0), 0.0, 4.65));
    }
    let frq = if opts.ppmref { op_ppmref(&out_zf_ph, 2.9, 3.1, 3.027, None)?.1 } else { 0.0 };
    report.freq_shift = frq;
    let out = op_freqshift(&out_ls_ph, frq);
    let out_noproc = op_freqshift(&out_noproc, frq);
    let (outw, outw_noproc) = match (outw_ls_ph, w_zf_ph) {
        (Some(w), Some(zf)) => {
            let f = if opts.ppmref { op_ppmref(&zf, 4.0, 5.5, 4.65, None)?.1 } else { 0.0 };
            report.freq_shift_water = Some(f);
            (Some(op_freqshift(&w, f)), outw_noproc.map(|n| op_freqshift(&n, f)))
        }
        _ => (None, None),
    };
    hooks.step("Measuring SNR and linewidth", 0.95)?;
    quality(&mut report, &out, outw.as_ref());
    hooks.step("Done", 1.0)?;
    Ok(PipelineOutput { out, outw, out_noproc, outw_noproc, report })
}

/// Four alternating alignments (averages, ISIS, averages, ISIS), as
/// run_specialproc_auto. Returns the aligned data and, per average, the
/// accumulated frequency and phase (N x 2, column-major).
fn align_special(input: &Spectra, tmax: f64, hooks: &mut Hooks, frac: f32) -> Result<(Spectra, Vec<f64>, Vec<f64>), String> {
    let mut fs: Vec<f64>;
    let mut phs: Vec<f64>;
    hooks.step("Aligning averages", frac)?;
    let a = op_align_averages(input, Some(tmax), AlignTo::Median)?;
    let na = a.n_averages;
    fs = a.fs;
    phs = a.phs;
    fs.resize(na * 2, 0.0);
    phs.resize(na * 2, 0.0);
    let mut cur = a.out;
    for pass in 0..3 {
        hooks.step(if pass % 2 == 0 { "Aligning ISIS subspectra" } else { "Aligning averages" }, frac)?;
        if pass % 2 == 0 {
            let r = op_align_isis(&cur, tmax, None)?;
            for k in 0..na {
                fs[na + k] += r.fs[k];
                phs[na + k] += r.phs[k];
            }
            cur = r.out;
        } else {
            let r = op_align_averages(&cur, Some(tmax), AlignTo::Median)?;
            for k in 0..na * 2 {
                fs[k] += r.fs[k];
                phs[k] += r.phs[k];
            }
            cur = r.out;
        }
    }
    Ok((cur, fs, phs))
}

/// FID-A `run_specialproc_auto` on loaded data: coil combination (phases
/// from the ISIS-combined water reference at point 2), alignment of averages
/// and ISIS subspectra, ISIS combination, removal of bad averages, drift
/// correction, averaging, left shift, phasing on creatine and referencing.
pub fn run_specialproc_auto(raw: &Spectra, raww: Option<&Spectra>, opts: &SpecialOptions, progress: &mut dyn FnMut(&str, f32), cancelled: &dyn Fn() -> bool) -> Result<PipelineOutput, String> {
    let mut hooks = Hooks { progress, cancelled };
    let mut report = Report { pipeline: "run_specialproc_auto".into(), ..Default::default() };
    if raw.dims.sub_specs == 0 || raw.size(raw.dims.sub_specs) != 2 {
        return Err("SPECIAL data need two subspectra.".into());
    }
    report.averages_raw = if raw.dims.averages > 0 { raw.size(raw.dims.averages) } else { 1 };
    hooks.step("Combining receiver channels", 0.0)?;
    let co = &opts.coils;
    let cc = match raww {
        Some(w) => op_getcoilcombos(&op_combinesubspecs(w, CombineMode::Diff)?, co.point, co.mode)?,
        None => {
            report.warnings.push("No water reference: coil phases were taken from the averaged metabolite data (FID-A would use op_getcoilcombos_specReg).".into());
            op_getcoilcombos(&op_combinesubspecs(&op_averaging(raw), CombineMode::Diff)?, co.point, co.mode)?
        }
    };
    let r = op_addrcvrs(raw, co.point, co.mode, Some(&cc), false)?;
    report.coils = coil_report(&r.coilcombos, raww.is_some());
    let out_cc = r.out;
    let out_w_cc = match raww {
        Some(w) => Some(op_addrcvrs(w, co.point, co.mode, Some(&cc), false)?.out),
        None => None,
    };
    let mut out_noproc = op_combinesubspecs(&op_averaging(&out_cc), CombineMode::Diff)?;
    let mut out_w_noproc = out_w_cc.as_ref().map(|w| op_combinesubspecs(&op_averaging(w), CombineMode::Diff)).transpose()?;

    let na = if out_cc.dims.averages > 0 { out_cc.size(out_cc.dims.averages) } else { 1 };
    let (out_ai, mut fs_ai, mut phs_ai) = if opts.align_isis && out_cc.dims.averages > 0 && na > 1 {
        let (ai, fs, phs) = align_special(&out_cc, opts.isis_tmax, &mut hooks, 0.1)?;
        let fs_m: Vec<f64> = (0..na).map(|k| (fs[k] + fs[na + k]) / 2.0).collect();
        let phs_m: Vec<f64> = (0..na).map(|k| (phs[k] + phs[na + k]) / 2.0).collect();
        (ai, fs_m, phs_m)
    } else {
        (out_cc, vec![0.0; na], vec![0.0; na])
    };
    let out_w_ai = match out_w_cc {
        Some(w) if opts.align_isis && w.dims.averages > 0 && w.size(w.dims.averages) > 1 => {
            Some(align_special(&w, opts.isis_tmax, &mut hooks, 0.25)?.0)
        }
        other => other,
    };
    report.isis_freq = fs_ai.clone();
    report.isis_phase = phs_ai.clone();
    let out_cs = op_combinesubspecs(&out_ai, CombineMode::Diff)?;
    drop(out_ai);
    let mut out_w_cs = out_w_ai.as_ref().map(|w| op_combinesubspecs(w, CombineMode::Diff)).transpose()?;
    drop(out_w_ai);

    let out_rm = if opts.rm_bad_averages.enabled && out_cs.dims.averages > 0 {
        let (o, rep) = rm_bad_loop(&out_cs, &opts.rm_bad_averages, &mut hooks, 0.4, &mut report.warnings)?;
        let keep: Vec<usize> = (0..fs_ai.len()).filter(|k| !rep.removed.contains(k)).collect();
        fs_ai = keep.iter().map(|&k| fs_ai[k]).collect();
        phs_ai = keep.iter().map(|&k| phs_ai[k]).collect();
        report.rm_bad_averages = Some(rep);
        o
    } else {
        out_cs
    };

    let d = &opts.drift;
    let out_aa = if d.enabled && out_rm.dims.averages > 0 && out_rm.size(out_rm.dims.averages) > 1 {
        let nr = out_rm.size(out_rm.dims.averages);
        let mut fs_cum = fs_ai.clone();
        let mut phs_cum = phs_ai.clone();
        let mut cur = out_rm;
        let (mut fs_poly, mut phs_poly) = (100.0f64, 1000.0f64);
        let mut iter = 1;
        while (fs_poly.abs() > 0.001 || phs_poly.abs() > 0.01) && iter < d.max_iterations {
            hooks.step(&format!("Correcting frequency drift (pass {iter})"), 0.45 + 0.4 * iter as f32 / d.max_iterations as f32)?;
            let a = match d.domain {
                DriftDomain::Time => op_align_averages(&cur, Some(d.tmax), AlignTo::Best)?,
                DriftDomain::Freq => op_align_averages_fd(&cur, d.ppmmin, d.ppmmax, d.tmax, AlignTo::Best)?,
            };
            if let Some(w) = out_w_cs.as_ref() {
                if w.dims.averages > 0 && w.size(w.dims.averages) > 1 {
                    out_w_cs = Some(op_align_averages(w, Some(opts.water_tmax_factor * d.tmax), AlignTo::Best)?.out);
                }
            }
            for k in 0..nr {
                fs_cum[k] += a.fs[k];
                phs_cum[k] += a.phs[k];
            }
            fs_poly = slope(&a.fs[..nr]);
            phs_poly = slope(&a.phs[..nr]);
            cur = a.out;
            iter += 1;
        }
        if fs_poly.abs() > 0.001 || phs_poly.abs() > 0.01 {
            report.warnings.push(format!("Drift correction stopped after {} passes with a residual trend of {fs_poly:.4} Hz and {phs_poly:.4} deg per average.", iter - 1));
        }
        report.drift = Some(DriftReport { iterations: iter - 1, total_freq_drift: span(&fs_cum), total_phase_drift: span(&phs_cum), freq: fs_cum, phase: phs_cum });
        cur
    } else {
        if d.enabled {
            if let Some(w) = out_w_cs.as_ref() {
                if w.dims.averages > 0 && w.size(w.dims.averages) > 1 {
                    hooks.step("Aligning the water reference", 0.45)?;
                    out_w_cs = Some(op_align_averages(w, Some(opts.water_tmax_factor * d.tmax), AlignTo::Best)?.out);
                }
            }
        }
        out_rm
    };

    hooks.step("Averaging, left shift, phasing and referencing", 0.88)?;
    let ls = |s: Spectra| -> Result<Spectra, String> { if opts.leftshift { leftshift_by_own(&s) } else { Ok(s) } };
    let out_av = ls(op_averaging(&out_aa))?;
    let out_w_av = out_w_cs.as_ref().map(|w| ls(op_averaging(w))).transpose()?;
    let out_av_zp = op_zeropad(&out_av, 16.0);
    let ph0 = if opts.autophase { peak_phase(&out_av_zp, 2.85, 3.15)? } else { 0.0 };
    report.ph0 = ph0;
    let out_ph = op_addphase(&out_av, ph0, 0.0, 4.65);
    out_noproc = op_addphase(&ls(out_noproc)?, ph0, 0.0, 4.65);
    let mut w_ph = None;
    if let Some(w) = out_w_av.as_ref() {
        let zp = op_zeropad(w, 16.0);
        let ph0w = if opts.autophase { peak_phase(&zp, 4.0, 5.5)? } else { 0.0 };
        report.ph0_water = Some(ph0w);
        out_w_noproc = out_w_noproc.map(|n| ls(n).map(|n| op_addphase(&n, ph0w, 0.0, 4.65))).transpose()?;
        w_ph = Some((op_addphase(w, ph0w, 0.0, 4.65), op_addphase(&zp, ph0w, 0.0, 4.65)));
    }
    let frq = if opts.ppmref { op_ppmref(&out_av_zp, 2.9, 3.1, 3.027, None)?.1 } else { 0.0 };
    report.freq_shift = frq;
    let out = op_freqshift(&out_ph, frq);
    let out_noproc = op_freqshift(&out_noproc, frq);
    let (out_w, out_w_noproc) = match w_ph {
        Some((w, zp)) => {
            let f = if opts.ppmref { op_ppmref(&zp, 4.0, 5.5, 4.65, None)?.1 } else { 0.0 };
            report.freq_shift_water = Some(f);
            (Some(op_freqshift(&w, f)), out_w_noproc.map(|n| op_freqshift(&n, f)))
        }
        None => (None, None),
    };
    hooks.step("Measuring SNR and linewidth", 0.95)?;
    quality(&mut report, &out, out_w.as_ref());
    hooks.step("Done", 1.0)?;
    Ok(PipelineOutput { out, outw: out_w, out_noproc, outw_noproc: out_w_noproc, report })
}

/// Options of `run_megapressproc_auto`.
#[derive(Clone, Copy, Debug)]
pub struct MegaOptions {
    pub coils: CoilOptions,
    pub rm_bad_averages: RmBadOptions,
    pub drift: DriftOptions,
    /// tmax of the water reference's alignment (0.2 s).
    pub water_tmax: f64,
    pub leftshift: bool,
    /// Zero-order phase on creatine of the edit-ON subspectrum (2.9-3.1 ppm).
    pub autophase: bool,
    /// Align edit-ON to edit-OFF (op_alignMPSubspecs).
    pub align_subspecs: bool,
    /// Creatine of the edit-OFF subspectrum to 3.027 ppm.
    pub ppmref: bool,
}

impl Default for MegaOptions {
    fn default() -> Self {
        MegaOptions {
            coils: CoilOptions { mode: CoilMode::W, point: 1 },
            rm_bad_averages: RmBadOptions { enabled: true, nsd: 4.0, domain: Domain::Time },
            drift: DriftOptions { enabled: true, domain: DriftDomain::Freq, tmax: 0.25, ppmmin: 1.6, ppmmax: 4.0, max_iterations: 20 },
            water_tmax: 0.2,
            leftshift: true,
            autophase: true,
            align_subspecs: true,
            ppmref: true,
        }
    }
}

/// Result of `run_megapressproc_auto`.
pub struct MegaOutput {
    /// Edit-ON minus edit-OFF.
    pub diff: Spectra,
    pub sum: Spectra,
    /// FID-A's subSpec1 (phased by 180 degrees and referenced) and subSpec2.
    pub sub1: Spectra,
    pub sub2: Spectra,
    pub outw: Option<Spectra>,
    /// The difference without removal of bad averages or drift correction.
    pub diff_noproc: Spectra,
    pub report: Report,
}

/// Deterministic run_megapressproc_auto (avgAlignDomain 'f', alignSS 2): coil
/// combination, removal of bad averages, per-subspectrum drift correction,
/// phasing on the edit-ON creatine, alignment of the subspectra, and the
/// difference, sum and individual subspectra, referenced on creatine.
/// Fixed registration windows replace FID-A's random draws, as in
/// `run_pressproc_auto`; validation/megapressproc_det.m is the same in FID-A.
pub fn run_megapressproc_auto(raw: &Spectra, raww: Option<&Spectra>, opts: &MegaOptions, progress: &mut dyn FnMut(&str, f32), cancelled: &dyn Fn() -> bool) -> Result<MegaOutput, String> {
    let mut hooks = Hooks { progress, cancelled };
    let mut report = Report { pipeline: "run_megapressproc_auto".into(), ..Default::default() };
    if raw.dims.sub_specs == 0 || raw.size(raw.dims.sub_specs) != 2 {
        return Err("MEGA-PRESS data need two subspectra (edit-ON and edit-OFF).".into());
    }
    report.averages_raw = if raw.dims.averages > 0 { raw.size(raw.dims.averages) } else { 1 };
    hooks.step("Combining receiver channels", 0.0)?;
    let co = &opts.coils;
    let (cc, outw_cc) = match raww {
        Some(w) => {
            let cc = op_getcoilcombos(w, co.point, co.mode)?;
            let r = op_addrcvrs(w, co.point, co.mode, Some(&cc), false)?;
            (cc, Some(r.out))
        }
        None => (op_getcoilcombos(&op_averaging(&op_combinesubspecs(raw, CombineMode::Summ)?), co.point, co.mode)?, None),
    };
    let r = op_addrcvrs(raw, co.point, co.mode, Some(&cc), false)?;
    report.coils = coil_report(&r.coilcombos, raww.is_some());
    let out_cc = r.out;
    let mut diff_noproc = op_combinesubspecs(&op_averaging(&out_cc), CombineMode::Diff)?;

    let out_rm = if opts.rm_bad_averages.enabled && out_cc.dims.averages > 0 {
        let (o, rep) = rm_bad_loop(&out_cc, &opts.rm_bad_averages, &mut hooks, 0.2, &mut report.warnings)?;
        report.rm_bad_averages = Some(rep);
        o
    } else {
        out_cc.clone()
    };
    drop(out_cc);

    let d = &opts.drift;
    let outw_av = if let Some(w) = outw_cc.as_ref() {
        if d.enabled && w.dims.averages > 0 && w.size(w.dims.averages) > 1 {
            hooks.step("Aligning the water reference", 0.3)?;
            let outw_aa = op_align_averages(w, Some(opts.water_tmax), AlignTo::Best)?.out;
            Some(op_averaging(&outw_aa))
        } else {
            Some(op_averaging(w))
        }
    } else {
        None
    };
    let out_av = if d.enabled && out_rm.dims.averages > 0 && out_rm.size(out_rm.dims.averages) > 1 {
        let na = out_rm.size(out_rm.dims.averages);
        let ns = out_rm.size(out_rm.dims.sub_specs);
        let mut fscum = vec![0.0; na * ns];
        let mut phscum = vec![0.0; na * ns];
        let mut cur = out_rm;
        let mut p = 100.0f64;
        let mut iter = 0;
        while p.abs() > 0.0003 && iter < d.max_iterations {
            iter += 1;
            hooks.step(&format!("Correcting frequency drift (pass {iter})"), 0.3 + 0.5 * iter as f32 / d.max_iterations as f32)?;
            let a = match d.domain {
                DriftDomain::Time => op_align_averages(&cur, Some(d.tmax), AlignTo::Median)?,
                DriftDomain::Freq => op_align_averages_fd(&cur, d.ppmmin, d.ppmmax, d.tmax, AlignTo::Median)?,
            };
            // polyfit(repmat(1:na, 1, ns), fs, 1): one line through every subspectrum.
            let x: Vec<f64> = (0..na * ns).map(|k| (k % na + 1) as f64).collect();
            p = polyfit(&x, &a.fs, 1)[0];
            for k in 0..na * ns {
                fscum[k] += a.fs[k];
                phscum[k] += a.phs[k];
            }
            cur = a.out;
        }
        if p.abs() > 0.0003 {
            report.warnings.push(format!("Drift correction stopped after {iter} passes with a residual trend of {p:.4} Hz per average."));
        }
        let first = fscum[..na].to_vec();
        let first_ph = phscum[..na].to_vec();
        report.drift = Some(DriftReport { iterations: iter, total_freq_drift: span(&first), total_phase_drift: span(&first_ph), freq: fscum, phase: phscum });
        op_averaging(&cur)
    } else {
        op_averaging(&out_rm)
    };
    drop(outw_cc);

    hooks.step("Left shift, phasing and subspectrum alignment", 0.85)?;
    let (out_ls, outw_ls) = if opts.leftshift {
        (leftshift_by_own(&out_av)?, outw_av.as_ref().map(leftshift_by_own).transpose()?)
    } else {
        (out_av, outw_av)
    };
    let ph0 = if opts.autophase { op_autophase(&op_takesubspec(&out_ls, &[1])?, 2.9, 3.1, 0.0, None)?.1 } else { 0.0 };
    report.ph0 = ph0;
    let out_ph = op_addphase(&out_ls, ph0, 0.0, 4.65);
    diff_noproc = op_addphase(&diff_noproc, ph0, 0.0, 4.65);
    let out = if opts.align_subspecs && out_ph.dims.sub_specs > 0 {
        let (o, fs, phs) = op_align_mp_subspecs(&out_ph, false, None, None)?;
        report.isis_freq = vec![fs];
        report.isis_phase = vec![phs];
        o
    } else {
        out_ph
    };
    let outw_as = match outw_ls {
        Some(w) if w.dims.sub_specs > 0 => Some(op_align_mp_subspecs_fd(&w, 3.0, 6.5, true, None)?.0),
        other => other,
    };
    let diff = op_combinesubspecs(&out, CombineMode::Diff)?;
    let sum = op_combinesubspecs(&out, CombineMode::Summ)?;
    let sub1 = op_addphase(&op_takesubspec(&out, &[0])?, 180.0, 0.0, 4.65);
    let sub2 = op_takesubspec(&out, &[1])?;
    let (sub1, frq) = if opts.ppmref { op_ppmref(&sub1, 2.9, 3.1, 3.027, None)? } else { (sub1, 0.0) };
    report.freq_shift = frq;
    let diff = op_freqshift(&diff, frq);
    let sum = op_freqshift(&sum, frq);
    let sub2 = op_freqshift(&sub2, frq);
    let outw = match outw_as {
        Some(w) => {
            let w = if w.dims.sub_specs > 0 { op_combinesubspecs(&w, CombineMode::Diff)? } else { w };
            let ph = -phase1(w.fids[0]) * 180.0 / std::f64::consts::PI;
            report.ph0_water = Some(ph);
            Some(op_addphase(&w, ph, 0.0, 4.65))
        }
        None => None,
    };
    hooks.step("Measuring SNR and linewidth", 0.95)?;
    quality(&mut report, &sum, outw.as_ref());
    hooks.step("Done", 1.0)?;
    Ok(MegaOutput { diff, sum, sub1, sub2, outw, diff_noproc, report })
}
