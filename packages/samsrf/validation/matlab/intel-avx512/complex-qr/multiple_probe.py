#!/usr/bin/env python3
import json, sys, math, itertools, inspect
from pathlib import Path
from reflector_probe import cases, eq, mul, reflector, cr_nrm2, arr, P
from update_probe import dot, leading, trim, MODES
from second_probe import update
from solve_probe import div

def mod_dot(v, c, mode, c0last):
    return dot(v, c, mode, c0last=c0last, tail='mod')

def factor(cols):
    norms = [cr_nrm2([p for z in col for p in (z.real, z.imag)]) for col in cols]
    pivot = [0, 1] if norms[0] >= norms[1] else [1, 0]
    a = [list(cols[i]) for i in pivot]
    r, t, v = reflector(a[0], cr_nrm2, (1, 2))
    a[0] = [r] + v
    vt = trim([1 + 0j] + v)
    r12, tt = leading(a[1][0], dot(vt, a[1][:len(vt)], ('product', 1, 1)), t, (1, 1))
    a[1] = [r12] + [update(z, vi, tt, ('fused', 0, 1)) for vi, z in zip(vt[1:], a[1][1:])] + a[1][len(vt):]
    r, t2, v2 = reflector(a[1][1:], cr_nrm2, (1, 2))
    a[1] = [a[1][0], r] + v2
    return (a, [t, t2], pivot)

def records():
    root = P / 'qr-kernels/ubuntu-22.04-3'
    dr = P / 'qr-reference/ubuntu-24.04/compatible'
    meta = {c['id']: c for c in json.loads((dr / 'qr.json').read_text())['cases']}
    for c in json.loads((root / 'kernels.json').read_text())['multiple']:
        if c['precision'] != 'double' or not c['complex']:
            continue
        x = arr(dr, meta[c['design']]['x'])
        cols = [[1 + 0j] * len(x), x]
        if c['order'] != 'ones-first':
            cols.reverse()
        a, taus, pivot = factor(cols)
        rhs = arr(root, c['rhs'])
        qty = arr(root, c['qty'])
        betas = arr(root, c['together'])
        m = len(x)
        yield (c, a, taus, pivot, [rhs[j * m:(j + 1) * m] for j in range(8)], [qty[j * m:(j + 1) * m] for j in range(8)], [betas[j * 2:(j + 1) * 2] for j in range(8)])
if __name__ == '__main__':
    rec = list(records())
    results = []
    for mode in MODES:
        counts = [0, 0, 0]
        misses = []
        for c, a, taus, pivot, ys, qs, bs in rec:
            for j, (y, q) in enumerate(zip(ys, qs)):
                b = list(y)
                for i in range(2):
                    v = [1 + 0j] + a[i][i + 1:]
                    q0, t = leading(b[i], mod_dot(v, b[i:], mode, c0last=True), taus[i], (1, 1))
                    b[i:] = [q0] + [update(z, vi, t, ('fused', 0, 1)) for vi, z in zip(v[1:], b[i + 1:])]
                checks = [eq(b[0], q[0]), eq(b[1], q[1]), all((eq(x, y) for x, y in zip(b[2:], q[2:])))]
                counts = [x + y for x, y in zip(counts, checks)]
                if not all(checks):
                    misses.append([c['id'], j, checks])
        results.append({'dot': mode, 'counts': counts, 'misses': misses})
    results.sort(key=lambda r: sum(r['counts']), reverse=True)
    Path(sys.argv[1]).write_text(json.dumps({'columns': 8 * len(rec), 'results': results}, indent=2) + '\n')
    for r in results:
        print(r['dot'], r['counts'], r['misses'][:2])
