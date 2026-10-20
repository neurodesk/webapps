// SPDX-License-Identifier: BSD-3-Clause
// Port of Patch2Self from DIPY 1.12.1 (dipy/denoise/patch2self.py), version 1 with patch
// radius 0 and an ordinary least squares model. DIPY is Copyright (c) 2008-2026, dipy developers
// (LICENSE-DIPY).

//! Patch2Self denoising (Fadnavis et al. 2020), DIPY version 1, patch radius 0, OLS.
//!
//! Each volume is predicted by a least-squares fit, with an intercept, on the other volumes of
//! its group, over all voxels. The b0 volumes and the diffusion-weighted volumes are two separate
//! groups. A group of one volume is copied unchanged.
//!
//! The work is three steps, so that a caller can split the voxels across workers and keep one
//! copy of the data:
//!
//! 1. [`accumulate_gram`] adds the sums of products of a range of voxels to a Gram matrix
//!    (f64). Partial Gram matrices of separate voxel ranges add element by element.
//! 2. [`solve`] makes the regression coefficients of each volume from the Gram matrix.
//! 3. [`apply`] replaces the voxels of a range with their predictions, in place.
//!
//! Data is volume-major, as in NIfTI: the value of voxel `v` in volume `t` is at
//! `t * stride + v`, with the first spatial index fastest.

use std::ops::Range;

pub use dwi_gradients::B0_THRESHOLD;

/// The ridge penalty of DIPY's `model="ols"`: `Ridge(alpha=1e-10)`.
pub const ALPHA: f64 = 1e-10;

/// Voxels per block. The two passes copy one block of every group volume into a small f64
/// buffer, so the inner loops run over contiguous memory.
const BLOCK: usize = 256;

/// A stored sample: the computation is f64 whatever the storage.
pub trait Sample: Copy {
    fn to_f64(self) -> f64;
    fn from_f64(value: f64) -> Self;
}

impl Sample for f32 {
    fn to_f64(self) -> f64 {
        f64::from(self)
    }
    fn from_f64(value: f64) -> Self {
        value as f32
    }
}

impl Sample for f64 {
    fn to_f64(self) -> f64 {
        self
    }
    fn from_f64(value: f64) -> Self {
        value
    }
}

/// The volume indices of the two groups, in input order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Groups {
    pub b0: Vec<usize>,
    pub dwi: Vec<usize>,
}

impl Groups {
    /// The groups that are fitted: those with two or more volumes. A single b0 is copied.
    pub fn fitted(&self) -> Vec<&[usize]> {
        [self.b0.as_slice(), self.dwi.as_slice()]
            .into_iter()
            .filter(|g| g.len() >= 2)
            .collect()
    }
}

/// Splits the volumes into b0 (b < [`B0_THRESHOLD`]) and diffusion-weighted volumes.
///
/// DIPY takes b <= 50 as b0; the two rules differ only for a volume at exactly b = 50.
pub fn split_groups(bvals: &[f64]) -> Result<Groups, String> {
    let mut groups = Groups {
        b0: Vec::new(),
        dwi: Vec::new(),
    };
    for (t, &b) in bvals.iter().enumerate() {
        if !b.is_finite() {
            return Err(format!("The b-value of volume {t} is not a number."));
        }
        if b < B0_THRESHOLD {
            groups.b0.push(t);
        } else {
            groups.dwi.push(t);
        }
    }
    if groups.dwi.len() < 2 {
        return Err(format!(
            "Patch2Self needs at least 2 diffusion-weighted volumes (b >= {B0_THRESHOLD} s/mm²). \
             This data has {}.",
            groups.dwi.len()
        ));
    }
    Ok(groups)
}

/// The length of the Gram matrix of a group of `n` volumes: `(n + 1)²`.
pub const fn gram_len(n: usize) -> usize {
    (n + 1) * (n + 1)
}

/// The length of the coefficients of a group of `n` volumes: `n * (n + 1)`.
///
/// Row `j` holds the weight of each group volume in the prediction of volume `j` (zero for `j`
/// itself) and then the intercept.
pub const fn coefficients_len(n: usize) -> usize {
    n * (n + 1)
}

