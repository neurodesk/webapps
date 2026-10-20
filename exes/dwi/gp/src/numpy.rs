// SPDX-License-Identifier: BSD-3-Clause
// Ports numpy code: Copyright (c) 2005-2025, NumPy Developers (LICENSE-NUMPY).
//! numpy's summation order for a reduction along a contiguous axis
//! (`pairwise_sum` in numpy/_core/src/umath/loops_utils.h.src, numpy 2.3.5).
//!
//! scikit-learn's `np.mean`, `np.std` and `np.log(np.diag(L)).sum()` reduce along a
//! contiguous axis of length n (89 for M0), so numpy uses this order there.

/// numpy's block size for the unrolled sum (`PW_BLOCKSIZE`).
const PW_BLOCKSIZE: usize = 128;

/// The sum of `a` in numpy's pairwise order.
pub fn pairwise_sum(a: &[f64]) -> f64 {
    let n = a.len();
    if n < 8 {
        let mut res = 0.0;
        for &v in a {
            res += v;
        }
        res
    } else if n <= PW_BLOCKSIZE {
        let mut r = [0.0f64; 8];
        r.copy_from_slice(&a[..8]);
        let end = n - (n % 8);
        let mut i = 8;
        while i < end {
            for (j, rj) in r.iter_mut().enumerate() {
                *rj += a[i + j];
            }
            i += 8;
        }
        let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        for &v in &a[end..] {
            res += v;
        }
        res
    } else {
        let mut n2 = n / 2;
        n2 -= n2 % 8;
        pairwise_sum(&a[..n2]) + pairwise_sum(&a[n2..])
    }
}

#[cfg(test)]
mod tests {
    use super::pairwise_sum;

    #[test]
    fn exact_on_integers() {
        let a: Vec<f64> = (1..=300).map(f64::from).collect();
        assert_eq!(pairwise_sum(&a), 45150.0);
        assert_eq!(pairwise_sum(&a[..5]), 15.0);
        assert_eq!(pairwise_sum(&a[..89]), 4005.0);
    }

    #[test]
    fn block_order_differs_from_sequential() {
        // 1, then eight values that cancel only when added in numpy's order.
        let a = [1e16, 1.0, -1e16, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        let seq: f64 = a.iter().sum();
        // r = [1e16, 1, -1e16, 1, 0, 0, 0, 0]; ((1e16 + 1) + (-1e16 + 1)) + 0 = 0, + 1 = 1
        assert_eq!(pairwise_sum(&a), 1.0);
        assert_eq!(seq, 2.0);
    }
}
