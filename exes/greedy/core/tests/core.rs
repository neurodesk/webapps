use greedy_rs_core::{
    AffineMetric, Grid, Interpolation, Mat4, NiftiImage, ScalarType, Transform, VectorField,
    affine_matrix, affine_parameters, decode_image, decode_vector_field, downsample_grid,
    encode_image, encode_vector_field, gaussian_smooth, grids_match, image_centers,
    nmi_score_gradient_affine, register_affine, register_nmi_svf, reslice, reslice_with_background,
    reslice_with_interpolation, score_affine, ssd_score_gradient,
};

fn grid(dims: [usize; 3]) -> Grid {
    Grid {
        dims,
        lps_from_voxel: Mat4::IDENTITY,
    }
}

#[test]
fn nifti_scalar_and_vector_round_trip() {
    let image = NiftiImage {
        grid: grid([2, 2, 2]),
        data: (0..8).map(|x| x as f32).collect(),
        scalar_type: ScalarType::I16,
    };
    let decoded = decode_image(&encode_image(&image, cfg!(feature = "gzip")).unwrap()).unwrap();
    assert_eq!(decoded.data, image.data);
    assert_eq!(decoded.scalar_type, ScalarType::I16);
    assert!(grids_match(&decoded.grid, &image.grid, 0.0));

    // MATLAB commonly writes a spatially 3-D image as dim[0]=4, dim[4]=1.
    let mut singleton_4d = encode_image(&image, false).unwrap();
    singleton_4d[40..42].copy_from_slice(&4_i16.to_le_bytes());
    assert_eq!(decode_image(&singleton_4d).unwrap().data, image.data);
    singleton_4d[48..50].copy_from_slice(&2_i16.to_le_bytes());
    assert!(decode_image(&singleton_4d).is_err());

    let field = VectorField {
        grid: grid([2, 2, 2]),
        data: vec![[1.0, -2.0, 3.0]; 8],
    };
    assert_eq!(
        decode_vector_field(&encode_vector_field(&field, false).unwrap())
            .unwrap()
            .data,
        field.data
    );

    let quantized = VectorField {
        grid: grid([1, 1, 1]),
        data: vec![[0.14, -0.16, 0.04]],
    };
    assert_eq!(
        decode_vector_field(&encode_vector_field(&quantized, false).unwrap())
            .unwrap()
            .data,
        vec![[0.1, -0.2, 0.0]]
    );

    let physical_grid = Grid {
        dims: [1, 1, 1],
        lps_from_voxel: Mat4([
            [2.0, 0.0, 0.0, 10.0],
            [0.0, -3.0, 0.0, 20.0],
            [0.0, 0.0, 4.0, 30.0],
            [0.0, 0.0, 0.0, 1.0],
        ]),
    };
    let physical = VectorField {
        grid: physical_grid,
        data: vec![[0.31, -0.61, 0.19]],
    };
    assert_eq!(
        decode_vector_field(&encode_vector_field(&physical, false).unwrap())
            .unwrap()
            .data,
        vec![[0.4, -0.6, 0.0]]
    );
}

#[test]
fn nifti_rejects_values_and_dimensions_it_cannot_represent() {
    let non_finite = NiftiImage {
        grid: grid([1, 1, 1]),
        data: vec![f32::NAN],
        scalar_type: ScalarType::F32,
    };
    assert!(encode_image(&non_finite, false).is_err());

    let oversized = NiftiImage {
        grid: grid([32_768, 1, 1]),
        data: vec![0.0; 32_768],
        scalar_type: ScalarType::F32,
    };
    assert!(encode_image(&oversized, false).is_err());
}

#[test]
fn matrix_reader_rejects_a_non_affine_final_row() {
    assert!(greedy_rs_core::read_matrix("1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 1").is_err());
}

