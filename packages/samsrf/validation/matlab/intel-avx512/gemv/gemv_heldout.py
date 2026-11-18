#!/usr/bin/env python3
"""One-time held-out evaluation of the frozen Intel y'*A (prereg-dot-gemv.md, Q2 freeze)."""
import hashlib, importlib.util, json, os, struct, sys
HERE = os.path.dirname(os.path.abspath(__file__))
frozen = open(os.path.join(HERE, 'gemv_kernel.frozen.sha256')).read().split()[0]
assert hashlib.sha256(open(os.path.join(HERE, 'gemv_kernel.py'), 'rb').read()).hexdigest() == frozen, 'gemv_kernel.py changed since the freeze'
spec = importlib.util.spec_from_file_location('gk', os.path.join(HERE, 'gemv_kernel.py')); gk = importlib.util.module_from_spec(spec); spec.loader.exec_module(gk)
def f64(p):
    b = open(p, 'rb').read(); return list(struct.unpack('<%dd' % (len(b)//8), b))
pins, out = sys.argv[1], sys.argv[2]
d = os.path.join(pins, 'cgg', 'ubuntu-24.04')
report, ok, total = {}, 0, 0
for c in json.load(open(os.path.join(d, 'gemv.json')))['cases']:
    n, m = c['n'], c['m']
    ys = f64(os.path.join(d, c['ys']['file'])); As = f64(os.path.join(d, c['As']['file'])); prods = f64(os.path.join(d, c['products']['file']))
    hits = 0
    for dd in range(50, 100):
        y = ys[dd * n:(dd + 1) * n]
        for j in range(m):
            a = As[(dd * m + j) * n:(dd * m + j + 1) * n]
            hits += struct.pack('<d', gk.intel(y, a, j, m)) == struct.pack('<d', prods[j * 100 + dd])
    report[c['id']] = [hits, 50 * m]
    ok += hits; total += 50 * m
report['total'] = [ok, total]
json.dump({'kernelSha256': frozen, 'heldOut': report}, open(out, 'w'), indent=1)
print('held-out draws 50-99:', ok, '/', total, '; shapes with misses:', [k for k, v in report.items() if k != 'total' and v[0] != v[1]])
