// SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause
//! NiFreeze's intensity clip before registration: a port of `advanced_clip` from NiFreeze
//! 3bcfb00 (`src/nifreeze/data/filtering.py:64-182`, Apache-2.0, [LICENSE-NIFREEZE]) with its
//! default arguments (`p_min=35`, `p_max=99.98`, `nonnegative=True`, `dtype="int16"`,
//! `invert=False`).
//!
//! 1. Median-filter the volume with the footprint `skimage.morphology.ball(3)`: the 123 offsets
//!    with dz² + dy² + dx² ≤ 9 (scikit-image 0.26.0). SciPy 1.18.1's `median_filter` takes the
//!    value of rank `123 // 2 = 61` and extends the border with its default mode `"reflect"`
//!    (`d c b a | a b c d | d c b a`, repeated when an axis is shorter than the radius).
//! 2. Take the 35th and 99.98th percentiles of the finite, non-negative filtered values with
//!    NumPy 2.3.5's default method `"linear"`, in the precision of the data (see [`Real`]).
//! 3. Clip the *unfiltered* data to them, subtract its minimum, divide by its maximum and
//!    write `round(255 x)`, rounding half to even as `np.round` does.
//!
//! The NumPy, SciPy and scikit-image behaviours are reimplemented, not copied
//! (BSD-3-Clause, [LICENSE-NUMPY-SCIPY-SKIMAGE]).
//!
//! # The in-place quirk
//!
//! NiFreeze's registration (`registration/ants.py:83-87`, `_to_nifti`) calls
//! `advanced_clip(data, inplace=True)` and then writes `data`. `filtering.py:116-117` only
//! keeps working on the caller's array when it is floating point:
//!
//! - **Float input** is clipped in its own precision and overwritten with the 0-255 map
//!   (still float). The trivial model's prediction is `dataset.bzero` itself, a float64 array,
//!   so the first registration writes the clipped map into `bzero`, and every later one clips
//!   the clipped map again, which can change it.
//! - **Integer input** is clipped on a float32 copy that is thrown away: the caller's array,
//!   and so the file, is the unclipped data. It can still fail with a [`ClipError`].
//!
//! [`advanced_clip_in_place`] models both as an explicit state change: it takes the buffer
//! mutably and returns a [`ClipReport`] saying whether it was written. [`advanced_clip`] is
//! `inplace=False`, which always computes on a float32 copy and returns int16.
//!
//! [LICENSE-NIFREEZE]: https://github.com/neurodesk/webapps/blob/main/exes/dwi/hmc/LICENSE-NIFREEZE
//! [LICENSE-NUMPY-SCIPY-SKIMAGE]: https://github.com/neurodesk/webapps/blob/main/exes/dwi/hmc/LICENSE-NUMPY-SCIPY-SKIMAGE

use std::fmt;
use std::ops::{Add, Div, Mul, Sub};

/// `p_min`, the lower percentile.
pub const P_MIN: f64 = 35.0;
/// `p_max`, the upper percentile.
pub const P_MAX: f64 = 99.98;
/// The radius of `skimage.morphology.ball`.
pub const BALL_RADIUS: usize = 3;

/// Whether the input array was floating point, which decides if NiFreeze writes it in place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputKind {
    /// float32 or float64: clipped and overwritten.
    Float,
    /// An integer type: clipped on a float32 copy, left unchanged.
    Integer,
}

/// The outcome of one in-place clip.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClipReport {
    /// The input's type class.
    pub input: InputKind,
    /// Whether the caller's buffer now holds the 0-255 map. True exactly for float input.
    pub mutated: bool,
    /// The lower threshold (35th percentile of the filtered values), as `float()` gives it.
    pub a_min: f64,
    /// The upper threshold (99.98th percentile of the filtered values).
    pub a_max: f64,
}

/// NiFreeze's `ClippingValueError` cases, plus NaN input.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ClipError {
    /// The shape has a zero extent, its product overflows, or the data length differs from it.
    Shape { len: usize, shape: [usize; 3] },
    /// The volume holds a NaN. NiFreeze also fails on it (its minimum is NaN, so the range is
    /// degenerate), but only after writing a float input in place; this port refuses before
    /// touching the buffer, because SciPy's median of NaN is undefined.
    NaN,
    /// No finite, non-negative filtered value to take percentiles of.
    EmptySelection,
    /// A threshold is not finite.
    NonFiniteThresholds { a_min: f64, a_max: f64 },
    /// `a_max <= a_min`, as for a constant volume.
    InvalidThresholds { a_min: f64, a_max: f64 },
    /// The clipped range is zero or not finite. As in NiFreeze, a float input has already
    /// been clipped and shifted in place when this is returned.
    DegenerateRange { den: f64 },
}

