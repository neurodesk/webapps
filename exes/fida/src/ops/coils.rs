//! Receiver combination: op_getcoilcombos, op_addrcvrs, op_alignrcvrs,
//! op_combineRcvrs.

use num_complex::Complex64 as C;
use std::f64::consts::PI;

use super::averaging::op_averaging;
use super::linalg::{lstsq, CMat};
use super::subspecs::{op_combinesubspecs, op_four_step_combine, CombineMode};
use super::util::{phase1, squeeze_axis, std_c, strides, sum_axis, with_axis};
use crate::spectra::Spectra;

/// Coil weighting mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoilMode {
    /// `'w'`: weight by the signal amplitude at `point`.
    W,
    /// `'h'`: weight by signal / noise variance (Hall et al.).
    H,
    /// `'gls'`: generalised least squares with the noise covariance.
    Gls,
}

/// FID-A `coilcombos`: phase per coil (degrees), amplitude weight `sig`
/// (complex in `Gls` mode, real otherwise) and, after op_addrcvrs in `Gls`
/// mode, the GLS weights `w`.
#[derive(Clone, Debug, Default)]
pub struct CoilCombos {
    pub ph: Vec<f64>,
    pub sig: Vec<C>,
    pub w: Vec<C>,
}

/// Linear index of FID-A's `fids(point, n, 1, 1)`: point `p` (0-based) of
/// coil `n`, first entry of every later dimension.
fn at_coil(s: &Spectra, p: usize, n: usize) -> usize {
    let (inner, _, _) = strides(&s.sz, s.dims.coils - 1);
    p + inner * n
}

fn coil_tail_std(s: &Spectra, n: usize) -> f64 {
    let nt = s.n();
    let start = nt.saturating_sub(101);
    let v: Vec<C> = (start..nt).map(|i| s.fids[at_coil(s, i, n)]).collect();
    std_c(&v)
}

/// op_getcoilcombos: coil phases and weights from `point` (1-based).
pub fn op_getcoilcombos(input: &Spectra, point: usize, mode: CoilMode) -> Result<CoilCombos, String> {
    if input.flags.addedrcvrs || input.dims.coils == 0 {
        return Ok(CoilCombos { ph: vec![0.0], sig: vec![C::new(1.0, 0.0)], w: Vec::new() });
    }
    if point == 0 || point > input.n() {
        return Err(format!("Coil-combination point {point} is outside the FID."));
    }
    let p = point - 1;
    let nc = input.size(input.dims.coils);
    let mut cc = CoilCombos { ph: vec![0.0; nc], sig: vec![C::new(0.0, 0.0); nc], w: Vec::new() };
    match mode {
        CoilMode::Gls => {
            // mean(fids, dims.averages)(point, :).' : every coil (and any later dimension).
            let avg = if input.dims.averages > 0 {
                let a = input.dims.averages;
                let na = input.size(a) as f64;
                let f: Vec<C> = sum_axis(&input.fids, &input.sz, a - 1).into_iter().map(|v| v / na).collect();
                (f, with_axis(&input.sz, a - 1, 1))
            } else {
                (input.fids.clone(), input.sz.clone())
            };
            let nt = input.n();
            cc.sig = (0..avg.0.len() / nt).map(|k| avg.0[p + nt * k]).collect();
            cc.ph = vec![0.0; cc.sig.len()];
        }
        _ => {
            for n in 0..nc {
                let z = input.fids[at_coil(input, p, n)];
                cc.ph[n] = phase1(z) * 180.0 / PI;
                cc.sig[n] = match mode {
                    CoilMode::W => C::new(z.norm(), 0.0),
                    _ => {
                        let s = z.norm();
                        let nn = coil_tail_std(input, n);
                        C::new(s / (nn * nn), 0.0)
                    }
                };
            }
            let mx = cc.sig.iter().map(|z| z.re).fold(f64::NEG_INFINITY, f64::max);
            for v in cc.sig.iter_mut() {
                *v /= mx;
            }
        }
    }
    Ok(cc)
}

/// Output of op_addrcvrs.
#[derive(Clone, Debug)]
pub struct AddRcvrs {
    pub out: Spectra,
    /// The coilcombos actually applied (sig normalised to unit norm).
    pub coilcombos: CoilCombos,
    /// `fids_presum`: phased, unweighted FIDs before summation (only when requested).
    pub fids_presum: Option<Vec<C>>,
}

