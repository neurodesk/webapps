"""Ordered boundary comparison of MATLAB's default polyshape (#732).

MATLAB's `polyshape(P).Vertices` is recorded in order, one NaN row between
boundaries (record_geometry.m's polygon batches). Earlier comparisons used hull
vertex sets, ring vertex sets and hole flags, which sort vertices and so cannot
see edges, connectivity or which solid a hole belongs to. This reads the
recorded rings as cycles and compares them with the experimental model's final
rings (and its diagnostic variants, through `polyshape_hulls --oracle`):

- cycle: the ring's vertex bit patterns up to cyclic start and direction (the
  only normalisation applied; MATLAB orders solids clockwise, holes
  counter-clockwise, Clipper the other way round);
- edges: the undirected edge set of all rings;
- hole flag: MATLAB's ishole per boundary where recorded (causal and reproducer
  modes), otherwise the sign of the ring's shoelace (MATLAB: clockwise solid);
- membership: each hole's containing solid, the smallest-area solid whose
  closed polygon contains every vertex of the hole.

Each polygon is classified at its first difference, in this order: `hull`
(hull vertex sets differ), `survival` (the union of ring vertices differs),
`connectivity` (same vertices, different edge sets), `cycles` (same edges,
different cycles), `holes` (same cycles, different hole flags), `membership`
(same holed cycles, different containing solids), or `equal`. Hull equality is
reported separately because the hull can agree while the rings do not.

`--digest` writes, without any model, one SHA-256 per recorded batch over
MATLAB's canonical ordered rings with their hole flags (structured by case,
ring and vertex counts), so a frozen gate can hold the ordered observable rather
than a sorted vertex set.

  cargo build --release -p samsrf-core --features polyshape-experimental --example polyshape_hulls
  python3 -I polyshape_ordered_rings.py compare PATH_TO_POLYSHAPE_HULLS HOST_DIR CASE_ID [CASE_ID...] > report.json
  python3 -I polyshape_ordered_rings.py digest HOST_DIR CASE_ID [CASE_ID...]
  python3 -I polyshape_ordered_rings.py table VARIANT[,VARIANT...] report.json [report.json...]

`table` prints, per batch, the polygons whose rings equal MATLAB's in every
ordered observable and whose hull vertex set equals MATLAB's, for the
experimental model and each named variant; for a variant also the hulls it
gains and loses against the experimental model, and how many of the lost ones
had rings equal to MATLAB's under the experimental model.

Evidence, not a gate.
"""
import collections
from fractions import Fraction
import hashlib
import json
import math
import os
import struct
import subprocess
import sys

import numpy as np

VARIANTS = ('experimental', 'h-merge', 'h-merge-single', 'h-start', 'h-touch-pre', 'h-touch-post', 'h-nonstrict-post', 'h-hull-grid', 'h-hull-polyshape')
STAGES = ('hull', 'survival', 'connectivity', 'cycles', 'holes', 'membership', 'equal')


def to_bits(value):
    return struct.unpack('<Q', struct.pack('<d', value))[0]


