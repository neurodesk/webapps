//! Functional MRS (fMRS) transient-preserving preprocessing, temporal /
//! condition binning, and BOLD linewidth matching.
//!
//! Standard single-voxel preprocessing (`run_pressproc_auto`) averages every
//! transient into one spectrum. For fMRS, transients must be coil-combined,
//! quality-filtered (preserving original acquisition indices and timestamps),
//! aligned in frequency and phase across the full run, phased and referenced
//! in one consistent global frame (estimated on the high-SNR grand mean), and
//! then averaged within temporal windows or paradigm conditions. Optional
//! exponential line broadening equalises linewidths across bins so stimulus-
//! evoked BOLD T2* narrowing does not bias linear-combination fits.

use num_complex::Complex64;
use rustfft::FftPlanner;
use serde_json::{json, Value};

use super::align::{op_align_averages, op_align_averages_fd, AlignTo};
use super::averaging::{op_averaging, op_rmbadaverages, op_takeaverages, Domain};
use super::basic::{op_addphase, op_autophase, op_filter, op_freqshift, op_leftshift, op_ppmref, op_zeropad};
use super::coils::{op_addrcvrs, op_getcoilcombos, CoilCombos, CoilMode};
use super::ecc::op_ecc;
use super::pipeline::{CoilOptions, CoilReport, DriftDomain, DriftOptions, DriftReport, RmBadOptions, RmBadPass, RmBadReport, CANCELLED};
use super::quality::{op_get_lw, op_get_snr};
use super::util::{median, polyfit};
use crate::spectra::{fftshift, Spectra};

/// One temporal window or condition bin to build from original 0-based
/// transient indices.
#[derive(Clone, Debug)]
pub struct FmrsBinSpec {
    pub id: String,
    pub label: String,
    pub condition: Option<String>,
    /// Original 0-based transient indices belonging to this bin.
    pub indices: Vec<usize>,
    pub start_time_s: f64,
    pub end_time_s: f64,
}

/// Options for [`run_fmrs_preprocess`].
#[derive(Clone, Debug)]
pub struct FmrsOptions {
    pub coils: CoilOptions,
    pub rm_bad_averages: RmBadOptions,
    pub drift: DriftOptions,
    pub water_tmax: f64,
    pub leftshift: bool,
    pub autophase: bool,
    pub ppmref: bool,
    pub ge_phasing: bool,
    /// Apply water-reference eddy-current correction to the exported dynamic
    /// transient spectra when a water reference is present, matching LCModel's
    /// `doecc=T` frame.
    pub apply_ecc_to_dynamic: bool,
    /// Bins to form from the kept transients.
    pub bins: Vec<FmrsBinSpec>,
    /// Match linewidths across bins by exponential apodisation (BOLD matching).
    pub match_linewidth: bool,
    /// Optional explicit target linewidth (Hz) when `match_linewidth` is true;
    /// otherwise the maximum non-outlier bin linewidth is used.
    pub target_linewidth_hz: Option<f64>,
    /// Export complex per-kept-transient spectra over `[dynamic_ppm_end, dynamic_ppm_start]`
    /// for 2D dynamic spectral projection.
    pub export_transients: bool,
    pub dynamic_ppm_start: f64,
    pub dynamic_ppm_end: f64,
    /// Original 0-based acquisition indices for each transient in `raw` when
    /// empty rows were compacted during import (e.g. Philips SDAT padding).
    pub original_indices: Option<Vec<usize>>,
    /// Total raw acquisition rows before any empty-row compaction.
    pub original_count: Option<usize>,
}

impl Default for FmrsOptions {
    fn default() -> Self {
        FmrsOptions {
            coils: CoilOptions { mode: CoilMode::W, point: 1 },
            rm_bad_averages: RmBadOptions { enabled: true, nsd: 4.0, domain: Domain::Time },
            drift: DriftOptions { enabled: true, domain: DriftDomain::Freq, tmax: 0.25, ppmmin: 1.6, ppmmax: 4.0, max_iterations: 20 },
            water_tmax: 0.2,
            leftshift: true,
            autophase: true,
            ppmref: true,
            ge_phasing: false,
            apply_ecc_to_dynamic: true,
            bins: Vec::new(),
            match_linewidth: false,
            target_linewidth_hz: None,
            export_transients: false,
            dynamic_ppm_start: 4.2,
            dynamic_ppm_end: 0.2,
            original_indices: None,
            original_count: None,
        }
    }
}

/// Quality and drift record for one raw transient (0-based original index).
#[derive(Clone, Debug)]
pub struct TransientRecord {
    pub index: usize,
    pub time_s: f64,
    pub kept: bool,
    pub metric: Option<f64>,
    pub freq_hz: Option<f64>,
    pub phase_deg: Option<f64>,
}

/// One binned spectrum produced by [`run_fmrs_preprocess`].
#[derive(Clone, Debug)]
pub struct FmrsBinOutput {
    pub id: String,
    pub label: String,
    pub condition: Option<String>,
    pub start_time_s: f64,
    pub end_time_s: f64,
    pub mid_time_s: f64,
    pub averages_total: usize,
    pub averages_kept: usize,
    pub averages_removed: usize,
    pub kept_indices: Vec<usize>,
    /// `None` when every transient in this bin was removed as a bad average.
    pub spectrum: Option<Spectra>,
    pub snr_before: Option<f64>,
    pub snr_after: Option<f64>,
    pub linewidth_before_hz: Option<f64>,
    pub linewidth_after_hz: Option<f64>,
    pub broadening_applied_hz: f64,
    pub excluded_from_lw_target: bool,
    /// `"off" | "matched" | "target" | "unmatched_wider" | "unmatched_missing" | "unmatched_tolerance"`.
    pub linewidth_match_status: &'static str,
    pub empty_reason: Option<String>,
}