/// op_addrcvrs: phase, weight and sum the receiver channels. With
/// `coilcombos` `None`, phases and weights come from the average of the data
/// themselves at `point` (1-based), as FID-A's three-argument form.
/// `keep_presum` also returns FID-A's `fids_presum` (a full copy of the data).
pub fn op_addrcvrs(input: &Spectra, point: usize, mode: CoilMode, coilcombos: Option<&CoilCombos>, keep_presum: bool) -> Result<AddRcvrs, String> {
    if input.flags.addedrcvrs || input.dims.coils == 0 {
        let mut out = input.clone();
        out.flags.addedrcvrs = true;
        return Ok(AddRcvrs {
            coilcombos: CoilCombos { ph: vec![0.0], sig: vec![C::new(1.0, 0.0)], w: vec![C::new(1.0, 0.0)] },
            fids_presum: keep_presum.then(|| input.fids.clone()),
            out,
        });
    }
    let nc = input.size(input.dims.coils);
    let mut w_gls: Vec<C> = Vec::new();
    let (phs, mut sigs): (Vec<f64>, Vec<C>) = match coilcombos {
        Some(cc) => {
            if cc.ph.len() < nc || cc.sig.len() < nc {
                return Err(format!("The coil combination has {} coils; the data have {nc}.", cc.ph.len()));
            }
            if mode == CoilMode::Gls {
                w_gls = gls_weights(input, &cc.sig[..nc])?;
            }
            (cc.ph[..nc].to_vec(), cc.sig[..nc].to_vec())
        }
        None => {
            if point == 0 || point > input.n() {
                return Err(format!("Coil-combination point {point} is outside the FID."));
            }
            let mut av = if !input.flags.averaged { op_averaging(input) } else { input.clone() };
            if input.flags.is_four_steps {
                av = op_four_step_combine(&av, 0)?;
            }
            if input.dims.sub_specs > 0 {
                av = op_combinesubspecs(&av, CombineMode::Summ)?;
            }
            let p = point - 1;
            let mut phs = vec![0.0; nc];
            let mut sigs = vec![C::new(0.0, 0.0); nc];
            let nt = av.n();
            for n in 0..nc {
                let z = av.fids[at_coil(&av, p, n)];
                phs[n] = phase1(z) * 180.0 / PI;
                sigs[n] = match mode {
                    CoilMode::W => C::new(z.norm(), 0.0),
                    CoilMode::H => {
                        let s = (0..nt).map(|i| av.fids[at_coil(&av, i, n)].norm()).fold(f64::NEG_INFINITY, f64::max);
                        let nn = coil_tail_std(&av, n);
                        C::new(s / (nn * nn), 0.0)
                    }
                    CoilMode::Gls => C::new(0.0, 0.0),
                };
            }
            (phs, sigs)
        }
    };
    if mode != CoilMode::Gls {
        let nrm = sigs.iter().map(|z| z.norm_sqr()).sum::<f64>().sqrt();
        for v in sigs.iter_mut() {
            *v /= nrm;
        }
    }
    let c = input.dims.coils;
    let (inner, len, outer) = strides(&input.sz, c - 1);
    let mut presum = if keep_presum { Some(Vec::with_capacity(input.fids.len())) } else { None };
    let factors: Vec<(C, C)> = (0..len)
        .map(|n| match mode {
            CoilMode::Gls => (C::new(1.0, 0.0), w_gls.get(n).copied().unwrap_or(C::new(0.0, 0.0))),
            _ => (C::new(0.0, -phs[n] * PI / 180.0).exp(), sigs[n]),
        })
        .collect();
    let mut fids = vec![C::new(0.0, 0.0); inner * outer];
    for o in 0..outer {
        for n in 0..len {
            let (rot, wt) = factors[n];
            let src = &input.fids[inner * (n + len * o)..inner * (n + 1 + len * o)];
            let dst = &mut fids[inner * o..inner * (o + 1)];
            for (d, s) in dst.iter_mut().zip(src) {
                let ph = s * rot;
                if let Some(p) = presum.as_mut() {
                    p.push(ph);
                }
                *d += ph * wt;
            }
        }
    }
    // fids_presum was pushed in (o, n, i) order, which is column-major order.
    let mut out = input.clone();
    out.fids = fids;
    let (sz, dims) = squeeze_axis(&input.sz, input.dims, c);
    out.sz = sz;
    out.dims = dims;
    if input.dims.averages > 0 && out.dims.averages == 0 {
        out.averages = 1;
        out.flags.averaged = true;
    }
    out.flags.writtentostruct = true;
    out.flags.addedrcvrs = true;
    let wgts = if mode == CoilMode::Gls { w_gls } else { vec![C::new(0.0, 0.0); nc] };
    Ok(AddRcvrs { out, coilcombos: CoilCombos { ph: phs, sig: sigs, w: wgts }, fids_presum: presum })
}

