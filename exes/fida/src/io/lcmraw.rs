//! LCModel .RAW / .H2O input: FID-A `io_readlcmraw(filename, type)`.
//!
//! `type` selects the header FID-A expects: `Dat` for files written by
//! `io_writelcm` (the `$SEQPAR` namelist with hzpppm, NumberOfPoints and
//! dwellTime), `Raw` for the simulation header of `io_writelcmraw` (Sweep
//! Width / Vector Size / B0 Field), `Sim` for LCModel simulations (2048 points
//! at 2000 Hz, reversed ppm axis). As in FID-A the stored pairs are
//! conjugated back (`out.fids = RF'`).

use super::common::{fresh_flags, octave_range, str2num, time_axis, Res};
use crate::spectra::{Dims, Spectra};
use num_complex::Complex64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RawType {
    Dat,
    Raw,
    Sim,
    Rda,
}

/// C `strtod`-style scan of every leading number on a line, as `sscanf(line, '%f', inf)`.
/// Returns the numbers and whether the scan stopped on something that is not
/// a number (Octave's `errmsg`).
pub fn sscanf_f(line: &str) -> (Vec<f64>, bool) {
    let b = line.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    loop {
        while i < b.len() && (b[i] as char).is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return (out, false);
        }
        let start = i;
        let mut j = i;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let rest = &line[j..];
        let lower = rest.to_ascii_lowercase();
        let special = if lower.starts_with("inf") {
            Some((3, f64::INFINITY))
        } else if lower.starts_with("nan") {
            Some((3, f64::NAN))
        } else {
            None
        };
        if let Some((len, v)) = special {
            let neg = b[start] == b'-';
            out.push(if neg { -v } else { v });
            i = j + len;
            continue;
        }
        let mut digits = 0;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
            digits += 1;
        }
        if j < b.len() && b[j] == b'.' {
            j += 1;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
                digits += 1;
            }
        }
        if digits == 0 {
            return (out, true);
        }
        if j < b.len() && (b[j] == b'e' || b[j] == b'E') {
            let mut k = j + 1;
            if k < b.len() && (b[k] == b'+' || b[k] == b'-') {
                k += 1;
            }
            let k0 = k;
            while k < b.len() && b[k].is_ascii_digit() {
                k += 1;
            }
            if k > k0 {
                j = k;
            }
        }
        match line[start..j].parse::<f64>() {
            Ok(v) => out.push(v),
            Err(_) => return (out, true),
        }
        i = j;
    }
}

struct Lines<'a> {
    lines: Vec<&'a str>,
    pos: usize,
}

impl<'a> Lines<'a> {
    /// `fgets`: the next line, or None at end of file.
    fn next(&mut self) -> Option<&'a str> {
        let l = self.lines.get(self.pos).copied();
        if l.is_some() {
            self.pos += 1;
        }
        l
    }
    /// `while isempty(findstr(line, pat)) line = fgets(fid); end`
    fn find_from(&mut self, cur: &'a str, pat: &str, what: &str) -> Res<&'a str> {
        let mut line = cur;
        while !line.contains(pat) {
            line = self.next().ok_or_else(|| format!("This LCModel file has no '{pat}' line ({what})."))?;
        }
        Ok(line)
    }
}

/// MATLAB `line(a:b)` (1-based, inclusive; `b` = None for `end`), erroring
/// like MATLAB when the line is too short.
fn sub(line: &str, a: usize, b: Option<usize>, field: &str) -> Res<String> {
    let chars: Vec<char> = line.chars().collect();
    let end = b.unwrap_or(chars.len());
    if end > chars.len() || a == 0 {
        return Err(format!("The LCModel header line for {field} is too short: {:?}", line.trim_end()));
    }
    if a > end {
        return Ok(String::new());
    }
    Ok(chars[a - 1..end].iter().collect())
}

fn num(s: &str, field: &str) -> Res<f64> {
    match str2num(s) {
        Some(v) if !v.is_empty() => Ok(v[0]),
        _ => Err(format!("The LCModel header value for {field} is not a number: {:?}", s.trim())),
    }
}

