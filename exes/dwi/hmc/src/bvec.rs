// SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause
//! B-vector rotation after head-motion correction, by the rule of the method that estimated the
//! motion. Each volume has its own ITK affine from `antsRegistration` (`*0GenericAffine.mat`,
//! fixed = the reference, moving = the volume). The output keeps every volume: b0 columns are
//! written unchanged, and the gradients crate's rule of each method decides which columns are b0.
//!
//! **NiFreeze** ([`BvecRule::NiFreeze`]) ports `transform_fsl_bvec` and the gradient writer of
//! `to_nifti` from NiFreeze 3bcfb00df1e008b4dfeb59c0d63717c335ba0d1e
//! (`src/nifreeze/data/dmri/utils.py:285-317`, `src/nifreeze/data/dmri/io.py:183-234`),
//! Copyright The NiPreps Developers, Apache-2.0. NiFreeze stores each motion as nitransforms'
//! RAS matrix M of the ANTs transform ([`ItkAffine::ras`]) and rotates the FSL b-vector b with
//! the 3×3 block of inv(A)·inv(M)·A, A being the image affine. The result is not renormalised.
//! It reads the bvec and bval files as `float32` (`np.loadtxt(..., dtype="float32")`) and
//! formats the table as [`B0Rule::NiFreeze`] does, so the inputs are rounded to `f32` first.
//! Written with `%.6f` (b-vectors) and `%.2f` (b-values).
//!
//! **SHORELine** ([`BvecRule::ShoreLine`]) ports `aattp_rotate_vec` and `bvec_rotation` from
//! QSIPrep 26.1.1 (`qsiprep/interfaces/gradients.py:1003-1060`, `safe_unit_vector` in
//! `qsiprep/utils/misc.py`), Copyright the BBL developers team, BSD-3-Clause (`LICENSE-QSIPREP`).
//! QSIPrep writes the points 0 and 5·b to a CSV, maps them with `antsApplyTransformsToPoints
//! --transform [affine, 1]` (the inverse transform, in LPS) and renormalises their difference.
//! `antsApplyTransformsToPoints` (ANTs 2.6.0, the version QSIPrep 26.1.1 pins) runs in `float`
//! unless given `--precision 1`, and QSIPrep does not give it, so the points are parsed as
//! `float`, the transform's parameters are rounded to `float`, its inverse is ITK's
//! single-precision SVD inverse ([`vnl_svd`]) and the points are written back with
//! `std::setprecision(6)`: six significant digits. This module repeats every one of those
//! roundings. Written with `%.8f`; the b-values with QSIPrep's `%i` (truncated to an integer).
//!
//! The files are what `numpy.savetxt` writes: one row per line, values separated by one space,
//! `\n` after every row (three rows of b-vectors, one row of b-values). Python's `%.Nf` rounds
//! the exact binary value half to even and keeps the sign of a negative value that rounds to
//! zero (`-0.000000`), and so does Rust's `{:.N}`.
//!
//! Limits. SHORELine is reproduced to the bit: every step is single precision or a decimal
//! round trip. NiFreeze's inverses and products run in LAPACK and BLAS kernels whose summation
//! order (and use of FMA) depends on the machine, so its values can differ in the last bit,
//! about 1e-16. That changes the printed `%.6f` only at an exact tie, or in the sign of a value
//! that should be 0: an exact identity motion leaves residues near 1e-17 that NiFreeze prints
//! as `0.000000` or `-0.000000` depending on those kernels.

mod vnl_svd;

use crate::{ItkAffine, Matrix4};
use dwi_gradients::B0Rule;

/// The rule that rotates the b-vectors, with what it needs besides the transforms.
#[derive(Clone, Debug, PartialEq)]
pub enum BvecRule {
    /// NiFreeze 3bcfb00, with the NIfTI affine of the series (voxel to RAS, as nibabel reads it).
    NiFreeze { image_affine: Matrix4 },
    /// SHORELine as QSIPrep 26.1.1 runs it. The b-vectors are taken as LPS directions, as
    /// QSIPrep's `GradientRotation` receives them.
    ShoreLine,
}

impl BvecRule {
    /// The b0 rule of the method, from the gradients crate.
    pub fn b0_rule(&self) -> B0Rule {
        match self {
            BvecRule::NiFreeze { .. } => B0Rule::NiFreeze,
            BvecRule::ShoreLine => B0Rule::QsiPrep,
        }
    }

    /// Decimal places of the written b-vectors: 6 for NiFreeze, 8 for QSIPrep.
    pub fn bvec_decimals(&self) -> usize {
        match self {
            BvecRule::NiFreeze { .. } => 6,
            BvecRule::ShoreLine => 8,
        }
    }
}

