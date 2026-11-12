#!/usr/bin/env python3
"""Rebuild ?gemv's summation trees from record_qr_kernels.m probes (FPRev).

Usage: python3 -I qr-trees.py KERNELS_DIR REPORT_JSON

Each probe holds, for every pair i < j, the result of summing ones with +M
at i and -M at j. Every one added into a partial sum that holds M before -M
cancels it is lost, so the result is m - |subtree of LCA(i, j)|. Two leaves
share a child of a node of size n exactly when their LCA subtree is smaller
than n; applying that recursively rebuilds the tree. Floating-point addition
is commutative, so the tree alone fixes the rounding of the sum.
"""
import json
from pathlib import Path
import struct
import sys


def read_probe(root, descriptor):
    data = (root / descriptor['file']).read_bytes()
    values = struct.unpack(f'<{len(data) // 2}h', data)
    m = descriptor['shape'][0]
    return m, values  # column-major m x m


def subtree_sizes(m, values):
    def size(i, j):
        if i > j:
            i, j = j, i
        # Conjugation negates imaginary probes; the count is the magnitude.
        return m - abs(values[i + j * m])
    return size


def build(leaves, size):
    if len(leaves) == 1:
        return leaves[0]
    n = len(leaves)
    parent = {leaf: leaf for leaf in leaves}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for a_index, a in enumerate(leaves):
        for b in leaves[a_index + 1:]:
            if size(a, b) < n:
                parent[find(a)] = find(b)
    groups = {}
    for leaf in leaves:
        groups.setdefault(find(leaf), []).append(leaf)
    children = sorted(groups.values(), key=min)
    if len(children) == 1:
        raise ValueError(f'inconsistent probe over {leaves[:4]}...')
    return tuple(build(child, size) for child in children)


def render(tree):
    if isinstance(tree, int):
        return str(tree)
    return '(' + '+'.join(render(child) for child in tree) + ')'


def canonical(tree):
    if isinstance(tree, int):
        return tree
    return tuple(sorted((canonical(c) for c in tree), key=lambda t: min_leaf(t)))


def min_leaf(tree):
    return tree if isinstance(tree, int) else min(min_leaf(c) for c in tree)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    root = Path(sys.argv[1])
    metadata = json.loads((root / 'kernels.json').read_text())
    probes = metadata['probes'] if isinstance(metadata['probes'], list) else [metadata['probes']]
    rows = []
    for probe in probes:
        m, values = read_probe(root, probe['results'])
        try:
            tree = render(canonical(build(list(range(m)), subtree_sizes(m, values))))
        except ValueError as error:
            # Not a single binary tree of exact additions: e.g. the -M term
            # never meets +M before a lane is rounded, or fused operations.
            tree = f'not a tree: {error}'
        rows.append({'id': probe['id'], 'class': probe['class'], 'part': probe['part'], 'length': m,
                     'alignA': probe['alignA'], 'alignX': probe['alignX'], 'tree': tree})
    Path(sys.argv[2]).write_text(json.dumps({'cpu': next((line.split(':', 1)[1].strip() for line in metadata['environment']['cpu'].splitlines() if line.startswith('Model name')), None),
                                             'blas': metadata['environment']['blas'], 'trees': rows}, indent=1) + '\n')
    for row in rows[:6]:
        print(row['id'], row['tree'][:160])


if __name__ == '__main__':
    main()
