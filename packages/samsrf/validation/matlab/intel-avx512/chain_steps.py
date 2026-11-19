#!/usr/bin/env python3
"""Step-by-step comparison of chain.py variants with a qr-kernels host's recorded chains.

Usage: python3 -I chain_steps.py PINS_DIR HOST REPORT_JSON [--grid]
Discovery data only (prereg-chain.md): the real double single-RHS chains.
"""
import importlib.util
import itertools
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('chain', os.path.join(HERE, 'chain.py'))
chain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chain)

STEPS = ['pivot', 'R11', 'v1', 'tau1', 'R12', 'R22', 'v2', 'tau2', 'qty1', 'qty2', 'qtyRest', 'beta']


def f64(path):
    data = open(path, 'rb').read()
    return list(struct.unpack('<%dd' % (len(data) // 8), data))


def bits_equal(a, b):
    return len(a) == len(b) and all(struct.pack('<d', x) == struct.pack('<d', y) for x, y in zip(a, b))


def designs(pins, host):
    qr_dir = os.path.join(pins, 'qr-reference', 'ubuntu-24.04', 'compatible')
    meta = {c['id']: c for c in json.load(open(os.path.join(qr_dir, 'qr.json')))['cases']}
    d = os.path.join(pins, 'qr-kernels', host)
    out = []
    for c in json.load(open(os.path.join(d, 'kernels.json')))['cases']:
        if c['precision'] != 'double':
            continue
        design = meta[c['id']]
        if design['x']['imaginary']:
            continue
        chain_rec = next((ch for ch in c['chains'] if ch['variant'] == 'real'), None)
        if chain_rec is None:
            continue
        if chain_rec['factor']['imaginary'] and any(f64(os.path.join(d, chain_rec['factor']['imaginary']))):
            continue
        x = f64(os.path.join(qr_dir, design['x']['file']))
        y = f64(os.path.join(qr_dir, design['y']['file']))
        ones = [1.0] * len(x)
        columns = [ones, x] if c['order'] == 'ones-first' else [x, ones]
        m = len(x)
        factor = f64(os.path.join(d, chain_rec['factor']['file']))
        out.append({
            'id': c['id'], 'columns': columns, 'y': y, 'm': m,
            'pivot': [int(p) - 1 for p in f64(os.path.join(d, chain_rec['pivot']['file']))],
            'factor': [factor[:m], factor[m:]],
            'tau': f64(os.path.join(d, chain_rec['tau']['file'])),
            'qty': f64(os.path.join(d, chain_rec['qty']['file'])),
            'beta': f64(os.path.join(d, chain_rec['beta']['file'])),
        })
    return out


def compare(variant, design):
    f = variant.factor(design['columns'])
    a = f['a']
    checks = {
        'pivot': f['pivot'] == design['pivot'],
        'R11': bits_equal([a[0][0]], [design['factor'][0][0]]),
        'v1': bits_equal(a[0][1:], design['factor'][0][1:]),
        'tau1': bits_equal(f['taus'][:1], design['tau'][:1]),
        'R12': bits_equal([a[1][0]], [design['factor'][1][0]]),
        'R22': bits_equal([a[1][1]], [design['factor'][1][1]]),
        'v2': bits_equal(a[1][2:], design['factor'][1][2:]),
        'tau2': bits_equal(f['taus'][1:2], design['tau'][1:2]),
    }
    if not all(math.isfinite(v) for col in design['columns'] for v in col) or not all(math.isfinite(v) for v in design['y']):
        return checks, None
    qty = variant.qty(f, design['y'])
    checks['qty1'] = bits_equal(qty[:1], design['qty'][:1])
    checks['qty2'] = bits_equal(qty[1:2], design['qty'][1:2])
    checks['qtyRest'] = bits_equal(qty[2:], design['qty'][2:])
    checks['beta'] = bits_equal(variant.back(f, qty), design['beta'])
    first = next((s for s in STEPS if not checks.get(s, True)), None)
    return checks, first


def tally(variant, items):
    counts = {s: 0 for s in STEPS}
    firsts = {}
    for design in items:
        checks, first = compare(variant, design)
        for s in STEPS:
            counts[s] += bool(checks.get(s, False))
        firsts[str(first)] = firsts.get(str(first), 0) + 1
    return counts, firsts


def main():
    pins, host, out = sys.argv[1], sys.argv[2], sys.argv[3]
    items = designs(pins, host)
    report = {'host': host, 'designs': len(items)}
    amd = chain.Chain()
    report['amd chain'] = tally(amd, items)
    if '--grid' in sys.argv:
        grid = {}
        gemvs = {'amd': chain.AMD_GEMV, 'intel': chain.INTEL_GEMV(False), 'intel-fma': chain.INTEL_GEMV(True)}
        ormqrs = {'amd': chain.AMD_ORMQR1, 'intel': chain.INTEL_ORMQR1(False), 'intel-fma': chain.INTEL_ORMQR1(True)}
        for nrm2, (gname, g), gup, (oname, o), oup, back in itertools.product(('ref', 'cr'), gemvs.items(), (False, True), ormqrs.items(), (False, True), (False, True)):
            variant = chain.Chain(nrm2, g, gup, o, oup, back)
            name = f'nrm2={nrm2} gemv={gname} gemvUpd={"fma" if gup else "mul"} ormqr={oname} ormqrUpd={"fma" if oup else "mul"} back={"fma" if back else "mul"}'
            grid[name] = tally(variant, items)
        report['grid'] = grid
    json.dump(report, open(out, 'w'), indent=1)
    print(host, len(items), 'designs; AMD chain per step', report['amd chain'][0], 'first differences', report['amd chain'][1])
    if '--grid' in sys.argv:
        best = sorted(report['grid'].items(), key=lambda kv: (-kv[1][0]['beta'], -kv[1][0]['qtyRest'], -kv[1][0]['R22'], -kv[1][0]['R12']))[:12]
        for name, (counts, firsts) in best:
            print(name, counts, firsts)


if __name__ == '__main__':
    main()
