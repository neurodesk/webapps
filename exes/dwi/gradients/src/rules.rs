//! The b0 rules of NiFreeze and QSIPrep beside the dtifit rule of `Gradients`. Head-motion
//! correction splits b0 and diffusion-weighted volumes as the method it ports does; NODDI, the
//! tensor fit and the denoisers keep `Gradients` and its `b < 50` rule.
//!
//! This is a module of its own, and `lib.rs` only declares it on its last line, because
//! `noddi.wasm` embeds the line numbers of `lib.rs`: editing that file changes the committed
//! module even when its behaviour is the same.

use crate::B0_THRESHOLD;

/// NiFreeze 3bcfb00 counts a volume with b at or below this value (s/mm²) as a b0
/// (`DEFAULT_LOWB_THRESHOLD`, compared with `<=` in `data/dmri/base.py`).
pub const NIFREEZE_B0_MAX: f64 = 50.0;

/// NiFreeze reads a direction within this distance of length 0 as a b0, and one within it of
/// length 1 as unit (`DEFAULT_GRADIENT_ATOL`, through `np.isclose` in `format_gradients`).
pub const NIFREEZE_NORM_ATOL: f64 = 1e-2;

/// The relative tolerance `np.isclose` adds when it compares a length with 1.
const NUMPY_RTOL: f64 = 1e-5;

/// QSIPrep 26.1.1 counts a volume with b below this value (s/mm²) as a b0 (`--b0-threshold`).
pub const QSIPREP_B0_THRESHOLD: f64 = 100.0;

/// Which volumes are b0, and what a direction that is not unit length means.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum B0Rule {
    /// b < `B0_THRESHOLD`, as `Gradients` reads a table: a diffusion-weighted direction shorter
    /// than 0.5 is an error, the others become unit vectors.
    #[default]
    Dtifit,
    /// NiFreeze 3bcfb00 (`format_gradients`): a direction within `NIFREEZE_NORM_ATOL` of length 0
    /// makes the volume a b0 with b = 0; one within it of length 1 is kept as it is; any other
    /// becomes unit length and its b-value is multiplied by its length. Then b ≤ `NIFREEZE_B0_MAX`
    /// is a b0.
    NiFreeze,
    /// QSIPrep 26.1.1: b < `QSIPREP_B0_THRESHOLD` is a b0. Directions are read as for `Dtifit`.
    QsiPrep,
}

impl B0Rule {
    /// Whether a volume with this b-value, as `read` returns it, is a b0.
    pub fn is_b0(self, b: f64) -> bool {
        match self {
            B0Rule::Dtifit => b < B0_THRESHOLD,
            B0Rule::NiFreeze => b <= NIFREEZE_B0_MAX,
            B0Rule::QsiPrep => b < QSIPREP_B0_THRESHOLD,
        }
    }

    /// Checks the table as `Gradients::new` does and reads each volume with this rule.
    /// A b0 direction becomes the zero vector.
    pub fn read(self, mut bvals: Vec<f64>, bvecs: Vec<[f64; 3]>) -> Result<RuledGradients, String> {
        if bvals.is_empty() {
            return Err("The bval file is empty.".into());
        }
        if bvals.len() != bvecs.len() {
            return Err(format!(
                "The bval file has {} values but the bvec file has {} directions.",
                bvals.len(),
                bvecs.len()
            ));
        }
        if bvals.iter().any(|b| !b.is_finite() || *b < 0.0) {
            return Err("The bval file has a negative or non-numeric value.".into());
        }
        let mut directions = Vec::with_capacity(bvecs.len());
        for (i, (b, g)) in bvals.iter_mut().zip(&bvecs).enumerate() {
            if g.iter().any(|c| !c.is_finite()) {
                return Err(format!("The bvec direction of volume {i} is not a number."));
            }
            let norm = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
            let unit = [g[0] / norm, g[1] / norm, g[2] / norm];
            let direction = if self == B0Rule::NiFreeze {
                if norm <= NIFREEZE_NORM_ATOL {
                    *b = 0.0;
                    [0.0; 3]
                } else if (norm - 1.0).abs() <= NIFREEZE_NORM_ATOL + NUMPY_RTOL {
                    *g
                } else {
                    *b *= norm;
                    unit
                }
            } else if self.is_b0(*b) {
                [0.0; 3]
            } else if norm < 0.5 {
                return Err(format!(
                    "Volume {i} has b = {b} but its bvec direction has length {norm:.3}."
                ));
            } else {
                unit
            };
            directions.push(if self.is_b0(*b) { [0.0; 3] } else { direction });
        }
        Ok(RuledGradients {
            rule: self,
            bvals,
            bvecs: directions,
        })
    }
}

/// A gradient table read with a `B0Rule`: one b-value and one direction per volume.
#[derive(Clone, Debug)]
pub struct RuledGradients {
    pub rule: B0Rule,
    /// The b-values. NiFreeze rescales those whose direction is not unit length.
    pub bvals: Vec<f64>,
    /// Unit directions (NiFreeze keeps those within `NIFREEZE_NORM_ATOL` of unit length as they
    /// are). A b0 volume has the zero vector.
    pub bvecs: Vec<[f64; 3]>,
}

