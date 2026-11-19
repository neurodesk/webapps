#!/usr/bin/env python3
import importlib.util, json, os, struct, sys
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('gk', os.path.join(HERE, 'gemv_kernel.py')); gk = importlib.util.module_from_spec(spec); spec.loader.exec_module(gk)
BIG = 2.0 ** 70
def f64(p):
    b = open(p, 'rb').read(); return list(struct.unpack('<%dd' % (len(b)//8), b))
same = lambda a, b: struct.pack('<d', a) == struct.pack('<d', b)
def evaluate(pins, host, model, draws):
    d = os.path.join(pins, 'cgg', host)
    out = {}
    for c in json.load(open(os.path.join(d, 'gemv.json')))['cases']:
        n, m = c['n'], c['m']
        pairs = [(i, k) for i in range(n) for k in range(i + 1, n)]
        counts = f64(os.path.join(d, c['counts']['file']))
        p = len(pairs)
        assert len(counts) == p * m
        fp = [0] * m
        for idx, (i, k) in enumerate(pairs):
            a = [1.0] * n; a[i] = BIG; a[k] = -BIG
            y = [1.0] * n
            for j in range(m):
                fp[j] += same(model(y, a, j, m), counts[j * p + idx])
        ys = f64(os.path.join(d, c['ys']['file'])); As = f64(os.path.join(d, c['As']['file'])); prods = f64(os.path.join(d, c['products']['file']))
        dr = [0] * m
        for dd in draws:
            y = ys[dd * n:(dd + 1) * n]
            for j in range(m):
                a = As[(dd * m + j) * n:(dd * m + j + 1) * n]
                dr[j] += same(model(y, a, j, m), prods[j * 100 + dd])
        out[c['id']] = {'fingerprints': [fp, p], 'draws': [dr, len(draws)]}
    return out
if __name__ == '__main__':
    pins, which = sys.argv[1], sys.argv[2]
    if which == 'amd-control':
        r = evaluate(pins, 'ubuntu-22.04', gk.amd, range(100))
    elif which == 'intel-discovery':
        r = evaluate(pins, 'ubuntu-24.04', gk.intel, range(50))
    elif which == 'intel-discovery-amd-model':
        r = evaluate(pins, 'ubuntu-24.04', gk.amd, range(50))
    for cid, v in r.items():
        fp, p = v['fingerprints']; dr, nd = v['draws']
        print(f"{cid:14s} fingerprints per column {fp} of {p}; draws per column {dr} of {nd}")
