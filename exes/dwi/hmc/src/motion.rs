// SPDX-License-Identifier: BSD-3-Clause AND BSD-2-Clause AND Apache-2.0
//! Head-motion parameters and the motion TSV (`*_desc-hmc_motion.tsv`).
//!
//! [`ras_motion_params`] is a port of QSIPrep 26.1.1's `get_ras_motion_params`
//! (`qsiprep/interfaces/gradients.py:905-944`, commit 371b537a, BSD-3-Clause, `LICENSE-QSIPREP`).
//! It calls two library functions, ported here with it:
//!
//! - [`decompose44`]: transforms3d 0.4.2 `affines.decompose44` (commit 6a43a98e, BSD-2-Clause,
//!   `LICENSE-TRANSFORMS3D`), Spencer Thomas's Gram-Schmidt split into translation, rotation,
//!   zooms and shears.
//! - [`rotation_vector`]: SciPy 1.11.4 `Rotation.from_matrix(...).as_rotvec()`
//!   (`scipy/spatial/transform/_rotation.pyx`, BSD-3-Clause, `LICENSE-SCIPY`), the version
//!   QSIPrep 26.1.1 pins.
//!
//! [`framewise_displacement`] is nipype 1.11.0's `FramewiseDisplacement` with
//! `parameter_source="SPM"` (Apache-2.0), which QSIPrep runs on these parameters.
//!
//! Every frame is RAS+. The translation is the motion of the point `A[:3,:3]·c`, where `A` is
//! the reference grid's voxel-to-RAS affine and `c = (shape − 1)/2`: the grid centre minus the
//! grid origin, not the world grid centre `A·c`. On an oblique grid whose origin is far from its
//! centre the two differ by about |θ| × that distance; [`world_centre_motion`] gives the
//! world-centre form for comparison.

use crate::{ItkAffine, Matrix4};
use std::fmt;

/// A 3×3 matrix, row-major.
pub type Matrix3 = [[f64; 3]; 3];

/// A reference grid: its shape and its voxel-to-RAS affine (nibabel's `img.affine`).
#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    pub shape: [usize; 3],
    pub affine: Matrix4,
}

impl Grid {
    /// The voxel centre of the grid, `(shape − 1)/2`.
    pub fn centre_voxel(&self) -> [f64; 3] {
        self.shape.map(|n| (n as f64 - 1.0) / 2.0)
    }

    /// The world grid centre `A·c`, by nibabel's `apply_affine`: `A[:3,:3]·c + A[:3,3]`.
    pub fn world_centre(&self) -> [f64; 3] {
        let c = self.centre_voxel();
        let a = &self.affine;
        std::array::from_fn(|i| a[i][0] * c[0] + a[i][1] * c[1] + a[i][2] * c[2] + a[i][3])
    }

    /// QSIPrep's pivot `center_mm`: `apply_affine(A, c) − A[:3,3]`, about `A[:3,:3]·c`.
    pub fn pivot(&self) -> [f64; 3] {
        let w = self.world_centre();
        std::array::from_fn(|i| w[i] - self.affine[i][3])
    }
}

/// One volume's motion, in QSIPrep's `CombineMotions` order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    /// Zooms `sx, sy, sz`; one may be negative for a reflection.
    pub scale: [f64; 3],
    /// Shears `sxy, sxz, syz`.
    pub shear: [f64; 3],
    /// Rotation vector (radians) about RAS+ x, y and z.
    pub rotation: [f64; 3],
    /// Translation (mm) along RAS+ x, y and z.
    pub translation: [f64; 3],
}

impl Motion {
    /// No motion: unit scale, everything else zero.
    pub const IDENTITY: Motion = Motion {
        scale: [1.0; 3],
        shear: [0.0; 3],
        rotation: [0.0; 3],
        translation: [0.0; 3],
    };

    /// The twelve values as `get_ras_motion_params` returns them: scale, shear, rotation,
    /// translation (QSIPrep's `scaleX … shiftZ` columns).
    pub fn to_array(&self) -> [f64; 12] {
        let mut out = [0.0; 12];
        out[0..3].copy_from_slice(&self.scale);
        out[3..6].copy_from_slice(&self.shear);
        out[6..9].copy_from_slice(&self.rotation);
        out[9..12].copy_from_slice(&self.translation);
        out
    }

    /// The SPM movement parameters: translation, then rotation (`spm_movpar.txt`).
    pub fn spm(&self) -> [f64; 6] {
        let t = self.translation;
        let r = self.rotation;
        [t[0], t[1], t[2], r[0], r[1], r[2]]
    }
}

