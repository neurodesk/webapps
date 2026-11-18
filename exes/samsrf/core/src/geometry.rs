//! Planar geometry the reverse-correlation analyses use in place of MATLAB's
//! `delaunayTriangulation`, `convexHull`, `polyshape` and `samsrf_clusterroi`:
//! unique rows, the convex hull with its area and centroid, and a flood fill over
//! a Delaunay triangulation.
//!
//! A hull needs three non-collinear points. With fewer, MATLAB's `polyshape` is empty
//! (area 0, centroid NaN) and `convexHull` errors; the constructors return `None` and
//! each caller applies SamSrf's own fallback.

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

/// Which evaluation a hull estimate takes. `Listed` is the port's evaluation
/// before it followed MATLAB's stored order, and the analyses' default. `Stored`
/// follows the order and arithmetic fitted to MATLAB's recordings (`Hull`): it
/// matches far more recorded values but loses some that `Listed` matched,
/// because the port's rings of a self-intersecting polygon are not MATLAB's
/// (`packages/samsrf/validation/matlab/README.md`, "Hull area, centroid and vertex
/// order"). It stays diagnostic until it loses none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HullOrder {
    #[default]
    Listed,
    Stored,
}

/// `polyshape(points).convhull` as the port evaluated it before #732's
/// stored-order work: the same vertices, counter-clockwise from the lowest grid
/// point, with area and centroid summed from the first vertex.
#[derive(Debug, Clone, PartialEq)]
pub struct ListedHull {
    pub vertices: Vec<[f64; 2]>,
}

impl ListedHull {
    /// `None` where the shape is empty or its hull spans no area.
    pub fn of_polygon(points: &[[f64; 2]]) -> Option<ListedHull> {
        let hull = ListedHull { vertices: crate::polyshape::convex_hull_as_listed(points)? };
        (hull.area() > 0.0).then_some(hull)
    }

    /// The convex hull of `points` (Andrew's monotone chain): its corners
    /// counter-clockwise from the lexicographically smallest, or `None` when the
    /// points span no area. Its area is also what the port takes for
    /// `[K, AV] = convexHull(delaunayTriangulation(points))`, whose arithmetic is
    /// not identified (`packages/samsrf/validation/matlab/hull-area-predictions.md`).
    pub fn of(points: &[[f64; 2]]) -> Option<ListedHull> {
        let mut sorted: Vec<[f64; 2]> = points.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
        sorted.sort_by(row_order);
        sorted.dedup();
        if sorted.len() < 3 {
            return None;
        }
        let cross = |o: &[f64; 2], a: &[f64; 2], b: &[f64; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        let chain = |ordered: &mut dyn Iterator<Item = &[f64; 2]>| {
            let mut half: Vec<[f64; 2]> = Vec::new();
            for p in ordered {
                while half.len() >= 2 && cross(&half[half.len() - 2], &half[half.len() - 1], p) <= 0.0 {
                    half.pop();
                }
                half.push(*p);
            }
            half.pop();
            half
        };
        let mut corners = chain(&mut sorted.iter());
        corners.extend(chain(&mut sorted.iter().rev()));
        let hull = ListedHull { vertices: corners };
        if hull.vertices.len() < 3 || hull.area() <= 0.0 {
            return None;
        }
        Some(hull)
    }

    /// Shoelace area, translated to the first vertex.
    pub fn area(&self) -> f64 {
        self.sums().0.abs() / 2.0
    }

    /// The polygon centroid from the same sums.
    pub fn centroid(&self) -> [f64; 2] {
        let (twice, cx, cy) = self.sums();
        let origin = self.vertices[0];
        [origin[0] + cx / (3.0 * twice), origin[1] + cy / (3.0 * twice)]
    }

    fn sums(&self) -> (f64, f64, f64) {
        let n = self.vertices.len();
        let origin = self.vertices[0];
        let (mut twice, mut cx, mut cy) = (0.0, 0.0, 0.0);
        for i in 0..n {
            let a = [self.vertices[i][0] - origin[0], self.vertices[i][1] - origin[1]];
            let next = self.vertices[(i + 1) % n];
            let b = [next[0] - origin[0], next[1] - origin[1]];
            let cross = a[0] * b[1] - b[0] * a[1];
            twice += cross;
            cx += (a[0] + b[0]) * cross;
            cy += (a[1] + b[1]) * cross;
        }
        (twice, cx, cy)
    }
}

/// `(centroid, area)` of `polyshape(points).convhull` under `order`, or `None`
/// where that hull is empty.
pub fn polygon_hull_estimate(points: &[[f64; 2]], order: HullOrder) -> Option<([f64; 2], f64)> {
    match order {
        HullOrder::Listed => ListedHull::of_polygon(points).map(|hull| (hull.centroid(), hull.area())),
        HullOrder::Stored => Hull::of_polygon(points).map(|hull| (hull.centroid(), hull.area())),
    }
}

/// A diagnostic boundary model fitted to recorded MATLAB R2023b `polyshape`
/// output: clockwise, without a repeated closing vertex. Agreement of `area`
/// and `centroid` depends on the stored vertex order; other inputs are unestablished.
#[derive(Debug, Clone, PartialEq)]
pub struct Hull {
    pub vertices: Vec<[f64; 2]>,
}

impl Hull {
    /// Empirical model of `polyshape(points).convhull`, using a fixed-point grid,
    /// the even-odd rule and a 1e-8 cleaning tolerance (see `polyshape.rs`).
    /// This does not identify MATLAB's internal algorithm. `None` for empty shapes.
    pub fn of_polygon(points: &[[f64; 2]]) -> Option<Hull> {
        let hull = Hull { vertices: crate::polyshape::convex_hull(points)? };
        (hull.area() > 0.0).then_some(hull)
    }