/// Complex per-kept-transient frequency-domain data for two-stage dynamic
/// spectral projection, computed via a 2x-zero-filled forward FFT of conjugated
/// FIDs (`raw[k] = conj(fid[k])`, matching LCModel's `.COORD` convention) so the
/// downstream fitter aligns directly to LCModel's phase0, phase1, shift and scale.
#[derive(Clone, Debug)]
pub struct DynamicTransients {
    pub ppm: Vec<f64>,
    /// Original 0-based transient index for each row of `spectra_re`/`spectra_im`.
    pub indices: Vec<usize>,
    /// Acquisition timestamp (s) for each kept transient (`index * tr_s`).
    pub times_s: Vec<f64>,
    pub spectra_re: Vec<Vec<f64>>,
    pub spectra_im: Vec<Vec<f64>>,
    pub mean_re: Vec<f64>,
    pub mean_im: Vec<f64>,
    /// First-order Lorentzian line-broadening derivative `dS/d(LB_Hz)` on `ppm`:
    /// 2x-zero-filled `fftshift(fft(-pi * t * conj(fid_mean(t))))`, modelling
    /// BOLD T2* linewidth shifts in LCModel's spectral frame.
    pub bold_deriv_re: Vec<f64>,
    pub bold_deriv_im: Vec<f64>,
    /// First-order frequency-shift derivative `dS/d(f_Hz)` on `ppm`:
    /// 2x-zero-filled `fftshift(fft(-2*pi*i * t * conj(fid_mean(t))))`, modelling
    /// residual B0 shifts in LCModel's spectral frame.
    pub freq_deriv_re: Vec<f64>,
    pub freq_deriv_im: Vec<f64>,
    pub ecc_applied: bool,
}

/// Complete output of [`run_fmrs_preprocess`].
#[derive(Clone, Debug)]
pub struct FmrsOutput {
    pub grand_mean: Spectra,
    pub grand_mean_unprocessed: Spectra,
    pub water: Option<Spectra>,
    pub bins: Vec<FmrsBinOutput>,
    pub transients: Vec<TransientRecord>,
    pub dynamic: Option<DynamicTransients>,
    pub tr_s: f64,
    pub averages_raw: usize,
    pub averages_kept: usize,
    pub coils: Option<CoilReport>,
    pub rm_bad_averages: Option<RmBadReport>,
    pub drift: Option<DriftReport>,
    pub ph0: f64,
    pub ph0_water: Option<f64>,
    pub freq_shift: f64,
    pub freq_shift_water: Option<f64>,
    pub snr_mean: Option<f64>,
    pub linewidth_mean_hz: Option<f64>,
    pub linewidth_water_hz: Option<f64>,
    pub linewidth_ref: &'static str,
    pub match_linewidth: bool,
    pub target_linewidth_hz: Option<f64>,
    pub warnings: Vec<String>,
}

fn nan_to_null(v: f64) -> Value {
    if v.is_finite() { json!(v) } else { Value::Null }
}

fn opt_num(v: Option<f64>) -> Value {
    v.map(nan_to_null).unwrap_or(Value::Null)
}

fn vec_json(v: &[f64]) -> Value {
    Value::Array(v.iter().map(|&x| nan_to_null(x)).collect())
}

