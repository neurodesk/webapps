#!/usr/bin/env python3
import json, sys, itertools, math
from pathlib import Path
from reflector_probe import cases, eq, mul, reflector, cr_nrm2
from update_probe import dot, trim, leading
UPDATES = [('product', r, i) for r, i in itertools.product(range(3), repeat=2)] + [('fused', r, i) for r, i in itertools.product(range(2), repeat=2)]

def update(c, v, t, mode):
    if mode[0] == 'product':
        p = mul(v, t, mode[1], mode[2])
        return complex(c.real - p.real, c.imag - p.imag)
    r = math.fma(v.imag, t.imag, math.fma(-v.real, t.real, c.real)) if mode[1] == 0 else math.fma(-v.real, t.real, math.fma(v.imag, t.imag, c.real))
    i = math.fma(-v.imag, t.real, math.fma(-v.real, t.imag, c.imag)) if mode[2] == 0 else math.fma(-v.real, t.imag, math.fma(-v.imag, t.real, c.imag))
    return complex(r, i)
if __name__ == '__main__':
    cs = list(cases('ubuntu-22.04-3'))
    results = []
    for um in UPDATES:
        counts = dict.fromkeys(['R12', 'R22', 'tau2', 'v2', 'all'], 0)
        misses = []
        for c in cs:
            v = trim([1 + 0j] + c['factor'][0][1:])
            other = c['columns'][c['pivot'][1]]
            r, t = leading(other[0], dot(v, other[:len(v)], ('product', 0, 0)), c['tau'][0], (1, 1))
            tail = [update(z, vi, t, um) for vi, z in zip(v[1:], other[1:])] + other[len(v):]
            b, tau, vs = reflector(tail, cr_nrm2, (1, 2))
            checks = [eq(r, c['factor'][1][0]), eq(b, c['factor'][1][1]), eq(tau, c['tau'][1]), all((eq(a, b) for a, b in zip(vs, c['factor'][1][2:])))]
            for k, ok in zip(counts, checks + [all(checks)]):
                counts[k] += ok
            if not all(checks):
                misses.append({'id': c['id'], 'checks': checks})
        results.append({'update': um, 'counts': counts, 'misses': misses})
    results.sort(key=lambda r: r['counts']['all'], reverse=True)
    Path(sys.argv[1]).write_text(json.dumps(results, indent=2) + '\n')
    for r in results:
        print(r['update'], r['counts'], r['misses'][:2])
