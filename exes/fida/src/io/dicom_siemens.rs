//! Siemens spectroscopy DICOM: FID-A `io_loadspec_dicom_siemens(folder)` (a
//! folder of per-average DICOM files, VE11-style private CSA data or
//! XA-style SpectroscopyData) and `io_loadspec_IMA(filename, Bo, sw, te, tr)`
//! (a single IMA file, read with Chris Rodgers' SiemensCsaParse /
//! SiemensCsaReadFid).
//!
//! FID-A needs MATLAB's `dicominfo` for both, which Octave does not have, so
//! there is no FID-A reference here: this follows FID-A's code and the DICOM
//! standard (PS3.5, explicit/implicit VR little endian, explicit big endian).
//! Kept from FID-A: VE data (7FE1,1010) are conjugated, XA data (5600,0020)
//! are not; the ppm axis is centred on 4.6082 ppm; files are ordered by
//! InstanceNumber; `averages` is the number of files; with `eja_svs_mpress`
//! or `special` sequences the averages are split in two halves as
//! subspectra (while `subspecs` stays 1, as FID-A writes it). One deliberate
//! difference: FID-A reads `sSpecPara.ucRemoveOversampling` with str2double,
//! which gives NaN for the protocol's hexadecimal `0x1` and makes FID-A stop;
//! here hexadecimal is read as a number.

use super::common::{fresh_flags, octave_range, parse_number, Res};
use crate::spectra::{Dims, Spectra};
use num_complex::Complex64;

/// One top-level DICOM data element.
#[derive(Clone, Debug)]
pub struct Element {
    pub group: u16,
    pub elem: u16,
    pub vr: [u8; 2],
    pub value: Vec<u8>,
}

/// A parsed DICOM file (top-level elements, in file order).
#[derive(Clone, Debug, Default)]
pub struct DicomFile {
    pub elements: Vec<Element>,
    pub big_endian: bool,
}

impl DicomFile {
    pub fn get(&self, group: u16, elem: u16) -> Option<&Element> {
        self.elements.iter().find(|e| e.group == group && e.elem == elem)
    }
    pub fn string(&self, group: u16, elem: u16) -> Option<String> {
        self.get(group, elem).map(|e| {
            String::from_utf8_lossy(&e.value).trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string()
        })
    }
    /// Element of a private block: the block reserved by `creator` in `group`.
    pub fn private(&self, group: u16, creator: &str, low: u8) -> Option<&Element> {
        let block = self.elements.iter().find(|e| {
            e.group == group && (0x10..=0xff).contains(&e.elem) && String::from_utf8_lossy(&e.value).trim_end_matches(['\0', ' ']) == creator
        })?;
        let el = (block.elem << 8) | low as u16;
        self.get(group, el)
    }
    fn f32s(&self, e: &Element) -> Vec<f32> {
        e.value
            .chunks_exact(4)
            .map(|c| {
                let a = [c[0], c[1], c[2], c[3]];
                if self.big_endian {
                    f32::from_be_bytes(a)
                } else {
                    f32::from_le_bytes(a)
                }
            })
            .collect()
    }
}

const LONG_VRS: [&[u8; 2]; 11] = [b"OB", b"OW", b"OF", b"SQ", b"UT", b"UN", b"UC", b"UR", b"OD", b"OL", b"OV"];

struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
    explicit: bool,
    big: bool,
}

