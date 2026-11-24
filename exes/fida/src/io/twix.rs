//! Siemens twix raw data (.dat): FID-A `io_loadspec_twix` together with the
//! parts of mapVBVD (`mapVBVD.m`, `read_twix_hdr.m`, `twix_map_obj.m`) it
//! relies on. VB files and VD/VE/XA files (multi-RAID: the last measurement,
//! as FID-A assumes) are both handled.
//!
//! The data are never copied into mapVBVD's 16-dimensional array: FID-A's
//! squeeze / split / select / permute chain is tracked as a strided view of
//! that array and only the final `fids` are materialised, reading each sample
//! straight from the file bytes. The file plus the output are the only copies.

use super::common::{fresh_flags, octave_range, time_axis, Bytes, Res};
use crate::spectra::{Dims, Spectra};
use num_complex::Complex64;
use std::collections::{HashMap, HashSet};

const DIM_NAMES: [&str; 16] = [
    "Col", "Cha", "Lin", "Par", "Sli", "Ave", "Phs", "Eco", "Rep", "Set", "Seg", "Ida", "Idb", "Idc", "Idd", "Ide",
];

/// A header value after mapVBVD's `eval(['[' value ']'])`.
#[derive(Clone, Debug, PartialEq)]
pub enum PVal {
    Num(Vec<f64>),
    Str(String),
}

impl PVal {
    pub fn num(&self) -> Option<f64> {
        match self {
            PVal::Num(v) => v.first().copied(),
            PVal::Str(_) => None,
        }
    }
    pub fn text(&self) -> String {
        match self {
            PVal::Str(s) => s.clone(),
            PVal::Num(v) => v.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(" "),
        }
    }
    fn is_empty(&self) -> bool {
        match self {
            PVal::Num(v) => v.is_empty(),
            PVal::Str(s) => s.is_empty(),
        }
    }
}

/// One header buffer (Config, Dicom, Meas, MeasYaps, Phoenix, Spice) as
/// mapVBVD's `parse_buffer` builds it: the ASCCONV part, keyed by its full
/// path (`sRXSPEC.alDwellTime[0]`), merged with the XProtocol parameters.
#[derive(Clone, Debug, Default)]
pub struct Protocol {
    pub ascconv: HashMap<String, PVal>,
    pub ascconv_top: HashSet<String>,
    pub xprot: HashMap<String, PVal>,
}

impl Protocol {
    /// Field lookup with the merge rule of `parse_buffer` (Octave `unique`
    /// keeps the first occurrence, so ASCCONV names win over XProtocol ones).
    pub fn get(&self, key: &str) -> Option<&PVal> {
        let top = key.split(['.', '[']).next().unwrap_or(key);
        if self.ascconv_top.contains(top) {
            self.ascconv.get(key)
        } else if key == top {
            self.xprot.get(key)
        } else {
            None
        }
    }
    pub fn has(&self, key: &str) -> bool {
        let top = key.split(['.', '[']).next().unwrap_or(key);
        if key == top {
            self.ascconv_top.contains(key) || self.xprot.contains_key(key)
        } else {
            self.ascconv.contains_key(key)
        }
    }
}

/// The twix header: buffer name -> protocol.
#[derive(Clone, Debug, Default)]
pub struct TwixHeader {
    pub buffers: HashMap<String, Protocol>,
}

impl TwixHeader {
    pub fn get(&self, buffer: &str, key: &str) -> Option<&PVal> {
        self.buffers.get(buffer).and_then(|p| p.get(key))
    }
    fn num(&self, buffer: &str, key: &str) -> Res<f64> {
        match self.get(buffer, key) {
            Some(v) => v.num().ok_or_else(|| {
                format!("The twix header field {buffer}.{key} is not a number ({:?}); FID-A cannot use this file.", v.text())
            }),
            None => Err(format!(
                "The twix header has no {buffer}.{key}; this does not look like a single-voxel spectroscopy measurement FID-A can read."
            )),
        }
    }
    fn text(&self, buffer: &str, key: &str) -> Res<String> {
        self.get(buffer, key)
            .map(|v| v.text())
            .ok_or_else(|| format!("The twix header has no {buffer}.{key}."))
    }
}

// ---------------------------------------------------------------- header text

fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// `regexprep(buffer, '\n\s*\n', '')`.
fn delete_empty_lines(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\n' {
            let mut j = i + 1;
            let mut last_nl = None;
            while j < b.len() && is_space(b[j]) {
                if b[j] == b'\n' {
                    last_nl = Some(j);
                }
                j += 1;
            }
            if let Some(k) = last_nl {
                i = k + 1;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

fn find(h: &[u8], pat: &[u8], from: usize) -> Option<usize> {
    if pat.is_empty() || from >= h.len() || h.len() - from < pat.len() {
        return None;
    }
    h[from..].windows(pat.len()).position(|w| w == pat).map(|p| p + from)
}

fn rfind(h: &[u8], pat: &[u8]) -> Option<usize> {
    if h.len() < pat.len() {
        return None;
    }
    h.windows(pat.len()).rposition(|w| w == pat)
}

/// `parse_buffer`: split off the ASCCONV block and parse both parts.
fn parse_buffer(buf: &[u8]) -> Protocol {
    let mut p = Protocol::default();
    // '### ASCCONV BEGIN[^\n]*\n(.*)\s### ASCCONV END ###' ('.' matches newlines; greedy)
    let begin = find(buf, b"### ASCCONV BEGIN", 0);
    let mut xprot: Vec<u8> = buf.to_vec();
    if let Some(b0) = begin {
        if let Some(nl) = buf[b0..].iter().position(|&c| c == b'\n').map(|k| k + b0) {
            let end_pat = b"### ASCCONV END ###";
            if let Some(e) = rfind(&buf[nl + 1..], end_pat).map(|k| k + nl + 1) {
                // the \s before the END marker belongs to the match, not the token
                if e > nl + 1 && is_space(buf[e - 1]) {
                    let asc = &buf[nl + 1..e - 1];
                    parse_ascconv(asc, &mut p);
                    let mut rest = strcat_trim(&buf[..b0]);
                    rest.extend_from_slice(&buf[e + end_pat.len()..]);
                    xprot = rest;
                }
            }
        }
    }
    parse_xprot(&xprot, &mut p);
    p
}

/// `strcat` drops trailing whitespace of char arguments.
fn strcat_trim(b: &[u8]) -> Vec<u8> {
    let mut v = b.to_vec();
    while v.last().map(|&c| is_space(c) || c == 0).unwrap_or(false) {
        v.pop();
    }
    v
}

/// mapVBVD's inlined `str2num` for one ASCCONV value token.
fn eval_ascconv(tok: &str) -> PVal {
    if tok.is_empty() {
        return PVal::Num(Vec::new());
    }
    if tok.len() >= 2 && tok.starts_with('"') && tok.ends_with('"') {
        return PVal::Str(tok[1..tok.len() - 1].to_string());
    }
    match eval_number(tok) {
        Some(v) => PVal::Num(vec![v]),
        None => PVal::Str(tok.to_string()),
    }
}

fn eval_number(t: &str) -> Option<f64> {
    match t {
        "true" => return Some(1.0),
        "false" => return Some(0.0),
        _ => {}
    }
    super::common::parse_number(t)
}

/// `parse_ascconv`: every `(?<name>\S*)\s*=\s*(?<value>\S*)` match.
fn parse_ascconv(b: &[u8], p: &mut Protocol) {
    let n = b.len();
    let mut pos = 0;
    while pos < n {
        // try a match starting at pos
        let mut r = pos;
        while r < n && !is_space(b[r]) {
            r += 1;
        }
        let mut w = r;
        while w < n && is_space(b[w]) {
            w += 1;
        }
        let (name_end, eq) = if w < n && b[w] == b'=' {
            (r, w)
        } else if let Some(q) = b[pos..r].iter().rposition(|&c| c == b'=').map(|k| k + pos) {
            (q, q)
        } else {
            pos += 1;
            continue;
        };
        let mut v0 = eq + 1;
        while v0 < n && is_space(b[v0]) {
            v0 += 1;
        }
        let mut v1 = v0;
        while v1 < n && !is_space(b[v1]) {
            v1 += 1;
        }
        let name = String::from_utf8_lossy(&b[pos..name_end]).into_owned();
        let value = String::from_utf8_lossy(&b[v0..v1]).into_owned();
        assign_ascconv(&name, eval_ascconv(&value), p);
        pos = if v1 > pos { v1 } else { pos + 1 };
    }
}

/// Split an ASCCONV name the way `(?<name>\w*)\[(?<ix>[0-9]*)\]|(?<name>\w*)`
/// does and store the value under the normalised path.
fn assign_ascconv(name: &str, value: PVal, p: &mut Protocol) {
    let b = name.as_bytes();
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        // leftmost non-empty match at i
        let mut j = i;
        while j < b.len() && is_word(b[j]) {
            j += 1;
        }
        // alternative 1: \w*\[[0-9]*\]
        if j < b.len() && b[j] == b'[' {
            let mut k = j + 1;
            while k < b.len() && b[k].is_ascii_digit() {
                k += 1;
            }
            if k < b.len() && b[k] == b']' {
                let nm = &name[i..j];
                let ix = &name[j + 1..k];
                parts.push(format!("{nm}[{}]", ix.parse::<u64>().unwrap_or(0)));
                i = k + 1;
                continue;
            }
        }
        if j > i {
            parts.push(name[i..j].to_string());
            i = j;
        } else {
            i += 1;
        }
    }
    if parts.is_empty() {
        return;
    }
    for part in &parts {
        match part.as_bytes().first() {
            Some(c) if c.is_ascii_alphabetic() => {}
            _ => return, // "breaked": a component not starting with a letter
        }
    }
    let top = parts[0].split('[').next().unwrap_or("").to_string();
    p.ascconv_top.insert(top);
    p.ascconv.insert(parts.join("."), value);
}

/// mapVBVD's value cleanup and `eval` for one XProtocol parameter.
fn eval_xprot(raw: &[u8]) -> PVal {
    // regexprep(v, '("*)|( *<\w*> *[^\n]*)', ''): in Octave only the quotes go
    // (the empty first alternative always wins), then strtrim and \s+ -> ' '.
    let s: Vec<u8> = raw.iter().copied().filter(|&c| c != b'"').collect();
    let s = String::from_utf8_lossy(&s).into_owned();
    let words: Vec<&str> = s.split(|c: char| c.is_ascii_whitespace() || c == '\u{b}').filter(|w| !w.is_empty()).collect();
    let value = words.join(" ");
    if value.is_empty() {
        return PVal::Num(Vec::new());
    }
    let mut nums = Vec::with_capacity(words.len());
    for w in &words {
        for t in w.split(',').filter(|t| !t.is_empty()) {
            match eval_number(t) {
                Some(v) => nums.push(v),
                None => return PVal::Str(value),
            }
        }
    }
    PVal::Num(nums)
}

/// `parse_xprot`: the Bool/Long/String matches first, then the Double ones.
fn parse_xprot(b: &[u8], p: &mut Protocol) {
    let mut found: Vec<(String, PVal)> = Vec::new();
    for pass in 0..2 {
        let mut pos = 0;
        while let Some(at) = find(b, b"<Param", pos) {
            let mut k = at + 6;
            let ok_kind = if pass == 0 {
                let mut hit = false;
                for kind in [&b"Bool"[..], b"Long", b"String"] {
                    if b[k..].starts_with(kind) {
                        k += kind.len();
                        hit = true;
                        break;
                    }
                }
                hit
            } else if b[k..].starts_with(b"Double") {
                k += 6;
                true
            } else {
                false
            };
            if !ok_kind || !b[k..].starts_with(b".\"") {
                pos = at + 1;
                continue;
            }
            k += 2;
            let n0 = k;
            while k < b.len() && is_word(b[k]) {
                k += 1;
            }
            if k == n0 || !b[k..].starts_with(b"\">") {
                pos = at + 1;
                continue;
            }
            let name = String::from_utf8_lossy(&b[n0..k]).into_owned();
            k += 2;
            while k < b.len() && is_space(b[k]) {
                k += 1;
            }
            if k >= b.len() || b[k] != b'{' {
                pos = at + 1;
                continue;
            }
            k += 1;
            if pass == 1 {
                // \s*(<Precision>\s*[0-9]*)?\s*
                let mut m = k;
                while m < b.len() && is_space(b[m]) {
                    m += 1;
                }
                if b[m..].starts_with(b"<Precision>") {
                    m += 11;
                    while m < b.len() && is_space(b[m]) {
                        m += 1;
                    }
                    while m < b.len() && b[m].is_ascii_digit() {
                        m += 1;
                    }
                    k = m;
                }
                while k < b.len() && is_space(b[k]) {
                    k += 1;
                }
            }
            let v0 = k;
            while k < b.len() && b[k] != b'}' {
                k += 1;
            }
            let mut name = name;
            if !name.as_bytes()[0].is_ascii_alphabetic() {
                name = format!("x{name}");
            }
            found.push((name, eval_xprot(&b[v0..k])));
            pos = k.max(at + 1);
        }
    }
    for (name, v) in found {
        p.xprot.insert(name, v);
    }
}

/// `read_twix_hdr` from the header start (just after `hdr_len`).
fn read_twix_hdr(b: &Bytes, mut pos: usize) -> Res<TwixHeader> {
    let nbuffers = b.u32le(pos)? as usize;
    pos += 4;
    if nbuffers > 64 {
        return Err("This twix file's header is corrupt (implausible number of header buffers).".into());
    }
    let mut hdr = TwixHeader::default();
    for _ in 0..nbuffers {
        let name_bytes = &b.b[pos.min(b.len())..(pos + 64).min(b.len())];
        match name_bytes.iter().position(|&c| c == 0) {
            Some(nul) => {
                let name = String::from_utf8_lossy(&name_bytes[..nul]).into_owned();
                pos += nul + 1;
                let len = b.u32le(pos)? as usize;
                pos += 4;
                let raw = b.slice(pos, len)?;
                pos += len;
                let buf = delete_empty_lines(raw);
                hdr.buffers.insert(name, parse_buffer(&buf));
            }
            None => {
                // an extraordinarily long buffer name: skip to past the next nul
                let rest = &b.b[pos.min(b.len())..];
                match rest.iter().position(|&c| c == 0) {
                    Some(nul) => pos += nul + 1,
                    None => return Err("This twix file's header is corrupt (a header buffer name is never terminated).".into()),
                }
            }
        }
    }
    Ok(hdr)
}

// ------------------------------------------------------------------- MDHs

/// One imaging acquisition (an ADC with all its channels).
#[derive(Clone, Debug)]
struct Acq {
    mem_pos: usize,
    ncol: usize,
    ncha: usize,
    lc: [u16; 14],
    cut_off: [u16; 2],
    reflect: bool,
    free_param: [u16; 4],
    ice_param: [u16; 24],
}

struct Scan {
    version: &'static str, // "vb" or "vd"
    hdr: TwixHeader,
    acqs: Vec<Acq>,
}

fn byte_mdh(vd: bool) -> usize {
    if vd {
        184
    } else {
        128
    }
}

/// mapVBVD's `loop_mdh_read` + `evalMDH`, keeping the imaging scans.
fn read_mdhs(b: &Bytes, start: usize, vd: bool) -> Res<(Vec<Acq>, bool)> {
    let bm = byte_mdh(vd);
    let (ev, dma, dma_off, dma_skip) = if vd { (40, 48, 192, 32) } else { (20, 28, 0, 128) };
    // VB-layout offset -> raw offset
    let at = |o: usize| if vd && o >= 20 { o + 20 } else { o };
    let mut cpos = start;
    let mut acqs = Vec::new();
    let mut is_eof = false;
    loop {
        if cpos.checked_add(bm).map(|e| e > b.len()).unwrap_or(true) {
            is_eof = true;
            break;
        }
        let m = &b.b[cpos..cpos + bm];
        let bitmask = m[ev];
        let dma25 = |m: &[u8]| u32::from_le_bytes([m[0], m[1], m[2], m[3] & 1]) as usize;
        if (m[0] == 0 && m[1] == 0 && m[2] == 0) || bitmask & 1 != 0 {
            let l = dma25(m);
            if l == 0 || bitmask & 1 != 0 {
                break;
            }
        }
        if bitmask & 0x20 != 0 {
            let l = dma25(m);
            cpos += l.max(1);
            continue;
        }
        let ncol = u16::from_le_bytes([m[dma], m[dma + 1]]) as usize;
        let ncha = u16::from_le_bytes([m[dma + 2], m[dma + 3]]) as usize;
        let len = dma_off + (8 * ncol + dma_skip) * ncha;
        let u16at = |o: usize| u16::from_le_bytes([m[at(o)], m[at(o) + 1]]);
        let mask = u32::from_le_bytes([m[at(20)], m[at(21)], m[at(22)], m[at(23)]]);
        let bit = |k: u32| mask & (1 << k) != 0;
        let not_image = bit(0)
            || bit(1)
            || bit(2)
            || bit(21)
            || bit(25)
            || bit(15)
            || bit(14)
            || bit(5)
            || (bit(22) && !bit(23));
        if !not_image {
            let mut lc = [0u16; 14];
            for (k, v) in lc.iter_mut().enumerate() {
                *v = u16at(32 + 2 * k);
            }
            let mut ice = [0u16; 24];
            let mut free = [0u16; 4];
            if vd {
                // VB-layout 108..156 and 156..164
                for (k, v) in ice.iter_mut().enumerate() {
                    *v = u16at(108 + 2 * k);
                }
                for (k, v) in free.iter_mut().enumerate() {
                    *v = u16at(156 + 2 * k);
                }
            } else {
                for (k, v) in ice.iter_mut().take(4).enumerate() {
                    *v = u16at(80 + 2 * k);
                }
                for (k, v) in free.iter_mut().enumerate() {
                    *v = u16at(88 + 2 * k);
                }
            }
            acqs.push(Acq {
                mem_pos: cpos,
                ncol,
                ncha,
                lc,
                cut_off: [u16at(60), u16at(62)],
                reflect: bit(24),
                free_param: free,
                ice_param: ice,
            });
        }
        if len == 0 {
            // cannot advance; mapVBVD would loop forever here
            return Err("This twix file is corrupt: an acquisition header declares zero samples and zero channels.".into());
        }
        cpos += len;
    }
    Ok((acqs, is_eof))
}

fn parse_header_layout(b: &Bytes) -> Res<(bool, usize, usize)> {
    if b.b.len() < 8 {
        return Err("This file is too small to be Siemens twix raw data.".into());
    }
    let first = b.u32le(0)?;
    let second = b.u32le(4)?;
    let (vd, off) = if first < 10000 && second <= 64 {
        let nscans = second as usize;
        if nscans == 0 {
            return Err("This twix file lists no measurements.".into());
        }
        // FID-A keeps the last measurement of a multi-RAID file
        let k = nscans - 1;
        let off = b.u64le(16 + 152 * k)? as usize;
        (true, off)
    } else {
        (false, 0)
    };
    let hdr_len = b.u32le(off)? as usize;
    if hdr_len < 4 || off.checked_add(hdr_len).map(|e| e > b.b.len()).unwrap_or(true) {
        return Err("This does not look like a Siemens twix file (the measurement header length is out of range).".into());
    }
    Ok((vd, off, hdr_len))
}

/// Parse only the measurement header of a twix file (skipping the MDH scan).
pub fn parse_header(data: &[u8]) -> Res<TwixHeader> {
    let b = Bytes::new(data, "twix");
    let (_, off, _) = parse_header_layout(&b)?;
    read_twix_hdr(&b, off + 4)
}

fn parse_scan(data: &[u8]) -> Res<Scan> {
    let b = Bytes::new(data, "twix");
    let (vd, off, hdr_len) = parse_header_layout(&b)?;
    let hdr = read_twix_hdr(&b, off + 4)?;
    let (mut acqs, is_eof) = read_mdhs(&b, off + hdr_len, vd)?;
    if is_eof {
        // mapVBVD ignores the last parsed acquisition of a truncated file, then
        // tryAndFixLastMdh drops acquisitions whose data cannot be read.
        acqs.pop();
        while let Some(a) = acqs.last() {
            let (ncol, ncha) = (acqs[0].ncol, acqs[0].ncha);
            let (sh, ch) = if vd { (192, 32) } else { (0, 128) };
            if a.mem_pos + sh + ncha * (ch + 8 * ncol) <= data.len() {
                break;
            }
            acqs.pop();
        }
    }
    Ok(Scan { version: if vd { "vd" } else { "vb" }, hdr, acqs })
}

// ------------------------------------------------------------ strided view

/// A strided view of mapVBVD's full 16-d image array (column-major).
#[derive(Clone, Debug)]
struct View {
    offset: usize,
    shape: Vec<usize>,
    strides: Vec<usize>,
}

impl View {
    fn dense(shape: &[usize]) -> View {
        let mut strides = vec![1usize; shape.len()];
        for k in 1..shape.len() {
            strides[k] = strides[k - 1] * shape[k - 1];
        }
        let mut v = View { offset: 0, shape: shape.to_vec(), strides };
        v.trim();
        v
    }
    fn trim(&mut self) {
        while self.shape.len() > 2 && *self.shape.last().unwrap() == 1 {
            self.shape.pop();
            self.strides.pop();
        }
        while self.shape.len() < 2 {
            self.shape.push(1);
            self.strides.push(0);
        }
    }
    fn ndims(&self) -> usize {
        self.shape.len()
    }
    fn squeeze(mut self) -> View {
        if self.shape.len() > 2 {
            let keep: Vec<usize> = (0..self.shape.len()).filter(|&k| self.shape[k] != 1).collect();
            self.strides = keep.iter().map(|&k| self.strides[k]).collect();
            self.shape = keep.iter().map(|&k| self.shape[k]).collect();
            if self.shape.len() == 1 {
                self.shape.push(1);
                self.strides.push(0);
            }
            self.trim();
        }
        self
    }
    /// Index with `nsub` subscripts (MATLAB folds the trailing dimensions into the last).
    fn fold(mut self, nsub: usize) -> Res<View> {
        if self.shape.len() <= nsub {
            while self.shape.len() < nsub {
                self.shape.push(1);
                self.strides.push(0);
            }
            return Ok(self);
        }
        let k = nsub - 1;
        let mut n = self.shape[k];
        for j in k + 1..self.shape.len() {
            if self.shape[j] != 1 && self.strides[j] != self.strides[j - 1] * self.shape[j - 1] {
                return Err("internal error: cannot fold non-contiguous twix dimensions".into());
            }
            n *= self.shape[j];
        }
        self.shape.truncate(nsub);
        self.strides.truncate(nsub);
        self.shape[k] = n;
        Ok(self)
    }
    /// `A(..., start:step:start+step*(count-1), ...)` along 0-based `d`.
    fn range(mut self, d: usize, start: usize, step: usize, count: usize) -> Res<View> {
        while self.shape.len() <= d {
            self.shape.push(1);
            self.strides.push(0);
        }
        if count > 0 && start + step * (count - 1) >= self.shape[d] {
            return Err("internal error: twix index exceeds the data dimensions".into());
        }
        self.offset += start * self.strides[d];
        self.strides[d] *= step;
        self.shape[d] = count;
        self.trim();
        Ok(self)
    }
    /// Stack `parts` views (same shape) along a new last dimension, when they are
    /// evenly spaced in memory.
    fn stack(parts: &[View]) -> Res<View> {
        let first = &parts[0];
        let mut v = first.clone();
        let nd = v.shape.len();
        let _ = nd;
        let step = if parts.len() > 1 {
            parts[1].offset.checked_sub(first.offset).ok_or("internal error: twix stack order")?
        } else {
            0
        };
        for (i, p) in parts.iter().enumerate() {
            if p.shape != first.shape || p.strides != first.strides || p.offset != first.offset + i * step {
                return Err("internal error: twix subspectra are not evenly spaced".into());
            }
        }
        v.shape.push(parts.len());
        v.strides.push(step);
        v.trim();
        Ok(v)
    }
    fn permute(self, order: &[usize]) -> Res<View> {
        let n = order.len();
        let mut seen = vec![false; n];
        for &o in order {
            if o == 0 || o > n || seen[o - 1] {
                return Err(format!(
                    "FID-A cannot order the dimensions of this twix file (permute order {order:?}); the dimension layout is not one io_loadspec_twix supports."
                ));
            }
            seen[o - 1] = true;
        }
        if n < self.shape.len() {
            return Err(format!(
                "FID-A cannot order the dimensions of this twix file (permute order {order:?} for {} dimensions).",
                self.shape.len()
            ));
        }
        let mut shape = self.shape.clone();
        let mut strides = self.strides.clone();
        shape.resize(n, 1);
        strides.resize(n, 0);
        let mut v = View {
            offset: self.offset,
            shape: order.iter().map(|&o| shape[o - 1]).collect(),
            strides: order.iter().map(|&o| strides[o - 1]).collect(),
        };
        v.trim();
        Ok(v)
    }
    fn numel(&self) -> usize {
        self.shape.iter().product()
    }
}

/// Reads samples of the virtual 16-d array straight from the file.
struct Source<'a> {
    data: &'a [u8],
    ncol: usize,
    ncha: usize,
    scan_hdr: usize,
    chan_hdr: usize,
    /// line (dims 3..16, 0-based linear) -> acquisition
    page: Vec<u32>,
    acqs: &'a [Acq],
}

