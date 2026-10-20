//! The ITK `.mat` reader and writer against files that antsRegistration wrote
//! (`tests/fixtures/make_fixtures.py`) and nitransforms' reading of them (`expected.json`).

use dwi_hmc::{ItkAffine, MatError, Matrix4, Precision};
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
const CASES: [(&str, Precision); 2] = [
    ("ants-double.mat", Precision::Double),
    ("ants-float.mat", Precision::Float),
];

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURES}/{name}")).unwrap()
}

fn expected(name: &str) -> Value {
    let text = std::fs::read_to_string(format!("{FIXTURES}/expected.json")).unwrap();
    let all: Value = serde_json::from_str(&text).unwrap();
    all[name].clone()
}

fn numbers(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

fn matrix(v: &Value) -> Matrix4 {
    let rows: Vec<Vec<f64>> = v.as_array().unwrap().iter().map(numbers).collect();
    std::array::from_fn(|i| std::array::from_fn(|j| rows[i][j]))
}

fn max_difference(a: &Matrix4, b: &Matrix4) -> f64 {
    let mut worst: f64 = 0.0;
    for i in 0..4 {
        for j in 0..4 {
            worst = worst.max((a[i][j] - b[i][j]).abs());
        }
    }
    worst
}

#[test]
fn native_files_round_trip_byte_for_byte() {
    for (name, precision) in CASES {
        let bytes = fixture(name);
        let xfm = ItkAffine::from_mat(&bytes).unwrap();
        assert_eq!(xfm.precision, precision, "{name}");
        assert_eq!(xfm.to_mat(), bytes, "{name}");
    }
}

#[test]
fn both_precisions_read_the_values_nitransforms_reads() {
    for (name, _) in CASES {
        let xfm = ItkAffine::from_mat(&fixture(name)).unwrap();
        let want = expected(name);
        let precision_name = match xfm.precision {
            Precision::Double => "AffineTransform_double_3_3",
            Precision::Float => "AffineTransform_float_3_3",
        };
        assert_eq!(want["name"], precision_name, "{name}");
        // Float values widen to f64 exactly, so both precisions compare exactly.
        assert_eq!(
            xfm.parameters.to_vec(),
            numbers(&want["parameters"]),
            "{name}"
        );
        assert_eq!(xfm.fixed.to_vec(), numbers(&want["fixed"]), "{name}");
    }
}

#[test]
fn lps_and_ras_matrices_equal_nitransforms() {
    for (name, _) in CASES {
        let xfm = ItkAffine::from_mat(&fixture(name)).unwrap();
        let want = expected(name);
        let lps = max_difference(&xfm.lps(), &matrix(&want["lps"]));
        let ras = max_difference(&xfm.ras(), &matrix(&want["ras"]));
        assert!(lps <= 1e-12, "{name}: LPS differs by {lps:e}");
        assert!(ras <= 1e-12, "{name}: RAS differs by {ras:e}");
    }
}

/// nitransforms 25.1.0 keeps the centre as float32, so its own `to_ras()` of a double file
/// equals ours only once the centre is rounded to f32 (it differs by about 2e-9 otherwise).
#[test]
fn nitransforms_to_ras_rounds_the_centre_to_f32() {
    for (name, precision) in CASES {
        let mut xfm = ItkAffine::from_mat(&fixture(name)).unwrap();
        let want = matrix(&expected(name)["nitransforms_ras"]);
        let exact = max_difference(&xfm.ras(), &want);
        match precision {
            Precision::Float => assert!(exact <= 1e-12, "{name}: {exact:e}"),
            Precision::Double => assert!(exact > 1e-10, "{name}: {exact:e}"),
        }
        xfm.fixed = xfm.fixed.map(|v| v as f32 as f64);
        let rounded = max_difference(&xfm.ras(), &want);
        assert!(rounded <= 1e-12, "{name}: {rounded:e}");
    }
}

#[test]
fn writing_from_matrix_and_centre_reproduces_the_file() {
    for (name, precision) in CASES {
        let bytes = fixture(name);
        let xfm = ItkAffine::from_mat(&bytes).unwrap();
        let from_lps = ItkAffine::from_lps(&xfm.lps(), xfm.fixed, precision);
        assert_eq!(from_lps.to_mat(), bytes, "{name} from LPS");
        let ras_centre = [-xfm.fixed[0], -xfm.fixed[1], xfm.fixed[2]];
        let from_ras = ItkAffine::from_ras(&xfm.ras(), ras_centre, precision);
        assert_eq!(from_ras.to_mat(), bytes, "{name} from RAS");
    }
}

#[test]
fn identity_about_any_centre_has_zero_translation() {
    let mut eye = [[0.0; 4]; 4];
    for (i, row) in eye.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    let xfm = ItkAffine::from_lps(&eye, [3.5, -2.25, 40.0], Precision::Double);
    assert_eq!(&xfm.parameters[9..], &[0.0, 0.0, 0.0]);
    assert_eq!(xfm.lps(), eye);
}

#[test]
fn big_endian_files_read() {
    let little = fixture("ants-double.mat");
    let mut big = Vec::new();
    // Swap each header field and value; the names stay as they are.
    let mut at = 0;
    while at < little.len() {
        let field =
            |i: usize| i32::from_le_bytes(little[at + 4 * i..at + 4 * i + 4].try_into().unwrap());
        let (kind, rows, namlen) = (field(0), field(1) as usize, field(4) as usize);
        for i in 0..5 {
            let v = if i == 0 { kind + 1000 } else { field(i) };
            big.extend_from_slice(&v.to_be_bytes());
        }
        at += 20;
        big.extend_from_slice(&little[at..at + namlen]);
        at += namlen;
        for chunk in little[at..at + 8 * rows].chunks_exact(8) {
            big.extend(chunk.iter().rev());
        }
        at += 8 * rows;
    }
    assert_eq!(
        ItkAffine::from_mat(&big).unwrap(),
        ItkAffine::from_mat(&little).unwrap()
    );
}

#[test]
fn malformed_files_are_refused() {
    let bytes = fixture("ants-float.mat");
    assert_eq!(
        ItkAffine::from_mat(&bytes[..bytes.len() - 1]),
        Err(MatError::Truncated)
    );
    let mut huge = bytes.clone();
    huge[4..8].copy_from_slice(&i32::MAX.to_le_bytes());
    assert!(matches!(
        ItkAffine::from_mat(&huge),
        Err(MatError::Truncated)
    ));
    let mut trailing = bytes.clone();
    trailing.extend_from_slice(&bytes);
    assert_eq!(
        ItkAffine::from_mat(&trailing),
        Err(MatError::TrailingData(bytes.len()))
    );
    let mut renamed = bytes.clone();
    renamed[20..26].copy_from_slice(b"Euler3");
    assert!(matches!(
        ItkAffine::from_mat(&renamed),
        Err(MatError::UnsupportedTransform(_))
    ));
    let mut mixed = fixture("ants-double.mat");
    // Relabel the fixed block as single; its 24 bytes then hold 6 floats, not 3.
    let fixed_at = 20 + 27 + 96;
    mixed[fixed_at] = 10;
    assert!(ItkAffine::from_mat(&mixed).is_err());
}

/// Set HMC_WRITE_DIR to write files from known matrices, for
/// `make_fixtures.py --check` to read with ANTs and nitransforms.
#[test]
fn write_files_for_external_check() {
    let Ok(dir) = std::env::var("HMC_WRITE_DIR") else {
        return;
    };
    let m = [
        [0.99, -0.05, 0.02, 1.25],
        [0.04, 1.01, -0.03, -3.5],
        [-0.02, 0.03, 0.98, 2.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    for precision in [Precision::Double, Precision::Float] {
        let xfm = ItkAffine::from_ras(&m, [10.0, -20.0, 5.0], precision);
        xfm.write(format!("{dir}/written-{precision:?}.mat"))
            .unwrap();
        println!("{precision:?} LPS {:?}", xfm.lps());
        println!("{precision:?} RAS {:?}", xfm.ras());
    }
}