/// transforms3d's `decompose44` result: `A = T · R · diag(Z) · S`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Decomposition {
    pub translation: [f64; 3],
    pub rotation: Matrix3,
    pub zooms: [f64; 3],
    /// `sxy, sxz, syz`, the upper triangle of the unit shear matrix.
    pub shears: [f64; 3],
}

fn dot3(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn det3(m: &Matrix3) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/// transforms3d 0.4.2 `affines.decompose44`, statement by statement.
pub fn decompose44(a44: &Matrix4) -> Decomposition {
    let translation = [a44[0][3], a44[1][3], a44[2][3]];
    // M0, M1, M2 = np.array(RZS).T: the columns of the 3×3 part.
    let column = |j: usize| [a44[0][j], a44[1][j], a44[2][j]];
    let (mut m0, mut m1, mut m2) = (column(0), column(1), column(2));
    let mut sx = dot3(&m0, &m0).sqrt();
    m0 = m0.map(|v| v / sx);
    let sx_sxy = dot3(&m0, &m1);
    m1 = std::array::from_fn(|i| m1[i] - sx_sxy * m0[i]);
    let sy = dot3(&m1, &m1).sqrt();
    m1 = m1.map(|v| v / sy);
    let sxy = sx_sxy / sx;
    let sx_sxz = dot3(&m0, &m2);
    let sy_syz = dot3(&m1, &m2);
    m2 = std::array::from_fn(|i| m2[i] - (sx_sxz * m0[i] + sy_syz * m1[i]));
    let sz = dot3(&m2, &m2).sqrt();
    m2 = m2.map(|v| v / sz);
    let sxz = sx_sxz / sx;
    let syz = sy_syz / sy;
    // Rmat = np.array([M0, M1, M2]).T
    let mut rotation: Matrix3 = std::array::from_fn(|i| [m0[i], m1[i], m2[i]]);
    if det3(&rotation) < 0.0 {
        sx *= -1.0;
        for row in &mut rotation {
            row[0] *= -1.0;
        }
    }
    Decomposition {
        translation,
        rotation,
        zooms: [sx, sy, sz],
        shears: [sxy, sxz, syz],
    }
}

/// SciPy 1.11.4 `Rotation.from_matrix(m).as_rotvec()`: the quaternion by the largest of the
/// diagonal and the trace, normalised, made canonical (w ≥ 0), then `angle / sin(angle/2)` times
/// its vector part, with the series `2 + θ²/12 + 7θ⁴/2880` below 1e-3 rad.
pub fn rotation_vector(m: &Matrix3) -> [f64; 3] {
    // from_matrix
    let decision = [m[0][0], m[1][1], m[2][2], m[0][0] + m[1][1] + m[2][2]];
    let mut choice = 0;
    let mut vmax = decision[0];
    for (i, &d) in decision.iter().enumerate().skip(1) {
        if d > vmax {
            choice = i;
            vmax = d;
        }
    }
    let mut q = [0.0; 4];
    if choice != 3 {
        let i = choice;
        let j = (i + 1) % 3;
        let k = (j + 1) % 3;
        q[i] = 1.0 - decision[3] + 2.0 * m[i][i];
        q[j] = m[j][i] + m[i][j];
        q[k] = m[k][i] + m[i][k];
        q[3] = m[k][j] - m[j][k];
    } else {
        q[0] = m[2][1] - m[1][2];
        q[1] = m[0][2] - m[2][0];
        q[2] = m[1][0] - m[0][1];
        q[3] = 1.0 + decision[3];
    }
    let norm = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if norm != 0.0 {
        q = q.map(|v| v / norm);
    }
    // as_rotvec: _quat_canonical_single
    if q[3] < 0.0
        || (q[3] == 0.0 && q[0] < 0.0)
        || (q[3] == 0.0 && q[0] == 0.0 && q[1] < 0.0)
        || (q[3] == 0.0 && q[0] == 0.0 && q[1] == 0.0 && q[2] < 0.0)
    {
        q = q.map(|v| -v); // q *= -1.0
    }
    let vector = [q[0], q[1], q[2]];
    let angle = 2.0 * dot3(&vector, &vector).sqrt().atan2(q[3]);
    let scale = if angle <= 1e-3 {
        let angle2 = angle * angle;
        2.0 + angle2 / 12.0 + 7.0 * angle2 * angle2 / 2880.0
    } else {
        angle / (angle / 2.0).sin()
    };
    vector.map(|v| scale * v)
}

/// The RAS matrix of an ITK transform as `get_ras_motion_params` builds it:
/// `m_lps[:3,3] = offset + center − mat @ center`, then diag(−1, −1, 1, 1) on both sides.
fn qsiprep_ras(xfm: &ItkAffine) -> Matrix4 {
    let p = &xfm.parameters;
    let c = &xfm.fixed;
    let mut m = [[0.0; 4], [0.0; 4], [0.0; 4], [0.0, 0.0, 0.0, 1.0]];
    for i in 0..3 {
        let mat_c = p[3 * i] * c[0] + p[3 * i + 1] * c[1] + p[3 * i + 2] * c[2];
        m[i][3] = (p[9 + i] + c[i]) - mat_c;
        for j in 0..3 {
            m[i][j] = p[3 * i + j];
        }
    }
    const FLIP: [f64; 4] = [-1.0, -1.0, 1.0, 1.0];
    std::array::from_fn(|i| std::array::from_fn(|j| FLIP[i] * m[i][j] * FLIP[j]))
}

/// The motion of `m_ras` decomposed, with the translation of the point `pivot` (RAS mm):
/// QSIPrep's loop `(m[i,3] − p_i) + (m[i,0]·p_0 + m[i,1]·p_1 + m[i,2]·p_2)`.
pub fn motion_about(m_ras: &Matrix4, pivot: [f64; 3]) -> Motion {
    let d = decompose44(m_ras);
    let rotation = rotation_vector(&d.rotation);
    let translation = std::array::from_fn(|i| {
        (m_ras[i][3] - pivot[i])
            + (m_ras[i][0] * pivot[0] + m_ras[i][1] * pivot[1] + m_ras[i][2] * pivot[2])
    });
    Motion {
        scale: d.zooms,
        shear: d.shears,
        rotation,
        translation,
    }
}

/// QSIPrep 26.1.1 `get_ras_motion_params(itk_file, ref_file)`: an ITK (LPS) transform from the
/// reference grid to a volume, as RAS+ motion about QSIPrep's pivot `A[:3,:3]·c`.
pub fn ras_motion_params(xfm: &ItkAffine, grid: &Grid) -> Motion {
    motion_about(&qsiprep_ras(xfm), grid.pivot())
}

/// The same decomposition of a RAS matrix from reference to scan (NiFreeze's motion affines).
pub fn ras_motion(m_ras: &Matrix4, grid: &Grid) -> Motion {
    motion_about(m_ras, grid.pivot())
}

/// [`ras_motion`] with the translation of the world grid centre `A·c` instead.
pub fn world_centre_motion(m_ras: &Matrix4, grid: &Grid) -> Motion {
    motion_about(m_ras, grid.world_centre())
}

/// The ITK transform's RAS matrix, exactly as [`ras_motion_params`] builds it.
pub fn itk_ras_matrix(xfm: &ItkAffine) -> Matrix4 {
    qsiprep_ras(xfm)
}

/// Power et al.'s 50 mm head radius, nipype's default.
pub const FD_RADIUS: f64 = 50.0;

/// Framewise displacement as nipype 1.11.0 `FramewiseDisplacement(parameter_source="SPM")`:
/// `Σ|Δtranslation| + 50 · Σ|Δrotation|` between consecutive rows. The first row has none
/// (`None`, written `n/a`), as in QSIPrep's confounds.
pub fn framewise_displacement(rows: &[Motion]) -> Vec<Option<f64>> {
    let mut out = Vec::with_capacity(rows.len());
    if rows.is_empty() {
        return out;
    }
    out.push(None);
    for pair in rows.windows(2) {
        let (a, b) = (pair[0].spm(), pair[1].spm());
        let mut diff: [f64; 6] = std::array::from_fn(|k| a[k] - b[k]);
        for d in &mut diff[3..6] {
            *d *= FD_RADIUS;
        }
        out.push(Some(diff.iter().fold(0.0, |s, d| s + d.abs())));
    }
    out
}

/// NiFreeze's `DEFAULT_LOWB_THRESHOLD` (3bcfb00): volumes with b ≤ 50 are b0 volumes, which
/// NiFreeze removes before registration.
pub const NIFREEZE_LOWB_THRESHOLD: f64 = 50.0;

/// Why per-volume rows could not be assembled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MotionError {
    /// The number of diffusion-weighted transforms differs from the number of b > 50 volumes.
    VolumeCount { weighted: usize, transforms: usize },
}

