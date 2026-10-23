// SPDX-License-Identifier: Apache-2.0
//! Rigid transforms of the grid's physical frame: p = voxel_size ⊙ (ijk - centre), in mm,
//! along the voxel axes. Parameters are translations (mm) and rotations (radians) about
//! x, y and z: p' = Rz Ry Rx p + t.

pub type Mat3 = [[f64; 3]; 3];

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Rigid {
    pub translation: [f64; 3],
    pub rotation: [f64; 3],
}

fn rx(a: f64) -> Mat3 {
    let (s, c) = a.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}

fn ry(a: f64) -> Mat3 {
    let (s, c) = a.sin_cos();
    [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
}

fn rz(a: f64) -> Mat3 {
    let (s, c) = a.sin_cos();
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}

fn drx(a: f64) -> Mat3 {
    let (s, c) = a.sin_cos();
    [[0.0, 0.0, 0.0], [0.0, -s, -c], [0.0, c, -s]]
}

fn dry(a: f64) -> Mat3 {
    let (s, c) = a.sin_cos();
    [[-s, 0.0, c], [0.0, 0.0, 0.0], [-c, 0.0, -s]]
}

fn drz(a: f64) -> Mat3 {
    let (s, c) = a.sin_cos();
    [[-s, -c, 0.0], [c, -s, 0.0], [0.0, 0.0, 0.0]]
}

pub fn mul(a: &Mat3, b: &Mat3) -> Mat3 {
    std::array::from_fn(|i| std::array::from_fn(|j| (0..3).map(|k| a[i][k] * b[k][j]).sum()))
}

pub fn apply(a: &Mat3, v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2])
}

pub fn transpose(a: &Mat3) -> Mat3 {
    std::array::from_fn(|i| std::array::from_fn(|j| a[j][i]))
}

impl Rigid {
    pub fn matrix(&self) -> Mat3 {
        let [a, b, c] = self.rotation;
        mul(&rz(c), &mul(&ry(b), &rx(a)))
    }

    /// The derivative of the rotation matrix with respect to each angle.
    pub fn matrix_derivatives(&self) -> [Mat3; 3] {
        let [a, b, c] = self.rotation;
        [
            mul(&rz(c), &mul(&ry(b), &drx(a))),
            mul(&rz(c), &mul(&dry(b), &rx(a))),
            mul(&drz(c), &mul(&ry(b), &rx(a))),
        ]
    }

    pub fn from_matrix(r: &Mat3, translation: [f64; 3]) -> Self {
        // R = Rz Ry Rx: r[2][0] = -sin(b), r[2][1] = cos(b) sin(a), r[1][0] = sin(c) cos(b).
        let b = (-r[2][0]).clamp(-1.0, 1.0).asin();
        let a = r[2][1].atan2(r[2][2]);
        let c = r[1][0].atan2(r[0][0]);
        Self {
            translation,
            rotation: [a, b, c],
        }
    }

    pub fn apply(&self, p: [f64; 3]) -> [f64; 3] {
        let q = apply(&self.matrix(), p);
        std::array::from_fn(|i| q[i] + self.translation[i])
    }

    /// self ∘ other: p ↦ self(other(p)).
    pub fn compose(&self, other: &Rigid) -> Rigid {
        let r = mul(&self.matrix(), &other.matrix());
        let t = self.apply(other.translation);
        Rigid::from_matrix(&r, t)
    }

    pub fn inverse(&self) -> Rigid {
        let rt = transpose(&self.matrix());
        let t = apply(&rt, self.translation);
        Rigid::from_matrix(&rt, [-t[0], -t[1], -t[2]])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_round_trips_and_inverse_composes_to_identity() {
        let t = Rigid {
            translation: [1.0, -2.0, 0.5],
            rotation: [0.1, -0.2, 0.3],
        };
        let back = Rigid::from_matrix(&t.matrix(), t.translation);
        for i in 0..3 {
            assert!((back.rotation[i] - t.rotation[i]).abs() < 1e-12);
        }
        let id = t.compose(&t.inverse());
        let p = id.apply([3.0, 4.0, 5.0]);
        for (a, b) in p.iter().zip([3.0, 4.0, 5.0]) {
            assert!((a - b).abs() < 1e-12);
        }
    }

    #[test]
    fn derivatives_match_finite_differences() {
        let t = Rigid {
            translation: [0.0; 3],
            rotation: [0.2, -0.1, 0.4],
        };
        let d = t.matrix_derivatives();
        for (k, dk) in d.iter().enumerate() {
            let mut u = t;
            u.rotation[k] += 1e-6;
            let (a, b) = (u.matrix(), t.matrix());
            for i in 0..3 {
                for j in 0..3 {
                    assert!(((a[i][j] - b[i][j]) / 1e-6 - dk[i][j]).abs() < 1e-5);
                }
            }
        }
    }
}