impl<'a> Source<'a> {
    fn get(&self, lin: usize) -> Complex64 {
        let col = lin % self.ncol;
        let r = lin / self.ncol;
        let cha = r % self.ncha;
        let line = r / self.ncha;
        let a = self.page[line];
        if a == u32::MAX {
            return Complex64::new(0.0, 0.0);
        }
        let acq = &self.acqs[a as usize];
        let col = if acq.reflect { self.ncol - 1 - col } else { col };
        let off = acq.mem_pos + self.scan_hdr + cha * (self.chan_hdr + 8 * self.ncol) + self.chan_hdr + 8 * col;
        let d = &self.data[off..off + 8];
        let re = f32::from_le_bytes([d[0], d[1], d[2], d[3]]);
        let im = f32::from_le_bytes([d[4], d[5], d[6], d[7]]);
        Complex64::new(re as f64, im as f64)
    }

    fn materialize(&self, v: &View) -> Vec<Complex64> {
        let total = v.numel();
        let mut out = Vec::with_capacity(total);
        if total == 0 {
            return out;
        }
        let n = v.shape.len();
        let mut idx = vec![0usize; n];
        let mut off = v.offset;
        for _ in 0..total {
            out.push(self.get(off));
            for k in 0..n {
                idx[k] += 1;
                off += v.strides[k];
                if idx[k] < v.shape[k] {
                    break;
                }
                off -= v.strides[k] * v.shape[k];
                idx[k] = 0;
            }
        }
        out
    }

