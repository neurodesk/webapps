//! The GP against scikit-learn 1.9.1 with NiFreeze 3bcfb00's kernel
//! (tests/fixtures/*.json, written by tools/oracle.py).
//!
//! Two kinds of test:
//! * replay: the lml and gradient at every theta that scikit-learn's optimizer
//!   visited, and on a grid of theta (lml_grid). Tolerance 1e-10: relative for the
//!   lml; for the gradient, relative where |g| >= 1 and absolute below (grad_err).
//! * path: the full fit. Each evaluation must follow scikit-learn's theta sequence,
//!   and the fitted hyperparameters must agree to 1e-6 relative.

mod common;

use common::{load, num, nums, rel, rel_inf, rel_vec, rows3, targets, vec3};
use dwi_gp::kernel::pairwise_angles;
use dwi_gp::{FitError, Form, GaussianProcess, Likelihood, Targets};
use serde_json::Value;

const FORMS: [Form; 2] = [Form::Gram, Form::PerTarget];

/// The error of a gradient: max |a - b| / max(|b|, 1). Each component is a small
/// difference of large terms near an optimum (|g| down to 1e-8 at the end of
/// interior_pgtol, from terms of size 1-100), so no implementation, scikit-learn's
/// two forms included, agrees there to 1e-10 of |g|. The measure is relative where
/// |g| >= 1 and absolute below; the optimizer's pgtol test (1e-5) is absolute too.
fn grad_err(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    let d = (0..3).map(|k| (a[k] - b[k]).abs()).fold(0.0, f64::max);
    d / b.iter().map(|v| v.abs()).fold(1.0, f64::max)
}

#[test]
fn lml_grid_matches_scikit_learn() {
    let fx = load("lml_grid");
    let x = rows3(&fx["X"]);
    let angles = pairwise_angles(&x, &x);
    let alpha = num(&fx["alpha"]);
    for form in FORMS {
        let mut worst = (0.0f64, 0.0f64, 0.0f64);
        for case in fx["cases"].as_array().unwrap() {
            let (n, y) = targets(&fx["y"][case["y"].as_str().unwrap()]);
            let t = Targets::normalize(&y, n);
            let lik = Likelihood::new(&angles, &t, alpha, form);
            let theta = vec3(&case["theta"]);
            let (lml, grad) = lik.eval(&theta);
            let lml_orig = num(&case["lml_orig"]);
            if lml_orig == f64::NEG_INFINITY {
                assert_eq!(lml, f64::NEG_INFINITY);
                assert!(grad.iter().all(|g| g.to_bits() == 0), "{grad:?}");
                let mut g = [1.0; 3];
                let f = lik.objective(&theta, &mut g);
                assert_eq!(f, f64::INFINITY);
                assert!(
                    g.iter().all(|g| g.to_bits() == (-0.0f64).to_bits()),
                    "{g:?}"
                );
                continue;
            }
            let e_lml = rel(lml, lml_orig);
            let e_orig = grad_err(&grad, &vec3(&case["grad_orig"]));
            let e_patch = grad_err(&grad, &vec3(&case["grad_patched"]));
            worst = (
                worst.0.max(e_lml),
                worst.1.max(e_orig),
                worst.2.max(e_patch),
            );
            assert!(e_lml < 1e-10, "{form:?} {}: lml {e_lml:e}", case["params"]);
            assert!(
                e_orig < 1e-10,
                "{form:?} {}: grad vs orig {e_orig:e}",
                case["params"]
            );
            assert!(
                e_patch < 1e-10,
                "{form:?} {}: grad vs patch {e_patch:e}",
                case["params"]
            );
        }
        eprintln!(
            "lml_grid {form:?}: max rel lml {:.2e}, grad vs original {:.2e}, grad vs summed {:.2e}",
            worst.0, worst.1, worst.2
        );
    }
}

fn y_of(fx: &Value) -> (usize, Vec<f64>) {
    targets(&fx["y"])
}

