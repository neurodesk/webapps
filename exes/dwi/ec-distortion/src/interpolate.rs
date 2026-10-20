// SPDX-License-Identifier: Apache-2.0
//! Cubic convolution (Keys 1981, a = -0.5) along one line, with its derivative.

/// The value and the derivative at position `t` of a line of `n` samples `f(0..n)`. Positions
/// outside the line take the edge values.
pub fn cubic(f: impl Fn(usize) -> f64, n: usize, t: f64) -> (f64, f64) {
    if t < 0.0 {
        return (f(0), 0.0);
    }
    if t > (n - 1) as f64 {
        return (f(n - 1), 0.0);
    }
    let i = t.floor();
    let s = t - i;
    let i = i as isize;
    let at = |k: isize| f(k.clamp(0, n as isize - 1) as usize);
    let (p0, p1, p2, p3) = (at(i - 1), at(i), at(i + 1), at(i + 2));
    // Keys' kernel with a = -0.5 as a cubic in s (Catmull-Rom form).
    let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
    let c = -0.5 * p0 + 0.5 * p2;
    let value = ((a * s + b) * s + c) * s + p1;
    let derivative = (3.0 * a * s + 2.0 * b) * s + c;
    (value, derivative)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reproduces_quadratics_inside_the_line() {
        let f = |i: usize| (i as f64).powi(2) - 3.0 * i as f64 + 1.0;
        for t in [1.0, 1.25, 2.5, 3.75] {
            let (v, d) = cubic(f, 8, t);
            assert!((v - (t * t - 3.0 * t + 1.0)).abs() < 1e-12, "{t}");
            assert!((d - (2.0 * t - 3.0)).abs() < 1e-12, "{t}");
        }
    }

    #[test]
    fn held_edges_have_zero_derivative() {
        let f = |i: usize| [2.0, 5.0, -1.0, 4.0][i];
        for t in [-3.0, -0.25, 3.25, 9.0] {
            let (value, derivative) = cubic(f, 4, t);
            let epsilon = 1e-4;
            let finite_difference =
                (cubic(f, 4, t + epsilon).0 - cubic(f, 4, t - epsilon).0) / (2.0 * epsilon);
            assert_eq!(value, if t < 0.0 { 2.0 } else { 4.0 });
            assert_eq!(finite_difference, 0.0);
            assert_eq!(derivative, finite_difference, "position {t}");
        }
    }

    #[test]
    fn samples_are_exact_and_edges_are_held() {
        let f = |i: usize| [2.0, 5.0, -1.0, 4.0][i];
        assert_eq!(cubic(f, 4, 2.0).0, -1.0);
        assert_eq!(cubic(f, 4, -3.0).0, 2.0);
        assert_eq!(cubic(f, 4, 9.0).0, 4.0);
    }
}
