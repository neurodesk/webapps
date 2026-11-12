"""Stage-by-stage census of the polyshape model against a MATLAB recording.

For each polygon of a recorded batch (record_geometry.m) and the model's stages
(core/examples/polyshape_stages.rs), it reports the first stage at which the
model departs from MATLAB, MATLAB's ring topology as the recording shows it, and
a test of the premise that MATLAB's default polyshape is its KeepCollinearPoints
rings cleaned independently. Evidence for diagnosis, not a gate.

  cargo run --release --example polyshape_stages -- HOST_DIR CASE STAGES.json
  python3 polyshape_census.py HOST_DIR CASE STAGES.json REPORT.json

Stages, in order (the first failing one is the case's first divergence):
  grid     every MATLAB vertex (default and KeepCollinearPoints) is an input
           vertex or exactly k / 10^p + c on the model's grid ('grid ambiguous'
           when the double cannot tell neighbouring grid points apart)
  union    MATLAB's KeepCollinearPoints vertices lie on the model's first
           (strictly simple, even-odd) Clipper union: at its vertices or exactly
           on its edges, where KeepCollinearPoints keeps points the union drops
  rings    MATLAB's KeepCollinearPoints rings equal the model's first-union
           rings restricted to those vertices (as unoriented cycles)
  vertices the model's final vertex set equals MATLAB's default vertex set
  hull     the model's hull vertex set equals MATLAB's
"""
import collections
import json
import math
import os
import struct
import sys

import numpy as np


def load(root, case_id):
    recording = json.load(open(os.path.join(root, 'geometry.json')))
    case = next(c for c in recording['cases'] if c['id'] == case_id)

    def read(descriptor):
        values = np.fromfile(os.path.join(root, descriptor['file']), dtype='<f8')
        shape = descriptor['shape']
        return values.reshape(shape[::-1]).T if len(shape) == 2 else values

    def split(rows, counts):
        out, offset = [], 0
        for n in counts.astype(int).ravel():
            n = max(n, 0)
            out.append(rows[offset:offset + n])
            offset += n
        return out

    data = {
        'points': split(read(case['points']), read(case['counts'])),
        'default': split(read(case['simplified']), read(case['simplifiedCounts'])),
        'hull': split(read(case['hull']), read(case['hullCounts'])),
    }
    if 'collinearVertices' in case:
        data['kept'] = split(read(case['collinearVertices']), read(case['collinearCounts']))
    return data


def rings(rows):
    out, current = [], []
    for v in rows:
        if np.isnan(v[0]):
            if current:
                out.append(current)
            current = []
        else:
            current.append((float(v[0]), float(v[1])))
    if current:
        out.append(current)
    return out


def to_grid(ring, inputs, stage):
    """A MATLAB ring in grid units, or None when a vertex is off the grid."""
    centre, scale = stage['centre'], stage['scale']
    out = []
    for p in ring:
        if p in inputs:
            out.append(inputs[p])
            continue
        k = (round((p[0] - centre[0]) * scale), round((p[1] - centre[1]) * scale))
        inverse = 1.0 / scale
        back = lambda q: (q[0] * inverse + centre[0], q[1] * inverse + centre[1])
        if back(k) != p:
            return None
        # A double coarser than the grid maps several grid points to p.
        if any(back((k[0] + dx, k[1] + dy)) == p for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy):
            raise Ambiguous
        out.append(k)
    return out


class Ambiguous(Exception):
    """A recorded vertex does not determine its grid point."""


def on_edges(p, rings):
    """p is a vertex of, or lies exactly on an edge of, one of rings."""
    for r in rings:
        for j in range(len(r)):
            a, b = r[j], r[(j + 1) % len(r)]
            if p == a:
                return True
            cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
            if cross == 0 and min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1]):
                return True
    return False


def cycle(ring):
    ring = [tuple(p) for p in ring]
    k = ring.index(min(ring))
    return tuple(ring[k:] + ring[:k])


def unoriented(ring):
    return min(cycle(ring), cycle(list(ring)[::-1]))


