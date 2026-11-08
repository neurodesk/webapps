//! Planar geometry the reverse-correlation analyses use in place of MATLAB's
//! `delaunayTriangulation`, `convexHull`, `polyshape` and `samsrf_clusterroi`:
//! unique rows, the convex hull with its area and centroid, and a flood fill over
//! a Delaunay triangulation.
//!
//! A hull needs three non-collinear points. With fewer, MATLAB's `polyshape` is empty
//! (area 0, centroid NaN) and `convexHull` errors; `Hull::of` returns `None` and each
//! caller applies SamSrf's own fallback.

/// MATLAB `[C, ia] = unique(A, 'rows')`: rows sorted lexicographically, `ia` the first
/// occurrence of each. NaN rows sort last and are all distinct, as in MATLAB.
pub fn unique_rows(points: &[[f64; 2]]) -> (Vec<[f64; 2]>, Vec<usize>) {
    let mut order: Vec<usize> = (0..points.len()).collect();
    order.sort_by(|&a, &b| row_order(&points[a], &points[b]).then(a.cmp(&b)));
    let mut rows = Vec::new();
    let mut first = Vec::new();
    for index in order {
        let point = points[index];
        let duplicate = rows.last().is_some_and(|last: &[f64; 2]| last[0] == point[0] && last[1] == point[1]);
        if !duplicate {
            rows.push(point);
            first.push(index);
        }
    }
    (rows, first)
}

fn row_order(a: &[f64; 2], b: &[f64; 2]) -> std::cmp::Ordering {
    nan_last(a[0], b[0]).then(nan_last(a[1], b[1]))
}

fn nan_last(a: f64, b: f64) -> std::cmp::Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => a.partial_cmp(&b).unwrap(),
    }
}

/// A convex polygon: its vertices counter-clockwise, without a repeated closing vertex.
#[derive(Debug, Clone, PartialEq)]
pub struct Hull {
    pub vertices: Vec<[f64; 2]>,
}

impl Hull {
    /// Hull of a polygon after removing collinear boundary vertices, including
    /// retraced spikes. SamSrf's CF path constructs a `polyshape` before taking
    /// its hull; a zero-area spike is therefore not part of that hull.
    pub fn of_polygon(points: &[[f64; 2]]) -> Option<Hull> {
        let mut boundary = points.to_vec();
        // Inferred from recorded R2023b thin triangles at three scales. Points
        // exactly at the relative cutoff remain sensitive to rounding.
        let span = (0..2).map(|axis| {
            let low = points.iter().map(|p| p[axis]).fold(f64::INFINITY, f64::min);
            let high = points.iter().map(|p| p[axis]).fold(f64::NEG_INFINITY, f64::max);
            high - low
        }).fold(0.0, f64::max);
        let tolerance = span * 1e-8;
        loop {
            let n = boundary.len();
            if n < 3 {
                return None;
            }
            let redundant = (0..n).find(|&i| {
                let a = boundary[(i + n - 1) % n];
                let b = boundary[i];
                let c = boundary[(i + 1) % n];
                let cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
                cross == 0.0 || cross.abs() < tolerance * (c[0] - a[0]).hypot(c[1] - a[1])
            });
            match redundant {
                Some(i) => { boundary.remove(i); }
                None => return Self::of(&boundary),
            }
        }
    }

