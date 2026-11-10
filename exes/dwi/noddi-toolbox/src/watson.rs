// SPDX-License-Identifier: Artistic-2.0
//! The Watson-distributed stick and hindered compartments: ports of the toolbox's
//! `WatsonSHCoeff.m`, `LegendreGaussianIntegral.m` and `WatsonHinderedDiffusionCoeff.m`
//! (Gary Hui Zhang), values only. The toolbox's `NODDI_erfi.m` is not ported:
//! `erfi` is dwi-amico's independent power series.

use dwi_amico::special::{erf, erfi};
use std::f64::consts::PI;

/// `WatsonSHCoeff(k)`: the zonal spherical-harmonic coefficients of orders 0, 2, ..., 12 of
/// the Watson distribution with concentration `k`.
pub fn sh_coeff(k: f64) -> [f64; 7] {
    let mut c = [0.0; 7];
    c[0] = 2.0 * PI.sqrt();
    let (k2, k3, k4, k5, k6) = (k * k, k * k * k, k.powi(4), k.powi(5), k.powi(6));
    if k > 30.0 {
        let l = k.ln() - 30f64.ln();
        let p = [l, l * l, l.powi(3), l.powi(4), l.powi(5), l.powi(6)];
        let fit = |a: [f64; 7]| {
            a[0] + a[1] * p[0] + a[2] * p[1] + a[3] * p[2] + a[4] * p[3] + a[5] * p[4] + a[6] * p[5]
        };
        c[1] = fit([
            7.52308, 0.411538, -0.214588, 0.0784091, -0.023981, 0.00731537, -0.0026467,
        ]);
        c[2] = fit([
            8.93718,
            1.62147,
            -0.733421,
            0.191568,
            -0.0202906,
            -0.00779095,
            0.00574847,
        ]);
        c[3] = fit([
            8.87905, 3.35689, -1.15935, 0.0673053, 0.121857, -0.066642, 0.0180215,
        ]);
        c[4] = fit([
            7.84352, 5.03178, -1.0193, -0.426362, 0.328816, -0.0688176, -0.0229398,
        ]);
        c[5] = fit([
            6.30113, 6.09914, -0.16088, -1.05578, 0.338069, 0.0937157, -0.106935,
        ]);
        c[6] = fit([
            4.65678, 6.30069, 1.13754, -1.38393, -0.0134758, 0.331686, -0.105954,
        ]);
    } else if k > 0.1 {
        let sk = k.sqrt();
        let sk2 = sk * k;
        let sk3 = sk2 * k;
        let sk4 = sk3 * k;
        let sk5 = sk4 * k;
        let sk6 = sk5 * k;
        let erfik = erfi(sk);
        let ierfik = 1.0 / erfik;
        let ek = k.exp();
        let dawsonk = 0.5 * PI.sqrt() * erfik / ek;
        c[1] = 3.0 * sk - (3.0 + 2.0 * k) * dawsonk;
        c[1] = 5f64.sqrt() * c[1] * ek;
        c[1] = c[1] * ierfik / k;
        c[2] = (105.0 + 60.0 * k + 12.0 * k2) * dawsonk;
        c[2] = c[2] - 105.0 * sk + 10.0 * sk2;
        c[2] = 0.375 * c[2] * ek / k2;
        c[2] *= ierfik;
        c[3] = -3465.0 - 1890.0 * k - 420.0 * k2 - 40.0 * k3;
        c[3] *= dawsonk;
        c[3] = c[3] + 3465.0 * sk - 420.0 * sk2 + 84.0 * sk3;
        c[3] = c[3] * (13.0 * PI).sqrt() / 64.0 / k3;
        c[3] /= dawsonk;
        c[4] = 675675.0 + 360360.0 * k + 83160.0 * k2 + 10080.0 * k3 + 560.0 * k4;
        c[4] *= dawsonk;
        c[4] = c[4] - 675675.0 * sk + 90090.0 * sk2 - 23100.0 * sk3 + 744.0 * sk4;
        c[4] = 17f64.sqrt() * c[4] * ek;
        c[4] = c[4] / 512.0 / k4;
        c[4] *= ierfik;
        c[5] = -43648605.0
            - 22972950.0 * k
            - 5405400.0 * k2
            - 720720.0 * k3
            - 55440.0 * k4
            - 2016.0 * k5;
        c[5] *= dawsonk;
        c[5] = c[5] + 43648605.0 * sk - 6126120.0 * sk2 + 1729728.0 * sk3 - 82368.0 * sk4
            + 5104.0 * sk5;
        c[5] = (21.0 * PI).sqrt() * c[5] / 4096.0 / k5;
        c[5] /= dawsonk;
        c[6] = 7027425405.0
            + 3666482820.0 * k
            + 872972100.0 * k2
            + 122522400.0 * k3
            + 10810800.0 * k4
            + 576576.0 * k5
            + 14784.0 * k6;
        c[6] *= dawsonk;
        c[6] = c[6] - 7027425405.0 * sk + 1018467450.0 * sk2 - 302630328.0 * sk3 + 17153136.0 * sk4
            - 1553552.0 * sk5
            + 25376.0 * sk6;
        c[6] = 5.0 * c[6] * ek;
        c[6] = c[6] / 16384.0 / k6;
        c[6] *= ierfik;
    } else {
        c[1] = (4.0 / 3.0 * k + 8.0 / 63.0 * k2) * (PI / 5.0).sqrt();
        c[2] = (8.0 / 21.0 * k2 + 32.0 / 693.0 * k3) * (PI.sqrt() * 0.2);
        c[3] = (16.0 / 693.0 * k3 + 32.0 / 10395.0 * k4) * (PI / 13.0).sqrt();
        c[4] = 32.0 / 19305.0 * k4 * (PI / 17.0).sqrt();
        c[5] = 64.0 * (PI / 21.0).sqrt() * k5 / 692835.0;
        c[6] = 128.0 * PI.sqrt() * k6 / 152108775.0;
    }
    c
}

