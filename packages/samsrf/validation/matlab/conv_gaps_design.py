"""Courses of record_conv_gaps.m (sections B and C), the competing models, and the
discrimination check run before any MATLAB recording."""
import math, json, sys
DRAWS = 12
M31 = 2147483647
class Stream:
    def __init__(self, seed): self.s = seed
    def next(self):
        self.s = (self.s * 48271) % M31
        return self.s / M31
def course(n, taps, kind, density, seed):
    st = Stream(seed)
    nonzero = [i for i in range(n) if st.next() < density]
    kernel = [(1 + 0.5 * st.next()) / (1 + t) for t in range(taps)]
    draws = []
    for d in range(DRAWS):
        re, im = [], []
        for _ in nonzero:
            re.append(2 * st.next() - 1)
            im.append(2 * st.next() - 1 if kind == 'complex' else 0.0)
        draws.append((re, im))
    return nonzero, kernel, draws
# (section, n, taps, kind, density, seed)
B = [('threshold-decide', n, 33, 'complex', 0.20, 1000 + n) for n in range(990, 995)] + \
    [('threshold-confirm', n, 17, 'complex', 0.20, 2000 + n) for n in range(1006, 1011)] + \
    [('threshold-real', n, 33, 'real', 0.20, 3000 + n) for n in (2016, 2017)] + \
    [('blocks-decide', n, 33, 'complex', 0.20, 4000 + n) for n in (4063, 4064, 4065)] + \
    [('blocks-confirm', n, 65, 'complex', 0.20, 5000 + n) for n in (4031, 4032, 4033)] + \
    [('blocks-confirm', n, 33, 'real', 0.20, 6000 + n) for n in (8159, 8160, 8161)] + \
    [('control', 2048, 33, 'complex', 0.20, 7001), ('control', 4096, 17, 'real', 0.20, 7002)]
C = [('short-heldout', 1300, t, 'complex', 0.20, 8000 + t) for t in (2, 4, 6, 7)] + \
    [('short-heldout', 2500, t, 'real', 0.20, 8100 + t) for t in (2, 4, 6, 7)] + \
    [('short-heldout', 300, 6, 'complex', 0.20, 8201), ('short-heldout', 250, 7, 'real', 0.20, 8202),
     ('short-heldout', 400, 5, 'real', 0.20, 8203), ('short-heldout', 40, 4, 'real', 0.15, 8204),
     ('short-dense', 1100, 4, 'complex', 0.60, 8301), ('short-dense', 900, 7, 'real', 0.60, 8302)]
def law(M, strict_blocks, size):
    base = 8192 // size
    def unfused(i, k, n, T):
        if T <= 16: return True
        f = n + T - 1
        if f < M: return False
        P = base
        while (f >= 8 * P) if strict_blocks else (-(-f // P) > 8): P *= 2
        if k % P >= P - 16: return i >= (k // P + 1) * P - 16
        if k >= P:
            B_ = k // P * P; return B_ <= i + T - 1 < B_ + 16
        return False
    return unfused
def sparse(values, nonzero, kernel, n, unfused):
    T = len(kernel); out = []
    for k in range(n):
        s = 0.0
        for i, v in zip(nonzero, values):
            if i > k: break
            if i + T <= k: continue
            t = kernel[k - i]
            s = (s + v * t) if unfused(i, k, n, T) else math.fma(v, t, s)
        out.append(s)
    return out
def tap_order(values, nonzero, kernel, n, fused):
    y = [0.0] * n
    for i, v in zip(nonzero, values): y[i] = v
    out = []
    for k in range(n):
        s = 0.0
        for j in range(min(len(kernel), k + 1)):
            s = math.fma(y[k - j], kernel[j], s) if fused else s + y[k - j] * kernel[j]
        out.append(s)
    return out
def parts(row, model):
    _, n, T, kind, dens, seed = row
    nz, h, draws = course(n, T, kind, dens, seed)
    res = []
    for re, im in draws:
        res.append(model(re, nz, h, n)); res.append(model(im, nz, h, n))
    return res, nz
def differ(a, b):
    return sum(x != y for pa, pb in zip(a, b) for x, y in zip(pa, pb))
if __name__ == '__main__':
    report = []
    for row in B:
        size = 16 if row[3] == 'complex' else 8
        cands = {}
        for M in ([1023, 1024, 1025, 1026] if size == 16 else [2048, 2049]):
            for strict in (False, True):
                cands[(M, strict)] = parts(row, lambda v, nz, h, n, M=M, s=strict: sparse(v, nz, h, n, law(M * (1 if size == 16 else 1), s, size)))[0]
        nz = parts(row, lambda v, nz, h, n: [0.0] * n)[1]
        keys = sorted(cands)
        pairs = {f'{a}-{b}': differ(cands[a], cands[b]) for a, b in zip(keys, keys[1:])}
        report.append((row, len(nz), pairs))
        print(row, 'nnz', len(nz), 'sparse', 4 * len(nz) < row[1], pairs, flush=True)
    for row in C:
        idx = parts(row, lambda v, nz, h, n: sparse(v, nz, h, n, lambda *a: True))[0]
        tap_unf = parts(row, lambda v, nz, h, n: tap_order(v, nz, h, n, False))[0]
        tap_fused = parts(row, lambda v, nz, h, n: tap_order(v, nz, h, n, row[1] > 16))[0]
        nz = parts(row, lambda v, nz, h, n: [0.0] * n)[1]
        print(row, 'nnz', len(nz), 'sparse', 4 * len(nz) < row[1], 'index-unfused vs tap-unfused', differ(idx, tap_unf), 'vs port(tap, fused>16)', differ(idx, tap_fused), 'tap-unfused vs port', differ(tap_unf, tap_fused), flush=True)
