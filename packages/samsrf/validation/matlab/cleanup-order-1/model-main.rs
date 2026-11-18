#![allow(dead_code)]
mod polyshape;
fn bits(points: &[[f64; 2]]) -> Vec<[u64; 2]> {
    points.iter().map(|p| p.map(f64::to_bits)).collect()
}
fn estimate(vertices: &[[f64; 2]]) -> [u64; 3] {
    let centre = [0, 1].map(|axis| {
        let low = vertices.iter().map(|p| p[axis]).fold(f64::INFINITY, f64::min);
        let high = vertices.iter().map(|p| p[axis]).fold(f64::NEG_INFINITY, f64::max);
        (low + high) / 2.0
    });
    let w: Vec<[f64; 2]> = vertices.iter().map(|p| [p[0] - centre[0], p[1] - centre[1]]).collect();
    let mut twice = 0.0;
    for i in 0..w.len() {
        let (p, q) = (w[i], w[(i + 1) % w.len()]);
        twice += p[0] * q[1] - p[1] * q[0];
    }
    let inverse = 1.0 / twice;
    let (mut cx, mut cy) = (0.0, 0.0);
    for i in 0..w.len() {
        let (p, q) = (w[i], w[(i + 1) % w.len()]);
        let share = (p[0] * q[1] - p[1] * q[0]) * inverse;
        cx += (p[0] + q[0]) * share;
        cy += (p[1] + q[1]) * share;
    }
    let weight = -(twice / 2.0);
    let total = 0.0 + weight;
    let reciprocal = 1.0 / total;
    let x = (0.0 + weight * (cx * (1.0 / 3.0) + centre[0])) * reciprocal;
    let y = (0.0 + weight * (cy * (1.0 / 3.0) + centre[1])) * reciprocal;
    [x.to_bits(), y.to_bits(), (twice.abs() / 2.0).to_bits()]
}
fn main() {
    let input = std::fs::read_to_string(std::env::args().nth(1).unwrap()).unwrap();
    for line in input.lines() {
        let (id, raw) = line.split_once('\t').unwrap();
        let coords: Vec<f64> = raw.split_whitespace().map(|h| f64::from_bits(u64::from_str_radix(h, 16).unwrap())).collect();
        let points: Vec<[f64; 2]> = coords.chunks_exact(2).map(|p| [p[0], p[1]]).collect();
        let shape = polyshape::boundaries(&points);
        let shape_bits: Vec<Vec<[u64; 2]>> = shape.iter().map(|r| bits(r)).collect();
        let survivor = polyshape::convex_hull(&points).unwrap();
        let preclean = polyshape::preclean_start(&points).unwrap();
        println!("{id}\t{shape_bits:?}\t{:?}\t{:?}\t{:?}\t{:?}", bits(&survivor), bits(&preclean), estimate(&survivor), estimate(&preclean));
    }
}