impl fmt::Display for MotionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MotionError::VolumeCount {
                weighted,
                transforms,
            } => write!(
                f,
                "{transforms} transforms for {weighted} diffusion-weighted volumes"
            ),
        }
    }
}

impl std::error::Error for MotionError {}

/// One row per input volume for the NiFreeze path: NiFreeze registers only the volumes with
/// b > [`NIFREEZE_LOWB_THRESHOLD`], in order, so each b0 volume gets an identity row and keeps
/// its place (the outputs keep the b0 volumes). This rule is proposed in #441 and waits for the
/// maintainer: SHORELine registers its b0 volumes, so there the two methods differ.
pub fn nifreeze_rows(bvals: &[f64], weighted: &[Motion]) -> Result<Vec<Motion>, MotionError> {
    let count = bvals
        .iter()
        .filter(|&&b| b > NIFREEZE_LOWB_THRESHOLD)
        .count();
    if count != weighted.len() {
        return Err(MotionError::VolumeCount {
            weighted: count,
            transforms: weighted.len(),
        });
    }
    let mut next = weighted.iter();
    Ok(bvals
        .iter()
        .map(|&b| {
            if b > NIFREEZE_LOWB_THRESHOLD {
                *next.next().unwrap()
            } else {
                Motion::IDENTITY
            }
        })
        .collect())
}

