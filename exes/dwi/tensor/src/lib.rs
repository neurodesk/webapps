// Matrix code indexes rows and columns as the equations do.
#![allow(clippy::needless_range_loop)]
//! Diffusion tensor fit (Basser et al. 1994) on the log signal, by ordinary least squares or by
//! weighted least squares with the squared observed signal as weights. FSL `dtifit -w` gives the
//! same diffusivities for voxels whose samples are all positive (`packages/noddi/validation`).
//! b is in s/mm², so diffusivities are in mm²/s.

use dwi_gradients::Gradients;

/// The design of one gradient table: the log-signal model ln S = ln S0 − b gᵀ D g.
pub struct Design {
    /// One row per volume: [1, −b gx², −b gy², −b gz², −2b gx gy, −2b gx gz, −2b gy gz].
    rows: Vec<[f64; 7]>,
}

/// The fitted tensor of one voxel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TensorFit {
    pub s0: f64,
    /// Eigenvalues, largest first (mm²/s). They can be negative for a poor fit.
    pub evals: [f64; 3],
    /// Unit eigenvectors in the order of `evals`.
    pub evecs: [[f64; 3]; 3],
}

impl TensorFit {
    pub fn md(&self) -> f64 {
        (self.evals[0] + self.evals[1] + self.evals[2]) / 3.0
    }

    pub fn ad(&self) -> f64 {
        self.evals[0]
    }

    pub fn rd(&self) -> f64 {
        (self.evals[1] + self.evals[2]) / 2.0
    }

    /// FA is zero for any strictly negative eigenvalue. Other maps retain the unconstrained fit.
    /// Zero eigenvalues are valid: a rank-one tensor has FA = 1.
    pub fn fa(&self) -> f64 {
        let [l1, l2, l3] = self.evals;
        if self.evals.iter().any(|&value| value < 0.0) {
            return 0.0;
        }
        let norm = l1 * l1 + l2 * l2 + l3 * l3;
        if norm <= 0.0 {
            return 0.0;
        }
        let spread = (l1 - l2).powi(2) + (l2 - l3).powi(2) + (l3 - l1).powi(2);
        (0.5 * spread / norm).sqrt()
    }
}