    fn at(&self, v: &View, sub: &[usize]) -> Complex64 {
        let off = v.offset + sub.iter().zip(v.strides.iter()).map(|(i, s)| i * s).sum::<usize>();
        self.get(off)
    }
}

/// The twix image object (`twix_obj.image`) after `clean()`.
struct Image {
    full: [usize; 16],
}

impl Image {
    fn n(&self, name: &str) -> usize {
        self.full[DIM_NAMES.iter().position(|&d| d == name).unwrap()]
    }
    fn sqz(&self) -> (Vec<usize>, Vec<String>) {
        let mut s = Vec::new();
        let mut d = Vec::new();
        for k in 0..16 {
            if self.full[k] > 1 {
                s.push(self.full[k]);
                d.push(DIM_NAMES[k].to_string());
            }
        }
        (s, d)
    }
}

/// Result of reading a twix file: the metabolite data and, for sequences that
/// embed them (CMRR sLASER `svs_slaserVOI_dkd2`, Columbia sLASER), the water
/// reference scans (`out_w`).
#[derive(Clone, Debug)]
pub struct TwixResult {
    pub out: Spectra,
    pub out_w: Option<Spectra>,
    /// "vb", "vd" or "XA60", as io_loadspec_twix uses it.
    pub version: String,
    /// The parsed header of the measurement that was read.
    pub header: TwixHeader,
}

