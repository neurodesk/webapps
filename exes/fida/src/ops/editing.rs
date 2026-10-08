//! MEGA-PRESS edit-ON/OFF handling for readers that cannot tell (GE P-files,
//! Philips SDAT). Not FID-A: FID-A's readers split alternate transients into
//! two subspectra when told to, and its pipeline assumes the Siemens layout
//! (edit-OFF first, the two subspectra stored phase-inverted, so that FID-A's
//! `'diff'`, a sum, gives ON minus OFF). Here the data decide, as Osprey's
//! `osp_onOffClassifyMEGA` does for GABA editing: the 1.9 ppm editing pulse
//! nearly erases the NAA singlet at 2.01 ppm in edit-ON, so the subspectrum
//! with the larger NAA peak is edit-OFF. Creatine, which editing leaves alone,
//! tells whether the two are stored inverted.

use crate::ops::averaging::op_averaging;
use crate::ops::coils::{op_addrcvrs, op_getcoilcombos, CoilMode};
use crate::ops::subspecs::op_takesubspec;
use crate::spectra::spec_of;
use crate::Spectra;
use num_complex::Complex64;

/// What the data say about editing.
#[derive(Clone, Debug, PartialEq)]
pub struct EditCheck {
    /// NAA/Cr of the larger over the smaller subspectrum; about 1 when unedited.
    pub contrast: f64,
    /// The first subspectrum is edit-OFF.
    pub off_first: bool,
    /// The two subspectra are stored phase-inverted (creatine anti-correlated).
    pub inverted: bool,
}

impl EditCheck {
    /// NAA/Cr differing by half between the subspectra marks GABA editing
    /// (measured 2.5-14 on edited data, within 1 % of 1 on unedited data).
    pub fn edited(&self) -> bool {
        self.contrast > 1.5
    }
}

/// FID-A's `fids(:,:,1) = data(:,1:2:end)`, `fids(:,:,2) = data(:,2:2:end)`:
/// alternate transients into two subspectra, a new last dimension. `averages`
/// stays the number of transients, as FID-A's GE and SDAT readers count it.
pub fn split_alternate(input: &Spectra) -> Result<Spectra, String> {
    let a = input.dims.averages;
    if a == 0 || a != input.sz.len() || input.dims.sub_specs != 0 {
        return Err("Only data with transients in their last dimension and no subspectra can be split into edit-ON and edit-OFF.".into());
    }
    let na = input.size(a);
    if na < 2 || na % 2 != 0 {
        return Err(format!("These data have {na} transients, which do not split into edit-ON and edit-OFF pairs."));
    }
    let block = input.fids.len() / na;
    let mut fids = Vec::with_capacity(input.fids.len());
    for s in 0..2 {
        for k in (s..na).step_by(2) {
            fids.extend_from_slice(&input.fids[k * block..(k + 1) * block]);
        }
    }
    let mut out = input.clone();
    out.fids = fids;
    out.sz[a - 1] = na / 2;
    out.sz.push(2);
    out.dims.sub_specs = out.sz.len();
    out.subspecs = 2;
    out.raw_subspecs = 2;
    Ok(out)
}

/// Coil-combined, averaged spectra of the two subspectra of `input`.
fn subspectra(input: &Spectra, water: Option<&Spectra>) -> Result<[Vec<Complex64>; 2], String> {
    let combined = if input.dims.coils > 0 {
        // Coil phases from the water, else from edit-OFF/ON 1 alone (summing
        // inverted subspectra would cancel the signal the phases come from).
        let reference = match water {
            Some(w) => op_averaging(w),
            None => op_averaging(&op_takesubspec(input, &[0])?),
        };
        let combos = op_getcoilcombos(&reference, 1, CoilMode::W)?;
        op_addrcvrs(input, 1, CoilMode::W, Some(&combos), false)?.out
    } else {
        input.clone()
    };
    let av = op_averaging(&combined);
    Ok([spec_of(op_takesubspec(&av, &[0])?.fid(0)), spec_of(op_takesubspec(&av, &[1])?.fid(0))])
}

