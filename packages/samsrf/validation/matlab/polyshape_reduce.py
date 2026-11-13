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


if __name__ == '__main__':
    main()
