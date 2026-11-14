"""Reduces the four point clouds the experimental polyshape model regresses
(#732: 177, 932, 1607, 1937 of record_geometry.m's point_clouds, 0-based) to
small reproducers, without MATLAB.

On each full cloud MATLAB's and the experimental hull differ in whether some
input points (the witnesses) are hull vertices. The proxy for "the experimental
model still differs from MATLAB" is that every witness stays in the reduced
cloud, the shipped model (which equals MATLAB on the four recorded clouds) puts
it on or off the hull as MATLAB did, and the experimental model does the
opposite. A proxy based on any hull difference instead reduces to crossing
vertices placed by different intersection rules, which is not the recorded
discrepancy. The proxy is only a prediction: polyshape_reproducer_cases.m
records MATLAB on every reduction this writes, and only that recording decides
which reductions reproduce the discrepancy. Deletion keeps the input order
(SamSrf passes clusters in breadth-first order), so a reproducer is a list of
1-based indices into the original cloud.

It writes polyshape-reproducers.json: for each cloud the full cloud (a
control that must equal the pinned recording), the witnesses, the 1-minimal
reduction, every accepted reduction on the way, each one-point deletion
of the minimal reduction, and the minimal reduction reversed, at every cyclic
start, translated by [0.37 -1.21] and scaled by 1e-2 and 1e2 (MATLAB applies
the same transforms in polyshape_reproducer_cases.m). Each case carries both
models' predicted hull, area and centroid as IEEE-754 bits, written before
MATLAB is recorded on them.

  cargo build --release --features polyshape-experimental --example polyshape_hulls
  python3 polyshape_reduce.py GEOMETRY_HOST_DIR PATH_TO_POLYSHAPE_HULLS OUT.json

`round2` writes polyshape-reproducers-2.json from the first recording's report
(polyshape_reproducers_report.py): for each cloud, the smallest untransformed
case on which MATLAB's hull equals the shipped model's and not the experimental
one (the smallest measured reproducer), each of its one-point deletions, and
its other starts, its reversal and the three transforms when neither the first
round nor the causal probe (which has every transform of the full clouds)
recorded them. Predictions again come from both models before recording.

  python3 polyshape_reduce.py round2 GEOMETRY_HOST_DIR PATH_TO_POLYSHAPE_HULLS FIRST_REPORT.json OUT.json

`round3` writes polyshape-reproducers-3.json for clouds whose second-round
reproducer was not 1-minimal: every one-point deletion that still reproduced in
MATLAB, and each of their one-point deletions.

  python3 polyshape_reduce.py round3 GEOMETRY_HOST_DIR PATH_TO_POLYSHAPE_HULLS SECOND_REPORT.json OUT.json

`lookahead` continues one cloud's reduction from recorded verdicts alone
(exes/samsrf/core/tests/matlab_polyshape_reproducers.json, never a model): the
frontier is every recorded untransformed reproducer of the smallest recorded
size, and the round records every subset that deletes 1 to DEPTH points from a
frontier member and was not recorded before, as role 'reduction'.

  python3 polyshape_reduce.py lookahead GEOMETRY_HOST_DIR PATH_TO_POLYSHAPE_HULLS CLOUD DEPTH OUT.json
"""
import json
import os
import struct
import subprocess
import sys

import numpy as np

CLOUDS = (177, 932, 1607, 1937)


def load_clouds(root):
    recording = json.load(open(os.path.join(root, 'geometry.json')))
    case = next(c for c in recording['cases'] if c['id'] == 'polygon_point_clouds')

    def read(descriptor):
        values = np.fromfile(os.path.join(root, descriptor['file']), dtype='<f8')
        shape = descriptor['shape']
        return values.reshape(shape[::-1]).T if len(shape) == 2 else values

    def split(rows, counts):
        out, offset = [], 0
        for n in counts.ravel().astype(int):
            out.append([tuple(map(float, r)) for r in rows[offset:offset + n]])
            offset += n
        assert offset == len(rows)
        return out

    return (split(read(case['points']), read(case['counts'])),
            split(read(case['hull']), read(case['hullCounts'])))


def to_bits(value):
    return struct.unpack('<Q', struct.pack('<d', value))[0]


class Oracle:
    def __init__(self, binary):
        self.binary = binary
        self.cache = {}

    def evaluate(self, polygons):
        missing = [p for p in polygons if tuple(p) not in self.cache]
        if missing:
            bits = [[[to_bits(x), to_bits(y)] for x, y in p] for p in missing]
            result = subprocess.run([self.binary, '--oracle'], input=json.dumps(bits),
                                    text=True, capture_output=True, check=True)
            for p, r in zip(missing, json.loads(result.stdout)):
                self.cache[tuple(p)] = r
        return [self.cache[tuple(p)] for p in polygons]


