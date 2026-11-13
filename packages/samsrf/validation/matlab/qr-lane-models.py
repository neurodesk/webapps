#!/usr/bin/env python3
"""Fit lane-tree summation models to one host's FPRev probes.

Usage: python3 -I qr-lane-models.py KERNELS_HOST_DIR REPORT_JSON [--max-lanes N]

KERNELS_HOST_DIR is one record_qr_kernels.m recording (kernels.json and its
arrays). For every probe group (`?gemv` probes at offset 0, and each recorded
`?ormqr` column), the report gives either one model that reproduces the FPRev
counts at every recorded length, or the models that fit each length. The
recorded count for a pair i < j is m - |LCA subtree of i and j| (its
magnitude for imaginary probes, which conjugation negates), so a model fits
exactly when it gives every pair the same LCA subtree size.

A model is (layout, lanes, strides, tail):
- layout `vector`: all m slots, c(1) included, go round-robin into the lanes;
  `seed`: c(1) starts lane 0 and the products follow from lane 0 (MKL's AMD
  `?gemv`); `first`: the first product starts lane 0, the others follow from
  lane 0 and c(1) is added last (MKL's AMD `?ormqr`); `c0last`: the products
  go round-robin from lane 0 and c(1) is added last.
- the lanes fold pairwise in `strides` order: lane k takes lane k + s when
  k / s is even.
- tail `mod`: every element round-robin; `seq`: whole blocks of `lanes`, the
  rest added after the fold in order; `pow2`: whole blocks, then the rest in
  power-of-two chunks (lanes / 2, lanes / 4, ...) each from lane 0.

This is a hypothesis family, not MKL's code: a group with no fitting model needs
another family. The AMD recordings fit the models lstsq.rs implements for every
group whose block equals its lane count.
"""
import collections
import itertools
import json
from pathlib import Path
import struct
import sys

LAYOUTS = ('vector', 'seed', 'first', 'c0last')
TAILS = ('mod', 'seq', 'pow2')


def lca_sizes(m, layout, lanes, strides, tail):
    sizes = {}

    def combine(a, b):
        for x in a:
            for y in b:
                sizes[(x, y) if x < y else (y, x)] = len(a) + len(b)
        return a + b

    acc = [None] * lanes
    if layout == 'vector':
        body = list(range(m))
    elif layout == 'seed':
        acc[0] = [0]
        body = list(range(1, m))
    elif layout == 'first':
        acc[0] = [1] if m > 1 else None
        body = list(range(2, m))
    else:
        body = list(range(1, m))
    blocked = len(body) if tail == 'mod' else len(body) // lanes * lanes
    for i, x in enumerate(body[:blocked]):
        k = i % lanes
        acc[k] = [x] if acc[k] is None else combine(acc[k], [x])
    rest = body[blocked:]
    if tail == 'pow2':
        chunk = lanes // 2
        while rest and chunk >= 1:
            if len(rest) >= chunk:
                for k, x in enumerate(rest[:chunk]):
                    acc[k] = [x] if acc[k] is None else combine(acc[k], [x])
                rest = rest[chunk:]
            chunk //= 2
    consumed = set()
    for stride in strides:
        for k in range(lanes):
            if (k // stride) % 2 == 0 and k + stride < lanes and k not in consumed and k + stride not in consumed:
                if acc[k] is not None and acc[k + stride] is not None:
                    acc[k] = combine(acc[k], acc[k + stride])
                elif acc[k] is None:
                    acc[k] = acc[k + stride]
                consumed.add(k + stride)
    total = acc[0]
    for x in rest:
        total = [x] if total is None else combine(total, [x])
    if layout in ('first', 'c0last'):
        total = [0] if total is None else combine([0], total)
    return sizes


def candidates(max_lanes):
    lanes = 1
    while lanes <= max_lanes:
        powers = [2 ** i for i in range(lanes.bit_length() - 1)]
        orders = sorted(set(itertools.permutations(sorted(powers, reverse=True))), reverse=True)
        for layout in LAYOUTS:
            for strides in orders:
                for tail in TAILS:
                    yield (layout, lanes, strides, tail)
        lanes *= 2


def recorded_sizes(values, m, plane):
    v = values[plane * m * m:(plane + 1) * m * m]
    return {(i, j): m - abs(v[i + j * m]) for i in range(m) for j in range(i + 1, m)}


def load(root):
    metadata = json.loads((root / 'kernels.json').read_text())
    groups = collections.defaultdict(list)
    for kind in ('probes', 'ormqr'):
        for probe in metadata[kind]:
            if kind == 'probes' and (probe['alignA'] or probe['alignX']):
                continue  # alignment does not change any recorded tree
            m = probe['length']
            if m < 3:
                continue
            data = (root / probe['results']['file']).read_bytes()
            if probe['results']['file'].endswith('.i16'):
                values = struct.unpack(f'<{len(data) // 2}h', data)
            else:
                values = struct.unpack(f'<{len(data) // 8}d', data)
            columns = probe.get('recordedColumns', [0])
            columns = columns if isinstance(columns, list) else [columns]
            for slot, column in enumerate(columns):
                key = (kind, probe['class'], probe['part'], probe.get('columns', 1), column)
                groups[key].append((m, recorded_sizes(values, m, slot if kind == 'ormqr' else 0)))
    return groups


def label(model):
    layout, lanes, strides, tail = model
    return f"{layout}/{lanes}/{'-'.join(map(str, strides)) or '-'}/{tail}"


def main():
    args = sys.argv[1:]
    max_lanes = 32
    if '--max-lanes' in args:
        at = args.index('--max-lanes')
        max_lanes = int(args[at + 1])
        del args[at:at + 2]
    if len(args) != 2:
        raise SystemExit(__doc__)
    root, report_path = Path(args[0]), Path(args[1])
    models = list(candidates(max_lanes))
    report = []
    for key, items in sorted(load(root).items()):
        items.sort(key=lambda item: item[0])
        short = [item for item in items if item[0] <= 40][:6] or items[:2]
        whole = [model for model in models
                 if all(lca_sizes(m, *model) == sizes for m, sizes in short)
                 and all(lca_sizes(m, *model) == sizes for m, sizes in items)]
        row = {'kind': key[0], 'class': key[1], 'part': key[2], 'columns': key[3], 'column': key[4],
               'lengths': [m for m, _ in items], 'oneModel': [label(model) for model in whole[:4]]}
        if not whole and key[0] == 'probes':
            row['perLength'] = {m: [label(model) for model in models if lca_sizes(m, *model) == sizes][:3]
                                for m, sizes in items}
        report.append(row)
        print(f"{key}: {len(items)} lengths, one model: {row['oneModel'][:1] or 'none'}", flush=True)
    report_path.write_text(json.dumps(report, indent=1) + '\n')


if __name__ == '__main__':
    main()