/// The rotated gradient table of every volume, b0 volumes included.
#[derive(Clone, Debug, PartialEq)]
pub struct HmcGradients {
    /// The b-values to write: the input's, except that NiFreeze rescales a diffusion-weighted
    /// b-value whose direction is not unit length (`format_gradients`).
    pub bvals: Vec<f64>,
    /// The rotated directions; b0 volumes keep the input's direction.
    pub bvecs: Vec<[f64; 3]>,
    /// Whether each volume is a b0 under the method's rule.
    pub b0: Vec<bool>,
    bvec_decimals: usize,
    shoreline: bool,
}

impl HmcGradients {
    /// The `*_desc-hmc_dwi.bvec` text: three rows, `%.6f` (NiFreeze) or `%.8f` (SHORELine).
    pub fn bvec_text(&self) -> String {
        let mut out = String::new();
        for axis in 0..3 {
            let row: Vec<String> = self
                .bvecs
                .iter()
                .map(|v| format!("{:.*}", self.bvec_decimals, v[axis]))
                .collect();
            out.push_str(&row.join(" "));
            out.push('\n');
        }
        out
    }

    /// The `*_desc-hmc_dwi.bval` text: one row, `%.2f` (NiFreeze) or `%i` (SHORELine).
    pub fn bval_text(&self) -> String {
        let row: Vec<String> = self
            .bvals
            .iter()
            .map(|&b| {
                if self.shoreline {
                    format!("{}", b.trunc() as i64)
                } else {
                    format!("{b:.2}")
                }
            })
            .collect();
        row.join(" ") + "\n"
    }
}

/// Rotates the gradient table with one transform per volume (a b0 volume's is not used).
/// `bvals` and `bvecs` are the numbers of the input files, read as `f64`.
pub fn rotate_gradients(
    rule: &BvecRule,
    bvals: &[f64],
    bvecs: &[[f64; 3]],
    transforms: &[ItkAffine],
) -> Result<HmcGradients, String> {
    if transforms.len() != bvals.len() {
        return Err(format!(
            "There are {} transforms for {} volumes.",
            transforms.len(),
            bvals.len()
        ));
    }
    let (ruled, shoreline) = match rule {
        // NiFreeze reads both files as float32 before it formats the table.
        BvecRule::NiFreeze { .. } => (
            B0Rule::NiFreeze.read(
                bvals.iter().map(|&b| b as f32 as f64).collect(),
                bvecs.iter().map(|g| g.map(|c| c as f32 as f64)).collect(),
            )?,
            false,
        ),
        BvecRule::ShoreLine => (B0Rule::QsiPrep.read(bvals.to_vec(), bvecs.to_vec())?, true),
    };
    let mut out = HmcGradients {
        bvals: Vec::with_capacity(bvals.len()),
        bvecs: Vec::with_capacity(bvals.len()),
        b0: Vec::with_capacity(bvals.len()),
        bvec_decimals: rule.bvec_decimals(),
        shoreline,
    };
    for (i, transform) in transforms.iter().enumerate() {
        let b0 = ruled.is_b0(i);
        out.b0.push(b0);
        if b0 {
            out.bvals.push(bvals[i]);
            out.bvecs.push(bvecs[i]);
            continue;
        }
        let rotated = match rule {
            BvecRule::NiFreeze { image_affine } => {
                out.bvals.push(ruled.bvals[i]);
                nifreeze_rotate(ruled.bvecs[i], &transform.ras(), image_affine)
            }
            BvecRule::ShoreLine => {
                out.bvals.push(bvals[i]);
                shoreline_rotate(bvecs[i], transform)
            }
        };
        out.bvecs
            .push(rotated.ok_or_else(|| format!("The transform of volume {i} is singular."))?);
    }
    Ok(out)
}

/// NiFreeze's `transform_fsl_bvec(b, M, A, invert=True)`: the 3×3 block of inv(A)·inv(M)·A
/// times b, with M the RAS motion matrix and A the image affine. `None` if either is singular.
pub fn nifreeze_rotate(
    b: [f64; 3],
    motion_ras: &Matrix4,
    image_affine: &Matrix4,
) -> Option<[f64; 3]> {
    let a = block(image_affine);
    let a_inv = inverse3(&a)?;
    let m_inv = inverse3(&block(motion_ras))?;
    // Only the 3×3 blocks reach the result: both matrices have the bottom row (0, 0, 0, 1).
    let x = product(&product(&a_inv, &m_inv), &a);
    Some(std::array::from_fn(|i| {
        x[i][0] * b[0] + x[i][1] * b[1] + x[i][2] * b[2]
    }))
}

