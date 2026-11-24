//! Bruker (ParaVision 5, 6, 7 and 360) scan directories: FID-A
//! `io_loadspec_bruk(inDir, rawData, leftshift)`.
//!
//! The directory is given as (relative name, bytes) pairs: `acqp`, `method`
//! and the data file (`fid.raw` for PV 5 and `rawdata.job0` for PV 6/7/360
//! when reading the uncombined averages; `fid` for the combined data), plus
//! the optional reference scan (`fid.ref`, `fid.refscan`, or
//! `pdata/1/fid_refscan.64`).
//!
//! FID-A's quirks are kept: samples are read as (imag, real) pairs and
//! combined as real - i*imag; the first `leftshift` (68) points are dropped
//! and zeros appended; the ppm axis is `length(specs)` points wide (the
//! largest dimension); the reference scan of PV 5 files is read as int16 and
//! reshaped by the metabolite average count. FID-A cannot read the combined
//! data (`rawData='n'`: it tests an undefined variable); here that path reads
//! `fid` as its code intends.

use super::common::{fresh_flags, octave_range, str2double, str2num, time_axis, NdArray, Res};
use crate::spectra::{Dims, Spectra};
use num_complex::Complex64;

/// Result of reading a Bruker scan.
#[derive(Clone, Debug)]
pub struct BrukerResult {
    pub out: Spectra,
    /// FID-A's second output (`ref`): the reference scans, when present.
    pub ref_scan: Option<Spectra>,
    /// ParaVision version string from acqp (e.g. "PV 5.1").
    pub version: String,
}

fn get<'a>(files: &'a [(String, &'a [u8])], name: &str) -> Option<&'a [u8]> {
    files.iter().find(|(n, _)| n == name || n.ends_with(&format!("/{name}"))).map(|(_, b)| *b)
}

struct Text<'a> {
    lines: Vec<&'a str>,
}

impl<'a> Text<'a> {
    fn new(s: &'a str) -> Self {
        Text { lines: s.split_inclusive('\n').collect() }
    }
    /// Index of the first line (from `from`) containing `pat`, or an error as
    /// FID-A's fgets loop hits the end of the file.
    fn find(&self, pat: &str, from: usize, file: &str) -> Res<usize> {
        (from..self.lines.len())
            .find(|&k| self.lines[k].contains(pat))
            .ok_or_else(|| format!("The Bruker {file} file has no {pat} entry."))
    }
    fn after_eq(&self, k: usize) -> &'a str {
        let l = self.lines[k];
        match l.find('=') {
            Some(e) => &l[e + 1..],
            None => "",
        }
    }
}

fn contains(s: &str, p: &str) -> bool {
    s.contains(p)
}

fn ints(b: &[u8], width: usize) -> Vec<f64> {
    match width {
        2 => b.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f64).collect(),
        4 => b.chunks_exact(4).map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64).collect(),
        _ => b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect(),
    }
}

/// real_fid = d(2:2:end), imag_fid = d(1:2:end), fids = real - 1i*imag.
fn to_complex(d: &[f64]) -> Vec<Complex64> {
    let n_re = d.len() / 2;
    let n_im = (d.len() + 1) / 2;
    let n = n_re.min(n_im);
    (0..n).map(|k| Complex64::new(d[2 * k + 1], 0.0) - Complex64::new(0.0, 1.0) * d[2 * k]).collect()
}

/// `fids_raw(leftshift+1:end,:,:)` then `padarray(..., [leftshift,0], 'post')`.
fn shift_pad(a: &NdArray, leftshift: usize) -> NdArray {
    let n = a.dim(0);
    let rest = a.data.len() / n.max(1);
    let mut v = Vec::with_capacity(a.data.len());
    let kept = n.saturating_sub(leftshift);
    let new_n = kept + leftshift;
    for c in 0..rest {
        v.extend_from_slice(&a.data[c * n + (n - kept)..(c + 1) * n]);
        v.extend(std::iter::repeat(Complex64::new(0.0, 0.0)).take(leftshift));
    }
    let mut shape = a.shape.clone();
    shape[0] = new_n;
    NdArray::new(v, shape)
}