/// Which columns the motion TSV has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Columns {
    /// Rigid registration (NiFreeze): translation, rotation and framewise displacement.
    Rigid,
    /// Affine registration (SHORELine): the rigid columns, then `scale_x scale_y scale_z`.
    Affine,
}

impl Columns {
    /// The header names in order.
    pub fn names(self) -> &'static [&'static str] {
        const RIGID: [&str; 7] = [
            "trans_x",
            "trans_y",
            "trans_z",
            "rot_x",
            "rot_y",
            "rot_z",
            "framewise_displacement",
        ];
        const AFFINE: [&str; 10] = [
            "trans_x",
            "trans_y",
            "trans_z",
            "rot_x",
            "rot_y",
            "rot_z",
            "framewise_displacement",
            "scale_x",
            "scale_y",
            "scale_z",
        ];
        match self {
            Columns::Rigid => &RIGID,
            Columns::Affine => &AFFINE,
        }
    }
}

/// A number as Python's `repr(float)` writes it (pandas and NumPy text output): the shortest
/// string that reads back to the same double, positional when the decimal exponent is in
/// −4..16, otherwise `d.ddde±XX`. Non-finite values are written `n/a`.
pub fn format_number(v: f64) -> String {
    if !v.is_finite() {
        return "n/a".to_string();
    }
    // Rust's `{:e}` is the shortest round-trip digits: "-1.2345e-7".
    let sci = format!("{v:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let (sign, mantissa) = match mantissa.strip_prefix('-') {
        Some(m) => ("-", m),
        None => ("", mantissa),
    };
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    if (-4..16).contains(&exp) {
        let n = digits.len() as i32;
        if exp < 0 {
            let zeros = "0".repeat((-exp - 1) as usize);
            format!("{sign}0.{zeros}{digits}")
        } else if exp + 1 >= n {
            let zeros = "0".repeat((exp + 1 - n) as usize);
            format!("{sign}{digits}{zeros}.0")
        } else {
            let (int, frac) = digits.split_at((exp + 1) as usize);
            format!("{sign}{int}.{frac}")
        }
    } else {
        let (first, rest) = digits.split_at(1);
        let dot = if rest.is_empty() { "" } else { "." };
        let esign = if exp < 0 { '-' } else { '+' };
        format!("{sign}{first}{dot}{rest}e{esign}{:02}", exp.abs())
    }
}

/// The motion TSV: a header, then one row per input volume, tab-separated, `\n` line ends.
/// Translations in mm, rotations as RAS+ rotation vectors in radians, framewise displacement in
/// mm (`n/a` on the first row), scales unitless; numbers by [`format_number`].
pub fn motion_tsv(rows: &[Motion], columns: Columns) -> String {
    let fd = framewise_displacement(rows);
    let mut out = columns.names().join("\t");
    out.push('\n');
    for (row, fd) in rows.iter().zip(fd) {
        let mut cells: Vec<String> = row.spm().iter().map(|&v| format_number(v)).collect();
        cells.push(fd.map_or_else(|| "n/a".to_string(), format_number));
        if columns == Columns::Affine {
            cells.extend(row.scale.iter().map(|&v| format_number(v)));
        }
        out.push_str(&cells.join("\t"));
        out.push('\n');
    }
    out
}