#[test]
fn nifti_form_precedence_follows_itk() {
    let image = NiftiImage {
        grid: Grid {
            dims: [1, 1, 1],
            lps_from_voxel: Mat4([
                [1.0, 0.0, 0.0, 1.0],
                [0.0, 1.0, 0.0, 2.0],
                [0.0, 0.0, 1.0, 3.0],
                [0.0, 0.0, 0.0, 1.0],
            ]),
        },
        data: vec![0.0],
        scalar_type: ScalarType::F32,
    };
    // Scanner-anatomical sform plus a qform with a different offset: ITK
    // takes the orthonormal sform, so the LPS origin stays (1, 2, 3).
    let mut raw = encode_image(&image, false).unwrap();
    raw[252..254].copy_from_slice(&1_i16.to_le_bytes());
    raw[268..272].copy_from_slice(&10.0_f32.to_le_bytes());
    let decoded = decode_image(&raw).unwrap();
    assert_eq!(decoded.grid.lps_from_voxel.0[0][3], 1.0);
    // A sheared sform is rejected and the qform (offset 10, 0, 0) wins.
    raw[284..288].copy_from_slice(&0.3_f32.to_le_bytes());
    let decoded = decode_image(&raw).unwrap();
    assert_eq!(decoded.grid.lps_from_voxel.0[0][3], -10.0);
    assert_eq!(decoded.grid.lps_from_voxel.0[0][1], 0.0);
}

#[test]
fn nifti_rejects_invalid_spatial_geometry() {
    let image = NiftiImage {
        grid: grid([1, 1, 1]),
        data: vec![0.0],
        scalar_type: ScalarType::F32,
    };
    let mut raw = encode_image(&image, false).unwrap();
    raw[80..84].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(decode_image(&raw).is_err());

    let mut raw = encode_image(&image, false).unwrap();
    raw[292..296].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(decode_image(&raw).is_err());
}

#[test]
fn identity_reslice_preserves_values_and_strict_grid_check() {
    let moving = NiftiImage {
        grid: grid([2, 2, 2]),
        data: (0..8).map(|x| x as f32).collect(),
        scalar_type: ScalarType::F32,
    };
    let output = reslice(
        &moving.grid,
        &moving,
        &[Transform::Affine(Mat4::IDENTITY)],
        Some(&moving.grid),
    )
    .unwrap();
    assert_eq!(output.data, moving.data);
    assert!(
        reslice(
            &moving.grid,
            &moving,
            &[Transform::Affine(Mat4::IDENTITY)],
            Some(&grid([3, 2, 2]))
        )
        .is_err()
    );
}

#[test]
fn nearest_reslice_preserves_discrete_values() {
    let moving = NiftiImage {
        grid: grid([2, 1, 1]),
        data: vec![0.0, 10.0],
        scalar_type: ScalarType::U8,
    };
    let mut fixed = moving.grid.clone();
    fixed.lps_from_voxel.0[0][3] = 0.4;
    let chain = [Transform::Affine(Mat4::IDENTITY)];
    let linear = reslice(&fixed, &moving, &chain, None).unwrap();
    let nearest =
        reslice_with_interpolation(&fixed, &moving, &chain, None, Interpolation::Nearest).unwrap();
    assert_eq!(linear.data, vec![4.0, 6.0]);
    assert_eq!(nearest.data, vec![0.0, 10.0]);
}

#[test]
fn reslice_uses_requested_background_outside_the_source_field_of_view() {
    let moving = NiftiImage {
        grid: grid([2, 1, 1]),
        data: vec![10.0, 20.0],
        scalar_type: ScalarType::I16,
    };
    let mut fixed = moving.grid.clone();
    fixed.lps_from_voxel.0[0][3] = -0.5;
    let chain = [Transform::Affine(Mat4::IDENTITY)];
    let linear = reslice_with_background(
        &fixed,
        &moving,
        &chain,
        None,
        Interpolation::Linear,
        -1000.0,
    )
    .unwrap();
    let nearest = reslice_with_background(
        &fixed,
        &moving,
        &chain,
        None,
        Interpolation::Nearest,
        -1000.0,
    )
    .unwrap();
    assert_eq!(linear.data, vec![-495.0, 15.0]);
    assert_eq!(nearest.data, vec![-1000.0, 20.0]);
}

