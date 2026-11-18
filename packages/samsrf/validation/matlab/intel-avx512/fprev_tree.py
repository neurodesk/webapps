#!/usr/bin/env python3
"""Reconstruct summation trees from qr-kernels FPRev counts (LCA subtree sizes).

Usage: python3 -I fprev_tree.py KERNELS_HOST_DIR KIND CLASS PART COLUMNS COLUMN [LENGTHS]
e.g. ... ubuntu-22.04-3 ormqr double 0 8 0 13,21,33,65 prints the trees of right-hand side 0
of 8 at those lengths.
"""
import json, os, struct, sys, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('lm', os.path.join(HERE, '..', 'qr-lane-models.py'))
lm = importlib.util.module_from_spec(spec); spec.loader.exec_module(lm)


def tree_from_sizes(m, sizes):
    clusters = {i: (i,) for i in range(m)}
    trees = {i: i for i in range(m)}
    def lca(a, b):
        return sizes[(a, b) if a < b else (b, a)]
    for s in range(2, m + 1):
        merged = True
        while merged:
            merged = False
            keys = sorted(clusters)
            for x in range(len(keys)):
                for y in range(x + 1, len(keys)):
                    A, B = clusters[keys[x]], clusters[keys[y]]
                    if len(A) + len(B) == s and lca(A[0], B[0]) == s:
                        new = min(keys[x], keys[y])
                        old = max(keys[x], keys[y])
                        trees[new] = (trees[keys[x]], trees[keys[y]])
                        clusters[new] = tuple(sorted(A + B))
                        del clusters[old], trees[old]
                        merged = True
                        break
                if merged:
                    break
    assert len(clusters) == 1, f'not a binary tree: {len(clusters)} clusters left'
    return trees[0]


def load(root, kind, cls, part, columns, column):
    out = {}
    for m, sizes in lm.load(root)[(kind, cls, part, columns, column)]:
        out[m] = sizes
    return out


if __name__ == '__main__':
    from pathlib import Path
    root = Path(sys.argv[1])
    kind, cls, part, columns, column = sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
    lengths = [int(v) for v in sys.argv[7].split(',')] if len(sys.argv) > 7 else None
    data = load(root, kind, cls, part, columns, column)
    for m in sorted(data):
        if lengths and m not in lengths:
            continue
        print(m, tree_from_sizes(m, data[m]))