def hull_set(model):
    return None if model is None or 'error' in model else frozenset(map(tuple, model['hull']))


def witnesses(cloud, matlab_hull, experimental):
    """Input points on exactly one of MATLAB's and the experimental hull, with
    whether MATLAB has them."""
    matlab, ours = frozenset(matlab_hull), hull_set(experimental)
    return {p: p in matlab for p in set(cloud) if (p in matlab) != (p in ours)}


def reproduces(cloud, witness, result, kept):
    """The proxy: every witness is kept, the shipped hull has it as MATLAB's
    full-cloud hull did and the experimental hull does not."""
    points = {cloud[k] for k in kept}
    production, experimental = hull_set(result['production']), hull_set(result['experimental'])
    if production is None or experimental is None:
        return False
    return all(p in points and (p in production) == on and (p in experimental) != on for p, on in witness.items())


def ddmin(cloud, oracle, witness):
    """Zeller's ddmin over point indices; keeps the input order. Returns the
    1-minimal index list and every accepted reduction on the way."""
    indices = list(range(len(cloud)))
    chain = [list(indices)]
    n = 2
    while len(indices) >= 2:
        size = len(indices)
        chunks = [indices[i * size // n:(i + 1) * size // n] for i in range(n)]
        candidates = [c for c in chunks if len(c) >= 3] + [[k for k in indices if k not in c] for c in chunks]
        candidates = [c for c in candidates if len(c) >= 3]
        results = oracle.evaluate([[cloud[k] for k in c] for c in candidates])
        accepted = next((c for c, r in zip(candidates, results) if reproduces(cloud, witness, r, c)), None)
        if accepted is not None:
            indices = accepted
            chain.append(list(indices))
            n = max(n - 1, 2)
            continue
        if n >= size:
            break
        n = min(size, 2 * n)
    return indices, chain


def transformed(points, reversed_, shift, transform):
    """record_geometry.m's transforms: flipud, then circshift(-shift), or a
    translation by [0.37 -1.21] (1) or scaling by 1e-2 (2) or 1e2 (3)."""
    q = list(reversed(points)) if reversed_ else list(points)
    q = q[shift:] + q[:shift]
    if transform == 1:
        q = [(x + 0.37, y + -1.21) for x, y in q]
    elif transform == 2:
        q = [(x * 1e-2, y * 1e-2) for x, y in q]
    elif transform == 3:
        q = [(x * 1e2, y * 1e2) for x, y in q]
    return q


def prediction(model):
    if model is None:
        return {'empty': True}
    if 'error' in model:
        return {'error': model['error']}
    return {
        'hull': sorted([to_bits(x), to_bits(y)] for x, y in model['hull']),
        'area': to_bits(model['area']),
        'centroid': [to_bits(v) for v in model['centroid']],
    }


def cases_of(entry):
    """Every recorded case of one cloud: (role, indices, reversed, shift, transform)."""
    cases = [('original', entry['chain'][0], 0, 0, 0), ('minimal', entry['minimal'], 0, 0, 0)]
    cases += [('chain', c, 0, 0, 0) for c in entry['chain'][1:-1]]
    cases += [('oneDeleted', c, 0, 0, 0) for c in entry['oneDeleted']]
    n = len(entry['minimal'])
    cases += [('order', entry['minimal'], r, k, 0) for r in (0, 1) for k in range(n) if (r, k) != (0, 0)]
    cases += [('scale', entry['minimal'], 0, 0, t) for t in (1, 2, 3)]
    return cases


def main():
    root, binary, out = sys.argv[1:4]
    clouds, matlab_hulls = load_clouds(root)
    oracle = Oracle(binary)
    report = []
    for cloud_id in CLOUDS:
        cloud = clouds[cloud_id]
        original = oracle.evaluate([cloud])[0]
        assert hull_set(original['production']) == frozenset(matlab_hulls[cloud_id]), f'{cloud_id}: shipped model no longer equals MATLAB'
        witness = witnesses(cloud, matlab_hulls[cloud_id], original['experimental'])
        assert witness, f'{cloud_id}: no input point separates the hulls'
        minimal, chain = ddmin(cloud, oracle, witness)
        neighbours = [[k for k in minimal if k != j] for j in minimal]
        neighbour_results = oracle.evaluate([[cloud[k] for k in c] for c in neighbours])
        assert not any(reproduces(cloud, witness, r, c) for r, c in zip(neighbour_results, neighbours)), f'{cloud_id}: not 1-minimal'
        report.append({
            'cloud': cloud_id,
            'points': len(cloud),
            'witnesses': [{'point': list(p), 'onMatlabHull': on} for p, on in sorted(witness.items())],
            'minimal': [k + 1 for k in minimal],
            'chain': [[k + 1 for k in c] for c in chain],
            'oneDeleted': [[k + 1 for k in c] for c in neighbours if len(c) >= 3],
        })
        print(f'cloud {cloud_id}: {len(cloud)} points -> {len(minimal)} ({len(chain)} accepted reductions)')
    polygons, specs = [], []
    for entry in report:
        cloud = clouds[entry['cloud']]
        for role, indices, reversed_, shift, transform in cases_of(entry):
            polygons.append(transformed([cloud[k - 1] for k in indices], reversed_, shift, transform))
            specs.append({'cloud': entry['cloud'], 'role': role, 'indices': indices,
                          'reversed': reversed_, 'shift': shift, 'transform': transform})
    for spec, result in zip(specs, oracle.evaluate(polygons)):
        spec['predicted'] = {'shipped': prediction(result['production']), 'experimental': prediction(result['experimental'])}
    with open(out, 'w') as f:
        json.dump({'clouds': report, 'cases': specs}, f, indent=1)
        f.write('\n')
    print(f'{len(specs)} cases')


def round2():
    root, binary, first_report, out = sys.argv[2:6]
    clouds, _ = load_clouds(root)
    oracle = Oracle(binary)
    first = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'polyshape-reproducers.json')))
    rows = json.load(open(first_report))['rows']
    polygons, specs, chosen = [], [], []
    for cloud_id in CLOUDS:
        candidates = [(len(first['cases'][r['case']]['indices']), r['case']) for r in rows
                      if r['cloud'] == cloud_id and r['transform'] == 0 and r['reversed'] == 0 and r['shift'] == 0
                      and r['matlabEqualsShipped'] and not r['matlabEqualsExperimental']]
        size, case = min(candidates)
        reproducer = first['cases'][case]['indices']
        # The causal probe already recorded every transform of the full clouds.
        recorded_orders = size == len(clouds[cloud_id]) or any(
            c['role'] == 'order' and c['cloud'] == cloud_id and c['indices'] == reproducer for c in first['cases'])
        chosen.append({'cloud': cloud_id, 'reproducer': reproducer, 'firstRoundCase': case})
        cases = [('reproducer', reproducer, 0, 0, 0)]
        cases += [('oneDeleted', [k for k in reproducer if k != j], 0, 0, 0) for j in reproducer if len(reproducer) > 3]
        if not recorded_orders:
            cases += [('order', reproducer, r, k, 0) for r in (0, 1) for k in range(size) if (r, k) != (0, 0)]
            cases += [('scale', reproducer, 0, 0, t) for t in (1, 2, 3)]
        for role, indices, reversed_, shift, transform in cases:
            polygons.append(transformed([clouds[cloud_id][k - 1] for k in indices], reversed_, shift, transform))
            specs.append({'cloud': cloud_id, 'role': role, 'indices': indices,
                          'reversed': reversed_, 'shift': shift, 'transform': transform})
    for spec, result in zip(specs, oracle.evaluate(polygons)):
        spec['predicted'] = {'shipped': prediction(result['production']), 'experimental': prediction(result['experimental'])}
    with open(out, 'w') as f:
        json.dump({'reproducers': chosen, 'cases': specs}, f, indent=1)
        f.write('\n')
    print(f'{len(specs)} cases', [(c['cloud'], len(c['reproducer'])) for c in chosen])


