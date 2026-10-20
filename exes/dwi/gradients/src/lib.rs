//! Diffusion gradient table rules shared by every diffusion stage: which volumes are b0, which
//! b-values form one shell, whether the data supports NODDI, and which volumes the tensor fit uses.
//! Text parsing stays in JavaScript (`packages/dwi2trx/src/gradients.js`); this crate takes numbers.

/// A volume with b below this value (s/mm²) is a b0, as FSL dtifit and dwi2trx count them.
pub const B0_THRESHOLD: f64 = 50.0;

/// Non-zero b-values are rounded to this step (s/mm²) to find shells, so 995, 1000 and 1005 are
/// one shell.
pub const SHELL_STEP: f64 = 100.0;

/// The tensor fit uses every shell up to this b-value (s/mm²), where the signal is close to
/// Gaussian; data with no shell this low uses its lowest shell instead.
pub const DTI_MAX_B: f64 = 1200.0;

/// A gradient table: one b-value and one direction per volume.
#[derive(Clone, Debug)]
pub struct Gradients {
    pub bvals: Vec<f64>,
    /// Unit directions. A b0 volume has the zero vector.
    pub bvecs: Vec<[f64; 3]>,
}

impl Gradients {
    /// Checks the table and makes each diffusion-weighted direction a unit vector.
    /// A b0 direction becomes the zero vector, whatever the file had.
    pub fn new(bvals: Vec<f64>, bvecs: Vec<[f64; 3]>) -> Result<Self, String> {
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
        let mut unit = Vec::with_capacity(bvecs.len());
        for (i, (&b, g)) in bvals.iter().zip(&bvecs).enumerate() {
            if g.iter().any(|c| !c.is_finite()) {
                return Err(format!("The bvec direction of volume {i} is not a number."));
            }
            if b < B0_THRESHOLD {
                unit.push([0.0; 3]);
                continue;
            }
            let norm = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
            if norm < 0.5 {
                return Err(format!(
                    "Volume {i} has b = {b} but its bvec direction has length {norm:.3}."
                ));
            }
            unit.push([g[0] / norm, g[1] / norm, g[2] / norm]);
        }
        Ok(Self { bvals, bvecs: unit })
    }

    pub fn len(&self) -> usize {
        self.bvals.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bvals.is_empty()
    }

    pub fn is_b0(&self, volume: usize) -> bool {
        self.bvals[volume] < B0_THRESHOLD
    }

    /// The indices of the b0 volumes.
    pub fn b0_volumes(&self) -> Vec<usize> {
        (0..self.len()).filter(|&i| self.is_b0(i)).collect()
    }

    /// The shell of each volume: 0 for a b0, else the b-value rounded to `SHELL_STEP`.
    pub fn shell_of(&self, volume: usize) -> f64 {
        if self.is_b0(volume) {
            0.0
        } else {
            (self.bvals[volume] / SHELL_STEP).round() * SHELL_STEP
        }
    }

    /// The distinct non-zero shells, lowest first.
    pub fn shells(&self) -> Vec<f64> {
        let mut shells: Vec<f64> = (0..self.len())
            .map(|i| self.shell_of(i))
            .filter(|&s| s > 0.0)
            .collect();
        shells.sort_by(f64::total_cmp);
        shells.dedup();
        shells
    }

    /// The number of volumes in each shell from `shells`, in the same order.
    pub fn shell_counts(&self) -> Vec<usize> {
        self.shells()
            .iter()
            .map(|&s| (0..self.len()).filter(|&i| self.shell_of(i) == s).count())
            .collect()
    }