impl fmt::Display for ClipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClipError::Shape { len, shape } => {
                write!(f, "{len} values do not fill a {shape:?} volume")
            }
            ClipError::NaN => write!(f, "the volume holds a NaN"),
            ClipError::EmptySelection => write!(
                f,
                "empty percentile selection after applying nonnegative constraint and finite \
                 filtering (p_min={P_MIN}, p_max={P_MAX})"
            ),
            ClipError::NonFiniteThresholds { a_min, a_max } => write!(
                f,
                "percentile thresholds are not finite (a_min={a_min}, a_max={a_max})"
            ),
            ClipError::InvalidThresholds { a_min, a_max } => write!(
                f,
                "invalid percentile thresholds (a_max <= a_min) (a_min={a_min}, a_max={a_max})"
            ),
            ClipError::DegenerateRange { den } => {
                write!(
                    f,
                    "degenerate dynamic range after clipping/shift (den={den})"
                )
            }
        }
    }
}

impl std::error::Error for ClipError {}

/// A floating-point type the clip computes in: every NumPy operation stays in the array's
/// precision (NEP 50), so a float32 array is filtered, interpolated, scaled and rounded in f32.
pub trait Real:
    Copy
    + PartialOrd
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
{
    /// `0`.
    const ZERO: Self;
    /// `1`.
    const ONE: Self;
    /// Converts a Python float or int operand as NumPy does when it meets an array of this type.
    fn from_f64(value: f64) -> Self;
    /// `float(x)`.
    fn to_f64(self) -> f64;
    /// `np.isfinite`.
    fn is_finite(self) -> bool;
    /// `np.isnan`.
    fn is_nan(self) -> bool;
    /// `np.floor`.
    fn floor(self) -> Self;
    /// `np.round` with `decimals=0`: half to even.
    fn round_ties_even(self) -> Self;
}

impl Real for f64 {
    const ZERO: Self = 0.0;
    const ONE: Self = 1.0;
    fn from_f64(value: f64) -> Self {
        value
    }
    fn to_f64(self) -> f64 {
        self
    }
    fn is_finite(self) -> bool {
        f64::is_finite(self)
    }
    fn is_nan(self) -> bool {
        f64::is_nan(self)
    }
    fn floor(self) -> Self {
        f64::floor(self)
    }
    fn round_ties_even(self) -> Self {
        f64::round_ties_even(self)
    }
}

impl Real for f32 {
    const ZERO: Self = 0.0;
    const ONE: Self = 1.0;
    fn from_f64(value: f64) -> Self {
        value as f32
    }
    fn to_f64(self) -> f64 {
        f64::from(self)
    }
    fn is_finite(self) -> bool {
        f32::is_finite(self)
    }
    fn is_nan(self) -> bool {
        f32::is_nan(self)
    }
    fn floor(self) -> Self {
        f32::floor(self)
    }
    fn round_ties_even(self) -> Self {
        f32::round_ties_even(self)
    }
}

/// A voxel type `advanced_clip` accepts: float32, float64 or an integer type.
pub trait Sample: Copy {
    /// The type class, which decides the in-place behaviour.
    const KIND: InputKind;
    /// `astype(np.float32)`.
    fn to_f32(self) -> f32;
    /// The in-place call for this type (see [`advanced_clip_in_place`]).
    fn clip_in_place(data: &mut [Self], shape: [usize; 3]) -> Result<ClipReport, ClipError>;
}

impl Sample for f64 {
    const KIND: InputKind = InputKind::Float;
    fn to_f32(self) -> f32 {
        self as f32
    }
    fn clip_in_place(data: &mut [Self], shape: [usize; 3]) -> Result<ClipReport, ClipError> {
        clip_real(data, shape, InputKind::Float)
    }
}

impl Sample for f32 {
    const KIND: InputKind = InputKind::Float;
    fn to_f32(self) -> f32 {
        self
    }
    fn clip_in_place(data: &mut [Self], shape: [usize; 3]) -> Result<ClipReport, ClipError> {
        clip_real(data, shape, InputKind::Float)
    }
}

