//! Philips SDAT/SPAR: FID-A `io_loadspec_sdat` with Gannet's `philipsLoad`
//! (SPAR text header, SDAT VAX single-precision complex samples).

use super::common::{fresh_flags, octave_range, str2double, time_axis, NdArray, Res};
use crate::spectra::{Dims, Spectra};
use num_complex::Complex64;
use std::collections::HashMap;

/// A SPAR value: number when `str2double` accepts it, else the raw text
/// (including the trailing whitespace the header regex captures).
#[derive(Clone, Debug, PartialEq)]
pub enum SparValue {
    Num(f64),
    Text(String),
}

fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// All matches of `([\w\[\].]*)\s*:\s*([-\w\s.\"\\:\.]*)` in one line.
fn spar_matches(line: &str) -> Vec<(String, String)> {
    let b = line.as_bytes();
    let name_ch = |c: u8| is_word(c) || c == b'[' || c == b']' || c == b'.';
    let val_ch = |c: u8| is_word(c) || (c as char).is_ascii_whitespace() || matches!(c, b'-' | b'.' | b'"' | b'\\' | b':');
    let mut out = Vec::new();
    let mut p = 0;
    while p <= b.len() {
        let mut j = p;
        while j < b.len() && name_ch(b[j]) {
            j += 1;
        }
        let mut k = j;
        while k < b.len() && (b[k] as char).is_ascii_whitespace() {
            k += 1;
        }
        if k < b.len() && b[k] == b':' {
            let name = line[p..j].to_string();
            let mut v = k + 1;
            while v < b.len() && (b[v] as char).is_ascii_whitespace() {
                v += 1;
            }
            let v0 = v;
            while v < b.len() && val_ch(b[v]) {
                v += 1;
            }
            out.push((name, line[v0..v].to_string()));
            p = v.max(k + 1);
            if v == b.len() {
                break;
            }
            continue;
        }
        p += 1;
    }
    out
}

/// Parse a SPAR header as `philipsLoad` does (lines with exactly one match).
pub fn parse_spar(text: &str) -> HashMap<String, SparValue> {
    let mut h = HashMap::new();
    for line in text.split_inclusive('\n') {
        let m = spar_matches(line);
        if m.len() == 1 {
            let (name, value) = &m[0];
            let field: String = name.chars().filter(|&c| c != '[' && c != ']').collect();
            if field.is_empty() {
                continue; // MATLAB cannot make an empty field name
            }
            let d = str2double(value);
            let v = if !d.is_nan() { SparValue::Num(d) } else { SparValue::Text(value.clone()) };
            h.insert(field, v);
        }
    }
    h
}

/// Gannet's `uint32le_to_VAXF`.
pub fn vax_f(u: u32) -> f64 {
    let word2 = u >> 16;
    let word1 = u & 0xffff;
    let vax = (word1 << 16) | word2;
    let s = vax >> 31;
    let e = (vax >> 23) & 0xff;
    let f = vax & 0x7f_ffff;
    let m = 0.5 + f as f64 / 16777216.0;
    (-1f64).powi(s as i32) * m * 2f64.powi(e as i32 - 128)
}

fn num(h: &HashMap<String, SparValue>, k: &str) -> Res<f64> {
    match h.get(k) {
        Some(SparValue::Num(v)) => Ok(*v),
        Some(SparValue::Text(t)) => Err(format!("The SPAR field {k} is not a number ({:?}).", t.trim())),
        None => Err(format!("The SPAR file has no {k} field; is it the SPAR belonging to this SDAT?")),
    }
}

fn text(h: &HashMap<String, SparValue>, k: &str) -> String {
    match h.get(k) {
        Some(SparValue::Text(t)) => t.clone(),
        Some(SparValue::Num(v)) => format!("{v}"),
        None => String::new(),
    }
}

