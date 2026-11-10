#!/usr/bin/env python3
"""Compare the port's least-squares coefficients with MATLAB's and with the
exact solution of the same rounded inputs.

Usage: python3 -I qr-accuracy.py RECORDING PORT_AFTER_JSON [PORT_BEFORE_JSON] REPORT_JSON

RECORDING is one setting of the pinned qr-reference.json archive, e.g.
ubuntu-24.04/compatible. PORT_AFTER_JSON is written by the qr_reference test
with SAMSRF_QR_REPORT set. The exact solution uses rational arithmetic on the
inputs after MATLAB's conversion to the design's class, so it separates
rounding inside the solve from rounding of the inputs.
"""
from fractions import Fraction
import json
import math
from pathlib import Path
import struct
import sys


def read(root, descriptor):
    def doubles(name):
        data = (root / name).read_bytes()
        return list(struct.unpack(f'<{len(data) // 8}d', data))
    re = doubles(descriptor['file'])
    im = doubles(descriptor['imaginary']) if descriptor.get('imaginary') else [0.0] * len(re)
    return list(zip(re, im))


def to_class(value, single):
    return struct.unpack('<f', struct.pack('<f', value))[0] if single else value


def ulps(a, b, single):
    if a == b:
        return 0
    if not (math.isfinite(a) and math.isfinite(b)):
        return math.inf
    fmt, mask = ('<i', '<f') if single else ('<q', '<d')
    def ordered(v):
        bits = struct.unpack(fmt, struct.pack(mask, v))[0]
        return -(bits & ((1 << (31 if single else 63)) - 1)) if bits < 0 else bits
    return abs(ordered(a) - ordered(b))


class Z:
    """Exact complex rationals."""
    def __init__(self, re, im=Fraction(0)):
        self.re, self.im = Fraction(re), Fraction(im)
    def __add__(self, o): return Z(self.re + o.re, self.im + o.im)
    def __sub__(self, o): return Z(self.re - o.re, self.im - o.im)
    def __mul__(self, o): return Z(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)
    def __truediv__(self, o):
        d = o.re * o.re + o.im * o.im
        return Z((self.re * o.re + self.im * o.im) / d, (self.im * o.re - self.re * o.im) / d)
    def conj(self): return Z(self.re, -self.im)
    def abs(self): return math.hypot(float(self.re), float(self.im))


def dot(a, b):
    total = Z(0)
    for u, v in zip(a, b):
        total = total + u.conj() * v
    return total


def exact(columns, y, keep):
    """Least squares on the kept columns, zero elsewhere."""
    kept = [columns[k] for k in keep]
    if len(kept) == 1:
        solution = [dot(kept[0], y) / dot(kept[0], kept[0])]
    else:
        a, b = kept
        aa, ab, bb = dot(a, a), dot(a, b), dot(b, b)
        ay, by = dot(a, y), dot(b, y)
        determinant = aa * bb - ab * ab.conj()
        solution = [(bb * ay - ab * by) / determinant, (aa * by - ab.conj() * ay) / determinant]
    result = [Z(0), Z(0)]
    for k, value in zip(keep, solution):
        result[k] = value
    return result


def main():
    args = sys.argv[1:]
    if len(args) not in (3, 4):
        raise SystemExit(__doc__)
    root = Path(args[0])
    after = {row['id']: row for row in json.loads(Path(args[1]).read_text())}
    before = {row['id']: row for row in json.loads(Path(args[2]).read_text())} if len(args) == 4 else {}
    metadata = json.loads((root / 'qr.json').read_text())
    rows = []
    for case in metadata['cases']:
        single = case['precision'] == 'single'
        x = [(to_class(r, single), to_class(i, single)) for r, i in read(root, case['x'])]
        y = [to_class(r, single) for r, _ in read(root, case['y'])]
        ones = [(1.0, 0.0)] * len(x)
        columns = [ones, x] if case['order'] == 'ones-first' else [x, ones]
        columns = [[Z(r, i) for r, i in column] for column in columns]
        pivot = [int(p) - 1 for p, _ in read(root, case['pivotWithoutRhs'])]
        rank = after[case['id']]['rank']
        truth = exact(columns, [Z(v) for v in y], sorted(pivot[:rank]))
        matlab = read(root, case['beta'])
        port = list(zip(after[case['id']]['re'], after[case['id']]['im']))
        row = {'id': case['id'], 'precision': case['precision'], 'rank': rank, 'coefficients': []}
        old = before.get(case['id'])
        for k in range(2):
            scale = truth[k].abs()
            def error(value):
                return Z(value[0], value[1]).__sub__(truth[k]).abs()
            entry = {
                'matlab': matlab[k], 'port': port[k],
                'ulpsRe': ulps(port[k][0], matlab[k][0], single),
                'ulpsIm': ulps(port[k][1], matlab[k][1], single),
                'portError': error(port[k]), 'matlabError': error(matlab[k]), 'exactMagnitude': scale,
            }
            if old:
                entry['before'] = old['re'][k]
                entry['beforeUlpsRe'] = ulps(old['re'][k], matlab[k][0], single)
            row['coefficients'].append(entry)
        rows.append(row)
    summary = {}
    for row in rows:
        family = row['id'].split('_')[0] + ('_' + row['id'].split('_')[1] if row['id'].startswith(('nearly', 'ones')) else '')
        key = f"{family}-{row['precision']}"
        entry = summary.setdefault(key, {'cases': 0, 'exactAfter': 0, 'exactBefore': 0, 'beforeCompared': 0,
                                         'maxUlpsRe': 0, 'maxUlpsIm': 0, 'maxUlpsBefore': 0,
                                         'maxErrorRatio': 0.0})
        entry['cases'] += 1
        entry['exactAfter'] += all(c['ulpsRe'] == 0 and c['ulpsIm'] == 0 for c in row['coefficients'])
        if 'before' in row['coefficients'][0]:
            entry['beforeCompared'] += 1
            entry['exactBefore'] += all(c['beforeUlpsRe'] == 0 for c in row['coefficients'])
            entry['maxUlpsBefore'] = max(entry['maxUlpsBefore'], *(c['beforeUlpsRe'] for c in row['coefficients']))
        for c in row['coefficients']:
            entry['maxUlpsRe'] = max(entry['maxUlpsRe'], c['ulpsRe'])
            entry['maxUlpsIm'] = max(entry['maxUlpsIm'], c['ulpsIm'])
            # How much less accurate than MATLAB the port is, against the exact solution.
            floor = (2.0 ** -23 if row['precision'] == 'single' else 2.0 ** -52) * max(c['exactMagnitude'], 1e-300)
            entry['maxErrorRatio'] = max(entry['maxErrorRatio'], c['portError'] / max(c['matlabError'], floor))
    report = {'summary': summary, 'cases': rows}
    Path(args[-1]).write_text(json.dumps(report, indent=1, default=str) + '\n')
    for key, entry in sorted(summary.items()):
        print(key, json.dumps(entry))


if __name__ == '__main__':
    main()