class Batch:
    """One recorded polygon batch, validated for class, shape, bytes, finiteness
    and complete consumption of every array it reads."""

    def __init__(self, root, case_id):
        with open(os.path.join(root, 'geometry.json')) as source:
            recording = json.load(source)
        matches = [c for c in recording['cases'] if c['id'] == case_id]
        if len(matches) != 1:
            raise ValueError(f'{case_id}: expected exactly one case')
        self.root, self.id, self.case = root, case_id, matches[0]
        if self.case.get('kind') != 'polygon-batch':
            raise ValueError(f'{case_id}: not a polygon batch')
        self.n = self.case['cases']
        if type(self.n) is not int or self.n < 0:
            raise ValueError(f'{case_id}: invalid case count')
        self.polygons = self._split('points', 'counts', 2, nan_rows=False)
        self.hulls = self._split('hull', 'hullCounts', 2, nan_rows=False)
        self.vertices = self._split('simplified', 'simplifiedCounts', 2, nan_rows=True)
        self.flags = (self._split('defaultHoles', 'defaultHolesCounts', 1, nan_rows=False)
                      if 'defaultHoles' in self.case else None)
        errors = self._read('error', 1).ravel()
        self.failed = [bool(e) for e in errors]
        if len(self.failed) != self.n:
            raise ValueError(f'{case_id}: error inventory')
        self.rings = []
        for i, rows in enumerate(self.vertices):
            rings = split_rings(rows)
            if self.flags is not None:
                flags = [int(f[0]) for f in self.flags[i]]
                if any(f not in (0, 1) for f in flags):
                    raise ValueError(f'{case_id}[{i}]: hole flags must be binary')
                if len(flags) != len(rings):
                    raise ValueError(f'{case_id}[{i}]: {len(flags)} hole flags for {len(rings)} rings')
            else:
                # MATLAB orders solid boundaries clockwise (negative shoelace).
                flags = [int(signed_area(r) > 0) for r in rings]
            self.rings.append(list(zip(flags, rings)))

    def _read(self, field, columns):
        descriptor = self.case[field]
        if descriptor['class'] != 'double' or descriptor['imaginary'] != '':
            raise ValueError(f'{field}: expected real double data')
        shape = descriptor['shape']
        if (not isinstance(shape, list) or len(shape) != 2 or any(type(k) is not int or k < 0 for k in shape)
                or shape[1] != columns):
            raise ValueError(f'{field}: expected a matrix with {columns} columns')
        filename = descriptor['file']
        if not filename or os.path.basename(filename) != filename:
            raise ValueError(f'{field}: expected a bare file name')
        path = os.path.join(self.root, filename)
        if os.path.getsize(path) != shape[0] * shape[1] * 8:
            raise ValueError(f'{field}: byte count does not match shape')
        return np.fromfile(path, dtype='<f8').reshape(shape[::-1]).T

    def _split(self, field, counts_field, columns, nan_rows):
        rows, counts = self._read(field, columns), self._read(counts_field, 1).ravel()
        if len(counts) != self.n:
            raise ValueError(f'{counts_field}: expected {self.n} counts')
        finite = np.isfinite(rows)
        if nan_rows:
            # NaN only as whole separator rows.
            if not np.all(finite.all(axis=1) | np.isnan(rows).all(axis=1)):
                raise ValueError(f'{field}: non-finite values outside NaN separator rows')
        elif not finite.all():
            raise ValueError(f'{field}: expected finite values')
        out, offset = [], 0
        for k in counts:
            if not (math.isfinite(k) and k == int(k) and k >= 0):
                raise ValueError(f'{counts_field}: invalid count {k}')
            out.append(rows[offset:offset + int(k)])
            offset += int(k)
        if offset != len(rows):
            raise ValueError(f'{field}: counts do not consume all rows')
        return out


def split_rings(rows):
    rings, current = [], []
    for x, y in rows:
        if math.isnan(x):
            if not current:
                raise ValueError('empty boundary between NaN rows')
            rings.append(current)
            current = []
        else:
            current.append((to_bits(float(x)), to_bits(float(y))))
    if current:
        rings.append(current)
    elif len(rows):
        raise ValueError('trailing NaN row')
    return rings


def value(point):
    return tuple(struct.unpack('<d', struct.pack('<Q', b))[0] for b in point)


def signed_area(ring):
    """The shoelace area, exactly (rational arithmetic on the doubles)."""
    pts = [tuple(Fraction(v) for v in value(p)) for p in ring]
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])) / 2


def canonical_cycle(ring):
    """The ring's lexicographically smallest rotation over both directions."""
    candidates = []
    for seq in (list(ring), list(reversed(ring))):
        for k in range(len(seq)):
            candidates.append(tuple(seq[k:] + seq[:k]))
    return min(candidates)


def edges(rings):
    out = collections.Counter()
    for _, ring in rings:
        for a, b in zip(ring, ring[1:] + ring[:1]):
            out[(min(a, b), max(a, b))] += 1
    return out


def contains(ring, point):
    """Closed point-in-polygon (boundary counts as inside), exactly."""
    pts = [tuple(Fraction(v) for v in value(p)) for p in ring]
    x, y = (Fraction(v) for v in value(point))
    inside = False
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
        if cross == 0 and min(x1, x2) <= x <= max(x1, x2) and min(y1, y2) <= y <= max(y1, y2):
            return True
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def membership(rings):
    """Each hole's canonical cycle mapped to its containing solid's (None when no
    solid contains every vertex)."""
    solids = [(abs(signed_area(r)), canonical_cycle(r), r) for flag, r in rings if not flag]
    result = {}
    for flag, ring in rings:
        if flag:
            owners = sorted((a, c) for a, c, r in solids if all(contains(r, p) for p in ring))
            result[canonical_cycle(ring)] = owners[0][1] if owners else None
    return result


def classify(matlab_hull, matlab_rings, model_hull, model_rings):
    """The first observable at which the model departs from MATLAB."""
    stages = {}
    stages['hull'] = sorted(matlab_hull) == sorted(model_hull)
    stages['survival'] = ({p for _, r in matlab_rings for p in r} == {p for _, r in model_rings for p in r})
    stages['connectivity'] = edges(matlab_rings) == edges(model_rings)
    stages['cycles'] = (collections.Counter(canonical_cycle(r) for _, r in matlab_rings)
                        == collections.Counter(canonical_cycle(r) for _, r in model_rings))
    stages['holes'] = (collections.Counter((f, canonical_cycle(r)) for f, r in matlab_rings)
                       == collections.Counter((f, canonical_cycle(r)) for f, r in model_rings))
    stages['membership'] = stages['holes'] and membership(matlab_rings) == membership(model_rings)
    first = next((s for s in STAGES[1:-1] if not stages[s]), 'equal')
    return first, stages['hull']


