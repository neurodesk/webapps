//! The two optimisers SamSrf's fine fits use: MATLAB's `fminsearch` (Nelder-Mead, Lagarias
//! et al. 1998, as `fminsearch.m` implements it) and `samsrf_hookejeeves` (pattern search).
//!
//! `fminsearch` follows MATLAB's source step for step (initial simplex, coefficients,
//! acceptance rules, stable sort, convergence test, `OutputFcn`), which the Octave
//! reference harness reimplements in `shims/fminsearch.m`; the two produce the same
//! sequence of evaluations.

use num_complex::Complex64;
use std::cmp::Ordering;

/// MATLAB orders complex objectives by magnitude and phase when sorting a
/// simplex, but compares their real parts in the acceptance branches.
pub trait ObjectiveValue: Copy + std::ops::Sub<Output = Self> {
    fn is_finite(self) -> bool;
    fn magnitude(self) -> f64;
    fn real(self) -> f64;
    fn sort_order(self, other: Self) -> Ordering;
    fn infinity() -> Self;
}

impl ObjectiveValue for f64 {
    fn is_finite(self) -> bool { self.is_finite() }
    fn magnitude(self) -> f64 { self.abs() }
    fn real(self) -> f64 { self }
    fn sort_order(self, other: Self) -> Ordering { matlab_order(self, other) }
    fn infinity() -> Self { f64::INFINITY }
}

impl ObjectiveValue for Complex64 {
    fn is_finite(self) -> bool { self.re.is_finite() && self.im.is_finite() }
    fn magnitude(self) -> f64 { self.norm() }
    fn real(self) -> f64 { self.re }
    fn sort_order(self, other: Self) -> Ordering {
        matlab_order(complex_sort_magnitude(self), complex_sort_magnitude(other)).then_with(|| matlab_order(self.arg(), other.arg()))
    }
    fn infinity() -> Self { Self::new(f64::INFINITY, 0.0) }
}

fn complex_sort_magnitude(value: Complex64) -> f64 {
    // The recorded R2023b CSS simplex ties after sqrt(re²+im²), then sorts by
    // phase. hypot can separate that tie by one ULP and change the fitted pRF.
    let square = value.norm_sqr();
    if square.is_normal() { square.sqrt() } else { value.norm() }
}

/// `optimset` fields `fminsearch` reads. `tol_x` and `tol_fun` default to 1e-4, the
/// iteration and evaluation limits to `200 * n`.
#[derive(Debug, Clone, PartialEq)]
pub struct FminsearchOptions {
    pub tol_x: f64,
    pub tol_fun: f64,
    pub max_iter: Option<usize>,
    pub max_fun_evals: Option<usize>,
    /// SamSrf's `samsrf_fminsearch_outfun`: stop as soon as the best value is not finite.
    pub stop_when_not_finite: bool,
}

impl Default for FminsearchOptions {
    fn default() -> Self {
        Self { tol_x: 1e-4, tol_fun: 1e-4, max_iter: None, max_fun_evals: None, stop_when_not_finite: false }
    }
}

/// Why `fminsearch` returned: MATLAB's `exitflag`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitFlag {
    /// 1: both tolerances met.
    Converged,
    /// 0: an iteration or evaluation limit.
    Limit,
    /// -1: stopped by the output function.
    Stopped,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FminsearchResult<T = f64> {
    pub x: Vec<f64>,
    pub fval: T,
    pub exit_flag: ExitFlag,
    pub iterations: usize,
    pub func_count: usize,
}