def area(ring):
    return sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring))) / 2


def distance(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def altitude(a, p, b):
    length = distance(a, b)
    cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])
    return abs(cross) / length if length > 0 else distance(a, p)


def near_collinear(p1, p2, p3, tolerance):
    if abs(p1[0] - p2[0]) > abs(p1[1] - p2[1]):
        if (p1[0] > p2[0]) == (p1[0] < p3[0]):
            x, m, y = p2, p1, p3
        elif (p2[0] > p1[0]) == (p2[0] < p3[0]):
            x, m, y = p1, p2, p3
        else:
            x, m, y = p1, p3, p2
    else:
        if (p1[1] > p2[1]) == (p1[1] < p3[1]):
            x, m, y = p2, p1, p3
        elif (p2[1] > p1[1]) == (p2[1] < p3[1]):
            x, m, y = p1, p2, p3
        else:
            x, m, y = p1, p3, p2
    return altitude(x, m, y) < tolerance


def clean(path, tolerance):
    """The model's clean (polyshape.rs), Clipper's CleanPolygon loop."""
    n = len(path)
    if n == 0:
        return []
    nxt = [(i + 1) % n for i in range(n)]
    prv = [(i - 1) % n for i in range(n)]
    done = [False] * n
    size = n

    def exclude(op):
        result = prv[op]
        nxt[result] = nxt[op]
        prv[nxt[op]] = result
        done[result] = False
        return result

    op = 0
    while not done[op] and nxt[op] != prv[op]:
        a, b, c = path[prv[op]], path[op], path[nxt[op]]
        if distance(b, a) < tolerance:
            op = exclude(op)
            size -= 1
        elif distance(a, c) < tolerance:
            following = nxt[op]
            exclude(following)
            op = exclude(op)
            size -= 2
        elif near_collinear(a, b, c, tolerance):
            op = exclude(op)
            size -= 1
        else:
            done[op] = True
            op = nxt[op]
    if size < 3:
        return []
    out = []
    for _ in range(size):
        out.append(path[op])
        op = nxt[op]
    return out


def topology(kept, input_vertices):
    """MATLAB's KeepCollinearPoints ring topology, from the geometry alone.
    Solid boundaries and holes are told apart by orientation (the sign of the
    larger rings' area gives the solid sign)."""
    if not kept:
        return {}
    signs = [area(r) for r in kept]
    solid_sign = math.copysign(1, max(signs, key=abs))
    solid = [r for r, a in zip(kept, signs) if math.copysign(1, a) == solid_sign]
    holes = [r for r, a in zip(kept, signs) if math.copysign(1, a) != solid_sign]
    solid_vertices = collections.Counter(p for r in solid for p in set(r))
    features = collections.Counter()
    for h in holes:
        contacts = sum(1 for p in set(h) if solid_vertices[p])
        features['hole, %s contact' % ('no' if contacts == 0 else 'one' if contacts == 1 else 'two+')] += 1
    for i in range(len(solid)):
        for j in range(i + 1, len(solid)):
            if len(set(solid[i]) & set(solid[j])) >= 2:
                features['solids sharing two+ vertices (enclosed gap)'] += 1
    for r in kept:
        if not any(p in input_vertices for p in r):
            features['crossing-only ring'] += 1
        if len(set(r)) < len(r):
            features['self-touching ring'] += 1
    return dict(features)