/// Classify the two subspectra of `input` (from `split_alternate` or a
/// reader's subspectra).
pub fn classify_mega(input: &Spectra, water: Option<&Spectra>) -> Result<EditCheck, String> {
    if input.dims.sub_specs == 0 || input.size(input.dims.sub_specs) != 2 {
        return Err("Edit-ON/OFF classification needs two subspectra.".into());
    }
    let [s1, s2] = subspectra(input, water)?;
    let ppm = &input.ppm;
    let band = |lo: f64, hi: f64| (0..ppm.len()).filter(move |&i| ppm[i] > lo && ppm[i] < hi);
    let peak = |s: &[Complex64], lo, hi| band(lo, hi).map(|i| s[i].norm()).fold(0.0, f64::max);
    let ratio = |s: &[Complex64]| peak(s, 1.9, 2.1) / peak(s, 2.9, 3.1);
    let (r1, r2) = (ratio(&s1), ratio(&s2));
    if !(r1.is_finite() && r2.is_finite() && r1 > 0.0 && r2 > 0.0) {
        return Err("No NAA and creatine peaks to classify edit-ON and edit-OFF by.".into());
    }
    let cr: f64 = band(2.9, 3.15).map(|i| (s1[i] * s2[i].conj()).re).sum();
    Ok(EditCheck { contrast: r1.max(r2) / r1.min(r2), off_first: r1 >= r2, inverted: cr < 0.0 })
}

fn scale_subspec(s: &mut Spectra, index: usize, factor: f64) {
    let per = s.fids.len() / 2;
    for v in &mut s.fids[index * per..(index + 1) * per] {
        *v *= factor;
    }
}

fn swap_subspecs(s: &mut Spectra) {
    let per = s.fids.len() / 2;
    let (a, b) = s.fids.split_at_mut(per);
    a.swap_with_slice(b);
}

/// Bring `input` to the Siemens layout FID-A's `run_megapressproc_auto`
/// assumes: edit-OFF first, the subspectra stored inverted.
pub fn to_fida_layout(input: &Spectra, check: &EditCheck) -> Spectra {
    let mut out = input.clone();
    if !check.off_first {
        swap_subspecs(&mut out);
    }
    if !check.inverted {
        scale_subspec(&mut out, 0, -1.0);
    }
    out
}

/// Drop empty transients (Philips stores a short water reference in a block
/// padded with zero rows, which FID-A's VAX decoding reads as 2^-129, not 0);
/// averaging them in would scale the signal down by the padding. A transient
/// is empty when its largest value is below 1e-12 of the largest overall.
/// Returns the data unchanged when none are empty.
pub fn drop_empty_transients(input: &Spectra) -> Spectra {
    let a = input.dims.averages;
    if a == 0 || a != input.sz.len() {
        return input.clone();
    }
    let na = input.size(a);
    let block = input.fids.len() / na;
    let peak = |k: usize| input.fids[k * block..(k + 1) * block].iter().map(|v| v.norm()).fold(0.0, f64::max);
    let largest = (0..na).map(peak).fold(0.0, f64::max);
    let keep: Vec<usize> = (0..na).filter(|&k| peak(k) > 1e-12 * largest).collect();
    if keep.len() == na || keep.is_empty() {
        return input.clone();
    }
    let mut out = input.clone();
    out.fids = keep.iter().flat_map(|&k| input.fids[k * block..(k + 1) * block].iter().copied()).collect();
    out.sz[a - 1] = keep.len();
    if keep.len() == 1 {
        out.dims.averages = 0;
        out.flags.averaged = true;
    }
    out.squeeze_sz();
    out.averages = keep.len();
    out.raw_averages = keep.len();
    out
}