    /// `polyshape(DT.Points(convexHull(DT), :))` for `DT = delaunayTriangulation(points)`:
    /// the boundary of the points' hull, exactly collinear points included and
    /// counter-clockwise from the first input point on it, cleaned and stored as
    /// `polyshape` does. `None` where that shape is empty or the points span no area.
    pub fn of_delaunay_boundary(points: &[[f64; 2]]) -> Option<Hull> {
        let boundary = delaunay_boundary(points)?;
        let mut stored = crate::polyshape::boundaries(&boundary);
        if stored.len() != 1 {
            return None;
        }
        let hull = Hull { vertices: stored.remove(0) };
        (hull.area() > 0.0).then_some(hull)
    }

    /// `polyshape.area`: half the absolute sum, in stored order, of the cross
    /// products of consecutive vertices taken from the centre of their bounding box.
    pub fn area(&self) -> f64 {
        let sums = self.sums();
        times_power_of_two(sums.twice.abs() / 2.0, 2 * sums.exponent)
    }

    /// Empirical arithmetic fit to recorded `polyshape.centroid` values on the
    /// stored vertices: relative to the bounding-box centre, the sum of cross
    /// products `a`, then `sum((x1 + x2) * (t * (1/a)))` times `1/3`, back in
    /// place, weighted by the clockwise-positive area `-a/2` and multiplied by
    /// its reciprocal, as for one boundary of a multi-boundary shape.
    ///
    /// Where these steps underflow they stay MATLAB's: the recorded triangle of
    /// side 1e-300 has area 0 and centroid NaN. No recording shows MATLAB
    /// overflowing, and there the port keeps the centroid finite: sums that
    /// would overflow are taken on the vertices divided by a power of two
    /// (`Sums`), and where `-a/2` times a coordinate would overflow, the
    /// product is taken on that coordinate's significand and its power of two
    /// restored last. Either rounds as the steps would with an unbounded
    /// exponent, so a hull scaled by a power of two has its centroid scaled.
    pub fn centroid(&self) -> [f64; 2] {
        let Sums { twice, centre, w, exponent } = self.sums();
        let inverse = 1.0 / twice;
        let n = w.len();
        let (mut cx, mut cy) = (0.0, 0.0);
        for i in 0..n {
            let (p, q) = (w[i], w[(i + 1) % n]);
            let share = (p[0] * q[1] - p[1] * q[0]) * inverse;
            cx += (p[0] + q[0]) * share;
            cy += (p[1] + q[1]) * share;
        }
        let third = 1.0 / 3.0;
        let local = [times_power_of_two(cx * third, exponent) + centre[0], times_power_of_two(cy * third, exponent) + centre[1]];
        // In units of 2^(2 exponent) and its inverse, which cancel.
        let weight = -(twice / 2.0);
        let total = 0.0 + weight;
        let reciprocal = 1.0 / total;
        local.map(|value| {
            let k = if exponent == 0 && (weight * value).is_finite() { 0 } else { binade(value) };
            times_power_of_two((0.0 + weight * times_power_of_two(value, -k)) * reciprocal, k)
        })
    }

