//! Synthetic-signal tests for every op: known shifts, phases, SNR and
//! linewidths are recovered. These need no data.

use fida::ops::pipeline::{run_megapressproc_auto, run_pressproc_auto, run_specialproc_auto, MegaOptions, PressOptions, SpecialOptions, CANCELLED};
use fida::ops::util::{fid_from_spec, ppm_axis, spec, t_axis};
use fida::ops::*;
use fida::{Dims, Flags, Spectra};
use num_complex::Complex64 as C;
use std::f64::consts::PI;

const N: usize = 2048;
const SW: f64 = 4000.0;
const BO: f64 = 3.0;

/// Deterministic standard normal numbers (xorshift + Box-Muller).
struct Rng(u64);
impl Rng {
    fn uniform(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn normal(&mut self) -> f64 {
        let (u, v) = (self.uniform(), self.uniform());
        (-2.0 * u.ln()).sqrt() * (2.0 * PI * v).cos()
    }
}

fn txfrq() -> f64 {
    BO * 42.577e6
}

/// A FID with Lorentzian peaks at (ppm, amplitude, T2 s), FID-A's sign
/// convention (ppm = -f/(Bo*42.577) + 4.65).
fn fid(peaks: &[(f64, f64, f64)]) -> Vec<C> {
    let t = t_axis(N, 1.0 / SW);
    t.iter()
        .map(|&tk| {
            peaks
                .iter()
                .map(|&(ppm, a, t2)| {
                    // FID-A spectra are fftshift(ifft(fid)), which puts exp(+2i*pi*f*t) at -f Hz,
                    // i.e. at ppm = f/(Bo*42.577) + 4.65.
                    let f = (ppm - 4.65) * BO * 42.577;
                    C::new(-tk / t2, 2.0 * PI * f * tk).exp() * a
                })
                .sum()
        })
        .collect()
}

fn metab() -> Vec<C> {
    fid(&[(2.01, 1.0, 0.08), (3.03, 0.8, 0.08), (3.21, 0.6, 0.08), (4.65, 3.0, 0.05)])
}

fn spectra(fids: Vec<C>, sz: Vec<usize>, dims: Dims, averages: usize, subspecs: usize) -> Spectra {
    let n = sz[0];
    Spectra {
        fids,
        sz,
        dims,
        ppm: ppm_axis(n, SW, BO),
        t: t_axis(n, 1.0 / SW),
        spectralwidth: SW,
        dwelltime: 1.0 / SW,
        txfrq: txfrq(),
        te: 30.0,
        tm: None,
        tr: 2000.0,
        bo: BO,
        seq: "press".into(),
        date: String::new(),
        averages,
        raw_averages: averages,
        subspecs,
        raw_subspecs: subspecs,
        points_to_leftshift: 0.0,
        flags: Flags { writtentostruct: true, gotparams: true, ..Default::default() },
        nucleus: "1H".into(),
    }
}

fn shift(f: &[C], hz: f64, deg: f64) -> Vec<C> {
    let t = t_axis(f.len(), 1.0 / SW);
    f.iter().zip(&t).map(|(v, tk)| v * C::new(0.0, 2.0 * PI * hz * tk + deg * PI / 180.0).exp()).collect()
}

/// Averages (dims t=1, averages=2) of `base` shifted by (Hz, degrees), with noise.
fn averaged(base: &[C], shifts: &[(f64, f64)], noise: f64, seed: u64) -> Spectra {
    let mut rng = Rng(seed);
    let mut fids = Vec::new();
    for &(hz, deg) in shifts {
        for v in shift(base, hz, deg) {
            fids.push(v + C::new(rng.normal(), rng.normal()) * noise);
        }
    }
    let mut s = spectra(fids, vec![N, shifts.len()], Dims { t: 1, averages: 2, ..Default::default() }, shifts.len(), 1);
    s.flags.addedrcvrs = true;
    s
}

#[test]
fn align_averages_recovers_known_shifts() {
    let base = metab();
    // Three averages already aligned, so the median is the unshifted signal.
    let truth = [(0.0, 0.0), (1.5, 20.0), (0.0, 0.0), (-2.0, -35.0), (0.0, 0.0)];
    let s = averaged(&base, &truth, 0.0, 1);
    let a = op_align_averages(&s, Some(0.3), AlignTo::Median).unwrap();
    for (k, &(hz, deg)) in truth.iter().enumerate() {
        assert!((a.fs[k] + hz).abs() < 1e-6, "fs[{k}] = {} (expected {})", a.fs[k], -hz);
        assert!((a.phs[k] + deg).abs() < 1e-4, "phs[{k}] = {}", a.phs[k]);
    }
    let e = a.out.fids.chunks(N).map(|c| c.iter().zip(&base).map(|(x, y)| (x - y).norm()).fold(0.0, f64::max)).fold(0.0, f64::max);
    assert!(e < 1e-5, "aligned FIDs differ from the base by {e}");
    // Against an external reference and the best average.
    let r = spectra(base.clone(), vec![N, 1], Dims { t: 1, ..Default::default() }, 1, 1);
    let a = op_align_averages(&s, Some(0.3), AlignTo::Ref(&r)).unwrap();
    assert!((a.fs[3] - 2.0).abs() < 1e-6 && (a.phs[3] - 35.0).abs() < 1e-4);
    let a = op_align_averages(&s, Some(0.3), AlignTo::Best).unwrap();
    assert!(a.reference[0].is_some());
    assert!((a.fs[1] + 1.5).abs() < 1e-6);
}

#[test]
fn align_averages_fd_and_freq_align_recover_shifts() {
    let base = metab();
    let truth = [(0.0, 0.0), (0.8, 10.0), (0.0, 0.0), (-1.2, -15.0), (0.0, 0.0)];
    let s = averaged(&base, &truth, 0.0, 2);
    // 'y' aligns to the mean, so align to an external reference to know the answer.
    let r = spectra(base.clone(), vec![N, 1], Dims { t: 1, ..Default::default() }, 1, 1);
    let a = op_align_averages_fd(&s, 1.6, 4.0, 0.25, AlignTo::Ref(&r)).unwrap();
    for (k, &(hz, deg)) in truth.iter().enumerate() {
        assert!((a.fs[k] + hz).abs() < 1e-3, "fd fs[{k}] = {}", a.fs[k]);
        assert!((a.phs[k] + deg).abs() < 0.1, "fd phs[{k}] = {}", a.phs[k]);
    }
    let truth = [(0.0, 0.0), (0.7, 0.0), (-0.4, 0.0)];
    let s = averaged(&base, &truth, 0.0, 3);
    let a = op_freq_align_averages(&s, 0.3, false, None).unwrap();
    assert!((a.fs[1] + 0.7).abs() < 1e-6 && (a.fs[2] - 0.4).abs() < 1e-6, "{:?}", a.fs);
}

#[test]
fn align_isis_recovers_second_subspectrum_shift() {
    let a = metab();
    let b = fid(&[(2.01, 0.5, 0.08), (1.3, 0.4, 0.05)]);
    let shifts = [(0.0, 0.0), (1.1, 25.0), (0.0, 0.0), (-0.9, -12.0), (0.0, 0.0)];
    let na = shifts.len();
    let mut fids = Vec::new();
    for _ in 0..na {
        fids.extend_from_slice(&a);
    }
    for &(hz, deg) in &shifts {
        // op_alignISIS applies exp(-1i*2*pi*f*t) and +p, so shift by +f and -p.
        fids.extend(shift(&b, hz, -deg));
    }
    let mut s = spectra(fids, vec![N, na, 2], Dims { t: 1, averages: 2, sub_specs: 3, ..Default::default() }, na * 2, 2);
    s.flags.addedrcvrs = true;
    let r = op_align_isis(&s, 0.4, None).unwrap();
    for (k, &(hz, deg)) in shifts.iter().enumerate() {
        assert!((r.fs[k] - hz).abs() < 1e-6, "fs[{k}] = {}", r.fs[k]);
        assert!((r.phs[k] - deg).abs() < 1e-4, "phs[{k}] = {}", r.phs[k]);
    }
    let c = op_combinesubspecs(&r.out, CombineMode::Diff).unwrap();
    assert_eq!(c.sz, vec![N, na]);
    assert_eq!(c.averages, na);
}

#[test]
fn align_mp_subspecs_recovers_shift() {
    let off = metab();
    let on = shift(&off, -1.3, 30.0);
    let mut fids = off.clone();
    fids.extend(on);
    let mut s = spectra(fids, vec![N, 2], Dims { t: 1, sub_specs: 2, ..Default::default() }, 2, 2);
    s.flags.addedrcvrs = true;
    let (out, f, p) = op_align_mp_subspecs(&s, true, None, None).unwrap();
    // The model applies exp(-1i*2*pi*f*t) then +p.
    assert!((f + 1.3).abs() < 1e-6, "f {f}");
    assert!((p + 30.0).abs() < 1e-4, "p {p}");
    let e = out.fids[N..].iter().zip(&off).map(|(x, y)| (x - y).norm()).fold(0.0, f64::max);
    assert!(e < 1e-5);
}

#[test]
fn rmbadaverages_removes_a_corrupted_average() {
    let base = metab();
    let shifts = vec![(0.0, 0.0); 24];
    let mut s = averaged(&base, &shifts, 0.02, 4);
    // Corrupt average 13 (motion: a large phase and amplitude change).
    for v in s.fids[13 * N..14 * N].iter_mut() {
        *v *= C::new(0.0, 1.2).exp() * 0.6;
    }
    let r = op_rmbadaverages(&s, 3.0, Domain::Time).unwrap();
    assert_eq!(r.bad, vec![13]);
    assert_eq!(r.out.sz, vec![N, 23]);
    assert_eq!(r.out.averages, 23);
    let r = op_rmbadaverages(&s, 3.0, Domain::Freq).unwrap();
    assert_eq!(r.bad, vec![13]);
    let w = op_rmworstaverage(&s).unwrap();
    assert_eq!(w.bad, vec![13]);
}

#[test]
fn averaging_median_takeaverages() {
    let base = metab();
    let s = averaged(&base, &[(0.0, 0.0), (0.0, 0.0), (0.0, 0.0), (0.0, 0.0)], 0.1, 5);
    let a = op_averaging(&s);
    assert_eq!(a.sz, vec![N, 1]);
    assert_eq!(a.dims.averages, 0);
    assert!(a.flags.averaged);
    let mean: C = (0..4).map(|k| s.fids[k * N + 7]).sum::<C>() / 4.0;
    assert!((a.fids[7] - mean).norm() < 1e-12);
    let m = op_median(&s);
    let mut re: Vec<f64> = (0..4).map(|k| s.fids[k * N + 7].re).collect();
    re.sort_by(|x, y| x.partial_cmp(y).unwrap());
    assert!((m.fids[7].re - (re[1] + re[2]) / 2.0).abs() < 1e-12);
    let t = op_takeaverages(&s, &[1, 3]).unwrap();
    assert_eq!(t.sz, vec![N, 2]);
    assert_eq!(t.fids[N], s.fids[3 * N]);
    let t = op_takeaverages(&s, &[2]).unwrap();
    assert_eq!(t.sz, vec![N, 1]);
    assert_eq!(t.dims.averages, 0);
}

#[test]
fn coil_combination_recovers_phases_and_weights() {
    let base = metab();
    let amps = [1.0, 0.5, 0.25, 2.0];
    let phases = [10.0, -80.0, 170.0, 45.0];
    let na = 3;
    let mut fids = Vec::new();
    for _ in 0..na {
        for c in 0..4 {
            fids.extend(base.iter().map(|v| v * C::from_polar(amps[c], phases[c] * PI / 180.0)));
        }
    }
    let s = spectra(fids, vec![N, 4, na], Dims { t: 1, coils: 2, averages: 3, ..Default::default() }, na, 1);
    let cc = op_getcoilcombos(&s, 1, CoilMode::W).unwrap();
    let p0 = base[0].im.atan2(base[0].re) * 180.0 / PI;
    for c in 0..4 {
        let d = (cc.ph[c] - p0 - phases[c] + 540.0).rem_euclid(360.0) - 180.0;
        assert!(d.abs() < 1e-9, "coil {c} phase");
        assert!((cc.sig[c].re - amps[c] / 2.0).abs() < 1e-12, "coil {c} weight");
    }
    let r = op_addrcvrs(&s, 1, CoilMode::W, Some(&cc), false).unwrap();
    assert_eq!(r.out.sz, vec![N, na]);
    assert_eq!(r.out.dims, Dims { t: 1, averages: 2, ..Default::default() });
    // Phased, weighted sum: sum(a_c^2)/norm(a) * base * exp(-i p0).
    let nrm = amps.iter().map(|a| a * a).sum::<f64>().sqrt();
    let want = base[5] * C::from_polar(nrm, -p0 * PI / 180.0);
    assert!((r.out.fids[5] - want).norm() < 1e-9 * want.norm());
    let h = op_addrcvrs(&s, 1, CoilMode::H, None, false).unwrap();
    assert!(h.out.flags.addedrcvrs);
    let (al, _) = op_alignrcvrs(&s, 1, CoilMode::W, None).unwrap();
    assert!((al.fids[0].im.atan2(al.fids[0].re)).abs() < 1e-9);
}

#[test]
fn snr_of_known_noise() {
    // A spectrum with a peak of height 1000 at 2.0 ppm and white noise of
    // standard deviation 1 in the real part of every point.
    let ppm = ppm_axis(N, SW, BO);
    let mut rng = Rng(9);
    let spec_v: Vec<C> = ppm
        .iter()
        .map(|&p| {
            let peak = 1000.0 / (1.0 + ((p - 2.0) / 0.1).powi(2));
            C::new(peak + rng.normal(), rng.normal())
        })
        .collect();
    let s = spectra(fid_from_spec(&spec_v), vec![N, 1], Dims { t: 1, ..Default::default() }, 1, 1);
    let r = op_get_snr(&s, 1.8, 2.2, -2.0, 0.0).unwrap();
    assert!((r.noise_sd - 1.0).abs() < 0.15, "noise sd {}", r.noise_sd);
    assert!((r.snr - 1000.0).abs() < 150.0, "SNR {}", r.snr);
}

#[test]
fn linewidth_of_known_lorentzian() {
    let t2 = 0.05;
    let s = spectra(fid(&[(4.65, 1.0, t2)]), vec![N, 1], Dims { t: 1, ..Default::default() }, 1, 1);
    let lw = op_get_lw(&s, 4.4, 5.0, 8.0).unwrap();
    let want = 1.0 / (PI * t2);
    assert!((lw - want).abs() < 0.05 * want, "linewidth {lw} vs {want}");
}

#[test]
fn autophase_ppmref_freqshift() {
    let s0 = spectra(fid(&[(3.0, 1.0, 0.1)]), vec![N, 1], Dims { t: 1, ..Default::default() }, 1, 1);
    let s = op_addphase(&s0, 40.0, 0.0, 4.65);
    let (p, ph) = op_autophase(&s, 2.8, 3.2, 0.0, None).unwrap();
    assert!((ph + 40.0).abs() < 1.0, "phase {ph}");
    let pz = op_zeropad(&p, 10.0);
    let sp = spec(&pz.fids);
    let kz = (0..sp.len()).max_by(|&a, &b| sp[a].norm().partial_cmp(&sp[b].norm()).unwrap()).unwrap();
    assert!(sp[kz].im.abs() < 0.02 * sp[kz].re);
    let s0s = spec(&s0.fids);
    let k = (0..N).max_by(|&a, &b| s0s[a].norm().partial_cmp(&s0s[b].norm()).unwrap()).unwrap();
    let (r, f) = op_ppmref(&s0, 2.8, 3.2, 3.027, None).unwrap();
    assert!(((f / (txfrq() / 1e6)) + 0.027).abs() < 0.005, "shift {f} Hz");
    let (_, f2) = op_ppmref(&r, 2.8, 3.2, 3.027, None).unwrap();
    assert!(f2.abs() < 0.2, "residual shift {f2}");
    let sh = op_freqshift(&s0, 5.0);
    let back = op_freqshift(&sh, -5.0);
    assert!(back.fids.iter().zip(&s0.fids).all(|(a, b)| (a - b).norm() < 1e-12));
    let ph1 = op_addphase(&s0, 0.0, 0.001, 3.0);
    assert!((spec(&ph1.fids)[k] - spec(&s0.fids)[k]).norm() < 0.05 * spec(&s0.fids)[k].norm());
}

#[test]
fn shape_ops() {
    let mut s = spectra(metab(), vec![N, 1], Dims { t: 1, ..Default::default() }, 1, 1);
    s.points_to_leftshift = 3.0;
    let l = op_leftshift(&s, 3).unwrap();
    assert_eq!(l.sz, vec![N - 3, 1]);
    assert_eq!(l.fids[0], s.fids[3]);
    assert_eq!(l.ppm.len(), N - 3);
    let z = op_zeropad(&s, 2.0);
    assert_eq!(z.sz, vec![2 * N, 1]);
    assert!(z.fids[N..].iter().all(|v| *v == C::new(0.0, 0.0)));
    assert!(z.flags.zeropadded);
    let f = op_filter(&s, 4.0);
    let t = 0.1;
    let k = (t * SW) as usize;
    assert!((f.fids[k] / s.fids[k] - C::new((-(k as f64 / SW) * PI * 4.0).exp(), 0.0)).norm() < 1e-12);
    let r = op_freqrange(&s, 1.0, 4.0).unwrap();
    assert!(r.ppm.iter().all(|&p| p > 1.0 && p < 4.0));
    assert!((r.spectralwidth - 3.0 * BO * 42.577).abs() < 2.0 * SW / N as f64);
    let tr = op_timerange(&s, 0.0, 0.1).unwrap();
    assert_eq!(tr.n(), (0.1 * SW).round() as usize);
    assert_eq!(op_amp_scale(&s, 2.0).fids[1], s.fids[1] * 2.0);
    assert_eq!(op_complex_conj(&s).fids[1], s.fids[1].conj());
}

#[test]
fn subspectra_and_four_steps() {
    let a = metab();
    let b: Vec<C> = a.iter().map(|v| -v * 0.5).collect();
    let mut fids = a.clone();
    fids.extend(b.iter());
    let s = spectra(fids, vec![N, 2], Dims { t: 1, sub_specs: 2, ..Default::default() }, 2, 2);
    let d = op_combinesubspecs(&s, CombineMode::Diff).unwrap();
    assert!((d.fids[4] - (a[4] + b[4]) / 2.0).norm() < 1e-12);
    let m = op_combinesubspecs(&s, CombineMode::Summ).unwrap();
    assert!((m.fids[4] - (b[4] - a[4]) / 2.0).norm() < 1e-12);
    let t = op_takesubspec(&s, &[1]).unwrap();
    assert_eq!(t.sz, vec![N, 1]);
    assert_eq!(t.fids[4], b[4]);
    let mut fids = Vec::new();
    for k in 0..4 {
        fids.extend(a.iter().map(|v| v * (k + 1) as f64));
    }
    let mut s4 = spectra(fids, vec![N, 4], Dims { t: 1, sub_specs: 2, ..Default::default() }, 4, 4);
    s4.flags.is_four_steps = true;
    let expect = [(3.0, 7.0), (1.0, 1.0), (4.0, 6.0), (2.0, 2.0)];
    for (mode, &(x, y)) in expect.iter().enumerate() {
        let o = op_four_step_combine(&s4, mode as u8).unwrap();
        assert_eq!(o.sz, vec![N, 2]);
        assert!((o.fids[4] - a[4] * x / 2.0).norm() < 1e-12, "mode {mode}");
        assert!((o.fids[N + 4] - a[4] * y / 2.0).norm() < 1e-12, "mode {mode}");
    }
}

#[test]
fn ecc_removes_phase_modulation() {
    let water = fid(&[(4.65, 10.0, 0.08)]);
    let metab_f = fid(&[(2.01, 1.0, 0.08)]);
    let ec: Vec<f64> = (0..N).map(|k| 0.8 * (-(k as f64) / 200.0).exp() + 0.3).collect();
    let apply = |f: &[C]| -> Vec<C> { f.iter().zip(&ec).map(|(v, p)| v * C::new(0.0, *p).exp()).collect() };
    let w = spectra(apply(&water), vec![N, 1], Dims { t: 1, ..Default::default() }, 1, 1);
    let m = spectra(apply(&metab_f), vec![N, 1], Dims { t: 1, ..Default::default() }, 1, 1);
    let (mo, wo) = op_ecc(&m, &w).unwrap();
    // The water FID becomes real and positive up to the phase of its first point.
    for k in 0..N {
        let z = wo.fids[k] * C::new(0.0, -ec[0]).exp();
        assert!(z.im.abs() < 1e-9 * z.norm().max(1e-300));
    }
    for k in 0..N {
        let want = metab_f[k] * C::new(0.0, ec[0]).exp();
        assert!((mo.fids[k] - want).norm() < 1e-9);
    }
}

#[test]
fn remove_water_keeps_metabolites() {
    let water = fid(&[(4.65, 50.0, 0.05), (4.72, 5.0, 0.03)]);
    let met = fid(&[(2.01, 1.0, 0.08), (3.03, 0.8, 0.08)]);
    let mut rng = Rng(11);
    let all: Vec<C> = water.iter().zip(&met).map(|(w, m)| w + m + C::new(rng.normal(), rng.normal()) * 1e-3).collect();
    let s = spectra(all, vec![N, 1], Dims { t: 1, ..Default::default() }, 1, 1);
    let r = op_remove_water(&s, [4.4, 5.0], 20, None).unwrap();
    let e = r.out.fids.iter().zip(&met).map(|(a, b)| (a - b).norm()).fold(0.0, f64::max);
    // FID-A takes the damping as (|z|-1)/dt rather than ln|z|/dt, so the water
    // model is close but not exact: 0.2 % of the water amplitude.
    assert!(e < 0.1, "water-removed FID differs from the metabolites by {e}");
    assert!(r.components.ppm.iter().all(|&p| p > 4.4 && p < 5.0));
    let h = op_hsvd_fit(&s, [1.5, 3.5], 20, None).unwrap();
    let e = h.model.fids.iter().zip(&met).map(|(a, b)| (a - b).norm()).fold(0.0, f64::max);
    assert!(e < 0.02, "HSVD model of the metabolites differs by {e}");
}

fn press_raw(drift: &[(f64, f64)], ncoils: usize, noise: f64) -> Spectra {
    let base = metab();
    let na = drift.len();
    let mut rng = Rng(21);
    let mut fids = Vec::with_capacity(N * ncoils * na);
    for &(hz, deg) in drift {
        let sh = shift(&base, hz, deg);
        for c in 0..ncoils {
            let g = C::from_polar(1.0 + c as f64 * 0.3, c as f64 * 0.7);
            fids.extend(sh.iter().map(|v| v * g + C::new(rng.normal(), rng.normal()) * noise));
        }
    }
    spectra(fids, vec![N, ncoils, na], Dims { t: 1, coils: 2, averages: 3, ..Default::default() }, na, 1)
}

#[test]
fn press_pipeline_corrects_drift_and_reports() {
    let na = 32;
    let drift: Vec<(f64, f64)> = (0..na).map(|k| (0.1 * k as f64, 2.0 * (k as f64 * 0.3).sin())).collect();
    let raw = press_raw(&drift, 4, 0.02);
    let mut msgs: Vec<(String, f32)> = Vec::new();
    let r = run_pressproc_auto(&raw, None, &PressOptions::default(), &mut |m, f| msgs.push((m.into(), f)), &|| false).unwrap();
    assert!(msgs.windows(2).all(|w| w[1].1 >= w[0].1), "progress must not go backwards");
    assert_eq!(msgs.last().unwrap().1, 1.0);
    let d = r.report.drift.as_ref().unwrap();
    // Corrections undo the drift up to a common offset.
    let off = d.freq[0] + drift[0].0;
    for k in 0..na {
        assert!((d.freq[k] + drift[k].0 - off).abs() < 0.05, "average {k}: {} vs {}", d.freq[k], -drift[k].0);
    }
    assert!((d.total_freq_drift - 3.1).abs() < 0.1);
    assert_eq!(r.out.sz, vec![N, 1]);
    assert!(r.report.snr.unwrap() > 10.0);
    let j = r.report.to_json();
    assert!(j["drift"]["freq"].as_array().unwrap().len() == na);
    // Creatine referenced to 3.027 ppm.
    let zp = op_zeropad(&r.out, 16.0);
    let sp = spec(&zp.fids);
    let k = (0..sp.len()).filter(|&i| zp.ppm[i] > 2.9 && zp.ppm[i] < 3.1).max_by(|&a, &b| sp[a].norm().partial_cmp(&sp[b].norm()).unwrap()).unwrap();
    assert!((zp.ppm[k] - 3.027).abs() < 0.01, "creatine at {}", zp.ppm[k]);
    // Every step can be switched off.
    let mut o = PressOptions::default();
    o.rm_bad_averages.enabled = false;
    o.drift.enabled = false;
    o.autophase = false;
    o.ppmref = false;
    let r2 = run_pressproc_auto(&raw, None, &o, &mut |_, _| {}, &|| false).unwrap();
    assert!(r2.report.drift.is_none() && r2.report.rm_bad_averages.is_none());
    assert_eq!(r2.report.freq_shift, 0.0);
}

#[test]
fn pipelines_can_be_cancelled() {
    let raw = press_raw(&vec![(0.0, 0.0); 8], 2, 0.01);
    let calls = std::cell::Cell::new(0);
    let cancel = || {
        calls.set(calls.get() + 1);
        calls.get() > 2
    };
    let e = run_pressproc_auto(&raw, None, &PressOptions::default(), &mut |_, _| {}, &cancel).unwrap_err();
    assert_eq!(e, CANCELLED);
}

#[test]
fn special_pipeline_runs_on_synthetic_data() {
    // SPECIAL: subspectrum 1 holds the full signal plus an unwanted one that
    // subspectrum 2 cancels (op_combinesubspecs 'diff' adds them).
    let met = metab();
    let unwanted = fid(&[(1.3, 2.0, 0.03)]);
    let na = 12;
    let nc = 2;
    let mut rng = Rng(31);
    let mut fids = Vec::new();
    for sub in 0..2 {
        for k in 0..na {
            let hz = 0.05 * k as f64;
            for c in 0..nc {
                let g = C::from_polar(1.0, 0.4 * c as f64);
                let sig: Vec<C> = if sub == 0 {
                    met.iter().zip(&unwanted).map(|(m, u)| m + u).collect()
                } else {
                    met.iter().zip(&unwanted).map(|(m, u)| m - u).collect()
                };
                fids.extend(shift(&sig, hz, 0.0).iter().map(|v| v * g + C::new(rng.normal(), rng.normal()) * 0.01));
            }
        }
    }
    let raw = spectra(fids, vec![N, nc, na, 2], Dims { t: 1, coils: 2, averages: 3, sub_specs: 4, extras: 0 }, na * 2, 2);
    let r = run_specialproc_auto(&raw, None, &SpecialOptions::default(), &mut |_, _| {}, &|| false).unwrap();
    assert_eq!(r.out.sz, vec![N, 1]);
    assert!(!r.report.warnings.is_empty(), "missing-water warning expected");
    assert!(r.report.drift.is_some());
    assert_eq!(r.report.isis_freq.len(), na);
}

fn special_raw(na: usize, nc: usize, shifts: &[(f64, f64)], water: bool) -> Spectra {
    let base = if water {
        fid(&[(4.65, 10.0, 0.05)])
    } else {
        fid(&[(2.01, 1.0, 0.08), (3.03, 0.8, 0.08), (3.21, 0.6, 0.08)])
    };
    let unwanted = fid(&[(1.3, 1.5, 0.03)]);
    let mut rng = Rng(if water { 41 } else { 37 });
    let mut fids = Vec::new();
    for sub in 0..2 {
        for k in 0..na {
            let (hz, deg) = shifts.get(k).copied().unwrap_or((0.0, 0.0));
            for c in 0..nc {
                let g = C::from_polar(1.0, 0.4 * c as f64);
                let sig: Vec<C> = if sub == 0 {
                    base.iter().zip(&unwanted).map(|(m, u)| m + u).collect()
                } else {
                    base.iter().zip(&unwanted).map(|(m, u)| m - u).collect()
                };
                fids.extend(shift(&sig, hz, deg).iter().map(|v| v * g + C::new(rng.normal(), rng.normal()) * 0.005));
            }
        }
    }
    if nc > 1 {
        spectra(fids, vec![N, nc, na, 2], Dims { t: 1, coils: 2, averages: 3, sub_specs: 4, extras: 0 }, na * 2, 2)
    } else {
        let mut s = spectra(fids, vec![N, na, 2], Dims { t: 1, coils: 0, averages: 2, sub_specs: 3, extras: 0 }, na * 2, 2);
        s.flags.addedrcvrs = true;
        s
    }
}

fn megapress_raw(na: usize, nc: usize, shifts: &[(f64, f64)]) -> Spectra {
    let off = fid(&[(2.01, 1.0, 0.08), (3.03, 0.8, 0.08), (3.21, 0.6, 0.08)]);
    let on = fid(&[(2.01, 0.2, 0.08), (3.01, 0.25, 0.06), (3.03, 0.8, 0.08), (3.21, 0.6, 0.08)]);
    let mut rng = Rng(53);
    let mut fids = Vec::new();
    for sub in 0..2 {
        let base = if sub == 0 { &off } else { &on };
        for k in 0..na {
            let (hz, deg) = shifts.get(k).copied().unwrap_or((0.0, 0.0));
            for c in 0..nc {
                let g = C::from_polar(1.0, 0.3 * c as f64);
                fids.extend(shift(base, hz, deg).iter().map(|v| v * g + C::new(rng.normal(), rng.normal()) * 0.005));
            }
        }
    }
    if nc > 1 {
        spectra(fids, vec![N, nc, na, 2], Dims { t: 1, coils: 2, averages: 3, sub_specs: 4, extras: 0 }, na * 2, 2)
    } else {
        let mut s = spectra(fids, vec![N, na, 2], Dims { t: 1, coils: 0, averages: 2, sub_specs: 3, extras: 0 }, na * 2, 2);
        s.flags.addedrcvrs = true;
        s
    }
}

fn water_raw(shifts: &[(f64, f64)], nc: usize) -> Spectra {
    let base = fid(&[(4.65, 10.0, 0.05)]);
    let mut rng = Rng(61);
    let mut fids = Vec::new();
    for &(hz, deg) in shifts {
        for c in 0..nc {
            let g = C::from_polar(1.0, 0.3 * c as f64);
            fids.extend(shift(&base, hz, deg).iter().map(|v| v * g + C::new(rng.normal(), rng.normal()) * 0.002));
        }
    }
    if nc > 1 {
        spectra(fids, vec![N, nc, shifts.len()], Dims { t: 1, coils: 2, averages: 3, sub_specs: 0, extras: 0 }, shifts.len(), 1)
    } else {
        let mut s = spectra(fids, vec![N, shifts.len()], Dims { t: 1, coils: 0, averages: 2, sub_specs: 0, extras: 0 }, shifts.len(), 1);
        s.flags.addedrcvrs = true;
        s
    }
}

#[test]
fn low_average_scans_succeed_across_all_pipelines_and_align_multi_average_water() {
    // 1- and 2-average PRESS (multicoil and single-coil with explicit singleton average axis).
    let raw2 = press_raw(&[(0.0, 0.0), (0.2, 1.0)], 4, 0.01);
    let r2 = run_pressproc_auto(&raw2, None, &PressOptions::default(), &mut |_, _| {}, &|| false).unwrap();
    assert_eq!(r2.out.sz, vec![N, 1]);
    assert!(r2.report.warnings.iter().any(|w| w.contains("at least 3 averages")), "{:?}", r2.report.warnings);
    assert_eq!(r2.report.rm_bad_averages.as_ref().unwrap().averages_after, 2);

    let combined2 = fida::ops::coils::op_addrcvrs(&raw2, 1, fida::ops::coils::CoilMode::W, None, false).unwrap().out;
    assert!(op_rmbadaverages(&combined2, 4.0, Domain::Time).is_err());
    assert!(op_rmworstaverage(&combined2).is_err());

    let raw1_mc = press_raw(&[(0.0, 0.0)], 4, 0.005);
    let water_drifted = water_raw(&[(0.0, 0.0), (6.0, 40.0), (-5.0, -35.0), (4.0, 25.0)], 4);
    let r1_mc = run_pressproc_auto(&raw1_mc, Some(&water_drifted), &PressOptions::default(), &mut |_, _| {}, &|| false).unwrap();
    assert_eq!(r1_mc.out.sz, vec![N, 1]);
    assert!(r1_mc.out.flags.averaged && r1_mc.out.dims.averages == 0);
    // Multi-average water reference must still be aligned when metabolite has 1 average.
    let w_aligned_peak = spec(&r1_mc.outw.as_ref().unwrap().fids).iter().map(|z| z.norm()).fold(0.0, f64::max);
    let w_noproc_peak = spec(&r1_mc.outw_noproc.as_ref().unwrap().fids).iter().map(|z| z.norm()).fold(0.0, f64::max);
    assert!(w_aligned_peak > w_noproc_peak * 1.15, "water peak should sharpen after alignment: {w_aligned_peak} vs {w_noproc_peak}");

    // Single-coil PRESS with explicit singleton average axis (dims.averages == 2, size == 1).
    let raw1_sc = averaged(&metab(), &[(0.0, 0.0)], 0.005, 71);
    let r1_sc = run_pressproc_auto(&raw1_sc, None, &PressOptions::default(), &mut |_, _| {}, &|| false).unwrap();
    assert_eq!(r1_sc.out.sz, vec![N, 1]);
    assert!(r1_sc.out.flags.averaged && r1_sc.out.dims.averages == 0);

    // 1- and 2-average SPECIAL (multicoil and single-coil), plus multi-average water alignment.
    for (na, nc) in [(1, 2), (1, 1), (2, 2)] {
        let m = special_raw(na, nc, &[(0.0, 0.0), (0.5, 5.0)], false);
        let w = special_raw(4, nc, &[(0.0, 0.0), (6.0, 40.0), (-5.0, -35.0), (4.0, 25.0)], true);
        let rs = run_specialproc_auto(&m, Some(&w), &SpecialOptions::default(), &mut |_, _| {}, &|| false).unwrap();
        assert_eq!(rs.out.sz, vec![N, 1]);
        assert!(rs.out.flags.averaged && rs.out.dims.averages == 0);
        if na == 1 {
            let aligned = spec(&rs.outw.as_ref().unwrap().fids).iter().map(|z| z.norm()).fold(0.0, f64::max);
            let noproc = spec(&rs.outw_noproc.as_ref().unwrap().fids).iter().map(|z| z.norm()).fold(0.0, f64::max);
            assert!(aligned > noproc * 1.15, "SPECIAL water peak should sharpen: {aligned} vs {noproc}");
        }
    }

    // 1- and 2-average MEGA-PRESS (multicoil and single-coil), plus multi-average water alignment.
    for (na, nc) in [(1, 2), (1, 1), (2, 2)] {
        let m = megapress_raw(na, nc, &[(0.0, 0.0), (0.5, 5.0)]);
        let w = water_raw(&[(0.0, 0.0), (6.0, 40.0), (-5.0, -35.0), (4.0, 25.0)], nc);
        let rm = run_megapressproc_auto(&m, Some(&w), &MegaOptions::default(), &mut |_, _| {}, &|| false).unwrap();
        assert_eq!(rm.diff.sz, vec![N, 1]);
        assert!(rm.diff.flags.averaged && rm.diff.dims.averages == 0);
        if na == 1 {
            let w_out = rm.outw.as_ref().unwrap();
            let aligned = spec(&w_out.fids).iter().map(|z| z.norm()).fold(0.0, f64::max);
            let w_cc = fida::ops::coils::op_addrcvrs(&w, 1, fida::ops::coils::CoilMode::W, None, false).unwrap().out;
            let unaligned = spec(&op_averaging(&w_cc).fids).iter().map(|z| z.norm()).fold(0.0, f64::max);
            assert!(aligned > unaligned * 1.15, "MEGA-PRESS water peak should sharpen: {aligned} vs {unaligned}");
        }
    }

    // Multi-index op_takeaverages remaps dims when squeeze drops a singleton coil axis.
    let s_singleton_coil = spectra(
        vec![C::new(1.0, 0.0); 16 * 1 * 3 * 2],
        vec![16, 1, 3, 2],
        Dims { t: 1, coils: 2, averages: 3, sub_specs: 4, extras: 0 },
        6,
        2,
    );
    let took = op_takeaverages(&s_singleton_coil, &[0, 1]).unwrap();
    assert_eq!(took.sz, vec![16, 2, 2]);
    assert_eq!(took.dims, Dims { t: 1, coils: 0, averages: 2, sub_specs: 3, extras: 0 });
}
