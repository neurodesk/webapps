//! Bloch signal model + MP2RAGE/SA2RAGE lookup tables.
//! Direct port of `mp2rage_t1/model.py` (the "normal", nimages=2 branch).

use crate::interp::{arange, argmax, argmin, interp_decreasing, np_interp_vec};

/// MP2RAGE sequence parameters (mirrors the Python `MP` dict).
#[derive(Clone, Debug)]
pub struct Mp2rageParams {
    pub tr: f64,
    pub tis: (f64, f64),
    pub flip: (f64, f64),
    pub nz: (f64, f64),
    pub flash_tr: f64,
    pub inv_eff: f64,
}

/// SA2RAGE sequence parameters (mirrors the Python `SA` dict).
#[derive(Clone, Debug)]
pub struct Sa2rageParams {
    pub tr: f64,
    pub tis: (f64, f64),
    pub flip: (f64, f64),
    pub nz: (f64, f64),
    pub flash_tr: f64,
    pub average_t1: f64,
}

/// Steady-state MP2RAGE signal of the two GRE readout blocks (`MPRAGEfunc`).
/// `nz = (n_before_centre, n_after_centre)`; returns `(S1, S2)` per T1.
pub fn mprage_signal(
    mp2rage_tr: f64,
    ti: (f64, f64),
    nz: (f64, f64),
    flash_tr: f64,
    flip_deg: (f64, f64),
    t1s: &[f64],
    inv_eff: f64,
) -> (Vec<f64>, Vec<f64>) {
    let a1 = flip_deg.0.to_radians();
    let a2 = flip_deg.1.to_radians();
    let (nz_bef, nz_aft) = (nz.0, nz.1);
    let nztot = nz_bef + nz_aft;
    let m0 = 1.0;

    let ta_bef = nz_bef * flash_tr;
    let ta_aft = nz_aft * flash_tr;
    let ta = nztot * flash_tr;
    let td1 = ti.0 - ta_bef;
    let td2 = ti.1 - ti.0 - ta;
    let td3 = mp2rage_tr - ti.1 - ta_aft;

    let cos_a1 = a1.cos();
    let cos_a2 = a2.cos();
    let s1a = a1.sin();
    let s2a = a2.sin();

    let mut out1 = Vec::with_capacity(t1s.len());
    let mut out2 = Vec::with_capacity(t1s.len());

    for &t1 in t1s {
        let e1 = (-flash_tr / t1).exp();
        let e_td1 = (-td1 / t1).exp();
        let e_td2 = (-td2 / t1).exp();
        let e_td3 = (-td3 / t1).exp();

        let c1 = cos_a1 * e1;
        let c2 = cos_a2 * e1;

        let denom = 1.0 + inv_eff * (c1 * c2).powf(nztot) * (e_td1 * e_td2 * e_td3);

        let mut num = m0 * (1.0 - e_td1);
        num = num * c1.powf(nztot) + m0 * (1.0 - e1) * (1.0 - c1.powf(nztot)) / (1.0 - c1);
        num = num * e_td2 + m0 * (1.0 - e_td2);
        num = num * c2.powf(nztot) + m0 * (1.0 - e1) * (1.0 - c2.powf(nztot)) / (1.0 - c2);
        num = num * e_td3 + m0 * (1.0 - e_td3);

        let mzss = num / denom;

        let mut temp = (-inv_eff * mzss * e_td1 + m0 * (1.0 - e_td1)) * c1.powf(nz_bef)
            + m0 * (1.0 - e1) * (1.0 - c1.powf(nz_bef)) / (1.0 - c1);
        out1.push(s1a * temp);

        temp = temp * c1.powf(nz_aft) + m0 * (1.0 - e1) * (1.0 - c1.powf(nz_aft)) / (1.0 - c1);
        temp = (temp * e_td2 + m0 * (1.0 - e_td2)) * c2.powf(nz_bef)
            + m0 * (1.0 - e1) * (1.0 - c2.powf(nz_bef)) / (1.0 - c2);
        out2.push(s2a * temp);
    }
    (out1, out2)
}

/// MP2RAGE UNI lookup — monotonic branch, endpoints padded to +/-0.5.
/// Returns `(intensity, t1vector)` (decreasing intensity).
pub fn mp2rage_lookuptable(
    tr: f64,
    tis: (f64, f64),
    flip: (f64, f64),
    nz: (f64, f64),
    flash_tr: f64,
    inv_eff: f64,
) -> (Vec<f64>, Vec<f64>) {
    let t1vec = arange(0.05, 5.0 + 1e-9, 0.05);
    let (s1, s2) = mprage_signal(tr, tis, nz, flash_tr, flip, &t1vec, inv_eff);
    let intensity: Vec<f64> = (0..t1vec.len())
        .map(|i| (s1[i] * s2[i]) / (s1[i] * s1[i] + s2[i] * s2[i]))
        .collect();
    let minindex = argmax(&intensity);
    let maxindex = argmin(&intensity);
    let mut i_branch = intensity[minindex..=maxindex].to_vec();
    let t_branch = t1vec[minindex..=maxindex].to_vec();
    let n = i_branch.len();
    i_branch[0] = 0.5;
    i_branch[n - 1] = -0.5;
    (i_branch, t_branch)
}

/// SA2RAGE ratio lookup — returns `(B1vector, intensity=S1/S2)`.
pub fn sa2rage_lookuptable(
    tr: f64,
    tis: (f64, f64),
    flip: (f64, f64),
    nz: (f64, f64),
    flash_tr: f64,
    average_t1: f64,
) -> (Vec<f64>, Vec<f64>) {
    let b1vector = arange(0.005, 2.5 + 1e-9, 0.005);
    let mut intensity = Vec::with_capacity(b1vector.len());
    for &b1 in &b1vector {
        let sat_eff = -(b1 * std::f64::consts::PI / 2.0).cos();
        let flip_b1 = (b1 * flip.0, b1 * flip.1);
        let (s1, s2) = mprage_signal(tr, tis, nz, flash_tr, flip_b1, &[average_t1], sat_eff);
        intensity.push(s1[0] / s2[0]);
    }
    (b1vector, intensity)
}

/// Uncorrected T1 [s] from a UNI image (port of `t1_from_uni`).
/// `uni` is flattened; the caller reshapes. NaNs (out of range) become 0.
pub fn t1_from_uni(uni: &[f64], p: &Mp2rageParams) -> Vec<f64> {
    let (i_branch, t_branch) = mp2rage_lookuptable(p.tr, p.tis, p.flip, p.nz, p.flash_tr, p.inv_eff);
    let maxabs = uni.iter().fold(0.0f64, |m, &v| m.max(v.abs()));
    let scaled: Vec<f64> = if maxabs > 1.0 {
        uni.iter().map(|&v| -0.5 + v / 4095.0).collect()
    } else {
        uni.to_vec()
    };
    let mut t1 = interp_decreasing(&i_branch, &t_branch, &scaled, f64::NAN, f64::NAN);
    for v in t1.iter_mut() {
        if v.is_nan() {
            *v = 0.0;
        }
    }
    t1
}

/// `np.interp(query, xp, fp)` re-exported for callers that need the ascending form.
pub fn interp_ascending(query: &[f64], xp: &[f64], fp: &[f64]) -> Vec<f64> {
    np_interp_vec(query, xp, fp, f64::NAN, f64::NAN)
}
