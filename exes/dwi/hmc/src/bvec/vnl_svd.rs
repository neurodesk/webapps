// SPDX-License-Identifier: BSD-3-Clause
//! The single-precision 3×3 inverse that ITK computes for `antsApplyTransformsToPoints`
//! (`[transform, 1]` at its default float precision): `itk::Matrix<float, 3, 3>::GetInverse`,
//! which is `vnl_matrix_inverse<float>`, the pseudo-inverse V·W⁻¹·Uᵀ of LINPACK's `ssvdc`.
//!
//! A port of VXL as ITK 5.4.5 bundles it (`Modules/ThirdParty/VNL/src/vxl`, ITK commit
//! f51594ad88194a72cdc06a314dafff709fcdc2e9): `core/vnl/algo/vnl_svd.hxx` (constructor with
//! job 21, `zero_out_absolute(0)`, `pinverse`), `core/vnl/vnl_matrix.h` (`operator*`),
//! `core/vnl/vnl_fortran_copy.hxx`, and the f2c translations `v3p/netlib/linpack/ssvdc.c` and
//! `v3p/netlib/blas/{snrm2,sdot,saxpy,sscal,srot,srotg}.c`. VXL is under the licence in
//! `LICENSE-VXL`; LINPACK and the reference BLAS are netlib code.
//!
//! The result must be bit for bit, because QSIPrep prints the transformed points with six
//! significant digits and a one-ulp difference in the inverse moves about a tenth of them.
//! Every operation is `f32`, as the C is on x86-64 (SSE, no excess precision, no FMA), except
//! where f2c's `doublereal` returns and `double sqrt` put a compound expression in `f64`:
//! `scale * sqrt(ssq)` in `snrm2` and `scale * sqrt(...)` in `srotg`. A single `f64` operation
//! rounded to `f32` equals the `f32` operation, so only those two need `f64` here.

/// Column-major 3×3 storage with LINPACK's 1-based (row, column) indices.
#[derive(Clone, Copy)]
struct Fortran([f32; 9]);

impl Fortran {
    fn at(&self, i: usize, j: usize) -> f32 {
        self.0[(i - 1) + 3 * (j - 1)]
    }

    fn set(&mut self, i: usize, j: usize, v: f32) {
        self.0[(i - 1) + 3 * (j - 1)] = v;
    }

    /// Rows `from..=3` of column `j`, as a slice.
    fn col(&self, j: usize, from: usize) -> &[f32] {
        &self.0[3 * (j - 1) + from - 1..3 * j]
    }

    fn col_mut(&mut self, j: usize, from: usize) -> &mut [f32] {
        &mut self.0[3 * (j - 1) + from - 1..3 * j]
    }

    /// Two different columns, mutably.
    fn cols_mut(&mut self, a: usize, b: usize) -> (&mut [f32], &mut [f32]) {
        assert_ne!(a, b);
        let (lo, hi) = (a.min(b), a.max(b));
        let (left, right) = self.0.split_at_mut(3 * (hi - 1));
        let low = &mut left[3 * (lo - 1)..3 * lo];
        let high = &mut right[..3];
        if a < b { (low, high) } else { (high, low) }
    }
}

/// f2c's `r_sign`: |a| with the sign of b, where b = −0 counts as positive.
fn r_sign(a: f32, b: f32) -> f32 {
    let x = if a >= 0.0 { a } else { -a };
    if b >= 0.0 { x } else { -x }
}

fn snrm2(x: &[f32]) -> f32 {
    match x.len() {
        0 => 0.0,
        1 => x[0].abs(),
        _ => {
            let mut scale = 0.0f32;
            let mut ssq = 1.0f32;
            for &xi in x {
                if xi != 0.0 {
                    let absxi = xi.abs();
                    if scale < absxi {
                        let r = scale / absxi;
                        ssq = ssq * (r * r) + 1.0;
                        scale = absxi;
                    } else {
                        let r = absxi / scale;
                        ssq += r * r;
                    }
                }
            }
            (scale as f64 * (ssq as f64).sqrt()) as f32
        }
    }
}

/// `sdot` for n < 5, which is all a 3×3 needs: the clean-up loop.
fn sdot(x: &[f32], y: &[f32]) -> f32 {
    debug_assert!(x.len() < 5 && x.len() == y.len());
    let mut stemp = 0.0f32;
    for (a, b) in x.iter().zip(y) {
        stemp += a * b;
    }
    stemp
}

fn saxpy(a: f32, x: &[f32], y: &mut [f32]) {
    if a == 0.0 {
        return;
    }
    for (yi, xi) in y.iter_mut().zip(x) {
        *yi += a * xi;
    }
}

