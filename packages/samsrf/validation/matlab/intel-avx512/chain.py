#!/usr/bin/env python3
"""Double real two-column MKL least-squares chain with per-step kernel switches.

Mirrors exes/samsrf/core/src/lstsq.rs (`Factored::new`, `solve`) for real double designs;
each MKL kernel can be swapped for an Intel AVX512_E1 candidate (prereg-chain.md).
"""
import math
from fractions import Fraction

EPS = 2.0 ** -52


def ref_nrm2(values):
    scale, ssq = 0.0, 1.0
    for value in values:
        if value != 0.0:
            a = abs(value)
            if scale < a:
                r = scale / a
                ssq = 1.0 + ssq * r * r
                scale = a
            else:
                r = a / scale
                ssq += r * r
    return scale * math.sqrt(ssq)


def cr_sqrt(s):
    if s == 0:
        return 0.0
    k = (s.numerator.bit_length() - s.denominator.bit_length()) // 2
    scaled = s / Fraction(4) ** k if k >= 0 else s * Fraction(4) ** -k
    d = math.ldexp(math.sqrt(float(scaled)), k)
    if math.isinf(d):
        return d
    for _ in range(8):
        below, above = math.nextafter(d, 0.0), math.nextafter(d, math.inf)
        low = (Fraction(below) + Fraction(d)) / 2
        high = (Fraction(d) + Fraction(above)) / 2
        if low * low <= s <= high * high:
            return d
        d = below if s < low * low else above
    raise AssertionError('no correctly rounded sqrt')


def cr_nrm2(values):
    return cr_sqrt(sum(Fraction(v) * Fraction(v) for v in values))


NRM2 = {'ref': ref_nrm2, 'cr': cr_nrm2}


def lapy2(x, y):
    x, y = abs(x), abs(y)
    w, z = (x, y) if x >= y else (y, x)
    if z == 0.0:
        return w
    q = z / w
    return w * math.sqrt(1.0 + q * q)


