//! The `b < B0_THRESHOLD` rule on the cases in `data/b0-rule.tsv`. The JavaScript b0 selection
//! (`packages/dwi2trx/src/gradients.js`, `b0Volumes`) reads the same file and must agree.
use dwi_gradients::{B0Rule, Gradients};

const X: [f64; 3] = [1.0, 0.0, 0.0];

const CASES: &str = include_str!("data/b0-rule.tsv");

fn cases(text: &str) -> Vec<(Vec<f64>, Vec<usize>)> {
    text.lines()
        .filter(|line| !line.starts_with('#') && !line.trim().is_empty())
        .map(|line| {
            let (bvals, b0) = line
                .split_once('\t')
                .expect("a case is b-values, a tab, then the b0 indices or none");
            let bvals = bvals
                .split_whitespace()
                .map(|v| v.parse().unwrap())
                .collect();
            let b0 = match b0 {
                "none" => Vec::new(),
                b0 => b0.split_whitespace().map(|v| v.parse().unwrap()).collect(),
            };
            (bvals, b0)
        })
        .collect()
}

#[test]
fn the_b0_rule_selects_the_shared_cases() {
    let cases = cases(CASES);
    assert_eq!(cases.len(), 6);
    for (bvals, b0) in cases {
        let bvecs = vec![X; bvals.len()];
        let g = Gradients::new(bvals.clone(), bvecs.clone()).unwrap();
        assert_eq!(g.b0_volumes(), b0, "{bvals:?}");
        let ruled = B0Rule::Dtifit.read(bvals.clone(), bvecs).unwrap();
        assert_eq!(ruled.b0_volumes(), b0, "{bvals:?}");
    }
}

#[test]
fn the_shared_cases_survive_a_trailing_whitespace_trim() {
    let trimmed: String = CASES
        .lines()
        .map(|line| format!("{}\n", line.trim_end()))
        .collect();
    assert_eq!(cases(&trimmed), cases(CASES));
}

#[test]
fn the_b0_rule_splits_sub_107() {
    let bvals: Vec<f64> = include_str!("data/sub-107_dir-AP_dwi.bval")
        .split_whitespace()
        .map(|v| v.parse().unwrap())
        .collect();
    let g = Gradients::new(bvals.clone(), vec![X; bvals.len()]).unwrap();
    assert_eq!(g.b0_volumes(), (0..=100).step_by(10).collect::<Vec<_>>());
}