/// QSIPrep's `aattp_rotate_vec(b, transform)`: the inverse transform applied in `float` to the
/// LPS points 0 and 5·b, each written with six significant digits, and the unit vector of their
/// difference. `None` if the transform is singular.
pub fn shoreline_rotate(b: [f64; 3], transform: &ItkAffine) -> Option<[f64; 3]> {
    if b.iter().all(|&c| c == 0.0) {
        return Some(b); // 'b0: No rotation'
    }
    // The CSV holds `str(5 * b)`, the shortest repr, which ANTs parses as float (strtof).
    let point: [f32; 3] = std::array::from_fn(|i| {
        format!("{}", 5.0 * b[i])
            .parse::<f32>()
            .expect("a finite number formats as a decimal")
    });
    let inverse = FloatAffine::new(transform).inverse()?;
    let p0 = csv_point(inverse.transform_point([0.0; 3]));
    let p1 = csv_point(inverse.transform_point(point));
    let d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    let norm = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    if norm == 0.0 {
        return Some([1.0, 0.0, 0.0]); // safe_unit_vector
    }
    Some(d.map(|c| c / norm))
}

/// A coordinate as `antsApplyTransformsToPoints` writes it (`std::setprecision(6)` of a float,
/// i.e. `%.6g`) and `np.loadtxt` reads it back.
fn csv_point(p: [f32; 3]) -> [f64; 3] {
    p.map(|c| {
        format!("{:.5e}", c as f64)
            .parse::<f64>()
            .expect("a finite number formats as a decimal")
    })
}

/// `itk::AffineTransform<float, 3>` as ITK holds it: the matrix and the offset.
struct FloatAffine {
    matrix: [[f32; 3]; 3],
    offset: [f32; 3],
}

impl FloatAffine {
    /// The parameters and centre rounded to float, and ITK's `ComputeOffset` in float:
    /// offset = t + c, then offset −= A[i][j]·c[j] for each j.
    fn new(t: &ItkAffine) -> Self {
        let p = t.parameters.map(|v| v as f32);
        let c = t.fixed.map(|v| v as f32);
        let matrix = std::array::from_fn(|i| std::array::from_fn(|j| p[3 * i + j]));
        let offset = std::array::from_fn(|i| {
            let mut o = p[9 + i] + c[i];
            for j in 0..3 {
                o -= p[3 * i + j] * c[j];
            }
            o
        });
        FloatAffine { matrix, offset }
    }

    /// `MatrixOffsetTransformBase::GetInverse`: the inverse matrix and −(inverse · offset).
    fn inverse(&self) -> Option<Self> {
        let matrix = vnl_svd::inverse(&self.matrix)?;
        let offset = mat_vec(&matrix, &self.offset).map(|v| -v);
        Some(FloatAffine { matrix, offset })
    }

    /// `TransformPoint`: matrix · point + offset.
    fn transform_point(&self, p: [f32; 3]) -> [f32; 3] {
        let m = mat_vec(&self.matrix, &p);
        std::array::from_fn(|i| m[i] + self.offset[i])
    }
}

/// `itk::Matrix<float>` times a vector: sum = 0, then sum += m[i][j]·v[j].
fn mat_vec(m: &[[f32; 3]; 3], v: &[f32; 3]) -> [f32; 3] {
    std::array::from_fn(|i| {
        let mut sum = 0.0f32;
        for j in 0..3 {
            sum += m[i][j] * v[j];
        }
        sum
    })
}

type Matrix3 = [[f64; 3]; 3];

fn block(m: &Matrix4) -> Matrix3 {
    std::array::from_fn(|i| std::array::from_fn(|j| m[i][j]))
}

fn product(a: &Matrix3, b: &Matrix3) -> Matrix3 {
    std::array::from_fn(|i| {
        std::array::from_fn(|j| a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])
    })
}