/// MATLAB `fminsearch(f, x0, options)`.
pub fn fminsearch<T: ObjectiveValue, F: FnMut(&[f64]) -> T>(mut f: F, x0: &[f64], options: &FminsearchOptions) -> FminsearchResult<T> {
    let n = x0.len();
    let max_iter = options.max_iter.unwrap_or(200 * n);
    let max_fun = options.max_fun_evals.unwrap_or(200 * n);
    let (rho, chi, psi, sigma) = (1.0, 2.0, 0.5, 0.5);
    let usual_delta = 0.05;
    let zero_term_delta = 0.00025;

    // v: n + 1 vertices, each of n coordinates; fv their values. Kept sorted by fv.
    let mut v: Vec<Vec<f64>> = Vec::with_capacity(n + 1);
    let mut fv: Vec<T> = Vec::with_capacity(n + 1);
    v.push(x0.to_vec());
    fv.push(f(x0));
    let mut func_evals = 1;
    let mut itercount = 0;
    let output_stop = |fval: T| options.stop_when_not_finite && !fval.is_finite();
    if output_stop(fv[0]) {
        return FminsearchResult { x: v[0].clone(), fval: fv[0], exit_flag: ExitFlag::Stopped, iterations: itercount, func_count: func_evals };
    }
    for j in 0..n {
        let mut y = x0.to_vec();
        if y[j] != 0.0 {
            y[j] *= 1.0 + usual_delta;
        } else {
            y[j] = zero_term_delta;
        }
        fv.push(f(&y));
        v.push(y);
    }
    sort_simplex(&mut v, &mut fv);
    itercount += 1;
    func_evals = n + 1;
    let mut stop = output_stop(fv[0]);
    let mut exit_flag = ExitFlag::Converged;

    while func_evals < max_fun && itercount < max_iter && !stop {
        let f_spread = fv[1..].iter().map(|value| (fv[0] - *value).magnitude()).fold(0.0, f64::max);
        let x_spread = v[1..]
            .iter()
            .map(|vertex| vertex.iter().zip(&v[0]).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max))
            .fold(0.0, f64::max);
        if f_spread <= options.tol_fun && x_spread <= options.tol_x {
            break;
        }
        // Centroid of the n best vertices.
        let mut xbar = vec![0.0; n];
        for vertex in &v[..n] {
            for (sum, value) in xbar.iter_mut().zip(vertex) {
                *sum += value;
            }
        }
        for value in &mut xbar {
            *value /= n as f64;
        }
        let worst = v[n].clone();
        let xr: Vec<f64> = xbar.iter().zip(&worst).map(|(b, w)| (1.0 + rho) * b - rho * w).collect();
        let fxr = f(&xr);
        func_evals += 1;
        if fxr.real() < fv[0].real() {
            let xe: Vec<f64> = xbar.iter().zip(&worst).map(|(b, w)| (1.0 + rho * chi) * b - rho * chi * w).collect();
            let fxe = f(&xe);
            func_evals += 1;
            if fxe.real() < fxr.real() {
                v[n] = xe;
                fv[n] = fxe;
            } else {
                v[n] = xr;
                fv[n] = fxr;
            }
        } else if fxr.real() < fv[n - 1].real() {
            v[n] = xr;
            fv[n] = fxr;
        } else {
            let mut shrink = false;
            if fxr.real() < fv[n].real() {
                let xc: Vec<f64> = xbar.iter().zip(&worst).map(|(b, w)| (1.0 + psi * rho) * b - psi * rho * w).collect();
                let fxc = f(&xc);
                func_evals += 1;
                if fxc.real() <= fxr.real() {
                    v[n] = xc;
                    fv[n] = fxc;
                } else {
                    shrink = true;
                }
            } else {
                let xcc: Vec<f64> = xbar.iter().zip(&worst).map(|(b, w)| (1.0 - psi) * b + psi * w).collect();
                let fxcc = f(&xcc);
                func_evals += 1;
                if fxcc.real() < fv[n].real() {
                    v[n] = xcc;
                    fv[n] = fxcc;
                } else {
                    shrink = true;
                }
            }
            if shrink {
                let best = v[0].clone();
                for j in 1..=n {
                    for (value, b) in v[j].iter_mut().zip(&best) {
                        *value = b + sigma * (*value - b);
                    }
                    fv[j] = f(&v[j]);
                }
                func_evals += n;
            }
        }
        sort_simplex(&mut v, &mut fv);
        itercount += 1;
        stop = output_stop(fv[0]);
        if stop {
            exit_flag = ExitFlag::Stopped;
        }
    }
    if exit_flag != ExitFlag::Stopped && (func_evals >= max_fun || itercount >= max_iter) {
        exit_flag = ExitFlag::Limit;
    }
    FminsearchResult { x: v[0].clone(), fval: fv[0], exit_flag, iterations: itercount, func_count: func_evals }
}

/// MATLAB `sort` is stable, and NaN sorts last.
fn sort_simplex<T: ObjectiveValue>(v: &mut [Vec<f64>], fv: &mut [T]) {
    let mut order: Vec<usize> = (0..fv.len()).collect();
    order.sort_by(|&a, &b| fv[a].sort_order(fv[b]));
    let sorted_v: Vec<Vec<f64>> = order.iter().map(|&i| v[i].clone()).collect();
    let sorted_f: Vec<T> = order.iter().map(|&i| fv[i]).collect();
    v.clone_from_slice(&sorted_v);
    fv.copy_from_slice(&sorted_f);
}

fn matlab_order(a: f64, b: f64) -> std::cmp::Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => a.partial_cmp(&b).unwrap(),
    }
}

