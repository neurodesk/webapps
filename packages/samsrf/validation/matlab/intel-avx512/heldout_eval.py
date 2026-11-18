#!/usr/bin/env python3
"""One-time held-out evaluation of the frozen Intel chain (prereg-chain.md, freeze).

Usage: python3 -I heldout_eval.py PINS_DIR INPUTS_DIR REPORT_JSON
"""
import hashlib
import importlib.util
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FROZEN = open(os.path.join(HERE, 'chain.frozen.sha256')).read().split()[0]
actual = hashlib.sha256(open(os.path.join(HERE, 'chain.py'), 'rb').read()).hexdigest()
assert actual == FROZEN, f'chain.py changed since the freeze: {actual} != {FROZEN}'
spec = importlib.util.spec_from_file_location('chain', os.path.join(HERE, 'chain.py'))
chain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chain)


def f64(path):
    data = open(path, 'rb').read()
    return list(struct.unpack('<%dd' % (len(data) // 8), data))


def same(a, b):
    return struct.pack('<d', a) == struct.pack('<d', b)


class Blocked(chain.Tree):
    """lstsq.rs tree_sum with block != lanes (AMD leftover kernels only)."""

    def __init__(self, lanes, block, strides):
        super().__init__('first', lanes, strides, 'seq', False)
        self.block = block

    def dot(self, v, c):
        products = [a * b for a, b in zip(v, c[1:])]
        c0 = c[0]
        if not products:
            return c0
        seed, body = products[0], products[1:]
        blocked = len(body) // self.block * self.block
        if self.lanes > 1 and blocked > 0:
            sums = [None] * self.lanes
            sums[0] = seed
            for i, p in enumerate(body[:blocked]):
                k = i % self.lanes
                sums[k] = p if sums[k] is None else sums[k] + p
            for stride in self.strides:
                for k in range(self.lanes):
                    if (k // stride) % 2 == 0 and k + stride < self.lanes and sums[k] is not None and sums[k + stride] is not None:
                        sums[k] = sums[k] + sums[k + stride]
            w = sums[0]
            for p in body[blocked:]:
                w = w + p
        else:
            w = seed
            for p in body:
                w = w + p
        return c0 + w


AMD_ONE = chain.AMD_ORMQR1
AMD_GROUP = Blocked(2, 2, (1,))


def amd_rhs(count, index):
    """lstsq.rs rhs_kernel for real double right-hand sides."""
    grouped = count // 4 * 4
    if count == 1:
        return AMD_ONE
    if index < grouped:
        return AMD_GROUP
    left, position = count - grouped, index - grouped
    if left == 1 or (left == 3 and position == 2):
        return AMD_ONE
    if position == 0:
        return Blocked(4, 8, (2, 1))
    return Blocked(2, 8, (1,))


INTEL_SINGLE = chain.INTEL_ORMQR1(True)
INTEL_GROUPED = chain.Grouped('fma-a', True)


def intel_rhs(count, index):
    return chain.intel_rhs_tree(count, index, INTEL_GROUPED, INTEL_SINGLE)


MODELS = {
    'amd': (chain.Chain(), amd_rhs),
    'intel': (chain.Chain('cr', chain.INTEL_GEMV(True), True, INTEL_SINGLE, True, True, True), intel_rhs),
}


def solve_all(model, columns, ys):
    variant, rhs = MODELS[model]
    f = variant.factor(columns)
    count = len(ys)
    coefficients = []
    for index, y in enumerate(ys):
        qty = variant.qty(f, y, rhs(count, index))
        coefficients.append(variant.back(f, qty, divide=(count == 1)))
    return coefficients


def fit(alternative, a, b1, b2):
    return a * b1 + b2 if alternative == 'a' else math.fma(a, b1, b2)


def h3(pins, inputs, index, model, host):
    recorded = json.load(open(os.path.join(pins, 'cgg', host, 'constants-direct.json')))['cases']
    by_id = {c['id']: c for c in recorded}
    tallies = {}
    misses = {'a': [], 'c': []}
    for entry in (e for e in index if e['set'] == 'h3'):
        n, V, j = entry['n'], entry['V'], entry['j']
        x = f64(os.path.join(inputs, entry['file']))
        columns_x = [x[k * n:(k + 1) * n] for k in range(V)]
        expected = f64(os.path.join(pins, 'cgg', host, by_id[entry['id']]['detrend']['file']))
        group = f"n{n if n in (1, 2, 3, 37) else 250}"
        for alternative in ('a', 'c'):
            if n == 1:
                d = [v - v for v in columns_x[j]]
            else:
                time = [i / (n - 1) for i in range(n)]
                coefficients = solve_all(model, [time, [1.0] * n], columns_x)
                slope, intercept = coefficients[j]
                d = [v - fit(alternative, t, slope, intercept) for v, t in zip(columns_x[j], time)]
            hits = sum(same(p, q) for p, q in zip(d, expected))
            key = f'{group} ({alternative})'
            t = tallies.setdefault(key, [0, 0, 0, 0])
            t[0] += hits
            t[1] += n
            t[2] += hits == n
            t[3] += 1
            if hits != n and len(misses[alternative]) < 12:
                misses[alternative].append((entry['id'], n - hits))
    return {'values/total, cases exact/total': tallies, 'firstMisses': misses}


def h4(pins, inputs, index, model, host):
    dir_ = os.path.join(pins, 'revcor-reference', host)
    cases = {c['id']: c for c in json.load(open(os.path.join(dir_, 'revcor-matrix.json')))['cases']}
    out = {}
    for entry in (e for e in index if e['set'] == 'h4' and e['host'] == host):
        case = cases[entry['id']]
        pre = cases[case['preprocessing']]
        volumes = pre['courses']['shape'][0]
        courses = f64(os.path.join(dir_, pre['courses']['file']))
        roi = [int(v) - 1 for v in f64(os.path.join(dir_, pre['roi']['file']))]
        x = f64(os.path.join(inputs, entry['x']))
        expected = f64(os.path.join(dir_, case['recomputedCorrectedCourses']['file']))
        ys = [courses[v * volumes:(v + 1) * volumes] for v in roi]
        assert all(math.isfinite(value) for y in ys for value in y)
        coefficients = solve_all(model, [x, [1.0] * volumes], ys)
        row = {}
        for alternative in ('a', 'c'):
            hits = courses_exact = 0
            for (b1, b2), y, v in zip(coefficients, ys, roi):
                e = expected[v * volumes:(v + 1) * volumes]
                r = [yt - fit(alternative, xt, b1, b2) for yt, xt in zip(y, x)]
                h = sum(same(p, q) for p, q in zip(r, e))
                hits += h
                courses_exact += h == volumes
            row[f'({alternative})'] = {'values': [hits, volumes * len(roi)], 'courses': [courses_exact, len(roi)]}
        out[entry['id']] = row
    return out


def main():
    pins, inputs, report_path = sys.argv[1], sys.argv[2], sys.argv[3]
    index = json.load(open(os.path.join(inputs, 'index.json')))
    report = {'chainSha256': FROZEN}
    report['H3 AMD control (ubuntu-22.04, AMD 9V74, amd chain)'] = h3(pins, inputs, index, 'amd', 'ubuntu-22.04')
    report['H4 AMD control (ubuntu-22.04, AMD 9V74, amd chain)'] = h4(pins, inputs, index, 'amd', 'ubuntu-22.04')
    report['H3 Intel (ubuntu-24.04, Intel 6975P-C, intel chain)'] = h3(pins, inputs, index, 'intel', 'ubuntu-24.04')
    report['H4 Intel (ubuntu-24.04, Intel 8370C, intel chain)'] = h4(pins, inputs, index, 'intel', 'ubuntu-24.04')
    report['H3 Intel host with the amd chain (reference)'] = h3(pins, inputs, index, 'amd', 'ubuntu-24.04')
    json.dump(report, open(report_path, 'w'), indent=1)
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