/// The inverse by LU with partial pivoting, solving A·X = I as `np.linalg.inv` (LAPACK
/// `gesv`) does. LAPACK's blocking and BLAS kernels may order the sums differently, which can
/// change the last bit: about 1e-16, far below the 1e-6 that NiFreeze prints.
#[allow(clippy::needless_range_loop)]
fn inverse3(a: &Matrix3) -> Option<Matrix3> {
    let mut lu = *a;
    let mut perm = [0usize, 1, 2];
    for k in 0..3 {
        let mut p = k;
        for i in k + 1..3 {
            if lu[i][k].abs() > lu[p][k].abs() {
                p = i;
            }
        }
        if lu[p][k] == 0.0 {
            return None;
        }
        lu.swap(k, p);
        perm.swap(k, p);
        for i in k + 1..3 {
            let l = lu[i][k] / lu[k][k];
            lu[i][k] = l;
            for j in k + 1..3 {
                lu[i][j] -= l * lu[k][j];
            }
        }
    }
    let mut x = [[0.0; 3]; 3];
    for col in 0..3 {
        // Forward substitution with the permuted identity column, then back substitution.
        let mut y: [f64; 3] = std::array::from_fn(|i| if perm[i] == col { 1.0 } else { 0.0 });
        for i in 1..3 {
            for j in 0..i {
                y[i] -= lu[i][j] * y[j];
            }
        }
        for i in (0..3).rev() {
            for j in i + 1..3 {
                y[i] -= lu[i][j] * y[j];
            }
            y[i] /= lu[i][i];
        }
        for i in 0..3 {
            x[i][col] = y[i];
        }
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Precision;

    const IDENTITY: Matrix4 = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];

    #[test]
    fn inverse3_inverts() {
        let a = [[0.0, 2.0, 1.0], [1.0, 0.5, -3.0], [4.0, 0.0, 2.0]];
        let x = inverse3(&a).unwrap();
        let p = product(&a, &x);
        for (i, row) in p.iter().enumerate() {
            for (j, v) in row.iter().enumerate() {
                let e = if i == j { 1.0 } else { 0.0 };
                assert!((v - e).abs() < 1e-15, "{p:?}");
            }
        }
        assert!(inverse3(&[[1.0, 2.0, 3.0], [2.0, 4.0, 6.0], [0.0, 0.0, 1.0]]).is_none());
    }

    #[test]
    fn float_svd_inverse_inverts() {
        let m = [
            [0.98f32, -0.17, 0.05],
            [0.17, 0.99, -0.02],
            [-0.05, 0.03, 1.02],
        ];
        let x = vnl_svd::inverse(&m).unwrap();
        for (i, row) in m.iter().enumerate() {
            for j in 0..3 {
                let v: f32 = (0..3).map(|k| row[k] * x[k][j]).sum();
                let e = if i == j { 1.0 } else { 0.0 };
                assert!((v - e).abs() < 1e-6, "{x:?}");
            }
        }
        assert!(vnl_svd::inverse(&[[1.0, 2.0, 0.0], [2.0, 4.0, 0.0], [0.0, 0.0, 1.0]]).is_none());
    }

    #[test]
    fn identity_keeps_directions() {
        let t = ItkAffine::from_lps(&IDENTITY, [0.0; 3], Precision::Double);
        let b = [0.6, 0.0, -0.8];
        assert_eq!(nifreeze_rotate(b, &IDENTITY, &IDENTITY), Some(b));
        let r = shoreline_rotate(b, &t).unwrap();
        assert!(r.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-6), "{r:?}");
        assert_eq!(shoreline_rotate([0.0; 3], &t), Some([0.0; 3]));
    }

    #[test]
    fn text_layout() {
        let t = ItkAffine::from_lps(&IDENTITY, [0.0; 3], Precision::Double);
        let rule = BvecRule::NiFreeze {
            image_affine: IDENTITY,
        };
        let g = rotate_gradients(
            &rule,
            &[0.0, 1000.0],
            &[[0.0; 3], [-1e-9, 0.0, 1.0]],
            &[t.clone(), t.clone()],
        )
        .unwrap();
        assert_eq!(g.b0, vec![true, false]);
        // The b0 keeps its input; -1e-9 survives float32 and prints as -0.
        assert_eq!(
            g.bvec_text(),
            "0.000000 -0.000000\n0.000000 0.000000\n0.000000 1.000000\n"
        );
        assert_eq!(g.bval_text(), "0.00 1000.00\n");
        let g = rotate_gradients(
            &BvecRule::ShoreLine,
            &[5.0, 999.7],
            &[[0.0; 3], [1.0, 0.0, 0.0]],
            &[t.clone(), t],
        )
        .unwrap();
        assert_eq!(g.bval_text(), "5 999\n");
        assert_eq!(g.bvec_text().lines().count(), 3);
    }

    #[test]
    fn transform_count_must_match() {
        let err = rotate_gradients(&BvecRule::ShoreLine, &[0.0], &[[0.0; 3]], &[]).unwrap_err();
        assert!(err.contains("0 transforms for 1 volumes"), "{err}");
    }
}
