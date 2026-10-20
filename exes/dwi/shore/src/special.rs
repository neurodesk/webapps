// SPDX-License-Identifier: BSD-3-Clause
//! Special functions for the 3dSHORE basis: the associated Legendre function with the
//! Condon-Shortley phase (as `scipy.special.lpmv`), the generalised Laguerre polynomial
//! (as `scipy.special.genlaguerre`) and the gamma and factorial values of `_kappa`.
//! Each uses a standard recurrence; `tests/oracle.rs` holds them to scipy through the basis.

/// P_l^m(x) for integer 0 <= m <= l and -1 <= x <= 1, with the Condon-Shortley phase
/// (-1)^m, as `scipy.special.lpmv(m, l, x)`. Upward recurrence in the degree from
/// P_m^m = (-1)^m (2m-1)!! (1-x²)^(m/2).
pub fn lpmv(m: usize, l: usize, x: f64) -> f64 {
    if m > l {
        return 0.0;
    }
    let mut pmm = 1.0;
    if m > 0 {
        let s = ((1.0 - x) * (1.0 + x)).sqrt();
        let mut odd = 1.0;
        for _ in 0..m {
            pmm *= -odd * s;
            odd += 2.0;
        }
    }
    if l == m {
        return pmm;
    }
    let mut prev = pmm;
    let mut cur = x * (2 * m + 1) as f64 * pmm;
    for ll in m + 2..=l {
        let next = ((2 * ll - 1) as f64 * x * cur - (ll + m - 1) as f64 * prev) / (ll - m) as f64;
        prev = cur;
        cur = next;
    }
    cur
}

/// The generalised Laguerre polynomial L_n^(alpha)(x), by the three-term recurrence
/// (k+1) L_(k+1) = (2k+1+alpha-x) L_k - (k+alpha) L_(k-1).
pub fn genlaguerre(n: usize, alpha: f64, x: f64) -> f64 {
    if n == 0 {
        return 1.0;
    }
    let mut prev = 1.0;
    let mut cur = 1.0 + alpha - x;
    for k in 1..n {
        let k = k as f64;
        let next = ((2.0 * k + 1.0 + alpha - x) * cur - (k + alpha) * prev) / (k + 1.0);
        prev = cur;
        cur = next;
    }
    cur
}

/// n! as a float; exact for the n <= 6 that radial order 6 needs.
pub fn factorial(n: usize) -> f64 {
    (1..=n).fold(1.0, |acc, k| acc * k as f64)
}

/// Γ(n + 3/2) = √π (2n+1)!! / 2^(n+1).
pub fn gamma_half(n: usize) -> f64 {
    let mut value = std::f64::consts::PI.sqrt() / 2.0;
    for k in 0..n {
        value *= k as f64 + 1.5;
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legendre_matches_closed_forms() {
        let x: f64 = 0.3;
        let s = (1.0 - x * x).sqrt();
        assert!((lpmv(0, 2, x) - 0.5 * (3.0 * x * x - 1.0)).abs() < 1e-15);
        assert!((lpmv(1, 2, x) + 3.0 * x * s).abs() < 1e-15);
        assert!((lpmv(2, 2, x) - 3.0 * s * s).abs() < 1e-15);
        assert!((lpmv(3, 4, x) + 105.0 * x * s * s * s).abs() < 1e-13);
        assert_eq!(lpmv(3, 2, x), 0.0);
    }

    #[test]
    fn laguerre_matches_closed_forms() {
        let (a, x): (f64, f64) = (2.5, 1.7);
        assert_eq!(genlaguerre(0, a, x), 1.0);
        assert!((genlaguerre(1, a, x) - (1.0 + a - x)).abs() < 1e-15);
        let l2 = x * x / 2.0 - (a + 2.0) * x + (a + 2.0) * (a + 1.0) / 2.0;
        assert!((genlaguerre(2, a, x) - l2).abs() < 1e-14);
    }

    #[test]
    fn gamma_and_factorial() {
        assert_eq!(factorial(0), 1.0);
        assert_eq!(factorial(6), 720.0);
        assert!((gamma_half(0) - 0.886_226_925_452_758).abs() < 1e-15);
        assert!((gamma_half(2) - 3.323_350_970_447_843).abs() < 1e-14);
    }
}
