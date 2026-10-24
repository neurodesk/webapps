// SPDX-License-Identifier: Apache-2.0
use dwi_sdc::{Grid, PhaseEncoding, approximate, displacement_to_field};
use serde_json::Value;
use std::path::Path;
fn array(path: &Path, name: &str) -> Vec<f32> {
    std::fs::read(path.join(format!("{name}.bin")))
        .unwrap()
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect()
}
fn grid(metadata: &Value, name: &str) -> Grid {
    let shape = std::array::from_fn(|i| metadata[name]["shape"][i].as_u64().unwrap() as usize);
    let affine = std::array::from_fn(|i| {
        std::array::from_fn(|j| metadata[name]["affine"][i][j].as_f64().unwrap())
    });
    Grid::new(shape, affine).unwrap()
}
fn difference(actual: &[f32], expected: &[f32], mask: Option<&[f32]>) -> (f32, f32) {
    assert_eq!(actual.len(), expected.len());
    let mut errors: Vec<_> = actual
        .iter()
        .zip(expected)
        .enumerate()
        .filter(|(i, _)| mask.is_none_or(|m| m[*i] > 0.0))
        .map(|(_, (&a, &b))| (a - b).abs())
        .collect();
    assert!(errors.iter().all(|v| v.is_finite()));
    errors.sort_by(f32::total_cmp);
    {
        let middle = errors.len() / 2;
        let median = if errors.len() % 2 == 0 {
            (errors[middle - 1] + errors[middle]) * 0.5
        } else {
            errors[middle]
        };
        (median, *errors.last().unwrap())
    }
}
#[test]
fn pinned_displacement_and_bspline_fit_meet_unchanged_native_gates() {
    let Some(directory) = std::env::var_os("SDC_FIELD_FIT_REFERENCE") else {
        assert!(
            std::env::var_os("SDC_REQUIRE_REFERENCE").is_none(),
            "SDC_REQUIRE_REFERENCE needs SDC_FIELD_FIT_REFERENCE, staged by validation/prepare-reference.mjs"
        );
        eprintln!("reference test skipped: set SDC_FIELD_FIT_REFERENCE");
        return;
    };
    let path = Path::new(&directory);
    let metadata: Value =
        serde_json::from_slice(&std::fs::read(path.join("metadata.json")).unwrap()).unwrap();
    let image = grid(&metadata, "image");
    let pe = PhaseEncoding::try_from(metadata["pe"].as_str().unwrap()).unwrap();
    let converted = displacement_to_field(
        &array(path, "displacement"),
        &image,
        metadata["readout"].as_f64().unwrap(),
        pe,
    )
    .unwrap();
    let error = difference(&converted, &array(path, "extracted"), None);
    eprintln!("displacement: median={}Hz max={}Hz", error.0, error.1);
    assert!(error.0 <= 1e-4);
    let input_grid = grid(&metadata, "input");
    let fit = approximate(&array(path, "input"), &input_grid).unwrap();
    assert_eq!(fit.grid.shape(), grid(&metadata, "coefficients").shape());
    let coefficients = difference(&fit.coefficients, &array(path, "coefficients"), None);
    let field = difference(
        &fit.field,
        &array(path, "field"),
        Some(&array(path, "mask")),
    );
    eprintln!(
        "fit iterations={}; coefficients median={}Hz max={}Hz; in-brain field median={}Hz max={}Hz",
        fit.iterations, coefficients.0, coefficients.1, field.0, field.1
    );
    assert!(
        coefficients.0 <= 1e-4,
        "coefficient median {}Hz",
        coefficients.0
    );
    assert!(field.0 <= 1e-4, "field median {}Hz", field.0);
}

#[test]
fn staged_coefficients_evaluate_on_small_crops_without_a_full_fit() {
    let Some(directory) = std::env::var_os("SDC_FIELD_FIT_REFERENCE") else {
        return;
    };
    let path = Path::new(&directory);
    let metadata: Value =
        serde_json::from_slice(&std::fs::read(path.join("metadata.json")).unwrap()).unwrap();
    let image = grid(&metadata, "input");
    let control = grid(&metadata, "coefficients");
    let coefficients = array(path, "coefficients");
    let field = array(path, "field");
    for origin in [[0, 0, 0], [40, 50, 30], [108, 108, 61]] {
        let mut affine = image.affine();
        for row in &mut affine[..3] {
            row[3] += (0..3).map(|j| row[j] * origin[j] as f64).sum::<f64>();
        }
        let crop = Grid::new([8, 8, 8], affine).unwrap();
        let result = dwi_sdc::evaluate(&coefficients, &control, &crop).unwrap();
        let mut expected = Vec::new();
        for z in 0..8 {
            for y in 0..8 {
                for x in 0..8 {
                    let p = [origin[0] + x, origin[1] + y, origin[2] + z];
                    expected
                        .push(field[p[0] + image.shape()[0] * (p[1] + image.shape()[1] * p[2])]);
                }
            }
        }
        let error = difference(&result, &expected, None);
        eprintln!(
            "crop{origin:?}: evaluation median={} max={}",
            error.0, error.1
        );
        assert!(error.1 <= 1e-4);
    }
}