/// GLS weights `w = ((sig'*(Psi\sig))^-1 * sig'/Psi).'` with the noise
/// covariance `Psi = e*e'` of the last quarter of every FID, taken, as FID-A
/// does, from `reshape(fids, [ncoils, numel/ncoils])` (a plain column-major
/// reshape, so a "column" is `ncoils` consecutive samples).
fn gls_weights(input: &Spectra, sig: &[C]) -> Result<Vec<C>, String> {
    let nc = sig.len();
    let nt = input.n();
    let first = ((0.75 * nt as f64).ceil() as usize).max(1) - 1;
    let cols = input.fids.len() / nc;
    let mut psi = CMat::zeros(nc, nc);
    for col in 0..cols {
        if col % nt < first {
            continue;
        }
        let e = &input.fids[col * nc..(col + 1) * nc];
        for j in 0..nc {
            let ej = e[j].conj();
            for i in 0..nc {
                psi[(i, j)] += e[i] * ej;
            }
        }
    }
    let s = CMat::from_col(sig);
    // Psi \ sig and sig' / Psi = (Psi' \ sig)'.
    let a = lstsq(&psi, &s);
    let denom: C = sig.iter().zip(a.col_slice(0)).map(|(x, y)| x.conj() * y).sum();
    let b = lstsq(&psi.h(), &s);
    // Row w = (sig'/Psi) / denom = conj(b)^T / denom; FID-A then takes .' (no conjugate).
    Ok(b.col_slice(0).iter().map(|v| v.conj() / denom).collect())
}

/// op_alignrcvrs: phase the receivers without summing them. Returns the
/// phased data and the coilcombos used.
pub fn op_alignrcvrs(input: &Spectra, point: usize, mode: CoilMode, coilcombos: Option<&CoilCombos>) -> Result<(Spectra, CoilCombos), String> {
    if input.flags.addedrcvrs {
        return Err("The receivers have already been combined.".into());
    }
    if input.dims.coils != 2 {
        return Err("op_alignrcvrs expects the coils in the second dimension.".into());
    }
    let nc = input.size(2);
    let cc = match coilcombos {
        Some(cc) => {
            if cc.ph.len() < nc {
                return Err("The coil combination has fewer coils than the data.".into());
            }
            CoilCombos { ph: cc.ph[..nc].to_vec(), sig: cc.sig[..nc].to_vec(), w: Vec::new() }
        }
        None => {
            if point == 0 || point > input.n() {
                return Err(format!("Coil-combination point {point} is outside the FID."));
            }
            let mut av = if input.dims.averages > 0 { op_averaging(input) } else { input.clone() };
            if input.flags.is_four_steps {
                av = op_four_step_combine(&av, 0)?;
            }
            if input.dims.sub_specs > 0 {
                av = op_combinesubspecs(&av, CombineMode::Summ)?;
            }
            let p = point - 1;
            let mut cc = CoilCombos { ph: vec![0.0; nc], sig: vec![C::new(0.0, 0.0); nc], w: Vec::new() };
            for n in 0..nc {
                let z = av.fids[at_coil(&av, p, n)];
                cc.ph[n] = phase1(z) * 180.0 / PI;
                cc.sig[n] = match mode {
                    CoilMode::H => {
                        let nn = coil_tail_std(&av, n);
                        C::new(z.norm() / (nn * nn), 0.0)
                    }
                    _ => C::new(z.norm(), 0.0),
                };
            }
            cc
        }
    };
    let (inner, len, outer) = strides(&input.sz, 1);
    let mut out = input.clone();
    for o in 0..outer {
        for n in 0..len {
            let rot = C::new(0.0, -cc.ph[n] * PI / 180.0).exp();
            for v in out.fids[inner * (n + len * o)..inner * (n + 1 + len * o)].iter_mut() {
                *v *= rot;
            }
        }
    }
    Ok((out, cc))
}

/// Output of op_combineRcvrs.
#[derive(Clone, Debug)]
pub struct CombineRcvrs {
    pub out: Spectra,
    pub outw: Spectra,
    pub out_presum: Spectra,
    pub outw_presum: Spectra,
    pub weights: CoilCombos,
}

/// op_combineRcvrs: `'h'` weights and phases from point 2 of the water
/// reference, applied to both the metabolite and water data.
pub fn op_combine_rcvrs(input: &Spectra, inw: &Spectra) -> Result<CombineRcvrs, String> {
    let weights = op_getcoilcombos(inw, 2, CoilMode::H)?;
    let (out_presum, _) = op_alignrcvrs(input, 2, CoilMode::H, Some(&weights))?;
    let (outw_presum, _) = op_alignrcvrs(inw, 2, CoilMode::H, Some(&weights))?;
    let out = op_addrcvrs(input, 2, CoilMode::H, Some(&weights), false)?.out;
    let outw = op_addrcvrs(inw, 2, CoilMode::H, Some(&weights), false)?.out;
    Ok(CombineRcvrs { out, outw, out_presum, outw_presum, weights })
}