fn sscal(a: f32, x: &mut [f32]) {
    for xi in x {
        *xi *= a;
    }
}

fn srot(x: &mut [f32], y: &mut [f32], c: f32, s: f32) {
    for (xi, yi) in x.iter_mut().zip(y.iter_mut()) {
        let stemp = c * *xi + s * *yi;
        *yi = c * *yi - s * *xi;
        *xi = stemp;
    }
}

/// `srotg(sa, sb, c, s)`: overwrites sa with r and sb with z, returns (c, s).
fn srotg(sa: &mut f32, sb: &mut f32) -> (f32, f32) {
    let (a, b) = (*sa, *sb);
    let roe = if a.abs() > b.abs() { a } else { b };
    let scale = a.abs() + b.abs();
    let (c, s, r, z);
    if scale == 0.0 {
        c = 1.0;
        s = 0.0;
        r = 0.0;
        z = 0.0;
    } else {
        let r1 = a / scale;
        let r2 = b / scale;
        let mut rr = (scale as f64 * ((r1 * r1 + r2 * r2) as f64).sqrt()) as f32;
        rr *= r_sign(1.0, roe);
        r = rr;
        c = a / r;
        s = b / r;
        let mut zz = 1.0f32;
        if a.abs() > b.abs() {
            zz = s;
        }
        if b.abs() >= a.abs() && c != 0.0 {
            zz = 1.0 / c;
        }
        z = zz;
    }
    *sa = r;
    *sb = z;
    (c, s)
}

