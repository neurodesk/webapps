//! Motion decomposition and the motion TSV against QSIPrep 26.1.1's own `get_ras_motion_params`
//! run on synthetic transforms (`tests/fixtures/make_motion_fixtures.py`, `motion.json`).

use dwi_hmc::motion::{
    Columns, Grid, Motion, MotionError, decompose44, format_number, framewise_displacement,
    itk_ras_matrix, motion_tsv, nifreeze_rows, ras_motion, ras_motion_params, rotation_vector,
    world_centre_motion,
};
use dwi_hmc::{ItkAffine, Matrix4};
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
/// The issue's gate is 1e-6; the port agrees far more closely, so hold it there.
const TOL: f64 = 1e-11;

fn fixture() -> Value {
    let text = std::fs::read_to_string(format!("{FIXTURES}/motion.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn numbers(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

fn matrix4(v: &Value) -> Matrix4 {
    let rows: Vec<Vec<f64>> = v.as_array().unwrap().iter().map(numbers).collect();
    std::array::from_fn(|i| std::array::from_fn(|j| rows[i][j]))
}

fn grid(all: &Value, name: &str) -> Grid {
    let g = &all["grids"][name];
    let shape = numbers(&g["shape"]);
    Grid {
        shape: std::array::from_fn(|i| shape[i] as usize),
        affine: matrix4(&g["affine"]),
    }
}

fn transform(file: &str) -> ItkAffine {
    ItkAffine::read(format!("{FIXTURES}/{file}")).unwrap()
}

fn assert_close(label: &str, got: &[f64], want: &[f64], tol: f64) {
    assert_eq!(got.len(), want.len(), "{label}");
    for (k, (g, w)) in got.iter().zip(want).enumerate() {
        assert!(
            (g - w).abs() <= tol,
            "{label}[{k}]: {g} against {w} (difference {:e})",
            (g - w).abs()
        );
    }
}

fn from_array(v: &[f64]) -> Motion {
    Motion {
        scale: [v[0], v[1], v[2]],
        shear: [v[3], v[4], v[5]],
        rotation: [v[6], v[7], v[8]],
        translation: [v[9], v[10], v[11]],
    }
}

#[test]
fn matches_qsiprep_get_ras_motion_params() {
    let all = fixture();
    let cases = all["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 18);
    for case in cases {
        let file = case["file"].as_str().unwrap();
        let g = grid(&all, case["grid"].as_str().unwrap());
        let label = format!("{} on {}", file, case["grid"]);
        let got = ras_motion_params(&transform(file), &g).to_array();
        assert_close(&label, &got, &numbers(&case["qsiprep"]), TOL);
    }
}

#[test]
fn ras_matrix_matches_qsiprep() {
    let all = fixture();
    for case in all["cases"].as_array().unwrap() {
        let file = case["file"].as_str().unwrap();
        let got = itk_ras_matrix(&transform(file));
        let want = matrix4(&case["ras"]);
        assert_close(file, got.as_flattened(), want.as_flattened(), 1e-12);
        // The crate's own LPS-to-RAS conversion agrees with QSIPrep's composition.
        let ras = transform(file).ras();
        assert_close(file, ras.as_flattened(), want.as_flattened(), 1e-12);
    }
}

#[test]
fn nifreeze_ras_matrices_give_the_same_motion() {
    // NiFreeze hands over RAS matrices from reference to scan: the same decomposition applies.
    let all = fixture();
    for case in all["cases"].as_array().unwrap() {
        let g = grid(&all, case["grid"].as_str().unwrap());
        let got = ras_motion(&matrix4(&case["ras"]), &g).to_array();
        assert_close(
            case["file"].as_str().unwrap(),
            &got,
            &numbers(&case["qsiprep"]),
            TOL,
        );
    }
}

#[test]
fn world_centre_form() {
    let all = fixture();
    for case in all["cases"].as_array().unwrap() {
        let g = grid(&all, case["grid"].as_str().unwrap());
        let m = matrix4(&case["ras"]);
        let world = world_centre_motion(&m, &g);
        let label = case["file"].as_str().unwrap();
        assert_close(
            label,
            &world.translation,
            &numbers(&case["world_translation"]),
            1e-9,
        );
        // Only the pivot differs.
        let pivot = ras_motion(&m, &g);
        assert_eq!(world.rotation, pivot.rotation, "{label}");
        assert_eq!(world.scale, pivot.scale, "{label}");
    }
}

#[test]
fn pivot_is_grid_centre_minus_origin() {
    let all = fixture();
    let g = grid(&all, "oblique-las");
    let pivot = g.pivot();
    let world = g.world_centre();
    // The oblique grid's origin is far from its centre, as on ds005577 (about 190 mm there).
    let distance = (0..3)
        .map(|i| (world[i] - pivot[i]).powi(2))
        .sum::<f64>()
        .sqrt();
    let origin: f64 = (0..3).map(|i| g.affine[i][3].powi(2)).sum::<f64>().sqrt();
    assert!((distance - origin).abs() < 1e-9);
    assert!(origin > 150.0);
    // For a pure rotation θ about z, the two translations differ by |θ| × that distance at most.
    let theta: f64 = 0.02;
    let mut m: Matrix4 = [
        [0.0; 4],
        [0.0; 4],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    m[0][0] = theta.cos();
    m[0][1] = -theta.sin();
    m[1][0] = theta.sin();
    m[1][1] = theta.cos();
    let a = ras_motion(&m, &g).translation;
    let b = world_centre_motion(&m, &g).translation;
    let gap = (0..3).map(|i| (a[i] - b[i]).powi(2)).sum::<f64>().sqrt();
    assert!(gap <= theta * origin + 1e-9 && gap > 0.0);
}

#[test]
fn decompose44_round_trips() {
    let r = rotation_vector(&[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
    assert_eq!(r, [0.0, 0.0, 0.0]);
    // transforms3d's docstring example: T, R (90 degrees about z), Z, S.
    let a: Matrix4 = {
        let (z, s) = ([2.0, 3.0, 4.0], [0.2, 0.1, 0.3]);
        let rot = [[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]];
        let smat = [[1.0, s[0], s[1]], [0.0, 1.0, s[2]], [0.0, 0.0, 1.0]];
        let mut out = [[0.0; 4], [0.0; 4], [0.0; 4], [0.0, 0.0, 0.0, 1.0]];
        for i in 0..3 {
            for j in 0..3 {
                out[i][j] = (0..3).map(|k| rot[i][k] * z[k] * smat[k][j]).sum();
            }
        }
        out[0][3] = 20.0;
        out[1][3] = 30.0;
        out[2][3] = 40.0;
        out
    };
    let d = decompose44(&a);
    assert_close("T", &d.translation, &[20.0, 30.0, 40.0], 1e-12);
    assert_close("Z", &d.zooms, &[2.0, 3.0, 4.0], 1e-12);
    assert_close("S", &d.shears, &[0.2, 0.1, 0.3], 1e-12);
    assert_close(
        "R",
        d.rotation.as_flattened(),
        &[0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        1e-12,
    );
    let v = rotation_vector(&d.rotation);
    assert_close(
        "rotvec",
        &v,
        &[0.0, 0.0, std::f64::consts::FRAC_PI_2],
        1e-12,
    );
}

#[test]
fn framewise_displacement_matches_nipype() {
    let all = fixture();
    for (name, seq) in all["sequences"].as_object().unwrap() {
        let rows = sequence_rows(&all, seq);
        let got = framewise_displacement(&rows);
        let want = seq["framewise_displacement"].as_array().unwrap();
        assert_eq!(got.len(), want.len(), "{name}");
        assert_eq!(got[0], None);
        assert!(want[0].is_null());
        for (k, (g, w)) in got.iter().zip(want).enumerate().skip(1) {
            let (g, w) = (g.unwrap(), w.as_f64().unwrap());
            assert!((g - w).abs() <= 1e-12, "{name}[{k}]: {g} against {w}");
        }
    }
}

/// The sequence's rows from QSIPrep's own values, with b0 identity rows for the NiFreeze path.
fn sequence_rows(all: &Value, seq: &Value) -> Vec<Motion> {
    let g = seq["grid"].as_str().unwrap();
    let qsiprep = |file: &str| {
        let case = all["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["grid"] == g && c["file"] == file)
            .unwrap();
        from_array(&numbers(&case["qsiprep"]))
    };
    let weighted: Vec<Motion> = seq["dwi"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| qsiprep(f.as_str().unwrap()))
        .collect();
    match seq["bvals"].as_array() {
        Some(_) => nifreeze_rows(&numbers(&seq["bvals"]), &weighted).unwrap(),
        None => weighted,
    }
}

#[test]
fn tsv_matches_byte_for_byte() {
    let all = fixture();
    for (name, seq) in all["sequences"].as_object().unwrap() {
        let columns = match seq["columns"].as_str().unwrap() {
            "rigid" => Columns::Rigid,
            "affine" => Columns::Affine,
            other => panic!("{other}"),
        };
        let rows = sequence_rows(&all, seq);
        let got = motion_tsv(&rows, columns);
        assert_eq!(got, seq["tsv"].as_str().unwrap(), "{name}");
    }
}

#[test]
fn tsv_from_the_crate_decomposition() {
    // The whole path from .mat files: same rows to 1e-11, same shape of file.
    let all = fixture();
    let seq = &all["sequences"]["rigid"];
    let g = grid(&all, "oblique-las");
    let weighted: Vec<Motion> = seq["dwi"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| ras_motion_params(&transform(f.as_str().unwrap()), &g))
        .collect();
    let rows = nifreeze_rows(&numbers(&seq["bvals"]), &weighted).unwrap();
    let text = motion_tsv(&rows, Columns::Rigid);
    let want = seq["tsv"].as_str().unwrap();
    assert_eq!(text.lines().count(), want.lines().count());
    for (got, want) in text.lines().zip(want.lines()).skip(1) {
        let parse = |line: &str| -> Vec<f64> {
            line.split('\t')
                .map(|c| {
                    if c == "n/a" {
                        f64::NAN
                    } else {
                        c.parse().unwrap()
                    }
                })
                .collect()
        };
        let (g, w) = (parse(got), parse(want));
        for (a, b) in g.iter().zip(&w) {
            assert!(
                (a.is_nan() && b.is_nan()) || (a - b).abs() <= 1e-9,
                "{got}\n{want}"
            );
        }
    }
}

#[test]
fn b0_volumes_get_identity_rows() {
    let moved = Motion {
        translation: [1.0, 2.0, 3.0],
        ..Motion::IDENTITY
    };
    let rows = nifreeze_rows(&[0.0, 1000.0, 50.0, 50.5, 0.0], &[moved, moved]).unwrap();
    assert_eq!(
        rows,
        vec![
            Motion::IDENTITY,
            moved,
            Motion::IDENTITY,
            moved,
            Motion::IDENTITY
        ]
    );
    assert_eq!(
        nifreeze_rows(&[0.0, 1000.0], &[moved, moved]),
        Err(MotionError::VolumeCount {
            weighted: 1,
            transforms: 2
        })
    );
    let header = motion_tsv(&[], Columns::Rigid);
    assert_eq!(
        header,
        "trans_x\ttrans_y\ttrans_z\trot_x\trot_y\trot_z\tframewise_displacement\n"
    );
    let one = motion_tsv(&[Motion::IDENTITY], Columns::Affine);
    assert_eq!(
        one.lines().nth(1).unwrap(),
        "0.0\t0.0\t0.0\t0.0\t0.0\t0.0\tn/a\t1.0\t1.0\t1.0"
    );
}

#[test]
fn numbers_are_written_as_python_repr() {
    let cases = [
        (0.0, "0.0"),
        (-0.0, "-0.0"),
        (1.0, "1.0"),
        (0.1, "0.1"),
        (-1.2000000000000002, "-1.2000000000000002"),
        (1e-4, "0.0001"),
        (1.5e-5, "1.5e-05"),
        (-9.999999999999999e-05, "-9.999999999999999e-05"),
        (123456.0, "123456.0"),
        (1e15, "1000000000000000.0"),
        (1e16, "1e+16"),
        (2.5e300, "2.5e+300"),
        (5e-324, "5e-324"),
        (f64::NAN, "n/a"),
    ];
    for (v, want) in cases {
        assert_eq!(format_number(v), want, "{v:e}");
    }
}
