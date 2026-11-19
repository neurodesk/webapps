#!/usr/bin/env python3
"""Evaluate the frozen dnrm2 candidates of prereg-dnrm2.md (sha256 33951f69...).

Usage: python3 -I dnrm2_candidates.py PINS_DIR REPORT_JSON [--held-out]

Without --held-out only the discovery set D is evaluated. With it, H1 and H2 are
evaluated for the candidates that pass D, as the pre-registration allows.
"""
import itertools
import json
import math
import os
import struct
import sys


def f64(path):
    data = open(path, 'rb').read()
    return list(struct.unpack('<%dd' % (len(data) // 8), data))


# ---- candidates -------------------------------------------------------------------------

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


def lane_sum(terms, lanes, strides, tail, fused):
    """Sum of squares of `terms` in the qr-lane-models.py `vector` layout."""
    def add(acc, e):
        if acc is None:
            return e * e
        return math.fma(e, e, acc) if fused else acc + e * e

    acc = [None] * lanes
    blocked = len(terms) if tail == 'mod' else len(terms) // lanes * lanes
    for i, e in enumerate(terms[:blocked]):
        acc[i % lanes] = add(acc[i % lanes], e)
    rest = terms[blocked:]
    if tail == 'pow2':
        chunk = lanes // 2
        while rest and chunk >= 1:
            if len(rest) >= chunk:
                for k, e in enumerate(rest[:chunk]):
                    acc[k] = add(acc[k], e)
                rest = rest[chunk:]
            chunk //= 2
    consumed = set()
    for stride in strides:
        for k in range(lanes):
            if (k // stride) % 2 == 0 and k + stride < lanes and k not in consumed and k + stride not in consumed:
                if acc[k] is not None and acc[k + stride] is not None:
                    acc[k] = acc[k] + acc[k + stride]
                elif acc[k] is None:
                    acc[k] = acc[k + stride]
                consumed.add(k + stride)
    total = acc[0]
    for e in rest:
        total = add(total, e)
    return 0.0 if total is None else total


def make_candidate(lanes, strides, tail, fused, scaling):
    def nrm2(values):
        values = list(values)
        if not values:
            return 0.0
        if scaling == 'none':
            return math.sqrt(lane_sum(values, lanes, strides, tail, fused))
        m = max(abs(v) for v in values)
        if m == 0.0:
            return 0.0
        if scaling == 'divide':
            terms = [v / m for v in values]
        else:
            inverse = 1.0 / m
            terms = [v * inverse for v in values]
        return m * math.sqrt(lane_sum(terms, lanes, strides, tail, fused))
    return nrm2


def candidates():
    yield 'ref', ref_nrm2
    lanes = 1
    while lanes <= 32:
        powers = [2 ** i for i in range(lanes.bit_length() - 1)]
        orders = sorted(set(itertools.permutations(sorted(powers, reverse=True))), reverse=True)
        tails = ('mod',) if lanes == 1 else ('mod', 'seq', 'pow2')
        for strides in orders:
            for tail in tails:
                for fused in (False, True):
                    for scaling in ('none', 'divide', 'reciprocal'):
                        name = f"L{lanes}/{'-'.join(map(str, strides)) or '-'}/{tail}/{'fma' if fused else 'mul'}/{scaling}"
                        yield name, make_candidate(lanes, strides, tail, fused, scaling)
        lanes *= 2


# ---- data -------------------------------------------------------------------------------

def discovery(pins):
    """[(n, x, {host label: norm})] from numerics (Intel 8370C on 22.04) and numerics2
    (Intel 8573C on 24.04); AMD norms kept for the `ref` sanity check."""
    rows = {}
    for run, intel, amd in (('numerics', 'ubuntu-22.04', 'ubuntu-24.04'), ('numerics2', 'ubuntu-24.04', 'ubuntu-22.04')):
        for host, kind in ((intel, 'intel'), (amd, 'amd')):
            d = os.path.join(pins, run, host, 'compatible')
            cases = [c for c in json.load(open(os.path.join(d, 'numerics.json')))['cases'] if c['kind'] == 'blas']
            for c in cases:
                x = f64(os.path.join(d, c['x']['file']))
                norm = f64(os.path.join(d, c['norm']['file']))[0]
                row = rows.setdefault(c['id'], {'x': x, 'values': {}})
                assert row['x'] == x, c['id']
                row['values'][f'{run}-{kind}'] = norm
    return [(len(r['x']), r['x'], r['values']) for _, r in sorted(rows.items(), key=lambda kv: len(kv[1]['x']))]


def mean_double(values):
    sums = [0.0] * 4
    for index, value in enumerate(values):
        sums[index % 4 if len(values) >= 44 else 0] += value
    return (((0.0 + sums[0]) + sums[1]) + sums[2]) + sums[3]


def ddot_pairs(x, y):
    n = min(len(x), len(y))
    total, start = (x[0] * y[0], 1) if n % 2 == 1 else (0.0, 0)
    for i in range(start, n, 2):
        pair = x[i] * y[i] + x[i + 1] * y[i + 1]
        total = pair if i == 0 else total + pair
    return total


def corr(x, y, nrm2):
    n = len(x)
    my = mean_double(y) / n
    yc = [v - my for v in y]
    mx = mean_double(x) / n
    xc = [v - mx for v in x]
    r = ddot_pairs(xc, yc) / nrm2(xc) / nrm2(yc)
    return r / abs(r) if abs(r) > 1.0 else r


def held_out_h1(pins, host):
    d = os.path.join(pins, 'arithmetic-order', host, 'compatible')
    out = []
    for c in json.load(open(os.path.join(d, 'arithmetic-order.json')))['cases']:
        if c['kind'] != 'corr' or not 25 <= c['n'] <= 50:
            continue
        n, k = c['x']['shape']
        x, y, r = f64(os.path.join(d, c['x']['file'])), f64(os.path.join(d, c['y']['file'])), f64(os.path.join(d, c['r']['file']))
        for j in range(k):
            out.append((n, x[j * n:(j + 1) * n], y[j * n:(j + 1) * n], r[j]))
    return out


def dlapy2(x, y):
    xa, ya = abs(x), abs(y)
    w, z = max(xa, ya), min(xa, ya)
    if z == 0.0 or w > 1.7976931348623157e308:
        return w
    return w * math.sqrt(1.0 + (z / w) ** 2)


def held_out_h2(pins, host):
    """(id, x(1), x(2:n), recorded R(1,1)) of the real double designs whose recorded
    chain pivots the x column first."""
    qr_dir = os.path.join(pins, 'qr-reference', 'ubuntu-24.04', 'compatible')
    designs = {c['id']: c for c in json.load(open(os.path.join(qr_dir, 'qr.json')))['cases']}
    d = os.path.join(pins, 'qr-kernels', host)
    out = []
    for c in json.load(open(os.path.join(d, 'kernels.json')))['cases']:
        if c['precision'] != 'double':
            continue
        design = designs[c['id']]
        if design['x']['imaginary']:
            continue
        x = f64(os.path.join(qr_dir, design['x']['file']))
        for chain in c['chains']:
            if chain['variant'] != 'real':
                continue
            pivot = f64(os.path.join(d, chain['pivot']['file']))
            x_column = 1 if c['order'] == 'ones-first' else 2
            if int(pivot[0]) != x_column:
                continue
            factor = f64(os.path.join(d, chain['factor']['file']))
            if chain['factor']['imaginary'] and any(f64(os.path.join(d, chain['factor']['imaginary']))):
                continue
            out.append((c['id'], x[0], x[1:], factor[0]))
    return out


def r11(alpha, rest, nrm2):
    xnorm = nrm2(rest)
    if xnorm == 0.0:
        return alpha
    return -math.copysign(dlapy2(alpha, xnorm), alpha)


def main():
    pins, out = sys.argv[1], sys.argv[2]
    held = '--held-out' in sys.argv
    rows = discovery(pins)
    report = {'discovery': {'lengths': [n for n, _, _ in rows]}}
    intel_agree = all(v['numerics-intel'] == v['numerics2-intel'] for _, _, v in rows)
    report['discovery']['intelHostsAgree'] = intel_agree
    report['discovery']['amdHostsAgree'] = all(v['numerics-amd'] == v['numerics2-amd'] for _, _, v in rows)
    passing, tally = [], {}
    total = 0
    for name, nrm2 in candidates():
        total += 1
        values = [nrm2(x) for _, x, _ in rows]
        intel = sum(v == r['numerics-intel'] and v == r['numerics2-intel'] for v, (_, _, r) in zip(values, rows))
        amd = sum(v == r['numerics-amd'] for v, (_, _, r) in zip(values, rows))
        tally[name] = {'intel': intel, 'amd': amd}
        if intel == len(rows):
            passing.append(name)
    report['discovery']['candidates'] = total
    report['discovery']['refAmd'] = tally['ref']['amd']
    report['discovery']['passing'] = passing
    best = sorted(tally.items(), key=lambda kv: -kv[1]['intel'])[:15]
    report['discovery']['bestIntel'] = best
    if held and passing:
        functions = dict(candidates())
        h1 = held_out_h1(pins, 'ubuntu-24.04')
        h1_amd = held_out_h1(pins, 'ubuntu-22.04')
        h2 = held_out_h2(pins, 'ubuntu-22.04-3')
        h2_amd = held_out_h2(pins, 'ubuntu-22.04-1')
        report['heldOut'] = {
            'H1 size': len(h1), 'H2 size': len(h2),
            'ref on AMD H1': sum(corr(x, y, ref_nrm2) == r for _, x, y, r in h1_amd),
            'ref on AMD H2': [sum(r11(a, rest, ref_nrm2) == e for _, a, rest, e in h2_amd), len(h2_amd)],
            'ref on Intel H1': sum(corr(x, y, ref_nrm2) == r for _, x, y, r in h1),
            'ref on Intel H2': sum(r11(a, rest, ref_nrm2) == e for _, a, rest, e in h2),
            'candidates': {},
        }
        for name in passing:
            f = functions[name]
            report['heldOut']['candidates'][name] = {
                'H1': sum(corr(x, y, f) == r for _, x, y, r in h1),
                'H2': sum(r11(a, rest, f) == e for _, a, rest, e in h2),
            }
    json.dump(report, open(out, 'w'), indent=1)
    print(json.dumps({k: (v if k != 'discovery' else {kk: vv for kk, vv in v.items() if kk != 'bestIntel'}) for k, v in report.items()}, indent=1)[:6000])


if __name__ == '__main__':
    main()
