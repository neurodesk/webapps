//! The Rust de-shearing against packages/syncro/src/pipeline.js's own outputs (tests/fixtures/deshear.json, from
//! scripts/freeze-deshear.mjs): grids, trilinear voxels and nearest-neighbour masks, bit for bit.

use serde_json::Value;
use syncro_core::geometry::{Grid, orthogonal_grid, resample_linear, resample_nearest};
use syncro_core::volume::Volume;

fn affine(v: &Value) -> [[f64; 4]; 3] {
    let rows: Vec<Vec<f64>> = serde_json::from_value(v.clone()).unwrap();
    [0, 1, 2].map(|r| [0, 1, 2, 3].map(|c| rows[r][c]))
}

#[test]
fn matches_the_javascript_reference() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/deshear.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dims: [usize; 3] = serde_json::from_value(case["dims"].clone()).unwrap();
        let a = affine(&case["affine"]);
        let grid = orthogonal_grid(dims, &a);
        if let Some(error) = case.get("error") {
            assert_eq!(grid.unwrap_err(), error.as_str().unwrap(), "{name}");
            continue;
        }
        let grid = grid.unwrap();
        if case["grid"].is_null() {
            assert!(grid.is_none(), "{name}: no shear, no grid");
            continue;
        }
        let grid = grid.unwrap();
        let expected = Grid {
            dims: serde_json::from_value(case["grid"]["dims"].clone()).unwrap(),
            affine: affine(&case["grid"]["affine"]),
        };
        assert_eq!(grid.dims, expected.dims, "{name}");
        for r in 0..3 {
            for c in 0..4 {
                assert!(
                    (grid.affine[r][c] - expected.affine[r][c]).abs() <= 1e-12,
                    "{name} affine {r},{c}"
                );
            }
        }
        let data: Vec<f32> = serde_json::from_value(case["data"].clone()).unwrap();
        let fill = case["fill"].as_f64().unwrap() as f32;
        let linear = resample_linear(
            &Volume {
                data,
                dims,
                affine: a,
            },
            &grid,
            fill,
        )
        .unwrap();
        let want: Vec<f32> = serde_json::from_value(case["linear"].clone()).unwrap();
        assert_eq!(linear.data.len(), want.len(), "{name}");
        for (i, (got, want)) in linear.data.iter().zip(&want).enumerate() {
            assert_eq!(
                got.to_bits(),
                want.to_bits(),
                "{name} voxel {i}: {got} vs {want}"
            );
        }
        let mask: Vec<u8> = serde_json::from_value(case["mask"].clone()).unwrap();
        let nearest = resample_nearest(
            &Volume {
                data: mask,
                dims,
                affine: a,
            },
            &grid,
        )
        .unwrap();
        let want: Vec<u8> = serde_json::from_value(case["nearest"].clone()).unwrap();
        assert_eq!(nearest.data, want, "{name} nearest");
    }
}
