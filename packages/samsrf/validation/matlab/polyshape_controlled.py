"""Controlled touching-region and enclosed-void polygons for #732 (round 7), with
the predictions of three port models frozen before MATLAB records them.

Every case is one input ring, as SamSrf passes polygons. Families:

  pinwheel   k tips (k = 3..6) around a regular k-gon void of circumradius
             s * tolerance; each tip runs from void corner c_i out to two points
             on the unit circle and back to c_{i+1}, so neighbouring tips touch
             only at the void's corners. The ring then traces the void backwards
             from c_1, so the void is unfilled under the even-odd rule: a void
             enclosed by regions that touch at single vertices.
  lens       two regions that touch each other at two vertices (c_1 and c_3)
             around a quadrilateral void c_1 c_2 c_3 c_4 of width s * tolerance:
             a two-vertex contact control.
  filled     the pinwheel ring without the backward void loop (the void is
             filled): a no-void control.
  gapped     the pinwheel with each corner split into two points g * tolerance
             apart, so neighbouring tips do not touch and the void opens to the
             outside through the gaps: a non-touching control.
  reproducer the 1-minimal reproducers of clouds 932 and 1607 (relevance
             controls).

tolerance = 1e-8 * span of the drawn shape, the experimental model's. Every
shape is drawn at rotation 0 and at an irrational rotation (held out). Each
shape is recorded as drawn and, held out, reversed from another start,
translated by [0.37 -1.21] and scaled by 1e2 (MATLAB applies those exactly).
Coordinates are exact doubles in the spec.

Predictions per case, for the experimental model and its rule variants h-merge
(H_M) and h-merge-single (H_M1), plus the shipped model's hull: the hull vertex
set, and the final rings with their hole flags and vertex sets. Their SHA-256 is
committed in the spec before the first recording.

  python3 polyshape_controlled.py spec GEOMETRY_HOST_DIR PATH_TO_POLYSHAPE_HULLS OUT.json
  python3 polyshape_controlled.py report RECORDING_HOST_DIR PATH_TO_POLYSHAPE_HULLS REPORT.json
"""
import argparse
import hashlib
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from polyshape_reduce import Oracle, load_clouds, to_bits, transformed  # noqa: E402

MODELS = ['experimental', 'h-merge', 'h-merge-single']
SIZES = [0.5, 1, 1.5, 2, 3, 5, 10, 100, 10000]
GAPS = [0.5, 2, 10]
ROTATION = math.sqrt(2) - 1   # radians, irrational
DISCOVERY_K = (3, 5)


def from_bits(value):
    return struct.unpack('<d', struct.pack('<Q', value))[0]


def rotate(points, angle):
    c, s = math.cos(angle), math.sin(angle)
    return [(x * c - y * s, x * s + y * c) for x, y in points]


def polar(radius, angle):
    return (radius * math.cos(angle), radius * math.sin(angle))


TOLERANCE = 2e-8   # 1e-8 * span; every family spans 2 in x or y up to rounding


def span_tolerance(points):
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return 1e-8 * max(max(xs) - min(xs), max(ys) - min(ys))


def pinwheel(k, s, filled=False, gap=None):
    corners = [polar(s * TOLERANCE, 2 * math.pi * i / k) for i in range(k)]
    ring = []
    for i in range(k):
        mid = 2 * math.pi * (i + 0.5) / k
        width = 0.35 * 2 * math.pi / k
        a, b = corners[i], corners[(i + 1) % k]
        if gap is not None:
            # Split each corner into two points g * tolerance apart along the void edge.
            def toward(p, q):
                d = math.hypot(q[0] - p[0], q[1] - p[1])
                t = gap * TOLERANCE / 2 / d
                return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)
            a, b = toward(a, b), toward(b, a)
        ring += [a, polar(1.0, mid - width), polar(1.0, mid + width), b]
    if gap is None:
        # Consecutive tips share their corner: drop the repeated point.
        ring = [p for j, p in enumerate(ring) if j % 4 != 3]
    if not filled:
        ring += [corners[0]] + corners[:0:-1]
    return ring


def lens(s):
    c1, c3 = (-0.5, 0.0), (0.5, 0.0)
    c2, c4 = (0.0, s * TOLERANCE / 2), (0.0, -s * TOLERANCE / 2)
    ring = [c1, (-0.6, 1.0), (0.6, 1.0), c3, (0.6, -1.0), (-0.6, -1.0)]
    return ring + [c1, c4, c3, c2]


