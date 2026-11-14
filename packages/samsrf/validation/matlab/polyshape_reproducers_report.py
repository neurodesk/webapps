"""Compares a polyshape-reproducers recording (record_geometry.m) with the
predictions committed in polyshape-reproducers.json before it was recorded.

For each case it reports whether MATLAB's convhull vertex set equals the shipped
model's predicted hull, the experimental model's, both or neither; MATLAB's
regions and holes with and without KeepCollinearPoints; whether polyshape of
MATLAB's kept vertices (fromKept) and of its default vertices (fromDefault) and
simplify(polyshape(P, 'Simplify', false)) equal the default; whether each
witness is on MATLAB's hull; and the experimental model's area and CF sigma
error against MATLAB's hull. Evidence, not a gate. It refuses a recording whose
polygons differ from the spec's.

  python3 polyshape_reproducers_report.py HOST_DIR reproducer_cases|reproducer_round2|reproducer_round3|reproducer_round4|reproducer_round5 REPORT.json [PATH_TO_POLYSHAPE_HULLS]
"""
import collections
import json
import math
import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from polyshape_reduce import Oracle, expand, prediction, predictions_digest, transformed  # noqa: E402

ROLES = ['original', 'minimal', 'chain', 'oneDeleted', 'order', 'scale', 'reproducer', 'reduction']


def from_bits(value):
    return struct.unpack('<d', struct.pack('<Q', value))[0]