/// FID-A `io_readlcmraw` on the bytes of a .RAW/.H2O file.
pub fn load(data: &[u8], kind: RawType) -> Res<Spectra> {
    let text = String::from_utf8_lossy(data);
    let mut l = Lines { lines: text.split_inclusive('\n').collect(), pos: 0 };
    let first = l.next().ok_or("This LCModel file is empty.")?;
    let (bo, hzpppm, vectorsize, spectralwidth, dwelltime, mut line);
    let mut echot = f64::NAN;
    match kind {
        RawType::Rda | RawType::Sim => {
            let ln = l.find_from(first, "hzpppm", "field strength")?;
            let hz = num(&sub(ln, 9, None, "hzpppm")?, "hzpppm")?;
            hzpppm = hz;
            bo = hz / 42.5939971;
            let mut cur = ln;
            for _ in 0..4 {
                cur = l.next().ok_or("This LCModel file ends inside its header.")?;
            }
            line = cur;
            vectorsize = 2048usize;
            spectralwidth = 2000.0;
            if kind == RawType::Rda {
                // FID-A's 'rda' branch never sets dwelltime and fails computing t
                return Err("FID-A's io_readlcmraw 'rda' type does not define a dwell time; read this file as 'sim' or 'dat'.".into());
            }
            dwelltime = 1.0 / spectralwidth;
        }
        RawType::Dat => {
            let ln = l.find_from(first, "hzpppm", "field strength")?;
            let hz = num(&sub(ln, 9, None, "hzpppm")?, "hzpppm")?;
            hzpppm = hz;
            bo = hz / 42.5939971;
            if let Some(e) = l.lines[..l.pos].iter().rev().find(|x| x.contains("echot=")) {
                if let Some((_, v)) = e.split_once("echot=") {
                    echot = str2num(v).and_then(|v| v.first().copied()).unwrap_or(f64::NAN);
                }
            }
            let ln = l.find_from(ln, "NumberOfPoints", "number of points")?;
            let vs = num(&sub(ln, 17, None, "NumberOfPoints")?, "NumberOfPoints")?;
            if !(vs >= 1.0 && vs.fract() == 0.0 && vs < 1e8) {
                return Err(format!("This LCModel file declares {vs} points."));
            }
            vectorsize = vs as usize;
            let ln = l.find_from(ln, "dwellTime", "dwell time")?;
            dwelltime = num(&sub(ln, 12, None, "dwellTime")?, "dwellTime")?;
            spectralwidth = 1.0 / dwelltime;
            let _ = l.next().ok_or("This LCModel file ends inside its header.")?;
            line = l.next().ok_or("This LCModel file ends inside its header.")?;
        }
        RawType::Raw => {
            let ln = l.find_from(first, "Sweep Width", "sweep width")?;
            spectralwidth = num(&sub(ln, 16, Some(24), "Sweep Width")?, "Sweep Width")?;
            dwelltime = 1.0 / spectralwidth;
            let ln = l.find_from(ln, "Vector Size", "vector size")?;
            let vs = num(&sub(ln, 16, Some(20), "Vector Size")?, "Vector Size")?;
            if !(vs >= 1.0 && vs.fract() == 0.0 && vs < 1e8) {
                return Err(format!("This LCModel file declares {vs} points."));
            }
            vectorsize = vs as usize;
            let ln = l.find_from(ln, "B0 Field", "field strength")?;
            bo = num(&sub(ln, 16, Some(21), "B0 Field")?, "B0 Field")?;
            hzpppm = bo * 42.5939971;
            line = ln;
        }
    }
    line = l.find_from(line, "$END", "end of the namelist")?;
    let _ = line;
    let mut rf: Vec<Complex64> = Vec::new();
    while let Some(ln) = l.next() {
        let (a, err) = sscanf_f(ln);
        if err {
            return Err(format!("READLCMRAW failed with read error: line {} is not numeric: {:?}", l.pos, ln.trim_end()));
        }
        if a.len() < 2 {
            return Err(format!("This LCModel file's data line {} does not hold a real and an imaginary value.", l.pos));
        }
        rf.push(Complex64::new(a[0], 0.0) + Complex64::new(0.0, 1.0) * a[1]);
    }
    if rf.len() != vectorsize {
        return Err(format!(
            "This LCModel file declares {vectorsize} points but holds {} data lines (FID-A reads one complex point per line).",
            rf.len()
        ));
    }
    let fids: Vec<Complex64> = rf.iter().map(|z| z.conj()).collect();
    let n = vectorsize as f64;
    let f = octave_range(
        (-spectralwidth / 2.0) + (spectralwidth / (2.0 * n)),
        spectralwidth / n,
        (spectralwidth / 2.0) - (spectralwidth / (2.0 * n)),
    );
    let a = if kind == RawType::Sim { -1.0 } else { 1.0 };
    let ppm: Vec<f64> = f.iter().map(|&x| a * -x / (bo * 42.577) + 4.65).collect();
    let mut flags = fresh_flags();
    flags.leftshifted = true;
    flags.averaged = true;
    flags.addedrcvrs = true;
    flags.subtracted = true;
    flags.writtentotext = true;
    Ok(Spectra {
        fids,
        sz: vec![vectorsize, 1],
        dims: Dims { t: 1, ..Dims::default() },
        ppm,
        t: time_axis(dwelltime, vectorsize),
        spectralwidth,
        dwelltime: 1.0 / spectralwidth,
        txfrq: hzpppm * 1e6,
        // FID-A sets no te/tr here; the echot of an io_writelcm header is kept
        te: if echot.is_finite() { echot } else { 0.0 },
        tm: None,
        tr: 0.0,
        bo,
        seq: String::new(),
        date: String::new(),
        averages: 1,
        raw_averages: 1,
        subspecs: 1,
        raw_subspecs: 1,
        points_to_leftshift: 0.0,
        flags,
        nucleus: "1H".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_numbers() {
        assert_eq!(sscanf_f("  1.5e+00  -2.000000e-01\n"), (vec![1.5, -0.2], false));
        assert_eq!(sscanf_f("-1.234560E+02-2.000000E+00"), (vec![-123.456, -2.0], false));
        assert_eq!(sscanf_f(" 1 x"), (vec![1.0], true));
    }

    #[test]
    fn round_trip_with_writer() {
        let mut s = Spectra {
            sz: vec![3, 1],
            fids: vec![Complex64::new(1.0, 2.0), Complex64::new(-3.5, 0.25), Complex64::new(0.0, -1e-3)],
            txfrq: 123.2e6,
            dwelltime: 0.00025,
            ..Default::default()
        };
        s.flags.addedrcvrs = true;
        s.flags.averaged = true;
        let text = crate::io::lcm::lcm_text(&s, 30.0).unwrap();
        let r = load(text.as_bytes(), RawType::Dat).unwrap();
        assert_eq!(r.sz, vec![3, 1]);
        for (a, b) in r.fids.iter().zip(s.fids.iter()) {
            assert!((a - b).norm() < 1e-6 * b.norm().max(1e-3));
        }
        assert_eq!(r.te, 30.0);
        assert!(load(b"garbage", RawType::Dat).is_err());
        assert!(load(b"", RawType::Raw).is_err());
    }
}