    /// The convex hull of `points` (Andrew's monotone chain), or `None` when the points
    /// span no area (fewer than three distinct points, or all collinear).
    pub fn of(points: &[[f64; 2]]) -> Option<Hull> {
        let mut sorted: Vec<[f64; 2]> = points.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
        sorted.sort_by(row_order);
        sorted.dedup();
        if sorted.len() < 3 {
            return None;
        }
        let cross = |o: &[f64; 2], a: &[f64; 2], b: &[f64; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        let mut lower: Vec<[f64; 2]> = Vec::new();
        for p in &sorted {
            while lower.len() >= 2 && cross(&lower[lower.len() - 2], &lower[lower.len() - 1], p) <= 0.0 {
                lower.pop();
            }
            lower.push(*p);
        }
        let mut upper: Vec<[f64; 2]> = Vec::new();
        for p in sorted.iter().rev() {
            while upper.len() >= 2 && cross(&upper[upper.len() - 2], &upper[upper.len() - 1], p) <= 0.0 {
                upper.pop();
            }
            upper.push(*p);
        }
        lower.pop();
        upper.pop();
        lower.extend(upper);
        if lower.len() < 3 {
            return None;
        }
        let hull = Hull { vertices: lower };
        if hull.area() <= 0.0 {
            return None;
        }
        Some(hull)
    }

    /// Shoelace area, translated to avoid cancellation far from the origin.
    pub fn area(&self) -> f64 {
        let n = self.vertices.len();
        let origin = self.vertices[0];
        let mut twice = 0.0;
        for i in 0..n {
            let a = [self.vertices[i][0] - origin[0], self.vertices[i][1] - origin[1]];
            let next = self.vertices[(i + 1) % n];
            let b = [next[0] - origin[0], next[1] - origin[1]];
            twice += a[0] * b[1] - b[0] * a[1];
        }
        twice.abs() / 2.0
    }

    /// The polygon centroid, as `polyshape.centroid`.
    pub fn centroid(&self) -> [f64; 2] {
        let n = self.vertices.len();
        let origin = self.vertices[0];
        let mut twice = 0.0;
        let mut cx = 0.0;
        let mut cy = 0.0;
        for i in 0..n {
            let a = [self.vertices[i][0] - origin[0], self.vertices[i][1] - origin[1]];
            let next = self.vertices[(i + 1) % n];
            let b = [next[0] - origin[0], next[1] - origin[1]];
            let cross = a[0] * b[1] - b[0] * a[1];
            twice += cross;
            cx += (a[0] + b[0]) * cross;
            cy += (a[1] + b[1]) * cross;
        }
        [origin[0] + cx / (3.0 * twice), origin[1] + cy / (3.0 * twice)]
    }
}

/// A Delaunay triangulation reduced to what `samsrf_clusterroi` needs: each point's
/// neighbours along triangle edges. Collinear or too few points give no edges, where
/// MATLAB's `delaunay` would error.
#[derive(Debug, Clone, PartialEq)]
pub struct Triangulation {
    pub neighbours: Vec<Vec<usize>>,
}

impl Triangulation {
    pub fn delaunay(points: &[[f64; 2]]) -> Triangulation {
        let mut neighbours = vec![Vec::new(); points.len()];
        let input: Vec<delaunator::Point> = points.iter().map(|p| delaunator::Point { x: p[0], y: p[1] }).collect();
        let triangulation = delaunator::triangulate(&input);
        for triangle in triangulation.triangles.as_chunks::<3>().0 {
            for i in 0..3 {
                let a = triangle[i];
                let b = triangle[(i + 1) % 3];
                if !neighbours[a].contains(&b) {
                    neighbours[a].push(b);
                }
                if !neighbours[b].contains(&a) {
                    neighbours[b].push(a);
                }
            }
        }
        for list in &mut neighbours {
            list.sort_unstable();
        }
        Triangulation { neighbours }
    }
}

/// `samsrf_clusterroi(v, Statistic, Threshold, Faces)` with a scalar threshold: the
/// vertices connected to `seed` through vertices whose statistic exceeds `threshold`,
/// seed first, then in breadth-first order. Empty when the seed itself is not above
/// the threshold.
pub fn cluster_roi(seed: usize, statistic: &[f64], threshold: f64, triangulation: &Triangulation) -> Vec<usize> {
    if statistic[seed].is_nan() || statistic[seed] <= threshold {
        return Vec::new();
    }
    let mut selected = vec![false; statistic.len()];
    selected[seed] = true;
    let mut cluster = vec![seed];
    let mut frontier = vec![seed];
    while !frontier.is_empty() {
        let mut next: Vec<usize> = frontier.iter().flat_map(|&v| triangulation.neighbours[v].iter().copied()).collect();
        next.sort_unstable();
        next.dedup();
        next.retain(|&u| u != seed && !selected[u] && statistic[u] > threshold);
        for &u in &next {
            selected[u] = true;
        }
        cluster.extend(&next);
        frontier = next;
    }
    cluster
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_rows_sorts_and_keeps_first_occurrences() {
        let (rows, first) = unique_rows(&[[3.0, 1.0], [1.0, 2.0], [3.0, 1.0], [1.0, 2.0]]);
        assert_eq!(rows, vec![[1.0, 2.0], [3.0, 1.0]]);
        assert_eq!(first, vec![1, 0]);
    }

    #[test]
    fn hull_of_a_square_with_interior_points() {
        let points = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.5, 0.5], [0.25, 0.75]];
        let hull = Hull::of(&points).unwrap();
        assert_eq!(hull.vertices.len(), 4);
        assert!((hull.area() - 1.0).abs() < 1e-15);
        let [cx, cy] = hull.centroid();
        assert!((cx - 0.5).abs() < 1e-15 && (cy - 0.5).abs() < 1e-15);
    }

    #[test]
    fn degenerate_sets_have_no_hull() {
        assert_eq!(Hull::of(&[[0.0, 0.0], [1.0, 1.0]]), None);
        assert_eq!(Hull::of(&[[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]), None);
        assert_eq!(Hull::of(&[[0.0, 0.0], [0.0, 0.0], [0.0, 0.0]]), None);
    }

    #[test]
    fn small_offset_polygon_retains_its_area_and_centroid() {
        // Recorded MATLAB polyshape case: uncentred shoelace arithmetic gave
        // zero area, although the triangle has three distinct vertices.
        let points = [[1000.0, 1000.0], [1000.001, 1000.0000000001], [1000.002, 1000.0]];
        let hull = Hull::of_polygon(&points).unwrap();
        let expected_area = (points[2][0] - points[0][0]) * (points[1][1] - points[0][1]) / 2.0;
        assert_eq!(hull.area(), expected_area);
        let [x, y] = hull.centroid();
        assert!((x - 1000.001).abs() < 2e-13);
        assert!((y - (1000.0 + (points[1][1] - 1000.0) / 3.0)).abs() < 2e-13);
    }

    #[test]
    fn cluster_follows_triangle_edges_above_threshold() {
        // A 3 x 3 grid; the statistic peaks at the centre and is low on the right column.
        let mut points = Vec::new();
        let mut statistic = Vec::new();
        for y in 0..3 {
            for x in 0..3 {
                points.push([x as f64, y as f64]);
                statistic.push(if x == 2 { 0.1 } else if (x, y) == (1, 1) { 1.0 } else { 0.6 });
            }
        }
        let triangulation = Triangulation::delaunay(&points);
        let mut cluster = cluster_roi(4, &statistic, 0.5, &triangulation);
        cluster.sort_unstable();
        assert_eq!(cluster, vec![0, 1, 3, 4, 6, 7]);
        assert!(cluster_roi(2, &statistic, 0.5, &triangulation).is_empty());
    }
}
