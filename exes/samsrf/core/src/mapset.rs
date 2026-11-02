//! The result of an analysis: `Srf.Values` (one name per row) and `Srf.Data`
//! (rows x vertices), with `Srf.Raw_Values` / `Srf.Raw_Data` where SamSrf keeps
//! them (the fine-fit parameters before `Scaled_Param` rescaling and polar
//! unwrapping in `samsrf_fit_prf`; the unsmoothed estimates in `samsrf_revcor_cf`).
//!
//! Rows are row-major over all vertices of the hemisphere: `data[row * vertices + v]`,
//! zero outside the analysed region, as `samsrf_expand_srf` expands `Srf.Roi`.

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
#[derive(Debug, Clone, PartialEq)]
pub struct MapSet {
    pub maps: Maps,
    pub raw: Option<Maps>,
    pub analysed: crate::timeseries::VertexSelection,
}
