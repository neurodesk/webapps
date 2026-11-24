//! LCModel .RAW / .H2O output: FID-A `io_writelcm`.
//!
//! The same function writes metabolite (.RAW) and water (.H2O) files. As in
//! FID-A, the first FID is written as (real, -imag) pairs (LCModel's
//! conjugate convention), with the `$SEQPAR` and `$NMID` namelists FID-A
//! writes (seq='PRESS', fmtdat='(2E15.6)', volume=8.0, tramp=1.0).
//!
//! Every number occupies exactly 15 characters, because LCModel reads the
//! data with FMTDAT='(2E15.6)'. FID-A's `'  % 7.6e'` already gives 15
//! characters for two-digit exponents, and the output is byte-identical to
//! FID-A there; for a three-digit exponent (|x| >= 1e100 or < 1e-99) FID-A
//! writes 16 characters and shifts the columns, so one leading blank is
//! dropped instead.

use super::common::Res;
use crate::spectra::Spectra;

/// C/MATLAB `%.{prec}e` (exponent with sign and at least two digits).
pub fn c_exp(x: f64, prec: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Inf".into() } else { "-Inf".into() };
    }
    let s = format!("{:.*e}", prec, x);
    let (mant, exp) = s.split_once('e').unwrap_or((&s, "0"));
    let e: i32 = exp.parse().unwrap_or(0);
    let sign = if e < 0 { '-' } else { '+' };
    format!("{mant}e{sign}{:02}", e.abs())
}

/// C `% 7.6e`: a blank where the sign of a non-negative number would go.
fn space_exp(x: f64) -> String {
    let s = c_exp(x, 6);
    let s = if s.starts_with('-') { s } else { format!(" {s}") };
    if s.len() < 7 {
        format!("{s:>7}")
    } else {
        s
    }
}

/// One `E15.6`-compatible field: FID-A's `'  % 7.6e'`, right-aligned in 15.
pub fn field15(x: f64) -> String {
    let s = space_exp(x);
    if s.len() <= 13 {
        format!("{:>15}", format!("  {s}"))
    } else {
        format!("{s:>15}")
    }
}

/// C `%.{prec}f`.
fn c_fixed(x: f64, prec: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Inf".into() } else { "-Inf".into() };
    }
    format!("{:.*}", prec, x)
}

/// Why FID-A refuses to write, or warns.
fn check(s: &Spectra) -> Res<Vec<String>> {
    if s.flags.is_four_steps {
        return Err("ERROR:  Must first combine four subspecs using op_fourStepCombine".into());
    }
    if !s.flags.addedrcvrs {
        return Err("ERROR:  reciever channels must be combined first".into());
    }
    if s.n() == 0 || s.fids.len() < s.n() {
        return Err("There are no data points to write.".into());
    }
    let mut warnings = Vec::new();
    if !s.flags.averaged {
        warnings.push("WARNING:  Signals must be averaged first".to_string());
    }
    Ok(warnings)
}

/// The text FID-A's `io_writelcm(in, outfile, te)` writes, with any warnings
/// FID-A prints (e.g. data not averaged). `te` is the echo time in ms.
pub fn lcm_text_with_warnings(s: &Spectra, te: f64) -> Res<(String, Vec<String>)> {
    lcm_text_with_seq(s, te, "PRESS")
}

/// Like [`lcm_text_with_warnings`], recording `seq` in `$SEQPAR` (e.g. `"STEAM"`,
/// `"PRESS"`, `"sLASER"`, `"SPECIAL"`, `"MEGA-PRESS"`). LCModel's `MYBASI 11`
/// checks `$SEQPAR` `seq` against the basis set's `SEQ` and warns on a
/// PRESS/STEAM mismatch, so passing the dataset's sequence family avoids
/// spurious diagnostics on STEAM data and preserves `seq` for the app's `.RAW`
/// import path (FID-A's native `io_readlcmraw` leaves `seq` empty).
pub fn lcm_text_with_seq(s: &Spectra, te: f64, seq: &str) -> Res<(String, Vec<String>)> {
    let warnings = check(s)?;
    let n = s.n();
    let seq = if seq.trim().is_empty() { "PRESS" } else { seq.trim() };
    let quoted_seq = seq.replace('\'', "''");
    let mut out = String::with_capacity(200 + 32 * n);
    out.push_str(" $SEQPAR");
    out.push_str(&format!("\n echot= {}", c_fixed(te, 2)));
    out.push_str(&format!("\n seq= '{quoted_seq}'"));
    out.push_str(&format!("\n hzpppm= {}", c_fixed(s.txfrq / 1e6, 6)));
    out.push_str(&format!("\n NumberOfPoints= {n}"));
    out.push_str(&format!("\n dwellTime= {}", c_fixed(s.dwelltime, 6)));
    out.push_str("\n $END");
    out.push_str("\n $NMID");
    out.push_str("\n id='ANONYMOUS ', fmtdat='(2E15.6)'");
    out.push_str("\n volume=8.0");
    out.push_str("\n tramp=1.0");
    out.push_str("\n $END\n");
    for z in &s.fids[..n] {
        out.push_str(&field15(z.re));
        out.push_str(&field15(-z.im));
        out.push('\n');
    }
    Ok((out, warnings))
}

/// The .RAW/.H2O text for `s` (FID-A `io_writelcm`); `te` in ms.
pub fn lcm_text(s: &Spectra, te: f64) -> Res<String> {
    lcm_text_with_warnings(s, te).map(|(t, _)| t)
}

/// Write the .RAW/.H2O file to any writer (FID-A `io_writelcm`); `te` in ms.
pub fn write_lcm<W: std::io::Write>(s: &Spectra, te: f64, w: &mut W) -> Res<()> {
    let text = lcm_text(s, te)?;
    w.write_all(text.as_bytes()).map_err(|e| format!("Could not write the LCModel file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_15_wide() {
        assert_eq!(field15(1.5), "   1.500000e+00");
        assert_eq!(field15(-1.5), "  -1.500000e+00");
        assert_eq!(field15(0.0), "   0.000000e+00");
        assert_eq!(field15(-0.0), "  -0.000000e+00");
        assert_eq!(field15(123456.0), "   1.234560e+05");
        assert_eq!(field15(1e-120), "  1.000000e-120");
        assert_eq!(field15(-2e200), " -2.000000e+200");
        for x in [1.0, -3.3e-7, 9.999999e99, 1e100, -1e-300] {
            assert_eq!(field15(x).len(), 15);
        }
    }

    #[test]
    fn refuses_like_fida() {
        let mut s = Spectra { sz: vec![4, 1], fids: vec![Default::default(); 4], ..Default::default() };
        assert!(lcm_text(&s, 30.0).is_err());
        s.flags.addedrcvrs = true;
        let (t, w) = lcm_text_with_warnings(&s, 30.0).unwrap();
        assert_eq!(w.len(), 1);
        assert_eq!(t.lines().count(), 12 + 4);
        assert!(t.contains("\n seq= 'PRESS'\n"));
        let (steam, _) = lcm_text_with_seq(&s, 11.0, "STEAM").unwrap();
        assert!(steam.contains("\n seq= 'STEAM'\n"));
        let (blank, _) = lcm_text_with_seq(&s, 11.0, "  ").unwrap();
        assert!(blank.contains("\n seq= 'PRESS'\n"));
    }
}