/// `ssvdc` with n = p = 3 and job = 21: returns (s, U, V), or `None` when it does not converge.
/// The loops keep LINPACK's indices so the port can be read against the Fortran.
#[allow(clippy::needless_range_loop)]
fn ssvdc(mut x: Fortran) -> Option<([f32; 4], Fortran, Fortran)> {
    const N: usize = 3;
    const P: usize = 3;
    let mut s = [0.0f32; 4]; // 1-based
    let mut e = [0.0f32; 4];
    let mut work = [0.0f32; 4];
    let mut u = Fortran([0.0; 9]);
    let mut v = Fortran([0.0; 9]);
    let maxit = 1000;
    let ncu = N.min(P);
    let nct = (N - 1).min(P);
    let nrt = (P - 2).min(N); // max(0, min(p - 2, n)) for p ≥ 2
    let lu = nct.max(nrt);

    // Reduce x to bidiagonal form, storing the diagonal in s and the super-diagonal in e.
    for l in 1..=lu {
        let lp1 = l + 1;
        if l <= nct {
            s[l] = snrm2(x.col(l, l));
            if s[l] != 0.0 {
                if x.at(l, l) != 0.0 {
                    s[l] = r_sign(s[l], x.at(l, l));
                }
                let r = 1.0 / s[l];
                sscal(r, x.col_mut(l, l));
                x.set(l, l, x.at(l, l) + 1.0);
            }
            s[l] = -s[l];
        }
        for j in lp1..=P {
            if l <= nct && s[l] != 0.0 {
                let t = -sdot(x.col(l, l), x.col(j, l)) / x.at(l, l);
                let (cl, cj) = x.cols_mut(l, j);
                saxpy(t, &cl[l - 1..], &mut cj[l - 1..]);
            }
            e[j] = x.at(l, j);
        }
        if l <= nct {
            for i in l..=N {
                u.set(i, l, x.at(i, l));
            }
        }
        if l <= nrt {
            e[l] = snrm2(&e[lp1..=P]);
            if e[l] != 0.0 {
                if e[lp1] != 0.0 {
                    e[l] = r_sign(e[l], e[lp1]);
                }
                let r = 1.0 / e[l];
                sscal(r, &mut e[lp1..=P]);
                e[lp1] += 1.0;
            }
            e[l] = -e[l];
            if lp1 <= N && e[l] != 0.0 {
                for w in &mut work[lp1..=N] {
                    *w = 0.0;
                }
                for j in lp1..=P {
                    saxpy(e[j], x.col(j, lp1), &mut work[lp1..=N]);
                }
                for j in lp1..=P {
                    let r = -e[j] / e[lp1];
                    saxpy(r, &work[lp1..=N], x.col_mut(j, lp1));
                }
            }
            for i in lp1..=P {
                v.set(i, l, e[i]);
            }
        }
    }

    // The final bidiagonal matrix of order m.
    let mut m = P.min(N + 1);
    let nctp1 = nct + 1;
    let nrtp1 = nrt + 1;
    if nct < P {
        s[nctp1] = x.at(nctp1, nctp1);
    }
    if N < m {
        s[m] = 0.0;
    }
    if nrtp1 < m {
        e[nrtp1] = x.at(nrtp1, m);
    }
    e[m] = 0.0;

    // Generate U.
    for j in nctp1..=ncu {
        for i in 1..=N {
            u.set(i, j, 0.0);
        }
        u.set(j, j, 1.0);
    }
    for ll in 1..=nct {
        let l = nct - ll + 1;
        if s[l] != 0.0 {
            for j in l + 1..=ncu {
                let t = -sdot(u.col(l, l), u.col(j, l)) / u.at(l, l);
                let (cl, cj) = u.cols_mut(l, j);
                saxpy(t, &cl[l - 1..], &mut cj[l - 1..]);
            }
            sscal(-1.0, u.col_mut(l, l));
            u.set(l, l, u.at(l, l) + 1.0);
            for i in 1..l {
                u.set(i, l, 0.0);
            }
        } else {
            for i in 1..=N {
                u.set(i, l, 0.0);
            }
            u.set(l, l, 1.0);
        }
    }

    // Generate V.
    for ll in 1..=P {
        let l = P - ll + 1;
        let lp1 = l + 1;
        if l <= nrt && e[l] != 0.0 {
            for j in lp1..=P {
                let t = -sdot(v.col(l, lp1), v.col(j, lp1)) / v.at(lp1, l);
                let (cl, cj) = v.cols_mut(l, j);
                saxpy(t, &cl[lp1 - 1..], &mut cj[lp1 - 1..]);
            }
        }
        for i in 1..=P {
            v.set(i, l, 0.0);
        }
        v.set(l, l, 1.0);
    }

    // Main iteration loop for the singular values.
    let mm = m;
    let mut iter = 0;
    while m != 0 {
        if iter >= maxit {
            return None;
        }
        // Inspect for negligible elements: kase 1 deflates s(m), 2 splits at s(l), 3 is a QR
        // step, 4 is convergence.
        let mut l = 0;
        for ll in 1..=m {
            l = m - ll;
            if l == 0 {
                break;
            }
            let test = s[l].abs() + s[l + 1].abs();
            let ztest = test + e[l].abs();
            if ztest == test {
                e[l] = 0.0;
                break;
            }
        }
        let kase;
        if l == m - 1 {
            kase = 4;
        } else {
            let lp1 = l + 1;
            let mp1 = m + 1;
            let mut ls = l;
            for lls in lp1..=mp1 {
                ls = m + lp1 - lls;
                if ls == l {
                    break;
                }
                let mut test = 0.0f32;
                if ls != m {
                    test += e[ls].abs();
                }
                if ls != l + 1 {
                    test += e[ls - 1].abs();
                }
                let ztest = test + s[ls].abs();
                if ztest == test {
                    s[ls] = 0.0;
                    break;
                }
            }
            if ls == l {
                kase = 3;
            } else if ls == m {
                kase = 1;
            } else {
                kase = 2;
                l = ls;
            }
        }
        l += 1;

        match kase {
            1 => {
                let mm1 = m - 1;
                let mut f = e[m - 1];
                e[m - 1] = 0.0;
                for kk in l..=mm1 {
                    let k = mm1 + l - kk;
                    let mut t1 = s[k];
                    let (cs, sn) = srotg(&mut t1, &mut f);
                    s[k] = t1;
                    if k != l {
                        f = -sn * e[k - 1];
                        e[k - 1] *= cs;
                    }
                    let (vk, vm) = v.cols_mut(k, m);
                    srot(vk, vm, cs, sn);
                }
            }
            2 => {
                let mut f = e[l - 1];
                e[l - 1] = 0.0;
                for k in l..=m {
                    let mut t1 = s[k];
                    let (cs, sn) = srotg(&mut t1, &mut f);
                    s[k] = t1;
                    f = -sn * e[k];
                    e[k] *= cs;
                    let (uk, ul) = u.cols_mut(k, l - 1);
                    srot(uk, ul, cs, sn);
                }
            }
            3 => {
                let scale = s[m]
                    .abs()
                    .max_c(s[m - 1].abs())
                    .max_c(e[m - 1].abs())
                    .max_c(s[l].abs())
                    .max_c(e[l].abs());
                let sm = s[m] / scale;
                let smm1 = s[m - 1] / scale;
                let emm1 = e[m - 1] / scale;
                let sl = s[l] / scale;
                let el = e[l] / scale;
                let b = ((smm1 + sm) * (smm1 - sm) + emm1 * emm1) / 2.0;
                let c = (sm * emm1) * (sm * emm1);
                let mut shift = 0.0f32;
                if !(b == 0.0 && c == 0.0) {
                    shift = (b * b + c).sqrt();
                    if b < 0.0 {
                        shift = -shift;
                    }
                    shift = c / (b + shift);
                }
                let mut f = (sl + sm) * (sl - sm) + shift;
                let mut g = sl * el;
                for k in l..m {
                    let (cs, sn) = srotg(&mut f, &mut g);
                    if k != l {
                        e[k - 1] = f;
                    }
                    f = cs * s[k] + sn * e[k];
                    e[k] = cs * e[k] - sn * s[k];
                    g = sn * s[k + 1];
                    s[k + 1] *= cs;
                    let (vk, vk1) = v.cols_mut(k, k + 1);
                    srot(vk, vk1, cs, sn);
                    let (cs, sn) = srotg(&mut f, &mut g);
                    s[k] = f;
                    f = cs * e[k] + sn * s[k + 1];
                    s[k + 1] = -sn * e[k] + cs * s[k + 1];
                    g = sn * e[k + 1];
                    e[k + 1] *= cs;
                    if k < N {
                        let (uk, uk1) = u.cols_mut(k, k + 1);
                        srot(uk, uk1, cs, sn);
                    }
                }
                e[m - 1] = f;
                iter += 1;
            }
            _ => {
                // Make the singular value positive, then sort into decreasing order.
                if s[l] < 0.0 {
                    s[l] = -s[l];
                    sscal(-1.0, v.col_mut(l, 1));
                }
                while l != mm && s[l] < s[l + 1] {
                    s.swap(l, l + 1);
                    if l < P {
                        let (a, b) = v.cols_mut(l, l + 1);
                        a.swap_with_slice(b);
                    }
                    if l < N {
                        let (a, b) = u.cols_mut(l, l + 1);
                        a.swap_with_slice(b);
                    }
                    l += 1;
                }
                iter = 0;
                m -= 1;
            }
        }
    }
    Some((s, u, v))
}

