#!/usr/bin/env python3
"""One-time held-out evaluation of the frozen Intel ddot (prereg-dot-gemv.md, Q1 freeze)."""
import hashlib, importlib.util, json, os, struct, sys
HERE = os.path.dirname(os.path.abspath(__file__))
frozen = open(os.path.join(HERE, 'dot_kernel.frozen.sha256')).read().split()[0]
actual = hashlib.sha256(open(os.path.join(HERE, 'dot_kernel.py'), 'rb').read()).hexdigest()
assert actual == frozen, 'dot_kernel.py changed since the freeze'
spec = importlib.util.spec_from_file_location('dk', os.path.join(HERE, 'dot_kernel.py')); dk = importlib.util.module_from_spec(spec); spec.loader.exec_module(dk)
def f64(p):
    b = open(p, 'rb').read(); return list(struct.unpack('<%dd' % (len(b)//8), b))
pins, out = sys.argv[1], sys.argv[2]
d = os.path.join(pins, 'arithmetic-order', 'ubuntu-24.04', 'compatible')
cases = {c['n']: c for c in json.load(open(os.path.join(d, 'arithmetic-order.json')))['cases'] if c['kind'] == 'dot-order'}
report, total, ok = {}, 0, 0
for n in sorted(k for k in cases if k >= 51):
    c = cases[n]
    X = f64(os.path.join(d, c['x']['file'])); Y = f64(os.path.join(d, c['y']['file'])); D = f64(os.path.join(d, c['dots']['file']))
    hits = sum(struct.pack('<d', dk.ddot(X[k*n:(k+1)*n], Y[k*n:(k+1)*n], fused=True)) == struct.pack('<d', D[k]) for k in range(25, 50))
    report[n] = [hits, 25]
    total += 25; ok += hits
report['total'] = [ok, total]
json.dump({'kernelSha256': frozen, 'heldOut': report}, open(out, 'w'), indent=1)
print('held-out draws 26-50 from 51 elements:', ok, '/', total, '; lengths with misses:', [n for n, v in report.items() if n != 'total' and v[0] != v[1]])
