// SPDX-License-Identifier: Apache-2.0
//! The polynomial terms of the eddy-current field.

use crate::Geometry;

/// The field model of one volume, as eddy's `--flm`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Model {
    /// 1, x, y, z.
    Linear,
    /// 1, x, y, z, x², y², z², xy, xz, yz.
    Quadratic,
}

impl Model {
    pub fn len(&self) -> usize {
        match self {
            Model::Linear => 4,
            Model::Quadratic => 10,
        }
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    /// The terms at voxel `ijk`. Coordinates are scaled to -1..1 over the grid (the voxel
    /// centres of the first and last voxel of an axis), which keeps the fit well
    /// conditioned. A complete linear or quadratic polynomial is the same function space in
    /// any rotated frame, so voxel axes lose nothing against scanner axes.
    pub fn terms(&self, geometry: &Geometry, ijk: [usize; 3]) -> Vec<f64> {
        let [x, y, z] = scaled(geometry, ijk);
        let mut t = vec![1.0, x, y, z];
        if *self == Model::Quadratic {
            t.extend([x * x, y * y, z * z, x * y, x * z, y * z]);
        }
        t
    }

    /// The derivative of each term along the PE axis, per voxel.
    pub fn pe_derivatives(&self, geometry: &Geometry, ijk: [usize; 3]) -> Vec<f64> {
        let u = scaled(geometry, ijk);
        let a = geometry.pe_axis;
        // d(scaled)/d(voxel) along the PE axis.
        let s = half_extent(geometry, a).recip();
        let mut d_lin = [0.0; 3];
        d_lin[a] = s;
        let mut t = vec![0.0, d_lin[0], d_lin[1], d_lin[2]];
        if *self == Model::Quadratic {
            let [x, y, z] = u;
            let [dx, dy, dz] = d_lin;
            t.extend([
                2.0 * x * dx,
                2.0 * y * dy,
                2.0 * z * dz,
                dx * y + x * dy,
                dx * z + x * dz,
                dy * z + y * dz,
            ]);
        }
        t
    }
}

fn half_extent(geometry: &Geometry, axis: usize) -> f64 {
    ((geometry.dims[axis] as f64 - 1.0) / 2.0).max(0.5)
}

fn scaled(geometry: &Geometry, ijk: [usize; 3]) -> [f64; 3] {
    std::array::from_fn(|a| {
        let centre = (geometry.dims[a] as f64 - 1.0) / 2.0;
        (ijk[a] as f64 - centre) / half_extent(geometry, a)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivatives_match_finite_differences() {
        let g = Geometry::new([7, 9, 5], [2.0; 3], 1, 1.0, 0.05).unwrap();
        for ijk in [[1, 3, 2], [5, 6, 1]] {
            let d = Model::Quadratic.pe_derivatives(&g, ijk);
            let up = Model::Quadratic.terms(&g, [ijk[0], ijk[1] + 1, ijk[2]]);
            let down = Model::Quadratic.terms(&g, [ijk[0], ijk[1] - 1, ijk[2]]);
            for t in 0..10 {
                // Exact for polynomials up to degree 2.
                assert!((d[t] - (up[t] - down[t]) / 2.0).abs() < 1e-12, "term {t}");
            }
        }
    }

    #[test]
    fn coordinates_span_minus_one_to_one() {
        let g = Geometry::new([5, 4, 1], [2.0; 3], 0, 1.0, 0.05).unwrap();
        assert_eq!(scaled(&g, [0, 0, 0]), [-1.0, -1.0, 0.0]);
        assert_eq!(scaled(&g, [4, 3, 0]), [1.0, 1.0, 0.0]);
        assert_eq!(
            Model::Linear.len(),
            Model::Linear.terms(&g, [0, 0, 0]).len()
        );
        assert_eq!(
            Model::Quadratic.len(),
            Model::Quadratic.terms(&g, [0, 0, 0]).len()
        );
    }
}
