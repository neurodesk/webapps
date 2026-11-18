#!/usr/bin/env python3
"""Diagnostic reconstruction, not a validated oracle for MATLAB corr's intermediate stages.

The dot candidate is fixed by raw products. Both this candidate and the shipped AMD
arithmetic are reconstructed here with the port's means and norm candidates. Differences
are reported, never used to fit a kernel. n=1 is excluded from the finite-correlation count.
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chain import cr_nrm2, ref_nrm2  # noqa: E402
from dot_candidates import array, bits, dot, load  # noqa: E402

MODELS = {
    'intel': {'lanes': 4, 'folds': [1, 2], 'tail': 'pow2', 'fused': True},
    'amd': {'lanes': 2, 'folds': [1], 'tail': 'mod', 'fused': False},
}


def mean(values, complex_part=False):
    lanes = [0.0] * 4
    for i, value in enumerate(values):
        lanes[i % 4 if complex_part or len(values) >= 44 else 0] += value
    total = 0.0
    for value in lanes:
        total += value
    return total / len(values)


def replay(pins):
    load(pins)  # Verify the same input vectors and both receipt-based host roles.
    results = {}
    for recording in ('numerics', 'numerics2'):
        root = pins / recording
        manifest = json.loads((root / 'manifest.json').read_text())
        hosts = {}
        for host, info in manifest['hosts'].items():
            role = 'intel' if info['blas'].endswith('(CNR branch AVX512_E1)') else 'amd'
            directory = root / host / 'compatible'
            cases = json.loads((directory / 'numerics.json').read_text())['cases']
            rows = []
            for case in cases:
                if case['kind'] != 'blas':
                    continue
                zr, zi, y = array(directory, case['z']), array(directory, case['z'], True), array(directory, case['y'])
                if len(y) == 1:
                    continue
                zr = [value - mean(zr, True) for value in zr]
                zi = [value - mean(zi, True) for value in zi]
                y = [value - mean(y) for value in y]
                norm = cr_nrm2 if role == 'intel' else ref_nrm2
                nx, ny = norm([v for pair in zip(zr, zi, strict=True) for v in pair]), norm(y)
                got = (dot(zr, y, MODELS[role]) / nx / ny, dot([-v for v in zi], y, MODELS[role]) / nx / ny)
                target = (array(directory, case['corr'])[0], array(directory, case['corr'], True)[0])
                rows.append({'id': case['id'], 'equal': [bits(a) == bits(b) for a, b in zip(got, target, strict=True)],
                             'actual': list(map(bits, got)), 'expected': list(map(bits, target))})
            assert len(rows) == 23
            hosts[role] = {'cpu': info['cpu'], 'equal': sum(all(row['equal']) for row in rows),
                           'of': len(rows), 'misses': [row for row in rows if not all(row['equal'])]}
        results[recording] = hosts
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pins', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    with args.out.open('x') as output:
        json.dump(replay(args.pins), output, indent=2)
        output.write('\n')


if __name__ == '__main__':
    main()
