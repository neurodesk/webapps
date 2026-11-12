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

/// MATLAB's `polyshape(points).Vertices` as a set (the model does not reproduce
/// their ring order), and `Hull::of_polygon(points)`.
pub fn polyshape_vertices(points: &[[f64; 2]]) -> crate::error::Result<(Vec<[f64; 2]>, Option<Hull>)> {
    use crate::polyshape::Unresolved;
    let simplified = crate::polyshape::simplify(points).map_err(|failure| crate::error::Error::Shape(match failure {
        Unresolved::Grid => "polyshape: the coordinates do not fit the fixed-point grid MATLAB's polyshape is reproduced on".into(),
        Unresolved::Clipper(failure) => format!("polyshape: Clipper's union failed ({failure:?}); MATLAB's result for this polygon was not recorded"),
    }))?;
    let hull = simplified.hull.map(|vertices| Hull { vertices }).filter(|hull| hull.area() > 0.0);
    Ok((simplified.vertices, hull))
}

/// The polyshape model's stages in grid units (diagnostics, not an API):
/// `(centre, scale, tolerance, input ring, [first union, first clean, second
/// union, second clean], hull, first union's creation order)`.
#[doc(hidden)]
#[allow(clippy::type_complexity)]
pub fn polyshape_stages(points: &[[f64; 2]]) -> crate::error::Result<Option<([f64; 2], f64, f64, Vec<(i64, i64)>, [Vec<Vec<(i64, i64)>>; 4], Vec<(i64, i64)>, Vec<Vec<usize>>)>> {
    let stages = crate::polyshape::stages(points).map_err(|failure| crate::error::Error::Shape(format!("polyshape: {failure:?}")))?;
    Ok(stages.map(|s| (s.grid.centre, s.grid.scale, s.grid.tolerance, s.ring, [s.first_union, s.first_clean, s.second_union, s.second_clean], s.hull, s.first_union_order)))
}

/// `polyshape_stages` for several boundaries united together (diagnostic
/// replays of NaN-separated polyshape vertices).
#[doc(hidden)]
#[allow(clippy::type_complexity)]
pub fn polyshape_stages_of_boundaries(boundaries: &[Vec<[f64; 2]>]) -> crate::error::Result<Option<([f64; 2], f64, f64, Vec<(i64, i64)>, [Vec<Vec<(i64, i64)>>; 4], Vec<(i64, i64)>, Vec<Vec<usize>>)>> {
    let stages = crate::polyshape::stages_of_boundaries(boundaries).map_err(|failure| crate::error::Error::Shape(format!("polyshape: {failure:?}")))?;
    Ok(stages.map(|s| (s.grid.centre, s.grid.scale, s.grid.tolerance, s.ring, [s.first_union, s.first_clean, s.second_union, s.second_clean], s.hull, s.first_union_order)))
}

/// Invoke the model's actual grid cleaner for diagnostic replays.
#[doc(hidden)]
pub fn polyshape_clean(path: &[(i64, i64)], tolerance: f64) -> Vec<(i64, i64)> {
    crate::polyshape::clean(path, tolerance)
}

/// A convex polygon: its vertices counter-clockwise, without a repeated closing vertex.
#[derive(Debug, Clone, PartialEq)]
pub struct Hull {
    pub vertices: Vec<[f64; 2]>,
}