/// `legendreGaussianIntegral(x, 6)`: ∫₀¹ exp(-x t²) P_2n(t) dt for n = 0..6.
pub fn legendre_gaussian_integral(x: f64) -> [f64; 7] {
    if x > 0.05 {
        let mut i = [0.0; 7];
        let sqrtx = x.sqrt();
        i[0] = PI.sqrt() * erf(sqrtx) / sqrtx;
        let dx = 1.0 / x;
        let emx = -(-x).exp();
        for n in 1..7 {
            i[n] = (emx + (n as f64 - 0.5) * i[n - 1]) * dx;
        }
        [
            i[0],
            -0.5 * i[0] + 1.5 * i[1],
            0.375 * i[0] - 3.75 * i[1] + 4.375 * i[2],
            -0.3125 * i[0] + 6.5625 * i[1] - 19.6875 * i[2] + 14.4375 * i[3],
            0.2734375 * i[0] - 9.84375 * i[1] + 54.140625 * i[2] - 93.84375 * i[3]
                + 50.2734375 * i[4],
            -(63.0 / 256.0) * i[0] + (3465.0 / 256.0) * i[1] - (30030.0 / 256.0) * i[2]
                + (90090.0 / 256.0) * i[3]
                - (109395.0 / 256.0) * i[4]
                + (46189.0 / 256.0) * i[5],
            (231.0 / 1024.0) * i[0] - (18018.0 / 1024.0) * i[1] + (225225.0 / 1024.0) * i[2]
                - (1021020.0 / 1024.0) * i[3]
                + (2078505.0 / 1024.0) * i[4]
                - (1939938.0 / 1024.0) * i[5]
                + (676039.0 / 1024.0) * i[6],
        ]
    } else {
        let (x2, x3, x4) = (x * x, x * x * x, x * x * x * x);
        let (x5, x6) = (x4 * x, x4 * x * x);
        [
            2.0 - 2.0 * x / 3.0 + x2 / 5.0 - x3 / 21.0 + x4 / 108.0,
            -4.0 * x / 15.0 + 4.0 * x2 / 35.0 - 2.0 * x3 / 63.0 + 2.0 * x4 / 297.0,
            8.0 * x2 / 315.0 - 8.0 * x3 / 693.0 + 4.0 * x4 / 1287.0,
            -16.0 * x3 / 9009.0 + 16.0 * x4 / 19305.0,
            32.0 * x4 / 328185.0,
            -64.0 * x5 / 14549535.0,
            128.0 * x6 / 760543875.0,
        ]
    }
}

