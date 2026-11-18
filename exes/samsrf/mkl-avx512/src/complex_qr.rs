//! Test-only candidate for finite complex-double, two-column QR on the recorded Intel
//! AVX512_E1 branch. Derived from staged QR values and FPRev trees, not fitted maps.
//! The norm is the existing correctly-rounded candidate, including its known limitations.
use num_complex::Complex64 as C;

fn product(a: C, b: C) -> C {
    C::new(
        a.re.mul_add(b.re, -a.im * b.im),
        a.re.mul_add(b.im, a.im * b.re),
    )
}

fn norm(x: &[C]) -> f64 {
    crate::nrm2(&x.iter().flat_map(|z| [z.re, z.im]).collect::<Vec<_>>())
}

// LAPACK's robust reciprocal, as in the shipped LARFG, before fused complex scaling.
fn reciprocal(z: C) -> C {
    let (mut a, mut b, mut c, mut d) = (1.0, 0.0, z.re, z.im);
    let mut scale = 1.0;
    let unit = f64::EPSILON * 0.5;
    let tiny = f64::MIN_POSITIVE * 2.0 / unit;
    let blow_up = 2.0 / (unit * unit);
    let cd = c.abs().max(d.abs());
    if cd >= 0.5 * f64::MAX {
        c *= 0.5;
        d *= 0.5;
        scale *= 0.5;
    }
    if cd <= tiny {
        c *= blow_up;
        d *= blow_up;
        scale *= blow_up;
    }
    let swapped = z.im.abs() > z.re.abs();
    if swapped {
        std::mem::swap(&mut a, &mut b);
        std::mem::swap(&mut c, &mut d);
    }
    let r = d / c;
    let t = 1.0 / (c + d * r);
    let part = |a: f64, b: f64| {
        if r != 0.0 {
            let br = b * r;
            if br != 0.0 {
                (a + br) * t
            } else {
                a * t + (b * t) * r
            }
        } else {
            (a + d * (b / c)) * t
        }
    };
    let (p, q) = (part(a, b), part(b, -a));
    C::new(p * scale, if swapped { -q * scale } else { q * scale })
}

fn reflector(x: &mut [C]) -> C {
    let mut alpha = x[0];
    let mut xn = norm(&x[1..]);
    if xn == 0.0 && alpha.im == 0.0 {
        return C::new(0.0, 0.0);
    }
    let diagonal = |a: C, n: f64| {
        let w = a.re.abs().max(a.im.abs()).max(n.abs());
        let (ar, ai, nr) = (a.re.abs() / w, a.im.abs() / w, n.abs() / w);
        -(w * (ar * ar + ai * ai + nr * nr).sqrt()).copysign(a.re)
    };
    let mut beta = diagonal(alpha, xn);
    let mut rescaled = 0;
    while beta.abs() < crate::RESCALE && rescaled < 20 {
        let inv = 1.0 / crate::RESCALE;
        for z in &mut x[1..] {
            *z = C::new(z.re * inv, z.im * inv);
        }
        alpha = C::new(alpha.re * inv, alpha.im * inv);
        beta *= inv;
        rescaled += 1;
    }
    if rescaled > 0 {
        xn = norm(&x[1..]);
        beta = diagonal(alpha, xn);
    }
    let half = if (beta - alpha.re).is_finite() {
        1.0
    } else {
        0.5
    };
    let (ah, bh) = (C::new(alpha.re * half, alpha.im * half), beta * half);
    let tau = C::new((bh - ah.re) / bh, -ah.im / bh);
    let inv = reciprocal(C::new(ah.re - bh, ah.im));
    let inv = C::new(inv.re * half, inv.im * half);
    for z in &mut x[1..] {
        // ZSCAL fuses the real part of the multiplier in both components.
        *z = C::new(
            z.re.mul_add(inv.re, -z.im * inv.im),
            z.im.mul_add(inv.re, z.re * inv.im),
        );
    }
    for _ in 0..rescaled {
        beta *= crate::RESCALE;
    }
    x[0] = C::new(beta, 0.0);
    tau
}

fn dot(v: &[C], c: &[C], rhs: bool, paired: bool) -> C {
    let start = usize::from(rhs);
    let body = c.len() - start;
    let blocked = if paired { body } else { body / 8 * 8 };
    let mut sums = [C::new(0.0, 0.0); 4];
    let term = |i: usize| {
        if i == 0 {
            c[0]
        } else {
            product(v[i - 1].conj(), c[i])
        }
    };
    for i in 0..blocked {
        sums[i % 4] += term(i + start);
    }
    let mut sum = (sums[0] + sums[2]) + (sums[1] + sums[3]);
    for i in blocked..body {
        sum += term(i + start);
    }
    if rhs {
        c[0] + sum
    } else {
        sum
    }
}

