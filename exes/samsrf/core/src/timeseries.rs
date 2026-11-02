//! Time-series blocks.
//!
//! Layout is vertex-major: the time course of vertex `v` is the contiguous slice
//! `data[v * volumes .. (v + 1) * volumes]`. This matches MATLAB's column-major
//! `Srf.Data` (volumes x vertices), keeps detrend, z-score and correlation on
//! contiguous memory, and lets a reader scatter one GIFTI DataArray (one volume,
//! every vertex) into place without a transpose pass.

/// A run as read from disk: float32 values, every vertex, vertex-major. SamSrf's
/// GIFTI import converts the single-precision arrays to double before normalising;
/// `preprocess::RunAccumulator` does the same conversion vertex by vertex.
#[derive(Debug, Clone, PartialEq)]
pub struct RawRun {
    pub volumes: usize,
    pub vertices: usize,
    pub data: Vec<f32>,
}

impl RawRun {
    pub fn course(&self, vertex: usize) -> &[f32] {
        &self.data[vertex * self.volumes..(vertex + 1) * self.volumes]
    }
}

/// A processed time-series block in f64, vertex-major. `vertices` is the number of
/// time courses stored here (the kept vertices of `preprocess::Preprocessed`).
#[derive(Debug, Clone, PartialEq)]
pub struct TimeSeries {
    pub volumes: usize,
    pub vertices: usize,
    pub data: Vec<f64>,
}

impl TimeSeries {
    pub fn zeros(volumes: usize, vertices: usize) -> Self {
        Self { volumes, vertices, data: vec![0.0; volumes * vertices] }
    }

    pub fn course(&self, vertex: usize) -> &[f64] {
        &self.data[vertex * self.volumes..(vertex + 1) * self.volumes]
    }

    pub fn course_mut(&mut self, vertex: usize) -> &mut [f64] {
        &mut self.data[vertex * self.volumes..(vertex + 1) * self.volumes]
    }
}

/// Which vertices a consumer keeps: every vertex, or a sorted list of unique
/// 0-based indices (an ROI label, or the union of ROI and seed region).
#[derive(Debug, Clone, PartialEq)]
pub enum VertexSelection {
    All,
    Indices(Vec<u32>),
}

impl VertexSelection {
    /// Sorted unique indices from any order (a label's file order).
    pub fn from_indices(mut indices: Vec<u32>) -> Self {
        indices.sort_unstable();
        indices.dedup();
        VertexSelection::Indices(indices)
    }

    pub fn len(&self, total: usize) -> usize {
        match self {
            VertexSelection::All => total,
            VertexSelection::Indices(indices) => indices.len(),
        }
    }

    pub fn is_empty(&self, total: usize) -> bool {
        self.len(total) == 0
    }

    /// The 0-based vertex index of kept position `position`.
    pub fn vertex(&self, position: usize) -> usize {
        match self {
            VertexSelection::All => position,
            VertexSelection::Indices(indices) => indices[position] as usize,
        }
    }
}
