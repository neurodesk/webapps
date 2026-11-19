#!/usr/bin/env python3
"""Lane-tree models for x'*y and their FPRev LCA sizes (discovery fitting)."""
import itertools

def build(n, lanes, strides, tail, half=None):
    """Return the tree as nested tuples over element indices 0..n-1.
    tail: 'pow2' (chunks lanes/2, lanes/4, ... from lane 0), 'mod' (round-robin),
          'halfmask' (one chunk of `half` from lane 0 if it fits, then the rest as one
          masked chunk from lane 0), 'mask' (the whole rest as one masked chunk)."""
    acc = [None] * lanes
    def add(k, e):
        acc[k] = e if acc[k] is None else (acc[k], e)
    blocked = n if tail == 'mod' else n // lanes * lanes
    for i in range(blocked):
        add(i % lanes, i)
    rest = list(range(blocked, n))
    if tail == 'pow2':
        chunk = lanes // 2
        while rest and chunk >= 1:
            if len(rest) >= chunk:
                for k, e in enumerate(rest[:chunk]):
                    add(k, e)
                rest = rest[chunk:]
            chunk //= 2
    elif tail == 'halfmask':
        h = half or lanes // 2
        while len(rest) >= h:
            for k, e in enumerate(rest[:h]):
                add(k, e)
            rest = rest[h:]
        for k, e in enumerate(rest):
            add(k, e)
        rest = []
    elif tail == 'mask':
        for k, e in enumerate(rest):
            add(k, e)
        rest = []
    consumed = set()
    for stride in strides:
        for k in range(lanes):
            if (k // stride) % 2 == 0 and k + stride < lanes and k not in consumed and k + stride not in consumed:
                if acc[k] is not None and acc[k + stride] is not None:
                    acc[k] = (acc[k], acc[k + stride])
                elif acc[k] is None:
                    acc[k] = acc[k + stride]
                consumed.add(k + stride)
    total = acc[0]
    for e in rest:
        total = e if total is None else (total, e)
    return total

def lca_sizes(tree):
    sizes = {}
    def walk(t):
        if isinstance(t, int):
            return [t]
        a, b = walk(t[0]), walk(t[1])
        for x in a:
            for y in b:
                sizes[(min(x, y), max(x, y))] = len(a) + len(b)
        return a + b
    walk(tree)
    return sizes
