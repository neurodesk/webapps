//! Memory at the M0 size: 89 volumes and 161668 targets. scikit-learn's gradient
//! builds an (n, n, targets) float64 array, 10.2 GB at this size; the port must not.
//! The test reads the peak resident size (VmHWM) of this test process, which runs
//! only the tests of this file.

use dwi_gp::kernel::pairwise_angles;
use dwi_gp::{Form, GaussianProcess, Likelihood, Targets};

const N: usize = 89;
const T: usize = 161_668;

fn peak_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// Deterministic directions and shell-like int16 signals.
fn data() -> (Vec<[f64; 3]>, Vec<i16>) {
    let mut s: u64 = 447;
    let mut rnd = move || {
        s = s
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((s >> 11) as f64) / ((1u64 << 53) as f64)
    };
    let x: Vec<[f64; 3]> = (0..N)
        .map(|_| {
            let z = 2.0 * rnd() - 1.0;
            let p = 2.0 * std::f64::consts::PI * rnd();
            let r = (1.0 - z * z).sqrt();
            [r * p.cos(), r * p.sin(), z]
        })
        .collect();
    let mut y = Vec::with_capacity(N * T);
    for _ in 0..T {
        let d = 0.0005 + 0.0025 * rnd();
        let s0 = 300.0 + 1200.0 * rnd();
        for i in 0..N {
            let b = if i % 3 == 0 { 3000.0 } else { 1000.0 };
            let v = s0 * (-b * d).exp() * (1.0 + 0.05 * (rnd() - 0.5));
            y.push(v.round() as i16);
        }
    }
    (x, y)
}

#[test]
fn no_buffer_of_n_by_n_by_targets() {
    let (x, y) = data();
    let before = peak_kib();
    let angles = pairwise_angles(&x, &x);
    let targets = Targets::normalize(&y, N);
    let theta = [0.1f64.ln(), 2.0f64.ln(), 0.0];
    let gram = Likelihood::new(&angles, &targets, 1e-10, Form::Gram).eval(&theta);
    let per = Likelihood::new(&angles, &targets, 1e-10, Form::PerTarget).eval(&theta);
    assert!(gram.0.is_finite() && per.0.is_finite());
    assert!(((gram.0 - per.0) / per.0).abs() < 1e-10);
    // One full fit and prediction at this size, with the default (Gram) form.
    let fit = GaussianProcess::default().fit(&x, &y).unwrap();
    let pred = fit.predict(&[x[7]]).unwrap();
    assert_eq!(pred.len(), T);
    let after = peak_kib();
    if let (Some(b), Some(a)) = (before, after) {
        let inputs = (N * T * (2 + 8)) as u64 / 1024;
        eprintln!(
            "peak resident: {} MiB before, {} MiB after; the targets take {} MiB",
            b / 1024,
            a / 1024,
            inputs / 1024
        );
        // An (n, n, targets) float64 buffer would add 10.2 GB.
        assert!(a < 1024 * 1024, "peak {a} KiB");
    } else {
        eprintln!("no /proc/self/status: the memory bound is not measured");
    }
}
