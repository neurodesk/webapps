//! The result of an analysis: `Srf.Values` (one name per row) and `Srf.Data`
//! (rows x vertices), with `Srf.Raw_Values` / `Srf.Raw_Data` where SamSrf keeps
//! them (the fine-fit parameters before `Scaled_Param` rescaling and polar
//! unwrapping in `samsrf_fit_prf`; the unsmoothed estimates in `samsrf_revcor_cf`).
//!
//! Rows are row-major over all vertices of the hemisphere: `data[row * vertices + v]`,
//! zero outside the analysed region, as `samsrf_expand_srf` expands `Srf.Roi`.

/// MATLAB's NaN. R2023b on x86-64 writes every NaN it makes, from the `NaN` constant or an
/// invalid operation, as this negative quiet NaN (`0xFFC00000` in single), and every NaN of
/// the pinned SamSrf recordings is this one. Rust's `f64::NAN` is the positive NaN, and
/// neither WebAssembly arithmetic nor float casts fix a NaN's sign, so `Job::merge` writes
/// this one and `gifti::write_map` its single counterpart.
pub const MATLAB_NAN: f64 = f64::from_bits(0xFFF8_0000_0000_0000);

/// Replaces every NaN with `MATLAB_NAN`.
pub fn matlab_nans(values: &mut [f64]) {
    for value in values.iter_mut().filter(|value| value.is_nan()) {
        *value = MATLAB_NAN;
    }
}

/// One block of named rows.
#[derive(Debug, Clone, PartialEq)]
pub struct Maps {
    pub values: Vec<String>,
    pub vertices: usize,
    pub data: Vec<f64>,
}

impl Maps {
    pub fn zeros(values: Vec<String>, vertices: usize) -> Self {
        let data = vec![0.0; values.len() * vertices];
        Self { values, vertices, data }
    }

    pub fn rows(&self) -> usize {
        self.values.len()
    }

    pub fn row(&self, index: usize) -> &[f64] {
        &self.data[index * self.vertices..(index + 1) * self.vertices]
    }

    pub fn row_mut(&mut self, index: usize) -> &mut [f64] {
        &mut self.data[index * self.vertices..(index + 1) * self.vertices]
    }

    /// The row named `name` (case-sensitive, as `strfind(Srf.Values, 'x0')` is).
    pub fn find(&self, name: &str) -> Option<usize> {
        self.values.iter().position(|value| value == name)
    }
}

/// `Srf` after an analysis: the maps, their raw counterpart when SamSrf keeps one,
/// and the vertices the analysis covered (`Srf.Roi`, 0-based, or every vertex).
/// `imaginary` holds the imaginary parts of `maps.data`, in its layout, when MATLAB's
/// `Srf.Data` would be complex (the SamSrf CSS convention with a negative response);
/// `samsrf_expand_srf` and every exported map keep only the real parts.
#[derive(Debug, Clone, PartialEq)]
pub struct MapSet {
    pub maps: Maps,
    pub raw: Option<Maps>,
    pub analysed: crate::timeseries::VertexSelection,
    pub imaginary: Option<Vec<f64>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_nan_becomes_matlabs_and_other_values_keep_their_bits() {
        let positive = f64::NAN;
        let payload = f64::from_bits(0x7FF8_0000_0000_0001);
        let mut values = [positive, -positive, payload, 1.5, -0.0, f64::INFINITY];
        matlab_nans(&mut values);
        let bits: Vec<u64> = values.iter().map(|value| value.to_bits()).collect();
        assert_eq!(bits, [0xFFF8_0000_0000_0000, 0xFFF8_0000_0000_0000, 0xFFF8_0000_0000_0000, 1.5f64.to_bits(), (-0.0f64).to_bits(), f64::INFINITY.to_bits()]);
    }
}