fn reshape_cols(v: Vec<Complex64>, cols: f64, what: &str) -> Res<NdArray> {
    if !(cols >= 1.0 && cols.fract() == 0.0) {
        return Err(format!("The Bruker method gives {cols} {what}."));
    }
    let c = cols as usize;
    if v.len() % c != 0 || v.is_empty() {
        return Err(format!("The Bruker data ({} points) do not divide into {c} {what}.", v.len()));
    }
    let r = v.len() / c;
    Ok(NdArray::new(v, vec![r, c]))
}

/// FID-A `io_loadspec_bruk(inDir, rawData, leftshift)`: `raw` selects the
/// uncombined averages ('y', FID-A's default) or the combined `fid` ('n');
/// `leftshift` is FID-A's default 68 unless the caller knows better.
pub fn load(files: &[(String, &[u8])], raw: bool, leftshift: usize) -> Res<BrukerResult> {
    let acqp_b = get(files, "acqp").ok_or("This Bruker scan has no acqp file.")?;
    let method_b = get(files, "method").ok_or("This Bruker scan has no method file.")?;
    let acqp_s = String::from_utf8_lossy(acqp_b);
    let method_s = String::from_utf8_lossy(method_b);
    let acqp = Text::new(&acqp_s);
    let method = Text::new(&method_s);

    let k = acqp.find("<PV", 0, "acqp")?;
    let line: Vec<char> = acqp.lines[k].chars().collect();
    let version: String = if line.len() >= 3 { line[1..line.len() - 2].iter().collect() } else { String::new() };
    let pv5 = contains(&version, "PV 5");
    let pv67 = contains(&version, "PV 6") || contains(&version, "PV 7");
    let pv360 = contains(&version, "PV-360");

    let raw_points = if pv360 {
        let k = method.find("$PVM_SpecMatrix=", 0, "method")?;
        str2double(method.lines.get(k + 1).copied().unwrap_or(""))
    } else {
        let k = method.find("$PVM_DigNp=", 0, "method")?;
        str2double(method.after_eq(k))
    };
    let k = method.find("$PVM_NAverages=", 0, "method")?;
    let raw_averages = str2double(method.after_eq(k));
    let k = method.find("$PVM_EncUseMultiRec=", 0, "method")?;
    let mr = method.after_eq(k);
    let multi_rec = &mr[..mr.len().saturating_sub(1)]; // line(eq+1:end-1)
    let multi_rcvrs = multi_rec == "Yes";
    let k2 = method.find("$PVM_EncNReceivers=", k, "method")?;
    let nrcvrs = str2num(method.after_eq(k2)).and_then(|v| v.first().copied()).unwrap_or(f64::NAN);

    let (fids_raw, averages) = if raw {
        let data = if pv67 || pv360 {
            get(files, "rawdata.job0").ok_or("This ParaVision 6/7/360 scan has no rawdata.job0 file (needed for the uncombined averages).")?
        } else if pv5 {
            get(files, "fid.raw").ok_or("This ParaVision 5 scan has no fid.raw file (needed for the uncombined averages).")?
        } else {
            return Err(format!("FID-A's Bruker reader supports ParaVision 5, 6, 7 and 360; this scan is {version:?}."));
        };
        let v = to_complex(&ints(data, 4));
        let mut a = reshape_cols(v, raw_averages, "averages")?;
        if !pv5 && multi_rcvrs {
            let (p, r) = (raw_points, nrcvrs);
            if !(p >= 1.0 && r >= 1.0 && p.fract() == 0.0 && r.fract() == 0.0) || (p * r * raw_averages) as usize != a.data.len() {
                return Err("The Bruker data size does not match PVM_DigNp x receivers x averages.".into());
            }
            a = NdArray::new(a.data, vec![p as usize, r as usize, raw_averages as usize]).permute(&[1, 3, 2])?;
        }
        (a, raw_averages)
    } else {
        let data = get(files, "fid").ok_or("This Bruker scan has no fid file.")?;
        let v = to_complex(&ints(data, 4));
        let n = v.len();
        (NdArray::new(v, vec![n, 1]), 1.0)
    };
    if fids_raw.dim(0) < leftshift {
        return Err(format!("The Bruker FIDs have fewer points ({}) than the leftshift ({leftshift}).", fids_raw.dim(0)));
    }
    let fids = shift_pad(&fids_raw, leftshift);
    let sz = fids.shape.clone();
    let mut dims = Dims { t: 1, ..Dims::default() };
    if !pv5 && multi_rcvrs {
        dims.coils = if raw_averages == 1.0 { 2 } else { 3 };
    }
    dims.averages = if raw { 2 } else { 0 };

    let is_ref = if pv5 {
        get(files, "fid.ref").map(|b| (b, 2usize))
    } else if pv67 || contains(&version, "PV-360.2") {
        get(files, "fid.refscan").map(|b| (b, 4))
    } else if contains(&version, "PV-360.3") {
        get(files, "pdata/1/fid_refscan.64").map(|b| (b, 8))
    } else {
        None
    };

    let spectralwidth = if pv5 || pv67 {
        let k = method.find("$PVM_DigSw=", 0, "method")?;
        str2double(method.after_eq(k))
    } else if pv360 {
        let k = method.find("$PVM_SpecSWH=", 0, "method")?;
        str2double(method.lines.get(k + 1).copied().unwrap_or(""))
    } else {
        return Err(format!("FID-A's Bruker reader supports ParaVision 5, 6, 7 and 360; this scan is {version:?}."));
    };
    let k = acqp.find("$BF1=", 0, "acqp")?;
    let txfrq = str2double(acqp.after_eq(k)) * 1e6;
    let bo = txfrq / 42577000.0;
    let sw_ppm = spectralwidth / (txfrq / 1e6);
    // te: FID-A gives 0 when the entry is missing or on an unterminated last line
    let te = match (0..method.lines.len()).find(|&k| method.lines[k].contains("$PVM_EchoTime=")) {
        Some(k) if !(k + 1 == method.lines.len() && !method.lines[k].ends_with('\n')) => str2double(method.after_eq(k)),
        _ => 0.0,
    };
    let k = method.find("$PVM_RepetitionTime=", 0, "method")?;
    let tr = str2double(method.after_eq(k));
    let k = method.find("$Method=", 0, "method")?;
    let sequence = method.after_eq(k).trim().to_string();

    let len = *sz.iter().max().unwrap_or(&0);
    if len < 2 {
        return Err("The Bruker FID is too short.".into());
    }
    let ppm = octave_range(4.65 + (sw_ppm / 2.0), -sw_ppm / (len as f64 - 1.0), 4.65 - (sw_ppm / 2.0));
    let dwelltime = 1.0 / spectralwidth;
    let t = time_axis(dwelltime, sz[0]);
    let base = |fids: NdArray, dims: Dims, averages: usize, raw_averages: usize| -> Spectra {
        let sz = fids.shape.clone();
        let mut flags = fresh_flags();
        flags.is_four_steps = false;
        Spectra {
            fids: fids.data,
            sz,
            dims,
            ppm: ppm.clone(),
            t: t.clone(),
            spectralwidth,
            dwelltime,
            txfrq,
            te,
            tm: None,
            tr,
            bo,
            seq: sequence.clone(),
            date: String::new(),
            averages,
            raw_averages,
            subspecs: 1,
            raw_subspecs: 1,
            points_to_leftshift: 68.0 - leftshift as f64,
            flags,
            nucleus: "1H".into(),
        }
    };
    let ra = if raw_averages >= 0.0 { raw_averages as usize } else { 0 };
    let mut out = base(fids, dims, averages as usize, ra);
    out.flags.averaged = !raw;
    out.flags.addedrcvrs = !(multi_rcvrs && dims.coils != 0);

    let ref_scan = match is_ref {
        Some((b, w)) => {
            let v = to_complex(&ints(b, w));
            let ra_ref = if pv5 {
                raw_averages
            } else {
                let k = method.find("$PVM_RefScanNA=", 0, "method")?;
                str2double(method.after_eq(k))
            };
            let a = reshape_cols(v, ra_ref, "reference averages")?;
            if a.dim(0) < leftshift {
                return Err("The Bruker reference FIDs are shorter than the leftshift.".into());
            }
            let rf = shift_pad(&a, leftshift);
            let rdims = Dims { t: 1, coils: 0, averages: if ra_ref > 1.0 { 2 } else { 0 }, sub_specs: 0, extras: 0 };
            let n = ra_ref as usize;
            let mut r = base(rf, rdims, n, n);
            r.flags.averaged = false;
            r.flags.addedrcvrs = true;
            Some(r)
        }
        None => None,
    };
    Ok(BrukerResult { out, ref_scan, version })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_files() {
        assert!(load(&[], true, 68).is_err());
        let files = vec![("acqp".to_string(), &b"##$BF1=300\n<PV 5.1>\n"[..])];
        assert!(load(&files, true, 68).is_err());
    }
}
