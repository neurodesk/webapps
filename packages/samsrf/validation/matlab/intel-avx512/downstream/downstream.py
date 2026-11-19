#!/usr/bin/env python3
"""Q3 (Intel corr, arithmetic-order) and Q4 (Intel double CF profiles, revcor) with the
frozen Q1/Q2 kernels and correctly rounded norms (prereg-dot-gemv.md). AMD controls use
the port's AMD kernels. Misses are classified, never refitted."""
import hashlib, importlib.util, json, math, os, struct, sys
from fractions import Fraction
from decimal import Decimal, getcontext
getcontext().prec = 90
HERE = os.path.dirname(os.path.abspath(__file__)); UP = os.path.dirname(HERE)
def load(name, path, frozen=None):
    if frozen:
        want = open(frozen).read().split()[0]
        assert hashlib.sha256(open(path, 'rb').read()).hexdigest() == want, f'{path} changed since its freeze'
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
dk = load('dk', os.path.join(UP, 'dot', 'dot_kernel.py'), os.path.join(UP, 'dot', 'dot_kernel.frozen.sha256'))
gk = load('gk', os.path.join(UP, 'gemv', 'gemv_kernel.py'), os.path.join(UP, 'gemv', 'gemv_kernel.frozen.sha256'))
f1 = load('f1', os.path.join(UP, 'dnrm2_candidates.py'))
f2 = load('f2', os.path.join(UP, 'dnrm2_family2.py'))
same = lambda a, b: struct.pack('<d', a) == struct.pack('<d', b)
def f64(p):
    b = open(p, 'rb').read(); return list(struct.unpack('<%dd' % (len(b)//8), b))
def mean(v):
    return f1.mean_double(v) / len(v)
def ddot_amd(x, y):
    if len(x) < 51:
        return f1.ddot_pairs(x, y)
    n = len(x); r = [[0.0, 0.0] for _ in range(4)]; i = 0
    while i + 8 <= n:
        for u in range(4):
            for w in range(2):
                r[u][w] += x[i + 2*u + w] * y[i + 2*u + w]
        i += 8
    while i + 2 <= n:
        r[0][0] += x[i] * y[i]; r[0][1] += x[i+1] * y[i+1]; i += 2
    if i < n:
        r[0][0] += x[i] * y[i]
    return (((r[0][0] + r[1][0]) + r[2][0]) + r[3][0]) + (((r[0][1] + r[1][1]) + r[2][1]) + r[3][1])
def ddot_intel(x, y):
    return f1.ddot_pairs(x, y) if len(x) < 51 else dk.ddot(x, y, fused=True)
def clamp(r):
    return r / abs(r) if abs(r) > 1.0 else r
def corr(x, y, dot, norm):
    my, mx = mean(y), mean(x)
    yc = [v - my for v in y]; xc = [v - mx for v in x]
    return clamp(dot(xc, yc) / norm(xc) / norm(yc)), xc, yc
def tie_distance(values):
    """Distance of the exact norm from the nearest rounding midpoint, in ULP."""
    s = sum(Fraction(t) * Fraction(t) for t in values)
    c = f2.cr_sqrt(s)
    if c == 0.0:
        return None
    r = (Decimal(s.numerator) / Decimal(s.denominator)).sqrt()
    u = Decimal(math.ulp(c))
    lo = (Decimal(math.nextafter(c, 0.0)) + Decimal(c)) / 2
    hi = (Decimal(c) + Decimal(math.nextafter(c, math.inf))) / 2
    return float(min(abs(r - lo), abs(r - hi)) / u)

def q3(pins, host, dot, norm):
    d = os.path.join(pins, 'arithmetic-order', host, 'compatible')
    rows = {}
    misses = []
    for c in json.load(open(os.path.join(d, 'arithmetic-order.json')))['cases']:
        if c['kind'] != 'corr':
            continue
        n, k = c['x']['shape']
        X = f64(os.path.join(d, c['x']['file'])); Y = f64(os.path.join(d, c['y']['file'])); R = f64(os.path.join(d, c['r']['file']))
        hits = 0
        for j in range(k):
            r, xc, yc = corr(X[j*n:(j+1)*n], Y[j*n:(j+1)*n], dot, norm)
            if same(r, R[j]):
                hits += 1
            else:
                misses.append({'n': n, 'pair': j, 'tieDistanceX': tie_distance(xc), 'tieDistanceY': tie_distance(yc)})
        rows[n] = [hits, k]
    return rows, misses

def q4(pins, host, gemv, norm):
    d = os.path.join(pins, 'revcor-reference', host)
    cases = json.load(open(os.path.join(d, 'revcor-matrix.json')))['cases']
    out, misses = {}, []
    for c in cases:
        if not (c['kind'] == 'pipeline' and c['analysis'] == 'cf' and c['precision'] == 'double' and c['mapReplayModel']['Smoothing'] == 0):
            continue
        X = f64(os.path.join(d, c['seedCourses']['file'])); volumes, nsvx = c['seedCourses']['shape']
        Ysaved = f64(os.path.join(d, c['savedCourses']['file'])); saved = [int(v) - 1 for v in f64(os.path.join(d, c['savedVertices']['file']))]
        P = f64(os.path.join(d, c['profiles']['file'])); assert c['profiles']['shape'][0] == nsvx
        seeds = []
        for j in range(nsvx):
            col = X[j*volumes:(j+1)*volumes]; m = mean(col)
            cc = [v - m for v in col]
            seeds.append((cc, norm(cc)))
        hits = total = 0
        for i, v in enumerate(saved):
            y = Ysaved[i*volumes:(i+1)*volumes]; my = mean(y); yc = [t - my for t in y]
            ny = norm(yc)
            for j, (cc, nx) in enumerate(seeds):
                r = clamp((gemv(yc, cc, j, nsvx) / ny) / nx)
                e = P[v * nsvx + j]
                total += 1
                if same(r, e):
                    hits += 1
                else:
                    misses.append({'case': c['id'], 'vertex': v, 'seed': j, 'tieDistanceY': tie_distance(yc), 'tieDistanceSeed': tie_distance(cc)})
        out[c['id']] = [hits, total]
    return out, misses

if __name__ == '__main__':
    pins, report_path = sys.argv[1], sys.argv[2]
    report = {}
    a3, m3a = q3(pins, 'ubuntu-22.04', ddot_amd, f1.ref_nrm2)
    report['Q3 AMD control'] = {'byLength': a3, 'misses': m3a}
    i3, m3 = q3(pins, 'ubuntu-24.04', ddot_intel, f2.cr_norm)
    report['Q3 Intel'] = {'byLength': i3, 'misses': m3}
    a4, m4a = q4(pins, 'ubuntu-22.04', gk.amd, f1.ref_nrm2)
    report['Q4 AMD control'] = {'byCase': a4, 'misses': m4a[:20], 'missCount': len(m4a)}
    i4, m4 = q4(pins, 'ubuntu-24.04', gk.intel, f2.cr_norm)
    report['Q4 Intel'] = {'byCase': i4, 'misses': m4, 'missCount': len(m4)}
    json.dump(report, open(report_path, 'w'), indent=1)
    def tot(rows):
        return sum(v[0] for v in rows.values()), sum(v[1] for v in rows.values())
    print('Q3 AMD control (all lengths):', tot(a3), 'misses', len(m3a))
    long_i = {n: v for n, v in i3.items() if n >= 51}; short_i = {n: v for n, v in i3.items() if n < 51}
    print('Q3 Intel 51-250:', tot(long_i), '| replay 25-50:', tot(short_i))
    for m in m3: print('   Q3 Intel miss', m)
    print('Q4 AMD control:', tot(a4), 'misses', len(m4a))
    print('Q4 Intel:', tot(i4), 'misses', len(m4))
    for m in m4[:20]: print('   Q4 Intel miss', m)