impl<'a> Reader<'a> {
    fn u16(&mut self) -> Res<u16> {
        let s = self.b.get(self.pos..self.pos + 2).ok_or("This DICOM file is truncated.")?;
        self.pos += 2;
        Ok(if self.big { u16::from_be_bytes([s[0], s[1]]) } else { u16::from_le_bytes([s[0], s[1]]) })
    }
    fn u32(&mut self) -> Res<u32> {
        let s = self.b.get(self.pos..self.pos + 4).ok_or("This DICOM file is truncated.")?;
        self.pos += 4;
        Ok(if self.big { u32::from_be_bytes([s[0], s[1], s[2], s[3]]) } else { u32::from_le_bytes([s[0], s[1], s[2], s[3]]) })
    }
    /// Read one element header: (group, elem, vr, length).
    fn header(&mut self) -> Res<(u16, u16, [u8; 2], u32)> {
        let g = self.u16()?;
        let e = self.u16()?;
        if g == 0xfffe {
            let len = self.u32()?;
            return Ok((g, e, *b"  ", len));
        }
        if self.explicit {
            let vr = self.b.get(self.pos..self.pos + 2).ok_or("This DICOM file is truncated.")?;
            let vr = [vr[0], vr[1]];
            self.pos += 2;
            if LONG_VRS.iter().any(|v| **v == vr) {
                self.pos += 2;
                let len = self.u32()?;
                Ok((g, e, vr, len))
            } else {
                let len = self.u16()? as u32;
                Ok((g, e, vr, len))
            }
        } else {
            let len = self.u32()?;
            Ok((g, e, *b"UN", len))
        }
    }
    /// Skip an undefined-length sequence or item body up to its delimiter.
    fn skip_undefined(&mut self, depth: usize) -> Res<()> {
        if depth > 32 {
            return Err("This DICOM file nests sequences too deeply.".into());
        }
        loop {
            let (g, e, vr, len) = self.header()?;
            if g == 0xfffe && (e == 0xe0dd || e == 0xe00d) {
                return Ok(());
            }
            if len == 0xffff_ffff {
                self.skip_undefined(depth + 1)?;
                let _ = vr;
            } else {
                self.pos = self.pos.checked_add(len as usize).filter(|&p| p <= self.b.len()).ok_or("This DICOM file is truncated.")?;
            }
        }
    }
}

/// Parse a DICOM file's top-level elements.
pub fn parse_dicom(b: &[u8]) -> Res<DicomFile> {
    let start = if b.len() > 132 && &b[128..132] == b"DICM" { 132 } else { 0 };
    let mut r = Reader { b, pos: start, explicit: true, big: false };
    let mut out = DicomFile::default();
    let mut ts_explicit = true;
    let mut ts_big = false;
    let mut meta_done = start == 0;
    if start == 0 {
        // no preamble: guess implicit VR when the VR bytes are not letters
        if b.len() >= 6 && !(b[4].is_ascii_uppercase() && b[5].is_ascii_uppercase()) {
            r.explicit = false;
        }
    }
    while r.pos + 8 <= b.len() {
        if !meta_done {
            // group 0002 is always explicit little endian
            let g = u16::from_le_bytes([b[r.pos], b[r.pos + 1]]);
            if g != 2 {
                meta_done = true;
                r.explicit = ts_explicit;
                r.big = ts_big;
            }
        }
        let (g, e, vr, len) = r.header()?;
        if len == 0xffff_ffff {
            r.skip_undefined(0)?;
            continue;
        }
        let end = r.pos.checked_add(len as usize).filter(|&p| p <= b.len()).ok_or("This DICOM file is truncated.")?;
        let value = b[r.pos..end].to_vec();
        r.pos = end;
        if g == 2 && e == 0x0010 {
            let ts = String::from_utf8_lossy(&value).trim_matches(|c: char| c == '\0' || c == ' ').to_string();
            match ts.as_str() {
                "1.2.840.10008.1.2" => ts_explicit = false,
                "1.2.840.10008.1.2.2" => ts_big = true,
                "1.2.840.10008.1.2.1.99" => return Err("This DICOM file is deflate-compressed, which is not supported.".into()),
                _ => {}
            }
        }
        if vr == *b"SQ" {
            continue;
        }
        out.elements.push(Element { group: g, elem: e, vr, value });
    }
    out.big_endian = ts_big;
    if out.elements.is_empty() {
        return Err("This is not a DICOM file.".into());
    }
    Ok(out)
}

/// FID-A `getPhoenixValue(txt, param, isNumeric)` (text form).
fn phoenix_text(txt: &str, param: &str) -> Option<String> {
    let idx = txt.find(param)?;
    let eq = idx + txt[idx..].find('=')?;
    let nl = eq + txt[eq..].find(['\r', '\n'])?;
    Some(txt[eq + 1..nl].trim().to_string())
}