def oracle(binary, polygons):
    bits = [[[to_bits(float(x)), to_bits(float(y))] for x, y in p] for p in polygons]
    result = subprocess.run([binary, '--oracle'], input=json.dumps(bits), text=True, capture_output=True, check=True)
    out = json.loads(result.stdout)
    if len(out) != len(polygons):
        raise ValueError('oracle result count')
    return out


def model_rings(variant):
    return [(int(r['hole']), [(to_bits(x), to_bits(y)) for x, y in r['vertices']]) for r in variant['rings']]


def model_hull(variant):
    hull = variant['hull']
    return [] if hull is None else [(to_bits(x), to_bits(y)) for x, y in hull['hull']]


def compare(binary, root, case_ids, chunk=2000):
    report = {}
    for case_id in case_ids:
        batch = Batch(root, case_id)
        rows = []
        for start in range(0, batch.n, chunk):
            results = oracle(binary, [list(map(tuple, p)) for p in batch.polygons[start:start + chunk]])
            for offset, result in enumerate(results):
                i = start + offset
                hull = [(to_bits(float(x)), to_bits(float(y))) for x, y in batch.hulls[i]]
                row = {'index': i, 'matlabFailed': batch.failed[i], 'matlabRings': len(batch.rings[i]),
                       'matlabHoles': sum(f for f, _ in batch.rings[i])}
                for name in VARIANTS:
                    variant = result['variants'][name]
                    if 'error' in variant:
                        row[name] = {'first': 'error', 'hull': False}
                        continue
                    first, hull_equal = classify(hull, batch.rings[i], model_hull(variant), model_rings(variant))
                    row[name] = {'first': first, 'hull': hull_equal}
                rows.append(row)
        summary = {}
        for name in VARIANTS:
            counts = collections.Counter((r[name]['first'], r[name]['hull']) for r in rows)
            summary[name] = {f'{first}/{"hull-equal" if h else "hull-differs"}': k
                             for (first, h), k in sorted(counts.items())}
        report[case_id] = {'polygons': batch.n, 'flagsRecorded': batch.flags is not None,
                           'summary': summary, 'rows': rows}
    return report


def digest(root, case_id):
    """SHA-256 over MATLAB's canonical ordered rings with hole flags, ring order
    within a polygon sorted by canonical cycle (MATLAB's boundary order is kept as
    a separate digest)."""
    batch = Batch(root, case_id)
    canonical, ordered = hashlib.sha256(), hashlib.sha256()
    for h in (canonical, ordered):
        h.update(struct.pack('<Q', batch.n))
    for rings in batch.rings:
        cycles = [(f, canonical_cycle(r)) for f, r in rings]
        for h, seq in ((canonical, sorted(cycles)), (ordered, [(f, tuple(r)) for f, r in rings])):
            h.update(struct.pack('<Q', len(seq)))
            for f, cycle in seq:
                h.update(struct.pack('<BQ', f, len(cycle)))
                for x, y in cycle:
                    h.update(struct.pack('<QQ', x, y))
    return {'case': case_id, 'polygons': batch.n, 'rings': sum(len(r) for r in batch.rings),
            'vertices': sum(len(c) for rings in batch.rings for _, c in rings),
            'canonicalSha256': canonical.hexdigest(), 'recordedOrderSha256': ordered.hexdigest()}


def table(variants, reports):
    lines = []
    for path in reports:
        with open(path) as source:
            report = json.load(source)
        for case_id, batch in report.items():
            rows = batch['rows']
            cells = [case_id, str(batch['polygons'])]
            for name in ('experimental',) + tuple(variants):
                rings = sum(r[name]['first'] == 'equal' for r in rows)
                hulls = sum(r[name]['hull'] for r in rows)
                cell = f'{name}: rings {rings}, hulls {hulls}'
                if name != 'experimental':
                    lost = [r for r in rows if r['experimental']['hull'] and not r[name]['hull']]
                    gained = sum(not r['experimental']['hull'] and r[name]['hull'] for r in rows)
                    ring_equal_lost = sum(r['experimental']['first'] == 'equal' for r in lost)
                    cell += f' (+{gained} -{len(lost)}, {ring_equal_lost} of the lost ring-equal)'
                cells.append(cell)
            lines.append(' | '.join(cells))
    return lines


def main(argv):
    if len(argv) >= 4 and argv[1] == 'compare':
        json.dump(compare(argv[2], argv[3], argv[4:]), sys.stdout)
    elif len(argv) >= 4 and argv[1] == 'table':
        print('\n'.join(table(argv[2].split(','), argv[3:])))
    elif len(argv) >= 3 and argv[1] == 'digest':
        json.dump([digest(argv[2], c) for c in argv[3:]], sys.stdout, indent=1)
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
