// SPDX-License-Identifier: Apache-2.0
use dwi_sdc::{
    Grid, PhaseEncoding, approximate, control_grid, displacement_to_field, evaluate,
    field_to_displacement,
};
use serde_json::Value;

fn grid(sign: f64) -> Grid {
    Grid::new(
        [2, 1, 1],
        [
            [2.0 * sign, 0.0, 0.0, 12.0],
            [0.0, 3.0, 0.0, -8.0],
            [0.0, 0.0, 4.0, 5.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
    )
    .unwrap()
}
#[test]
fn all_six_phase_directions_respect_lps_and_affine_flips() {
    for sign in [-1.0, 1.0] {
        let image = grid(sign);
        for (name, axis, polarity) in [
            ("i", 0, 1.0),
            ("i-", 0, -1.0),
            ("j", 1, 1.0),
            ("j-", 1, -1.0),
            ("k", 2, 1.0),
            ("k-", 2, -1.0),
        ] {
            let pe = PhaseEncoding::try_from(name).unwrap();
            let vector = field_to_displacement(&[10.0, -20.0], &image, 0.1, pe).unwrap();
            let mut expected = vec![0.0; 6];
            let scale = match axis {
                0 => -2.0 * sign as f32,
                1 => -3.0,
                _ => 4.0,
            };
            expected[axis] = scale * polarity;
            expected[3 + axis] = -2.0 * scale * polarity;
            assert_eq!(vector, expected, "{name}, affine sign {sign}");
            assert_eq!(
                displacement_to_field(&vector, &image, 0.1, pe).unwrap(),
                [10.0, -20.0]
            );
        }
    }
}
#[test]
fn conversion_accounts_for_oblique_axis_mixing() {
    let image = Grid::new(
        [1, 1, 1],
        [
            [0.0, -3.0, 0.0, 7.0],
            [2.0, 0.0, 0.0, 9.0],
            [0.0, 0.0, 4.0, 1.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
    )
    .unwrap();
    let pe = PhaseEncoding::try_from("i-").unwrap();
    assert_eq!(
        displacement_to_field(&[3.0, -4.0, 8.0], &image, 0.1, pe).unwrap(),
        [-20.0]
    );
    assert_eq!(
        field_to_displacement(&[-20.0], &image, 0.1, pe).unwrap(),
        [0.0, -4.0, 0.0]
    );
}
#[test]
fn invalid_geometry_encoding_readout_and_array_lengths_fail() {
    assert!(PhaseEncoding::try_from("x").is_err());
    assert!(Grid::new([0, 1, 1], grid(1.0).affine()).is_err());
    assert!(Grid::new([1, 1, 1], [[0.0; 4]; 4]).is_err());
    assert!(
        Grid::new(
            [1, 1, 1],
            [
                [1e-320, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0]
            ]
        )
        .is_err()
    );
    let pe = PhaseEncoding::try_from("j").unwrap();
    assert!(field_to_displacement(&[1.0, 2.0], &grid(1.0), 0.0, pe).is_err());
    assert!(field_to_displacement(&[1.0], &grid(1.0), 0.1, pe).is_err());
    assert!(field_to_displacement(&[f32::NAN, 0.0], &grid(1.0), 0.1, pe).is_err());
}
fn shape(value: &Value) -> [usize; 3] {
    std::array::from_fn(|i| value[i].as_u64().unwrap() as usize)
}
fn affine(value: &Value) -> [[f64; 4]; 4] {
    std::array::from_fn(|i| std::array::from_fn(|j| value[i][j].as_f64().unwrap()))
}
fn values(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap() as f32)
        .collect()
}
fn difference(actual: &[f32], expected: &[f32]) -> (f32, f32) {
    assert_eq!(actual.len(), expected.len());
    let mut diff: Vec<_> = actual
        .iter()
        .zip(expected)
        .map(|(a, b)| (a - b).abs())
        .collect();
    diff.sort_by(f32::total_cmp);
    {
        let middle = diff.len() / 2;
        let median = if diff.len() % 2 == 0 {
            (diff[middle - 1] + diff[middle]) * 0.5
        } else {
            diff[middle]
        };
        (median, *diff.last().unwrap())
    }
}
#[test]
fn constant_linear_and_known_bspline_fields_match_independent_sdcflows() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/synthetic.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let image = Grid::new(shape(&case["shape"]), affine(&case["affine"])).unwrap();
        let expected_grid =
            Grid::new(shape(&case["controlShape"]), affine(&case["controlAffine"])).unwrap();
        let control = control_grid(&image, [16.0, 16.0, 10.0]).unwrap();
        assert_eq!(control.shape(), expected_grid.shape());
        for (a, b) in control
            .affine()
            .iter()
            .flatten()
            .zip(expected_grid.affine().iter().flatten())
        {
            assert!((a - b).abs() < 1e-6);
        }
        let evaluation = evaluate(&values(&case["coefficients"]), &expected_grid, &image).unwrap();
        eprintln!(
            "{name}: independent coefficient evaluation {:?}",
            difference(&evaluation, &values(&case["field"]))
        );
        let fitted = approximate(&values(&case["input"]), &image).unwrap();
        let exact = difference(&fitted.coefficients, &values(&case["exactCoefficients"]));
        eprintln!(
            "{name}: CG versus exact ridge coefficient median={} max={}",
            exact.0, exact.1
        );
        let coeff = difference(&fitted.coefficients, &values(&case["coefficients"]));
        let field = difference(&fitted.field, &values(&case["field"]));
        eprintln!(
            "{name}: coefficients median={} max={}, field median={} max={}, iterations={}",
            coeff.0, coeff.1, field.0, field.1, fitted.iterations
        );
        assert!(coeff.0 <= 1e-4, "{name}: coefficient median {}", coeff.0);
        assert!(field.0 <= 1e-4, "{name}: field median {}", field.0);
        let evaluation = evaluate(&values(&case["coefficients"]), &expected_grid, &image).unwrap();
        assert!(difference(&evaluation, &values(&case["field"])).1 < 1e-5);
    }
}

#[test]
fn displacement_samples_need_not_have_the_epi_grid_shape() {
    let image = grid(1.0);
    let pe = PhaseEncoding::try_from("j").unwrap();
    assert_eq!(
        displacement_to_field(&[0.0, -3.0, 0.0], &image, 0.1, pe).unwrap(),
        [10.0]
    );
    assert!(displacement_to_field(&[0.0, 0.0], &image, 0.1, pe).is_err());
}

#[test]
fn evaluation_refuses_rotated_axes_instead_of_ignoring_cross_axis_coordinates() {
    let control = Grid::new(
        [6, 6, 6],
        [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
    )
    .unwrap();
    let image = Grid::new(
        [2, 2, 2],
        [
            [0.0, -1.0, 0.0, 2.0],
            [1.0, 0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0, 2.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
    )
    .unwrap();
    let coefficients: Vec<f32> = (0..216).map(|i| (i % 6) as f32).collect();
    assert!(
        evaluate(&coefficients, &control, &image)
            .unwrap_err()
            .0
            .contains("parallel")
    );
}

#[test]
fn conversion_refuses_unrepresentable_scales_and_overflowing_results() {
    let image = Grid::new(
        [1, 1, 1],
        [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
    )
    .unwrap();
    let pe = PhaseEncoding::try_from("i").unwrap();
    for readout in [1e-60, 1e60] {
        assert!(displacement_to_field(&[1.0, 0.0, 0.0], &image, readout, pe).is_err());
        assert!(field_to_displacement(&[1.0], &image, readout, pe).is_err());
    }
    assert!(field_to_displacement(&[f32::MAX], &image, 2.0, pe).is_err());
    assert!(displacement_to_field(&[f32::MAX, 0.0, 0.0], &image, 0.5, pe).is_err());
}

#[test]
fn wasm_fit_budget_checks_csr_buffers_without_allocating_voxels() {
    let affine = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let large = Grid::new([256, 256, 128], affine).unwrap();
    assert!(
        dwi_sdc::validate_wasm_fit(&large)
            .unwrap_err()
            .0
            .contains("CSR and buffers")
    );
    let reference = Grid::new([116, 116, 69], affine).unwrap();
    assert_eq!(dwi_sdc::validate_wasm_fit(&reference), Ok(()));
}