/// Replay: -lml and -grad at every theta of scikit-learn's trace.
fn replay(name: &str) {
    let fx = load(name);
    let x = rows3(&fx["X"]);
    let angles = pairwise_angles(&x, &x);
    let (n, y) = y_of(&fx);
    let t = Targets::normalize(&y, n);
    let e_mean = rel_vec(&t.mean, &nums(&fx["normalize"]["mean"]));
    let e_std = rel_vec(&t.std, &nums(&fx["normalize"]["std"]));
    eprintln!("{name}: normalisation max rel mean {e_mean:.2e}, std {e_std:.2e}");
    // numpy's pairwise order gives the same bits.
    assert!(
        e_mean == 0.0 && e_std == 0.0,
        "{name}: mean {e_mean:e}, std {e_std:e}"
    );
    let alpha = num(&fx["kernel"]["alpha"]);
    for form in FORMS {
        let lik = Likelihood::new(&angles, &t, alpha, form);
        let (mut ef, mut eg) = (0.0f64, 0.0f64);
        for e in fx["trace"].as_array().unwrap() {
            let theta = vec3(&e["theta"]);
            let mut g = [0.0; 3];
            let f = lik.objective(&theta, &mut g);
            let want_f = num(&e["f"]);
            let want_g = vec3(&e["g"]);
            if want_f == f64::INFINITY {
                assert_eq!(f, f64::INFINITY);
                assert!(g.iter().all(|v| v.to_bits() == (-0.0f64).to_bits()));
                assert!(want_g.iter().all(|v| v.to_bits() == (-0.0f64).to_bits()));
                continue;
            }
            ef = ef.max(rel(f, want_f));
            eg = eg.max(grad_err(&g, &want_g));
            if std::env::var("GP_TRACE").is_ok() {
                eprintln!(
                    "{name} {form:?} theta {theta:?}: g {g:?} want {want_g:?} err {:.2e}",
                    grad_err(&g, &want_g)
                );
            }
        }
        eprintln!("{name} replay {form:?}: max rel f {ef:.2e}, g {eg:.2e}");
        assert!(
            ef < 1e-10 && eg < 1e-10,
            "{name} {form:?}: f {ef:e} g {eg:e}"
        );
    }
}

/// Path: the full fit, step by step.
fn path(name: &str, form: Form) -> dwi_gp::Fit {
    let fx = load(name);
    let x = rows3(&fx["X"]);
    let (_, y) = y_of(&fx);
    let k = &fx["kernel"];
    let start = vec3(&k["start"]);
    let gp = GaussianProcess {
        start,
        form,
        ..GaussianProcess::default()
    };
    let fit = if fx["y_dtype"] == "int16" {
        let yi: Vec<i16> = y.iter().map(|&v| v as i16).collect();
        gp.fit(&x, &yi).unwrap()
    } else {
        gp.fit(&x, &y).unwrap()
    };

    // theta0 and the bounds are np.log of the values: the same bits from libm.
    let theta0 = vec3(&k["theta0"]);
    for i in 0..3 {
        assert_eq!(fit.theta0[i].to_bits(), theta0[i].to_bits(), "theta0[{i}]");
        let b = nums(&k["bounds_log"][i]);
        assert_eq!(
            fit.bounds_log[i].0.to_bits(),
            b[0].to_bits(),
            "bounds[{i}].0"
        );
        assert_eq!(
            fit.bounds_log[i].1.to_bits(),
            b[1].to_bits(),
            "bounds[{i}].1"
        );
    }

    let want = fx["trace"].as_array().unwrap();
    let mut e_theta = 0.0f64;
    for (s, e) in fit.trace.iter().enumerate() {
        let et = rel_inf(&e.theta, &vec3(&want[s]["theta"]));
        if std::env::var("GP_TRACE").is_ok() {
            eprintln!("{name} {form:?} step {s}: rel theta {et:.2e}");
        }
        e_theta = e_theta.max(et);
    }
    let r = &fx["result"];
    let e_x = rel_inf(&fit.theta, &vec3(&r["x"]));
    let e_params = rel_vec(
        &[fit.params().a, fit.params().lambda, fit.params().sigma2],
        &nums(&fx["fitted"]["params"]),
    );
    let pred = fit.predict(&[vec3(&fx["X_new"])]).unwrap();
    let e_pred = rel_vec(&pred, &nums(&fx["predict"]["y_mean"]));
    let e_lml = rel(fit.lml, num(&fx["fitted"]["lml"]));
    eprintln!(
        "{name} path {form:?}: {} evaluations, nit {}, max rel theta per step {e_theta:.2e}, \
         end theta {e_x:.2e}, params {e_params:.2e}, lml {e_lml:.2e}, predict {e_pred:.2e}; {}",
        fit.trace.len(),
        fit.result.nit,
        fit.result.message()
    );
    assert_eq!(fit.trace.len(), want.len(), "{name}: evaluations");
    assert_eq!(fit.result.nfev as u64, r["nfev"].as_u64().unwrap());
    assert_eq!(fit.result.nit as u64, r["nit"].as_u64().unwrap());
    assert_eq!(fit.result.status as u64, r["status"].as_u64().unwrap());
    assert_eq!(fit.result.message(), r["message"].as_str().unwrap());
    assert!(e_theta < 1e-11, "{name}: path {e_theta:e}");
    assert!(e_params < 1e-6, "{name}: params {e_params:e}");
    assert!(e_lml < 1e-10, "{name}: lml {e_lml:e}");
    assert!(e_pred < 1e-12, "{name}: predict {e_pred:e}");
    let iterates = fx["iterations"].as_array().unwrap();
    assert_eq!(fit.iterations.len(), iterates.len());
    fit
}

