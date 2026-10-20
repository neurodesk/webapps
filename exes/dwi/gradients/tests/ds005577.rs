//! The b0 rules on a real table: OpenNeuro ds005577 sub-107 (see `data/README.md`).
use dwi_gradients::B0Rule;

fn table() -> (Vec<f64>, Vec<[f64; 3]>) {
    let numbers = |text: &str| -> Vec<Vec<f64>> {
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                line.split_whitespace()
                    .map(|v| v.parse().unwrap())
                    .collect()
            })
            .collect()
    };
    let bvals = numbers(include_str!("data/sub-107_dir-AP_dwi.bval")).concat();
    let rows = numbers(include_str!("data/sub-107_dir-AP_dwi.bvec"));
    let bvecs = (0..bvals.len())
        .map(|i| [rows[0][i], rows[1][i], rows[2][i]])
        .collect();
    (bvals, bvecs)
}

#[test]
fn nifreeze_and_qsiprep_split_sub_107() {
    for rule in [B0Rule::NiFreeze, B0Rule::QsiPrep] {
        let (bvals, bvecs) = table();
        let g = rule.read(bvals, bvecs).unwrap();
        assert_eq!(g.len(), 101, "{rule:?}");
        assert_eq!(
            g.b0_volumes(),
            (0..=100).step_by(10).collect::<Vec<_>>(),
            "{rule:?}"
        );
        let dwi = g.dwi_volumes();
        let shell = |b: f64| dwi.iter().filter(|&&i| g.bvals[i] == b).count();
        assert_eq!(
            (shell(1000.0), shell(3000.0), dwi.len()),
            (30, 60, 90),
            "{rule:?}"
        );
    }
}
