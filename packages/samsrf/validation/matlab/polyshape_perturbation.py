"""One-coordinate perturbation sweeps of cloud 177's 1-minimal 6-point
reproducer (#732), with competing predictions written before MATLAB records
them (polyshape-reproducers-6.json).

On that reproducer MATLAB's default drops the ring through input points 4 and
5 and two crossings (the sliver). Clipper's CleanPolygon empties it from 6 of 8
start and direction choices and keeps a triangle from input point 5, where the
union starts it, which is what the experimental model does. Sweeping one
coordinate of point 4 or 5 in tolerance steps moves the sliver through regimes
where every start empties it, every start keeps it, or the result depends on
the start. The sweeps say which rule MATLAB's transitions follow:

  H_X  the experimental model (clean from the union's start), per case
  H_I  start-independent: the sliver survives only if every start keeps it
  H_S  the shipped model's hull

The observable is whether input point 4 (as perturbed) is a vertex of MATLAB's
default polyshape (the sliver survives), plus its hull. A transition MATLAB
shows where none of the clean regimes change would point to a region-level
criterion instead of vertex-level cleaning.

  python3 polyshape_perturbation.py spec GEOMETRY_HOST_DIR PATH_TO_POLYSHAPE_HULLS PATH_TO_POLYSHAPE_STAGES OUT.json
  python3 polyshape_perturbation.py report RECORDING_HOST_DIR PATH_TO_POLYSHAPE_HULLS REPORT.json
"""
import json
import math
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from polyshape_reduce import Oracle, load_clouds, predictions_digest, to_bits, transformed  # noqa: E402

CLOUD = 177
STEPS = [round(-2.5 + 0.05 * i, 2) for i in range(101)]
SWEEPS = [(5, 1), (5, 0), (4, 1), (4, 0)]   # (input point of the reproducer, axis)
TRANSFORMS = [0, 1, 3]                      # as drawn, translated, scaled by 1e2 (held out)


def from_bits(value):
    return struct.unpack('<d', struct.pack('<Q', value))[0]


def reproducer_indices():
    frozen = json.load(open(os.path.join(HERE, '..', '..', '..', '..', 'exes', 'samsrf', 'core', 'tests', 'matlab_polyshape_reproducers.json')))
    return frozen['oneMinimal'][str(CLOUD)][0]


def perturbed(base, point, axis, value):
    q = list(base)
    p = list(q[point - 1])
    p[axis] = value
    q[point - 1] = tuple(p)
    return q


def cases_of(spec, cloud_points):
    """Every case's polygon: the reproducer with one coordinate replaced, then transformed."""
    base = [cloud_points[k - 1] for k in spec['indices']]
    out = []
    for item in spec['perturbations']:
        polygon = perturbed(base, item['point'], item['axis'], from_bits(int(item['value'], 16)))
        out.append(transformed(polygon, 0, 0, item['transform']))
    return out


def sliver(stage, polygon, point):
    """The first union's ring through `point` (1-based) and its clean from all
    8 start and direction choices: 'k' keeps a ring with that point."""
    centre, scale = stage['centre'], stage['scale']
    grid = {(math.trunc((p[0] - centre[0]) * scale), math.trunc((p[1] - centre[1]) * scale)): k + 1 for k, p in enumerate(polygon)}
    target = next((g for g, k in grid.items() if k == point), None)
    rings = [[tuple(v) for v in ring] for ring in stage['firstUnion'] if any(grid.get(tuple(v)) == point for v in ring)]
    return target, rings


def main_spec():
    root, hulls, stages_binary, out = sys.argv[2:6]
    clouds, _ = load_clouds(root)
    indices = reproducer_indices()
    base = [clouds[CLOUD][k - 1] for k in indices]
    xs, ys = [p[0] for p in base], [p[1] for p in base]
    tolerance = 1e-8 * max(max(xs) - min(xs), max(ys) - min(ys))
    perturbations = []
    for transform in TRANSFORMS:
        for point, axis in SWEEPS:
            for step in STEPS:
                value = base[point - 1][axis] + step * tolerance
                perturbations.append({'point': point, 'axis': axis, 'step': step, 'transform': transform,
                                      'value': f'{to_bits(value):016x}'})
    spec = {'cloud': CLOUD, 'role': 'perturbation', 'indices': indices, 'perturbations': perturbations}
    polygons = cases_of(spec, clouds[CLOUD])
    oracle = Oracle(hulls)
    results = oracle.evaluate(polygons)
    spec['predictionsSha256'] = predictions_digest(polygons, results)
    # Per-case survival of input point 4 under H_X (experimental output) and H_I
    # (every clean start keeps the sliver).
    requests, owners = [], []
    survive_x = []
    for i, (polygon, result) in enumerate(zip(polygons, results)):
        stage = result['experimentalStages']
        target, rings = sliver(stage, polygon, 4)
        survive_x.append(any(tuple(v) == target for ring in stage['secondClean'] for v in ring))
        for ring in rings:
            for reversed_ in (0, 1):
                q = ring[::-1] if reversed_ else ring
                for k in range(len(q)):
                    requests.append({'rings': [q[k:] + q[:k]], 'tolerance': stage['tolerance']})
                    owners.append((i, target))
    cleaned = json.loads(subprocess.run([stages_binary, '--clean'], input=json.dumps(requests), text=True, capture_output=True, check=True).stdout)
    keeps = [True] * len(polygons)
    seen = [False] * len(polygons)
    for (i, target), paths in zip(owners, cleaned):
        seen[i] = True
        if not any(tuple(v) == target for path in paths for v in path):
            keeps[i] = False
    survive_i = [k and s for k, s in zip(keeps, seen)]
    spec['predictSurvival'] = {
        'H_X': ''.join('1' if v else '0' for v in survive_x),
        'H_I': ''.join('1' if v else '0' for v in survive_i),
    }
    differ = sum(a != b for a, b in zip(survive_x, survive_i))
    with open(out, 'w') as f:
        json.dump(spec, f, separators=(',', ':'))
        f.write('\n')
    print(f'{len(perturbations)} cases; H_X and H_I differ on {differ}; predictions {spec["predictionsSha256"]}')


