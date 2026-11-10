// SPDX-License-Identifier: Artistic-2.0
//! The Rician log-likelihood: ports of the toolbox's `RicianLogLik.m` and `logbesseli0.m`.
//! Below 700 the toolbox takes `log(besseli(0, x))`; [`log_i0`] computes it here.

use std::f64::consts::PI;

/// ln I0(x) for x ≥ 0: the power series Σ (x²/4)^k / (k!)² below 30, whose terms are all
/// positive, and above it the asymptotic series x - ln(2πx)/2 + ln Σ a_k with
/// a_k = a_{k-1} (2k-1)² / (8kx), stopped before its terms grow.
pub fn log_i0(x: f64) -> f64 {
    if x < 30.0 {
        let q = 0.25 * x * x;
        // The terms after the first, so that ln_1p keeps small x exact.
        let mut term = 1.0;
        let mut rest = 0.0;
        let mut k = 0.0;
        loop {
            k += 1.0;
            term *= q / (k * k);
            rest += term;
            if term <= (1.0 + rest) * 1e-17 {
                return rest.ln_1p();
            }
        }
    }
    let mut term = 1.0f64;
    let mut sum = 1.0;
    let mut k = 0.0;
    loop {
        k += 1.0;
        let next = term * (2.0 * k - 1.0) * (2.0 * k - 1.0) / (8.0 * k * x);
        if next >= term || next <= sum * 1e-17 {
            break;
        }
        term = next;
        sum += term;
    }
    x - 0.5 * (2.0 * PI * x).ln() + sum.ln()
}

/// `logbesseli0(x)` of one value.
fn logbesseli0(x: f64) -> f64 {
    if x < 700.0 {
        log_i0(x)
    } else {
        x - (2.0 * PI * x).ln() / 2.0
    }
}

/// `RicianLogLik(meas, signals, sig)` over the measurements in `kept`.
pub fn log_likelihood(meas: &[f64], signals: &[f64], sig: f64) -> f64 {
    let sig2 = sig * sig;
    let mut loglik = 0.0;
    for (&m, &s) in meas.iter().zip(signals) {
        let sumsqsc = (s * s + m * m) / (2.0 * sig2);
        let scp = m * s / sig2;
        loglik += -2.0 * sig.ln() - sumsqsc + s.ln() + logbesseli0(scp);
    }
    loglik
}
