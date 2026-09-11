use std::{env, fs, process::Command};

use greedy_rs_core::{
    Grid, Mat4, NiftiImage, ScalarType, decode_image, decode_vector_field, encode_image,
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