macro_rules! integer_sample {
    ($($t:ty),*) => {$(
        impl Sample for $t {
            const KIND: InputKind = InputKind::Integer;
            fn to_f32(self) -> f32 {
                self as f32
            }
            fn clip_in_place(data: &mut [Self], shape: [usize; 3]) -> Result<ClipReport, ClipError> {
                // `data.astype(np.float32, copy=False)` must copy: the result is discarded.
                let mut copy: Vec<f32> = data.iter().map(|&v| v.to_f32()).collect();
                clip_real(&mut copy, shape, InputKind::Integer)
            }
        }
    )*};
}

integer_sample!(u8, i8, u16, i16, u32, i32, u64, i64);

/// `advanced_clip(data, inplace=True)`, as `_to_nifti` calls it.
///
/// `data` is one volume in any memory order, with `shape` its dimensions from the slowest- to
/// the fastest-varying axis (`ball(3)` is symmetric in its axes, so a NIfTI buffer in Fortran
/// order with `[nz, ny, nx]` gives the same result as NumPy's view of it). Float input is
/// overwritten with the 0-255 map in its own type; integer input is left unchanged. The
/// report says which happened.
pub fn advanced_clip_in_place<T: Sample>(
    data: &mut [T],
    shape: [usize; 3],
) -> Result<ClipReport, ClipError> {
    T::clip_in_place(data, shape)
}

/// `advanced_clip(data)` (`inplace=False`): the 0-255 map as int16, computed on a float32
/// copy for every input type, float64 included.
pub fn advanced_clip<T: Sample>(data: &[T], shape: [usize; 3]) -> Result<Vec<i16>, ClipError> {
    let mut copy: Vec<f32> = data.iter().map(|&v| v.to_f32()).collect();
    clip_real(&mut copy, shape, T::KIND)?;
    Ok(copy.iter().map(|&v| v as i16).collect())
}

/// `filtering.py:119-177` on a float buffer of the array's precision, written in place.
fn clip_real<F: Real>(
    data: &mut [F],
    shape: [usize; 3],
    input: InputKind,
) -> Result<ClipReport, ClipError> {
    let len = shape.iter().try_fold(1usize, |len, &axis| {
        if axis == 0 {
            None
        } else {
            len.checked_mul(axis)
        }
    });
    if len != Some(data.len()) {
        return Err(ClipError::Shape {
            len: data.len(),
            shape,
        });
    }
    if data.iter().any(|v| v.is_nan()) {
        return Err(ClipError::NaN);
    }

    let denoised = median_filter_ball(data, shape);
    let mut sel: Vec<F> = denoised
        .into_iter()
        .filter(|&v| v >= F::ZERO && v.is_finite())
        .collect();
    if sel.is_empty() {
        return Err(ClipError::EmptySelection);
    }
    sel.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let a_min = percentile(&sel, P_MIN).to_f64();
    let a_max = percentile(&sel, P_MAX).to_f64();
    if !a_min.is_finite() || !a_max.is_finite() {
        return Err(ClipError::NonFiniteThresholds { a_min, a_max });
    }
    if a_max <= a_min {
        return Err(ClipError::InvalidThresholds { a_min, a_max });
    }

    // np.clip(data, a_min, a_max, out=data): the Python floats become the array's type.
    let (lo, hi) = (F::from_f64(a_min), F::from_f64(a_max));
    for v in data.iter_mut() {
        let x = if *v < lo { lo } else { *v };
        *v = if x > hi { hi } else { x };
    }
    let min = fold(data, |a, b| if b < a { b } else { a });
    for v in data.iter_mut() {
        *v = *v - min;
    }
    let den = fold(data, |a, b| if b > a { b } else { a }).to_f64();
    if !den.is_finite() || den == 0.0 {
        return Err(ClipError::DegenerateRange { den });
    }
    let den = F::from_f64(den);
    let scale = F::from_f64(255.0);
    for v in data.iter_mut() {
        *v = (scale * (*v / den)).round_ties_even();
    }

    Ok(ClipReport {
        input,
        mutated: input == InputKind::Float,
        a_min,
        a_max,
    })
}

fn fold<F: Real>(data: &[F], pick: impl Fn(F, F) -> F) -> F {
    data[1..].iter().fold(data[0], |a, &b| pick(a, b))
}

