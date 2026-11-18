#!/usr/bin/env python3
"""Inputs and frozen predictions for the convexHull area and grid round (#732).

SamSrfAnalysis takes a reverse-correlation hull's Fwhm from
[K, AV] = convexHull(delaunayTriangulation(txy)) and its pixel grid from
linspace(-a, a, n) (samsrf_revcor_prf.m). The port's formula for AV is not
MATLAB's (`ListedHull::of`, then `delaunay_hull_area`), and the grid's end values are inferred. This
writes the point sets and grids MATLAB records (record_geometry(..., 'hull-area'))
and every candidate's prediction, before any recording
(hull-area-predictions.md).

Usage:
  hull_area_design.py design CLI_SETS INPUTS_JSON
  hull_area_design.py fresh INPUTS_JSON
  hull_area_design.py predict INPUTS_JSON
CLI_SETS lists the 42 double reverse-correlation hull vertices of the pinned
SamSrfAnalysis recording (cli-reference.json, AMD host) with their
suprathreshold pixel coordinates, as cli_rc_hulls.rs rebuilds them from
MATLAB's courses. `design` writes the inputs: each grid's coordinates once, each
point set as runs of MATLAB pixel indices on its grid (reversed sets are flagged,
not repeated). `predict` recomputes every candidate's predictions from the inputs
alone and prints their SHA-256, which hull-area-predictions.md freezes. `fresh`
writes the held-out set its addendum adds for dispatch 2 (seed 7321), with no
discovery sets of its own.
"""
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import random
import struct
import sys

ROUND = 'hull-area-1'
SEED = 7320

# Candidate areas, each from the hull's vertices in the order named.
AREA_MODELS = ('A0', 'A1', 'A2', 'A3', 'A4', 'A5')
GRID_MODELS = ('L0', 'L1', 'L2', 'L3')


def bits(value):
    return struct.unpack('<Q', struct.pack('<d', value))[0]


def hexed(value):
    return f'{bits(value):016x}'


def unhex(text):
    return struct.unpack('<d', struct.pack('<Q', int(text, 16)))[0]


# Grids: linspace(-a, a, n) under each candidate. n = 1 gives [a] in all.

def grid(model, a, n):
    if n == 1:
        return [a]
    n1 = n - 1
    if model in ('L0', 'L1'):
        # Symmetric: (2i - (n - 1)) * (a / (n - 1)).
        step = a / n1
        values = [(2.0 * i - n1) * step for i in range(n)]
    else:
        # Ascending: d1 + ((0:n1) .* (d2 - d1)) ./ n1.
        width = a - (-a)
        values = [-a + (i * width) / n1 for i in range(n)]
    if model in ('L0', 'L2'):
        values[0] = -a
        values[-1] = a
    return values


# The hull's boundary as convexHull lists it, by the port's model: exact
# predicates, exactly collinear points kept, counter-clockwise from the first
# input point on it, closed.

def orientation(a, b, c):
    value = (Fraction(b[0]) - Fraction(a[0])) * (Fraction(c[1]) - Fraction(a[1])) - (Fraction(b[1]) - Fraction(a[1])) * (Fraction(c[0]) - Fraction(a[0]))
    return (value > 0) - (value < 0)


def boundary(points):
    ordered = sorted(set(points))
    if len(ordered) < 3 or all(orientation(ordered[0], ordered[1], p) == 0 for p in ordered[2:]):
        return None

    def chain(sequence):
        half = []
        for p in sequence:
            while len(half) >= 2 and orientation(half[-2], half[-1], p) < 0:
                half.pop()
            half.append(p)
        half.pop()
        return half

    ring = chain(ordered) + chain(reversed(ordered))
    on = set(ring)
    start = next(p for p in points if p in on)
    k = ring.index(start)
    return ring[k:] + ring[:k]


def indices(points, ring):
    first = {}
    for i, p in enumerate(points):
        first.setdefault(p, i + 1)
    k = [first[p] for p in ring]
    return k + k[:1]


# Areas. Every sum runs left to right in double precision.

def port_area(points):
    """`ListedHull::of` (then `delaunay_hull_area`): corners counter-clockwise from the lexicographically
    smallest, cross products from that corner."""
    ordered = sorted(set(points))
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower = []
    for p in ordered:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0.0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(ordered):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0.0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    origin = hull[0]
    twice = 0.0
    for i in range(len(hull)):
        a = (hull[i][0] - origin[0], hull[i][1] - origin[1])
        nxt = hull[(i + 1) % len(hull)]
        b = (nxt[0] - origin[0], nxt[1] - origin[1])
        twice += a[0] * b[1] - b[0] * a[1]
    return abs(twice) / 2.0