class Tree:
    """A summation tree for w = c0 + sum v(i) c(i), i >= 1.

    layout: 'seed' (c0 seeds lane 0, products from lane 0, AMD gemv), 'first' (p1 seeds
    lane 0, the rest from lane 0, c0 added last, AMD ormqr), 'vector' (c0 is slot 0, every
    slot round-robin, Intel gemv), 'c0last' (products round-robin, c0 last, Intel ormqr).
    tail: 'seq' (rest after the fold, in order; AMD lstsq.rs, sequential when no full
    block), 'pow2' (rest in chunks lanes/2, lanes/4, ... from lane 0 before the fold).
    """

    def __init__(self, layout, lanes, strides, tail, fused):
        self.layout, self.lanes, self.strides, self.tail, self.fused = layout, lanes, strides, tail, fused

    def dot(self, v, c):
        """w = c(0) + sum_i v(i) c(i+1), v without its implicit leading 1."""
        products = list(zip(v, c[1:]))
        c0 = c[0]
        fused = self.fused

        def add(acc, term):
            if isinstance(term, float):
                return term if acc is None else acc + term
            a, b = term
            if acc is None:
                return a * b
            return math.fma(a, b, acc) if fused else acc + a * b

        if self.layout in ('seed', 'first'):
            # lstsq.rs tree_sum: the seed, then whole blocks round-robin, strides, rest in order.
            if self.layout == 'seed':
                seed, body = c0, products
            else:
                if not products:
                    return c0
                seed, body = products[0], products[1:]
            blocked = len(body) // self.lanes * self.lanes
            if self.lanes > 1 and blocked > 0:
                sums = [None] * self.lanes
                sums[0] = add(None, seed)
                for i, term in enumerate(body[:blocked]):
                    sums[i % self.lanes] = add(sums[i % self.lanes], term)
                for stride in self.strides:
                    for k in range(self.lanes):
                        if (k // stride) % 2 == 0 and k + stride < self.lanes:
                            if sums[k] is not None and sums[k + stride] is not None:
                                sums[k] = sums[k] + sums[k + stride]
                w = sums[0]
                for term in body[blocked:]:
                    w = add(w, term)
            else:
                w = add(None, seed)
                for term in body:
                    w = add(w, term)
            return c0 + w if self.layout == 'first' else w
        slots = ([c0] if self.layout == 'vector' else []) + products
        acc = [None] * self.lanes
        blocked = len(slots) // self.lanes * self.lanes
        for i, term in enumerate(slots[:blocked]):
            acc[i % self.lanes] = add(acc[i % self.lanes], term)
        rest = slots[blocked:]
        if self.tail == 'pow2':
            chunk = self.lanes // 2
            while rest and chunk >= 1:
                if len(rest) >= chunk:
                    for k, term in enumerate(rest[:chunk]):
                        acc[k] = add(acc[k], term)
                    rest = rest[chunk:]
                chunk //= 2
        consumed = set()
        for stride in self.strides:
            for k in range(self.lanes):
                if (k // stride) % 2 == 0 and k + stride < self.lanes and k not in consumed and k + stride not in consumed:
                    if acc[k] is not None and acc[k + stride] is not None:
                        acc[k] = acc[k] + acc[k + stride]
                    elif acc[k] is None:
                        acc[k] = acc[k + stride]
                    consumed.add(k + stride)
        total = acc[0]
        for term in rest:
            total = add(total, term)
        if self.layout == 'c0last':
            total = c0 if total is None else c0 + total
        return total


AMD_GEMV = Tree('seed', 8, (2, 4, 1), 'seq', False)
AMD_ORMQR1 = Tree('first', 8, (2, 4, 1), 'seq', False)
INTEL_GEMV = lambda fused: Tree('vector', 16, (8, 4, 1, 2), 'pow2', fused)
INTEL_ORMQR1 = lambda fused: Tree('c0last', 16, (8, 4, 1, 2), 'pow2', fused)


def apply(tree, v, tau, c, update_fused, trim, lead_fused=False):
    if trim:
        last = 0
        for i, value in enumerate(v):
            if value != 0.0:
                last = i + 1
        v = v[:last]
    w = tree.dot(v, c)
    t = tau * w
    c[0] = math.fma(-tau, w, c[0]) if lead_fused else c[0] - t
    for i, vi in enumerate(v):
        c[i + 1] = math.fma(-vi, t, c[i + 1]) if update_fused else c[i + 1] - vi * t
    return w


RESCALE = 2.2250738585072014e-308 / (EPS * 0.5)


def larfg(alpha, x, nrm2):
    xnorm = nrm2(x)
    if xnorm == 0.0:
        return alpha, 0.0
    beta = -math.copysign(lapy2(alpha, xnorm), alpha)
    inverse = 1.0 / RESCALE
    rescaled = 0
    if abs(beta) < RESCALE:
        while True:
            rescaled += 1
            for i in range(len(x)):
                x[i] = inverse * x[i]
            beta *= inverse
            alpha *= inverse
            if abs(beta) >= RESCALE or rescaled >= 20:
                break
        xnorm = nrm2(x)
        beta = -math.copysign(lapy2(alpha, xnorm), alpha)
    half = 1.0 if math.isfinite(beta - alpha) else 0.5
    beta_h, alpha_h = beta * half, alpha * half
    tau = (beta_h - alpha_h) / beta_h
    factor = half / (alpha_h - beta_h)
    for i in range(len(x)):
        x[i] = factor * x[i]
    for _ in range(rescaled):
        beta *= RESCALE
    return beta, tau


class Chain:
    def __init__(self, nrm2='ref', gemv=AMD_GEMV, gemv_update_fused=False, ormqr1=AMD_ORMQR1, ormqr_update_fused=False, back_fused=False, lead_fused=False):
        self.lead_fused = lead_fused
        self.nrm2 = NRM2[nrm2]
        self.gemv, self.gemv_update_fused = gemv, gemv_update_fused
        self.ormqr1, self.ormqr_update_fused = ormqr1, ormqr_update_fused
        self.back_fused = back_fused

    def factor(self, columns):
        a = [list(col) for col in columns]
        n, m = len(a), len(a[0])
        pivot = list(range(n))
        norms = [self.nrm2(col) for col in a]
        original = list(norms)
        threshold = math.sqrt(EPS)
        taus, steps = [], []
        for i in range(min(m, n)):
            best = i
            for j in range(i + 1, n):
                if norms[j] > norms[best]:
                    best = j
            for lst in (a, pivot, norms, original):
                lst[i], lst[best] = lst[best], lst[i]
            x = a[i][i + 1:]
            beta, tau = larfg(a[i][i], x, self.nrm2)
            a[i][i + 1:] = x
            a[i][i] = beta
            taus.append(tau)
            for j in range(i + 1, n):
                column = a[j][i:]
                apply(self.gemv, a[i][i + 1:], tau, column, self.gemv_update_fused, True)
                a[j][i:] = column
            for j in range(i + 1, n):
                if norms[j] != 0.0:
                    ratio = abs(a[j][i]) / norms[j]
                    temp = max(0.0, 1.0 - ratio * ratio)
                    quotient = norms[j] / original[j]
                    if temp * quotient * quotient <= threshold:
                        norms[j] = self.nrm2(a[j][i + 1:])
                        original[j] = norms[j]
                    else:
                        norms[j] = norms[j] * math.sqrt(temp)
        diagonal = [a[i][i] for i in range(min(m, n))]
        tolerance = max(m, n) * EPS * abs(diagonal[0]) if diagonal else 0.0
        rank = 0
        for r in diagonal:
            if abs(r) > tolerance:
                rank += 1
            else:
                break
        return {'a': a, 'taus': taus, 'pivot': pivot, 'rank': rank}

    def qty(self, f, y, ormqr=None):
        b = list(y)
        tree = ormqr or self.ormqr1
        for i, tau in enumerate(f['taus']):
            part = b[i:]
            apply(tree, f['a'][i][i + 1:], tau, part, self.ormqr_update_fused, False, self.lead_fused)
            b[i:] = part
        return b

    def back(self, f, b, divide=True):
        a, n, rank = f['a'], len(f['a']), f['rank']
        x = [0.0] * n
        for i in reversed(range(rank)):
            s = b[i]
            for j in range(i + 1, rank):
                s = math.fma(-a[j][i], x[j], s) if self.back_fused else s - a[j][i] * x[j]
            x[i] = s / a[i][i] if divide else s * (1.0 / a[i][i])
        coefficients = [0.0] * n
        for k, column in enumerate(f['pivot']):
            coefficients[column] = x[k]
        return coefficients


class Grouped:
    """Intel AVX512_E1 `?ormqr` for a column inside a group of four right-hand sides:
    16-product chunks, lane k pairs products k and k+8 of the chunk and adds the pair to
    its running sum; the remaining products in chunks of 8, 4, 2, 1 from lane 0; 8 lanes
    folded with strides 4, 1, 2; c(1) added last (fprev_tree.py on run 43127453138).

    pair: 'mul' fl(fl(pa) + fl(pb)), 'fma-b' fma(vb, cb, fl(pa)), 'fma-a' fma(va, ca, fl(pb)).
    rest_fused: remaining products accumulated with fma.
    """

    def __init__(self, pair, rest_fused):
        self.pair, self.rest_fused = pair, rest_fused

    def dot(self, v, c):
        terms = list(zip(v, c[1:]))
        c0 = c[0]
        acc = [None] * 8
        full = len(terms) // 16
        for k in range(full):
            chunk = terms[16 * k:16 * k + 16]
            for lane in range(8):
                (va, ca), (vb, cb) = chunk[lane], chunk[lane + 8]
                if self.pair == 'mul':
                    t = va * ca + vb * cb
                elif self.pair == 'fma-b':
                    t = math.fma(vb, cb, va * ca)
                else:
                    t = math.fma(va, ca, vb * cb)
                acc[lane] = t if acc[lane] is None else acc[lane] + t
        rest = terms[16 * full:]
        size = 8
        while rest and size >= 1:
            if len(rest) >= size:
                for lane, (a, b) in enumerate(rest[:size]):
                    if acc[lane] is None:
                        acc[lane] = a * b
                    else:
                        acc[lane] = math.fma(a, b, acc[lane]) if self.rest_fused else acc[lane] + a * b
                rest = rest[size:]
            size //= 2
        consumed = set()
        for stride in (4, 1, 2):
            for k in range(8):
                if (k // stride) % 2 == 0 and k + stride < 8 and k not in consumed and k + stride not in consumed:
                    if acc[k] is not None and acc[k + stride] is not None:
                        acc[k] = acc[k] + acc[k + stride]
                    elif acc[k] is None:
                        acc[k] = acc[k + stride]
                    consumed.add(k + stride)
        total = acc[0]
        return c0 if total is None else c0 + total


def intel_rhs_tree(count, index, grouped, single):
    """Kernel for right-hand side `index` of `count` on the Intel branch."""
    return grouped if index < count // 4 * 4 else single


def qty_many(chain_, f, ys, kernel_for):
    out = []
    count = len(ys)
    for index, y in enumerate(ys):
        out.append(chain_.qty(f, y, kernel_for(count, index)))
    return out
