//! Python-compatible text helpers. Commands, sidecars and reports must match fastprep.py
//! byte-for-byte, so number formatting follows Python's `repr`, `:g` and `round` rules.

use serde_json::Value;

/// (sign, shortest round-trip digits, decimal exponent of the first digit).
fn digits(x: f64) -> (bool, String, i32) {
    let s = format!("{:e}", x.abs()); // shortest round-trip, e.g. "2.4600000000000004e0"
    let (m, e) = s.split_once('e').unwrap();
    (x.is_sign_negative(), m.replace('.', ""), e.parse().unwrap())
}

fn exp_suffix(e: i32) -> String {
    format!("e{}{:02}", if e < 0 { '-' } else { '+' }, e.abs())
}

/// Python `repr(float)`: shortest round-trip digits; scientific when exponent < -4 or >= 16.
pub fn repr(x: f64) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf" } else { "-inf" }.into();
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0" } else { "0.0" }.into();
    }
    let (neg, d, e) = digits(x);
    let sign = if neg { "-" } else { "" };
    if !(-4..16).contains(&e) {
        let m = if d.len() > 1 {
            format!("{}.{}", &d[..1], &d[1..])
        } else {
            d.clone()
        };
        return format!("{sign}{m}{}", exp_suffix(e));
    }
    let n = d.len() as i32;
    let body = if e < 0 {
        format!("0.{}{}", "0".repeat((-e - 1) as usize), d)
    } else if e + 1 >= n {
        format!("{}{}.0", d, "0".repeat((e + 1 - n) as usize))
    } else {
        format!("{}.{}", &d[..(e + 1) as usize], &d[(e + 1) as usize..])
    };
    format!("{sign}{body}")
}

/// Python `f'{x:g}'` (6 significant digits, trailing zeros removed).
pub fn g(x: f64) -> String {
    if !x.is_finite() {
        return repr(x);
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0" } else { "0" }.into();
    }
    let s = format!("{:.5e}", x); // rounded to 6 significant digits
    let (m, e) = s.split_once('e').unwrap();
    let e: i32 = e.parse().unwrap();
    let strip = |t: String| {
        if t.contains('.') {
            t.trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            t
        }
    };
    if (-4..6).contains(&e) {
        strip(format!("{:.*}", (5 - e) as usize, x))
    } else {
        format!("{}{}", strip(m.to_string()), exp_suffix(e))
    }
}

/// Python `round(x, n)`: correctly rounded, ties to even on the exact binary value.
pub fn round(x: f64, n: usize) -> f64 {
    format!("{:.*}", n, x).parse().unwrap()
}

/// Python `str()` of a JSON number or string as it came from a sidecar.
pub fn value(v: &Value) -> String {
    match v {
        Value::Number(n) if n.is_f64() => repr(n.as_f64().unwrap()),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::Null => "None".into(),
        other => other.to_string(),
    }
}

/// Python `html.escape(s, quote=True)`.
pub fn escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#x27;"),
            c => o.push(c),
        }
    }
    o
}

/// Python `shlex.quote`.
pub fn quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\"'\"'"))
    }
}

/// Python `fnmatch.fnmatchcase`: `*`, `?`, `[seq]`, `[!seq]`.
pub fn fnmatch(name: &str, pat: &str) -> bool {
    fn class(p: &[char], c: char) -> Option<(bool, usize)> {
        let (neg, mut i) = if p.get(1) == Some(&'!') {
            (true, 2)
        } else {
            (false, 1)
        };
        let start = i;
        let mut hit = false;
        while i < p.len() && (p[i] != ']' || i == start) {
            if i + 2 < p.len() && p[i + 1] == '-' && p[i + 2] != ']' {
                hit |= p[i] <= c && c <= p[i + 2];
                i += 3;
            } else {
                hit |= p[i] == c;
                i += 1;
            }
        }
        (i < p.len()).then_some((hit != neg, i + 1))
    }
    fn m(n: &[char], p: &[char]) -> bool {
        match p.first() {
            None => n.is_empty(),
            Some('*') => (0..=n.len()).any(|k| m(&n[k..], &p[1..])),
            Some('?') => !n.is_empty() && m(&n[1..], &p[1..]),
            Some('[') => match (n.first(), class(p, *n.first().unwrap_or(&'\0'))) {
                (Some(_), Some((ok, len))) => ok && m(&n[1..], &p[len..]),
                (Some(c), None) => *c == '[' && m(&n[1..], &p[1..]),
                (None, _) => false,
            },
            Some(c) => n.first() == Some(c) && m(&n[1..], &p[1..]),
        }
    }
    m(
        &name.chars().collect::<Vec<_>>(),
        &pat.chars().collect::<Vec<_>>(),
    )
}

/// Python `repr` of a list of strings, e.g. `['j', 'j-']`.
pub fn list_repr<S: AsRef<str>>(xs: &[S]) -> String {
    format!(
        "[{}]",
        xs.iter()
            .map(|s| format!("'{}'", s.as_ref()))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_number_formats() {
        for (x, r) in [
            (2.0, "2.0"),
            (0.1, "0.1"),
            (2.4600000000000004, "2.4600000000000004"),
            (1e-5, "1e-05"),
            (1e16, "1e+16"),
            (123456789.0, "123456789.0"),
            (0.0001, "0.0001"),
            (-2.5, "-2.5"),
            (std::f64::consts::TAU, "6.283185307179586"),
            (2.776319980621338, "2.776319980621338"),
        ] {
            assert_eq!(repr(x), r);
        }
        for (x, r) in [
            (35.32, "35.32"),
            (2.0, "2"),
            (0.0001, "0.0001"),
            (1234567.0, "1.23457e+06"),
            (14.0, "14"),
            (1e-5, "1e-05"),
        ] {
            assert_eq!(g(x), r);
        }
        assert_eq!(round(0.5175, 3), 0.517); // binary 0.51749999...
        assert_eq!(round(2.5, 0), 2.0);
    }

    #[test]
    fn quoting_and_globs() {
        assert_eq!(quote("a/b-c.nii.gz"), "a/b-c.nii.gz");
        assert_eq!(quote("it's"), "'it'\"'\"'s'");
        assert_eq!(quote(""), "''");
        assert!(fnmatch(
            "sub-x_acq-mprageVnav_T1wRMS.nii.gz",
            "*acq-mprageVnav_T1wRMS*"
        ));
        assert!(
            fnmatch("a1.nii", "a[0-9].nii")
                && !fnmatch("ab.nii", "a[!b].nii")
                && !fnmatch("x.nii", "y*")
        );
        assert_eq!(
            escape("<a href='x'>&\""),
            "&lt;a href=&#x27;x&#x27;&gt;&amp;&quot;"
        );
    }
}