def shoelace(closed, translate):
    origin = closed[0] if translate else (0.0, 0.0)
    s = 0.0
    for p, q in zip(closed, closed[1:]):
        x1, y1 = p[0] - origin[0], p[1] - origin[1]
        x2, y2 = q[0] - origin[0], q[1] - origin[1]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def trapezoid(closed):
    """polyarea's sum((x(next) - x) .* (y(next) + y)), wrapping, left to right."""
    s = 0.0
    n = len(closed)
    for i in range(n):
        p, q = closed[i], closed[(i + 1) % n]
        s += (q[0] - p[0]) * (q[1] + p[1])
    return abs(s) / 2.0


def fan(closed, each):
    o = closed[0]
    s = 0.0
    for p, q in zip(closed[1:-1], closed[2:-1]):
        c = (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
        s += abs(c) / 2.0 if each else c
    return s if each else abs(s) / 2.0


def areas(points, k):
    closed = [points[i - 1] for i in k]
    return {
        'A0': port_area(points),
        'A1': shoelace(closed, False),
        'A2': shoelace(closed, True),
        'A3': trapezoid(closed),
        'A4': fan(closed, False),
        'A5': fan(closed, True),
    }


def triangle_areas(points, triangles, model):
    """Areas over a recorded ConnectivityList, rows in order (evaluated after recording)."""
    s = 0.0
    for row in triangles:
        a, b, c = (points[int(v) - 1] for v in row)
        if model in ('T4', 'T5'):
            cross = a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])
        else:
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if model in ('T1', 'T5'):
            s += cross
        elif model in ('T2', 'T4'):
            s += abs(cross) / 2.0
        else:
            s += abs(cross)
    if model in ('T1', 'T5'):
        return abs(s) / 2.0
    return s / 2.0 if model == 'T3' else s


# Point sets.

def blob(rng, a, columns, rows, small=False):
    """MATLAB pixel indices (column-major, top row first: xc(:), yc(:) of
    meshgrid(linspace(-a, a, columns), linspace(-a, a, rows)) with yc flipped)
    above a threshold of one or two oriented bumps with pixel noise."""
    bumps = []
    for _ in range(1 if small or rng.random() < 0.6 else 2):
        bumps.append((rng.uniform(-0.8, 0.8) * a, rng.uniform(-0.8, 0.8) * a,
                      rng.uniform(0.02, 0.08 if small else 0.35) * a, rng.uniform(0.02, 0.08 if small else 0.35) * a,
                      rng.uniform(0.0, math.pi), rng.uniform(0.5, 1.0)))
    noise = {(c, r): rng.uniform(-0.04, 0.04) for c in range(columns) for r in range(rows)}
    xs, ys = grid('L0', a, columns), grid('L0', a, rows)

    def value(c, r):
        x, y = xs[c], ys[rows - 1 - r]
        total = noise[c, r]
        for cx, cy, sx, sy, angle, height in bumps:
            u = (x - cx) * math.cos(angle) + (y - cy) * math.sin(angle)
            v = -(x - cx) * math.sin(angle) + (y - cy) * math.cos(angle)
            total += height * math.exp(-0.5 * ((u / sx) ** 2 + (v / sy) ** 2))
        return total

    values = {(c, r): value(c, r) for c in range(columns) for r in range(rows)}
    peak = max(values.values())
    threshold = peak * rng.uniform(0.3, 0.7)
    return [c * rows + r for c in range(columns) for r in range(rows) if values[c, r] > threshold]


GRIDS_DISCOVERY = [(9.5, 100, 100)]
GRIDS_HELD_OUT = [(9.5, 100, 100), (10.0, 100, 100), (6.25, 64, 64), (12.3, 101, 101), (3.7, 50, 50), (8.0, 128, 96)]


def grid_identity(a, columns, rows):
    return f'g_{hexed(a)}_{columns}x{rows}'


def runs(indices):
    """Ascending linear pixel indices as [start, length] runs."""
    out = []
    for i in indices:
        if out and out[-1][0] + out[-1][1] == i:
            out[-1][1] += 1
        else:
            out.append([i, 1])
    return out