fn check(len: usize, stride: usize, voxels: &Range<usize>, group: &[usize]) {
    assert!(
        voxels.start <= voxels.end && voxels.end <= stride,
        "voxel range outside the stride"
    );
    let volumes = len.checked_div(stride).unwrap_or(0);
    assert!(
        stride == 0 || len == volumes * stride,
        "data is not a whole number of volumes"
    );
    assert!(
        group.iter().all(|&t| t < volumes),
        "group volume index outside the data"
    );
}

/// Adds the voxels in `voxels` to the Gram matrix `gram` of `group`.
///
/// `gram` is `(n + 1) × (n + 1)`, row-major, with the volumes of the group first and a column of
/// ones last; only its upper triangle (row <= column) is written and read. Start from zeros.
///
/// # Panics
/// When the range, the group or `gram` does not fit the data.
pub fn accumulate_gram<T: Sample>(
    data: &[T],
    stride: usize,
    voxels: Range<usize>,
    group: &[usize],
    gram: &mut [f64],
) {
    check(data.len(), stride, &voxels, group);
    let n = group.len();
    let m = n + 1;
    assert_eq!(gram.len(), gram_len(n), "Gram matrix length");
    let mut block = vec![0.0f64; m * BLOCK];
    let mut start = voxels.start;
    while start < voxels.end {
        let len = BLOCK.min(voxels.end - start);
        for (i, &t) in group.iter().enumerate() {
            let src = &data[t * stride + start..t * stride + start + len];
            for (d, s) in block[i * BLOCK..i * BLOCK + len].iter_mut().zip(src) {
                *d = s.to_f64();
            }
        }
        block[n * BLOCK..n * BLOCK + len].fill(1.0);
        for i in 0..m {
            let a = &block[i * BLOCK..i * BLOCK + len];
            for k in i..m {
                let b = &block[k * BLOCK..k * BLOCK + len];
                gram[i * m + k] += dot(a, b);
            }
        }
        start += len;
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut acc = [0.0f64; 4];
    let chunks = a.len() / 4;
    for c in 0..chunks {
        for l in 0..4 {
            acc[l] += a[4 * c + l] * b[4 * c + l];
        }
    }
    let mut tail = 0.0;
    for i in 4 * chunks..a.len() {
        tail += a[i] * b[i];
    }
    (acc[0] + acc[1]) + (acc[2] + acc[3]) + tail
}

/// A regression that [`solve`] could not make.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SolveError {
    /// The Gram matrix holds no voxel.
    Empty,
    /// The data holds a value that is not a finite number (NaN or infinity).
    NotFinite,
    /// The volume at group position `volume` is a linear combination of other volumes of its
    /// group (for example, a copy of one), so the least-squares weights are not defined.
    Dependent { volume: usize },
}

impl std::fmt::Display for SolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SolveError::Empty => write!(f, "The data has no voxels."),
            SolveError::NotFinite => write!(
                f,
                "The data holds values that are not finite numbers (NaN or infinity)."
            ),
            SolveError::Dependent { volume } => write!(
                f,
                "Group volume {volume} (counting from 0) is a linear combination of other volumes \
                 of its group (for example, a copy of one), so Patch2Self cannot fit it."
            ),
        }
    }
}

