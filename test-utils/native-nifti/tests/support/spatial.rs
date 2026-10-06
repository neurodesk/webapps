pub fn affines() -> Vec<(&'static str, [[f64; 4]; 3])> {
    vec![
        (
            "identity",
            [[1., 0., 0., 7.], [0., 1., 0., -3.], [0., 0., 1., 2.]],
        ),
        (
            "reflected",
            [[-1., 0., 0., 7.], [0., 1., 0., -3.], [0., 0., -1., 2.]],
        ),
        (
            "permuted",
            [[0., 0., -2., 7.], [1., 0., 0., -3.], [0., 1.5, 0., 2.]],
        ),
        (
            "oblique",
            [
                [0.8, -0.6, 0.1, 7.],
                [0.6, 0.8, 0.2, -3.],
                [0.1, -0.2, 1.2, 2.],
            ],
        ),
        (
            "tied",
            [[1., -1., 0., 7.], [1., 1., 0., -3.], [0., 0., 1., 2.]],
        ),
        (
            "collision",
            [[1., 1., 1., 7.], [0., 0.25, 0., -3.], [0., 0., 0.5, 2.]],
        ),
        (
            "near-unit",
            [[0.95, 0., 0., 7.], [0., 1.05, 0., -3.], [0., 0., 1., 2.]],
        ),
        (
            "singular",
            [[1., 0., 0., 7.], [1., 0., 0., -3.], [0., 0., 1., 2.]],
        ),
        (
            "below-threshold",
            [
                [1., 0., 0., 7.],
                [0., 1., 0., -3.],
                [0., 0., f64::from_bits(1e-12f64.to_bits() - 1), 2.],
            ],
        ),
        (
            "at-threshold",
            [[1., 0., 0., 7.], [0., 1., 0., -3.], [0., 0., 1e-12, 2.]],
        ),
        (
            "negative-threshold",
            [[1., 0., 0., 7.], [0., 1., 0., -3.], [0., 0., -1e-12, 2.]],
        ),
    ]
}

pub fn input_runs(input: &[f32]) -> Vec<(usize, u32)> {
    let mut runs = Vec::new();
    for bits in input.iter().map(|x| x.to_bits()) {
        match runs.last_mut() {
            Some((count, previous)) if *previous == bits => *count += 1,
            _ => runs.push((1, bits)),
        }
    }
    runs
}

pub fn snapshot(name: &str, lines: Vec<String>) {
    let expected = match name {
        "synthsr" => include_str!("../snapshots/synthsr-spatial.txt"),
        "synthseg" => include_str!("../snapshots/synthseg-spatial.txt"),
        _ => panic!("Unknown method {name}"),
    };
    let actual = lines.join("\n") + "\n";
    if let Ok(dir) = std::env::var("NIFTI_SNAPSHOT_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/{name}-spatial.txt"), &actual).unwrap();
    }
    assert_eq!(actual, expected, "{name} spatial baseline");
}
