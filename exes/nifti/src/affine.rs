/// Invert the spatial 3x3 block, ignoring translation.
/// Reject only determinants with magnitude below 1e-12.
/// Callers retain responsibility for checking nonfinite affine values.
pub fn inverse3(m: &[[f64; 4]; 3]) -> Result<[[f64; 3]; 3], String> {
    let [[a, b, c, _], [d, e, f, _], [g, h, i, _]] = *m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-12 {
        return Err("The image affine is singular.".into());
    }
    let adj = [
        [e * i - f * h, c * h - b * i, b * f - c * e],
        [f * g - d * i, a * i - c * g, c * d - a * f],
        [d * h - e * g, b * g - a * h, a * e - b * d],
    ];
    Ok(adj.map(|r| r.map(|v| v / det)))
}

/// Map RAS directions to voxel axes using inverse-column magnitudes.
/// Ties keep the first row. Missing axes replace the last occurrence of
/// the most frequent axis, choosing the first axis when counts tie.
pub fn ras_axes(affine: &[[f64; 4]; 3]) -> Result<[usize; 3], String> {
    let inv = inverse3(affine)?;
    let mut axes = [0usize; 3];
    for c in 0..3 {
        axes[c] = (0..3)
            .reduce(|a, b| {
                if inv[a][c].abs() >= inv[b][c].abs() {
                    a
                } else {
                    b
                }
            })
            .unwrap();
    }
    for i in 0..3 {
        if !axes.contains(&i) {
            let counts: Vec<usize> = (0..3)
                .map(|v| axes.iter().filter(|&&a| a == v).count())
                .collect();
            let most = counts
                .iter()
                .position(|&c| c == *counts.iter().max().unwrap())
                .unwrap();
            let last = axes.iter().rposition(|&a| a == most).unwrap();
            axes[last] = i;
        }
    }
    Ok(axes)
}