/// Makes the coefficients of a group of `n` volumes from its Gram matrix (see
/// [`coefficients_len`]).
///
/// This is scikit-learn's `Ridge(alpha=1e-10, fit_intercept=True)` with its Cholesky solver, as
/// DIPY's `model="ols"` uses it: the volumes are centred by their means, the weights solve
/// `(Xc'Xc + αI) w = Xc'yc`, and the intercept is `ȳ - x̄·w`.
pub fn solve(gram: &[f64], n: usize) -> Result<Vec<f64>, SolveError> {
    let m = n + 1;
    assert_eq!(gram.len(), gram_len(n), "Gram matrix length");
    let upper = |i: usize, k: usize| {
        if i <= k {
            gram[i * m + k]
        } else {
            gram[k * m + i]
        }
    };
    if gram.iter().any(|v| !v.is_finite()) {
        return Err(SolveError::NotFinite);
    }
    let count = upper(n, n);
    if count <= 0.0 {
        return Err(SolveError::Empty);
    }
    let mean: Vec<f64> = (0..n).map(|i| upper(i, n) / count).collect();
    let mut cov = vec![0.0f64; n * n];
    for i in 0..n {
        for k in 0..n {
            cov[i * n + k] = upper(i, k) - count * (mean[i] * mean[k]);
        }
    }
    // A constant volume centres to zero, so scikit-learn gives it zero weight. Its centred
    // variance here is only the rounding of `S_ii - N m²`, which can be negative, so set it to
    // the exact zero that explicit centring gives.
    for i in 0..n {
        if cov[i * n + i] <= CONSTANT_VARIANCE * upper(i, i) {
            for k in 0..n {
                cov[i * n + k] = 0.0;
                cov[k * n + i] = 0.0;
            }
        }
    }

    let mut coefficients = vec![0.0f64; coefficients_len(n)];
    let p = n - 1;
    let mut a = vec![0.0f64; p * p];
    let mut rhs = vec![0.0f64; p];
    let mut y = vec![0.0f64; p];
    let mut w = vec![0.0f64; p];
    for j in 0..n {
        let others: Vec<usize> = (0..n).filter(|&k| k != j).collect();
        for (r, &i) in others.iter().enumerate() {
            for (c, &k) in others.iter().enumerate() {
                a[r * p + c] = cov[i * n + k];
            }
            a[r * p + r] += ALPHA;
            rhs[r] = cov[i * n + j];
        }
        if let Err(r) = cholesky(&mut a, p) {
            return Err(SolveError::Dependent { volume: others[r] });
        }
        // Forward substitution with L, then back substitution with L'.
        for i in 0..p {
            let s: f64 = (0..i).map(|k| a[i * p + k] * y[k]).sum();
            y[i] = (rhs[i] - s) / a[i * p + i];
        }
        for i in (0..p).rev() {
            let s: f64 = (i + 1..p).map(|k| a[k * p + i] * w[k]).sum();
            w[i] = (y[i] - s) / a[i * p + i];
        }
        if let Some(r) = w.iter().position(|v| !v.is_finite()) {
            return Err(SolveError::Dependent { volume: others[r] });
        }
        let row = &mut coefficients[j * m..(j + 1) * m];
        let mut intercept = mean[j];
        let mut dotm = 0.0;
        for (r, &k) in others.iter().enumerate() {
            row[k] = w[r];
            dotm += mean[k] * w[r];
        }
        intercept -= dotm;
        row[n] = intercept;
    }
    Ok(coefficients)
}

/// The smallest pivot, relative to its diagonal entry, that [`cholesky`] accepts. The ratio is
/// 1 - R² of a volume on the volumes before it, so it is near zero only when they are linearly
/// dependent; rounding alone leaves about `p * 1e-16`.
const MIN_RELATIVE_PIVOT: f64 = 1e-10;

/// The largest centred variance, relative to the uncentred second moment, that [`solve`] treats
/// as a constant volume. Rounding of `S_ii - N m²` in f64 stays near `1e-16` of `S_ii`; a volume
/// that varies at all across a brain image is many orders of magnitude above this.
const CONSTANT_VARIANCE: f64 = 1e-11;

/// In-place Cholesky factorisation of the symmetric `p × p` matrix `a` (lower triangle written).
/// Returns the first row whose pivot fails when `a` is not positive definite or is singular to
/// rounding: that variable is a linear combination of the variables before it.
fn cholesky(a: &mut [f64], p: usize) -> Result<(), usize> {
    for j in 0..p {
        let diagonal = a[j * p + j];
        let mut d = diagonal;
        for k in 0..j {
            d -= a[j * p + k] * a[j * p + k];
        }
        if d.is_nan() || d <= MIN_RELATIVE_PIVOT * diagonal || d.is_infinite() {
            return Err(j);
        }
        let d = d.sqrt();
        a[j * p + j] = d;
        for i in j + 1..p {
            let mut s = a[i * p + j];
            for k in 0..j {
                s -= a[i * p + k] * a[j * p + k];
            }
            a[i * p + j] = s / d;
        }
    }
    Ok(())
}