def main():
    root, case_id, out = sys.argv[1:4]
    spec_file = {'reproducer_cases': 'polyshape-reproducers.json', 'reproducer_round2': 'polyshape-reproducers-2.json',
                 'reproducer_round3': 'polyshape-reproducers-3.json', 'reproducer_round4': 'polyshape-reproducers-4.json',
                 'reproducer_round5': 'polyshape-reproducers-5.json'}[case_id]
    spec = json.load(open(os.path.join(HERE, spec_file)))
    compact = 'masks' in spec
    if compact:
        spec['cases'] = expand(spec)
    first = json.load(open(os.path.join(HERE, 'polyshape-reproducers.json')))
    recording = json.load(open(os.path.join(root, 'geometry.json')))
    assert recording['mode'] == 'polyshape-reproducers'
    case = next(c for c in recording['cases'] if c['id'] == case_id)

    def read(descriptor):
        values = np.fromfile(os.path.join(root, descriptor['file']), dtype='<f8')
        shape = descriptor['shape']
        return values.reshape(shape[::-1]).T if len(shape) == 2 else values

    def split(field, counts):
        rows, out_, offset = read(case[field]), [], 0
        for n in read(case[counts]).ravel():
            assert n == int(n)
            n = max(int(n), 0)
            out_.append(rows[offset:offset + n])
            offset += n
        assert offset == len(rows), field
        return out_

    def points(rows):
        return [(float(r[0]), float(r[1])) for r in rows if not np.isnan(r[0])]

    def rings(rows):
        result, current = [], []
        for r in rows:
            if np.isnan(r[0]):
                if current:
                    result.append(tuple(current))
                current = []
            else:
                current.append((float(r[0]), float(r[1])))
        if current:
            result.append(tuple(current))
        return result

    def same_shape(a, b):
        def cycle(r):
            k = r.index(min(r))
            return r[k:] + r[:k]
        canon = lambda rs: collections.Counter(min(cycle(r), cycle(r[::-1])) for r in rs)
        return canon(rings(a)) == canon(rings(b))

    polygons = split('points', 'counts')
    if compact:
        # A compact round commits only a digest of both models' predictions:
        # regenerate them (polyshape_hulls --oracle, argument 4) and check it.
        oracle = Oracle(sys.argv[4])
        results = oracle.evaluate([[tuple(map(float, r)) for r in p] for p in polygons])
        assert predictions_digest(spec['cases'], results) == spec['predictionsSha256'], 'predictions differ from the committed digest'
        for item, result in zip(spec['cases'], results):
            item['predicted'] = {'shipped': prediction(result['production']), 'experimental': prediction(result['experimental'])}
    default = split('simplified', 'simplifiedCounts')
    kept = split('collinearVertices', 'collinearCounts')
    hulls = split('hull', 'hullCounts')
    from_kept, from_default, via = (split(f, f + 'Counts') for f in ('fromKept', 'fromDefault', 'viaSimplify'))
    default_holes, kept_holes = split('defaultHoles', 'defaultHolesCounts'), split('keptHoles', 'keptHolesCounts')
    estimate, parameters, errors = read(case['estimate']), read(case['parameters']), read(case['error']).ravel()
    assert len(polygons) == len(spec['cases'])
    clouds = {c['cloud']: c for c in first['clouds']}
    rows = []
    for i, item in enumerate(spec['cases']):
        assert list(parameters[i]) == [item['cloud'], ROLES.index(item['role']), item['reversed'], item['shift'], item['transform']], i
        matlab_hull = frozenset(points(hulls[i]))
        predicted = {}
        for model in ('shipped', 'experimental'):
            p = item['predicted'][model]
            predicted[model] = frozenset((from_bits(x), from_bits(y)) for x, y in p.get('hull', []))
        area = float(estimate[i, 2])
        experimental = item['predicted']['experimental']
        experimental_area = from_bits(experimental['area']) if 'area' in experimental else 0.0
        row = {
            'case': i, 'cloud': item['cloud'], 'role': item['role'], 'points': len(item['indices']),
            'reversed': item['reversed'], 'shift': item['shift'], 'transform': item['transform'],
            'error': bool(errors[i]),
            'matlabEqualsShipped': matlab_hull == predicted['shipped'],
            'matlabEqualsExperimental': matlab_hull == predicted['experimental'],
            'areaErrorExperimental': experimental_area / area - 1 if area else None,
            'sigmaErrorExperimental': math.sqrt(experimental_area / area) - 1 if area else None,
            'regionsDefault': int(read(case['regions']).ravel()[i]),
            'defaultHoles': int(np.sum(default_holes[i])), 'keptHoles': int(np.sum(kept_holes[i])),
            'defaultRings': len(rings(default[i])), 'keptRings': len(rings(kept[i])),
            'fromKeptEqualsDefault': same_shape(from_kept[i], default[i]),
            'fromDefaultEqualsDefault': same_shape(from_default[i], default[i]),
            'viaSimplifyEqualsDefault': same_shape(via[i], default[i]),
        }
        if item['transform'] == 0:
            row['witnessesOnMatlabHull'] = [tuple(w['point']) in matlab_hull for w in clouds[item['cloud']]['witnesses']]
            row['witnessesExpected'] = [w['onMatlabHull'] for w in clouds[item['cloud']]['witnesses']]
        rows.append(row)
    # The polygons MATLAB recorded are the spec's, from the full clouds' indices.
    full = {}
    for i, item in enumerate(spec['cases']):
        if item['transform'] == 0 and item['reversed'] == 0 and item['shift'] == 0:
            for k, p in zip(item['indices'], polygons[i]):
                full.setdefault(item['cloud'], {})[k] = tuple(map(float, p))
    for i, item in enumerate(spec['cases']):
        base = [full[item['cloud']].get(k) for k in range(1, max(full[item['cloud']]) + 1)]
        expected = transformed([base[k - 1] for k in item['indices']], item['reversed'], item['shift'], item['transform'])
        assert [tuple(map(float, r)) for r in polygons[i]] == expected, f'case {i}: polygon differs from the spec'
    summary = collections.Counter((r['cloud'], r['role'], r['matlabEqualsShipped'], r['matlabEqualsExperimental']) for r in rows)
    json.dump({'rows': rows, 'summary': [list(k) + [v] for k, v in sorted(summary.items())]}, open(out, 'w'), indent=1)
    for (cloud, role, shipped, experimental), n in sorted(summary.items()):
        print(f'{cloud} {role:10s} MATLAB=shipped {shipped!s:5s} MATLAB=experimental {experimental!s:5s} {n}')


if __name__ == '__main__':
    main()