/// `np.percentile(sorted, p)` with method `"linear"` on an ascending, non-empty slice.
///
/// NumPy divides `p` by `100` of the array's type, multiplies by `n - 1`, takes the floor and
/// the fraction `gamma` in that type, and interpolates as `a + (b - a) gamma`, or
/// `b - (b - a)(1 - gamma)` when `gamma >= 0.5`. An index at or past `n - 1` takes the maximum.
fn percentile<F: Real>(sorted: &[F], p: f64) -> F {
    let n = sorted.len();
    let q = F::from_f64(p) / F::from_f64(100.0);
    let virtual_index = F::from_f64((n - 1) as f64) * q;
    let below = virtual_index.floor();
    let gamma = virtual_index - below;
    let (a, b) = if virtual_index >= F::from_f64((n - 1) as f64) {
        (sorted[n - 1], sorted[n - 1])
    } else {
        let i = below.to_f64() as usize;
        (sorted[i], sorted[i + 1])
    };
    let diff = b - a;
    if gamma >= F::from_f64(0.5) {
        b - diff * (F::ONE - gamma)
    } else {
        a + diff * gamma
    }
}

/// The offsets of `skimage.morphology.ball(BALL_RADIUS)`, in its C order.
fn ball_offsets() -> Vec<[isize; 3]> {
    let r = BALL_RADIUS as isize;
    let mut offsets = Vec::new();
    for dz in -r..=r {
        for dy in -r..=r {
            for dx in -r..=r {
                if dz * dz + dy * dy + dx * dx <= r * r {
                    offsets.push([dz, dy, dx]);
                }
            }
        }
    }
    offsets
}

/// SciPy's `"reflect"` extension of index `i` on an axis of length `n`: half-sample symmetric,
/// period `2n`.
fn reflect(i: isize, n: usize) -> usize {
    let n = n as isize;
    let period = 2 * n;
    let m = i.rem_euclid(period);
    (if m < n { m } else { period - 1 - m }) as usize
}

/// `scipy.ndimage.median_filter(data, footprint=ball(3))`: the element of rank `n // 2` among
/// the `n = 123` footprint values, with the border extended by `"reflect"`.
fn median_filter_ball<F: Real>(data: &[F], shape: [usize; 3]) -> Vec<F> {
    let offsets = ball_offsets();
    let rank = offsets.len() / 2;
    let r = BALL_RADIUS as isize;
    // Reflected coordinate of every position and offset, per axis.
    let maps: Vec<Vec<usize>> = shape
        .iter()
        .map(|&n| {
            (0..n as isize)
                .flat_map(|i| (-r..=r).map(move |d| reflect(i + d, n)))
                .collect()
        })
        .collect();
    let width = 2 * BALL_RADIUS + 1;
    let at = |axis: usize, i: usize, d: isize| maps[axis][i * width + (d + r) as usize];
    let [_, n1, n2] = shape;
    let mut window = vec![F::ZERO; offsets.len()];
    let mut out = Vec::with_capacity(data.len());
    for i0 in 0..shape[0] {
        for i1 in 0..n1 {
            for i2 in 0..n2 {
                for (w, &[d0, d1, d2]) in window.iter_mut().zip(&offsets) {
                    let j = (at(0, i0, d0) * n1 + at(1, i1, d1)) * n2 + at(2, i2, d2);
                    *w = data[j];
                }
                let (_, median, _) =
                    window.select_nth_unstable_by(rank, |a, b| a.partial_cmp(b).expect("no NaN"));
                out.push(*median);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ball_matches_skimage() {
        // skimage.morphology.ball(3).sum() == 123 in scikit-image 0.26.0.
        assert_eq!(ball_offsets().len(), 123);
    }

    #[test]
    fn reflect_is_half_sample_symmetric() {
        // d c b a | a b c d | d c b a
        let got: Vec<usize> = (-4..8).map(|i| reflect(i, 4)).collect();
        assert_eq!(got, [3, 2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0]);
        // An axis shorter than the radius reflects again: ... a b | b a | a b | b a ...
        let got: Vec<usize> = (-3..5).map(|i| reflect(i, 2)).collect();
        assert_eq!(got, [1, 1, 0, 0, 1, 1, 0, 0]);
        assert!((-3..4).all(|i| reflect(i, 1) == 0));
    }

    #[test]
    fn percentile_is_numpy_linear() {
        // np.percentile(np.arange(10.0), 35) == 3.15; in float32 it is 3.1499999.
        let v64: Vec<f64> = (0..10).map(f64::from).collect();
        assert_eq!(percentile(&v64, 35.0), 3.15);
        let v32: Vec<f32> = (0..10).map(|i| i as f32).collect();
        assert_eq!(percentile(&v32, 35.0), 3.1499999_f32);
        assert_eq!(percentile(&v64, 100.0), 9.0);
        assert_eq!(percentile(&[7.0_f64], 99.98), 7.0);
    }
}
