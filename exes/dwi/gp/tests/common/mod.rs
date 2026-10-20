//! Reads the fixtures that tools/oracle.py writes.
#![allow(dead_code)]

use serde_json::Value;

pub fn load(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

/// A number; the strings "inf", "-inf" and "nan" stand for the non-finite values.
pub fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) => match s.as_str() {
            "inf" => f64::INFINITY,
            "-inf" => f64::NEG_INFINITY,
            "nan" => f64::NAN,
            _ => panic!("not a number: {s}"),
        },
        _ => v.as_f64().unwrap(),
    }
}

pub fn nums(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(num).collect()
}

pub fn vec3(v: &Value) -> [f64; 3] {
    let n = nums(v);
    [n[0], n[1], n[2]]
}

/// The relative difference, with equal values (also equal infinities) as 0.
pub fn rel(a: f64, b: f64) -> f64 {
    if a == b {
        return 0.0;
    }
    (a - b).abs() / a.abs().max(b.abs())
}

/// max |a - b| / max |b|: the difference of two vectors relative to their scale.
pub fn rel_inf(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len());
    let d = a
        .iter()
        .zip(b)
        .map(|(&x, &y)| (x - y).abs())
        .fold(0.0, f64::max);
    if d == 0.0 {
        return 0.0;
    }
    d / b.iter().map(|y| y.abs()).fold(0.0, f64::max)
}

/// The largest element-wise relative difference.
pub fn rel_vec(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(&x, &y)| rel(x, y))
        .fold(0.0, f64::max)
}

/// The rows of X.
pub fn rows3(v: &Value) -> Vec<[f64; 3]> {
    v.as_array().unwrap().iter().map(vec3).collect()
}

/// y as the oracle stores it, (n, T), turned target major.
pub fn targets(v: &Value) -> (usize, Vec<f64>) {
    let rows: Vec<Vec<f64>> = v.as_array().unwrap().iter().map(nums).collect();
    let n = rows.len();
    let t = rows[0].len();
    let mut out = Vec::with_capacity(n * t);
    for j in 0..t {
        for row in &rows {
            out.push(row[j]);
        }
    }
    (n, out)
}
