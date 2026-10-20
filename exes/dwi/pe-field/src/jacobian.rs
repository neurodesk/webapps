// SPDX-License-Identifier: BSD-3-Clause
//! The phase-encoding Jacobian of a displacement field, as QSIPrep 26.1.1's
//! `jacobian_determinant` (`qsiprep/interfaces/jacobian.py`) computes it, after TORTOISE:
//! `1 + d(u_PE)/d(PE)` by central differences along the phase-encoding voxel axis, with the
//! two edge slices of that axis set to 1.

use crate::Affine;

/// The signed Jacobian `1 + d(u_PE)/d(PE)` of `displacement` (LPS mm, NIfTI voxel order) on
/// a grid of `dims` with `affine`. The displacement is projected on the direction of voxel
/// axis `pe_axis`, so an oblique grid works as an axis-aligned one. A value <= 0 is a fold.
pub fn jacobian_pe(
    displacement: &[[f64; 3]],
    dims: [usize; 3],
    affine: &Affine,
    pe_axis: usize,
) -> Vec<f64> {
    // The voxel axis in LPS, and its spacing.
    let column = [-affine[0][pe_axis], -affine[1][pe_axis], affine[2][pe_axis]];
    let spacing = (column[0] * column[0] + column[1] * column[1] + column[2] * column[2]).sqrt();
    let direction = column.map(|c| c / spacing);
    let along: Vec<f64> = displacement
        .iter()
        .map(|d| d[0] * direction[0] + d[1] * direction[1] + d[2] * direction[2])
        .collect();
    let stride = match pe_axis {
        0 => 1,
        1 => dims[0],
        _ => dims[0] * dims[1],
    };
    let n = dims[pe_axis];
    let mut out = vec![1.0; along.len()];
    for (v, value) in out.iter_mut().enumerate() {
        let i = (v / stride) % n;
        if i == 0 || i + 1 == n {
            continue;
        }
        *value = 1.0 + (along[v + stride] - along[v - stride]) / (2.0 * spacing);
    }
    out
}

/// The intensity weights QSIPrep applies: |Jacobian|, and how many of the voxels with
/// `mask` set have a Jacobian <= 0 (a folded field; QSIPrep reports them).
pub fn modulation_weights(signed: &[f64], mask: Option<&[bool]>) -> (Vec<f64>, usize) {
    let folds = signed
        .iter()
        .enumerate()
        .filter(|&(v, &j)| j <= 0.0 && mask.is_none_or(|m| m[v]))
        .count();
    (signed.iter().map(|j| j.abs()).collect(), folds)
}