/// Options for [`load_with`].
#[derive(Clone, Copy, Debug, Default)]
pub struct TwixOptions {
    /// Reproduce FID-A as it runs in Octave on files whose `Meas` header has
    /// `SoftwareVersions` without "XA60" (every example file, VB17 included):
    /// io_loadspec_twix then never sets `version`, which resolves to Octave's
    /// `version()` function, so the 'vd' code paths are never taken. Off by
    /// default: the reader uses mapVBVD's 'vb'/'vd', as FID-A intends.
    pub octave_version_quirk: bool,
}

/// FID-A `io_loadspec_twix(filename)` on the bytes of a .dat file.
pub fn load(data: &[u8]) -> Res<TwixResult> {
    load_with(data, TwixOptions::default())
}

/// [`load`] with options.
pub fn load_with(data: &[u8], opts: TwixOptions) -> Res<TwixResult> {
    let scan = parse_scan(data)?;
    let acqs = &scan.acqs;
    if acqs.is_empty() {
        return Err("This twix file has no spectroscopy ADC data (it contains no imaging scans, only noise, sync or reference data).".into());
    }
    let ncol = acqs[0].ncol;
    let ncha = acqs[0].ncha;
    if ncol == 0 || ncha == 0 {
        return Err("This twix file's first acquisition has no samples or no channels.".into());
    }
    let (scan_hdr, chan_hdr) = if scan.version == "vd" { (192, 32) } else { (0, 128) };
    // twix_map_obj.clean(): sizes from the maxima of the loop counters
    let mut full = [1usize; 16];
    full[0] = ncol;
    full[1] = ncha;
    // sLC order: Lin Ave Sli Par Eco Phs Rep Set Seg Ida..Ide -> dataDims order
    let map_lc = [2usize, 5, 4, 3, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
    for a in acqs {
        for (k, &d) in map_lc.iter().enumerate() {
            full[d] = full[d].max(a.lc[k] as usize + 1);
        }
    }
    let nlines: usize = full[2..].iter().product();
    if nlines > 50_000_000 {
        return Err("This twix file's loop counters are implausibly large; the file is probably corrupt.".into());
    }
    let mut page = vec![u32::MAX; nlines];
    let need = scan_hdr + ncha * (chan_hdr + 8 * ncol);
    for (i, a) in acqs.iter().enumerate() {
        let mut sub = [0usize; 14];
        for (k, &d) in map_lc.iter().enumerate() {
            sub[d - 2] = a.lc[k] as usize;
        }
        let mut lin = 0usize;
        for k in (0..14).rev() {
            lin = lin * full[k + 2] + sub[k];
        }
        if a.mem_pos + need > data.len() {
            return Err("This twix file is truncated: an acquisition's data run past the end of the file.".into());
        }
        page[lin] = i as u32; // the last acquisition of a line wins
    }
    let image = Image { full };
    let src = Source { data, ncol, ncha, scan_hdr, chan_hdr, page, acqs };
    let hdr = &scan.hdr;

    // ---------------------------------------------------------- io_loadspec_twix
    let mut version = scan.version.to_string();
    if let Some(sv) = hdr.buffers.get("Meas").and_then(|m| if m.has("SoftwareVersions") { m.get("SoftwareVersions") } else { None }) {
        if sv.text().contains("XA60") {
            version = "XA60".into();
        } else if opts.octave_version_quirk {
            // FID-A never assigns `version` here, so the name resolves to the
            // interpreter's version() string: neither 'vd' nor 'XA60'.
            version = "interpreter".into();
        }
        // Otherwise (the default) keep mapVBVD's version, as FID-A intends: in
        // MATLAB the unassigned `version=='XA60'` comparison errors.
    }
    let (mut sqz_size, mut sqz_dims) = image.sqz();
    let sequence = hdr.text("Config", "SequenceFileName")?;
    let seq_has = |p: &str| sequence.contains(p);
    let is_special = seq_has("rm_special") || seq_has("vq_special");
    let is_jn_special = seq_has("jn_svs_special")
        || seq_has("md_Adiab_Special")
        || seq_has("md_Special")
        || seq_has("md_Inv_special")
        || seq_has("pt_svs_special_31p")
        || seq_has("md_svox_special");
    let is_hd_special = seq_has("md_dvox_special");
    let is_jn_mp = seq_has("jn_MEGA_GABA");
    let is_jn_seq = seq_has("jn_") || seq_has("md_");
    let is_wip529 = seq_has("edit_529");
    let is_wip859 = seq_has("edit_859");
    let is_minn_eja = seq_has("eja_svs_");
    let is_minn_dkd = seq_has("svs_slaserVOI_dkd2");
    let is_siemens = (seq_has("svs_se") || seq_has("svs_st")) && !seq_has("eja_svs");
    let is_universal = seq_has("smm_svs_herc");
    let is_columbia = seq_has("svs_slaser_cu");
    let v_vd = version == "vd";
    let v_xa = version == "XA60";
    let nset = image.n("Set");

    // isempty(twix_obj.hdr.MeasYaps.sWipMemBlock.alFree{8}): FID-A errors when
    // the structure or the 8th element does not exist.
    let universal_empty = if is_universal {
        let yaps = hdr.buffers.get("MeasYaps").ok_or("This twix file has no MeasYaps header.")?;
        if !yaps.ascconv_top.contains("sWipMemBlock") {
            return Err("FID-A needs sWipMemBlock.alFree[7] for the HERCULES sequence and this twix header has no sWipMemBlock.".into());
        }
        match yaps.get("sWipMemBlock.alFree[7]") {
            Some(v) => v.is_empty(),
            None => {
                let longer = yaps.ascconv.keys().any(|k| {
                    k.strip_prefix("sWipMemBlock.alFree[")
                        .and_then(|r| r.strip_suffix(']'))
                        .and_then(|n| n.parse::<usize>().ok())
                        .map(|n| n > 7)
                        .unwrap_or(false)
                });
                if !longer {
                    return Err("FID-A needs sWipMemBlock.alFree[7] for the HERCULES sequence and this twix header does not have it.".into());
                }
                true
            }
        }
    } else {
        false
    };
    let seq_string_edit = || {
        hdr.get("Config", "SequenceString").map(|v| v.text().eq_ignore_ascii_case("svs_edit")).unwrap_or(false)
    };

    let full_view = View::dense(&image.full);
    let mut fids: View;
    let split = is_special
        || (v_vd && is_jn_special)
        || (is_universal && universal_empty)
        || (v_xa && is_jn_special)
        || (v_vd && is_jn_mp && nset == 1);
    if split {
        let sq = full_view.clone().squeeze();
        let ave_ix = sqz_dims.iter().position(|d| d == "Ave");
        if ncol > 1 && ncha > 1 {
            if is_jn_seq && seq_string_edit() && v_xa {
                // XA60 svs_edit: sum(squeezedData(:,1,2,1)) ~= 0 ?
                let v4 = sq.clone().fold(4)?;
                if v4.shape[2] < 2 {
                    return Err("This XA60 svs_edit twix file has fewer than two averages.".into());
                }
                let mut s = Complex64::new(0.0, 0.0);
                for c in 0..v4.shape[0] {
                    s += src.at(&v4, &[c, 0, 1, 0]);
                }
                if s != Complex64::new(0.0, 0.0) {
                    fids = sq;
                } else {
                    let n = v4.shape[2];
                    let h = n / 2;
                    let a = v4.clone().range(3, 0, 1, 1)?.fold(3)?.range(2, 0, 2, h)?;
                    let b = v4.clone().range(3, 1, 1, 1)?.fold(3)?.range(2, 1, 2, h)?;
                    fids = View::stack(&[a, b])?;
                    sqz_size = vec![sqz_size[0], sqz_size[1], sqz_size.get(2).copied().unwrap_or(1) / 2, 2];
                }
                sqz_dims.pop();
            } else {
                let v3 = sq.clone().fold(3)?;
                let n = v3.shape[2];
                let h = n / 2;
                let a = v3.clone().range(2, 0, 2, h)?;
                let b = v3.clone().range(2, 1, 2, h)?;
                fids = View::stack(&[a, b])?;
                let ave_n = ave_ix.and_then(|k| sqz_size.get(k).copied());
                match ave_n {
                    Some(na) if na > 2 => {
                        sqz_size = vec![sqz_size[0], sqz_size[1], sqz_size.get(2).copied().unwrap_or(1) / 2, 2];
                    }
                    _ => {
                        if h != 1 {
                            // data(:,:,1)=squeezedData(:,:,1:2:end-1) is nonconformant in FID-A
                            return Err(format!(
                                "FID-A cannot split this SPECIAL/MEGA twix file into subspectra: it has {n} transients but no 'Ave' loop longer than 2."
                            ));
                        }
                        sqz_size = vec![sqz_size[0], sqz_size[1], 2];
                        sqz_dims.truncate(2);
                    }
                }
            }
        } else if ncol > 1 && ncha == 1 {
            if is_jn_seq && seq_string_edit() && v_xa {
                let v3 = sq.clone().fold(3)?;
                let mut s = Complex64::new(0.0, 0.0);
                if v3.shape[1] < 2 {
                    return Err("This XA60 svs_edit twix file has fewer than two averages.".into());
                }
                for c in 0..v3.shape[0] {
                    s += src.at(&v3, &[c, 1, 0]);
                }
                if s != Complex64::new(0.0, 0.0) {
                    fids = sq;
                } else {
                    let n = v3.shape[1];
                    let h = n / 2;
                    let a = v3.clone().range(2, 0, 1, 1)?.fold(2)?.range(1, 0, 2, h)?;
                    let b = v3.clone().range(2, 1, 1, 1)?.fold(2)?.range(1, 1, 2, h)?;
                    fids = View::stack(&[a, b])?;
                    sqz_size = vec![sqz_size[0], sqz_size.get(1).copied().unwrap_or(1) / 2, 2];
                }
            } else {
                let v2 = sq.clone().fold(2)?;
                let n = v2.shape[1];
                let h = n / 2;
                let a = v2.clone().range(1, 0, 2, h)?;
                let b = v2.clone().range(1, 1, 2, h)?;
                fids = View::stack(&[a, b])?;
                sqz_size = vec![sqz_size[0], sqz_size.get(1).copied().unwrap_or(1) / 2, 2];
            }
        } else {
            return Err("This SPECIAL/MEGA twix file has a single sample per ADC, which FID-A cannot split.".into());
        }
        sqz_dims.push(if is_jn_seq { "Set".into() } else { "Ida".into() });
    } else if is_hd_special {
        let sq = full_view.clone().squeeze();
        let nsub = if ncol > 1 && ncha > 1 {
            3
        } else if ncol > 1 && ncha == 1 {
            2
        } else {
            return Err("This dual-voxel SPECIAL twix file has a single sample per ADC.".into());
        };
        let v = sq.fold(nsub)?;
        let n = v.shape[nsub - 1];
        let q = n / 4;
        let parts: Vec<View> = (0..4).map(|k| v.clone().range(nsub - 1, k, 4, q)).collect::<Res<_>>()?;
        fids = View::stack(&parts)?;
        if nsub == 3 {
            sqz_size = vec![sqz_size[0], sqz_size[1], sqz_size.get(2).copied().unwrap_or(1) / 4, 4];
        } else {
            sqz_size = vec![sqz_size[0], sqz_size.get(1).copied().unwrap_or(1) / 4, 4];
        }
        sqz_dims.push(if is_jn_seq { "Set".into() } else { "Ida".into() });
    } else {
        fids = full_view.clone();
    }
    let _ = &sqz_size;

    fids = fids.squeeze();

    if is_siemens && v_vd && sqz_dims.last().map(|d| d == "Phs").unwrap_or(false) {
        sqz_dims.pop();
        sqz_size.pop();
        let nd = fids.ndims();
        if (2..=4).contains(&nd) {
            if fids.shape[nd - 1] < 2 {
                return Err("This Siemens PRESS/STEAM twix file has a 'Phs' loop of length 1.".into());
            }
            fids = fids.range(nd - 1, 1, 1, 1)?.squeeze();
        }
    }

    let seq = sequence.clone();
    let bo = hdr.num("Dicom", "flMagneticFieldStrength")?;
    let n_averages = if v_xa { hdr.num("Meas", "lAverages") } else { hdr.num("Meas", "Averages") };
    let te = hdr.num("MeasYaps", "alTE[0]")?;
    let seq_low = seq.to_ascii_lowercase();
    let is_steam = seq_low.contains("steam") || seq_low.contains("svs_st");
    let tm = if is_steam {
        hdr.num("MeasYaps", "alTD[0]").ok().filter(|&v| v.is_finite() && v > 0.0).map(|v| v / 1000.0)
    } else {
        None
    };
    let tr = hdr.num("MeasYaps", "alTR[0]")?;

    let mut w_refs = false;
    let mut fids_w: Option<View> = None;
    if is_minn_dkd {
        let mut nrefs = hdr.num("MeasYaps", "sSpecPara.lAutoRefScanNo")? as usize;
        if nrefs == 1 {
            nrefs = 0;
        }
        if nrefs > 0 {
            w_refs = true;
        }
        let navg = n_averages? as usize;
        let nd = fids.ndims();
        if (2..=4).contains(&nd) {
            let d = nd - 1;
            let len = fids.shape[d];
            if nrefs + navg > len {
                return Err(format!(
                    "This CMRR sLASER twix file has {len} acquisitions, fewer than its {navg} averages plus {nrefs} water references."
                ));
            }
            let w = fids.clone().range(d, len - nrefs, 1, nrefs)?;
            fids = fids.range(d, len - nrefs - navg, 1, navg)?;
            fids_w = Some(w);
        }
    }
    if is_columbia {
        let nd = fids.ndims();
        let nrefs;
        if nd == 4 {
            let mut c = 0;
            for k in 0..fids.shape[2] {
                if src.at(&fids, &[0, 0, k, 0]) != Complex64::new(0.0, 0.0) {
                    c += 1;
                }
            }
            nrefs = c;
            sqz_dims.truncate(3);
        } else if nd == 3 {
            let mut c = 0;
            for k in 0..fids.shape[1] {
                if src.at(&fids, &[0, k, 0]) != Complex64::new(0.0, 0.0) {
                    c += 1;
                }
            }
            nrefs = c;
            sqz_dims.truncate(2);
        } else {
            return Err("This Columbia sLASER twix file has an unexpected layout (FID-A expects 3 or 4 dimensions).".into());
        }
        if nrefs > 0 {
            w_refs = true;
        }
        if nd == 4 {
            if fids.shape[3] < 2 {
                return Err("This Columbia sLASER twix file has no metabolite block.".into());
            }
            fids_w = Some(fids.clone().range(2, 0, 1, nrefs)?.range(3, 0, 1, 1)?);
            fids = fids.range(3, 1, 1, 1)?;
        } else {
            if fids.shape[2] < 2 {
                return Err("This Columbia sLASER twix file has no metabolite block.".into());
            }
            fids_w = Some(fids.clone().range(1, 0, 1, nrefs)?.range(2, 0, 1, 1)?);
            fids = fids.range(2, 1, 1, 1)?;
        }
    }

    // -------------------------------------------------------- dimension indexing
    // find(strcmp(sqzDims, name)); a name listed twice makes FID-A's index
    // arithmetic fail, so it is an error here.
    for (i, d) in sqz_dims.iter().enumerate() {
        if sqz_dims[..i].contains(d) {
            return Err(format!(
                "FID-A cannot index the dimensions of this twix file: '{d}' appears twice in {sqz_dims:?}."
            ));
        }
    }
    let find = |name: &str| sqz_dims.iter().position(|d| d == name).map(|k| k + 1);
    let mut to_index: Vec<usize> = (1..=sqz_dims.len()).collect();
    let mut dims = Dims::default();
    dims.t = find("Col").ok_or("ERROR:  Spectrom contains no time domain information!! (this twix file has no 'Col' dimension)")?;
    to_index.retain(|&d| d != dims.t);
    dims.coils = find("Cha").unwrap_or(0);
    if dims.coils != 0 {
        to_index.retain(|&d| d != dims.coils);
    }
    let vdx = v_vd || v_xa;
    let avg = if vdx {
        if is_minn_eja || is_minn_dkd {
            find("Set")
        } else {
            find("Ave")
        }
    } else {
        find("Set")
    };
    dims.averages = match avg {
        Some(a) => {
            to_index.retain(|&d| d != a);
            a
        }
        None => match find("Rep") {
            Some(r) => {
                to_index.retain(|&d| d != r);
                r
            }
            None => 0,
        },
    };
    if !to_index.is_empty() {
        let ss = if is_jn_seq || is_special {
            if vdx {
                find("Set")
            } else {
                find("Ida")
            }
        } else if is_wip529 || is_minn_eja {
            find("Eco")
        } else if is_wip859 {
            find("Ide")
        } else {
            Some(to_index[0])
        };
        dims.sub_specs = match ss {
            Some(s) => {
                to_index.retain(|&d| d != s);
                s
            }
            None => 0,
        };
    }
    if !to_index.is_empty() {
        dims.extras = to_index[0];
    }

    let (t, c, a, s, e) = (dims.t, dims.coils, dims.averages, dims.sub_specs, dims.extras);
    let apply = |order: &[usize], nd: Dims, fids: &mut View, fids_w: &mut Option<View>| -> Res<Dims> {
        *fids = fids.clone().permute(order)?;
        if w_refs {
            if let Some(w) = fids_w.take() {
                *fids_w = Some(w.permute(order)?);
            }
        }
        Ok(nd)
    };
    let dd = |t, c, a, s, e| Dims { t, coils: c, averages: a, sub_specs: s, extras: e };
    match sqz_dims.len() {
        5 => dims = apply(&[t, c, a, s, e], dd(1, 2, 3, 4, 5), &mut fids, &mut fids_w)?,
        4 => {
            if e == 0 {
                dims = apply(&[t, c, a, s], dd(1, 2, 3, 4, 0), &mut fids, &mut fids_w)?;
            } else if s == 0 {
                dims = apply(&[t, c, a, e], dd(1, 2, 3, 0, 4), &mut fids, &mut fids_w)?;
            } else if a == 0 {
                // FID-A's typo `dims;averages=0;` leaves dims.averages as it was (0)
                dims = apply(&[t, c, s, e], dd(1, 2, a, 3, 4), &mut fids, &mut fids_w)?;
            } else if c == 0 {
                dims = apply(&[t, a, s, e], dd(1, 0, 2, 3, 4), &mut fids, &mut fids_w)?;
            }
        }
        3 => {
            if e == 0 && s == 0 {
                dims = apply(&[t, c, a], dd(1, 2, 3, 0, 0), &mut fids, &mut fids_w)?;
            } else if e == 0 && a == 0 {
                dims = apply(&[t, c, s], dd(1, 2, 0, 3, 0), &mut fids, &mut fids_w)?;
            } else if e == 0 && c == 0 {
                dims = apply(&[t, a, s], dd(1, 0, 2, 3, 0), &mut fids, &mut fids_w)?;
            }
        }
        2 => {
            if e == 0 && s == 0 && a == 0 {
                dims = apply(&[t, c], dd(1, 2, 0, 0, 0), &mut fids, &mut fids_w)?;
            } else if e == 0 && s == 0 && c == 0 {
                dims = apply(&[t, a], dd(1, 0, 2, 0, 0), &mut fids, &mut fids_w)?;
            } else if e == 0 && a == 0 && c == 0 {
                dims = apply(&[t, s], dd(1, 0, 0, 2, 0), &mut fids, &mut fids_w)?;
            }
        }
        1 => {
            // permute(fids,[dims.t]) on a column is the identity
            if t != 1 {
                return Err("FID-A cannot order the dimensions of this twix file.".into());
            }
            dims = dd(1, 0, 0, 0, 0);
        }
        _ => {}
    }

    let sz = fids.shape.clone();
    let sz_w = fids_w.as_ref().map(|w| w.shape.clone());

    let dwell_ns = hdr.num("MeasYaps", "sRXSPEC.alDwellTime[0]")?;
    let dwelltime = dwell_ns * 1e-9;
    let spectralwidth = 1.0 / dwelltime;
    let txfrq = if v_xa {
        hdr.num("MeasYaps", "sTXSPEC.asNucleusInfo[0].lFrequency")?
    } else {
        hdr.num("Config", "Frequency")?
    };

    let g = |v: &[usize], d: usize| v.get(d - 1).copied().unwrap_or(1);
    let (averages, raw_averages) = if dims.sub_specs != 0 {
        if dims.averages != 0 {
            let x = g(&sz, dims.averages) * g(&sz, dims.sub_specs);
            (x, x)
        } else {
            (g(&sz, dims.sub_specs), g(&sz, dims.sub_specs))
        }
    } else if dims.averages != 0 {
        (g(&sz, dims.averages), g(&sz, dims.averages))
    } else {
        (1, 1)
    };
    let (averages_w, raw_averages_w) = match &sz_w {
        Some(w) => {
            if dims.sub_specs != 0 {
                if dims.averages != 0 {
                    let x = g(w, dims.averages) * g(w, dims.sub_specs);
                    (x, x)
                } else {
                    (g(w, dims.sub_specs), g(&sz, dims.sub_specs))
                }
            } else if dims.averages != 0 {
                (g(w, dims.averages), g(w, dims.averages))
            } else {
                (1, 1)
            }
        }
        None => (1, 1),
    };
    let subspecs = if dims.sub_specs != 0 { g(&sz, dims.sub_specs) } else { 1 };

    let first = &acqs[0];
    let leftshift = if is_wip529 || is_wip859 || (is_siemens && sequence.contains("svs_se")) {
        first.cut_off[0] as f64
    } else if is_siemens {
        if v_xa {
            0.0
        } else {
            first.free_param[0] as f64
        }
    } else if is_minn_eja || is_minn_dkd {
        // iceParam(5,1): a VB mdh has only 4 ICE parameters and FID-A errors
        if scan.version == "vd" {
            first.ice_param[4] as f64
        } else {
            return Err("FID-A reads the CMRR leftshift from ICE parameter 5, which this VB twix file does not have.".into());
        }
    } else if is_jn_seq || is_jn_special || is_jn_mp {
        0.0
    } else {
        first.free_param[0] as f64
    };

    let nucleus = if v_xa {
        hdr.text("MeasYaps", "sTXSPEC.asNucleusInfo[0].tNucleus")?
    } else {
        hdr.text("Config", "Nucleus")?
    };
    let n = sz[0];
    let f = octave_range(
        (-spectralwidth / 2.0) + (spectralwidth / (2.0 * n as f64)),
        spectralwidth / n as f64,
        (spectralwidth / 2.0) - (spectralwidth / (2.0 * n as f64)),
    );
    let (gamma, offset) = match nucleus.as_str() {
        "1H" => (42.576, 4.65),
        "31P" => (17.235, 0.0),
        "13C" => (10.7084, 0.0),
        other => {
            return Err(format!("FID-A's twix reader supports the nuclei 1H, 31P and 13C; this file is {other}."));
        }
    };
    let ppm: Vec<f64> = f.iter().map(|&x| -x / (bo * gamma) + offset).collect();
    let t_axis = time_axis(dwelltime, n);

    let make = |v: &View, sz: Vec<usize>, averages: usize, raw_averages: usize| -> Spectra {
        let mut flags = fresh_flags();
        flags.is_four_steps = dims.sub_specs != 0 && sz.get(dims.sub_specs - 1).copied() == Some(4);
        Spectra {
            fids: src.materialize(v),
            sz,
            dims,
            ppm: ppm.clone(),
            t: t_axis.clone(),
            spectralwidth,
            dwelltime,
            txfrq,
            te: te / 1000.0,
            tm,
            tr: tr / 1000.0,
            bo,
            seq: seq.clone(),
            date: String::new(),
            averages,
            raw_averages,
            subspecs,
            raw_subspecs: subspecs,
            points_to_leftshift: leftshift,
            flags,
            nucleus: nucleus.clone(),
        }
    };
    let out = make(&fids, sz.clone(), averages, raw_averages);
    let out_w = if w_refs {
        let w = fids_w.as_ref().ok_or("internal error: water references expected")?;
        let mut sw = make(w, w.shape.clone(), averages_w, raw_averages_w);
        // FID-A's out_w isFourSteps line references an undefined variable; it
        // is only reached with subspectra, so keep the flag computed as for out.
        sw.flags.is_four_steps = dims.sub_specs != 0 && sw.sz.get(dims.sub_specs - 1).copied() == Some(4);
        Some(sw)
    } else {
        None
    };
    Ok(TwixResult { out, out_w, version, header: scan.hdr })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xprot_values() {
        let mut p = Protocol::default();
        parse_xprot(
            br#"<ParamString."SequenceFileName">  { "%SiemensSeq%\svs_se"  }
<ParamLong."Frequency">  { 123247115  }
<ParamDouble."flMagneticFieldStrength">  { <Precision> 16  2.89362000000000 }
<ParamLong."Frequency">  { 5  }"#,
            &mut p,
        );
        assert_eq!(p.get("SequenceFileName"), Some(&PVal::Str("%SiemensSeq%\\svs_se".into())));
        assert_eq!(p.get("Frequency").unwrap().num(), Some(5.0));
        assert_eq!(p.get("flMagneticFieldStrength").unwrap().num(), Some(2.89362));
    }

    #[test]
    fn ascconv_values() {
        let mut p = Protocol::default();
        parse_ascconv(
            b"sRXSPEC.alDwellTime[0]                   = 250000\nalTE[0] = 8500\nsTXSPEC.asNucleusInfo[0].tNucleus = \"1H\"\nx=0x1a\n",
            &mut p,
        );
        assert_eq!(p.get("sRXSPEC.alDwellTime[0]").unwrap().num(), Some(250000.0));
        assert_eq!(p.get("alTE[0]").unwrap().num(), Some(8500.0));
        assert_eq!(p.get("sTXSPEC.asNucleusInfo[0].tNucleus"), Some(&PVal::Str("1H".into())));
        assert_eq!(p.get("x").unwrap().num(), Some(26.0));
    }

    #[test]
    fn empty_lines() {
        assert_eq!(delete_empty_lines(b"a\n  \n\nb\nc"), b"ab\nc".to_vec());
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(load(&[]).is_err());
        assert!(load(&[1, 2, 3, 4, 5, 6, 7, 8, 9]).is_err());
        let mut v = vec![0u8; 4096];
        v[0] = 200;
        assert!(load(&v).is_err());
    }
}
