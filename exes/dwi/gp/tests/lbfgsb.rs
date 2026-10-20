//! L-BFGS-B against scipy 1.18.1 on two plain functions (tests/fixtures/lbfgsb_*.json).
//! The functions repeat the oracle's operation order, so f and g are the same bits;
//! every difference comes from the optimizer.

mod common;

use common::{load, num, nums, rel_inf};
use dwi_gp::lbfgsb::{Options, minimize_observed};

fn rosen(x: &[f64], g: &mut [f64]) -> f64 {
    let mut f = 0.0;
    g.iter_mut().for_each(|v| *v = 0.0);
    for i in 0..x.len() - 1 {
        let a = x[i + 1] - x[i] * x[i];
        let b = 1.0 - x[i];
        f += 100.0 * a * a + b * b;
        g[i] += -400.0 * x[i] * a - 2.0 * b;
        g[i + 1] += 200.0 * a;
    }
    f
}

fn mixed(x: &[f64], g: &mut [f64]) -> f64 {
    let w = [1.0, 2.0, 3.0, 0.5];
    let c = [0.7, -1.0, 1.0, 0.3];
    let mut f = 0.0;
    g.iter_mut().for_each(|v| *v = 0.0);
    for i in 0..4 {
        let r = x[i] - c[i];
        f += w[i] * r * r;
        g[i] += 2.0 * w[i] * r;
    }
    let q = x[0] * x[1] + x[2];
    f += 0.5 * q * q * q * q;
    let q3 = 2.0 * q * q * q;
    g[0] += q3 * x[1];
    g[1] += q3 * x[0];
    g[2] += q3;
    f
}

fn check(name: &str, fun: fn(&[f64], &mut [f64]) -> f64) -> dwi_gp::lbfgsb::Stats {
    let fx = load(name);
    let x0 = nums(&fx["x0"]);
    let bounds = fx["bounds"].as_array().unwrap();
    let lower: Vec<f64> = bounds.iter().map(|b| num(&b[0])).collect();
    let upper: Vec<f64> = bounds.iter().map(|b| num(&b[1])).collect();

    let mut trace: Vec<(Vec<f64>, f64, Vec<f64>)> = Vec::new();
    let mut iterations: Vec<(Vec<f64>, f64)> = Vec::new();
    let res = minimize_observed(
        |x: &[f64], g: &mut [f64]| {
            let f = fun(x, g);
            trace.push((x.to_vec(), f, g.to_vec()));
            f
        },
        &x0,
        &lower,
        &upper,
        &Options::default(),
        |x: &[f64], f: f64| iterations.push((x.to_vec(), f)),
    )
    .unwrap();

    let want = &fx["result"];
    let want_trace = fx["trace"].as_array().unwrap();
    let mut worst_x = 0.0f64;
    let mut worst_f = 0.0f64;
    for (k, (x, f, _g)) in trace.iter().enumerate() {
        let w = &want_trace[k];
        let ex = rel_inf(x, &nums(&w["x"]));
        if std::env::var("GP_TRACE").is_ok() {
            eprintln!("{name} eval {k}: rel x {ex:.2e}");
        }
        worst_x = worst_x.max(ex);
        worst_f = worst_f.max((*f - num(&w["f"])).abs() / num(&w["f"]).abs().max(1.0));
    }
    let worst_it = iterations
        .iter()
        .zip(fx["iterations"].as_array().unwrap())
        .map(|((x, _), w)| rel_inf(x, &nums(&w["x"])))
        .fold(0.0, f64::max);
    eprintln!(
        "{name}: {} evaluations, nit {}, max rel x {worst_x:.2e}, f {worst_f:.2e}, iterates {worst_it:.2e}; {:?}",
        trace.len(),
        res.nit,
        res.stats
    );
    assert_eq!(trace.len(), want_trace.len(), "{name}: evaluations");
    assert_eq!(res.nfev as u64, want["nfev"].as_u64().unwrap());
    assert_eq!(res.njev as u64, want["njev"].as_u64().unwrap());
    assert_eq!(res.nit as u64, want["nit"].as_u64().unwrap());
    assert_eq!(res.status as u64, want["status"].as_u64().unwrap());
    assert_eq!(res.message(), want["message"].as_str().unwrap());
    // Same branches, so the same counts and message; the values differ by OpenBLAS's
    // summation order, which Rosenbrock's conditioning amplifies to about 1e-11 in x.
    // f is the same function of x, so its error is |grad f| times that: up to 1.2e-10.
    assert!(worst_x < 1e-10 && worst_f < 1e-9, "{name}: path differs");
    assert!(rel_inf(&res.x, &nums(&want["x"])) < 1e-10);
    assert!((res.fun - num(&want["fun"])).abs() < 1e-10);
    res.stats
}

#[test]
fn rosenbrock_in_a_box_matches_scipy() {
    let stats = check("lbfgsb_rosen_box", rosen);
    // The run fills the memory, so the shift branches of matupd and formk run.
    assert!(stats.shifts > 0, "{stats:?}");
    assert!(stats.cauchy_segments > 0, "{stats:?}");
}

#[test]
fn subsm_backtrack_matches_scipy() {
    let stats = check("lbfgsb_rosen_backtrack", rosen);
    assert!(stats.subsm_backtracks > 0, "{stats:?}");
}

#[test]
fn mixed_bounds_match_scipy() {
    check("lbfgsb_mixed", mixed);
}

#[test]
fn rejects_bad_input() {
    use dwi_gp::lbfgsb::{Error, minimize};
    let f = |x: &[f64], g: &mut [f64]| {
        g[0] = 2.0 * x[0];
        x[0] * x[0]
    };
    let o = Options::default();
    assert_eq!(
        minimize(f, &[1.0], &[2.0], &[1.0], &o).unwrap_err(),
        Error::Bounds
    );
    assert_eq!(
        minimize(f, &[1.0], &[0.0, 0.0], &[1.0], &o).unwrap_err(),
        Error::Length
    );
    let r = minimize(f, &[1.0], &[f64::NEG_INFINITY], &[f64::INFINITY], &o).unwrap();
    assert!(r.success() && r.x[0].abs() < 1e-8, "{r:?}");
}