def main_report():
    import numpy as np
    from polyshape_reduce import hull_set
    root, hulls, out = sys.argv[2:5]
    spec = json.load(open(os.path.join(HERE, 'polyshape-reproducers-6.json')))
    recording = json.load(open(os.path.join(root, 'geometry.json')))
    case = next(c for c in recording['cases'] if c['id'] == 'reproducer_round6')
    original = next(c for c in recording['cases'] if c['id'] == 'reproducer_cases')

    def read(descriptor):
        assert descriptor['class'] == 'double' and descriptor['imaginary'] == ''
        values = np.fromfile(os.path.join(root, descriptor['file']), dtype='<f8')
        shape = descriptor['shape']
        assert values.size == int(np.prod(shape))
        return values.reshape(shape[::-1]).T if len(shape) == 2 else values

    def split(c, field, counts):
        rows, result, offset = read(c[field]), [], 0
        for n in read(c[counts]).ravel():
            assert n == int(n) and n >= 0
            result.append(rows[offset:offset + int(n)])
            offset += int(n)
        assert offset == len(rows), field
        return result

    # Cloud 177 as the first batch's full-cloud control recorded it.
    first = json.load(open(os.path.join(HERE, 'polyshape-reproducers.json')))
    control = next(k for k, c in enumerate(first['cases']) if c['cloud'] == CLOUD and c['role'] == 'original')
    cloud = [tuple(map(float, r)) for r in split(original, 'points', 'counts')[control]]
    polygons = split(case, 'points', 'counts')
    n = len(spec['perturbations'])
    assert len(polygons) == n
    expected = cases_of(spec, cloud)
    for i in range(n):
        assert [tuple(map(float, r)) for r in polygons[i]] == expected[i], f'case {i}: polygon differs from the spec'
    results = Oracle(hulls).evaluate(expected)
    assert predictions_digest(expected, results) == spec['predictionsSha256'], 'predictions differ from the committed digest'
    default = split(case, 'simplified', 'simplifiedCounts')
    kept = split(case, 'collinearVertices', 'collinearCounts')
    matlab_hulls = split(case, 'hull', 'hullCounts')
    holes = split(case, 'defaultHoles', 'defaultHolesCounts')
    rows = []
    for i, item in enumerate(spec['perturbations']):
        point4 = expected[i][3]
        vertices = {tuple(map(float, r)) for r in default[i] if not np.isnan(r[0])}
        kept_vertices = {tuple(map(float, r)) for r in kept[i] if not np.isnan(r[0])}
        hull = frozenset(tuple(map(float, r)) for r in matlab_hulls[i])
        rows.append({
            'case': i, 'point': item['point'], 'axis': item['axis'], 'step': item['step'], 'transform': item['transform'],
            'survives': point4 in vertices, 'keptHasPoint4': point4 in kept_vertices,
            'H_X': spec['predictSurvival']['H_X'][i] == '1', 'H_I': spec['predictSurvival']['H_I'][i] == '1',
            'hullShipped': hull == hull_set(results[i]['production']), 'hullExperimental': hull == hull_set(results[i]['experimental']),
            'defaultRings': int(len(holes[i])), 'defaultHoles': int(np.sum(holes[i])),
        })
    summary = {}
    for name in ('H_X', 'H_I'):
        summary[name] = sum(r['survives'] == r[name] for r in rows)
    summary['hullShipped'] = sum(r['hullShipped'] for r in rows)
    summary['hullExperimental'] = sum(r['hullExperimental'] for r in rows)
    summary['cases'] = n
    json.dump({'summary': summary, 'rows': rows}, open(out, 'w'), indent=0)
    print(summary)
    for sweep in SWEEPS:
        for transform in TRANSFORMS:
            seq = [r for r in rows if (r['point'], r['axis']) == sweep and r['transform'] == transform]
            line, prev = [], None
            for r in seq:
                key = (r['survives'], r['H_X'], r['H_I'])
                if key != prev:
                    line.append(f"{r['step']:+.2f}:M{int(r['survives'])}X{int(r['H_X'])}I{int(r['H_I'])}")
                    prev = key
            print(f'point {sweep[0]} axis {sweep[1]} transform {transform}: ' + ' '.join(line))


if __name__ == '__main__':
    if sys.argv[1] == 'spec':
        main_spec()
    elif sys.argv[1] == 'report':
        main_report()
