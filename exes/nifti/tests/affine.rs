use neurodesk_nifti::affine::{inverse3, ras_axes};

#[test]
fn singularity_cutoff_is_strict_and_uses_magnitude() {
    let cutoff = 1e-12f64;
    let below = f64::from_bits(cutoff.to_bits() - 1);
    let above = f64::from_bits(cutoff.to_bits() + 1);
    for scale in [0., below, -below, cutoff, -cutoff, above, -above] {
        let affine = [[1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., scale, 0.]];
        if scale.abs() < cutoff {
            assert_eq!(
                inverse3(&affine).unwrap_err(),
                "The image affine is singular."
            );
            assert_eq!(
                ras_axes(&affine).unwrap_err(),
                "The image affine is singular."
            );
        } else {
            assert_eq!(
                inverse3(&affine).unwrap()[2][2].to_bits(),
                (1. / scale).to_bits()
            );
            assert_eq!(ras_axes(&affine).unwrap(), [0, 1, 2]);
        }
    }
}

#[test]
fn translation_does_not_change_spatial_inverse_or_axes() {
    let affine = [[0., 0., -2., 0.], [1., 0., 0., 0.], [0., 1.5, 0., 0.]];
    let mut translated = affine;
    for (r, shift) in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY]
        .into_iter()
        .enumerate()
    {
        translated[r][3] = shift;
    }
    let bits = |a| inverse3(&a).unwrap().map(|r| r.map(f64::to_bits));
    assert_eq!(bits(translated), bits(affine));
    assert_eq!(ras_axes(&translated).unwrap(), [2, 0, 1]);
}

#[test]
fn ties_keep_the_first_row_and_repair_the_last_duplicate() {
    let tied = [[1., -1., 0., 0.], [1., 1., 0., 0.], [0., 0., 1., 0.]];
    let collision = [[1., 1., 1., 0.], [0., 0.25, 0., 0.], [0., 0., 0.5, 0.]];
    assert_eq!(ras_axes(&tied).unwrap(), [0, 1, 2]);
    assert_eq!(ras_axes(&collision).unwrap(), [0, 2, 1]);
}

#[test]
fn nonfinite_linear_values_retain_direct_helper_behavior() {
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let affine = [[value, 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 1., 0.]];
        let inverse = inverse3(&affine).unwrap();
        if value.is_nan() {
            assert!(inverse.iter().flatten().all(|v| v.is_nan()));
            assert_eq!(ras_axes(&affine).unwrap(), [2, 1, 0]);
        } else {
            assert_eq!(inverse[0][0], 0.);
            assert!(inverse[1][1].is_nan());
            assert!(inverse[2][2].is_nan());
            assert_eq!(ras_axes(&affine).unwrap(), [0, 2, 1]);
        }
    }
}