    fn sums(&self) -> Sums {
        let (low, high) = self.vertices.iter().fold(([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]), |(low, high), p| {
            ([low[0].min(p[0]), low[1].min(p[1])], [high[0].max(p[0]), high[1].max(p[1])])
        });
        let centre = [midpoint(low[0], high[0]), midpoint(low[1], high[1])];
        let w: Vec<[f64; 2]> = self.vertices.iter().map(|p| [p[0] - centre[0], p[1] - centre[1]]).collect();
        let twice = twice_area(&w);
        if twice.is_finite() {
            return Sums { twice, centre, w, exponent: 0 };
        }
        let exponent = binade(w.iter().fold(0.0_f64, |m, p| m.max(p[0].abs()).max(p[1].abs())));
        let w: Vec<[f64; 2]> = w.iter().map(|p| p.map(|v| times_power_of_two(v, -exponent))).collect();
        Sums { twice: twice_area(&w), centre, w, exponent }
    }
}

/// The stored vertices relative to the centre of their bounding box and twice
/// their signed area, in units of `2^exponent` (`2^2exponent` for the area). The
/// exponent is 0 unless the area overflows; then it brings the largest coordinate
/// into [1, 2), which rounds nothing unless a coordinate is 2^1022 times smaller.
struct Sums {
    twice: f64,
    centre: [f64; 2],
    w: Vec<[f64; 2]>,
    exponent: i32,
}

fn twice_area(w: &[[f64; 2]]) -> f64 {
    let n = w.len();
    let mut twice = 0.0;
    for i in 0..n {
        let (p, q) = (w[i], w[(i + 1) % n]);
        twice += p[0] * q[1] - p[1] * q[0];
    }
    twice
}

/// `(low + high) / 2`, or `low/2 + high/2`, which rounds the same, where the sum overflows.
fn midpoint(low: f64, high: f64) -> f64 {
    let sum = low + high;
    if sum.is_infinite() && low.is_finite() && high.is_finite() { low / 2.0 + high / 2.0 } else { sum / 2.0 }
}

/// `k` with `2^k <= |x| < 2^(k+1)`; 0 where `x` is zero or not finite.
fn binade(x: f64) -> i32 {
    if x == 0.0 || !x.is_finite() {
        return 0;
    }
    let bits = x.abs().to_bits();
    match (bits >> 52) as i32 {
        0 => 63 - bits.leading_zeros() as i32 - 1074,
        biased => biased - 1023,
    }
}

/// `x * 2^k`: exact unless the result overflows or is subnormal.
fn times_power_of_two(mut x: f64, mut k: i32) -> f64 {
    let power = |k: i32| f64::from_bits(((k + 1023) as u64) << 52);
    while k > 1023 {
        x *= power(1023);
        k -= 1023;
    }
    while k < -1022 {
        x *= power(-1022);
        k += 1022;
    }
    x * power(k)
}

/// The boundary of the convex hull of `points` that `convexHull` of their
/// Delaunay triangulation lists: decided with exact predicates, exactly
/// collinear points included, counter-clockwise from the first input point on
/// it. `None` where the points span no area.
fn delaunay_boundary(points: &[[f64; 2]]) -> Option<Vec<[f64; 2]>> {
    let finite: Vec<[f64; 2]> = points.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
    let mut sorted = finite.clone();
    sorted.sort_by(row_order);
    sorted.dedup();
    let turn = |a: &[f64; 2], b: &[f64; 2], c: &[f64; 2]| robust::orient2d(coord(a), coord(b), coord(c));
    if sorted.len() < 3 || (2..sorted.len()).all(|k| turn(&sorted[0], &sorted[1], &sorted[k]) == 0.0) {
        return None;
    }
    let chain = |ordered: &mut dyn Iterator<Item = &[f64; 2]>| {
        let mut half: Vec<[f64; 2]> = Vec::new();
        for p in ordered {
            while half.len() >= 2 && turn(&half[half.len() - 2], &half[half.len() - 1], p) < 0.0 {
                half.pop();
            }
            half.push(*p);
        }
        half.pop();
        half
    };
    let mut boundary = chain(&mut sorted.iter());
    boundary.extend(chain(&mut sorted.iter().rev()));
    let start = finite.iter().find_map(|p| boundary.iter().position(|b| b == p))?;
    boundary.rotate_left(start);
    Some(boundary)
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

    /// MATLAB R2023b's `centroid` and `area` of hulls it stored in this vertex
    /// order (record_geometry.m, `geometry-reference.json`, both hosts).
    #[test]
    fn centroid_and_area_round_as_matlab_on_its_stored_vertices() {
        let cases: [(&[[f64; 2]], [f64; 3]); 7] = [
            // From the box centre, 1/3 lands one ULP above its correct rounding.
            (&[[0.0, 0.0], [1.0, 1.0], [1.0, 0.0]], [0.6666666666666666, 0.33333333333333337, 0.5]),
            // Exact sums; MATLAB's y is one ULP below the correctly rounded 13/9.
            (&[[1.0, 2.0], [2.0, 2.0], [2.0, 1.0], [0.0, 1.0]], [1.2222222222222223, 1.4444444444444442, 1.5]),
            (&[[0.5, 0.0], [0.0, 2.0], [2.0, 1.0], [2.0, 0.5]], [0.9509803921568628, 0.9117647058823529, 2.125]),
            // Cross products cancel by about 4e6 ULP.
            (&[[0.0, 0.0], [7.64842058440951e-05, 6.442178402061286e-05], [0.001529684374568977, 0.001288435374475382]], [0.0005353895268043573, 0.00045095238616533166, 2.0000000072549875e-14]),
            // A centroid on the axes is +0, not -0.
            (&[[-0.5, -1.0], [-1.0, 0.0], [0.5, 1.0], [1.0, 0.0]], [0.0, 0.0, 2.0]),
            // The extreme grids of the polyshape probe: at 1e-300 every cross
            // product underflows to 0, so MATLAB's area is 0 and its centroid NaN.
            (&[[0.0, 0.0], [0.0, 1e-300], [1e-300, 0.0]], [f64::NAN, f64::NAN, 0.0]),
            (&[[1e12, 1e12], [1e12, 1000000000000.001], [1000000000000.001, 1e12]], [1000000000000.0004, 1000000000000.0004, 4.76837158203125e-07]),
        ];
        let bits = |v: f64| if v.is_nan() { f64::NAN.to_bits() } else { v.to_bits() };
        for (vertices, expected) in cases {
            let hull = Hull { vertices: vertices.to_vec() };
            let [x, y] = hull.centroid();
            assert_eq!([x, y, hull.area()].map(bits), expected.map(bits), "{vertices:?}");
        }
    }

    /// Recorded cases scaled by powers of two: within range (2^-300), and above
    /// it, where `-a/2` times the centroid would overflow (from about 2^341
    /// here) and then the cross products (from 2^511). The bits scale with them.
    #[test]
    fn scaled_cases_scale_their_bits() {
        let cases: [(&[[f64; 2]], [f64; 3]); 3] = [
            (&[[0.0, 0.0], [1.0, 1.0], [1.0, 0.0]], [0.6666666666666666, 0.33333333333333337, 0.5]),
            (&[[0.0, 0.0], [7.64842058440951e-05, 6.442178402061286e-05], [0.001529684374568977, 0.001288435374475382]], [0.0005353895268043573, 0.00045095238616533166, 2.0000000072549875e-14]),
            (&[[-0.5, -1.0], [-1.0, 0.0], [0.5, 1.0], [1.0, 0.0]], [0.0, 0.0, 2.0]),
        ];
        for (vertices, expected) in cases {
            for k in [-300, 350, 600, 900] {
                let hull = Hull { vertices: vertices.iter().map(|p| p.map(|v| times_power_of_two(v, k))).collect() };
                let [x, y] = hull.centroid();
                assert_eq!([x, y].map(f64::to_bits), [expected[0], expected[1]].map(|v| times_power_of_two(v, k).to_bits()), "{vertices:?} times 2^{k}");
                let area = times_power_of_two(expected[2], 2 * k);
                if area.is_normal() {
                    assert_eq!(hull.area().to_bits(), area.to_bits(), "{vertices:?} times 2^{k}");
                }
            }
        }
    }

    /// Rectangles far out, whose centroid is the middle of their bounding box.
    #[test]
    fn extreme_hulls_have_finite_centroids() {
        for (offset, side) in [(1e115, 1e100), (1e150, 1e140), (1e300, 1e290), (-1e307, 1e306), (1.7e308, 1e295)] {
            let corners = vec![[offset, 0.0], [offset + side, 0.0], [offset + side, side], [offset, side]];
            let direct = Hull { vertices: corners.clone() };
            let mut hulls = vec![direct];
            if offset.abs() < 1e200 && offset.abs() > 1.0 {
                hulls.push(Hull::of_polygon(&corners).unwrap());
            }
            for hull in hulls {
                let (low, high) = (offset, offset + side);
                let middle = [low / 2.0 + high / 2.0, side / 2.0];
                let [x, y] = hull.centroid();
                assert!(x.is_finite() && y.is_finite(), "{offset} {side}: {x} {y}");
                for (got, want) in [(x, middle[0]), (y, middle[1])] {
                    assert!(got.to_bits().abs_diff(want.to_bits()) <= 2, "{offset} {side}: {got} vs {want}");
                }
            }
        }
    }

    #[test]
    fn powers_of_two_are_carried_exactly() {
        assert_eq!([binade(1.0), binade(1.5), binade(0.75), binade(-8.0), binade(f64::MAX), binade(f64::MIN_POSITIVE)], [0, 0, -1, 3, 1023, -1022]);
        assert_eq!([binade(5e-324), binade(3.0 * 5e-324), binade(0.0), binade(f64::NAN)], [-1074, -1073, 0, 0]);
        assert_eq!(times_power_of_two(1.5, 2000), f64::INFINITY);
        assert_eq!(times_power_of_two(times_power_of_two(1.5, 2000), -2000), f64::INFINITY);
        assert_eq!(times_power_of_two(times_power_of_two(1.5e-300, 1500), -1500), 1.5e-300);
        assert_eq!(times_power_of_two(times_power_of_two(1e300, -2000), 2000), 1e300);
        assert_eq!(times_power_of_two(times_power_of_two(1.5, -1050), 1050), 1.5);
        assert_eq!(times_power_of_two(1.0, -1074), 5e-324);
        assert_eq!(midpoint(f64::MAX, f64::MAX), f64::MAX);
        assert_eq!(midpoint(1.0, 2.0), 1.5);
    }

    /// A recorded cloud of distinct points: MATLAB's hull, in its stored order, and its bits.
    #[test]
    fn polygon_hull_is_stored_and_rounded_as_matlab_stores_it() {
        let points = [[0.4549171866074128, 1.9098343775159823], [0.9804315476094008, 2.960863106026634], [0.29706208837477277, 1.594123948026354], [0.1567924020000721, 1.3135849239128334]];
        let hull = Hull::of_polygon(&points).unwrap();
        assert_eq!(hull.vertices, vec![[0.9804315476094008, 2.960863106026634], [0.29706208837477277, 1.594123948026354], [0.1567924020000721, 1.3135849239128334]]);
        let [x, y] = hull.centroid();
        assert_eq!([x, y, hull.area()].map(f64::to_bits), [0.4780953459852008, 1.9561906593028449, 1.3592302744447338e-07].map(f64::to_bits));
    }

    #[test]
    fn delaunay_boundary_keeps_collinear_points_from_the_first_input_point() {
        // A 3 x 3 grid listed column by column, top first, as the pixel order lists it.
        let points: Vec<[f64; 2]> = (0..3).flat_map(|x| (0..3).rev().map(move |y| [f64::from(x), f64::from(y)])).collect();
        let boundary = delaunay_boundary(&points).unwrap();
        assert_eq!(boundary, vec![[0.0, 2.0], [0.0, 1.0], [0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [2.0, 1.0], [2.0, 2.0], [1.0, 2.0]]);
        let hull = Hull::of_delaunay_boundary(&points).unwrap();
        assert_eq!(hull.vertices, vec![[0.0, 2.0], [2.0, 2.0], [2.0, 0.0], [0.0, 0.0]], "polyshape drops the collinear points and turns the ring clockwise");
        assert_eq!(ListedHull::of(&points).map(|hull| hull.area()), Some(4.0));
    }

    /// `[K, AV] = convexHull(delaunayTriangulation(P))`'s `K` as MATLAB R2023b
    /// recorded it (round hull-area-1: every one of 424 point sets, here two):
    /// collinear points kept, counter-clockwise from the first input point on the hull.
    #[test]
    fn delaunay_boundary_lists_matlabs_convex_hull() {
        let cases: [(&[[f64; 2]], &[usize]); 2] = [
            (&[[4.5101010101010095, 0.6717171717171717], [4.5101010101010095, 0.4797979797979798], [4.7020202020202015, 0.6717171717171717], [4.7020202020202015, 0.4797979797979798]], &[1, 2, 4, 3]),
            (&[[2.015151515151515, -7.388888888888888], [2.015151515151515, -7.58080808080808], [2.015151515151515, -7.7727272727272725], [2.2070707070707067, -7.388888888888888], [2.2070707070707067, -7.58080808080808], [2.2070707070707067, -7.7727272727272725], [2.398989898989899, -7.388888888888888], [2.398989898989899, -7.58080808080808]], &[1, 2, 3, 6, 8, 7, 4]),
        ];
        for (points, k) in cases {
            let boundary = delaunay_boundary(points).unwrap();
            let listed: Vec<usize> = boundary.iter().map(|b| points.iter().position(|p| p == b).unwrap() + 1).collect();
            assert_eq!(listed, k);
        }
    }

    #[test]
    fn degenerate_sets_have_no_hull() {
        for points in [&[[0.0, 0.0], [1.0, 1.0]][..], &[[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]], &[[0.0, 0.0], [0.0, 0.0], [0.0, 0.0]]] {
            assert_eq!(ListedHull::of(points), None);
            assert_eq!(Hull::of_delaunay_boundary(points), None);
            assert_eq!(Hull::of_polygon(points), None);
        }
    }

    #[test]
    fn listed_hull_preserves_base_nan_area_after_overflow() {
        let points = [[0.0, 0.0], [2e200, 1e200], [1e200, 1e200]];
        let hull = ListedHull::of(&points).expect("base retains a hull when its area is NaN");
        assert!(hull.area().is_nan());
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
        let hull_points = delaunay_boundary(points).unwrap().len();
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
        assert_eq!(Hull::of_polygon(&spike(1.5e-9)).unwrap().area(), 1.0);
        assert!(Hull::of_polygon(&spike(1.5e-8)).unwrap().area() > 1.0);
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
