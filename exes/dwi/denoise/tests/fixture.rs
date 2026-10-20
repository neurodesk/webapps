//! Compares the port with spec.py, the float64 reference that equals DIPY 1.12.1 Patch2Self
//! version 1 (OLS, patch radius 0) to < 5e-15 of the signal range on these cases.

use dwi_denoise::{
    accumulate_gram, apply, coefficients_len, denoise, gram_len, solve, split_groups,
};
use serde_json::Value;

struct Case {
    name: String,
    nvox: usize,
    bvals: Vec<f64>,
    input: Vec<f64>,
    expected: Vec<f64>,
}

fn numbers(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

fn cases() -> Vec<Case> {
    let text = include_str!("data/fixture.json");
    let fixture: Value = serde_json::from_str(text).unwrap();
    fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let dims = numbers(&c["dims"]);
            Case {
                name: c["name"].as_str().unwrap().to_string(),
                nvox: (dims[0] * dims[1] * dims[2]) as usize,
                bvals: numbers(&c["bvals"]),
                input: numbers(&c["input"]),
                expected: numbers(&c["expected"]),
            }
        })
        .collect()
}

fn range(v: &[f64]) -> f64 {
    let max = v.iter().copied().fold(f64::MIN, f64::max);
    let min = v.iter().copied().fold(f64::MAX, f64::min);
    max - min
}

fn max_abs_diff(a: &[f64], b: &[f64]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f64::max)
}

#[test]
fn f64_storage_matches_the_reference_to_1e9_of_the_range() {
    for case in cases() {
        let mut data = case.input.clone();
        denoise(&mut data, case.nvox, &case.bvals).unwrap();
        let rel = max_abs_diff(&data, &case.expected) / range(&case.expected);
        eprintln!("{}: max diff / range {rel:.2e}", case.name);
        assert!(rel <= 1e-9, "{}: {rel:e}", case.name);
    }
}

/// With f32 storage the math is still f64; only the final store rounds. Each output must be
/// within one f32 ulp of the reference rounded to f32 (a value near a rounding boundary can
/// round either way).
#[test]
fn f32_storage_is_within_one_ulp_of_the_reference() {
    for case in cases() {
        let mut data: Vec<f32> = case.input.iter().map(|&v| v as f32).collect();
        assert!(
            data.iter()
                .zip(&case.input)
                .all(|(&a, &b)| f64::from(a) == b),
            "the fixture input is exact in f32"
        );
        denoise(&mut data, case.nvox, &case.bvals).unwrap();
        for (i, (&got, &want)) in data.iter().zip(&case.expected).enumerate() {
            let want = want as f32;
            let ulp = f32::from_bits(want.abs().to_bits() + 1) - want.abs();
            assert!(
                (got - want).abs() <= ulp,
                "{} index {i}: {got} vs {want}",
                case.name
            );
        }
    }
}

#[test]
fn a_single_b0_is_copied_unchanged() {
    let case = cases().into_iter().find(|c| c.name == "one_b0").unwrap();
    let b0 = case.bvals.iter().position(|&b| b < 50.0).unwrap();
    let mut data = case.input.clone();
    denoise(&mut data, case.nvox, &case.bvals).unwrap();
    let slice = b0 * case.nvox..(b0 + 1) * case.nvox;
    assert_eq!(data[slice.clone()], case.input[slice]);
}

#[test]
fn group_rules() {
    let groups = split_groups(&[0.0, 49.9, 50.0, 1000.0]).unwrap();
    assert_eq!(groups.b0, vec![0, 1]);
    assert_eq!(groups.dwi, vec![2, 3]);

    let one = split_groups(&[0.0, 0.0, 1000.0]).unwrap_err();
    assert!(
        one.contains("at least 2 diffusion-weighted volumes") && one.contains("has 1"),
        "{one}"
    );
    let none = split_groups(&[0.0, 5.0]).unwrap_err();
    assert!(none.contains("has 0"), "{none}");
    assert!(split_groups(&[0.0, f64::NAN, 1000.0, 1000.0]).is_err());

    let mut data = vec![1.0f64; 4 * 3];
    let err = denoise(&mut data, 4, &[0.0, 1000.0, 0.0]).unwrap_err();
    assert!(err.contains("has 1"), "{err}");
    let err = denoise(&mut data, 5, &[0.0, 1000.0, 1000.0]).unwrap_err();
    assert!(err.contains("Expected 15 values"), "{err}");
}

#[test]
fn linearly_dependent_volumes_are_refused() {
    // Volumes 1 and 2 are identical, so predicting volume 3 from them has no unique solution.
    let nvox = 64;
    let mut data = Vec::new();
    for t in 0..4 {
        for v in 0..nvox {
            let x = v as f64;
            data.push(match t {
                0 => 100.0 + (x * 0.37).sin(),
                1 | 2 => 50.0 + (x * 1.3).cos() * 7.0 + x,
                _ => 20.0 + (x * 0.11).sin() * 3.0 + 0.5 * x,
            });
        }
    }
    let err = denoise(&mut data, nvox, &[0.0, 1000.0, 1000.0, 1000.0]).unwrap_err();
    assert!(
        err.starts_with("Volume 2 (counting from 0) is a linear combination"),
        "{err}"
    );
}

