#!/usr/bin/env python3
"""Find the first least-squares step where the port differs from MKL.

Usage: python3 -I qr-steps.py KERNELS_DIR PORT_STEPS_JSON REPORT_JSON

KERNELS_DIR is one record_qr_kernels.m output (kernels.json and arrays).
PORT_STEPS_JSON is written by the qr_steps example on the same pinned
designs. Steps are compared numerically in the order the algorithm produces
them. This diagnostic does not distinguish signed zeros. The Rust
qr_kernels chain gate performs the authoritative bitwise comparison.
"""
import json
from pathlib import Path
import struct
import sys

STEPS = ['pivot', 'R11', 'v1', 'tau1', 'R12', 'R22', 'v2', 'tau2', 'qty1', 'qty2', 'qtyRest', 'beta']


def read(root, descriptor):
    def doubles(name):
        data = (root / name).read_bytes()
        return list(struct.unpack(f'<{len(data) // 8}d', data))
    re = doubles(descriptor['file'])
    im = doubles(descriptor['imaginary']) if descriptor.get('imaginary') else [0.0] * len(re)
    shape = descriptor['shape']
    return [complex(a, b) for a, b in zip(re, im)], shape


def column_major(values, shape):
    rows = shape[0]
    return [values[j * rows:(j + 1) * rows] for j in range(len(values) // rows)]


def same(a, b):
    return len(a) == len(b) and all(x == y for x, y in zip(a, b))


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    root = Path(sys.argv[1])
    metadata = json.loads((root / 'kernels.json').read_text())
    port = {row['id']: row for row in json.loads(Path(sys.argv[2]).read_text())}
    report = {'environment': {k: metadata['environment'][k] for k in ('interpreter', 'blas', 'githubRun')},
              'cpu': next((line.split(':', 1)[1].strip() for line in metadata['environment']['cpu'].splitlines() if line.startswith('Model name')), None),
              'cases': [], 'summary': {}}
    cases = metadata['cases'] if isinstance(metadata['cases'], list) else [metadata['cases']]
    for case in cases:
        chains = case['chains'] if isinstance(case['chains'], list) else [case['chains']]
        mine = port[case['id']]
        variant = 'complex' if mine['complex'] else 'real'
        chain = next((c for c in chains if c['variant'] == variant), None)
        mldivide, _ = read(root, case['mldivide'])
        ours = [complex(*v) for v in mine['coefficients']]
        row = {'id': case['id'], 'precision': case['precision'], 'variant': variant,
               'portMatchesMldivide': same(ours, mldivide),
               'chains': {c['variant']: c['matchesMldivide'] for c in chains}}
        if chain is not None:
            values, shape = read(root, chain['factor'])
            factor = column_major(values, shape)
            tau, _ = read(root, chain['tau'])
            qty, _ = read(root, chain['qty'])
            beta, _ = read(root, chain['beta'])
            pivot = [int(round(p.real)) - 1 for p in read(root, chain['pivot'])[0]]
            packed = [[complex(*v) for v in column] for column in mine['packed']]
            port_tau = [complex(*v) for v in mine['tau']]
            port_qty = [complex(*v) for v in mine['qty']]
            checks = {
                'pivot': pivot == mine['pivot'],
                'R11': factor[0][0] == packed[0][0],
                'v1': same(factor[0][1:], packed[0][1:]),
                'tau1': tau[0] == port_tau[0],
                'R12': factor[1][0] == packed[1][0],
                'R22': factor[1][1] == packed[1][1],
                'v2': same(factor[1][2:], packed[1][2:]),
                'tau2': len(tau) < 2 or tau[1] == port_tau[1],
                'qty1': qty[0] == port_qty[0],
                'qty2': qty[1] == port_qty[1],
                'qtyRest': same(qty[2:], port_qty[2:]),
                'beta': same(beta, ours),
            }
            row['chainMatchesMldivide'] = chain['matchesMldivide']
            row['firstDifference'] = next((step for step in STEPS if not checks[step]), None)
            row['checks'] = checks
        report['cases'].append(row)
    summary = report['summary']
    for row in report['cases']:
        key = f"{row['precision']}-{row['variant']}"
        entry = summary.setdefault(key, {'cases': 0, 'chainEqualsMldivide': 0, 'portEqualsMldivide': 0, 'firstDifference': {}})
        entry['cases'] += 1
        entry['chainEqualsMldivide'] += bool(row.get('chainMatchesMldivide'))
        entry['portEqualsMldivide'] += row['portMatchesMldivide']
        first = str(row.get('firstDifference'))
        entry['firstDifference'][first] = entry['firstDifference'].get(first, 0) + 1
    Path(sys.argv[3]).write_text(json.dumps(report, indent=1) + '\n')
    print(report['cpu'], report['environment']['blas'][-30:])
    for key, entry in sorted(summary.items()):
        print(key, json.dumps(entry))


if __name__ == '__main__':
    main()