impl FmrsOutput {
    pub fn report_json(&self) -> Value {
        json!({
            "pipeline": "fmrs",
            "trS": nan_to_null(self.tr_s),
            "averagesRaw": self.averages_raw,
            "averagesKept": self.averages_kept,
            "coils": self.coils.as_ref().map(|c| json!({
                "phase": vec_json(&c.phase),
                "weight": vec_json(&c.weight),
                "from_water": c.from_water,
            })),
            "rm_bad_averages": self.rm_bad_averages.as_ref().map(|r| json!({
                "nsd": r.nsd,
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
            "ph0_water": opt_num(self.ph0_water),
            "freq_shift": nan_to_null(self.freq_shift),
            "freq_shift_water": opt_num(self.freq_shift_water),
            "snr": opt_num(self.snr_mean),
            "linewidth_naa": opt_num(self.linewidth_mean_hz),
            "linewidth_water": opt_num(self.linewidth_water_hz),
            "linewidthRef": self.linewidth_ref,
            "matchLinewidth": self.match_linewidth,
            "targetLinewidthHz": opt_num(self.target_linewidth_hz),
            "transients": self.transients.iter().map(|t| json!({
                "index": t.index,
                "timeS": nan_to_null(t.time_s),
                "kept": t.kept,
                "removed": !t.kept,
                "metric": opt_num(t.metric),
                "freqHz": opt_num(t.freq_hz),
                "phaseDeg": opt_num(t.phase_deg),
            })).collect::<Vec<_>>(),
            "warnings": self.warnings,
        })
    }
}

fn span(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mx = v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mn = v.iter().copied().fold(f64::INFINITY, f64::min);
    mx - mn
}

fn slope(v: &[f64]) -> f64 {
    let x: Vec<f64> = (1..=v.len()).map(|k| k as f64).collect();
    if v.len() < 2 {
        return 0.0;
    }
    polyfit(&x, v, 1)[0]
}

fn coil_report(cc: &CoilCombos, from_water: bool) -> CoilReport {
    CoilReport { phase: cc.ph.clone(), weight: cc.sig.iter().map(|z| z.re).collect(), from_water }
}

fn leftshift_by_own(s: &Spectra) -> Result<Spectra, String> {
    let ls = s.points_to_leftshift.max(0.0).round() as usize;
    if ls == 0 {
        return Ok(s.clone());
    }
    op_leftshift(s, ls)
}

fn measure_lw_window(s: &Spectra, lo: f64, hi: f64) -> Option<f64> {
    op_get_lw(s, lo, hi, 8.0).ok().filter(|v| v.is_finite() && *v > 0.0)
}

fn measure_snr(s: &Spectra) -> Option<f64> {
    op_get_snr(s, 1.8, 2.2, -2.0, 0.0).ok().map(|r| r.snr).filter(|v| v.is_finite())
}

fn rm_bad_with_indices(
    input: &Spectra,
    o: &RmBadOptions,
    progress: &mut dyn FnMut(&str, f32),
    cancelled: &dyn Fn() -> bool,
) -> Result<(Spectra, Vec<usize>, Vec<f64>, RmBadReport), String> {
    let before = if input.dims.averages > 0 { input.size(input.dims.averages) } else { 1 };
    let mut rep = RmBadReport { nsd: o.nsd, averages_before: before, ..Default::default() };
    let mut cur = input.clone();
    let mut left: Vec<usize> = (0..before).collect();
    let mut initial_metric: Vec<f64> = Vec::new();
    loop {
        if cancelled() {
            return Err(CANCELLED.into());
        }
        progress("Removing bad averages", 0.2);
        let r = op_rmbadaverages(&cur, o.nsd, o.domain)?;
        let pass_metric = r.metric[..r.metric.len() / r.n_subspecs.max(1)].to_vec();
        if initial_metric.is_empty() {
            initial_metric = pass_metric.clone();
        }
        let nbad = r.bad.len();
        for &b in &r.bad {
            rep.removed.push(left[b]);
        }
        let keep: Vec<usize> = (0..left.len()).filter(|k| !r.bad.contains(k)).collect();
        left = keep.iter().map(|&k| left[k]).collect();
        rep.passes.push(RmBadPass { metric: pass_metric, removed: r.bad.clone() });
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
    Ok((cur, left, initial_metric, rep))
}

fn build_dynamic_transients(
    aligned: &Spectra,
    water: Option<&Spectra>,
    apply_ecc: bool,
    kept_indices: &[usize],
    tr_s: f64,
    ppm_start: f64,
    ppm_end: f64,
) -> DynamicTransients {
    let (dyn_aligned, ecc_applied) = match (apply_ecc, water) {
        (true, Some(w)) if w.n() == aligned.n() => match op_ecc(aligned, w) {
            Ok((corrected, _)) => (corrected, true),
            Err(_) => (aligned.clone(), false),
        },
        _ => (aligned.clone(), false),
    };
    let grand_mean = op_averaging(&dyn_aligned);
    let n = dyn_aligned.n();
    let m = n * 2; // 2x zero-filling, matching LCModel's .COORD grid.
    let dt = dyn_aligned.dwelltime;
    let hzpppm = dyn_aligned.txfrq / 1e6;

    // LCModel receives `raw[k] = conj(fid[k])` (io_writelcm) and computes the
    // forward DFT `sum_k raw[k] * exp(-2*pi*i * f_j * k * dt)` on `ppm = 4.65 - f / hzpppm`.
    // Evaluating in LCModel's exact 2x-zero-filled frame works identically across
    // all vendors (including GE P-files after `op_complex_conj`) and matches
    // LCModel's `shiftPpm` and `phase1DegPerPpm` conventions directly.
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(m);
    let lcm_spec = |fid: &[Complex64]| -> Vec<Complex64> {
        let mut buf = vec![Complex64::new(0.0, 0.0); m];
        for (dst, &src) in buf.iter_mut().zip(fid.iter()) {
            *dst = src.conj();
        }
        fft.process(&mut buf);
        fftshift(&buf)
    };

    let full_ppm: Vec<f64> = (0..m)
        .map(|idx| {
            let q = idx as isize - (m / 2) as isize;
            let f_hz = (q as f64) / (m as f64 * dt);
            4.65 - f_hz / hzpppm
        })
        .collect();

    // Expand export range (+0.35 ppm margin on each side) so LCModel's
    // chemical-shift reference offset (`shiftPpm`, including room-temperature
    // phantom shifts) never clips the fit window.
    let lo = ppm_end - 0.35;
    let hi = ppm_start + 0.35;
    let mask: Vec<usize> = (0..m)
        .filter(|&i| full_ppm[i] <= hi && full_ppm[i] >= lo)
        .collect();
    let ppm: Vec<f64> = mask.iter().map(|&i| full_ppm[i]).collect();

    let mean_fid = grand_mean.fid(0);
    let mean_sp = lcm_spec(mean_fid);
    let mean_re: Vec<f64> = mask.iter().map(|&i| mean_sp[i].re).collect();
    let mean_im: Vec<f64> = mask.iter().map(|&i| mean_sp[i].im).collect();

    // First-order Lorentzian broadening derivative:
    // raw(t; LB) = raw(t) * exp(-pi * LB * t)  =>  d/dLB = -pi * t * raw(t)
    let lb_fid: Vec<Complex64> = mean_fid
        .iter()
        .zip(&grand_mean.t)
        .map(|(&z, &t)| z * (-std::f64::consts::PI * t))
        .collect();
    let lb_sp = lcm_spec(&lb_fid);
    let bold_deriv_re: Vec<f64> = mask.iter().map(|&i| lb_sp[i].re).collect();
    let bold_deriv_im: Vec<f64> = mask.iter().map(|&i| lb_sp[i].im).collect();

    // First-order frequency shift derivative in LCModel's frame:
    // raw(t; df) = raw(t) * exp(-2*pi*i * df * t)  =>  d/df = -2*pi*i * t * raw(t).
    // Since `lcm_spec` conjugates its input, pass `conj(-2*pi*i * t * conj(z)) = +2*pi*i * t * z`.
    let frq_fid: Vec<Complex64> = mean_fid
        .iter()
        .zip(&grand_mean.t)
        .map(|(&z, &t)| z * Complex64::new(0.0, 2.0 * std::f64::consts::PI * t))
        .collect();
    let frq_sp = lcm_spec(&frq_fid);
    let freq_deriv_re: Vec<f64> = mask.iter().map(|&i| frq_sp[i].re).collect();
    let freq_deriv_im: Vec<f64> = mask.iter().map(|&i| frq_sp[i].im).collect();

    let na = kept_indices.len();
    let mut spectra_re = Vec::with_capacity(na);
    let mut spectra_im = Vec::with_capacity(na);
    for k in 0..na {
        let sp = lcm_spec(&dyn_aligned.fids[k * n..(k + 1) * n]);
        spectra_re.push(mask.iter().map(|&i| sp[i].re).collect());
        spectra_im.push(mask.iter().map(|&i| sp[i].im).collect());
    }
    let times_s: Vec<f64> = kept_indices.iter().map(|&i| i as f64 * tr_s).collect();
    DynamicTransients {
        ppm,
        indices: kept_indices.to_vec(),
        times_s,
        spectra_re,
        spectra_im,
        mean_re,
        mean_im,
        bold_deriv_re,
        bold_deriv_im,
        freq_deriv_re,
        freq_deriv_im,
        ecc_applied,
    }
}

/// Run transient-preserving fMRS preprocessing, binning, and optional BOLD
/// linewidth matching.
pub fn run_fmrs_preprocess(
    raw: &Spectra,
    raww: Option<&Spectra>,
    opts: &FmrsOptions,
    progress: &mut dyn FnMut(&str, f32),
    cancelled: &dyn Fn() -> bool,
) -> Result<FmrsOutput, String> {
    if raw.dims.sub_specs > 0 && raw.size(raw.dims.sub_specs) > 1 {
        return Err("Functional MRS binning requires unedited single-subspectrum transients (not MEGA-PRESS/SPECIAL subspectra).".into());
    }
    let averages_raw = if raw.dims.averages > 0 { raw.size(raw.dims.averages) } else { 1 };
    if averages_raw < 2 {
        return Err("Functional MRS requires unaveraged multi-transient data (at least 2 averages).".into());
    }
    if opts.bins.is_empty() {
        return Err("Functional MRS requires at least one temporal window or condition bin.".into());
    }
    if !(raw.tr.is_finite() && raw.tr > 0.0) {
        return Err("Functional MRS requires a valid positive repetition time (TR) in the acquisition header.".into());
    }
    let tr_s = raw.tr / 1000.0;
    let mut warnings = Vec::new();
    let raw_coils = if raw.dims.coils > 0 { raw.size(raw.dims.coils) } else { 1 };
    let has_coils = raw_coils > 1;
    if let Some(w) = raww {
        let w_coils = if w.dims.coils > 0 { w.size(w.dims.coils) } else { 1 };
        if w_coils != raw_coils {
            return Err(format!(
                "Water reference has {w_coils} receive channels but the metabolite scan has {raw_coils}."
            ));
        }
        if w.n() != raw.n() || (w.dwelltime - raw.dwelltime).abs() > raw.dwelltime.abs() * 1e-6 {
            return Err("Water reference must have the same point count and dwell time as the metabolite scan.".into());
        }
    }

    if cancelled() {
        return Err(CANCELLED.into());
    }
    progress("Combining receiver channels", 0.0);
    let (mut out_cc, outw_cc, coils_report) = if has_coils {
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
        (r.out, outw_cc, Some(coil_report(&r.coilcombos, raww.is_some())))
    } else {
        // Already coil-combined (e.g. NIfTI-MRS, DICOM, SDAT): mark addedrcvrs so
        // op_rmbadaverages and spectral registration can operate on its transients.
        let mut combined = raw.clone();
        combined.flags.addedrcvrs = true;
        (combined, raww.cloned(), None)
    };
    let mut grand_mean_unprocessed = op_averaging(&out_cc);

    let (out_rm, kept_local, initial_metric, mut rm_bad_report) = if opts.rm_bad_averages.enabled && out_cc.dims.averages == 2 && averages_raw >= 4 {
        let (o, kept, metric, rep) = rm_bad_with_indices(&out_cc, &opts.rm_bad_averages, progress, cancelled)?;
        (o, kept, metric, Some(rep))
    } else {
        if opts.rm_bad_averages.enabled && averages_raw < 4 {
            warnings.push("Skipped bad-average removal because the scan has fewer than 4 averages.".into());
        }
        (out_cc.clone(), (0..averages_raw).collect(), Vec::new(), None)
    };
    out_cc.fids.clear();

    // Map local compacted transient positions back to true acquisition indices
    // (preserving timing when empty rows were dropped during import).
    let orig_map: Vec<usize> = match opts.original_indices.as_ref() {
        Some(v) if v.len() == averages_raw => v.clone(),
        _ => (0..averages_raw).collect(),
    };
    let total_raw = opts
        .original_count
        .unwrap_or(averages_raw)
        .max(orig_map.iter().copied().max().map(|m| m + 1).unwrap_or(0));
    let kept_indices: Vec<usize> = kept_local.iter().map(|&loc| orig_map[loc]).collect();
    if let Some(rep) = rm_bad_report.as_mut() {
        rep.removed = rep.removed.iter().map(|&loc| orig_map[loc]).collect();
    }

    let na_kept = kept_indices.len();
    let d = &opts.drift;
    let (aligned, outw_av, drift_report) = if d.enabled && out_rm.dims.averages > 0 && na_kept > 1 {
        if cancelled() {
            return Err(CANCELLED.into());
        }
        progress("Aligning the water reference", 0.3);
        let outw_aa = match outw_cc.as_ref() {
            Some(w) => {
                if w.dims.averages > 0 && w.size(w.dims.averages) > 1 {
                    Some(op_align_averages(w, Some(opts.water_tmax), AlignTo::Best)?.out)
                } else {
                    Some(w.clone())
                }
            }
            None => None,
        };
        let mut fscum = vec![0.0; na_kept];
        let mut phscum = vec![0.0; na_kept];
        let mut cur = out_rm;
        let (mut fs_poly, mut phs_poly) = (100.0f64, 1000.0f64);
        let mut iter = 1;
        let mut passes = 0;
        while (fs_poly.abs() > 0.001 || phs_poly.abs() > 0.01) && iter < d.max_iterations {
            if cancelled() {
                return Err(CANCELLED.into());
            }
            iter += 1;
            passes += 1;
            progress(
                &format!("Correcting frequency drift (pass {passes})"),
                0.3 + 0.4 * passes as f32 / d.max_iterations as f32,
            );
            let a = match d.domain {
                DriftDomain::Time => op_align_averages(&cur, Some(d.tmax), AlignTo::Median)?,
                DriftDomain::Freq => op_align_averages_fd(&cur, d.ppmmin, d.ppmmax, d.tmax, AlignTo::Median)?,
            };
            fs_poly = slope(&a.fs[..na_kept]);
            phs_poly = slope(&a.phs[..na_kept]);
            for k in 0..na_kept {
                fscum[k] += a.fs[k];
                phscum[k] += a.phs[k];
            }
            cur = a.out;
        }
        if fs_poly.abs() > 0.001 || phs_poly.abs() > 0.01 {
            warnings.push(format!(
                "Drift correction stopped after {passes} passes with a residual trend of {fs_poly:.4} Hz and {phs_poly:.4} deg per average."
            ));
        }
        let drift = DriftReport {
            iterations: passes,
            total_freq_drift: span(&fscum),
            total_phase_drift: span(&phscum),
            freq: fscum,
            phase: phscum,
        };
        (cur, outw_aa.as_ref().map(op_averaging), Some(drift))
    } else {
        (out_rm, outw_cc.as_ref().map(op_averaging), None)
    };

    if cancelled() {
        return Err(CANCELLED.into());
    }
    progress("Global phasing and referencing", 0.75);
    let aligned_ls = if opts.leftshift { leftshift_by_own(&aligned)? } else { aligned };
    let outw_ls = match outw_av.as_ref() {
        Some(w) if opts.leftshift => Some(leftshift_by_own(w)?),
        Some(w) => Some(w.clone()),
        None => None,
    };
    let mean_ls = op_averaging(&aligned_ls);

    // Estimate global zero-order phase and chemical-shift reference on the
    // high-SNR grand mean, then apply identically to every kept transient so
    // low-SNR windows remain phase-coherent.
    let ge = opts.ge_phasing;
    let mean_zf = if ge { op_zeropad(&mean_ls, 16.0) } else { op_filter(&op_zeropad(&mean_ls, 16.0), 5.0) };
    let (lo, hi) = if ge { (4.0, 5.5) } else { (2.9, 3.1) };
    let (mean_zf_ph, ph0) = if opts.autophase { op_autophase(&mean_zf, lo, hi, 0.0, None)? } else { (mean_zf, 0.0) };
    let frq = if opts.ppmref { op_ppmref(&mean_zf_ph, 2.9, 3.1, 3.027, None)?.1 } else { 0.0 };

    let aligned_ph = op_freqshift(&op_addphase(&aligned_ls, ph0, 0.0, 4.65), frq);
    let grand_mean = op_averaging(&aligned_ph);
    grand_mean_unprocessed = op_freqshift(
        &op_addphase(
            &if opts.leftshift { leftshift_by_own(&grand_mean_unprocessed)? } else { grand_mean_unprocessed },
            ph0,
            0.0,
            4.65,
        ),
        frq,
    );

    let mut ph0_water = None;
    let mut freq_shift_water = None;
    let water = if let Some(w) = outw_ls.as_ref() {
        let (zf_ph, ph0w) = if ge {
            (op_addphase(&op_zeropad(w, 16.0), ph0, 0.0, 4.65), ph0)
        } else {
            let zf = op_filter(&op_zeropad(w, 16.0), 5.0);
            if opts.autophase { op_autophase(&zf, 4.0, 5.5, 0.0, None)? } else { (zf, 0.0) }
        };
        ph0_water = Some(ph0w);
        let w_ph = op_addphase(w, ph0w, 0.0, 4.65);
        let fw = if opts.ppmref { op_ppmref(&zf_ph, 4.0, 5.5, 4.65, None)?.1 } else { 0.0 };
        freq_shift_water = Some(fw);
        Some(op_freqshift(&w_ph, fw))
    } else {
        None
    };

    let mut pos_by_orig = vec![None; total_raw];
    for (pos, &orig) in kept_indices.iter().enumerate() {
        if orig < total_raw {
            pos_by_orig[orig] = Some(pos);
        }
    }
    let mut metric_by_orig = vec![None; total_raw];
    for (loc, &orig) in orig_map.iter().enumerate() {
        if orig < total_raw {
            metric_by_orig[orig] = initial_metric.get(loc).copied().filter(|v| v.is_finite());
        }
    }

    let mut transients = Vec::with_capacity(total_raw);
    for orig in 0..total_raw {
        let pos = pos_by_orig[orig];
        transients.push(TransientRecord {
            index: orig,
            time_s: orig as f64 * tr_s,
            kept: pos.is_some(),
            metric: metric_by_orig[orig],
            freq_hz: pos.and_then(|p| drift_report.as_ref().and_then(|d| d.freq.get(p).copied())),
            phase_deg: pos.and_then(|p| drift_report.as_ref().and_then(|d| d.phase.get(p).copied())),
        });
    }

    if cancelled() {
        return Err(CANCELLED.into());
    }
    progress("Binning fMRS windows", 0.85);
    let mut bins = Vec::with_capacity(opts.bins.len());
    for spec_bin in &opts.bins {
        let mut positions = Vec::new();
        let mut orig_kept = Vec::new();
        let mut valid_total = 0usize;
        for &orig in &spec_bin.indices {
            if orig < total_raw {
                valid_total += 1;
                if let Some(pos) = pos_by_orig[orig] {
                    positions.push(pos);
                    orig_kept.push(orig);
                }
            }
        }
        let averages_kept = positions.len();
        let averages_removed = valid_total.saturating_sub(averages_kept);
        let mid_time_s = 0.5 * (spec_bin.start_time_s + spec_bin.end_time_s);
        if positions.is_empty() {
            bins.push(FmrsBinOutput {
                id: spec_bin.id.clone(),
                label: spec_bin.label.clone(),
                condition: spec_bin.condition.clone(),
                start_time_s: spec_bin.start_time_s,
                end_time_s: spec_bin.end_time_s,
                mid_time_s,
                averages_total: valid_total,
                averages_kept: 0,
                averages_removed,
                kept_indices: Vec::new(),
                spectrum: None,
                snr_before: None,
                snr_after: None,
                linewidth_before_hz: None,
                linewidth_after_hz: None,
                broadening_applied_hz: 0.0,
                excluded_from_lw_target: false,
                linewidth_match_status: if opts.match_linewidth { "unmatched_missing" } else { "off" },
                empty_reason: Some("All transients in this window were removed or out of range.".into()),
            });
            continue;
        }
        let sub = op_takeaverages(&aligned_ph, &positions)?;
        let avg = if sub.dims.averages > 0 { op_averaging(&sub) } else { sub };
        let snr_before = measure_snr(&avg);
        bins.push(FmrsBinOutput {
            id: spec_bin.id.clone(),
            label: spec_bin.label.clone(),
            condition: spec_bin.condition.clone(),
            start_time_s: spec_bin.start_time_s,
            end_time_s: spec_bin.end_time_s,
            mid_time_s,
            averages_total: valid_total,
            averages_kept,
            averages_removed,
            kept_indices: orig_kept,
            spectrum: Some(avg),
            snr_before,
            snr_after: snr_before,
            linewidth_before_hz: None,
            linewidth_after_hz: None,
            broadening_applied_hz: 0.0,
            excluded_from_lw_target: false,
            linewidth_match_status: "off",
            empty_reason: None,
        });
    }

    // Use one consistent reference resonance across all bins (NAA 1.8-2.2 ppm,
    // falling back to Cr 2.85-3.2 ppm for ALL bins only if NAA fails on most).
    let non_empty_count = bins.iter().filter(|b| b.spectrum.is_some()).count();
    let naa_lws: Vec<Option<f64>> = bins.iter().map(|b| b.spectrum.as_ref().and_then(|s| measure_lw_window(s, 1.8, 2.2))).collect();
    let naa_ok = naa_lws.iter().filter(|v| v.is_some()).count();
    let (linewidth_ref, lw_lo, lw_hi) = if non_empty_count > 0 && naa_ok * 2 >= non_empty_count {
        ("NAA", 1.8, 2.2)
    } else {
        ("Cr", 2.85, 3.2)
    };
    for (k, b) in bins.iter_mut().enumerate() {
        let lw = if linewidth_ref == "NAA" {
            naa_lws[k]
        } else {
            b.spectrum.as_ref().and_then(|s| measure_lw_window(s, lw_lo, lw_hi))
        };
        b.linewidth_before_hz = lw;
        b.linewidth_after_hz = lw;
    }

    // Optional BOLD linewidth matching across bins using the same estimator.
    let mut target_lw = None;
    if opts.match_linewidth {
        progress("Matching linewidths across bins (BOLD)", 0.92);
        let lws: Vec<f64> = bins.iter().filter_map(|b| b.linewidth_before_hz).collect();
        let chosen = if let Some(t) = opts.target_linewidth_hz.filter(|v| v.is_finite() && *v > 0.0) {
            Some(t)
        } else if !lws.is_empty() {
            let med = median(&lws);
            let cap = if lws.len() >= 4 && med > 0.0 { med * 2.5 } else { f64::INFINITY };
            let mut max_ok = 0.0f64;
            for b in &mut bins {
                if let Some(lw) = b.linewidth_before_hz {
                    if lw <= cap {
                        max_ok = max_ok.max(lw);
                    } else {
                        b.excluded_from_lw_target = true;
                    }
                }
            }
            if max_ok > 0.0 { Some(max_ok) } else { lws.iter().copied().fold(None, |a, x| Some(a.map_or(x, |m: f64| m.max(x)))) }
        } else {
            warnings.push(format!("BOLD linewidth matching skipped: {linewidth_ref} linewidth could not be measured on any bin."));
            None
        };
        target_lw = chosen;
        for b in &mut bins {
            let Some(target) = chosen else {
                b.linewidth_match_status = "unmatched_missing";
                continue;
            };
            let (Some(spec_bin), Some(lw_before)) = (b.spectrum.as_ref(), b.linewidth_before_hz) else {
                b.linewidth_match_status = "unmatched_missing";
                continue;
            };
            let delta = target - lw_before;
            if delta > 0.05 {
                let filtered = op_filter(spec_bin, delta);
                // Preserve missing post-filter measurement rather than fabricating `target`,
                // and verify the post-filter linewidth actually landed near `target`.
                let measured_after = measure_lw_window(&filtered, lw_lo, lw_hi);
                b.linewidth_after_hz = measured_after;
                b.snr_after = measure_snr(&filtered);
                b.broadening_applied_hz = delta;
                let tol = (target * 0.15).max(1.0);
                b.linewidth_match_status = match measured_after {
                    Some(after) if (after - target).abs() <= tol => "matched",
                    Some(_) => "unmatched_tolerance",
                    None => "unmatched_missing",
                };
                b.spectrum = Some(filtered);
            } else if delta < -0.05 {
                b.linewidth_match_status = "unmatched_wider";
            } else {
                b.linewidth_match_status = "target";
            }
        }
    }

    let dynamic = if opts.export_transients {
        progress("Preparing 2D dynamic transient matrix", 0.96);
        Some(build_dynamic_transients(
            &aligned_ph,
            water.as_ref(),
            opts.apply_ecc_to_dynamic,
            &kept_indices,
            tr_s,
            opts.dynamic_ppm_start,
            opts.dynamic_ppm_end,
        ))
    } else {
        None
    };

    let snr_mean = measure_snr(&grand_mean);
    let linewidth_mean_hz = measure_lw_window(&grand_mean, lw_lo, lw_hi);
    let linewidth_water_hz = water.as_ref().and_then(|w| op_get_lw(w, 4.4, 5.0, 8.0).ok());

    progress("Done", 1.0);
    Ok(FmrsOutput {
        grand_mean,
        grand_mean_unprocessed,
        water,
        bins,
        transients,
        dynamic,
        tr_s,
        averages_raw: total_raw,
        averages_kept: na_kept,
        coils: coils_report,
        rm_bad_averages: rm_bad_report,
        drift: drift_report,
        ph0,
        ph0_water,
        freq_shift: frq,
        freq_shift_water,
        snr_mean,
        linewidth_mean_hz,
        linewidth_water_hz,
        linewidth_ref,
        match_linewidth: opts.match_linewidth,
        target_linewidth_hz: target_lw,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spectra::{Dims, Flags};
    use num_complex::Complex64 as C;
    use std::f64::consts::PI;

    fn synthetic_fmrs(n_avg: usize, tr_ms: f64) -> Spectra {
        let n = 1024;
        let bo = 7.0;
        let txfrq = bo * 42.577e6;
        let sw = 6000.0;
        let dt = 1.0 / sw;
        let t: Vec<f64> = (0..n).map(|k| k as f64 * dt).collect();
        let hz_per_ppm = bo * 42.577;
        let f_naa = (2.01 - 4.65) * hz_per_ppm;
        let f_cr = (3.027 - 4.65) * hz_per_ppm;
        let mut fids = Vec::with_capacity(n * n_avg);
        for a in 0..n_avg {
            let stim = a >= n_avg / 2;
            let lw = if stim { 10.0 } else { 14.0 };
            let drift_hz = (a as f64 - n_avg as f64 / 2.0) * 0.4;
            let amp_naa = if stim { 1.1 } else { 1.0 };
            for &tk in &t {
                let env = (-PI * lw * tk).exp();
                let s_naa = C::new(0.0, 2.0 * PI * (f_naa + drift_hz) * tk).exp() * amp_naa;
                let s_cr = C::new(0.0, 2.0 * PI * (f_cr + drift_hz) * tk).exp() * 0.7;
                let noise = C::new(
                    ((a * 131 + (tk * 1e6) as usize * 17) % 97) as f64 * 1e-5 - 5e-4,
                    ((a * 73 + (tk * 1e6) as usize * 29) % 89) as f64 * 1e-5 - 5e-4,
                );
                fids.push((s_naa + s_cr) * env + noise);
            }
        }
        Spectra {
            fids,
            sz: vec![n, n_avg],
            dims: Dims { t: 1, coils: 0, averages: 2, sub_specs: 0, extras: 0 },
            t,
            ppm: super::super::util::ppm_axis(n, sw, bo),
            txfrq,
            bo,
            spectralwidth: sw,
            dwelltime: dt,
            te: 6.0,
            tr: tr_ms,
            averages: n_avg,
            raw_averages: n_avg,
            subspecs: 1,
            raw_subspecs: 1,
            seq: "STEAM".into(),
            points_to_leftshift: 0.0,
            flags: Flags { addedrcvrs: true, ..Default::default() },
            ..Default::default()
        }
    }

    #[test]
    fn fmrs_bins_preserves_indices_and_matches_bold_linewidth() {
        let s = synthetic_fmrs(16, 8000.0);
        let mut opts = FmrsOptions::default();
        opts.rm_bad_averages.enabled = false;
        opts.match_linewidth = true;
        opts.export_transients = true;
        opts.bins = vec![
            FmrsBinSpec { id: "rest".into(), label: "Rest".into(), condition: Some("Rest".into()), indices: (0..8).collect(), start_time_s: 0.0, end_time_s: 64.0 },
            FmrsBinSpec { id: "stim".into(), label: "Stim".into(), condition: Some("Stim".into()), indices: (8..16).collect(), start_time_s: 64.0, end_time_s: 128.0 },
        ];
        let out = run_fmrs_preprocess(&s, None, &opts, &mut |_, _| {}, &|| false).unwrap();
        assert_eq!(out.averages_raw, 16);
        assert_eq!(out.averages_kept, 16);
        assert_eq!(out.linewidth_ref, "NAA");
        assert_eq!(out.bins[0].linewidth_match_status, "target");
        assert_eq!(out.bins[1].linewidth_match_status, "matched");
        let rest_lw_after = out.bins[0].linewidth_after_hz.unwrap();
        let stim_lw_after = out.bins[1].linewidth_after_hz.unwrap();
        assert!((rest_lw_after - stim_lw_after).abs() < 1.5, "after: rest={rest_lw_after}, stim={stim_lw_after}");
        let dyn_t = out.dynamic.unwrap();
        assert_eq!(dyn_t.spectra_re.len(), 16);
        assert_eq!(dyn_t.spectra_im.len(), 16);
        assert_eq!(dyn_t.bold_deriv_im.len(), dyn_t.ppm.len());
    }

    #[test]
    fn fmrs_multipass_bad_average_removal_preserves_original_indices() {
        let mut s = synthetic_fmrs(20, 8000.0);
        let n = s.n();
        // Inject one huge outlier at index 2 (removed in pass 1) and a secondary
        // outlier at index 14 (removed in pass 2 after pass 1 narrows the SD).
        for k in 0..n {
            s.fids[2 * n + k] *= 30.0;
            s.fids[14 * n + k] *= 6.0;
        }
        let mut opts = FmrsOptions::default();
        opts.rm_bad_averages.enabled = true;
        opts.rm_bad_averages.nsd = 2.0;
        opts.drift.enabled = false;
        opts.bins = vec![
            FmrsBinSpec { id: "b1".into(), label: "B1".into(), condition: None, indices: (0..10).collect(), start_time_s: 0.0, end_time_s: 80.0 },
            FmrsBinSpec { id: "b2".into(), label: "B2".into(), condition: None, indices: (10..20).collect(), start_time_s: 80.0, end_time_s: 160.0 },
        ];
        let out = run_fmrs_preprocess(&s, None, &opts, &mut |_, _| {}, &|| false).unwrap();
        let rm = out.rm_bad_averages.as_ref().unwrap();
        assert!(rm.removed.contains(&2), "expected index 2 removed: {:?}", rm.removed);
        assert!(rm.removed.contains(&14), "expected index 14 removed: {:?}", rm.removed);
        assert!(!out.transients[2].kept);
        assert!(!out.transients[14].kept);
        assert!(!out.bins[0].kept_indices.contains(&2));
        assert!(!out.bins[1].kept_indices.contains(&14));
        assert_eq!(out.bins[0].kept_indices.len() + out.bins[0].averages_removed, 10);
        assert_eq!(out.bins[1].kept_indices.len() + out.bins[1].averages_removed, 10);
    }

    #[test]
    fn fmrs_rejects_missing_tr() {
        let s = synthetic_fmrs(8, 0.0);
        let mut opts = FmrsOptions::default();
        opts.bins = vec![FmrsBinSpec { id: "b1".into(), label: "B1".into(), condition: None, indices: (0..8).collect(), start_time_s: 0.0, end_time_s: 8.0 }];
        assert!(run_fmrs_preprocess(&s, None, &opts, &mut |_, _| {}, &|| false).is_err());
    }
}