#[test]
fn affine_scores_identity_and_image_center_initialization() {
    let image = NiftiImage {
        grid: grid([2, 2, 2]),
        data: (0..8).map(|x| x as f32).collect(),
        scalar_type: ScalarType::F32,
    };
    assert_eq!(
        score_affine(&image, &image, Mat4::IDENTITY, AffineMetric::Ssd).unwrap(),
        0.0
    );

    let mut moved_grid = grid([2, 2, 2]);
    moved_grid.lps_from_voxel.0[0][3] = 10.0;
    let init = image_centers(&image.grid, &moved_grid);
    assert_eq!(init.0[0][3], -10.0);
}

#[test]
fn affine_ssd_derivative_matches_a_centered_difference() {
    let fixed = NiftiImage {
        grid: grid([4, 4, 4]),
        data: vec![0.0; 64],
        scalar_type: ScalarType::F32,
    };
    let moving = NiftiImage {
        grid: grid([4, 4, 4]),
        data: (0..64).map(|index| (index % 4) as f32).collect(),
        scalar_type: ScalarType::F32,
    };
    let mut matrix = Mat4::IDENTITY;
    matrix.0[0][3] = 0.25;
    let (_, gradient) = ssd_score_gradient(&fixed, &moving, matrix).unwrap();
    // The sampler stores its result in f32, so use a step above its local ULP.
    let step = 1e-3;
    let mut plus = matrix;
    plus.0[0][3] += step;
    let mut minus = matrix;
    minus.0[0][3] -= step;
    let numeric = (score_affine(&fixed, &moving, plus, AffineMetric::Ssd).unwrap()
        - score_affine(&fixed, &moving, minus, AffineMetric::Ssd).unwrap())
        / (2.0 * step);
    assert!(
        (gradient[0] - numeric).abs() < 1e-3,
        "{} != {numeric}",
        gradient[0]
    );
}

#[test]
fn affine_nmi_derivative_matches_a_centered_difference() {
    let fixed = NiftiImage {
        grid: grid([6, 6, 6]),
        data: (0..216)
            .map(|index| {
                let x = (index % 6) as f32;
                let y = ((index / 6) % 6) as f32;
                let z = (index / 36) as f32;
                x * 20.0 + y * 3.0 + z
            })
            .collect(),
        scalar_type: ScalarType::F32,
    };
    let mut moving = fixed.clone();
    moving.data.rotate_left(6);
    // A rotated moving grid exercises the full voxel-to-RAS gradient map.
    let (c, s) = (0.96_f64, 0.28_f64);
    moving.grid.lps_from_voxel = Mat4([
        [c, -s, 0.0, 0.2],
        [s, c, 0.0, -0.1],
        [0.0, 0.0, 1.0, 0.3],
        [0.0, 0.0, 0.0, 1.0],
    ]);
    let mut matrix = Mat4::IDENTITY;
    matrix.0[0][3] = 0.35;
    let (_, gradient) = nmi_score_gradient_affine(&fixed, &moving, matrix).unwrap();
    let step = 1e-3;
    for index in 0..12 {
        let mut parameters = affine_parameters(matrix);
        parameters[index] += step;
        let plus = score_affine(
            &fixed,
            &moving,
            affine_matrix(parameters),
            AffineMetric::Nmi,
        );
        parameters[index] -= 2.0 * step;
        let minus = score_affine(
            &fixed,
            &moving,
            affine_matrix(parameters),
            AffineMetric::Nmi,
        );
        let numeric = (plus.unwrap() - minus.unwrap()) / (2.0 * step);
        // The binned trilinear samples are f32, so the external finite
        // difference is intentionally looser than the f64 histogram-chain
        // derivative.
        assert!(
            (gradient[index] - numeric).abs() < 5e-2,
            "{index}: {} != {numeric}",
            gradient[index]
        );
    }
}