def designed(cli):
    """The point sets, each as its grid and MATLAB pixel indices."""
    rng = random.Random(SEED)
    grids = {}
    sets = []

    def grid_of(a, columns, rows):
        identity = grid_identity(a, columns, rows)
        grids.setdefault(identity, {'identity': identity, 'half': a, 'columns': columns, 'rows': rows})
        return identity

    def add(identity, family, role, gid, pixel_indices, reverse=False):
        sets.append({'identity': identity, 'family': family, 'role': role, 'grid': gid, 'runs': runs(pixel_indices), 'reverse': reverse})
        if boundary(points_of(grids, sets[-1])) is None:
            sets.pop()
            return False
        return True

    for entry in cli:
        a, columns, rows = entry['scalingFactor'], entry['columns'], entry['rows']
        gid = grid_of(a, columns, rows)
        xs, ys = grid('L0', a, columns), grid('L0', a, rows)
        where = {(bits(x), bits(ys[rows - 1 - r])): c * rows + r for c, x in enumerate(xs) for r in range(rows)}
        pixel_indices = [where[int(x, 16), int(y, 16)] for x, y in entry['points']]
        if pixel_indices != sorted(pixel_indices):
            raise ValueError('CLI pixels must be in MATLAB pixel order')
        tag = f"{entry['run']}_p{entry['position']:02d}"
        add(f'cli_{tag}', 'cli', 'discovery', gid, pixel_indices)
        add(f'cli_reversed_{tag}', 'cli-reversed', 'discovery', gid, pixel_indices, True)
    for role, choices, count, small in (('discovery', GRIDS_DISCOVERY, 20, False), ('discovery', GRIDS_DISCOVERY, 20, True),
                                        ('heldout', GRIDS_HELD_OUT, 120, False), ('heldout', GRIDS_HELD_OUT, 40, True)):
        made = 0
        while made < count:
            a, columns, rows = choices[made % len(choices)]
            pixel_indices = blob(rng, a, columns, rows, small)
            if not 3 <= len(pixel_indices) <= 2500:
                continue
            family = 'small' if small else 'blob'
            identity = f"{family}_{'d' if role == 'discovery' else 'h'}{made:03d}"
            gid = grid_of(a, columns, rows)
            if add(identity, family, role, gid, pixel_indices):
                if role == 'heldout' and not small and made % 2 == 0:
                    add(f'{identity}_reversed', 'blob-reversed', role, gid, pixel_indices, True)
                made += 1
    return list(grids.values()), sets


def linspaces():
    """Regular grids, then grids whose last symmetric value (n - 1) * (a / (n - 1))
    is not a: the first three such n below 300 for each half, so that L0 and L1
    differ on every one of them."""
    out = []
    for role, halves, counts in (('discovery', (9.5, 0.1, 0.3, 1.1, 2.3, 10.0, 12.7, 0.7), (1, 2, 3, 7, 20, 99, 100, 101)),
                                 ('heldout', (1.9, 3.3, 5.7, 6.1, 13.1, 0.2, 4.7, 7.9), (4, 5, 19, 21, 50, 64, 128, 255))):
        for a in halves:
            for n in counts:
                out.append({'identity': f"{'d' if role == 'discovery' else 'h'}_{hexed(a)}_n{n}", 'role': role, 'half': a, 'n': n})
    taken = {(e['half'], e['n']) for e in out}
    for role, halves in (('discovery', (0.1, 0.3, 0.7, 1.1, 2.3, 12.7)), ('heldout', (0.2, 1.9, 3.3, 4.7, 5.7, 6.1, 7.9, 13.1))):
        for a in halves:
            ends = [n for n in range(3, 300) if (a, n) not in taken and grid('L0', a, n) != grid('L1', a, n)][:3]
            for n in ends:
                out.append({'identity': f"{'d' if role == 'discovery' else 'h'}e_{hexed(a)}_n{n}", 'role': role, 'half': a, 'n': n})
    return out


def fresh():
    """The addendum's fresh held-out sets and grids (seed 7321)."""
    rng = random.Random(7321)
    grids = {}
    sets = []
    made = 0
    while made < 60:
        a, columns, rows = GRIDS_HELD_OUT[made % len(GRIDS_HELD_OUT)]
        small = made >= 40
        pixel_indices = blob(rng, a, columns, rows, small)
        if not 3 <= len(pixel_indices) <= 2500:
            continue
        identity = grid_identity(a, columns, rows)
        grids.setdefault(identity, {'identity': identity, 'half': a, 'columns': columns, 'rows': rows})
        family = 'small' if small else 'blob'
        entry = {'identity': f'{family}_f{made:03d}', 'family': family, 'role': 'fresh', 'grid': identity, 'runs': runs(pixel_indices), 'reverse': False}
        if boundary(points_of(grids, entry)) is None:
            continue
        sets.append(entry)
        if not small and made % 2 == 0:
            sets.append({**entry, 'identity': f'{family}_f{made:03d}_reversed', 'family': 'blob-reversed', 'reverse': True})
        made += 1
    entries = []
    for a in (2.9, 4.1, 6.7, 8.3, 11.9, 0.45):
        for n in (6, 9, 33, 77, 101, 150):
            entries.append({'identity': f'f_{hexed(a)}_n{n}', 'role': 'fresh', 'half': a, 'n': n})
        taken = {(e['half'], e['n']) for e in entries}
        for n in [n for n in range(3, 300) if (a, n) not in taken and grid('L0', a, n) != grid('L1', a, n)][:2]:
            entries.append({'identity': f'fe_{hexed(a)}_n{n}', 'role': 'fresh', 'half': a, 'n': n})
    return list(grids.values()), sets, entries


