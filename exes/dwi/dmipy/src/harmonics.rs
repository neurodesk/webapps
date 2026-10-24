// SPDX-License-Identifier: MIT
//! Real even-order harmonics in dmipy's legacy Tournier convention.
//! Negative m is the imaginary part, positive m the real part, without sqrt(2).

use std::f64::consts::PI;

pub fn count(order: usize) -> usize {
    (order + 1) * (order + 2) / 2
}

fn associated(l: usize, m: usize, z: f64) -> f64 {
    let mut p = 1.0;
    let sine = (1.0 - z * z).max(0.0).sqrt();
    for j in 1..=m {
        p *= -((2 * j - 1) as f64) * sine;
    }
    if l == m {
        return p;
    }
    let mut next = z * (2 * m + 1) as f64 * p;
    for degree in m + 2..=l {
        let value = ((2 * degree - 1) as f64 * z * next - (degree + m - 1) as f64 * p)
            / (degree - m) as f64;
        p = next;
        next = value;
    }
    next
}

pub fn basis(order: usize, direction: [f64; 3]) -> Vec<f64> {
    let z = direction[2].clamp(-1.0, 1.0);
    let phi = direction[1].atan2(direction[0]);
    let mut out = Vec::with_capacity(count(order));
    for l in (0..=order).step_by(2) {
        for signed in -(l as isize)..=l as isize {
            let m = signed.unsigned_abs();
            let ratio = (l - m + 1..=l + m).fold(1.0, |v, k| v / k as f64);
            let normalization = (((2 * l + 1) as f64 / (4.0 * PI)) * ratio).sqrt();
            let azimuth = if signed < 0 {
                (m as f64 * phi).sin()
            } else {
                (m as f64 * phi).cos()
            };
            out.push(normalization * associated(l, m, z) * azimuth);
        }
    }
    out
}

pub fn rotational_basis(order: usize, z: f64) -> Vec<f64> {
    (0..=order)
        .step_by(2)
        .map(|l| (((2 * l + 1) as f64) / (4.0 * PI)).sqrt() * associated(l, 0, z))
        .collect()
}

/// Pseudoinverse of the fixed, full-column-rank sampling designs. The matrices
/// are small and well conditioned; partial pivoting solves their normal system.
pub fn pseudoinverse(rows: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let n = rows[0].len();
    let mut system = vec![vec![0.0; n * 2]; n];
    for (i, row) in system.iter_mut().enumerate() {
        for j in 0..n {
            row[j] = rows.iter().map(|v| v[i] * v[j]).sum();
        }
        row[n + i] = 1.0;
    }
    for column in 0..n {
        let pivot = (column..n)
            .max_by(|&a, &b| system[a][column].abs().total_cmp(&system[b][column].abs()))
            .unwrap();
        system.swap(column, pivot);
        let scale = system[column][column];
        assert!(
            scale.abs() > 1e-12,
            "Sampling design must have full column rank"
        );
        for value in &mut system[column] {
            *value /= scale;
        }
        let pivot_row = system[column].clone();
        for (i, row) in system.iter_mut().enumerate() {
            if i == column {
                continue;
            }
            let factor = row[column];
            for (value, &pivot) in row.iter_mut().zip(&pivot_row) {
                *value -= factor * pivot;
            }
        }
    }
    (0..n)
        .map(|i| {
            rows.iter()
                .map(|row| (0..n).map(|j| system[i][n + j] * row[j]).sum())
                .collect()
        })
        .collect()
}

pub fn project(inverse: &[Vec<f64>], values: &[f64]) -> Vec<f64> {
    inverse
        .iter()
        .map(|row| row.iter().zip(values).map(|(a, b)| a * b).sum())
        .collect()
}
