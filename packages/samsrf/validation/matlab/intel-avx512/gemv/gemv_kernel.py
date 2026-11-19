#!/usr/bin/env python3
"""Candidate MKL AVX512_E1 y'*A (dgemv 'T') per column, written a priori from the
identified Intel ?ormqr kernels (prereg-dot-gemv.md Q2), and the port's AMD model."""
import math

def _fold(acc, strides):
    lanes = len(acc)
    consumed = set()
    for stride in strides:
        for k in range(lanes):
            if (k // stride) % 2 == 0 and k + stride < lanes and k not in consumed and k + stride not in consumed:
                if acc[k] is not None and acc[k + stride] is not None:
                    acc[k] = acc[k] + acc[k + stride]
                elif acc[k] is None:
                    acc[k] = acc[k + stride]
                consumed.add(k + stride)
    return acc[0]

def single(y, a):
    """16 lanes over whole blocks of 16 products, the rest in chunks 8, 4, 2, 1 from lane 0,
    folds 8, 4, 1, 2, products accumulated with FMA."""
    n = len(y)
    acc = [None] * 16
    def add(k, i):
        acc[k] = y[i] * a[i] if acc[k] is None else math.fma(y[i], a[i], acc[k])
    blocked = n // 16 * 16
    for i in range(blocked):
        add(i % 16, i)
    rest = list(range(blocked, n))
    chunk = 8
    while rest and chunk >= 1:
        if len(rest) >= chunk:
            for k, i in enumerate(rest[:chunk]):
                add(k, i)
            rest = rest[chunk:]
        chunk //= 2
    total = _fold(acc, (8, 4, 1, 2))
    return 0.0 if total is None else total

def grouped(y, a):
    """16-product chunks: lane k adds fma(y_k a_k, fl(y_{k+8} a_{k+8})) to its sum; the
    rest fused in chunks 8, 4, 2, 1 from lane 0; folds 4, 1, 2."""
    n = len(y)
    acc = [None] * 8
    full = n // 16
    for c in range(full):
        base = 16 * c
        for k in range(8):
            i, j = base + k, base + k + 8
            t = math.fma(y[i], a[i], y[j] * a[j])
            acc[k] = t if acc[k] is None else acc[k] + t
    rest = list(range(16 * full, n))
    chunk = 8
    while rest and chunk >= 1:
        if len(rest) >= chunk:
            for k, i in enumerate(rest[:chunk]):
                acc[k] = y[i] * a[i] if acc[k] is None else math.fma(y[i], a[i], acc[k])
            rest = rest[chunk:]
        chunk //= 2
    total = _fold(acc, (4, 1, 2))
    return 0.0 if total is None else total

def intel(y, a, j, m):
    return grouped(y, a) if j < m // 4 * 4 else single(y, a)

def _amd_tree(products, lanes, block, strides):
    seed, body = products[0], products[1:]
    blocked = len(body) // block * block
    if lanes > 1 and blocked > 0:
        sums = [None] * lanes
        sums[0] = seed
        for i, p in enumerate(body[:blocked]):
            k = i % lanes
            sums[k] = p if sums[k] is None else sums[k] + p
        for stride in strides:
            for k in range(lanes):
                if (k // stride) % 2 == 0 and k + stride < lanes and sums[k] is not None and sums[k + stride] is not None:
                    sums[k] = sums[k] + sums[k + stride]
        w = sums[0]
        for p in body[blocked:]:
            w = w + p
        return w
    w = seed
    for p in body:
        w = w + p
    return w

def amd(y, a, j, m):
    """lstsq::gemv_t_double: ?ormqr's right-hand-side trees (lstsq.rs rhs_kernel)."""
    products = [yi * ai for yi, ai in zip(y, a)]
    grouped_count = m // 4 * 4
    if j < grouped_count:
        return _amd_tree(products, 2, 2, (1,))
    left, position = m - grouped_count, j - grouped_count
    if left == 1 or (left == 3 and position == 2):
        return _amd_tree(products, 8, 8, (2, 4, 1))
    if position == 0:
        return _amd_tree(products, 4, 8, (2, 1))
    return _amd_tree(products, 2, 8, (1,))
