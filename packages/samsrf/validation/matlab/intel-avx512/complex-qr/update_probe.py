#!/usr/bin/env python3
import json, sys, itertools, math
from pathlib import Path
from reflector_probe import cases, eq, mul, reflector, cr_nrm2
MODES = [('product', r, i) for r, i in itertools.product(range(3), repeat=2)] + [('serial', 0, 0), ('serial', 1, 0), ('split', 0, 0), ('split', 1, 0)]

def dot(v, c, mode, lanes=4, block=8, tail='seq', c0last=False):
    xs = [complex(z.real, -z.imag) for z in v]
    ys = list(c)
    if c0last:
        xs, ys = (xs[1:], ys[1:])
    blocked = len(xs) if tail == 'mod' else len(xs) // block * block
    acc = [[0.0] * 4 for _ in range(lanes)]

    def add(k, a, b):
        old = acc[k]
        if mode[0] == 'product':
            p = mul(a, b, mode[1], mode[2])
            old[0] += p.real
            old[1] += p.imag
        elif mode[0] == 'serial':
            if mode[1] == 0:
                old[0] = math.fma(-a.imag, b.imag, math.fma(a.real, b.real, old[0]))
                old[1] = math.fma(a.imag, b.real, math.fma(a.real, b.imag, old[1]))
            else:
                old[0] = math.fma(a.real, b.real, math.fma(-a.imag, b.imag, old[0]))
                old[1] = math.fma(a.real, b.imag, math.fma(a.imag, b.real, old[1]))
        else:
            terms = [(a.real, b.real), (a.imag, b.imag), (a.real, b.imag), (a.imag, b.real)]
            for j, (a, b) in enumerate(terms):
                old[j] = math.fma(a, b, old[j]) if mode[1] else old[j] + a * b
    for i in range(blocked):
        add(i % lanes, xs[i], ys[i])
    for stride in (2, 1) if lanes == 4 else ():
        for k in range(lanes):
            if k // stride % 2 == 0 and k + stride < lanes:
                acc[k] = [a + b for a, b in zip(acc[k], acc[k + stride])]
    for i in range(blocked, len(xs)):
        add(0, xs[i], ys[i])
    r = complex(acc[0][0] - acc[0][1], acc[0][2] + acc[0][3]) if mode[0] == 'split' else complex(acc[0][0], acc[0][1])
    if c0last:
        r = complex(c[0].real + r.real, c[0].imag + r.imag)
    return r

def trim(v):
    n = len(v)
    while n > 1 and v[n - 1] == 0j:
        n -= 1
    return v[:n]

def leading(c, w, tau, tm):
    t = mul(complex(tau.real, -tau.imag), w, *tm)
    return (complex(c.real - t.real, c.imag - t.imag), t)
if __name__ == '__main__':
    cs = list(cases('ubuntu-22.04-3'))
    inputs = []
    for c in cs:
        v = trim([1 + 0j] + c['factor'][0][1:])
        other = c['columns'][c['pivot'][1]]
        inputs.append((c, v, other))
    results = []
    for mode, tm in itertools.product(MODES, itertools.product(range(3), repeat=2)):
        misses = []
        for c, v, other in inputs:
            r, t = leading(other[0], dot(v, other[:len(v)], mode), c['tau'][0], tm)
            if not eq(r, c['factor'][1][0]):
                misses.append(c['id'])
        results.append({'dot': mode, 'temp': tm, 'equal': len(cs) - len(misses), 'misses': misses})
    results.sort(key=lambda r: r['equal'], reverse=True)
    Path(sys.argv[1]).write_text(json.dumps(results, indent=2) + '\n')
    for r in results[:12]:
        print(r['dot'], r['temp'], r['equal'], r['misses'][:3])
