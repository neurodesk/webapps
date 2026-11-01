use std::{env, fs, process::Command};

use greedy_rs_core::{
    Grid, Mat4, NiftiImage, NiftiSeries, ScalarType, decode_image, decode_series,
    decode_vector_field, encode_image, encode_series,
};

fn image() -> NiftiImage {
    NiftiImage {
        grid: Grid {
            dims: [4, 4, 4],
            lps_from_voxel: Mat4::IDENTITY,
        },
        data: (0..64).map(|value| value as f32).collect(),
        scalar_type: ScalarType::F32,
    }
}

fn run(arguments: &[&str]) {
    assert!(
        Command::new(env!("CARGO_BIN_EXE_greedy-rs"))
            .args(arguments)
            .status()
            .unwrap()
            .success(),
        "greedy-rs failed: {arguments:?}"
    );
}

#[test]
fn help_and_version_are_available() {
    for arguments in [&[][..], &["-h"][..], &["--help"][..]] {
        let output = Command::new(env!("CARGO_BIN_EXE_greedy-rs"))
            .args(arguments)
            .output()
            .unwrap();
        assert!(output.status.success());
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("Usage:"));
        assert!(help.contains("Paul Yushkevich"));
        assert!(help.contains("https://sites.google.com/view/greedyreg/about"));
        assert!(help.contains("https://github.com/pyushkevich/greedy"));
    }

    let output = Command::new(env!("CARGO_BIN_EXE_greedy-rs"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("greedy-rs {}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn affine_svf_and_reslice_workflow() {
    let directory = env::temp_dir().join(format!("greedy-rs-cli-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir(&directory).unwrap();
    let fixed = directory.join("fixed.nii.gz");
    let moving = directory.join("moving.nii.gz");
    let matrix = directory.join("aff.mat");
    let warp = directory.join("warp.nii.gz");
    let output = directory.join("resliced.nii.gz");
    let bytes = encode_image(&image(), true).unwrap();
    fs::write(&fixed, &bytes).unwrap();
    fs::write(&moving, bytes).unwrap();

    run(&[
        "-V",
        "0",
        "-d",
        "3",
        "-a",
        "-jitter",
        "0",
        "-m",
        "NMI",
        "-i",
        fixed.to_str().unwrap(),
        moving.to_str().unwrap(),
        "-o",
        matrix.to_str().unwrap(),
        "-ia-image-centers",
        "-n",
        "0x0x0",
    ]);
    assert_eq!(fs::read_to_string(&matrix).unwrap().lines().count(), 4);

    run(&[
        "-V",
        "0",
        "-d",
        "3",
        "-m",
        "NMI",
        "-i",
        fixed.to_str().unwrap(),
        moving.to_str().unwrap(),
        "-it",
        matrix.to_str().unwrap(),
        "-o",
        warp.to_str().unwrap(),
        "-sv",
        "-n",
        "0x0x0",
    ]);
    assert!(
        decode_vector_field(&fs::read(&warp).unwrap())
            .unwrap()
            .data
            .iter()
            .all(|v| *v == [0.0; 3])
    );

    run(&[
        "-V",
        "0",
        "-d",
        "3",
        "-rf",
        fixed.to_str().unwrap(),
        "-rm",
        moving.to_str().unwrap(),
        output.to_str().unwrap(),
        "--verify-aligned",
        moving.to_str().unwrap(),
        "-ri",
        "NN",
        "-r",
        warp.to_str().unwrap(),
        matrix.to_str().unwrap(),
    ]);
    assert_eq!(
        decode_image(&fs::read(&output).unwrap()).unwrap().grid.dims,
        [4, 4, 4]
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn auto_background_uses_the_source_minimum_below_zero() {
    let directory =
        env::temp_dir().join(format!("greedy-rs-background-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir(&directory).unwrap();
    let mut fixed_image = image();
    fixed_image.grid.lps_from_voxel.0[0][3] = -1.0;
    let mut moving_image = image();
    moving_image.data[0] = -1000.0;
    let fixed = directory.join("fixed.nii.gz");
    let moving = directory.join("moving.nii.gz");
    let matrix = directory.join("identity.mat");
    let output = directory.join("resliced.nii.gz");
    fs::write(&fixed, encode_image(&fixed_image, true).unwrap()).unwrap();
    fs::write(&moving, encode_image(&moving_image, true).unwrap()).unwrap();
    fs::write(&matrix, "1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n").unwrap();

    run(&[
        "-d",
        "3",
        "-rf",
        fixed.to_str().unwrap(),
        "-rm",
        moving.to_str().unwrap(),
        output.to_str().unwrap(),
        "-rb",
        "auto",
        "-r",
        matrix.to_str().unwrap(),
    ]);
    assert_eq!(
        decode_image(&fs::read(&output).unwrap()).unwrap().data[0],
        -1000.0
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn rigid_registration_and_four_dimensional_reslice_work() {
    let directory = env::temp_dir().join(format!("greedy-rs-4d-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir(&directory).unwrap();
    let fixed = directory.join("fixed.nii.gz");
    let moving = directory.join("moving.nii.gz");
    let matrix = directory.join("rigid.mat");
    let output = directory.join("resliced.nii.gz");
    let source = image();
    let mut values = source.data.clone();
    values.extend(source.data.iter().map(|value| value + 100.0));
    let series = NiftiSeries {
        grid: source.grid.clone(),
        data: values.clone(),
        scalar_type: ScalarType::F32,
        timepoints: 2,
        time_spacing: 3.0,
        time_units: 8,
    };
    let mut target = source.clone();
    target.grid.dims = [3, 3, 3];
    target.data.truncate(27);
    fs::write(&fixed, encode_image(&target, true).unwrap()).unwrap();
    fs::write(&moving, encode_series(&series, true).unwrap()).unwrap();
    run(&[
        "-V",
        "0",
        "-d",
        "3",
        "-a",
        "-jitter",
        "0",
        "-dof",
        "6",
        "-m",
        "NMI",
        "-i",
        fixed.to_str().unwrap(),
        fixed.to_str().unwrap(),
        "-o",
        matrix.to_str().unwrap(),
        "-ia-image-centers",
        "-n",
        "0x0x0",
    ]);
    run(&[
        "-d",
        "3",
        "-rf",
        fixed.to_str().unwrap(),
        "-rm",
        moving.to_str().unwrap(),
        output.to_str().unwrap(),
        "-r",
        matrix.to_str().unwrap(),
    ]);
    let decoded = decode_series(&fs::read(&output).unwrap()).unwrap();
    let mut expected = Vec::new();
    for offset in [0.0, 100.0] {
        for z in 0..3 {
            for y in 0..3 {
                for x in 0..3 {
                    expected.push(source.data[x + 4 * (y + 4 * z)] + offset);
                }
            }
        }
    }
    assert_eq!(decoded.grid.dims, [3, 3, 3]);
    assert_eq!(decoded.data, expected);
    assert_eq!(decoded.timepoints, 2);
    assert_eq!(decoded.time_spacing, 3.0);
    assert_eq!(decoded.time_units, 8);
    fs::remove_dir_all(directory).unwrap();
}

/// Without `-ia-image-centers` the affine starts from Greedy's physical identity;
/// `-ia FILE` starts from that matrix, and `-dof 6` from its rotation.
#[test]
fn affine_start_follows_the_initialization_flag() {
    let directory = env::temp_dir().join(format!("greedy-rs-cli-start-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir(&directory).unwrap();
    let fixed = directory.join("fixed.nii.gz");
    let moving = directory.join("moving.nii.gz");
    fs::write(&fixed, encode_image(&image(), true).unwrap()).unwrap();
    let mut shifted = image();
    shifted.grid.lps_from_voxel.0[2][3] = 5.0;
    fs::write(&moving, encode_image(&shifted, true).unwrap()).unwrap();
    let initial = directory.join("initial.mat");
    let rotation = "0 -1 0 2\n1 0 0 -3\n0 0 1 4\n0 0 0 1\n";
    fs::write(&initial, rotation).unwrap();
    // The same rotation after anisotropic scaling: a rigid start keeps only the
    // rotation of its polar decomposition, as Greedy's does.
    let affine = directory.join("affine.mat");
    fs::write(&affine, "0 -3 0 2\n2 0 0 -3\n0 0 1.5 4\n0 0 0 1\n").unwrap();
    let starts = [
        vec![],
        vec!["-ia-image-centers"],
        vec!["-ia-identity"],
        vec!["-ia", initial.to_str().unwrap()],
        vec!["-ia", affine.to_str().unwrap(), "-dof", "6"],
    ];
    let mut results = Vec::new();
    for (index, flags) in starts.iter().enumerate() {
        let matrix = directory.join(format!("{index}.mat"));
        let mut arguments = vec![
            "-V",
            "0",
            "-d",
            "3",
            "-a",
            "-m",
            "NMI",
            "-i",
            fixed.to_str().unwrap(),
            moving.to_str().unwrap(),
            "-o",
            matrix.to_str().unwrap(),
            "-n",
            "0x0x0",
        ];
        arguments.extend(flags);
        run(&arguments);
        results.push(greedy_rs_core::read_matrix(&fs::read_to_string(&matrix).unwrap()).unwrap());
    }
    assert_eq!(results[0], Mat4::IDENTITY);
    assert_eq!(results[1].0[2][3], 5.0);
    assert_eq!(results[1].0[0][3], 0.0);
    assert_eq!(results[2], Mat4::IDENTITY);
    let rotation = greedy_rs_core::read_matrix(rotation).unwrap();
    assert_eq!(results[3], rotation);
    for (row, expected) in results[4].0.iter().zip(rotation.0) {
        for (value, expected) in row.iter().zip(expected) {
            assert!((value - expected).abs() < 1e-12, "{:?}", results[4]);
        }
    }
    fs::remove_dir_all(directory).unwrap();
}

/// Regression gate for #623 on the whole-head T1 to ICBM 2009c pair: the
/// masked NMI affine collapsed (determinant 4 to 240) while Greedy gives
/// 0.73, and the unmasked one 0.62. Runs only when `GREEDY_T1_TEMPLATE_DIR`
/// holds the three decompressed files named in `tests/reference/README.md`.
#[test]
#[ignore = "requires GREEDY_T1_TEMPLATE_DIR to hold the issue #623 pair"]
fn masked_nmi_affine_on_a_whole_head_pair_matches_greedy() {
    let data = env::var("GREEDY_T1_TEMPLATE_DIR")
        .expect("GREEDY_T1_TEMPLATE_DIR must hold the issue #623 pair");
    let output = env::temp_dir().join(format!("greedy-rs-nmi-623-{}.mat", std::process::id()));
    for (mask, bounds) in [(true, 0.65..0.80), (false, 0.55..0.70)] {
        let mut arguments = vec![
            "-V",
            "0",
            "-d",
            "3",
            "-a",
            "-m",
            "NMI",
            "-i",
            &format!("{data}/mni_icbm152_t1_tal_nlin_sym_09c.nii"),
            &format!("{data}/sub-HML0541_ses-01_rec-defaced_T1w.nii"),
            "-o",
            output.to_str().unwrap(),
            "-n",
            "100x50x10",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        let mask_path = format!("{data}/mni_icbm152_t1_tal_nlin_sym_09c_mask.nii");
        if mask {
            arguments.extend(["-gm".to_string(), mask_path]);
        }
        run(&arguments.iter().map(String::as_str).collect::<Vec<_>>());
        let m = greedy_rs_core::read_matrix(&fs::read_to_string(&output).unwrap())
            .unwrap()
            .0;
        let determinant = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        assert!(
            bounds.contains(&determinant),
            "mask {mask}: determinant {determinant} outside {bounds:?}"
        );
    }
    fs::remove_file(output).unwrap();
}

/// On these two ds007522 T1s the masked NMI affine collapses from the identity
/// start (determinants 29.8 and 2.24; Greedy 1.4 collapses too), while starting
/// it from the unmasked affine with `-ia` converges (#623): determinants 0.72
/// and 0.64. The corners of a box around the template brain land 3.0 and 9.7 mm
/// on average from where the unmasked affine puts them (534 and 63 mm from the
/// identity start; 5.5 to 7.0 mm on three subjects where both starts converge).
#[test]
#[ignore = "requires GREEDY_T1_TEMPLATE_DIR to hold the whole-head T1s"]
fn masked_nmi_affine_from_the_unmasked_one_on_whole_head_t1s() {
    let data = env::var("GREEDY_T1_TEMPLATE_DIR")
        .expect("GREEDY_T1_TEMPLATE_DIR must hold the whole-head T1s");
    let template = format!("{data}/mni_icbm152_t1_tal_nlin_sym_09c.nii");
    let mask = format!("{data}/mni_icbm152_t1_tal_nlin_sym_09c_mask.nii");
    let directory = env::temp_dir().join(format!("greedy-rs-staged-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir(&directory).unwrap();
    for (subject, bounds) in [("0689", 0.65..0.80), ("0962", 0.58..0.72)] {
        let t1 = format!("{data}/sub-HML{subject}_ses-01_rec-defaced_T1w.nii");
        let unmasked = directory.join(format!("{subject}-unmasked.mat"));
        let masked = directory.join(format!("{subject}-masked.mat"));
        let common = ["-V", "0", "-d", "3", "-a", "-m", "NMI", "-n", "100x50x10"];
        let mut arguments = common.to_vec();
        arguments.extend(["-i", &template, &t1, "-o", unmasked.to_str().unwrap()]);
        run(&arguments);
        let mut arguments = common.to_vec();
        arguments.extend(["-i", &template, &t1, "-gm", &mask]);
        arguments.extend([
            "-ia",
            unmasked.to_str().unwrap(),
            "-o",
            masked.to_str().unwrap(),
        ]);
        run(&arguments);
        let read = |path: &std::path::Path| {
            greedy_rs_core::read_matrix(&fs::read_to_string(path).unwrap()).unwrap()
        };
        let (unmasked, masked) = (read(&unmasked), read(&masked));
        let m = masked.0;
        let determinant = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        assert!(
            bounds.contains(&determinant),
            "sub-HML{subject}: determinant {determinant} outside {bounds:?}"
        );
        let mut total = 0.0;
        for x in [-70.0, 70.0] {
            for y in [-100.0, 70.0] {
                for z in [-60.0, 80.0] {
                    let (a, b) = (masked.apply([x, y, z]), unmasked.apply([x, y, z]));
                    total += (0..3).map(|i| (a[i] - b[i]).powi(2)).sum::<f64>().sqrt();
                }
            }
        }
        assert!(
            total / 8.0 < 15.0,
            "sub-HML{subject}: box corners {} mm from the unmasked affine",
            total / 8.0
        );
    }
    fs::remove_dir_all(directory).unwrap();
}

/// Regression gate against Greedy 1.3 (double, `-threads 1 -jitter 0`) on the
/// 2 mm benchmark pair. Runs only when `GREEDY_BENCH_DIR` points at
/// allineate-benchmark; the bar is Greedy's own float-versus-double spread.
#[test]
#[ignore = "requires GREEDY_BENCH_DIR to point at allineate-benchmark"]
fn nmi_affine_2mm_matches_greedy_within_float_double_spread() {
    let bench =
        env::var("GREEDY_BENCH_DIR").expect("GREEDY_BENCH_DIR must point at allineate-benchmark");
    let output = env::temp_dir().join(format!("greedy-rs-nmi-2mm-{}.mat", std::process::id()));
    run(&[
        "-V",
        "0",
        "-d",
        "3",
        "-a",
        "-jitter",
        "0",
        "-m",
        "NMI",
        "-i",
        &format!("{bench}/MNI152_T1_2mm.nii.gz"),
        &format!("{bench}/T1_head_2mm.nii.gz"),
        "-o",
        output.to_str().unwrap(),
        "-ia-image-centers",
        "-n",
        "100x50x10",
    ]);
    let ours = greedy_rs_core::read_matrix(&fs::read_to_string(&output).unwrap()).unwrap();
    let reference =
        greedy_rs_core::read_matrix(include_str!("../../tests/reference/nmi_aff_2mm_double.mat"))
            .unwrap();
    let float =
        greedy_rs_core::read_matrix(include_str!("../../tests/reference/nmi_aff_2mm_float.mat"))
            .unwrap();
    let difference = |candidate: Mat4| {
        let mut linear = 0.0_f64;
        let mut translation = 0.0_f64;
        for r in 0..3 {
            translation += (candidate.0[r][3] - reference.0[r][3]).powi(2);
            for c in 0..3 {
                linear = linear.max((candidate.0[r][c] - reference.0[r][c]).abs());
            }
        }
        (linear, translation.sqrt())
    };
    let (linear, translation) = difference(ours);
    let (float_linear, float_translation) = difference(float);
    assert!(
        linear <= float_linear,
        "linear part differs by {linear}, above float's {float_linear}"
    );
    assert!(
        translation <= float_translation,
        "translation differs by {translation} mm, above float's {float_translation} mm"
    );
    fs::remove_file(output).unwrap();
}
