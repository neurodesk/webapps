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
    with open(os.path.join(root, 'geometry.json')) as source:
        recording = json.load(source)
    matches = [c for c in recording['cases'] if c['id'] == case_id]
    if len(matches) != 1:
        raise ValueError(f'{case_id}: expected exactly one case')
    case = matches[0]

    def read(field, columns):
        descriptor = case[field]
        if descriptor['class'] != 'double' or descriptor['imaginary'] != '':
            raise ValueError(f'{field}: expected real double data')
        shape = descriptor['shape']
        if (not isinstance(shape, list) or len(shape) != 2
                or any(type(n) is not int or n < 0 for n in shape)
                or shape[1] != columns):
            raise ValueError(f'{field}: expected a matrix with {columns} columns')
        filename = descriptor['file']
        if not filename or os.path.basename(filename) != filename:
            raise ValueError(f'{field}: expected a bare file name')
        path = os.path.join(root, filename)
        if os.path.getsize(path) != shape[0] * shape[1] * 8:
            raise ValueError(f'{field}: byte count does not match shape')
        values = np.fromfile(path, dtype='<f8')
        if not np.all(np.isfinite(values)):
            raise ValueError(f'{field}: expected finite values')
        return values.reshape(shape[::-1]).T

    def split(field, counts, columns):
        rows, out, offset = read(field, columns), [], 0
        if field == 'defaultHoles' and not np.all((rows == 0) | (rows == 1)):
            raise ValueError('defaultHoles: expected binary hole flags')
        for n in read(counts, 1).ravel():
            if n != int(n) or n < 0:
                raise ValueError(f'{counts}: expected nonnegative integer counts')
            out.append(rows[offset:offset + int(n)])
            offset += int(n)
        if offset != len(rows):
            raise ValueError(f'{field}: counts do not consume all rows')
        return out

    polygons = [[tuple(map(float, r)) for r in p] for p in split('points', 'counts', 2)]
    matlab = [int(np.sum(h)) for h in split('defaultHoles', 'defaultHolesCounts', 1)]
    if len(matlab) != len(polygons):
        raise ValueError(f'{case_id}: expected {len(polygons)} hole annotations, got {len(matlab)}')
    results = oracle.evaluate(polygons)
    if len(results) != len(polygons):
        raise ValueError(f'{case_id}: expected {len(polygons)} oracle results, got {len(results)}')
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
    with open(out, 'w') as destination:
        json.dump(report, destination, indent=1)


if __name__ == '__main__':
    main()