impl RuledGradients {
    pub fn len(&self) -> usize {
        self.bvals.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bvals.is_empty()
    }

    pub fn is_b0(&self, volume: usize) -> bool {
        self.rule.is_b0(self.bvals[volume])
    }

    /// The indices of the b0 volumes.
    pub fn b0_volumes(&self) -> Vec<usize> {
        (0..self.len()).filter(|&i| self.is_b0(i)).collect()
    }

    /// The indices of the diffusion-weighted volumes.
    pub fn dwi_volumes(&self) -> Vec<usize> {
        (0..self.len()).filter(|&i| !self.is_b0(i)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Gradients;

    const X: [f64; 3] = [1.0, 0.0, 0.0];

    fn b0s(rule: B0Rule, bvals: &[f64]) -> Vec<usize> {
        rule.read(bvals.to_vec(), vec![X; bvals.len()])
            .unwrap()
            .b0_volumes()
    }

    #[test]
    fn boundary_values() {
        let bvals = [0.0, 49.9, 50.0, 99.0, 100.0, 1000.0];
        assert_eq!(b0s(B0Rule::Dtifit, &bvals), vec![0, 1]);
        assert_eq!(b0s(B0Rule::NiFreeze, &bvals), vec![0, 1, 2]);
        assert_eq!(b0s(B0Rule::QsiPrep, &bvals), vec![0, 1, 2, 3]);
    }

    #[test]
    fn dtifit_rule_matches_gradients() {
        let bvals = vec![0.0, 49.9, 50.0, 1000.0, 2000.0];
        let bvecs = vec![
            [0.0; 3],
            [0.0; 3],
            [2.0, 0.0, 0.0],
            [0.0, 0.6, 0.8],
            [0.3, 0.4, 0.0],
        ];
        let ruled = B0Rule::Dtifit.read(bvals.clone(), bvecs.clone()).unwrap();
        let gradients = Gradients::new(bvals, bvecs).unwrap();
        assert_eq!(ruled.bvals, gradients.bvals);
        assert_eq!(ruled.bvecs, gradients.bvecs);
        assert_eq!(ruled.b0_volumes(), gradients.b0_volumes());
    }

    #[test]
    fn nifreeze_rescales_short_vectors() {
        let bvals = vec![1000.0, 1000.0, 1000.0, 1000.0, 80.0];
        let bvecs = vec![
            [0.5, 0.0, 0.0],     // b becomes 500, direction unit
            [0.0, 0.005, 0.0],   // length ≤ 0.01: a b0 with b = 0
            [0.0, 0.0, 1.005],   // within 0.01 of unit: kept as it is
            [0.0, 0.0, 0.03125], // b becomes 31.25 ≤ 50: a b0
            [0.5, 0.0, 0.0],     // b becomes 40: a b0
        ];
        let g = B0Rule::NiFreeze.read(bvals, bvecs).unwrap();
        assert_eq!(g.bvals, vec![500.0, 0.0, 1000.0, 31.25, 40.0]);
        assert_eq!(g.bvecs[0], X);
        assert_eq!(g.bvecs[2], [0.0, 0.0, 1.005]);
        assert_eq!(g.b0_volumes(), vec![1, 3, 4]);
        assert_eq!(g.dwi_volumes(), vec![0, 2]);
        for b0 in [1, 3, 4] {
            assert_eq!(g.bvecs[b0], [0.0; 3]);
        }
    }

    #[test]
    fn short_vectors_outside_nifreeze() {
        for rule in [B0Rule::Dtifit, B0Rule::QsiPrep] {
            let err = rule.read(vec![1000.0], vec![[0.2, 0.0, 0.0]]).unwrap_err();
            assert!(err.contains("length 0.200"), "{rule:?}: {err}");
            // A b0 may have any direction, short or not.
            let g = rule.read(vec![0.0, 1000.0], vec![[0.2, 0.0, 0.0], [0.0, 2.0, 0.0]]);
            assert_eq!(
                g.unwrap().bvecs,
                vec![[0.0; 3], [0.0, 1.0, 0.0]],
                "{rule:?}"
            );
        }
        // QSIPrep's b0 band reaches 99 s/mm²: a short direction there is a b0, not an error.
        let g = B0Rule::QsiPrep
            .read(vec![99.0], vec![[0.2, 0.0, 0.0]])
            .unwrap();
        assert_eq!(g.b0_volumes(), vec![0]);
    }

    #[test]
    fn rejects_bad_tables() {
        for rule in [B0Rule::Dtifit, B0Rule::NiFreeze, B0Rule::QsiPrep] {
            assert!(rule.read(vec![], vec![]).is_err());
            assert!(rule.read(vec![0.0], vec![]).is_err());
            assert!(rule.read(vec![-1.0], vec![[0.0; 3]]).is_err());
            assert!(rule.read(vec![1000.0], vec![[f64::NAN, 0.0, 1.0]]).is_err());
        }
    }
}