/// FID-A `io_loadspec_sdat(filename, subspecs)`: `sdat` and `spar` are the two files.
pub fn load(sdat: &[u8], spar: &[u8], subspecs: usize) -> Res<Spectra> {
    let h = parse_spar(&String::from_utf8_lossy(spar));
    let samples = num(&h, "samples")?;
    let rows = num(&h, "rows")?;
    if !(samples >= 1.0 && rows >= 1.0 && samples.fract() == 0.0 && rows.fract() == 0.0) {
        return Err("The SPAR file gives no valid samples/rows.".into());
    }
    let (ns, nr) = (samples as usize, rows as usize);
    let need = 2 * ns * nr;
    if sdat.len() / 4 < need {
        return Err(format!(
            "This SDAT file holds {} values but its SPAR announces {} samples x {} rows (complex): wrong SPAR, or a truncated SDAT.",
            sdat.len() / 4,
            ns,
            nr
        ));
    }
    if sdat.len() / 4 != need {
        // reshape(data, [2 samples rows]) in philipsLoad errors
        return Err(format!(
            "This SDAT file's size ({} bytes) does not match its SPAR ({} samples x {} rows).",
            sdat.len(),
            ns,
            nr
        ));
    }
    let v = |k: usize| vax_f(u32::from_le_bytes([sdat[4 * k], sdat[4 * k + 1], sdat[4 * k + 2], sdat[4 * k + 3]]));
    let data: Vec<Complex64> = (0..ns * nr).map(|k| Complex64::new(v(2 * k), 0.0) + Complex64::new(0.0, 1.0) * v(2 * k + 1)).collect();
    // squeeze(data(1,:,:)+1i*data(2,:,:)) -> samples x rows
    let data = NdArray::new(data, vec![1, ns, nr]).squeeze();
    let dsz = data.shape.clone();
    let t_ix: Vec<usize> = (0..dsz.len()).filter(|&k| dsz[k] == ns).collect();
    let a_ix: Vec<usize> = (0..dsz.len()).filter(|&k| dsz[k] == nr).collect();
    if t_ix.len() != 1 || a_ix.len() != 1 || t_ix[0] == a_ix[0] {
        return Err(format!(
            "FID-A cannot tell the time and averages dimensions of this SDAT apart ({ns} samples, {nr} rows)."
        ));
    }
    let data = data.permute(&[t_ix[0] + 1, a_ix[0] + 1])?;
    let fids = if subspecs == 2 || subspecs == 4 {
        if nr % subspecs != 0 {
            return Err(format!("This SDAT has {nr} rows, which do not divide into {subspecs} subspectra."));
        }
        let mut v = Vec::with_capacity(ns * nr);
        for s in 0..subspecs {
            let ix: Vec<usize> = (s..nr).step_by(subspecs).collect();
            v.extend(data.select(1, &ix)?.data);
        }
        NdArray::new(v, vec![ns, nr / subspecs, subspecs])
    } else {
        data
    };
    let dims = Dims { t: 1, coils: 0, averages: 2, sub_specs: if subspecs > 1 { 3 } else { 0 }, extras: 0 };
    let sz = fids.shape.clone();
    let txfrq = num(&h, "synthesizer_frequency")?;
    let bo = txfrq / 42577000.0;
    let averages = fids.dim(1) * fids.dim(2);
    let spectralwidth = num(&h, "sample_frequency")?;
    let dwelltime = 1.0 / spectralwidth;
    let te = num(&h, "echo_time")?;
    let tr = num(&h, "repetition_time")?;
    let n = sz[0] as f64;
    let f = octave_range(
        (-spectralwidth / 2.0) + (spectralwidth / (2.0 * n)),
        spectralwidth / n,
        (spectralwidth / 2.0) - (spectralwidth / (2.0 * n)),
    );
    let ppm: Vec<f64> = f.iter().map(|&x| -x / (bo * 42.577) + 4.65).collect();
    let mut flags = fresh_flags();
    flags.addedrcvrs = true;
    flags.is_four_steps = dims.sub_specs != 0 && sz.get(dims.sub_specs - 1).copied() == Some(4);
    Ok(Spectra {
        fids: fids.data,
        t: time_axis(dwelltime, sz[0]),
        sz,
        dims,
        ppm,
        spectralwidth,
        dwelltime,
        txfrq,
        te,
        tm: None,
        tr,
        bo,
        seq: text(&h, "scan_id"),
        date: text(&h, "scan_date"),
        averages,
        raw_averages: averages,
        subspecs,
        raw_subspecs: subspecs,
        points_to_leftshift: 0.0,
        flags,
        nucleus: "1H".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vax() {
        // 1.0 in VAX F: exponent 129, fraction 0, words swapped
        let vax: u32 = (129 << 23) | 0;
        let le = (vax >> 16) | ((vax & 0xffff) << 16);
        assert_eq!(vax_f(le), 1.0);
    }

    #[test]
    fn spar_lines() {
        let h = parse_spar("scan_id : SV_PRESS_30\r\n\r\nsamples : 1024\r\n! comment\r\nscan_date : 2009.06.16 10:32:45\r\n");
        assert_eq!(h.get("samples"), Some(&SparValue::Num(1024.0)));
        assert_eq!(h.get("scan_id"), Some(&SparValue::Text("SV_PRESS_30\r\n".into())));
        assert!(matches!(h.get("scan_date"), Some(SparValue::Text(_))));
        assert!(load(&[0u8; 16], b"samples : 4\nrows : 1\n", 1).is_err());
    }
}
