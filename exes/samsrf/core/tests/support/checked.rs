//! The checked boundary every recorded-probe gate reads MATLAB recordings through
//! (`focused_probes.rs`, `arithmetic_order.rs`): array descriptors with their class,
//! realness, shape, exact byte count and NaN policy; whole-number indices; and
//! `jsonencode`d matrices. Each test crate uses part of it.
#![allow(dead_code)]
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

pub type Checked<T> = Result<T, String>;

// ---- checked boundary ------------------------------------------------------------

/// A descriptor's MATLAB class. Every array is written as little-endian doubles
/// (`array_file`), so the class says which values the doubles may hold.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Class {
    Double,
    /// Exactly representable in single precision.
    Single,
    /// Whole numbers in 0..=u32::MAX (bit patterns of singles).
    Uint32,
}

impl Class {
    pub fn name(self) -> &'static str {
        match self {
            Class::Double => "double",
            Class::Single => "single",
            Class::Uint32 => "uint32",
        }
    }

    pub fn holds(self, x: f64) -> bool {
        match self {
            Class::Double => true,
            Class::Single => f64::from(x as f32) == x,
            Class::Uint32 => x.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&x),
        }
    }
}

/// Whether an array may hold NaN. Infinities are never accepted.
#[derive(Clone, Copy, PartialEq)]
pub enum Nan {
    Allowed,
    Refused,
}

/// A real array in MATLAB's column-major order.
#[derive(Debug)]
pub struct Array {
    pub shape: Vec<usize>,
    pub values: Vec<f64>,
}

impl Array {
    pub fn words(&self) -> Vec<u32> {
        self.values.iter().map(|&x| x as u32).collect()
    }
}

pub fn read_json(path: &Path) -> Checked<Value> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn text<'a>(value: &'a Value, key: &str) -> Checked<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key}: expected a string"))
}

pub fn number(value: &Value) -> Checked<f64> {
    value
        .as_f64()
        .ok_or_else(|| format!("{value}: expected a number"))
}

/// A whole number in `lo..=hi`.
pub fn integer(x: f64, lo: usize, hi: usize) -> Checked<usize> {
    if x.fract() == 0.0 && x >= lo as f64 && x <= hi as f64 {
        Ok(x as usize)
    } else {
        Err(format!("{x}: expected an integer in {lo}..={hi}"))
    }
}

/// A `jsonencode`d real matrix, returned row-major: a bare number for 1 x 1, a
/// flat list for a row or column vector, otherwise one list per row. Every entry
/// must be a number (`jsonencode` writes NaN as null, which no field may hold).
pub fn matrix(value: &Value, rows: usize, cols: usize) -> Checked<Vec<f64>> {
    let values = if rows * cols == 1 {
        vec![number(value)?]
    } else if rows == 1 || cols == 1 {
        let list = value
            .as_array()
            .ok_or_else(|| format!("{value}: expected a list"))?;
        list.iter().map(number).collect::<Checked<Vec<_>>>()?
    } else {
        let lines = value
            .as_array()
            .ok_or_else(|| format!("{value}: expected rows"))?;
        if lines.len() != rows {
            return Err(format!("expected {rows} rows, found {}", lines.len()));
        }
        let mut values = Vec::with_capacity(rows * cols);
        for line in lines {
            let line = line
                .as_array()
                .ok_or_else(|| format!("{line}: expected a row"))?;
            if line.len() != cols {
                return Err(format!("expected rows of {cols}, found {}", line.len()));
            }
            for entry in line {
                values.push(number(entry)?);
            }
        }
        values
    };
    if values.len() != rows * cols {
        return Err(format!(
            "expected {rows} x {cols} values, found {}",
            values.len()
        ));
    }
    Ok(values)
}

/// A descriptor `{file, shape, class, imaginary}` and its file: the class and
/// shape the field must have (`None` leaves a dimension free), real (`imaginary`
/// empty), exactly `8 * prod(shape)` bytes, and values its class holds.
pub fn array(
    dir: &Path,
    descriptor: &Value,
    class: Class,
    shape: &[Option<usize>],
    nan: Nan,
) -> Checked<Array> {
    let keys: BTreeSet<&str> = descriptor
        .as_object()
        .ok_or_else(|| format!("{descriptor}: expected an array descriptor"))?
        .keys()
        .map(String::as_str)
        .collect();
    if keys != BTreeSet::from(["class", "file", "imaginary", "shape"]) {
        return Err(format!("descriptor keys {keys:?}"));
    }
    let file = text(descriptor, "file")?;
    if file.starts_with('.') || file.contains(['/', '\\']) || !file.ends_with(".f64") {
        return Err(format!(
            "{file}: expected a .f64 file in the recording's folder"
        ));
    }
    let found = text(descriptor, "class")?;
    if found != class.name() {
        return Err(format!("{file}: class {found}, expected {}", class.name()));
    }
    if !text(descriptor, "imaginary")?.is_empty() {
        return Err(format!("{file}: complex, expected real"));
    }
    let dims = descriptor["shape"]
        .as_array()
        .ok_or_else(|| format!("{file}: shape is not a list"))?
        .iter()
        .map(|d| integer(number(d)?, 0, 1 << 31))
        .collect::<Checked<Vec<_>>>()?;
    if dims.len() != shape.len()
        || dims
            .iter()
            .zip(shape)
            .any(|(d, e)| e.is_some_and(|e| e != *d))
    {
        return Err(format!("{file}: shape {dims:?}, expected {shape:?}"));
    }
    let count = dims
        .iter()
        .try_fold(1usize, |total, d| total.checked_mul(*d))
        .ok_or_else(|| format!("{file}: shape overflows"))?;
    let bytes = std::fs::read(dir.join(file)).map_err(|e| format!("{file}: {e}"))?;
    if Some(bytes.len()) != count.checked_mul(8) {
        return Err(format!("{file}: {} bytes for {count} values", bytes.len()));
    }
    let values: Vec<f64> = bytes
        .as_chunks::<8>()
        .0
        .iter()
        .map(|b| f64::from_le_bytes(*b))
        .collect();
    for x in &values {
        let refused = if x.is_nan() {
            nan == Nan::Refused || class == Class::Uint32
        } else {
            x.is_infinite() || !class.holds(*x)
        };
        if refused {
            return Err(format!(
                "{file}: {x} is not a value of this {} field",
                class.name()
            ));
        }
    }
    Ok(Array {
        shape: dims,
        values,
    })
}
