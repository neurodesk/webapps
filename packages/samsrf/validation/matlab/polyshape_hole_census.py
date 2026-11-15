"""Hole topology census (#732): for every polygon of the recorded families that
carry per-boundary hole flags (record_geometry.m's causal and reproducer modes),
compare the number of holes in MATLAB's default polyshape with the number of
negatively wound rings in the output of the experimental model and of its
diagnostic rule variants (experimental::Hypothesis; polyshape_hulls --oracle).
Evidence, not a gate.

  cargo build --release --features polyshape-experimental --example polyshape_hulls
  python3 polyshape_hole_census.py PATH_TO_POLYSHAPE_HULLS CAUSAL_HOST_DIR REPRODUCER_HOST_DIR REPORT.json
"""
import collections
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from polyshape_reduce import Oracle  # noqa: E402

VARIANTS = ['experimental', 'h-merge', 'h-merge-single']
FAMILIES = [('causal', c) for c in ('causal_gap_sweep', 'causal_gap_bisection', 'causal_hole_contact', 'causal_real', 'causal_heldout')] + \
    [('reproducer', c) for c in ('reproducer_cases', 'reproducer_round2', 'reproducer_round3', 'reproducer_round4', 'reproducer_round5', 'reproducer_round6')]


def family(root, case_id, oracle):
    recording = json.load(open(os.path.join(root, 'geometry.json')))
    case = next(c for c in recording['cases'] if c['id'] == case_id)

    def read(descriptor):
        assert descriptor['class'] == 'double' and descriptor['imaginary'] == ''
        values = np.fromfile(os.path.join(root, descriptor['file']), dtype='<f8')
        shape = descriptor['shape']
        assert values.size == int(np.prod(shape))
        return values.reshape(shape[::-1]).T if len(shape) == 2 else values

    def split(field, counts):
        rows, out, offset = read(case[field]), [], 0
        for n in read(case[counts]).ravel():
            assert n == int(n) and n >= 0
            out.append(rows[offset:offset + int(n)])
            offset += int(n)
        assert offset == len(rows), field
        return out

    polygons = [[tuple(map(float, r)) for r in p] for p in split('points', 'counts')]
    matlab = [int(np.sum(h)) for h in split('defaultHoles', 'defaultHolesCounts')]
    results = oracle.evaluate(polygons)
    counts = collections.Counter()
    for m, result in zip(matlab, results):
        counts['polygons'] += 1
        counts['matlabWithHoles'] += m > 0
        for v in VARIANTS:
            holes = result['variants'][v].get('holes', -1)
            counts[f'{v}:equal'] += holes == m
            counts[f'{v}:holesWhereMatlabHas'] += m > 0 and holes > 0
            counts[f'{v}:holesWhereMatlabHasNone'] += m == 0 and holes > 0
    return dict(counts)


def main():
    binary, causal, reproducers, out = sys.argv[1:5]
    oracle = Oracle(binary)
    report = {}
    for kind, case_id in FAMILIES:
        report[case_id] = family(causal if kind == 'causal' else reproducers, case_id, oracle)
        print(case_id, report[case_id])
    json.dump(report, open(out, 'w'), indent=1)


if __name__ == '__main__':
    main()