fn phoenix_num(txt: &str, param: &str) -> Option<f64> {
    phoenix_text(txt, param).map(|v| parse_number(&v).unwrap_or(f64::NAN))
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

/// `extractPhoenixfromDicomInfo`: every private element whose text holds the protocol.
fn phoenix_from_private(d: &DicomFile) -> String {
    let mut txt = String::new();
    for e in &d.elements {
        if e.group % 2 == 1 {
            let v = latin1(&e.value);
            if v.contains("ASCCONV") || v.contains("alTE") || v.contains("tSequenceFileName") {
                txt.push_str(&v);
            }
        }
    }
    txt
}

/// `extractPhoenixFromDicomFile`: the file text from the first ASCCONV BEGIN
/// to the first ASCCONV END (plus one character, as FID-A's index does).
fn phoenix_from_file(b: &[u8]) -> String {
    let t = latin1(b);
    let (Some(i1), Some(i2)) = (t.find("ASCCONV BEGIN"), t.find("ASCCONV END")) else {
        return String::new();
    };
    let end = (i2 + "ASCCONV END".len() + 1).min(t.len());
    if i1 >= end {
        return String::new();
    }
    t[i1..end].to_string()
}

/// The Siemens Phoenix protocol (ASCCONV text) of one spectroscopy DICOM
/// file, as the reader finds it: in the file text for XA (enhanced) DICOM,
/// in the CSA private elements otherwise. Empty when there is none.
pub fn protocol_text(b: &[u8]) -> String {
    match parse_dicom(b) {
        Ok(d) if d.get(0x5600, 0x0020).is_some() => phoenix_from_file(b),
        Ok(d) => phoenix_from_private(&d),
        Err(_) => String::new(),
    }
}

/// FID-A `io_loadspec_dicom_siemens(folder)`: `files` are the (name, bytes)
/// of the folder. Returns the structure and the parsed first file.
pub fn load_folder(files: &[(String, &[u8])]) -> Res<(Spectra, DicomFile)> {
    let files: Vec<&(String, &[u8])> = files.iter().filter(|(n, _)| !n.starts_with('.')).collect();
    if files.is_empty() {
        return Err("No files found in folder.".into());
    }
    let n_fil = files.len();
    let mut infos: Vec<(f64, usize, DicomFile, &[u8])> = Vec::new();
    for (k, (_, b)) in files.iter().enumerate() {
        let Ok(d) = parse_dicom(b) else { continue };
        let inst = d.string(0x0020, 0x0013).and_then(|s| parse_number(&s)).unwrap_or((k + 1) as f64);
        infos.push((inst, k, d, b));
    }
    if infos.is_empty() {
        return Err("None of these files is a DICOM file.".into());
    }
    infos.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    let n_avg = infos.len();
    let info0 = &infos[0].2;
    let is_xa = info0.get(0x5600, 0x0020).is_some();
    let is_ve = info0.get(0x7fe1, 0x1010).is_some();
    if !is_xa && !is_ve {
        return Err("Unsupported Siemens DICOM spectroscopy format (no SpectroscopyData and no CSA non-image data).".into());
    }
    let csa = if is_xa { phoenix_from_file(infos[0].3) } else { phoenix_from_private(info0) };
    let mut cols: Vec<Vec<Complex64>> = Vec::with_capacity(n_avg);
    for (_, _, d, _) in &infos {
        let v: Vec<Complex64> = if is_xa {
            let e = d.get(0x5600, 0x0020).ok_or("A DICOM file of this series has no SpectroscopyData.")?;
            let x = d.f32s(e);
            (0..x.len() / 2).map(|k| Complex64::new(x[2 * k] as f64, 0.0) + Complex64::new(0.0, 1.0) * x[2 * k + 1] as f64).collect()
        } else {
            let e = d.get(0x7fe1, 0x1010).ok_or("A DICOM file of this series has no CSA non-image data (7FE1,1010).")?;
            let x: Vec<f32> = e.value.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            (0..x.len() / 2).map(|k| Complex64::new(x[2 * k] as f64, 0.0) - Complex64::new(0.0, 1.0) * x[2 * k + 1] as f64).collect()
        };
        if let Some(c0) = cols.first() {
            if c0.len() != v.len() {
                return Err("The DICOM files of this series hold different numbers of points.".into());
            }
        }
        cols.push(v);
    }
    let npts_file = cols[0].len();
    if npts_file == 0 {
        return Err("This DICOM series holds no spectroscopy points.".into());
    }
    let need = |p: &str| phoenix_num(&csa, p).ok_or_else(|| format!("The Siemens protocol in this DICOM has no {p}."));
    let n_pts = need("lVectorSize")?;
    let mut dwelltime = need("alDwellTime[0]")? * 1e-9;
    let rm_os = phoenix_num(&csa, "sSpecPara.ucRemoveOversampling");
    if let Some(v) = rm_os {
        if v.is_nan() {
            return Err("The protocol's sSpecPara.ucRemoveOversampling is not a number.".into());
        }
        if v != 0.0 {
            dwelltime *= 2.0;
        }
    }
    let spectralwidth = 1.0 / dwelltime;
    let txfrq = need("lFrequency")?;
    let bo = need("flNominalB0")?;
    let te = need("alTE[0]")? * 1e-3;
    let tr = need("alTR[0]")? * 1e-3;
    let date = info0.string(0x0040, 0x0244).unwrap_or_default();
    let sequence = phoenix_text(&csa, "tSequenceFileName").unwrap_or_default();
    let mut data: Vec<Complex64> = Vec::with_capacity(npts_file * n_avg);
    for c in &cols {
        data.extend_from_slice(c);
    }
    let (sz, dims) = if sequence.contains("eja_svs_mpress") || sequence.contains("special") {
        if n_avg % 2 != 0 {
            return Err(format!("This edited DICOM series has an odd number of files ({n_avg}); FID-A splits them in two halves."));
        }
        (vec![npts_file, n_avg / 2, 2], Dims { t: 1, coils: 0, averages: 2, sub_specs: 3, extras: 0 })
    } else {
        (vec![npts_file, n_avg], Dims { t: 1, coils: 0, averages: 2, sub_specs: 0, extras: 0 })
    };
    let mut sz = sz;
    while sz.len() > 2 && *sz.last().unwrap() == 1 {
        sz.pop();
    }
    let _ = n_fil;
    let n = npts_file as f64;
    let f = octave_range(
        (-spectralwidth / 2.0) + (spectralwidth / (2.0 * n)),
        spectralwidth / n,
        (spectralwidth / 2.0) - (spectralwidth / (2.0 * n)),
    );
    let ppm: Vec<f64> = f.iter().map(|&x| -x / (bo * 42.577) + 4.6082).collect();
    if !(n_pts >= 0.0 && n_pts.fract() == 0.0) {
        return Err("The protocol's lVectorSize is not a count.".into());
    }
    let t: Vec<f64> = (0..n_pts as usize).map(|k| k as f64 * dwelltime).collect();
    let mut flags = fresh_flags();
    flags.addedrcvrs = true;
    let s = Spectra {
        fids: data,
        sz,
        dims,
        ppm,
        t,
        spectralwidth,
        dwelltime,
        txfrq,
        te,
        tr,
        bo,
        seq: sequence,
        date,
        averages: n_avg,
        raw_averages: n_avg,
        subspecs: 1,
        raw_subspecs: 1,
        points_to_leftshift: 0.0,
        flags,
        nucleus: "1H".into(),
    };
    let first = infos.swap_remove(0).2;
    Ok((s, first))
}

/// Chris Rodgers' `SiemensCsaParse` of one CSA block: (name, strings, numeric?).
pub fn parse_csa(b: &[u8]) -> Res<Vec<(String, Vec<String>, bool, usize)>> {
    let bad = || "Unsupported CSA block format".to_string();
    if b.len() < 16 || &b[0..4] != b"SV10" || b[4..8] != [4, 3, 2, 1] {
        return Err(bad());
    }
    let u = |o: usize| -> Res<u32> { b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(bad) };
    let n = u(8)? as usize;
    if u(12)? != 77 || n > 10000 {
        return Err(bad());
    }
    let mut p = 16;
    let mut out = Vec::new();
    let cstr = |s: &[u8]| -> String {
        let e = s.iter().position(|&c| c == 0).unwrap_or(s.len());
        latin1(&s[..e])
    };
    for _ in 0..n {
        let name_b = b.get(p..p + 64).ok_or_else(bad)?;
        let name: String = cstr(name_b).chars().filter(|&c| c != '-').collect();
        p += 64;
        let vm = u(p)? as usize;
        let vr = cstr(b.get(p + 4..p + 8).ok_or_else(bad)?);
        let nitems = u(p + 12)? as usize;
        let check = u(p + 16)?;
        p += 20;
        if check != 77 && check != 205 {
            return Err(bad());
        }
        let mut items = Vec::new();
        for _ in 0..nitems {
            let h = [u(p)?, u(p + 4)?, u(p + 8)?, u(p + 12)?];
            p += 16;
            if (h[2] != 77 && h[2] != 205) || h[0] != h[1] || h[0] != h[3] {
                return Err(bad());
            }
            let len = h[0] as usize;
            items.push(cstr(b.get(p..p + len).ok_or_else(bad)?));
            p += len + (4 - len % 4) % 4;
        }
        let numeric = matches!(vr.as_str(), "DS" | "FD" | "FL" | "IS" | "SL" | "ST" | "UL" | "US");
        out.push((name, items, numeric, vm));
    }
    Ok(out)
}

/// FID-A `io_loadspec_IMA(filename, Bo, spectralwidth, te, tr)`: `bo` in T,
/// `spectralwidth` in Hz, `te`/`tr` in ms (FID-A leaves them empty when not given; 0 here).
pub fn load_ima(data: &[u8], bo: f64, spectralwidth: f64, te: Option<f64>, tr: Option<f64>) -> Res<Spectra> {
    let d = parse_dicom(data)?;
    let mut csa: std::collections::HashMap<String, (Vec<String>, bool, usize)> = Default::default();
    let mut found = false;
    for low in [0x10u8, 0x20] {
        if let Some(e) = d.private(0x0029, "SIEMENS CSA HEADER", low) {
            found = true;
            for (name, items, numeric, vm) in parse_csa(&e.value)? {
                csa.insert(name, (items, numeric, vm));
            }
        }
    }
    if !found {
        return Err("This DICOM file does not contain a 'SIEMENS CSA HEADER'.".into());
    }
    let num = |k: &str| -> Res<f64> {
        let (items, _, _) = csa.get(k).ok_or_else(|| format!("The CSA header has no {k}."))?;
        Ok(items.first().and_then(|s| parse_number(s)).unwrap_or(0.0))
    };
    let (dpc, cols, rows, frames) = (num("DataPointColumns")?, num("Columns")?, num("Rows")?, num("NumberOfFrames")?);
    let dims4: Vec<usize> = [dpc, cols, rows, frames]
        .iter()
        .map(|&x| if x >= 1.0 && x.fract() == 0.0 { Ok(x as usize) } else { Err("The CSA header gives a non-positive data size.".to_string()) })
        .collect::<Res<_>>()?;
    let e = d.private(0x7fe1, "SIEMENS CSA NON-IMAGE", 0x10).ok_or("This IMA file has no CSA non-image spectroscopy data.")?;
    let x: Vec<f32> = e.value.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let n: usize = dims4.iter().product();
    if x.len() != 2 * n {
        return Err(format!("This IMA file holds {} values, not the 2 x {n} its CSA header announces.", x.len()));
    }
    let fids: Vec<Complex64> = (0..n).map(|k| Complex64::new(x[2 * k] as f64, 0.0) - Complex64::new(0.0, 1.0) * x[2 * k + 1] as f64).collect();
    let mut sz = dims4.clone();
    while sz.len() > 2 && *sz.last().unwrap() == 1 {
        sz.pop();
    }
    // Naverages = Ncoils = 1 in FID-A
    let dims = if sz.len() == 4 {
        Dims { t: 1, coils: 2, averages: 3, sub_specs: 4, extras: 0 }
    } else {
        Dims { t: 1, coils: 0, averages: 0, sub_specs: 2, extras: 0 }
    };
    let (averages, raw_averages, subspecs, raw_subspecs) = super::common::standard_counts(&sz, &dims);
    let nn = sz[0] as f64;
    let f = octave_range((-spectralwidth / 2.0) + (spectralwidth / (2.0 * nn)), spectralwidth / nn, (spectralwidth / 2.0) - (spectralwidth / (2.0 * nn)));
    let dwelltime = 1.0 / spectralwidth;
    let mut flags = fresh_flags();
    flags.averaged = true;
    flags.addedrcvrs = true;
    flags.is_four_steps = super::common::four_steps(&sz, &dims);
    Ok(Spectra {
        fids,
        t: super::common::time_axis(dwelltime, sz[0]),
        sz,
        dims,
        ppm: f.iter().map(|&v| -v / (bo * 42.577) + 4.65).collect(),
        spectralwidth,
        dwelltime,
        txfrq: 42577000.0 * bo,
        te: te.unwrap_or(0.0),
        tr: tr.unwrap_or(0.0),
        bo,
        seq: String::new(),
        date: "1012000".into(),
        averages,
        raw_averages,
        subspecs,
        raw_subspecs,
        points_to_leftshift: 0.0,
        flags,
        nucleus: "1H".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phoenix_lookup() {
        let t = "x\nsRXSPEC.alDwellTime[0]\t = 250000\r\nsSpecPara.ucRemoveOversampling = 0x1\n";
        assert_eq!(phoenix_num(t, "alDwellTime[0]"), Some(250000.0));
        assert_eq!(phoenix_num(t, "sSpecPara.ucRemoveOversampling"), Some(1.0));
        assert_eq!(phoenix_num(t, "lFrequency"), None);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_dicom(b"").is_err());
        assert!(load_folder(&[("a".into(), &b"nope"[..])]).is_err());
        assert!(load_ima(b"nope", 3.0, 2000.0, None, None).is_err());
    }
}