def round3():
    root, binary, second_report, out = sys.argv[2:6]
    clouds, _ = load_clouds(root)
    oracle = Oracle(binary)
    second = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'polyshape-reproducers-2.json')))
    rows = json.load(open(second_report))['rows']
    reproducing = [second['cases'][r['case']] for r in rows if r['role'] == 'oneDeleted'
                   and r['matlabEqualsShipped'] and not r['matlabEqualsExperimental']]
    seen, cases = set(), []
    for item in reproducing:
        for role, indices in [('reproducer', item['indices'])] + [('oneDeleted', [k for k in item['indices'] if k != j]) for j in item['indices']]:
            key = (item['cloud'], tuple(indices))
            if key not in seen:
                seen.add(key)
                cases.append({'cloud': item['cloud'], 'role': role, 'indices': indices, 'reversed': 0, 'shift': 0, 'transform': 0})
    polygons = [[clouds[c['cloud']][k - 1] for k in c['indices']] for c in cases]
    for spec, result in zip(cases, oracle.evaluate(polygons)):
        spec['predicted'] = {'shipped': prediction(result['production']), 'experimental': prediction(result['experimental'])}
    with open(out, 'w') as f:
        json.dump({'reproducers': [{'cloud': c['cloud'], 'reproducer': c['indices']} for c in reproducing], 'cases': cases}, f, indent=1)
        f.write('\n')
    print(f'{len(cases)} cases from {len(reproducing)} reproducers')