/// `samsrf_hookejeeves(ErrFcn, SeedParams, InitStep, OnlyPos, NumMaxIter, NumShrinks)`.
/// `only_positive` follows `logical(OnlyPos)`: any non-zero flag (SamSrf's -1 included)
/// forbids offsets that make the parameter `<= 0`. Returns the parameters and the error.
pub fn hooke_jeeves<T: ObjectiveValue, F: FnMut(&[f64]) -> T>(
    mut f: F,
    seed: &[f64],
    initial_step: &[f64],
    only_positive: &[bool],
    max_iterations: usize,
    max_shrinks: usize,
) -> (Vec<f64>, T) {
    let n = seed.len();
    debug_assert_eq!(initial_step.len(), n);
    debug_assert_eq!(only_positive.len(), n);
    let mut offsets: Vec<f64> = initial_step.to_vec();
    let mut current = seed.to_vec();
    let mut current_err = f(&current);
    let mut iterations = 0;
    let mut no_better = 0;
    while iterations < max_iterations && no_better < max_shrinks {
        let mut best_err = T::infinity();
        let mut best: Option<Vec<f64>> = None;
        // Offsets: +step per parameter, then -step per parameter, as [eye; -eye].
        for i in 0..2 * n {
            let p = i % n;
            let mut candidate = current.clone();
            candidate[p] += if i < n { offsets[p] } else { -offsets[p] };
            let allowed = candidate.iter().zip(only_positive).all(|(value, positive)| !positive || *value > 0.0);
            if !allowed {
                continue;
            }
            let err = f(&candidate);
            // `min` ignores NaN; `find(NewErr == NewMinErr, 1)` takes the first minimum.
            if err.sort_order(best_err).is_lt() {
                best_err = err;
                best = Some(candidate);
            }
        }
        if best_err.real() < current_err.real() {
            current = best.expect("a finite minimum has a candidate");
            current_err = best_err;
        } else {
            for offset in &mut offsets {
                *offset /= 2.0;
            }
            no_better += 1;
        }
        iterations += 1;
    }
    (current, current_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_complex_simplex_tie_uses_phase() {
        let a = Complex64::new(0.9106118083000183, -7.183147232581177e-8);
        let b = Complex64::new(0.9106118083000183, -7.159155046565502e-8);
        assert!(a.sort_order(b).is_lt());
        assert!(Complex64::new(1e200, 1e200).sort_order(Complex64::new(2e200, 0.0)).is_lt());
    }

    fn banana(x: &[f64]) -> f64 {
        100.0 * (x[1] - x[0] * x[0]).powi(2) + (1.0 - x[0]).powi(2)
    }

    #[test]
    fn rosenbrock_matches_matlab_documentation() {
        // fminsearch_rosenbrock.json from the Octave shim: 85 iterations, 159 evaluations.
        let result = fminsearch(banana, &[-1.2, 1.0], &FminsearchOptions::default());
        assert_eq!(result.exit_flag, ExitFlag::Converged);
        assert_eq!(result.iterations, 85);
        assert_eq!(result.func_count, 159);
        assert!((result.x[0] - 1.0000220).abs() < 1e-6, "{:?}", result.x);
        assert!((result.x[1] - 1.0000422).abs() < 1e-6, "{:?}", result.x);
        assert!((result.fval - 8.1777e-10).abs() < 1e-13, "{}", result.fval);
    }

    #[test]
    fn stops_when_the_best_value_is_not_finite() {
        // The output function sees the best vertex, which NaN never becomes once a finite
        // value exists (NaN sorts last); a NaN start stops the search before the simplex.
        let mut calls = 0;
        let result = fminsearch(
            |_| {
                calls += 1;
                f64::NAN
            },
            &[-1.2, 1.0],
            &FminsearchOptions { stop_when_not_finite: true, ..Default::default() },
        );
        assert_eq!(result.exit_flag, ExitFlag::Stopped);
        assert!(result.fval.is_nan());
        assert_eq!(calls, 1);
        let mut calls = 0;
        let result = fminsearch(
            |x| {
                calls += 1;
                if calls > 5 {
                    f64::NAN
                } else {
                    banana(x)
                }
            },
            &[-1.2, 1.0],
            &FminsearchOptions { stop_when_not_finite: true, ..Default::default() },
        );
        assert_ne!(result.exit_flag, ExitFlag::Stopped);
        assert!(result.fval.is_finite());
    }

    #[test]
    fn limits_give_exit_flag_zero() {
        let result = fminsearch(banana, &[-1.2, 1.0], &FminsearchOptions { max_iter: Some(10), ..Default::default() });
        assert_eq!(result.exit_flag, ExitFlag::Limit);
        assert_eq!(result.iterations, 10);
    }

    #[test]
    fn hooke_jeeves_descends_and_respects_positivity() {
        let (x, err) = hooke_jeeves(|p| (p[0] - 2.0).powi(2) + (p[1] - 0.5).powi(2), &[0.0, 0.1], &[1.0, 1.0], &[false, true], 1000, 10);
        assert!((x[0] - 2.0).abs() < 1e-2 && (x[1] - 0.5).abs() < 1e-2, "{x:?} {err}");
        let (x, _) = hooke_jeeves(|p| (p[0] + 2.0).powi(2), &[0.5], &[1.0], &[true], 15, 3);
        assert!(x[0] > 0.0);
    }
}
