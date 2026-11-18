#!/usr/bin/env python3
"""Amendment 1 of prereg-dnrm2.md (sha256 1fde38f2...): family 2 on D, H1 and H2.

Usage: python3 -I dnrm2_family2.py PINS_DIR REPORT_JSON
"""
import importlib.util
import json
import math
import os
import sys
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('family1', os.path.join(HERE, 'dnrm2_candidates.py'))
family1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(family1)


def cr_sqrt(s):
    """The double nearest to sqrt(s) for an exact non-negative Fraction s."""
    if s == 0:
        return 0.0
    # Scale by an exact power of four into float range; sqrt scales by the power of two.
    k = (s.numerator.bit_length() - s.denominator.bit_length()) // 2
    scaled = s / Fraction(4) ** k if k >= 0 else s * Fraction(4) ** -k
    d = math.ldexp(math.sqrt(float(scaled)), k)
    if math.isinf(d):
        return d
    for _ in range(8):
        below, above = math.nextafter(d, 0.0), math.nextafter(d, math.inf)
        low = (Fraction(below) + Fraction(d)) / 2
        high = (Fraction(d) + Fraction(above)) / 2
        if low * low <= s <= high * high:
            return d
        d = below if s < low * low else above
    raise AssertionError('no correctly rounded sqrt found')


def cr_norm(values):
    return cr_sqrt(sum(Fraction(v) * Fraction(v) for v in values))


def two_sum(a, b):
    s = a + b
    bb = s - a
    return s, (a - (s - bb)) + (b - bb)


def dd_seq_norm(values):
    hi, lo = 0.0, 0.0
    for v in values:
        p = v * v
        e = math.fma(v, v, -p)
        hi, t = two_sum(hi, p)
        lo += t + e
    hi, lo = two_sum(hi, lo)
    if hi == 0.0:
        return 0.0
    r = math.sqrt(hi)
    d = math.fma(-r, r, hi) + lo
    return r + d / (2.0 * r)


NONFINITE = []

CANDIDATES = {'ref': family1.ref_nrm2, 'cr': cr_norm, 'dd-seq': dd_seq_norm}


def r11_variants(column, nrm2):
    alpha, rest = column[0], column[1:]
    xnorm = nrm2(rest)
    if xnorm == 0.0:
        same = alpha
        return {'a': same, 'b': same, 'c': same}
    sign = -1.0 if alpha >= 0 else 1.0
    return {
        'a': sign * family1.dlapy2(alpha, xnorm),
        'b': sign * cr_sqrt(Fraction(alpha) ** 2 + Fraction(xnorm) ** 2) if math.isfinite(xnorm) else math.nan,
        'c': sign * nrm2(column),
    }


def h2_designs(pins, host):
    """(id, pivoted column, recorded R(1,1)) of every real double design."""
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
        x = family1.f64(os.path.join(qr_dir, design['x']['file']))
        ones = [1.0] * len(x)
        columns = [ones, x] if c['order'] == 'ones-first' else [x, ones]
        for chain in c['chains']:
            if chain['variant'] != 'real':
                continue
            if chain['factor']['imaginary'] and any(family1.f64(os.path.join(d, chain['factor']['imaginary']))):
                continue
            pivot = family1.f64(os.path.join(d, chain['pivot']['file']))
            factor = family1.f64(os.path.join(d, chain['factor']['file']))
            column = columns[int(pivot[0]) - 1]
            if not all(math.isfinite(v) for v in column):
                NONFINITE.append(c['id'])
                continue
            out.append((c['id'], column, factor[0]))
    return out


def main():
    pins, out = sys.argv[1], sys.argv[2]
    rows = family1.discovery(pins)
    h1 = family1.held_out_h1(pins, 'ubuntu-24.04')
    h1_amd = family1.held_out_h1(pins, 'ubuntu-22.04')
    h2 = h2_designs(pins, 'ubuntu-22.04-3')
    h2_amd = h2_designs(pins, 'ubuntu-22.04-1')
    report = {'sizes': {'D': len(rows), 'H1': len(h1), 'H2': len(h2), 'H2 amd': len(h2_amd), 'H2 nonfinite excluded (both hosts)': len(NONFINITE)}}
    for name, f in CANDIDATES.items():
        entry = {
            'D intel': sum(f(x) == v['numerics-intel'] == v['numerics2-intel'] for _, x, v in rows),
            'D amd': sum(f(x) == v['numerics-amd'] for _, x, v in rows),
            'H1 intel': sum(family1.corr(x, y, f) == r for _, x, y, r in h1),
            'H1 amd': sum(family1.corr(x, y, f) == r for _, x, y, r in h1_amd),
        }
        for variant in 'abc':
            entry[f'H2 intel ({variant})'] = sum(r11_variants(col, f)[variant] == e for _, col, e in h2)
            entry[f'H2 amd ({variant})'] = sum(r11_variants(col, f)[variant] == e for _, col, e in h2_amd)
        report[name] = entry
    misses = {}
    for name in ('cr', 'dd-seq'):
        f = CANDIDATES[name]
        misses[name] = {
            'H1': [(n, j) for j, (n, x, y, r) in enumerate(h1) if family1.corr(x, y, f) != r][:20],
            'H2 (a)': [i for i, col, e in h2 if r11_variants(col, f)['a'] != e][:20],
            'H2 (c)': [i for i, col, e in h2 if r11_variants(col, f)['c'] != e][:20],
        }
    report['misses'] = misses
    json.dump(report, open(out, 'w'), indent=1)
    print(json.dumps(report, indent=1)[:5000])


if __name__ == '__main__':
    main()