#[test]
fn a_constant_volume_gets_zero_weight() {
    // The centred variance of a constant volume is rounding noise in `S_ii - N m²`, and it can
    // be negative. scikit-learn centres explicitly and gives the volume zero weight; so must we,
    // at every image size, and the constant volume itself is predicted as its mean.
    for nvox in [1_000usize, 100_000, 1_000_000] {
        let volumes = 6;
        let mut data = vec![0.0f64; nvox * volumes];
        for t in 0..volumes {
            for v in 0..nvox {
                let x = v as f64;
                data[t * nvox + v] = if t == 3 {
                    1234.567
                } else {
                    300.0 + 40.0 * (x * (0.013 + 0.007 * t as f64)).sin() + 9.0 * (x * 0.29).cos()
                };
            }
        }
        let bvals = [1000.0; 6];
        denoise(&mut data, nvox, &bvals).unwrap();
        for v in 0..nvox {
            assert!(
                (data[3 * nvox + v] - 1234.567).abs() < 1e-6,
                "nvox {nvox} voxel {v}"
            );
        }
        assert!(data.iter().all(|value| value.is_finite()));
    }
}

#[test]
fn values_that_are_not_finite_are_refused() {
    let case = cases().into_iter().next().unwrap();
    let mut data = case.input.clone();
    data[case.nvox + 3] = f64::NAN;
    let err = denoise(&mut data, case.nvox, &case.bvals).unwrap_err();
    assert!(err.contains("not finite"), "{err}");
}

#[test]
fn a_single_unchanged_b0_must_also_contain_only_finite_values() {
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut data = vec![
            invalid, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0,
        ];
        let err = denoise(&mut data, 4, &[0.0, 1000.0, 1000.0]).unwrap_err();
        assert!(err.contains("not finite"), "{err}");
    }
}

/// The Gram sums of separate voxel ranges add up to one pass, whether the ranges are views of
/// the whole array or independent volume-major buffers, and applying in chunks gives the same
/// output. The partial sums round in a different order, so the comparison has a tolerance.
#[test]
fn chunked_passes_equal_one_pass() {
    for case in cases() {
        let groups = split_groups(&case.bvals).unwrap();
        let nvol = case.bvals.len();
        let mut whole = case.input.clone();
        let mut chunked = case.input.clone();
        for group in groups.fitted() {
            let n = group.len();
            let mut one = vec![0.0; gram_len(n)];
            accumulate_gram(&case.input, case.nvox, 0..case.nvox, group, &mut one);

            // Uneven ranges of the whole array.
            let cuts = [0, 7, case.nvox / 3, case.nvox / 2 + 3, case.nvox];
            let mut sum = vec![0.0; gram_len(n)];
            for w in cuts.windows(2) {
                let mut part = vec![0.0; gram_len(n)];
                accumulate_gram(&case.input, case.nvox, w[0]..w[1], group, &mut part);
                for (s, p) in sum.iter_mut().zip(&part) {
                    *s += p;
                }
            }
            // Independent buffers: each holds its voxels of every volume.
            let mut sum2 = vec![0.0; gram_len(n)];
            for w in cuts.windows(2) {
                let len = w[1] - w[0];
                let mut chunk = Vec::with_capacity(len * nvol);
                for t in 0..nvol {
                    chunk
                        .extend_from_slice(&case.input[t * case.nvox + w[0]..t * case.nvox + w[1]]);
                }
                let mut part = vec![0.0; gram_len(n)];
                accumulate_gram(&chunk, len, 0..len, group, &mut part);
                for (s, p) in sum2.iter_mut().zip(&part) {
                    *s += p;
                }
            }
            for (i, &g) in one.iter().enumerate() {
                let tol = 1e-12 * g.abs().max(1.0);
                assert!((sum[i] - g).abs() <= tol, "{} gram {i}", case.name);
                assert!((sum2[i] - g).abs() <= tol, "{} gram {i}", case.name);
            }

            let c_one = solve(&one, n).unwrap();
            let c_sum = solve(&sum, n).unwrap();
            assert_eq!(c_one.len(), coefficients_len(n));
            apply(&mut whole, case.nvox, 0..case.nvox, group, &c_one);
            for w in cuts.windows(2) {
                apply(&mut chunked, case.nvox, w[0]..w[1], group, &c_sum);
            }
        }
        let rel = max_abs_diff(&whole, &chunked) / range(&case.expected);
        assert!(rel <= 1e-9, "{}: {rel:e}", case.name);
        let rel = max_abs_diff(&whole, &case.expected) / range(&case.expected);
        assert!(rel <= 1e-9, "{}: {rel:e}", case.name);
    }
}