/// f2c's `max`/`dmax`: `a >= b ? a : b`.
trait MaxC {
    fn max_c(self, other: Self) -> Self;
}

impl MaxC for f32 {
    fn max_c(self, other: f32) -> f32 {
        if self >= other { self } else { other }
    }
}

/// `vnl_matrix_inverse<float>(m).as_matrix()` for a row-major 3×3, or `None` when ITK would
/// call the matrix singular (its determinant is 0) or `ssvdc` does not converge.
pub(crate) fn inverse(m: &[[f32; 3]; 3]) -> Option<[[f32; 3]; 3]> {
    if determinant(m) == 0.0 {
        return None;
    }
    let mut x = Fortran([0.0; 9]);
    for j in 1..=3 {
        for i in 1..=3 {
            x.set(i, j, m[i - 1][j - 1]);
        }
    }
    let (s, u, v) = ssvdc(x)?;
    // zero_out_absolute(0): a singular value of 0 has a zero inverse.
    let mut winv = [[0.0f32; 3]; 3];
    for k in 0..3 {
        let w = s[k + 1].abs();
        winv[k][k] = if w <= 0.0 { 0.0 } else { 1.0 / w };
    }
    // V · W⁻¹, then · Uᵀ, each with vnl_matrix's dense product: sum = 0, sum += a·b.
    let mut vw = [[0.0f32; 3]; 3];
    for (i, row) in vw.iter_mut().enumerate() {
        for (k, out) in row.iter_mut().enumerate() {
            let mut sum = 0.0f32;
            for (j, wj) in winv.iter().enumerate() {
                sum += v.at(i + 1, j + 1) * wj[k];
            }
            *out = sum;
        }
    }
    let mut inv = [[0.0f32; 3]; 3];
    for (i, row) in inv.iter_mut().enumerate() {
        for (k, out) in row.iter_mut().enumerate() {
            let mut sum = 0.0f32;
            for (j, vwj) in vw[i].iter().enumerate() {
                sum += vwj * u.at(k + 1, j + 1);
            }
            *out = sum;
        }
    }
    Some(inv)
}

/// `vnl_determinant` of a 3×3 (`core/vnl/algo/vnl_determinant.hxx`), term by term.
fn determinant(m: &[[f32; 3]; 3]) -> f32 {
    m[0][0] * m[1][1] * m[2][2] - m[0][0] * m[2][1] * m[1][2] - m[1][0] * m[0][1] * m[2][2]
        + m[1][0] * m[2][1] * m[0][2]
        + m[2][0] * m[0][1] * m[1][2]
        - m[2][0] * m[1][1] * m[0][2]
}
