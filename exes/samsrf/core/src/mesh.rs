//! Mesh neighbourhoods: `samsrf_neighbours`, `samsrf_georoi` and `samsrf_geomatrix`,
//! which `samsrf_revcor_cf` uses to smooth connective field profiles across the seed
//! region. Distances are in steps between neighbouring vertices, counted exactly as
//! `samsrf_georoi` counts them.

use crate::surface::Faces;

/// Vertex adjacency built once from the faces.
#[derive(Debug, Clone, PartialEq)]
pub struct Adjacency {
    pub neighbours: Vec<Vec<u32>>,
}

impl Adjacency {
    pub fn new(vertex_count: usize, faces: &Faces) -> Adjacency {
        let mut neighbours = vec![Vec::new(); vertex_count];
        let mut link = |a: u32, b: u32| {
            if a != b && (a as usize) < vertex_count && (b as usize) < vertex_count {
                neighbours[a as usize].push(b);
                neighbours[b as usize].push(a);
            }
        };
        match faces {
            Faces::Triangles(faces) => {
                for face in faces {
                    for i in 0..3 {
                        for j in (i + 1)..3 {
                            link(face[i], face[j]);
                        }
                    }
                }
            }
            Faces::Quads(faces) => {
                for face in faces {
                    for i in 0..4 {
                        for j in (i + 1)..4 {
                            link(face[i], face[j]);
                        }
                    }
                }
            }
        }
        for list in &mut neighbours {
            list.sort_unstable();
            list.dedup();
        }
        Adjacency { neighbours }
    }

    /// `samsrf_neighbours(v, F)`: the vertices sharing a face with any vertex of `set`,
    /// excluding `set`'s own members, sorted and unique.
    pub fn neighbours_of(&self, set: &[u32]) -> Vec<u32> {
        let mut in_set = std::collections::HashSet::with_capacity(set.len());
        in_set.extend(set.iter().copied());
        let mut out: Vec<u32> = set.iter().flat_map(|&v| self.neighbours[v as usize].iter().copied()).filter(|u| !in_set.contains(u)).collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// `samsrf_georoi(v, s, V, F)`: the vertices within `steps` of `vertex` and their
    /// distances, in SamSrf's counting. Returns `(vertices, distances)` sorted by vertex.
    pub fn geo_roi(&self, vertex: u32, steps: usize) -> (Vec<u32>, Vec<f64>) {
        let mut counts: std::collections::HashMap<u32, f64> = std::collections::HashMap::new();
        let mut visited: Vec<u32> = Vec::new();
        let mut frontier = vec![vertex];
        for _ in 0..=steps {
            visited.extend(&frontier);
            let next = self.neighbours_of(&frontier);
            for &v in &frontier {
                *counts.entry(v).or_insert(0.0) += 1.0;
            }
            for &v in &next {
                *counts.entry(v).or_insert(0.0) += 1.0;
            }
            frontier = next;
        }
        visited.sort_unstable();
        visited.dedup();
        let distances = visited.iter().map(|v| steps as f64 - counts[v] + 1.0).collect();
        (visited, distances)
    }

    /// `samsrf_geomatrix(V, F, Vs, MaxDist)`: the `N x N` step distances between the
    /// vertices of `set`, row-major, `Inf` beyond `max_distance`.
    pub fn geo_matrix(&self, set: &[u32], max_distance: usize) -> Vec<f64> {
        let n = set.len();
        let mut matrix = vec![f64::INFINITY; n * n];
        let position: std::collections::HashMap<u32, usize> = set.iter().enumerate().map(|(i, &v)| (v, i)).collect();
        for (row, &v) in set.iter().enumerate() {
            let (vertices, distances) = self.geo_roi(v, max_distance);
            for (u, d) in vertices.iter().zip(distances) {
                if let Some(&column) = position.get(u) {
                    matrix[row * n + column] = d;
                }
            }
        }
        matrix
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A path graph 0-1-2-3-4 made of degenerate triangles.
    fn path() -> Adjacency {
        Adjacency::new(5, &Faces::Triangles(vec![[0, 1, 1], [1, 2, 2], [2, 3, 3], [3, 4, 4]]))
    }

    #[test]
    fn neighbours_exclude_the_query_set() {
        let adjacency = path();
        assert_eq!(adjacency.neighbours_of(&[2]), vec![1, 3]);
        assert_eq!(adjacency.neighbours_of(&[1, 2]), vec![0, 3]);
    }

    #[test]
    fn georoi_counts_as_samsrf_does() {
        // samsrf_georoi on a path from vertex 0 with s = 2: Nb goes {0}, {1}, {0,2}, so the
        // counts are 0 -> 3, 1 -> 3, 2 -> 2, 3 -> 1 and `s - Ds + 1` gives 0, 0, 1: SamSrf's
        // counting puts the immediate neighbours at distance 0.
        let (vertices, distances) = path().geo_roi(0, 2);
        assert_eq!(vertices, vec![0, 1, 2]);
        assert_eq!(distances, vec![0.0, 0.0, 1.0]);
    }

    #[test]
    fn geomatrix_is_inf_beyond_the_limit() {
        let matrix = path().geo_matrix(&[0, 4], 1);
        assert_eq!(matrix[0], 0.0);
        assert_eq!(matrix[1], f64::INFINITY);
        assert_eq!(matrix[3], 0.0);
    }
}
