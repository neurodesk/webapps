//! MATLAB R2023b's real double `x' * y`, `y' * A`, `corr` and the double CF profile
//! (`corr(y, X)`) as MKL 2021.3 ran them on its AVX512_E1 branch on the recorded Intel Xeon
//! hosts: research reference, fitted on the arithmetic-order (Xeon 6975P-C) and
//! constants-gamma-gemv (Xeon 6975P-C) fingerprints and draws, frozen, then compared with
//! their remaining draws, with `corr` (Xeon 6975P-C) and with the double CF profiles of the
//! reverse-correlation recording (Xeon 8370C). Before that, the remaining draws and the CF
//! profiles had been compared only with AMD models, but the `corr` values of 25 to 50
//! elements had already been evaluated with the Intel norm candidate (replay). The `x' * y`
//! kernel's tail lies outside the pre-registered structure family. The record, with these
//! deviations, is packages/samsrf/validation/matlab/intel-avx512/prereg-dot-gemv.md.
//!
//! The norms are the crate's correctly rounded candidate ([`crate::nrm2`]): two recorded
//! `corr` values need a norm one ULP below it near a rounding tie, and the gates pin both.

use crate::{accumulate, fold, grouped_sum, nrm2, sixteen_lanes, Term};

/// The length from which MATLAB hands a real `x' * y` to MKL's `ddot`
/// (`samsrf_core::matlab_math::DDOT_MKL_MIN_LENGTH`, recorded on both hosts).
pub const DDOT_MKL_MIN_LENGTH: usize = samsrf_core::matlab_math::DDOT_MKL_MIN_LENGTH;

/// MATLAB's `mean` of a double vector: one accumulator below 44 elements, otherwise four
/// lanes by index added in order. This is `samsrf_core::precision::mean_double`, which the
/// core keeps private; MATLAB's `mean` is the same on both hosts.
pub fn matlab_mean(values: &[f64]) -> f64 {
    let mut sums = [0.0f64; 4];
    for (index, &value) in values.iter().enumerate() {
        sums[if values.len() >= 44 { index % 4 } else { 0 }] += value;
    }
    sums.iter().sum::<f64>() / values.len() as f64
}

/// MATLAB's real `x' * y`. Below 51 elements MATLAB's own pair tree, the same on both hosts
/// (`samsrf_core::matlab_math::ddot_pairs`). From 51, MKL's `ddot` on the AVX512_E1 branch:
/// 32 lanes (four 8-wide registers) over whole blocks of 32 products, then a chunk of 16 and
/// a chunk of 8 from lane 0 where they fit, the rest (fewer than 8) as one masked chunk from
/// lane 0, every product fused into its lane, folds with strides 8, 16, 4, 2, 1.
pub fn ddot(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len().min(y.len());
    if n < DDOT_MKL_MIN_LENGTH {
        return samsrf_core::matlab_math::ddot_pairs(&x[..n], &y[..n]);
    }
    let mut lanes = [None; 32];
    let blocked = n / 32 * 32;
    for i in 0..blocked {
        lanes[i % 32] = Some(accumulate(lanes[i % 32], Term::Product(x[i], y[i])));
    }
    let mut next = blocked;
    for chunk in [16, 8] {
        if n - next >= chunk {
            for k in 0..chunk {
                lanes[k] = Some(accumulate(lanes[k], Term::Product(x[next + k], y[next + k])));
            }
            next += chunk;
        }
    }
    for (k, i) in (next..n).enumerate() {
        lanes[k] = Some(accumulate(lanes[k], Term::Product(x[i], y[i])));
    }
    fold(&mut lanes, &[8, 16, 4, 2, 1]).expect("at least 51 products")
}

/// MATLAB's double `y' * A` (MKL `dgemv` with `trans`) on the AVX512_E1 branch, one value
/// per column. Column j of m uses the grouped tree of `?ormqr` when it lies in a whole group
/// of four (j < 4 floor(m / 4)), and otherwise the 16-lane single-column tree, both without
/// the `c(1)` term: the same kernels this branch's `?ormqr` applies to right-hand sides.
pub fn gemv_t(y: &[f64], columns: &[&[f64]]) -> Vec<f64> {
    let grouped = columns.len() / 4 * 4;
    columns
        .iter()
        .enumerate()
        .map(|(j, a)| {
            assert_eq!(a.len(), y.len(), "column {j} and y differ in length");
            let sum = if j < grouped {
                let terms: Vec<(f64, f64)> = y.iter().zip(*a).map(|(&y, &a)| (y, a)).collect();
                grouped_sum(&terms)
            } else {
                let terms: Vec<Term> = y.iter().zip(*a).map(|(&y, &a)| Term::Product(y, a)).collect();
                sixteen_lanes(&terms)
            };
            sum.unwrap_or(0.0)
        })
        .collect()
}