fn apply(v: &[C], tau: C, c: &mut [C], rhs: bool, paired: bool) {
    let last = if rhs {
        v.len()
    } else {
        v.iter()
            .rposition(|z| z.re != 0.0 || z.im != 0.0)
            .map_or(0, |i| i + 1)
    };
    let v = &v[..last];
    let t = product(tau.conj(), dot(v, &c[..last + 1], rhs, paired));
    c[0] -= t;
    for (v, c) in v.iter().zip(&mut c[1..]) {
        *c = C::new(
            v.im.mul_add(t.im, (-v.re).mul_add(t.re, c.re)),
            (-v.re).mul_add(t.im, (-v.im).mul_add(t.re, c.im)),
        );
    }
}

fn divide(z: C, r: f64, multiple: bool) -> C {
    if !multiple {
        let denominator = r * r;
        let (ar, bi) = (z.re * r, z.im * r);
        if denominator.is_normal()
            && ar.is_finite()
            && bi.is_finite()
            && (ar != 0.0 || z.re == 0.0)
            && (bi != 0.0 || z.im == 0.0)
        {
            // Retain the zero cross-products: they determine the sign of zero.
            return C::new(
                (ar + z.im * 0.0) / denominator,
                (bi - z.re * 0.0) / denominator,
            );
        }
    }
    let inverse = 1.0 / r;
    if inverse.is_finite() {
        C::new(z.re * inverse, z.im * inverse)
    } else {
        C::new(z.re / r, z.im / r)
    }
}

/// A finite, tall complex design with exactly two columns. More columns require
/// norm downdating and later pivots, neither identified by this experiment.
pub struct Design {
    pub packed: Vec<Vec<C>>,
    pub tau: Vec<C>,
    pub pivot: Vec<usize>,
    pub rank: usize,
}

impl Design {
    pub fn new(columns: &[&[C]]) -> Self {
        assert_eq!(columns.len(), 2, "complex candidate requires two columns");
        let rows = columns[0].len();
        assert!(rows >= 2 && columns.iter().all(|c| c.len() == rows));
        assert!(columns
            .iter()
            .flat_map(|c| c.iter())
            .all(|z| z.re.is_finite() && z.im.is_finite()));
        assert!(
            columns.iter().flat_map(|c| c.iter()).any(|z| z.im != 0.0),
            "complex candidate requires a complex design"
        );
        let pivot = if norm(columns[0]) >= norm(columns[1]) {
            vec![0, 1]
        } else {
            vec![1, 0]
        };
        let mut packed = pivot
            .iter()
            .map(|&i| columns[i].to_vec())
            .collect::<Vec<_>>();
        let t1 = reflector(&mut packed[0]);
        let (first, rest) = packed.split_at_mut(1);
        apply(&first[0][1..], t1, &mut rest[0], false, false);
        let t2 = reflector(&mut packed[1][1..]);
        let tolerance = 10.0 * rows as f64 * f64::EPSILON * packed[0][0].re.abs();
        let rank = (0..2)
            .take_while(|&i| packed[i][i].re.abs() > tolerance)
            .count();
        Self {
            packed,
            tau: vec![t1, t2],
            pivot,
            rank,
        }
    }

    /// One RHS in its original group; odd final columns use the scalar-tail UNMQR tree.
    pub fn solve(&self, y: &[f64], count: usize, index: usize) -> (Vec<C>, Vec<C>) {
        assert_eq!(y.len(), self.packed[0].len());
        assert!(index < count && y.iter().all(|v| v.is_finite()));
        let paired = index < count / 2 * 2;
        let mut q = y.iter().map(|&v| C::new(v, 0.0)).collect::<Vec<_>>();
        for i in 0..2 {
            apply(
                &self.packed[i][i + 1..],
                self.tau[i],
                &mut q[i..],
                true,
                paired,
            );
        }
        let mut x = [C::new(0.0, 0.0); 2];
        if self.rank == 2 {
            x[1] = divide(q[1], self.packed[1][1].re, count > 1);
        }
        if self.rank > 0 {
            let mut z = q[0];
            if self.rank == 2 {
                let a = self.packed[1][0];
                let b = x[1];
                z = if count == 1 {
                    z - product(a, b)
                } else {
                    C::new(
                        a.im.mul_add(b.im, (-a.re).mul_add(b.re, z.re)),
                        (-a.im).mul_add(b.re, (-a.re).mul_add(b.im, z.im)),
                    )
                };
            }
            x[0] = divide(z, self.packed[0][0].re, count > 1);
        }
        let mut ordered = vec![C::new(0.0, 0.0); 2];
        for (i, &p) in self.pivot.iter().enumerate() {
            ordered[p] = x[i];
        }
        (ordered, q)
    }
}
