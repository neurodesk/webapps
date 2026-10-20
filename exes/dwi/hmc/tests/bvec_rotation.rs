//! B-vector rotation against files written by NiFreeze's and QSIPrep's own functions on
//! synthetic affines (`tests/fixtures/bvec/make_bvec_fixtures.py`). The comparisons with the
//! hmc reference runs (`nifreeze-gp`, `nifreeze-trivial-a1`, `qsiprep-r1`) wait for #438.

use dwi_hmc::{BvecRule, HmcGradients, ItkAffine, Matrix4, Precision, rotate_gradients};
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/bvec");

fn read(name: &str) -> String {
    std::fs::read_to_string(format!("{FIXTURES}/{name}")).unwrap()
}

fn numbers(text: &str) -> Vec<f64> {
    text.split_whitespace()
        .map(|t| t.parse().unwrap())
        .collect()
}

fn floats(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

struct Case {
    name: String,
    bvals: Vec<f64>,
    bvecs: Vec<[f64; 3]>,
    image_affine: Matrix4,
    transforms: Vec<ItkAffine>,
}

fn cases() -> Vec<Case> {
    let all: Value = serde_json::from_str(&read("cases.json")).unwrap();
    all["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let bvals = numbers(&read(c["bval"].as_str().unwrap()));
            let rows: Vec<Vec<f64>> = read(c["bvec"].as_str().unwrap())
                .lines()
                .map(numbers)
                .collect();
            assert_eq!(rows.len(), 3);
            let bvecs = (0..bvals.len())
                .map(|i| [rows[0][i], rows[1][i], rows[2][i]])
                .collect();
            let a: Vec<Vec<f64>> = c["image_affine"]
                .as_array()
                .unwrap()
                .iter()
                .map(floats)
                .collect();
            let transforms = c["transforms"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| ItkAffine {
                    precision: match t["precision"].as_str().unwrap() {
                        "float" => Precision::Float,
                        _ => Precision::Double,
                    },
                    parameters: floats(&t["parameters"]).try_into().unwrap(),
                    fixed: floats(&t["fixed"]).try_into().unwrap(),
                })
                .collect();
            Case {
                name: c["name"].as_str().unwrap().to_string(),
                bvals,
                bvecs,
                image_affine: std::array::from_fn(|i| std::array::from_fn(|j| a[i][j])),
                transforms,
            }
        })
        .collect()
}

/// The text with only the columns where `keep` holds, laid out as numpy.savetxt does.
fn columns(text: &str, keep: &[bool]) -> String {
    text.lines()
        .map(|line| {
            let tokens: Vec<&str> = line
                .split(' ')
                .zip(keep)
                .filter(|(_, k)| **k)
                .map(|(t, _)| t)
                .collect();
            assert_eq!(line.split(' ').count(), keep.len());
            tokens.join(" ") + "\n"
        })
        .collect()
}

fn check_b0_columns(case: &Case, g: &HmcGradients, decimals: usize) {
    let rows: Vec<Vec<String>> = g
        .bvec_text()
        .lines()
        .map(|l| l.split(' ').map(String::from).collect())
        .collect();
    for (i, _) in g.b0.iter().enumerate().filter(|(_, b0)| **b0) {
        for (axis, row) in rows.iter().enumerate() {
            assert_eq!(
                row[i],
                format!("{:.*}", decimals, case.bvecs[i][axis]),
                "{}: b0 column {i}",
                case.name
            );
        }
        assert_eq!(g.bvals[i], case.bvals[i]);
    }
}

#[test]
fn nifreeze_matches_upstream() {
    for case in cases() {
        let rule = BvecRule::NiFreeze {
            image_affine: case.image_affine,
        };
        let g = rotate_gradients(&rule, &case.bvals, &case.bvecs, &case.transforms).unwrap();
        assert_eq!(
            g.bvecs.len(),
            case.bvals.len(),
            "{}: every column",
            case.name
        );
        // NiFreeze's own files hold only the diffusion-weighted volumes.
        let dwi: Vec<bool> = g.b0.iter().map(|b0| !b0).collect();
        assert_eq!(
            columns(&g.bvec_text(), &dwi),
            read(&format!("{}.nifreeze.bvec", case.name)),
            "{}: bvec",
            case.name
        );
        assert_eq!(
            columns(&g.bval_text(), &dwi),
            read(&format!("{}.nifreeze.bval", case.name)),
            "{}: bval",
            case.name
        );
        check_b0_columns(&case, &g, 6);
    }
}