impl Hull {
    /// `polyshape(points).convhull`, as MATLAB R2023b computes it on its
    /// fixed-point grid with the even-odd rule and its 1e-8 cleaning tolerance
    /// (see `polyshape.rs`). `Ok(None)` where that shape is empty. An error where
    /// the model cannot follow MATLAB and MATLAB's result was not recorded:
    /// coordinates outside its integer grid, or a failed Clipper sweep.
    pub fn of_polygon(points: &[[f64; 2]]) -> crate::error::Result<Option<Hull>> {
        Ok(polyshape_vertices(points)?.1)
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
        for triangle in delaunay_triangles(points) {
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

/// The Delaunay triangles of `points`, counter-clockwise, as indices into `points`.
///
/// Cocircular points have several Delaunay triangulations. This one is unique: it
/// decides every incircle test exactly (Shewchuk's adaptive predicates) and breaks
/// exact ties with CGAL's symbolic perturbation, which lifts each point by an
/// infinitesimal that grows with its lexicographic (x, then y) rank. The result
/// therefore depends only on the point set, not on the input order or on the order
/// of insertion and flips. Duplicate points after the first and non-finite points
/// belong to no triangle; with fewer than three non-collinear points there are none.
pub fn delaunay_triangles(points: &[[f64; 2]]) -> Vec<[usize; 3]> {
    let mut order: Vec<usize> = (0..points.len()).filter(|&i| points[i][0].is_finite() && points[i][1].is_finite()).collect();
    order.sort_by(|&a, &b| row_order(&points[a], &points[b]).then(a.cmp(&b)));
    order.dedup_by(|b, a| points[*a] == points[*b]);
    let orient = |a: usize, b: usize, c: usize| orient(points, a, b, c);
    let Some(apex) = (2..order.len()).find(|&k| orient(order[0], order[1], order[k]) != 0.0) else {
        return Vec::new();
    };
    let mut mesh = Mesh::default();
    let chain = &order[..apex];
    let top = order[apex];
    let left = orient(chain[0], chain[1], top) > 0.0;
    for pair in chain.windows(2) {
        if left {
            mesh.add([pair[0], pair[1], top]);
        } else {
            mesh.add([pair[1], pair[0], top]);
        }
    }
    let mut hull: Vec<usize> = if left {
        chain.iter().copied().chain([top]).collect()
    } else {
        chain.iter().rev().copied().chain([top]).collect()
    };
    for &p in &order[apex + 1..] {
        // p is lexicographically after every hull vertex, so it lies strictly
        // outside the hull and sees one contiguous chain of hull edges.
        let n = hull.len();
        let visible: Vec<bool> = (0..n).map(|i| orient(hull[i], hull[(i + 1) % n], p) < 0.0).collect();
        let first = (0..n).find(|&i| visible[i] && !visible[(i + n - 1) % n]).expect("a point outside the hull sees an edge");
        let mut last = first;
        while visible[(last + 1) % n] {
            last = (last + 1) % n;
        }
        let mut i = first;
        loop {
            mesh.add([hull[(i + 1) % n], hull[i], p]);
            if i == last {
                break;
            }
            i = (i + 1) % n;
        }
        // Keep hull[first] and hull[last + 1]; p replaces the vertices between them.
        let keep_from = (last + 1) % n;
        let mut next = Vec::with_capacity(n + 1);
        let mut j = keep_from;
        loop {
            next.push(hull[j]);
            if j == first {
                break;
            }
            j = (j + 1) % n;
        }
        next.push(p);
        hull = next;
    }
    mesh.make_delaunay(points);
    mesh.triangles.into_iter().flatten().collect()
}

fn coord(point: &[f64; 2]) -> robust::Coord<f64> {
    robust::Coord { x: point[0], y: point[1] }
}

fn orient(points: &[[f64; 2]], a: usize, b: usize, c: usize) -> f64 {
    robust::orient2d(coord(&points[a]), coord(&points[b]), coord(&points[c]))
}

/// CGAL's `side_of_oriented_circle(p0, p1, p2, p, perturb = true)` for a
/// counter-clockwise `p0 p1 p2`: whether `p` is inside their circle once exact
/// cocircularity is resolved by the symbolic perturbation. Never on the circle.
fn inside_circle(points: &[[f64; 2]], p0: usize, p1: usize, p2: usize, p: usize) -> bool {
    let side = robust::incircle(coord(&points[p0]), coord(&points[p1]), coord(&points[p2]), coord(&points[p]));
    if side != 0.0 {
        return side > 0.0;
    }
    let mut ranked = [p0, p1, p2, p];
    ranked.sort_by(|&a, &b| row_order(&points[a], &points[b]));
    for &leading in ranked[2..].iter().rev() {
        let side = if leading == p {
            return false;
        } else if leading == p2 {
            orient(points, p0, p1, p)
        } else if leading == p1 {
            orient(points, p0, p, p2)
        } else {
            orient(points, p, p1, p2)
        };
        if side != 0.0 {
            return side > 0.0;
        }
    }
    unreachable!("the perturbation resolves every cocircular quadruple")
}

/// Counter-clockwise triangles with an index from each directed edge to its triangle.
#[derive(Default)]
struct Mesh {
    triangles: Vec<Option<[usize; 3]>>,
    edges: std::collections::HashMap<(usize, usize), usize>,
}

impl Mesh {
    fn add(&mut self, triangle: [usize; 3]) {
        let index = self.triangles.len();
        for i in 0..3 {
            self.edges.insert((triangle[i], triangle[(i + 1) % 3]), index);
        }
        self.triangles.push(Some(triangle));
    }

    fn remove(&mut self, index: usize) -> [usize; 3] {
        let triangle = self.triangles[index].take().expect("a live triangle");
        for i in 0..3 {
            self.edges.remove(&(triangle[i], triangle[(i + 1) % 3]));
        }
        triangle
    }

    fn opposite(triangle: [usize; 3], a: usize, b: usize) -> usize {
        triangle.into_iter().find(|&v| v != a && v != b).expect("a third vertex")
    }

    /// Lawson's edge flips. Each flip lowers the perturbed lifted surface, so the
    /// flips stop at the unique triangulation in which every edge is locally Delaunay.
    fn make_delaunay(&mut self, points: &[[f64; 2]]) {
        let mut pending: Vec<(usize, usize)> = self.triangles.iter().flatten().flat_map(|t| [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])]).collect();
        while let Some((u, v)) = pending.pop() {
            let (Some(&left), Some(&right)) = (self.edges.get(&(u, v)), self.edges.get(&(v, u))) else {
                continue;
            };
            let w = Self::opposite(self.triangles[left].unwrap(), u, v);
            let x = Self::opposite(self.triangles[right].unwrap(), u, v);
            if !inside_circle(points, u, v, w, x) {
                continue;
            }
            self.remove(left);
            self.remove(right);
            self.add([w, u, x]);
            self.add([x, v, w]);
            pending.extend([(u, x), (x, v), (v, w), (w, u)]);
        }
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
        let hull = Hull::of_polygon(&points).unwrap().unwrap();
        let expected_area = (points[2][0] - points[0][0]) * (points[1][1] - points[0][1]) / 2.0;
        assert_eq!(hull.area(), expected_area);
        let [x, y] = hull.centroid();
        assert!((x - 1000.001).abs() < 2e-13);
        assert!((y - (1000.0 + (points[1][1] - 1000.0) / 3.0)).abs() < 2e-13);
    }

    fn edges(triangles: &[[usize; 3]]) -> std::collections::BTreeSet<(usize, usize)> {
        triangles.iter().flat_map(|t| (0..3).map(move |i| (t[i].min(t[(i + 1) % 3]), t[i].max(t[(i + 1) % 3])))).collect()
    }

    /// A deterministic generator for the property tests (xorshift64*).
    fn uniform(state: &mut u64) -> f64 {
        *state ^= *state >> 12;
        *state ^= *state << 25;
        *state ^= *state >> 27;
        (state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Every triangle is counter-clockwise, the triangles tile the hull (Euler's
    /// count) and no point lies strictly inside the circle of a triangle.
    fn assert_delaunay(points: &[[f64; 2]], triangles: &[[usize; 3]]) {
        let hull_points = (0..points.len()).filter(|&i| {
            let hull = Hull::of(points).unwrap();
            let n = hull.vertices.len();
            (0..n).any(|k| {
                let (a, b) = (hull.vertices[k], hull.vertices[(k + 1) % n]);
                robust::orient2d(coord(&a), coord(&b), coord(&points[i])) == 0.0
                    && points[i][0] >= a[0].min(b[0]) && points[i][0] <= a[0].max(b[0])
                    && points[i][1] >= a[1].min(b[1]) && points[i][1] <= a[1].max(b[1])
            })
        }).count();
        assert_eq!(triangles.len(), 2 * points.len() - hull_points - 2);
        for t in triangles {
            assert!(orient(points, t[0], t[1], t[2]) > 0.0);
            for p in 0..points.len() {
                if !t.contains(&p) {
                    let side = robust::incircle(coord(&points[t[0]]), coord(&points[t[1]]), coord(&points[t[2]]), coord(&points[p]));
                    assert!(side <= 0.0, "point {p} inside the circle of {t:?}");
                }
            }
        }
    }

    #[test]
    fn delaunay_matches_delaunator_on_points_in_general_position() {
        let mut state = 0x9E37_79B9_7F4A_7C15;
        for n in [3, 4, 10, 50, 300] {
            let points: Vec<[f64; 2]> = (0..n).map(|_| [uniform(&mut state) * 7.0 - 3.0, uniform(&mut state) * 2.0 + 100.0]).collect();
            let ours = delaunay_triangles(&points);
            assert_delaunay(&points, &ours);
            let input: Vec<delaunator::Point> = points.iter().map(|p| delaunator::Point { x: p[0], y: p[1] }).collect();
            let theirs: Vec<[usize; 3]> = delaunator::triangulate(&input).triangles.chunks(3).map(|t| [t[0], t[1], t[2]]).collect();
            assert_eq!(edges(&ours), edges(&theirs), "{n} points");
        }
    }

    #[test]
    fn cocircular_ties_are_broken_independently_of_input_order() {
        let mut state = 0xD1B5_4A32_D192_ED03;
        for (nx, ny) in [(3, 3), (4, 5), (6, 6)] {
            let grid: Vec<[f64; 2]> = (0..ny).flat_map(|y| (0..nx).map(move |x| [f64::from(x), f64::from(y)])).collect();
            let reference = delaunay_triangles(&grid);
            assert_delaunay(&grid, &reference);
            let expected = edges(&reference);
            for _ in 0..20 {
                let mut order: Vec<usize> = (0..grid.len()).collect();
                for i in (1..order.len()).rev() {
                    order.swap(i, (uniform(&mut state) * (i + 1) as f64) as usize);
                }
                let shuffled: Vec<[f64; 2]> = order.iter().map(|&i| grid[i]).collect();
                let back: Vec<[usize; 3]> = delaunay_triangles(&shuffled).iter().map(|t| [order[t[0]], order[t[1]], order[t[2]]]).collect();
                assert_eq!(edges(&back), expected);
            }
        }
    }

    #[test]
    fn degenerate_inputs_have_no_triangles_and_duplicates_none_of_their_own() {
        assert!(delaunay_triangles(&[]).is_empty());
        assert!(delaunay_triangles(&[[0.0, 0.0], [1.0, 1.0]]).is_empty());
        assert!(delaunay_triangles(&[[0.0, 0.0], [1.0, 2.0], [2.0, 4.0], [3.0, 6.0]]).is_empty());
        let collinear_then_apex = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0], [1.5, 1.0]];
        let triangles = delaunay_triangles(&collinear_then_apex);
        assert_delaunay(&collinear_then_apex, &triangles);
        let duplicate = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 0.0]];
        let triangles = delaunay_triangles(&duplicate);
        assert_eq!(triangles.len(), 1);
        assert!(!triangles[0].contains(&3));
    }

    #[test]
    fn a_spike_narrower_than_the_cutoff_leaves_the_hull() {
        // MATLAB R2023b drops a spike 2e-9 of the span wide and keeps one 2e-8 wide.
        let spike = |w: f64| [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5 + w, 1.0], [0.5, 1.5], [0.5 - w, 1.0], [0.0, 1.0]];
        assert_eq!(Hull::of_polygon(&spike(1.5e-9)).unwrap().unwrap().area(), 1.0);
        assert!(Hull::of_polygon(&spike(1.5e-8)).unwrap().unwrap().area() > 1.0);
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
