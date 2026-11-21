//! De-shearing time on a real scan: `cargo run --release --example deshear_bench -- CT.nii`. On the 512×512×288
//! gantry-tilted CT (M4 Pro, one thread) it took 0.46 s; the JavaScript it replaced (pipeline.js `resampleOnto` at
//! 55199029d) took 1.35 s for the same bits.
use std::time::Instant;
use syncro_core::geometry::{orthogonal_grid, resample_linear};
use syncro_core::volume::read;

fn main() {
    let path = std::env::args().nth(1).expect("usage: deshear_bench IMAGE");
    let v = read(&std::fs::read(path).unwrap()).unwrap();
    let grid = orthogonal_grid(v.dims, &v.affine)
        .unwrap()
        .expect("not sheared");
    let fill = v.data.iter().copied().fold(f32::INFINITY, f32::min);
    let mut best = f64::INFINITY;
    for _ in 0..5 {
        let t = Instant::now();
        let out = resample_linear(&v, &grid, fill).unwrap();
        best = best.min(t.elapsed().as_secs_f64());
        std::hint::black_box(out);
    }
    println!("{:?} -> {:?}: best of 5 {:.3} s", v.dims, grid.dims, best);
}
