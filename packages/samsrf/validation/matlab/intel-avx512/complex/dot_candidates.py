#!/usr/bin/env python3
"""Offline replay of a finite family for MKL AVX512_E1 z'*y (complex z, real y).

Reads only existing raw BLAS vectors/products. No final map is used to select a model.
Python >=3.13 supplies correctly rounded math.fma. All evaluated recordings were already
seen by this research program: no discovery/holdout claim is made.
"""
import argparse
import hashlib
import itertools
import json
import math
from pathlib import Path
import struct


def bits(x):
    return struct.pack('<d', x).hex()


def array(root, descriptor, imaginary=False):
    name = descriptor['imaginary' if imaginary else 'file']
    assert name and Path(name).name == name
    data = (root / name).read_bytes()
    assert len(data) % 8 == 0
    return struct.unpack('<' + 'd' * (len(data) // 8), data)


def models():
    for lanes in (1, 2, 4, 8, 16):
        powers = [1 << i for i in range(lanes.bit_length() - 1)]
        for folds in itertools.permutations(powers):
            for tail in ('mod', 'seq', 'pow2', 'mask'):
                for fused in (False, True):
                    yield {'lanes': lanes, 'folds': list(folds), 'tail': tail, 'fused': fused}


def dot(x, y, model):
    lanes, folds, tail, fused = (model[k] for k in ('lanes', 'folds', 'tail', 'fused'))
    accumulators = [None] * lanes
    def add(k, i):
        acc = accumulators[k]
        accumulators[k] = x[i] * y[i] if acc is None else (
            math.fma(x[i], y[i], acc) if fused else acc + x[i] * y[i])
    blocked = len(x) if tail == 'mod' else len(x) // lanes * lanes
    for i in range(blocked):
        add(i % lanes, i)
    remaining = list(range(blocked, len(x)))
    if tail == 'pow2':
        chunk = lanes // 2
        while chunk:
            if len(remaining) >= chunk:
                for k, i in enumerate(remaining[:chunk]):
                    add(k, i)
                remaining = remaining[chunk:]
            chunk //= 2
    elif tail == 'mask':
        for k, i in enumerate(remaining):
            add(k, i)
        remaining = []
    consumed = set()
    for stride in folds:
        for k in range(lanes):
            if (k // stride) % 2 == 0 and k + stride < lanes and k not in consumed and k + stride not in consumed:
                a, b = accumulators[k], accumulators[k + stride]
                accumulators[k] = b if a is None else a if b is None else a + b
                consumed.add(k + stride)
    total = accumulators[0]
    for i in remaining:
        total = x[i] * y[i] if total is None else math.fma(x[i], y[i], total) if fused else total + x[i] * y[i]
    return 0.0 if total is None else total


def load(pins):
    rows = {}
    files = {}
    for recording in ('numerics', 'numerics2'):
        root = pins / recording
        manifest = json.loads((root / 'manifest.json').read_text())
        files[str(Path(recording) / 'manifest.json')] = hashlib.sha256((root / 'manifest.json').read_bytes()).hexdigest()
        roles = {}
        for host, meta in manifest['hosts'].items():
            if meta['blas'].endswith('(CNR branch AVX512_E1)'):
                role = 'intel'
            elif meta['blas'].endswith('(CNR branch auto)') and meta['cpu'].startswith('AMD'):
                role = 'amd'
            else:
                raise AssertionError(meta)
            assert role not in roles
            directory = root / host / 'compatible'
            cases = [c for c in json.loads((directory / 'numerics.json').read_text())['cases'] if c['kind'] == 'blas']
            assert len(cases) == 24
            values = []
            for case in cases:
                zr, zi, y = array(directory, case['z']), array(directory, case['z'], True), array(directory, case['y'])
                expected = (array(directory, case['complexDot'])[0], array(directory, case['complexDot'], True)[0])
                values.append({'id': case['id'], 're': zr, 'im': zi, 'y': y, 'expected': expected})
                for descriptor in ('z', 'y', 'complexDot'):
                    for key in ('file', 'imaginary'):
                        name = case[descriptor][key]
                        if name:
                            path = directory / name
                            files[str(path.relative_to(pins))] = hashlib.sha256(path.read_bytes()).hexdigest()
            roles[role] = {'cpu': meta['cpu'], 'cases': values}
        assert set(roles) == {'amd', 'intel'}
        rows[recording] = roles
    reference = rows['numerics']['intel']['cases']
    for roles in rows.values():
        for role in roles.values():
            for a, b in zip(reference, role['cases'], strict=True):
                assert (a['id'], a['re'], a['im'], a['y']) == (b['id'], b['re'], b['im'], b['y'])
    return rows, files


def evaluate(model, cases):
    matches, components, misses = 0, 0, []
    for case in cases:
        got = (dot(case['re'], case['y'], model), dot([-v for v in case['im']], case['y'], model))
        equal = [bits(a) == bits(b) for a, b in zip(got, case['expected'], strict=True)]
        components += sum(equal)
        matches += all(equal)
        if not all(equal):
            misses.append({'id': case['id'], 'expected': list(map(bits, case['expected'])), 'actual': list(map(bits, got))})
    return {'vectorsEqual': matches, 'componentsEqual': components, 'misses': misses}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pins', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    assert hasattr(math, 'fma'), 'Python >=3.13 required'
    rows, files = load(args.pins)
    family = list(models())
    scored = [(evaluate(m, rows['numerics']['intel']['cases']), m) for m in family]
    scored.sort(key=lambda v: (v[0]['vectorsEqual'], v[0]['componentsEqual']), reverse=True)
    passing = [m for result, m in scored if result['vectorsEqual'] == 24]
    top = [{'model': m, 'replay': {r: {host: evaluate(m, x['cases']) for host, x in roles.items()} for r, roles in rows.items()}} for _, m in scored[:8]]
    amd = {'lanes': 2, 'folds': [1], 'tail': 'mod', 'fused': False}
    result = {'scope': 'seen replay: 24 distinct vectors on two Intel and two AMD recordings',
              'sourceSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'filesSha256': files, 'familySize': len(family), 'passingModels': passing, 'top': top,
              'amdControl': {r: {host: evaluate(amd, x['cases']) for host, x in roles.items()} for r, roles in rows.items()}}
    with args.out.open('x') as out:
        json.dump(result, out, indent=2)
        out.write('\n')
    print(json.dumps({'familySize': len(family), 'passingModels': passing, 'best': scored[0]}, indent=2))


if __name__ == '__main__':
    main()