#[test]
fn affine_nmi_empty_overlap_is_a_nan_trial_not_an_error() {
    let image = NiftiImage {
        grid: grid([4, 4, 4]),
        data: (0..64).map(|index| index as f32).collect(),
        scalar_type: ScalarType::F32,
    };
    let mut outside = Mat4::IDENTITY;
    outside.0[0][3] = 100.0;
    assert!(
        score_affine(&image, &image, outside, AffineMetric::Nmi)
            .unwrap()
            .is_nan()
    );
    let (score, gradient) = nmi_score_gradient_affine(&image, &image, outside).unwrap();
    assert!(score.is_nan());
    assert!(gradient.iter().all(|value| value.is_nan()));
}

#[test]
fn affine_ssd_search_reduces_a_shifted_image_cost() {
    let fixed = NiftiImage {
        grid: grid([16, 16, 16]),
        data: (0..4096)
            .map(|index| {
                let x = (index % 16) as f32;
                let y = ((index / 16) % 16) as f32;
                (-0.1 * ((x - 7.0).powi(2) + (y - 8.0).powi(2))).exp()
            })
            .collect(),
        scalar_type: ScalarType::F32,
    };
    let mut moving = fixed.clone();
    for z in 0..16 {
        for y in 0..16 {
            for x in 0..16 {
                let target = x + 16 * (y + 16 * z);
                let source = (x + 2).min(15) + 16 * (y + 16 * z);
                moving.data[target] = fixed.data[source];
            }
        }
    }
    let initial = score_affine(&fixed, &moving, Mat4::IDENTITY, AffineMetric::Ssd).unwrap();
    // VNL checks its maximum after the trial evaluation, so one requested
    // evaluation still takes the first L-BFGS/More--Thuente step.
    let transform = register_affine(
        fixed.clone(),
        moving.clone(),
        AffineMetric::Ssd,
        [0, 0, 1],
        false,
    )
    .unwrap();
    let final_score = score_affine(&fixed, &moving, transform, AffineMetric::Ssd).unwrap();
    assert!(
        final_score < initial,
        "{final_score} is not below {initial}"
    );
}

#[test]
fn downsample_grid_preserves_voxel_bounding_box() {
    let source = grid([4, 4, 4]);
    let coarse = downsample_grid(&source, 4);
    assert_eq!(coarse.dims, [1, 1, 1]);
    assert_eq!(coarse.lps_from_voxel.0[0][0], 4.0);
    assert_eq!(coarse.lps_from_voxel.0[0][3], 1.5);
    assert_eq!(
        source.voxel_to_lps([-0.5, 0.0, 0.0])[0],
        coarse.voxel_to_lps([-0.5, 0.0, 0.0])[0]
    );
}

#[test]
fn downsample_grid_reduces_factors_on_short_axes() {
    let source = grid([3, 8, 1]);
    let coarse = downsample_grid(&source, 4);
    assert_eq!(coarse.dims, [2, 2, 1]);
    assert_eq!(coarse.lps_from_voxel.0[0][0], 1.5);
    assert_eq!(coarse.lps_from_voxel.0[1][1], 4.0);
    assert_eq!(coarse.lps_from_voxel.0[2][2], 1.0);
}

#[test]
fn nmi_svf_zero_iterations_returns_an_identity_warp() {
    let image = NiftiImage {
        grid: grid([4, 4, 4]),
        data: (0..64).map(|index| index as f32).collect(),
        scalar_type: ScalarType::F32,
    };
    let warp = register_nmi_svf(image.clone(), image.clone(), [0, 0, 0], false, |_, _| {}).unwrap();
    assert_eq!(warp.grid.dims, image.grid.dims);
    assert_eq!(warp.data, vec![[0.0; 3]; 64]);
}

