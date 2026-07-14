//! Validate the flat (Float32Array-style) WASM API natively against the golden
//! final maps. Compiling to wasm is checked separately by `wasm-pack build`.

use std::path::PathBuf;

use mp2rage_wasm::{t1map_b1, t1map_sa2rage};
use ndarray::{Array3, Array4};
use ndarray_npy::read_npy;

fn golden_dir() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p.push("tools/golden");
    p
}
fn g3(name: &str) -> Array3<f64> {
    read_npy(golden_dir().join(format!("{name}.npy"))).unwrap()
}

/// flatten an [i,j,k] array into NIfTI order (i fastest)
fn flat3(a: &Array3<f64>) -> Vec<f32> {
    let (nx, ny, nz) = a.dim();
    let mut v = vec![0f32; nx * ny * nz];
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                v[i + nx * (j + ny * k)] = a[[i, j, k]] as f32;
            }
        }
    }
    v
}

const MP_AFF: [f32; 16] = [2.0, 0.0, 0.0, -24.0, 0.0, 2.0, 0.0, -20.0, 0.0, 0.0, 2.0, -16.0, 0.0, 0.0, 0.0, 1.0];
const SA_AFF: [f32; 16] = [5.0, 0.0, 0.0, -22.0, 0.0, 5.0, 0.0, -18.0, 0.0, 0.0, 5.0, -15.0, 0.0, 0.0, 0.0, 1.0];
const MP: [f64; 9] = [4.3, 0.840, 2.370, 5.0, 6.0, 64.0, 128.0, 0.007, 0.96];
const SA: [f64; 9] = [2.4, 0.150, 1.500, 6.0, 6.0, 24.0, 24.0, 0.005, 1.5];

fn assert_ifast(name: &str, got: &[f32], want: &Array3<f64>, rtol: f64, atol: f64) {
    let (nx, ny, nz) = want.dim();
    let mut worst = 0.0f64;
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                let g = got[i + nx * (j + ny * k)] as f64;
                let w = want[[i, j, k]];
                let d = (g - w).abs();
                assert!(d <= atol + rtol * w.abs(), "{name}[{i},{j},{k}]: {g} vs {w}");
                worst = worst.max(d);
            }
        }
    }
    eprintln!("  {name:18} OK (worst |diff|={worst:.3e})");
}

#[test]
fn wasm_api_sa2rage_matches_golden() {
    let uni = g3("v_uni");
    let inv2 = g3("v_inv2");
    let sa4: Array4<f64> = read_npy(golden_dir().join("v_sa2rage.npy")).unwrap();
    let (sx, sy, sz, _) = sa4.dim();
    let plane = sx * sy * sz;
    let mut sa_flat = vec![0f32; plane * 2];
    for t in 0..2 {
        for k in 0..sz {
            for j in 0..sy {
                for i in 0..sx {
                    sa_flat[t * plane + i + sx * (j + sy * k)] = sa4[[i, j, k, t]] as f32;
                }
            }
        }
    }
    let (nx, ny, nz) = uni.dim();
    let res = t1map_sa2rage(
        &flat3(&uni),
        &flat3(&inv2),
        &sa_flat,
        &[nx as u32, ny as u32, nz as u32],
        &MP_AFF,
        &[sx as u32, sy as u32, sz as u32],
        &SA_AFF,
        &MP,
        &SA,
        false, // fallback_uncorrected off → golden parity
    );
    assert_ifast("SA t1", &res.t1(), &g3("v_corr_T1_ms"), 1e-6, 1e-4);
    assert_ifast("SA uni_corr", &res.uni_corr(), &g3("v_corr_UNI"), 0.0, 0.0);
}

#[test]
fn wasm_api_b1map_matches_golden() {
    let uni = g3("v_uni");
    let inv2 = g3("v_inv2");
    let b1 = g3("v_b1map_tfl");
    let (nx, ny, nz) = uni.dim();
    let (bx, by, bz) = b1.dim();
    let res = t1map_b1(
        &flat3(&uni),
        &flat3(&inv2),
        &flat3(&b1),
        &[nx as u32, ny as u32, nz as u32],
        &MP_AFF,
        &[bx as u32, by as u32, bz as u32],
        &SA_AFF,
        0, // tfl
        80.0,
        &MP,
        false, // extend_fov off → golden parity
        false, // fallback_uncorrected off → golden parity
    );
    assert_ifast("B1 t1", &res.t1(), &g3("v_b1map_corr_T1_ms"), 1e-6, 1e-4);
}