/// `WatsonHinderedDiffusionCoeff(dPar, dPerp, kappa)`: the parallel and perpendicular
/// diffusivities of the Watson-averaged hindered tensor.
pub fn hindered_coeff(d_par: f64, d_perp: f64, kappa: f64) -> [f64; 2] {
    let d_par_m_d_perp = d_par - d_perp;
    if kappa < 1e-5 {
        let d_par_p2_d_perp = d_par + 2.0 * d_perp;
        let k2 = kappa * kappa;
        [
            d_par_p2_d_perp / 3.0
                + 4.0 * d_par_m_d_perp * kappa / 45.0
                + 8.0 * d_par_m_d_perp * k2 / 945.0,
            d_par_p2_d_perp / 3.0
                - 2.0 * d_par_m_d_perp * kappa / 45.0
                - 4.0 * d_par_m_d_perp * k2 / 945.0,
        ]
    } else {
        let sk = kappa.sqrt();
        let dawsonf = 0.5 * (-kappa).exp() * PI.sqrt() * erfi(sk);
        let factor = sk / dawsonf;
        [
            (-d_par_m_d_perp + 2.0 * d_perp * kappa + d_par_m_d_perp * factor) / (2.0 * kappa),
            (d_par_m_d_perp + 2.0 * (d_par + d_perp) * kappa - d_par_m_d_perp * factor)
                / (4.0 * kappa),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coefficients_are_continuous_across_branches() {
        for k in [0.1, 30.0] {
            let below = sh_coeff(k * (1.0 - 1e-9));
            let above = sh_coeff(k * (1.0 + 1e-9));
            // Near k = 0.1 the toolbox's closed forms of orders 8-12 cancel; it keeps them.
            let orders = if k == 0.1 { 4 } else { 7 };
            for i in 0..orders {
                let scale = below[i].abs().max(1e-12);
                // The k > 30 branch is a fit; the toolbox accepts a small jump there.
                let tolerance = if k == 30.0 { 2e-3 } else { 1e-3 };
                assert!(
                    ((below[i] - above[i]) / scale).abs() < tolerance,
                    "k={k} order {i}: {} vs {}",
                    below[i],
                    above[i]
                );
            }
        }
    }

    #[test]
    fn isotropic_limit() {
        let c = sh_coeff(0.0);
        assert_eq!(c[0], 2.0 * PI.sqrt());
        assert!(c[1..].iter().all(|&v| v == 0.0));
        // With no orientation preference the hindered tensor is isotropic.
        let [a, b] = hindered_coeff(1.7e-9, 0.5e-9, 0.0);
        assert!((a - b).abs() < 1e-24 && (a - 0.9e-9).abs() < 1e-22);
    }

    #[test]
    fn gaussian_integral_matches_quadrature() {
        // Simpson's rule on ∫₀¹ exp(-x t²) P_2n(t) dt, on both branches. Just above 0.05 the
        // toolbox's upward recurrence loses the high orders; b · di of a b0 is 0 and of
        // b = 500 s/mm² is 0.85, so data stays clear of it.
        for x in [0.0, 0.03, 0.05, 0.8, 3.4, 6.8] {
            let got = legendre_gaussian_integral(x);
            for (n, &value) in got.iter().enumerate() {
                let steps = 20000;
                let h = 1.0 / steps as f64;
                let f = |t: f64| (-x * t * t).exp() * dwi_amico::special::legendre(2 * n, t);
                let mut sum = f(0.0) + f(1.0);
                for s in 1..steps {
                    sum += f(s as f64 * h) * if s % 2 == 1 { 4.0 } else { 2.0 };
                }
                // The toolbox's integral runs over [-1, 1]: twice the half range.
                let want = 2.0 * sum * h / 3.0;
                assert!(
                    (value - want).abs() < 1e-6,
                    "x={x} n={n}: {value} vs {want}"
                );
            }
        }
    }
}