#[test]
fn nmi_svf_runs_one_coarse_update() {
    let image = NiftiImage {
        grid: grid([16, 16, 16]),
        data: (0..4096)
            .map(|index| ((index % 16) + 16 * ((index / 256) % 16)) as f32)
            .collect(),
        scalar_type: ScalarType::F32,
    };
    let mut moving = image.clone();
    for z in 0..16 {
        for y in 0..16 {
            for x in 0..16 {
                let target = x + 16 * (y + 16 * z);
                let source = (x + 1).min(15) + 16 * (y + 16 * z);
                moving.data[target] = image.data[source];
            }
        }
    }
    let warp = register_nmi_svf(image, moving, [1, 0, 0], false, |_, _| {}).unwrap();
    assert!(warp.data.iter().flatten().all(|value| value.is_finite()));
}

#[test]
fn gaussian_smoothing_preserves_a_constant_interior() {
    let image = NiftiImage {
        grid: grid([9, 9, 9]),
        data: vec![3.0; 729],
        scalar_type: ScalarType::F32,
    };
    let smoothed = gaussian_smooth(&image, [1.0, 1.0, 1.0]).unwrap();
    let center = 4 + 9 * (4 + 9 * 4);
    assert!(
        (smoothed.data[center] - 3.0).abs() < 1e-6,
        "{}",
        smoothed.data[center]
    );
}

#[test]
fn nifti_spatial_units_normalize_spacing_and_origin_to_millimetres() {
    for (unit, factor) in [(1_u8, 1000.0_f32), (2, 1.0), (3, 0.001)] {
        let mut image = NiftiImage {
            grid: grid([2, 2, 2]),
            data: vec![7.0; 8],
            scalar_type: ScalarType::I16,
        };
        image.grid.lps_from_voxel.0[0][3] = 12.0;
        let mut bytes = encode_image(&image, false).unwrap();
        bytes[123] = unit | 8;
        for axis in 0..3 {
            bytes[80 + axis * 4..84 + axis * 4].copy_from_slice(&(1.0 / factor).to_le_bytes());
            for column in 0..4 {
                let offset = 280 + (axis * 4 + column) * 4;
                let value =
                    f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) / factor;
                bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            }
        }
        let decoded = decode_image(&bytes).unwrap();
        for row in 0..4 {
            for column in 0..4 {
                assert!(
                    (decoded.grid.lps_from_voxel.0[row][column]
                        - image.grid.lps_from_voxel.0[row][column])
                        .abs()
                        < 1e-5,
                    "unit {unit}, row {row}, column {column}"
                );
            }
        }
    }
}

#[test]
fn scaled_integer_identity_reslice_preserves_physical_intensity() {
    for scalar_type in [
        ScalarType::U8,
        ScalarType::I8,
        ScalarType::I16,
        ScalarType::U16,
        ScalarType::I32,
        ScalarType::U32,
        ScalarType::I64,
        ScalarType::U64,
    ] {
        let image = NiftiImage {
            grid: grid([2, 2, 2]),
            data: vec![7.0; 8],
            scalar_type,
        };
        let mut bytes = encode_image(&image, false).unwrap();
        bytes[112..116].copy_from_slice(&0.1_f32.to_le_bytes());
        bytes[116..120].copy_from_slice(&0.05_f32.to_le_bytes());
        let decoded = decode_image(&bytes).unwrap();
        let resliced = reslice_with_interpolation(
            &decoded.grid,
            &decoded,
            &[Transform::Affine(Mat4::IDENTITY)],
            None,
            Interpolation::Nearest,
        )
        .unwrap();
        let output = decode_image(&encode_image(&resliced, false).unwrap()).unwrap();
        assert_eq!(output.scalar_type, ScalarType::F32);
        assert!(output.data.iter().all(|value| (*value - 0.75).abs() < 1e-6));
    }
}