def census(root, case_id, stages_file, kind_of=None):
    data = load(root, case_id)
    stages = json.load(open(stages_file))
    rows = []
    for i, stage in enumerate(stages):
        P = [tuple(map(float, p)) for p in data['points'][i]]
        if stage is None or 'error' in (stage or {}):
            rows.append({'case': i, 'first': 'model empty or error'})
            continue
        inputs = {}
        centre, scale = stage['centre'], stage['scale']
        for p in P:
            inputs.setdefault(p, (math.trunc((p[0] - centre[0]) * scale), math.trunc((p[1] - centre[1]) * scale)))
        try:
            default = [to_grid(r, inputs, stage) for r in rings(data['default'][i])]
            kept = [to_grid(r, inputs, stage) for r in rings(data['kept'][i])] if 'kept' in data else []
            hull = to_grid([tuple(map(float, p)) for p in data['hull'][i] if not np.isnan(p[0])], inputs, stage)
        except Ambiguous:
            rows.append({'case': i, 'kind': kind_of(i) if kind_of else None, 'first': 'grid ambiguous'})
            continue
        row = {'case': i, 'kind': kind_of(i) if kind_of else None}
        stage_ok = {}
        stage_ok['grid'] = all(r is not None for r in default + kept) and hull is not None
        first_union = [[tuple(p) for p in r] for r in stage['firstUnion']]
        union_vertices = set(p for r in first_union for p in r)
        kept_vertices = set(p for r in kept for p in r) if stage_ok['grid'] else set()
        stage_ok['union'] = stage_ok['grid'] and all(p in union_vertices or on_edges(p, first_union) for p in kept_vertices)
        if stage_ok['union']:
            restricted = []
            for r in first_union:
                # Insert the kept vertices lying on each edge, in order along it.
                full = []
                for j in range(len(r)):
                    a, b = r[j], r[(j + 1) % len(r)]
                    full.append(a)
                    between = [p for p in kept_vertices if p not in (a, b) and on_edges(p, [[a, b]])]
                    between.sort(key=lambda p: (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2)
                    full.extend(between)
                q = [p for p in full if p in kept_vertices]
                q = [p for j, p in enumerate(q) if p != q[j - 1]] if len(q) > 1 else q
                if len(q) >= 3:
                    restricted.append(q)
            stage_ok['rings'] = collections.Counter(map(unoriented, restricted)) == collections.Counter(map(unoriented, kept))
        else:
            stage_ok['rings'] = False
        final = set(tuple(p) for r in stage['secondClean'] for p in r)
        stage_ok['vertices'] = stage_ok['grid'] and final == set(p for r in default for p in r)
        model_hull = set(tuple(p) for p in stage['hull']) if len(stage['hull']) >= 3 else set()
        stage_ok['hull'] = stage_ok['grid'] and model_hull == set(hull)
        row['stages'] = stage_ok
        row['first'] = next((name for name in ('grid', 'union', 'rings', 'vertices', 'hull') if not stage_ok[name]), 'none')
        if stage_ok['grid'] and kept:
            input_vertices = set(inputs.values())
            row['topology'] = topology(kept, input_vertices)
            tolerance = stage['tolerance']
            premise = [c for c in (clean(r, tolerance) for r in kept) if c]
            row['premise'] = set(p for r in premise for p in r) == set(p for r in default for p in r)
            kept_of = {}
            for k, r in enumerate(kept):
                for p in r:
                    kept_of.setdefault(p, set()).add(k)
            row['default rings spanning two+ kept rings'] = sum(1 for r in default if len(set.union(*[kept_of.get(p, set()) for p in r]) if r else set()) >= 2 and not any(set(r) <= set(k) for k in kept))
        rows.append(row)
    return rows


def summarise(rows):
    summary = collections.Counter()
    by_topology = collections.defaultdict(collections.Counter)
    for row in rows:
        key = (row.get('kind'), row['first'])
        summary[key] += 1
        features = tuple(sorted(row.get('topology', {}))) or ('none',)
        by_topology[features][(row['first'], row.get('premise'))] += 1
    return summary, by_topology


if __name__ == '__main__':
    root, case_id, stages_file, report = sys.argv[1:5]
    kind = (lambda i: (i + 1) % 5) if case_id in ('probe_point_clouds', 'probe_heldout_clouds', 'polygon_point_clouds') else None
    rows = census(root, case_id, stages_file, kind)
    summary, by_topology = summarise(rows)
    for key, count in sorted(summary.items(), key=str):
        print('first divergence', key, count)
    for features, counts in sorted(by_topology.items(), key=lambda kv: -sum(kv[1].values())):
        print('topology', features, dict(counts))
    json.dump({'case': case_id, 'rows': rows}, open(report, 'w'), indent=0)