def shapes(clouds):
    """(identity, family, parameters, points) of every base shape."""
    frozen = json.load(open(os.path.join(HERE, '..', '..', '..', '..', 'exes', 'samsrf', 'core', 'tests', 'matlab_polyshape_reproducers.json')))
    out = []
    for rotation in (0.0, ROTATION):
        tag = 'r1' if rotation else 'r0'
        for k in (3, 4, 5, 6):
            for s in SIZES:
                out.append((f'pinwheel-k{k}-s{s}-{tag}', 'pinwheel', {'k': k, 's': s, 'rotation': rotation}, rotate(pinwheel(k, s), rotation)))
            out.append((f'filled-k{k}-{tag}', 'filled', {'k': k, 's': 10, 'rotation': rotation}, rotate(pinwheel(k, 10, filled=True), rotation)))
            for g in GAPS:
                for s in (3, 100):
                    out.append((f'gapped-k{k}-s{s}-g{g}-{tag}', 'gapped', {'k': k, 's': s, 'g': g, 'rotation': rotation}, rotate(pinwheel(k, s, gap=g), rotation)))
        for s in SIZES:
            out.append((f'lens-s{s}-{tag}', 'lens', {'s': s, 'rotation': rotation}, rotate(lens(s), rotation)))
    for cloud in (932, 1607):
        indices = frozen['oneMinimal'][str(cloud)][0]
        out.append((f'reproducer-{cloud}', 'reproducer', {'cloud': cloud, 'indices': indices}, [clouds[cloud][k - 1] for k in indices]))
    return out


def heldout(identity, family, parameters, variant):
    """Discovery: the drawn copy of rotation-0 pinwheels with k in DISCOVERY_K and
    of rotation-0 controls; every other copy and shape is held out."""
    if variant != 'drawn':
        return True
    if family == 'reproducer':
        return False
    if parameters.get('rotation'):
        return True
    return family in ('pinwheel', 'filled', 'gapped') and parameters['k'] not in DISCOVERY_K


VARIANTS = [('drawn', 0, 0, 0), ('reversed', 1, 3, 0), ('translated', 0, 0, 1), ('scaled', 0, 0, 3)]


def build(clouds):
    base = shapes(clouds)
    cases = []
    for index, (identity, family, parameters, points) in enumerate(base):
        for name, reversed_, shift, transform in VARIANTS:
            cases.append({'shape': index, 'variant': name, 'reversed': reversed_, 'shift': shift % len(points),
                          'transform': transform, 'heldout': heldout(identity, family, parameters, name)})
    return base, cases


def case_points(base, case):
    return transformed(base[case['shape']][3], case['reversed'], case['shift'], case['transform'])


def canonical(model):
    """A model's prediction in canonical form: hull vertex set and final rings
    (hole flag, vertex set), all as IEEE bits, sorted."""
    if 'error' in model:
        return {'error': True}
    hull = model['hull']
    hull_bits = sorted([to_bits(x), to_bits(y)] for x, y in hull['hull']) if hull else []
    rings = sorted([bool(r['hole']), sorted([to_bits(x), to_bits(y)] for x, y in r['vertices'])] for r in model['rings'])
    return {'hull': hull_bits, 'rings': rings}


def predict(oracle, polygons):
    results = oracle.evaluate(polygons)
    out = []
    for result in results:
        shipped = result['production']
        out.append({
            'shipped': sorted([to_bits(x), to_bits(y)] for x, y in shipped['hull']) if shipped else [],
            **{m: canonical(result['variants'][m]) for m in MODELS},
        })
    return out


def pairs_bytes(pairs):
    out = struct.pack('<I', len(pairs))
    for x, y in pairs:
        out += struct.pack('<QQ', x, y)
    return out


def digest(predictions):
    """SHA-256 over every case: the shipped hull, then for each model in MODELS
    either b'E' (error) or its hull and its rings (count, then per ring the hole
    flag byte and its vertices), every vertex list sorted, as little-endian
    u32 counts and u64 bit patterns. Rust's gate computes the same bytes."""
    h = hashlib.sha256()
    for p in predictions:
        h.update(pairs_bytes(p['shipped']))
        for m in MODELS:
            q = p[m]
            if 'error' in q:
                h.update(b'E')
                continue
            h.update(b'M')
            h.update(pairs_bytes(q['hull']))
            h.update(struct.pack('<I', len(q['rings'])))
            for hole, vertices in q['rings']:
                h.update(bytes([1 if hole else 0]))
                h.update(pairs_bytes(vertices))
    return h.hexdigest()


def main_spec(root, hulls, out):
    clouds, _ = load_clouds(root)
    base, cases = build(clouds)
    predictions = predict(Oracle(hulls), [case_points(base, c) for c in cases])
    spec = {
        'role': 'controlled',
        'tolerance': TOLERANCE,
        'shapes': [{'identity': i, 'family': f, 'parameters': p, 'tolerance': span_tolerance(pts),
                    'points': [[f'{to_bits(x):016x}', f'{to_bits(y):016x}'] for x, y in pts]}
                   for i, f, p, pts in base],
        'cases': cases,
        'predictionsSha256': digest(predictions),
    }
    with open(out, 'w') as f:
        json.dump(spec, f, separators=(',', ':'))
        f.write('\n')
    differ = {pair: sum(p[pair[0]] != p[pair[1]] for p in predictions) for pair in [('experimental', 'h-merge'), ('experimental', 'h-merge-single'), ('h-merge', 'h-merge-single')]}
    holes = {m: sum(any(r[0] for r in p[m].get('rings', [])) for p in predictions) for m in MODELS}
    print(f"{len(base)} shapes, {len(cases)} cases ({sum(c['heldout'] for c in cases)} held out); predictions {spec['predictionsSha256']}")
    print('cases where two models differ:', {f'{a} vs {b}': n for (a, b), n in differ.items()})
    print('cases with a predicted hole:', holes)