#[test]
fn bounded_shell() {
    replay("bounded_shell");
    for form in FORMS {
        let fit = path("bounded_shell", form);
        // a and lambda end on their lower bounds, as in all 90 M0 fits.
        assert_eq!(fit.theta[0].to_bits(), fit.bounds_log[0].0.to_bits());
        assert_eq!(fit.theta[1].to_bits(), fit.bounds_log[1].0.to_bits());
    }
}

#[test]
fn stuck_inf() {
    replay("stuck_inf");
    for form in FORMS {
        let fit = path("stuck_inf", form);
        // The first trial point is the box corner, where K is not positive definite;
        // the line search comes back to theta0.
        assert_eq!(fit.trace[1].f, f64::INFINITY);
        assert_eq!(fit.theta, fit.theta0);
    }
}

#[test]
fn interior() {
    replay("interior");
    for form in FORMS {
        path("interior", form);
    }
}

#[test]
fn interior_pgtol() {
    replay("interior_pgtol");
    for form in FORMS {
        path("interior_pgtol", form);
    }
}

#[test]
fn normalize_edge() {
    replay("normalize_edge");
    let fx = load("normalize_edge");
    for form in FORMS {
        let fit = path("normalize_edge", form);
        assert_eq!(fit.targets.std[5], 1.0);
        let zeros = nums(&fx["y_train_column5"]);
        assert_eq!(fit.targets.target(5), zeros.as_slice());
    }
}

#[test]
fn non_finite_input_is_refused() {
    // scikit-learn's validate_data raises ValueError for NaN or inf in X or y.
    let x = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let gp = GaussianProcess::default();
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let y = [1.0, 2.0, bad, 4.0, 5.0, 6.0];
        assert_eq!(gp.fit(&x, &y).unwrap_err(), FitError::NonFinite);
        let mut xb = x;
        xb[1][2] = bad;
        let y = [1.0, 2.0, 3.0];
        assert_eq!(gp.fit(&xb, &y).unwrap_err(), FitError::NonFinite);
    }
}

#[test]
fn prediction_refuses_non_finite_directions() {
    let x = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let fit = GaussianProcess::default()
        .fit(&x, &[1.0, 2.0, 3.0])
        .unwrap();
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for axis in 0..3 {
            let mut query = [0.0; 3];
            query[axis] = bad;
            assert_eq!(fit.predict(&[query]).unwrap_err(), FitError::NonFinite);
        }
    }
}

#[test]
fn exp_of_theta0_matches_numpy() {
    // exp(ln 0.1) is not 0.1; the kernel uses exp(theta). Check libm against numpy.
    let fx = load("bounded_shell");
    let theta0 = vec3(&fx["kernel"]["theta0"]);
    let want = vec3(&fx["kernel"]["exp_theta0"]);
    for i in 0..3 {
        assert_eq!(
            libm::exp(theta0[i]).to_bits(),
            want[i].to_bits(),
            "exp(theta0[{i}])"
        );
    }
    assert_ne!(want[0], 0.1);
}