SPECS = [('reproducer_cases', 'polyshape-reproducers.json'), ('reproducer_round2', 'polyshape-reproducers-2.json'),
         ('reproducer_round3', 'polyshape-reproducers-3.json'), ('reproducer_round4', 'polyshape-reproducers-4.json'),
         ('reproducer_round5', 'polyshape-reproducers-5.json')]


def recorded_cases(cloud_id):
    """(indices, verdict) of every recorded untransformed case of one cloud, from
    the spec files and the frozen verdicts of the recordings."""
    here = os.path.dirname(os.path.abspath(__file__))
    frozen = json.load(open(os.path.join(here, '..', '..', '..', '..', 'exes', 'samsrf', 'core', 'tests', 'matlab_polyshape_reproducers.json')))
    result = []
    for case_id, name in SPECS:
        path = os.path.join(here, name)
        if case_id not in frozen['verdicts']:
            continue
        spec = json.load(open(path))
        verdicts = frozen['verdicts'][case_id]
        if isinstance(verdicts, str):
            verdicts = [(int(d) >> 1 == 1, int(d) & 1 == 1) for d in verdicts]
        items = expand(spec) if 'masks' in spec else spec['cases']
        assert len(verdicts) == len(items), case_id
        for item, verdict in zip(items, verdicts):
            if item['cloud'] == cloud_id and item['transform'] == 0 and item['reversed'] == 0 and item['shift'] == 0:
                result.append((tuple(item['indices']), tuple(verdict)))
    return result


def prediction_bytes(model):
    """One model's predicted hull as bytes for the round digest: 0 for an empty
    hull, else 1, then the sorted vertex bits, the area bits and the centroid bits,
    each as little-endian u64."""
    if model is None:
        return b'\x00'
    assert 'error' not in model, model
    out = bytearray(b'\x01')
    for x, y in sorted((to_bits(x), to_bits(y)) for x, y in model['hull']):
        out += struct.pack('<QQ', x, y)
    out += struct.pack('<Q', to_bits(model['area']))
    out += struct.pack('<QQ', *(to_bits(v) for v in model['centroid']))
    return bytes(out)


def expand(spec):
    """The cases of a compact round (bitmasks of 1-based indices into one cloud)."""
    return [{'cloud': spec['cloud'], 'role': spec['role'], 'indices': [k + 1 for k in range(64) if mask >> k & 1],
             'reversed': 0, 'shift': 0, 'transform': 0} for mask in spec['masks']]


def predictions_digest(cases, results):
    """SHA-256 over every case's shipped then experimental prediction_bytes."""
    import hashlib
    digest = hashlib.sha256()
    for result in results:
        digest.update(prediction_bytes(result['production']))
        digest.update(prediction_bytes(result['experimental']))
    return digest.hexdigest()


def lookahead():
    import itertools
    root, binary, cloud_id, depth, out = sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
    clouds, _ = load_clouds(root)
    oracle = Oracle(binary)
    recorded = recorded_cases(cloud_id)
    reproducing = [indices for indices, verdict in recorded if verdict == (True, False)]
    size = min(map(len, reproducing))
    frontier = sorted(set(r for r in reproducing if len(r) == size))
    seen = set(indices for indices, _ in recorded)
    subsets = set()
    for member in frontier:
        for d in range(1, depth + 1):
            for dropped in itertools.combinations(member, d):
                indices = tuple(k for k in member if k not in dropped)
                if len(indices) >= 3 and indices not in seen:
                    subsets.add(indices)
    ordered = sorted(subsets, key=lambda c: (-len(c), c))
    spec = {'cloud': cloud_id, 'role': 'reduction', 'depth': depth, 'frontier': [list(m) for m in frontier],
            'masks': [sum(1 << (k - 1) for k in c) for c in ordered]}
    cases = expand(spec)
    assert [tuple(c['indices']) for c in cases] == ordered
    results = oracle.evaluate([[clouds[cloud_id][k - 1] for k in c['indices']] for c in cases])
    spec['predictionsSha256'] = predictions_digest(cases, results)
    with open(out, 'w') as f:
        json.dump(spec, f, separators=(',', ':'))
        f.write('\n')
    print(f'{len(cases)} cases from a frontier of {len(frontier)} {size}-point reproducers; predictions {spec["predictionsSha256"]}')


if __name__ == '__main__':
    if sys.argv[1] == 'lookahead':
        lookahead()
    elif sys.argv[1] == 'round3':
        round3()
    elif sys.argv[1] == 'round2':
        round2()
    else:
        main()
