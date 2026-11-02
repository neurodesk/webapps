//! Cortical surface meshes and per-vertex scalars, as `samsrf_gii2srf` collects them
//! from a FreeSurfer `surf` folder or one GIFTI mesh. Vertex indices are 0-based
//! everywhere in this crate (SamSrf adds 1 when it loads a label).

/// Mesh faces. FreeSurfer quad files are rare but `fs_read_surf` reads them.
#[derive(Debug, Clone, PartialEq)]
pub enum Faces {
    Triangles(Vec<[u32; 3]>),
    Quads(Vec<[u32; 4]>),
}

impl Faces {
    pub fn len(&self) -> usize {
        match self {
            Faces::Triangles(faces) => faces.len(),
            Faces::Quads(faces) => faces.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// One mesh: `Srf.Vertices` and `Srf.Faces`.
#[derive(Debug, Clone, PartialEq)]
pub struct Surface {
    pub vertices: Vec<[f64; 3]>,
    pub faces: Faces,
}

/// A FreeSurfer `surf` folder for one hemisphere, as `samsrf_gii2srf` loads it.
/// `thickness` is optional because the example dataset ships without it.
#[derive(Debug, Clone, PartialEq)]
pub struct Anatomy {
    /// `lh.white`: the mesh the analyses use (`Srf.Vertices`, `Srf.Faces`).
    pub white: Surface,
    pub pial: Vec<[f64; 3]>,
    pub inflated: Vec<[f64; 3]>,
    pub sphere: Vec<[f64; 3]>,
    pub curvature: Vec<f64>,
    pub area: Vec<f64>,
    pub thickness: Option<Vec<f64>>,
}

impl Anatomy {
    /// `Srf.Normals = Pial - Vertices`.
    pub fn normals(&self) -> Vec<[f64; 3]> {
        self.pial
            .iter()
            .zip(&self.white.vertices)
            .map(|(p, w)| [p[0] - w[0], p[1] - w[1], p[2] - w[2]])
            .collect()
    }
}

/// A FreeSurfer label: 0-based vertex indices in file order, with the per-vertex
/// coordinates and value columns the file carries.
#[derive(Debug, Clone, PartialEq)]
pub struct Label {
    pub vertices: Vec<u32>,
    pub coordinates: Vec<[f64; 3]>,
    pub values: Vec<f64>,
}