/// Replaces the voxels in `voxels` of each volume of `group` with its prediction from the other
/// volumes, in place. Each block of voxels is read in full before it is written, so the
/// predictions use the original values.
///
/// # Panics
/// When the range, the group or `coefficients` does not fit the data.
pub fn apply<T: Sample>(
    data: &mut [T],
    stride: usize,
    voxels: Range<usize>,
    group: &[usize],
    coefficients: &[f64],
) {
    check(data.len(), stride, &voxels, group);
    let n = group.len();
    let m = n + 1;
    assert_eq!(
        coefficients.len(),
        coefficients_len(n),
        "coefficients length"
    );
    let mut input = vec![0.0f64; n * BLOCK];
    let mut output = vec![0.0f64; n * BLOCK];
    let mut start = voxels.start;
    while start < voxels.end {
        let len = BLOCK.min(voxels.end - start);
        for (i, &t) in group.iter().enumerate() {
            let src = &data[t * stride + start..t * stride + start + len];
            for (d, s) in input[i * BLOCK..i * BLOCK + len].iter_mut().zip(src) {
                *d = s.to_f64();
            }
        }
        for j in 0..n {
            let row = &coefficients[j * m..(j + 1) * m];
            let out = &mut output[j * BLOCK..j * BLOCK + len];
            out.fill(0.0);
            for (k, &w) in row[..n].iter().enumerate() {
                if k == j {
                    continue;
                }
                let x = &input[k * BLOCK..k * BLOCK + len];
                for (o, &v) in out.iter_mut().zip(x) {
                    *o += w * v;
                }
            }
            for o in out.iter_mut() {
                *o += row[n];
            }
        }
        for (j, &t) in group.iter().enumerate() {
            let dst = &mut data[t * stride + start..t * stride + start + len];
            for (d, &v) in dst.iter_mut().zip(&output[j * BLOCK..j * BLOCK + len]) {
                *d = T::from_f64(v);
            }
        }
        start += len;
    }
}

/// Denoises `data` (volume-major, `bvals.len()` volumes of `nvox` voxels) in place in one pass
/// per step.
pub fn denoise<T: Sample>(data: &mut [T], nvox: usize, bvals: &[f64]) -> Result<(), String> {
    if data.len() != nvox * bvals.len() {
        return Err(format!(
            "Expected {} values ({nvox} voxels × {} volumes), received {}.",
            nvox * bvals.len(),
            bvals.len(),
            data.len()
        ));
    }
    if data.iter().any(|value| !value.to_f64().is_finite()) {
        return Err(SolveError::NotFinite.to_string());
    }
    let groups = split_groups(bvals)?;
    for group in groups.fitted() {
        let mut gram = vec![0.0f64; gram_len(group.len())];
        accumulate_gram(data, nvox, 0..nvox, group, &mut gram);
        let coefficients = solve(&gram, group.len()).map_err(|e| match e {
            SolveError::Dependent { volume } => format!(
                "Volume {} (counting from 0) is a linear combination of other volumes of its \
                 group (for example, a copy of one), so Patch2Self cannot fit it.",
                group[volume]
            ),
            other => other.to_string(),
        })?;
        apply(data, nvox, 0..nvox, group, &coefficients);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cholesky_solves_a_known_system() {
        // Two regressors with a known exact fit: y = 2 x0 - x1 + 3.
        let x0 = [1.0, 2.0, 3.0, 4.0, 5.0, 7.0];
        let x1 = [2.0, 1.0, 5.0, 3.0, 8.0, 2.0];
        let y: Vec<f64> = x0.iter().zip(&x1).map(|(a, b)| 2.0 * a - b + 3.0).collect();
        let mut data = Vec::new();
        data.extend_from_slice(&x0);
        data.extend_from_slice(&x1);
        data.extend_from_slice(&y);
        let mut gram = vec![0.0; gram_len(3)];
        accumulate_gram(&data, 6, 0..6, &[0, 1, 2], &mut gram);
        let c = solve(&gram, 3).unwrap();
        let row = &c[2 * 4..3 * 4];
        assert!((row[0] - 2.0).abs() < 1e-8, "{row:?}");
        assert!((row[1] + 1.0).abs() < 1e-8, "{row:?}");
        assert_eq!(row[2], 0.0);
        assert!((row[3] - 3.0).abs() < 1e-7, "{row:?}");
    }
}