    /// NODDI needs at least one b0 and two or more non-zero shells.
    pub fn check_noddi(&self) -> Result<(), String> {
        if self.b0_volumes().is_empty() {
            return Err(format!(
                "NODDI needs a b0 volume (b < {B0_THRESHOLD} s/mm²). This data has none."
            ));
        }
        let shells = self.shells();
        if shells.len() < 2 {
            let found = shells
                .iter()
                .map(|s| format!("{s}"))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "NODDI needs two or more non-zero b-value shells. This data has one ({found} s/mm²)."
            ));
        }
        Ok(())
    }

    /// The volumes for the tensor fit: every b0 and every shell up to `DTI_MAX_B`, or the lowest
    /// shell when none is that low. A 500/1000/2000 acquisition fits its b = 500 and 1000 shells;
    /// a 1500/3000 one fits b = 1500.
    pub fn dti_volumes(&self) -> Result<Vec<usize>, String> {
        let b0 = self.b0_volumes();
        if b0.is_empty() {
            return Err(format!(
                "The tensor fit needs a b0 volume (b < {B0_THRESHOLD} s/mm²). This data has none."
            ));
        }
        let shells = self.shells();
        let lowest = *shells
            .first()
            .ok_or("The tensor fit needs diffusion-weighted volumes. This data has only b0.")?;
        let max_b = if lowest <= DTI_MAX_B {
            DTI_MAX_B
        } else {
            lowest
        };
        let volumes: Vec<usize> = (0..self.len())
            .filter(|&i| self.is_b0(i) || self.shell_of(i) <= max_b)
            .collect();
        if volumes.len() - b0.len() < 6 {
            let used: Vec<String> = shells
                .iter()
                .filter(|&&s| s <= max_b)
                .map(|s| s.to_string())
                .collect();
            return Err(format!(
                "The tensor fit needs six or more directions with b ≤ {max_b} s/mm² (shells {}). This data has {}.",
                used.join(", "),
                volumes.len() - b0.len()
            ));
        }
        Ok(volumes)
    }

    /// The table of the given volumes only, in that order.
    pub fn subset(&self, volumes: &[usize]) -> Self {
        Self {
            bvals: volumes.iter().map(|&i| self.bvals[i]).collect(),
            bvecs: volumes.iter().map(|&i| self.bvecs[i]).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(bvals: &[f64]) -> Gradients {
        let bvecs = bvals
            .iter()
            .enumerate()
            .map(|(i, _)| {
                let t = i as f64;
                [t.cos(), t.sin(), 0.3]
            })
            .collect();
        Gradients::new(bvals.to_vec(), bvecs).unwrap()
    }

    #[test]
    fn b0_threshold_matches_dtifit() {
        let g = table(&[0.0, 5.0, 49.9, 50.0, 1000.0]);
        assert_eq!(g.b0_volumes(), vec![0, 1, 2]);
        assert_eq!(g.bvecs[1], [0.0; 3]);
    }

    #[test]
    fn nearby_bvalues_are_one_shell() {
        let g = table(&[0.0, 995.0, 1000.0, 1005.0, 1990.0, 2010.0]);
        assert_eq!(g.shells(), vec![1000.0, 2000.0]);
        assert_eq!(g.shell_counts(), vec![3, 2]);
    }

    #[test]
    fn noddi_needs_two_shells_after_rounding() {
        let single = table(&[0.0, 995.0, 1000.0, 1005.0]);
        let err = single.check_noddi().unwrap_err();
        assert!(err.contains("two or more"), "{err}");
        assert!(table(&[0.0, 1000.0, 2000.0]).check_noddi().is_ok());
        assert!(table(&[1000.0, 2000.0]).check_noddi().is_err());
    }

    #[test]
    fn dti_uses_b0_and_every_shell_up_to_1200() {
        let mut bvals = vec![0.0];
        bvals.extend([500.0; 3]);
        bvals.extend([1000.0; 3]);
        bvals.extend([2000.0; 3]);
        bvals.extend([1205.0; 1]);
        bvals.push(0.0);
        let g = table(&bvals);
        // 1205 rounds to the 1200 shell, which is included; 2000 is not.
        assert_eq!(g.dti_volumes().unwrap(), vec![0, 1, 2, 3, 4, 5, 6, 10, 11]);
    }

    #[test]
    fn dti_uses_the_lowest_shell_when_none_is_1200_or_less() {
        let mut bvals = vec![0.0];
        bvals.extend([1500.0; 6]);
        bvals.extend([3000.0; 6]);
        let g = table(&bvals);
        assert_eq!(g.dti_volumes().unwrap(), vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn dti_needs_six_directions() {
        let g = table(&[0.0, 1000.0, 1000.0, 1000.0, 1000.0, 1000.0, 2000.0]);
        let err = g.dti_volumes().unwrap_err();
        assert!(
            err.contains("six or more") && err.contains("b ≤ 1200"),
            "{err}"
        );
    }

    #[test]
    fn directions_become_unit_vectors() {
        let g = Gradients::new(vec![0.0, 1000.0], vec![[0.2, 0.0, 0.0], [0.0, 2.0, 0.0]]).unwrap();
        assert_eq!(g.bvecs, vec![[0.0; 3], [0.0, 1.0, 0.0]]);
    }

    #[test]
    fn rejects_bad_tables() {
        assert!(Gradients::new(vec![], vec![]).is_err());
        assert!(Gradients::new(vec![0.0], vec![]).is_err());
        assert!(Gradients::new(vec![-1.0], vec![[0.0; 3]]).is_err());
        assert!(Gradients::new(vec![1000.0], vec![[0.0; 3]]).is_err());
        assert!(Gradients::new(vec![1000.0], vec![[f64::NAN, 0.0, 1.0]]).is_err());
    }
}

mod rules;
pub use rules::*;