impl Design {
    pub fn new(gradients: &Gradients) -> Self {
        let rows = gradients
            .bvals
            .iter()
            .zip(&gradients.bvecs)
            .map(|(&b, &[x, y, z])| {
                [
                    1.0,
                    -b * x * x,
                    -b * y * y,
                    -b * z * z,
                    -2.0 * b * x * y,
                    -2.0 * b * x * z,
                    -2.0 * b * y * z,
                ]
            })
            .collect();
        Self { rows }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Fits one voxel. A non-positive sample takes the smallest positive sample of the voxel, so
    /// the log is finite. Returns None when the voxel has no positive sample or the normal
    /// equations are singular.
    pub fn fit(&self, signal: &[f64], weighted: bool) -> Option<TensorFit> {
        assert_eq!(signal.len(), self.rows.len());
        let floor = signal
            .iter()
            .copied()
            .filter(|&s| s > 0.0 && s.is_finite())
            .fold(f64::INFINITY, f64::min);
        if !floor.is_finite() {
            return None;
        }
        let samples: Vec<f64> = signal
            .iter()
            .map(|&s| if s > 0.0 && s.is_finite() { s } else { floor })
            .collect();
        let logs: Vec<f64> = samples.iter().map(|s| s.ln()).collect();
        let weights: Vec<f64> = if weighted {
            samples.iter().map(|s| s * s).collect()
        } else {
            vec![1.0; samples.len()]
        };
        let beta = self.solve(&logs, &weights)?;
        Some(Self::decompose(beta))
    }

    /// Fits one voxel as dipy 1.7 `TensorModel(fit_method="WLS")` does, which AMICO uses for the
    /// fibre direction: samples below 1e-4 are raised to 1e-4, an OLS fit of the log signal gives
    /// the prediction p, and a second fit weights each row by exp(p)², i.e. the predicted signal
    /// squared (dipy `wls_fit_tensor`).
    pub fn fit_dipy_wls(&self, signal: &[f64]) -> Option<TensorFit> {
        assert_eq!(signal.len(), self.rows.len());
        let logs: Vec<f64> = signal.iter().map(|&s| s.max(1e-4).ln()).collect();
        let ols = self.solve(&logs, &vec![1.0; logs.len()])?;
        let weights: Vec<f64> = self
            .rows
            .iter()
            .map(|row| {
                let predicted: f64 = row.iter().zip(&ols).map(|(a, b)| a * b).sum();
                (2.0 * predicted).exp()
            })
            .collect();
        let beta = self.solve(&logs, &weights)?;
        Some(Self::decompose(beta))
    }

    fn decompose(beta: [f64; 7]) -> TensorFit {
        let tensor = [
            [beta[1], beta[4], beta[5]],
            [beta[4], beta[2], beta[6]],
            [beta[5], beta[6], beta[3]],
        ];
        let (evals, evecs) = eigen_symmetric(tensor);
        TensorFit {
            s0: beta[0].exp(),
            evals,
            evecs,
        }
    }

    /// Solves the weighted normal equations (Bᵀ W B) β = Bᵀ W y by Cholesky factorisation.
    fn solve(&self, y: &[f64], weights: &[f64]) -> Option<[f64; 7]> {
        let mut a = [[0.0f64; 7]; 7];
        let mut rhs = [0.0f64; 7];
        for ((row, &yi), &w) in self.rows.iter().zip(y).zip(weights) {
            for j in 0..7 {
                rhs[j] += w * row[j] * yi;
                for k in 0..=j {
                    a[j][k] += w * row[j] * row[k];
                }
            }
        }
        cholesky_solve(&mut a, &mut rhs)?;
        Some(rhs)
    }
}

/// Solves A x = b in place for a symmetric positive-definite A given by its lower triangle.
fn cholesky_solve(a: &mut [[f64; 7]; 7], b: &mut [f64; 7]) -> Option<()> {
    for j in 0..7 {
        let mut d = a[j][j];
        for k in 0..j {
            d -= a[j][k] * a[j][k];
        }
        if d <= 0.0 || !d.is_finite() {
            return None;
        }
        let d = d.sqrt();
        a[j][j] = d;
        for i in j + 1..7 {
            let mut s = a[i][j];
            for k in 0..j {
                s -= a[i][k] * a[j][k];
            }
            a[i][j] = s / d;
        }
    }
    for i in 0..7 {
        let mut s = b[i];
        for k in 0..i {
            s -= a[i][k] * b[k];
        }
        b[i] = s / a[i][i];
    }
    for i in (0..7).rev() {
        let mut s = b[i];
        for k in i + 1..7 {
            s -= a[k][i] * b[k];
        }
        b[i] = s / a[i][i];
    }
    Some(())
}

/// Eigenvalues (largest first) and unit eigenvectors of a symmetric 3×3 matrix by cyclic Jacobi
/// rotations. Each eigenvector has its largest-magnitude component positive, so the sign is the
/// same on every platform.
pub fn eigen_symmetric(m: [[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut a = m;
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..50 {
        let off = a[0][1].abs() + a[0][2].abs() + a[1][2].abs();
        let scale = a[0][0].abs() + a[1][1].abs() + a[2][2].abs();
        if off <= f64::EPSILON * scale || off == 0.0 {
            break;
        }
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            if a[p][q] == 0.0 {
                continue;
            }
            let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
            let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
            let t = if theta == 0.0 { 1.0 } else { t };
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            for k in 0..3 {
                let akp = a[k][p];
                let akq = a[k][q];
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for k in 0..3 {
                let apk = a[p][k];
                let aqk = a[q][k];
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for row in v.iter_mut() {
                let vp = row[p];
                let vq = row[q];
                row[p] = c * vp - s * vq;
                row[q] = s * vp + c * vq;
            }
        }
    }
    let mut order = [0usize, 1, 2];
    order.sort_by(|&i, &j| a[j][j].total_cmp(&a[i][i]));
    let evals = order.map(|i| a[i][i]);
    let evecs = order.map(|i| {
        let mut e = [v[0][i], v[1][i], v[2][i]];
        let largest = e
            .iter()
            .copied()
            .max_by(|x, y| x.abs().total_cmp(&y.abs()))
            .unwrap();
        if largest < 0.0 {
            e = e.map(|c| -c);
        }
        e
    });
    (evals, evecs)
}

/// The maps of a whole volume, one value per voxel. Voxels outside the mask, or with no fit, are 0.
pub struct TensorMaps {
    pub fa: Vec<f32>,
    pub md: Vec<f32>,
    pub ad: Vec<f32>,
    pub rd: Vec<f32>,
    pub s0: Vec<f32>,
    /// Three values per voxel: x, y, z of the principal eigenvector.
    pub v1: Vec<f32>,
}

/// Fits every voxel in the mask. `data` holds the volumes one after the other (volume-major:
/// `data[volume * voxels + voxel]`), and `volumes` selects the volumes of `design`, in its order.
pub fn fit_volume(
    data: &[f32],
    voxels: usize,
    volumes: &[usize],
    design: &Design,
    mask: Option<&[u8]>,
    weighted: bool,
) -> TensorMaps {
    assert_eq!(volumes.len(), design.len());
    assert!(volumes.iter().all(|&v| (v + 1) * voxels <= data.len()));
    let mut maps = TensorMaps {
        fa: vec![0.0; voxels],
        md: vec![0.0; voxels],
        ad: vec![0.0; voxels],
        rd: vec![0.0; voxels],
        s0: vec![0.0; voxels],
        v1: vec![0.0; voxels * 3],
    };
    let mut signal = vec![0.0f64; volumes.len()];
    for voxel in 0..voxels {
        if mask.is_some_and(|m| m[voxel] == 0) {
            continue;
        }
        for (s, &v) in signal.iter_mut().zip(volumes) {
            *s = data[v * voxels + voxel] as f64;
        }
        let Some(fit) = design.fit(&signal, weighted) else {
            continue;
        };
        maps.fa[voxel] = fit.fa() as f32;
        maps.md[voxel] = fit.md() as f32;
        maps.ad[voxel] = fit.ad() as f32;
        maps.rd[voxel] = fit.rd() as f32;
        maps.s0[voxel] = fit.s0 as f32;
        for c in 0..3 {
            maps.v1[voxel * 3 + c] = fit.evecs[0][c] as f32;
        }
    }
    maps
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 30 directions on a spiral over the sphere, with two b0 volumes.
    fn scheme() -> Gradients {
        let mut bvals = vec![0.0, 0.0];
        let mut bvecs = vec![[0.0; 3], [0.0; 3]];
        let n = 30;
        for i in 0..n {
            let z = 1.0 - 2.0 * (i as f64 + 0.5) / n as f64;
            let r = (1.0 - z * z).sqrt();
            let phi = i as f64 * 2.399_963_229_728_653;
            bvals.push(1000.0);
            bvecs.push([r * phi.cos(), r * phi.sin(), z]);
        }
        Gradients::new(bvals, bvecs).unwrap()
    }

    fn rotation(angle: f64) -> [[f64; 3]; 3] {
        let (s, c) = angle.sin_cos();
        [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
    }

    fn synthesize(g: &Gradients, s0: f64, evals: [f64; 3], r: [[f64; 3]; 3]) -> Vec<f64> {
        let mut d = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                for k in 0..3 {
                    d[i][j] += r[i][k] * evals[k] * r[j][k];
                }
            }
        }
        g.bvals
            .iter()
            .zip(&g.bvecs)
            .map(|(&b, gv)| {
                let mut q = 0.0;
                for i in 0..3 {
                    for j in 0..3 {
                        q += gv[i] * d[i][j] * gv[j];
                    }
                }
                s0 * (-b * q).exp()
            })
            .collect()
    }

    #[test]
    fn recovers_a_noise_free_tensor() {
        let g = scheme();
        let design = Design::new(&g);
        let evals = [1.7e-3, 0.4e-3, 0.3e-3];
        let r = rotation(0.6);
        let signal = synthesize(&g, 1200.0, evals, r);
        for weighted in [false, true] {
            let fit = design.fit(&signal, weighted).unwrap();
            assert!((fit.s0 - 1200.0).abs() < 1e-6);
            for (a, b) in fit.evals.iter().zip(evals) {
                assert!((a - b).abs() < 1e-12, "{a} {b}");
            }
            let v1 = fit.evecs[0];
            let expected = [r[0][0], r[1][0], r[2][0]];
            let dot: f64 = v1.iter().zip(expected).map(|(a, b)| a * b).sum();
            assert!((dot.abs() - 1.0).abs() < 1e-9);
            let md = (1.7e-3 + 0.4e-3 + 0.3e-3) / 3.0;
            assert!((fit.md() - md).abs() < 1e-12);
            assert!((fit.ad() - 1.7e-3).abs() < 1e-12);
            assert!((fit.rd() - 0.35e-3).abs() < 1e-12);
        }
    }

    #[test]
    fn isotropic_tensor_has_zero_fa() {
        let g = scheme();
        let signal = synthesize(&g, 900.0, [1e-3; 3], rotation(0.0));
        let fit = Design::new(&g).fit(&signal, true).unwrap();
        assert!(fit.fa() < 1e-9);
    }

    #[test]
    fn fa_of_a_known_tensor() {
        let fit = TensorFit {
            s0: 1.0,
            evals: [1.0, 0.0, 0.0],
            evecs: [[1.0, 0.0, 0.0]; 3],
        };
        assert!((fit.fa() - 1.0).abs() < 1e-15);
    }

    #[test]
    fn fa_boundary_is_a_strictly_negative_eigenvalue() {
        let fa = |evals| {
            TensorFit {
                s0: 1.0,
                evals,
                evecs: [[1.0, 0.0, 0.0]; 3],
            }
            .fa()
        };
        // Zero eigenvalues are valid; signed zero is not negative.
        assert_eq!(fa([1e-3, 0.0, 0.0]), 1.0);
        assert_eq!(fa([1e-3, 0.0, -0.0]), 1.0);
        assert_eq!(fa([0.0; 3]), 0.0);
        // The nonzero f64 values adjacent to zero fall either side of the rule.
        let adjacent = f64::from_bits(1);
        assert!((fa([1e-3, 1e-3, adjacent]) - 1.0 / 2f64.sqrt()).abs() < 1e-12);
        assert_eq!(fa([1e-3, 1e-3, -adjacent]), 0.0);
        // An indefinite tensor whose unconstrained FA is below one, and one above it.
        assert_eq!(fa([1.7e-3, 0.4e-3, -0.3e-3]), 0.0);
        assert_eq!(fa([1e-3, -0.5e-3, -0.5e-3]), 0.0);
    }

    #[test]
    fn negative_eigenvalues_zero_only_fa_for_ols_and_wls() {
        let gradients = scheme();
        let design = Design::new(&gradients);
        // Includes an indefinite tensor whose unconstrained FA is below one.
        for eigenvalues in [[1.7e-3, 0.4e-3, -0.3e-3], [1.0e-3, 1.0e-3, -0.01e-3]] {
            let signal = synthesize(&gradients, 900.0, eigenvalues, rotation(0.6));
            for weighted in [false, true] {
                let fit = design.fit(&signal, weighted).unwrap();
                assert_eq!(fit.fa(), 0.0);
                for (actual, expected) in fit.evals.iter().zip(eigenvalues) {
                    assert!((actual - expected).abs() < 1e-12);
                }
                assert!((fit.s0 - 900.0).abs() < 1e-6);
                assert!((fit.md() - eigenvalues.iter().sum::<f64>() / 3.0).abs() < 1e-12);
                assert!((fit.ad() - eigenvalues[0]).abs() < 1e-12);
                assert!((fit.rd() - (eigenvalues[1] + eigenvalues[2]) / 2.0).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn eigenvectors_have_a_fixed_sign() {
        let (_, v) = eigen_symmetric([[2.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 3.0]]);
        assert_eq!(v[0], [0.0, 0.0, 1.0]);
        assert_eq!(v[1], [1.0, 0.0, 0.0]);
    }

    #[test]
    fn zero_signal_has_no_fit() {
        let g = scheme();
        assert!(Design::new(&g).fit(&vec![0.0; g.len()], true).is_none());
    }

    #[test]
    fn volume_fit_respects_mask_and_selection() {
        let g = scheme();
        let voxels = 2;
        let signal = synthesize(&g, 1000.0, [1.5e-3, 0.5e-3, 0.5e-3], rotation(0.2));
        // One extra volume at the end that the selection leaves out.
        let mut data = vec![0.0f32; (g.len() + 1) * voxels];
        for (v, s) in signal.iter().enumerate() {
            data[v * voxels] = *s as f32;
            data[v * voxels + 1] = *s as f32;
        }
        let volumes: Vec<usize> = (0..g.len()).collect();
        let maps = fit_volume(
            &data,
            voxels,
            &volumes,
            &Design::new(&g),
            Some(&[1, 0]),
            true,
        );
        assert!((maps.md[0] - 0.833_333e-3).abs() < 1e-8);
        assert_eq!(maps.md[1], 0.0);
        assert_eq!(maps.v1[3..6], [0.0; 3]);
    }
}