fn centred(values: &[f64]) -> Vec<f64> {
    let mean = matlab_mean(values);
    values.iter().map(|value| value - mean).collect()
}

fn limited(r: f64) -> f64 {
    if r.abs() > 1.0 { r / r.abs() } else { r }
}

/// Statistics Toolbox `corr(x, y)` of two real double courses (`samsrf_core::css`'s order):
/// both centred with `mean`, `x' * y`, divided by `norm(x)` and then by `norm(y)`, limited to
/// [-1, 1].
pub fn correlation(x: &[f64], y: &[f64]) -> f64 {
    let (xc, yc) = (centred(x), centred(y));
    limited(ddot(&xc, &yc) / nrm2(&xc) / nrm2(&yc))
}

/// The double unsmoothed CF profile, `corr(y, X)` over the seed courses
/// (`samsrf_core::revcor_cf::Prepared::profile`'s order): `y` and every seed centred with
/// `mean`, `yc' * Xc` as one product, divided by `y`'s norm and then by each seed's, limited
/// to [-1, 1].
pub fn cf_profile(y: &[f64], seeds: &[&[f64]]) -> Vec<f64> {
    let yc = centred(y);
    let ny = nrm2(&yc);
    let centred_seeds: Vec<Vec<f64>> = seeds.iter().map(|seed| centred(seed)).collect();
    let columns: Vec<&[f64]> = centred_seeds.iter().map(Vec::as_slice).collect();
    gemv_t(&yc, &columns)
        .into_iter()
        .zip(&centred_seeds)
        .map(|(product, seed)| limited((product / ny) / nrm2(seed)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draws(seed: u64, n: usize) -> Vec<f64> {
        let mut state = seed;
        (0..n)
            .map(|_| {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                ((state >> 11) as f64 / (1u64 << 53) as f64 - 0.5) * 1000.0
            })
            .collect()
    }

    /// The replica of MATLAB's private `mean` gives the shipped `zscore`'s mean: a `zscore`
    /// built on it equals `samsrf_core::preprocess::zscore` bit for bit at every length.
    #[test]
    fn the_mean_replica_is_the_shipped_mean() {
        for n in 1..300 {
            let x = draws(n as u64, n);
            let mut shipped = x.clone();
            samsrf_core::preprocess::zscore(&mut shipped);
            let mu = matlab_mean(&x);
            let squares: Vec<f64> = x.iter().map(|v| (v - mu) * (v - mu)).collect();
            let sigma = if n > 1 { (samsrf_core::matlab_math::sum(&squares) / (n - 1) as f64).sqrt() } else { 0.0 };
            let sigma = if sigma == 0.0 { 1.0 } else { sigma };
            let replica: Vec<f64> = x.iter().map(|v| (v - mu) / sigma).collect();
            assert_eq!(replica.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), shipped.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "n = {n}");
        }
    }

    #[test]
    fn exact_products_sum_exactly_at_every_length() {
        for n in 1..300 {
            let x: Vec<f64> = (0..n).map(|i| (i % 7) as f64 - 3.0).collect();
            let y: Vec<f64> = (0..n).map(|i| (i % 5) as f64).collect();
            let exact: f64 = x.iter().zip(&y).map(|(a, b)| a * b).sum();
            assert_eq!(ddot(&x, &y), exact, "n = {n}");
            let a: Vec<&[f64]> = (0..6).map(|_| x.as_slice()).collect();
            assert!(gemv_t(&y, &a).iter().all(|&v| v == exact), "n = {n}");
        }
    }

    #[test]
    fn a_course_correlates_perfectly_with_itself() {
        let x = draws(7, 250);
        assert!((correlation(&x, &x) - 1.0).abs() < 1e-15);
        let profile = cf_profile(&x, &[&x, &x, &x, &x, &x]);
        assert!(profile.iter().all(|r| (r - 1.0).abs() < 1e-15), "{profile:?}");
    }
}