#[test]
fn shoreline_matches_upstream() {
    for case in cases() {
        let g = rotate_gradients(
            &BvecRule::ShoreLine,
            &case.bvals,
            &case.bvecs,
            &case.transforms,
        )
        .unwrap();
        let expected = read(&format!("{}.shoreline.bvec", case.name));
        let text = g.bvec_text();
        if text != expected {
            let ours: Vec<&str> = text.split_whitespace().collect();
            let theirs: Vec<&str> = expected.split_whitespace().collect();
            let bad: Vec<_> = ours
                .iter()
                .zip(&theirs)
                .enumerate()
                .filter(|(_, (a, b))| a != b)
                .collect();
            panic!(
                "{}: {} of {} values differ: {:?}",
                case.name,
                bad.len(),
                ours.len(),
                &bad[..bad.len().min(10)]
            );
        }
        // QSIPrep writes one b-value per line (savetxt of a 1-D array); the output is one row.
        let bval = g.bval_text();
        assert_eq!(bval.lines().count(), 1);
        assert_eq!(
            bval.split_whitespace().collect::<Vec<_>>(),
            read(&format!("{}.shoreline.bval", case.name))
                .split_whitespace()
                .collect::<Vec<_>>(),
            "{}: bval",
            case.name
        );
        check_b0_columns(&case, &g, 8);
    }
}

#[test]
fn rules_split_the_edge_table_differently() {
    let case = cases().into_iter().find(|c| c.name == "edges").unwrap();
    let rule = BvecRule::NiFreeze {
        image_affine: case.image_affine,
    };
    let nf = rotate_gradients(&rule, &case.bvals, &case.bvecs, &case.transforms).unwrap();
    let qsi = rotate_gradients(
        &BvecRule::ShoreLine,
        &case.bvals,
        &case.bvecs,
        &case.transforms,
    )
    .unwrap();
    let b0 = |g: &HmcGradients| -> Vec<usize> { (0..g.b0.len()).filter(|&i| g.b0[i]).collect() };
    assert_eq!(b0(&nf), vec![0, 8, 10]);
    assert_eq!(b0(&qsi), vec![0, 8, 10]);
    // NiFreeze rescales b with the length (2000 · 0.5, 1000 · 0.6) and does not renormalise a
    // rotated vector; QSIPrep keeps b and renormalises.
    assert_eq!(nf.bvals[4], 1000.0);
    assert_eq!(nf.bvals[6], 1000.0f32 as f64 * 0.6f32 as f64);
    assert_eq!(qsi.bvals[4], 2000.0);
    let length = |v: [f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    assert!(
        (length(nf.bvecs[2]) - 1.0).abs() > 0.01,
        "{:?}",
        nf.bvecs[2]
    );
    assert!(
        (length(qsi.bvecs[2]) - 1.0).abs() < 1e-12,
        "{:?}",
        qsi.bvecs[2]
    );
    // A component of -1e-9 after a 1e-9 rad rotation prints as -0.000000.
    assert_eq!(
        nf.bvec_text().lines().next().unwrap().split(' ').nth(3),
        Some("-0.000000")
    );
}

#[test]
fn nifreeze_b0_by_rescaled_b_value() {
    // b = 1000 with |g| = 1/32 becomes b = 31.25 ≤ 50: NiFreeze drops it as a b0, and the
    // output keeps it unchanged. QSIPrep's rule refuses such a short direction.
    let case = cases().into_iter().find(|c| c.name == "edges").unwrap();
    let rule = BvecRule::NiFreeze {
        image_affine: case.image_affine,
    };
    let bvecs = [[0.0, 0.0, 1.0 / 32.0], [0.0, 0.6, 0.8]];
    let g = rotate_gradients(&rule, &[1000.0, 1000.0], &bvecs, &case.transforms[..2]).unwrap();
    assert_eq!(g.b0, vec![true, false]);
    assert_eq!(g.bvecs[0], bvecs[0]);
    assert_eq!(g.bvals[0], 1000.0);
    assert!(
        rotate_gradients(
            &BvecRule::ShoreLine,
            &[1000.0],
            &bvecs[..1],
            &case.transforms[..1]
        )
        .is_err()
    );
}