def main_report(root, hulls, out):
    """Applies polyshape-reproducers-7-predictions.md's comparison to a recording."""
    import collections
    import numpy as np
    spec = json.load(open(os.path.join(HERE, 'polyshape-reproducers-7.json')))
    recording = json.load(open(os.path.join(root, 'geometry.json')))
    case = next(c for c in recording['cases'] if c['id'] == 'reproducer_round7')

    def read(descriptor):
        assert descriptor['class'] == 'double' and descriptor['imaginary'] == ''
        values = np.fromfile(os.path.join(root, descriptor['file']), dtype='<f8')
        shape = descriptor['shape']
        assert values.size == int(np.prod(shape)) and np.all(np.isfinite(values[~np.isnan(values)]))
        return values.reshape(shape[::-1]).T if len(shape) == 2 else values

    def split(field, counts):
        rows, result, offset = read(case[field]), [], 0
        for n in read(case[counts]).ravel():
            assert n == int(n) and n >= 0
            result.append(rows[offset:offset + int(n)])
            offset += int(n)
        assert offset == len(rows), field
        return result

    base = [(sh['identity'], sh['family'], sh['parameters'], [(from_bits(int(x, 16)), from_bits(int(y, 16))) for x, y in sh['points']]) for sh in spec['shapes']]
    cases = spec['cases']
    polygons = [case_points(base, c) for c in cases]
    recorded = split('points', 'counts')
    assert len(recorded) == len(cases) == 592
    for i, poly in enumerate(polygons):
        assert [tuple(map(float, r)) for r in recorded[i]] == poly, f'case {i}: polygon differs from the spec'
    predictions = predict(Oracle(hulls), polygons)
    assert digest(predictions) == spec['predictionsSha256'], 'predictions differ from the committed digest'
    defaults = split('simplified', 'simplifiedCounts')
    flags = split('defaultHoles', 'defaultHolesCounts')
    matlab_hulls = split('hull', 'hullCounts')
    rows = []
    tally = collections.defaultdict(collections.Counter)
    for i, c in enumerate(cases):
        identity, family, parameters, _ = base[c['shape']]
        boundaries, current = [], []
        for r in defaults[i]:
            if np.isnan(r[0]):
                if current:
                    boundaries.append(current)
                current = []
            else:
                current.append([to_bits(float(r[0])), to_bits(float(r[1]))])
        if current:
            boundaries.append(current)
        holes = [bool(h) for h in np.asarray(flags[i]).ravel()]
        assert len(holes) == len(boundaries), f'case {i}: hole flags and boundaries differ in number'
        matlab_rings = sorted([h, sorted(b)] for h, b in zip(holes, boundaries))
        matlab_hull = sorted([to_bits(float(x)), to_bits(float(y))] for x, y in matlab_hulls[i])
        topology = (sum(not h for h in holes), sum(holes))
        row = {'case': i, 'identity': identity, 'family': family, 'variant': c['variant'], 'heldout': c['heldout'],
               'matlabTopology': topology, 'matlabHullEqualsShipped': matlab_hull == predictions[i]['shipped'],
               'matlabHullEqualsExperimental': matlab_hull == predictions[i]['experimental'].get('hull')}
        for m in MODELS:
            q = predictions[i][m]
            if 'error' in q:
                row[m] = False
                continue
            model_topology = (sum(not r[0] for r in q['rings']), sum(r[0] for r in q['rings']))
            hull_ok = q['hull'] == matlab_hull
            if family == 'reproducer':
                row[m] = hull_ok and model_topology == topology
            else:
                row[m] = hull_ok and q['rings'] == matlab_rings
            row[m + 'Topology'] = model_topology
        rows.append(row)
        split_name = 'heldout' if c['heldout'] else 'discovery'
        tally[(family, split_name)]['cases'] += 1
        tally[(family, split_name)][f"matlab {topology[0]}s{topology[1]}h"] += 1
        for m in MODELS:
            tally[(family, split_name)][m] += row[m]
    json.dump({'rows': rows, 'tally': {f'{f}/{s}': dict(t) for (f, s), t in tally.items()}}, open(out, 'w'), indent=0)
    for (f, s), t in sorted(tally.items()):
        print(f'{f:10s} {s:9s} cases {t["cases"]:3d}', ' '.join(f'{m}={t[m]}' for m in MODELS), {k: v for k, v in t.items() if k.startswith('matlab')})


def main(argv=None):
    parser = argparse.ArgumentParser(description='Generate controlled polygon predictions or compare a recording.')
    parser.add_argument('command', choices=('spec', 'report'))
    parser.add_argument('root', help='Geometry host directory for spec; recording host directory for report')
    parser.add_argument('hulls', help='Path to the polyshape_hulls executable')
    parser.add_argument('out', help='Output JSON path')
    args = parser.parse_args(argv)
    if args.command == 'spec':
        main_spec(args.root, args.hulls, args.out)
    else:
        main_report(args.root, args.hulls, args.out)


if __name__ == '__main__':
    main()
