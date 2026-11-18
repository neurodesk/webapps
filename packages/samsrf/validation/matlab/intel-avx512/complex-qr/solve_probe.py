#!/usr/bin/env python3
import json, sys, itertools, math
from pathlib import Path
from reflector_probe import cases, eq, mul
from update_probe import dot, leading
from second_probe import update, UPDATES

def div(z, r, mode):
    if mode == 'direct':
        return complex(z.real / r, z.imag / r)
    if mode == 'reciprocal':
        return complex(z.real * (1 / r), z.imag * (1 / r))
    den = r * r
    re = z.real * r
    im = z.imag * r
    if den >= sys.float_info.min and math.isfinite(den) and all((math.isfinite(v) for v in [re, im])) and (re != 0 or z.real == 0) and (im != 0 or z.imag == 0):
        return complex(re / den, im / den)
    return complex(z.real / r, z.imag / r)

def apply(v, tau, c):
    q0, t = leading(c[0], dot(v, c, ('product', 1, 1), c0last=True), tau, (1, 1))
    return [q0] + [update(z, vi, t, ('fused', 0, 1)) for vi, z in zip(v[1:], c[1:])]

def solve(c, qty, dm, um):
    tol = 10 * len(c['y']) * sys.float_info.epsilon * abs(c['factor'][0][0])
    rank = sum((abs(c['factor'][i][i]) > tol for i in range(2)))
    x = [0j, 0j]
    if rank == 2:
        x[1] = div(qty[1], c['factor'][1][1].real, dm)
    if rank >= 1:
        x[0] = div(update(qty[0], c['factor'][1][0], x[1], um) if rank == 2 else qty[0], c['factor'][0][0].real, dm)
    out = [0j, 0j]
    for i, p in enumerate(c['pivot']):
        out[p] = x[i]
    return out
if __name__ == '__main__':
    cs = list(cases('ubuntu-22.04-3'))
    qtycounts = [0, 0, 0]
    qtymiss = []
    for c in cs:
        q = apply([1 + 0j] + c['factor'][0][1:], c['tau'][0], c['y'])
        q[1:] = apply([1 + 0j] + c['factor'][1][2:], c['tau'][1], q[1:])
        tests = [eq(q[0], c['qty'][0]), eq(q[1], c['qty'][1]), all((eq(a, b) for a, b in zip(q[2:], c['qty'][2:])))]
        qtycounts = [a + b for a, b in zip(qtycounts, tests)]
        if not all(tests):
            qtymiss.append(c['id'])
    print('qty', qtycounts, qtymiss)
    results = []
    for dm, um in itertools.product(['direct', 'reciprocal', 'trsv'], UPDATES):
        misses = []
        for c in cs:
            x = solve(c, c['qty'], dm, um)
            if not all((eq(a, b) for a, b in zip(x, c['beta']))):
                misses.append(c['id'])
        results.append({'divide': dm, 'update': um, 'equal': len(cs) - len(misses), 'misses': misses})
    results.sort(key=lambda r: r['equal'], reverse=True)
    Path(sys.argv[1]).write_text(json.dumps({'qty': qtycounts, 'qty_misses': qtymiss, 'backsolve': results}, indent=2) + '\n')
    for r in results[:8]:
        print(r)
