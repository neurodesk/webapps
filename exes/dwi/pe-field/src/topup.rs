// SPDX-License-Identifier: Apache-2.0
//! The susceptibility field (Hz) of a topup coefficient file (`*_fieldcoef.nii.gz`).
//!
//! A clean-room implementation from the file's header and from topup's own output, not from
//! FSL source. `tools/topup_reference.py` and `tests/topup.rs` hold it to the field that topup
//! writes with `--fout`. What the file holds:
//!
//! - NIfTI `intent_code` 2016 ("FSL topup cubic spline"); `pixdim` 1-3 are the knot spacing in
//!   voxels of the image grid topup ran on, and `intent_p1-3` that grid's voxel size in mm.
//! - One coefficient per knot, ⌊N/k⌋ + 3 along an axis of N voxels with knot spacing k.
//! - Knot j of an axis is at voxel (j - 1)·k, and the field is the tensor product of cubic
//!   B-splines of width 4k centred on the knots.
//! - The voxel axes are FSL's: for an image whose affine has a positive determinant, FSL counts
//!   x from the other end (voxel x is N - 1 - i).

/// The NIfTI intent code of a topup coefficient file.
pub const INTENT_TOPUP_CUBIC_SPLINE: i32 = 2016;

/// A topup coefficient grid.
#[derive(Clone, Debug)]
pub struct TopupCoefficients {
    dims: [usize; 3],
    knot_spacing: [usize; 3],
    /// NIfTI order (x fastest), with one plane of zeros after the last knot of each axis: the
    /// last voxel of an axis whose length is not a multiple of k reaches one knot past the
    /// grid, and topup's field treats that knot's coefficient as 0.
    padded: Vec<f64>,
}

impl TopupCoefficients {
    /// `dims` and `data` are the coefficient image's (NIfTI order, x fastest); `knot_spacing`
    /// is its `pixdim` 1-3, which must be whole voxels.
    pub fn new(dims: [usize; 3], knot_spacing: [f64; 3], data: &[f32]) -> Result<Self, String> {
        if data.len() != dims.iter().product::<usize>() {
            return Err(format!(
                "The coefficient file has {} values, not {}x{}x{}.",
                data.len(),
                dims[0],
                dims[1],
                dims[2]
            ));
        }
        let mut spacing = [0; 3];
        for a in 0..3 {
            let k = knot_spacing[a];
            if !(k >= 1.0 && k.fract() == 0.0) {
                return Err(format!(
                    "The knot spacing {k} (pixdim {}) is not a whole number of voxels; is this a topup coefficient file?",
                    a + 1
                ));
            }
            spacing[a] = k as usize;
        }
        let [px, py, pz] = dims.map(|n| n + 1);
        let mut padded = vec![0.0; px * py * pz];
        for c in 0..dims[2] {
            for b in 0..dims[1] {
                for a in 0..dims[0] {
                    padded[a + px * (b + py * c)] = data[a + dims[0] * (b + dims[1] * c)] as f64;
                }
            }
        }
        Ok(Self {
            dims,
            knot_spacing: spacing,
            padded,
        })
    }

    /// Whether this coefficient grid fits an image grid of `dims` voxels: ⌊N/k⌋ + 3 per axis.
    pub fn fits(&self, dims: [usize; 3]) -> bool {
        (0..3).all(|a| dims[a] / self.knot_spacing[a] + 3 == self.dims[a])
    }

    /// The field in Hz at every voxel of the image grid topup ran on (`dims`, NIfTI order).
    /// `fsl_flips_x` comes from that grid's affine (`crate::fsl_flips_x`).
    pub fn evaluate(&self, dims: [usize; 3], fsl_flips_x: bool) -> Result<Vec<f64>, String> {
        if !self.fits(dims) {
            return Err(format!(
                "A {}x{}x{} coefficient grid with knot spacing {:?} does not fit a {}x{}x{} image; give the grid topup ran on.",
                self.dims[0],
                self.dims[1],
                self.dims[2],
                self.knot_spacing,
                dims[0],
                dims[1],
                dims[2]
            ));
        }
        let weights: Vec<Vec<(usize, [f64; 4])>> = (0..3)
            .map(|a| {
                (0..dims[a])
                    .map(|i| {
                        let i = if a == 0 && fsl_flips_x {
                            dims[0] - 1 - i
                        } else {
                            i
                        };
                        knot_weights(i, self.knot_spacing[a])
                    })
                    .collect()
            })
            .collect();
        let [cx, cy] = [self.dims[0] + 1, self.dims[1] + 1];
        let mut field = Vec::with_capacity(dims.iter().product());
        for wz in &weights[2] {
            for wy in &weights[1] {
                for wx in &weights[0] {
                    let mut sum = 0.0;
                    for (c, &bz) in wz.1.iter().enumerate() {
                        for (b, &by) in wy.1.iter().enumerate() {
                            let row = cx * (wy.0 + b + cy * (wz.0 + c));
                            let mut line = 0.0;
                            for (a, &bx) in wx.1.iter().enumerate() {
                                line += bx * self.padded[row + wx.0 + a];
                            }
                            sum += bz * by * line;
                        }
                    }
                    field.push(sum);
                }
            }
        }
        Ok(field)
    }
}

/// The four knots whose B-splines cover voxel `i`, as (first knot, weights). Knot j is at
/// voxel (j - 1)·k, so for u = i/k + 1 the knots floor(u) - 1 ..= floor(u) + 2 are non-zero.
fn knot_weights(i: usize, k: usize) -> (usize, [f64; 4]) {
    let first = i / k;
    let frac = (i % k) as f64 / k as f64;
    // t = u - j for j = first .. first + 3, with u = first + 1 + frac.
    let w = [1.0 + frac, frac, frac - 1.0, frac - 2.0].map(cubic_bspline);
    (first, w)
}

/// The centred cubic B-spline, support (-2, 2).
fn cubic_bspline(t: f64) -> f64 {
    let t = t.abs();
    if t < 1.0 {
        2.0 / 3.0 - t * t + t * t * t / 2.0
    } else if t < 2.0 {
        let s = 2.0 - t;
        s * s * s / 6.0
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_sum_to_one() {
        for k in 1..5 {
            for i in 0..3 * k {
                let (_, w) = knot_weights(i, k);
                assert!((w.iter().sum::<f64>() - 1.0).abs() < 1e-15);
            }
        }
    }

    #[test]
    fn constant_coefficients_give_a_constant_field() {
        let dims = [7, 6, 5];
        let coef_dims = [7 / 2 + 3, 6 / 2 + 3, 5 / 2 + 3];
        let n: usize = coef_dims.iter().product();
        let c = TopupCoefficients::new(coef_dims, [2.0; 3], &vec![12.5; n]).unwrap();
        for flip in [false, true] {
            let field = c.evaluate(dims, flip).unwrap();
            assert_eq!(field.len(), 7 * 6 * 5);
            assert!(field.iter().all(|&f| (f - 12.5).abs() < 1e-12));
        }
    }

    #[test]
    fn refuses_a_grid_the_coefficients_do_not_fit() {
        let c = TopupCoefficients::new([6, 6, 6], [2.0; 3], &vec![0.0; 216]).unwrap();
        assert!(c.fits([6, 7, 7]));
        assert!(c.evaluate([8, 6, 6], false).is_err());
        assert!(TopupCoefficients::new([6, 6, 6], [2.5, 2.0, 2.0], &vec![0.0; 216]).is_err());
        assert!(TopupCoefficients::new([6, 6, 6], [2.0; 3], &[0.0; 10]).is_err());
    }
}
