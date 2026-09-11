use crate::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat4(pub [[f64; 4]; 4]);

impl Mat4 {
    pub const IDENTITY: Self = Self([
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]);

    pub fn apply(self, point: [f64; 3]) -> [f64; 3] {
        let p = [point[0], point[1], point[2], 1.0];
        let mut out = [0.0; 3];
        for (r, value) in out.iter_mut().enumerate() {
            *value = (0..4).map(|c| self.0[r][c] * p[c]).sum();
        }
        out
    }

    pub fn inverse(self) -> Result<Self> {
        let mut a = [[0.0; 8]; 4];
        for r in 0..4 {
            for (c, value) in self.0[r].iter().enumerate() {
                a[r][c] = *value;
            }
            a[r][r + 4] = 1.0;
        }
        for col in 0..4 {
            let pivot = (col..4)
                .max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs()))
                .unwrap();
            if a[pivot][col].abs() < 1e-12 {
                return Err(Error("singular spatial transform".into()));
            }
            a.swap(col, pivot);
            let scale = a[col][col];
            for value in &mut a[col] {
                *value /= scale;
            }
            for row in 0..4 {
                if row == col {
                    continue;
                }
                let scale = a[row][col];
                let pivot = a[col];
                for (value, pivot) in a[row].iter_mut().zip(pivot) {
                    *value -= scale * pivot;
                }
            }
        }
        let mut out = [[0.0; 4]; 4];
        for r in 0..4 {
            out[r].copy_from_slice(&a[r][4..]);
        }
        Ok(Self(out))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    pub dims: [usize; 3],
    /// NIfTI voxel-to-LPS physical transform. Vectors/wraps use this space.
    pub lps_from_voxel: Mat4,
}

impl Grid {
    /// Voxel coordinates of a linear (x fastest) index.
    pub fn voxel(&self, index: usize) -> [f64; 3] {
        [
            (index % self.dims[0]) as f64,
            ((index / self.dims[0]) % self.dims[1]) as f64,
            (index / (self.dims[0] * self.dims[1])) as f64,
        ]
    }
    pub fn voxel_to_lps(&self, voxel: [f64; 3]) -> [f64; 3] {
        self.lps_from_voxel.apply(voxel)
    }
    pub fn lps_to_voxel(&self, point: [f64; 3]) -> Result<[f64; 3]> {
        Ok(self.lps_from_voxel.inverse()?.apply(point))
    }

    pub fn ras_from_lps(point: [f64; 3]) -> [f64; 3] {
        [-point[0], -point[1], point[2]]
    }
    pub fn lps_from_ras(point: [f64; 3]) -> [f64; 3] {
        Self::ras_from_lps(point)
    }
}