def points_of(grids, entry):
    """A set's points in the order MATLAB receives them."""
    g = grids[entry['grid']] if isinstance(grids, dict) else next(x for x in grids if x['identity'] == entry['grid'])
    xs, ys = grid('L0', g['half'], g['columns']), grid('L0', g['half'], g['rows'])
    rows = g['rows']
    points = [(xs[i // rows], ys[rows - 1 - i % rows]) for start, length in entry['runs'] for i in range(start, start + length)]
    return points[::-1] if entry['reverse'] else points


def encoded(grids, sets, grid_entries):
    return {
        'round': ROUND,
        'grids': [{'identity': g['identity'], 'columns': g['columns'], 'rows': g['rows'],
                   'xs': [hexed(v) for v in grid('L0', g['half'], g['columns'])],
                   'ys': [hexed(v) for v in grid('L0', g['half'], g['rows'])]} for g in grids],
        'sets': sets,
        'linspace': [{'identity': e['identity'], 'role': e['role'], 'half': hexed(e['half']), 'n': e['n']} for e in grid_entries],
    }


def decoded_points(inputs, entry):
    """Points from the inputs' own coordinates (what record_geometry.m does)."""
    g = next(x for x in inputs['grids'] if x['identity'] == entry['grid'])
    xs, ys, rows = [unhex(v) for v in g['xs']], [unhex(v) for v in g['ys']], g['rows']
    points = [(xs[i // rows], ys[rows - 1 - i % rows]) for start, length in entry['runs'] for i in range(start, start + length)]
    return points[::-1] if entry['reverse'] else points


def predictions(inputs):
    result = {'sets': {}, 'linspace': {}}
    for entry in inputs['sets']:
        points = decoded_points(inputs, entry)
        k = indices(points, boundary(points))
        corner_points = [points[i - 1] for i in k[:-1]]
        corner_k = indices(corner_points, boundary(corner_points))
        result['sets'][entry['identity']] = {
            'hullSha256': hashlib.sha256(json.dumps(k).encode()).hexdigest(),
            'hullLength': len(k),
            'areas': {m: hexed(v) for m, v in areas(points, k).items()},
            'cornersHullSha256': hashlib.sha256(json.dumps(corner_k).encode()).hexdigest(),
            'cornersAreas': {m: hexed(v) for m, v in areas(corner_points, corner_k).items()},
        }
    for e in inputs['linspace']:
        a = unhex(e['half'])
        result['linspace'][e['identity']] = {m: hashlib.sha256(''.join(hexed(v) for v in grid(m, a, e['n'])).encode()).hexdigest() for m in GRID_MODELS}
    return result


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def main(arguments):
    if len(arguments) == 3 and arguments[0] == 'design':
        cli = json.loads(Path(arguments[1]).read_text())
        if len(cli) != 42 or any(len(entry['points']) < 3 for entry in cli):
            raise ValueError('expected the 42 double RC hull vertices')
        grids, sets = designed(cli)
        inputs = encoded(grids, sets, linspaces())
        Path(arguments[2]).write_text(json.dumps(inputs, separators=(',', ':')) + '\n')
        print(f"{len(sets)} point sets on {len(grids)} grids, {len(inputs['linspace'])} linspace calls")
    elif len(arguments) == 2 and arguments[0] == 'fresh':
        grids, sets, entries = fresh()
        inputs = {**encoded(grids, sets, entries), 'round': ROUND + ' fresh held-out (addendum)'}
        Path(arguments[1]).write_text(json.dumps(inputs, separators=(',', ':')) + '\n')
        print(f"{len(sets)} point sets on {len(grids)} grids, {len(entries)} linspace calls")
    elif len(arguments) == 2 and arguments[0] == 'predict':
        inputs = json.loads(Path(arguments[1]).read_text())
        print(digest(predictions(inputs)))
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
